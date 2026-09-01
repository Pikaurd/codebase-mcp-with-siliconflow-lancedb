import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { CodebaseService } from "./app.js";
import { ServiceError, toMcpError } from "./errors.js";
import { createMcpServer, withMcpRequestId } from "./mcp.js";
import type { ServiceConfig } from "./types.js";

interface McpSession {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
}

const sessionClosers = new WeakMap<Server, () => Promise<void>>();

function sameSecret(provided: string | undefined, expected: string): boolean {
  if (!provided?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(provided.slice("Bearer ".length));
  const target = Buffer.from(expected);
  return candidate.length === target.length && timingSafeEqual(candidate, target);
}

function securityFailure(response: Response, requestId: string, status: 401 | 403): void {
  const error = toMcpError(
    new ServiceError("UNAUTHORIZED", "Request rejected", "Use the local bearer token"),
    requestId,
  );
  if (status === 401) response.setHeader("www-authenticate", "Bearer");
  response.status(status).json(error);
}

function correlationId(request: Request): string {
  const value = request.headers["x-request-id"];
  return typeof value === "string" ? value : randomUUID();
}

function localAuthority(httpServer: Server): string | undefined {
  const address = httpServer.address();
  if (!address || typeof address === "string") return undefined;
  return address.port === 80 ? "127.0.0.1" : `127.0.0.1:${address.port}`;
}

function validOrigin(origin: string | undefined, authority: string): boolean {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host === authority && parsed.origin === origin;
  } catch {
    return false;
  }
}

function requestSessionId(request: Request): string | undefined {
  const value = request.headers["mcp-session-id"];
  return typeof value === "string" ? value : undefined;
}

export function createHttpServer(app: CodebaseService, config: ServiceConfig): Server {
  if (config.host !== "127.0.0.1") {
    throw new Error("HTTP MCP must bind only to 127.0.0.1");
  }
  const web = express();
  const sessions = new Map<string, McpSession>();
  const httpServer = createServer(web);
  web.disable("x-powered-by");

  web.use((request, response, next) => {
    const id = randomUUID();
    request.headers["x-request-id"] = id;
    response.setHeader("x-request-id", id);
    const authority = localAuthority(httpServer);
    const host = request.headers.host;
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (!authority || host !== authority || !validOrigin(origin, authority)) {
      securityFailure(response, id, 403);
      return;
    }
    next();
  });

  web.get("/healthz", (_request, response) => {
    response.json({ status: "ok" });
  });

  web.use("/mcp", (request, response, next) => {
    if (!sameSecret(request.headers.authorization, config.localAuthToken)) {
      securityFailure(response, correlationId(request), 401);
      return;
    }
    next();
  });
  web.use("/mcp", express.json({ limit: "1mb" }));

  web.post("/mcp", async (request, response) => {
    const id = correlationId(request);
    try {
      const requestedSessionId = requestSessionId(request);
      const existing = requestedSessionId ? sessions.get(requestedSessionId) : undefined;
      if (existing) {
        await withMcpRequestId(
          id,
          () => existing.transport.handleRequest(request, response, request.body),
        );
        return;
      }
      if (requestedSessionId || !isInitializeRequest(request.body)) {
        response.status(requestedSessionId ? 404 : 400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Invalid or missing MCP session" },
          id: null,
        });
        return;
      }

      let transport!: StreamableHTTPServerTransport;
      const mcpServer = createMcpServer(app);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (initializedSessionId) => {
          sessions.set(initializedSessionId, { server: mcpServer, transport });
        },
        onsessionclosed: async (closedSessionId) => {
          const session = sessions.get(closedSessionId);
          sessions.delete(closedSessionId);
          await session?.server.close();
        },
      });
      transport.onclose = () => {
        const closedSessionId = transport.sessionId;
        if (closedSessionId) sessions.delete(closedSessionId);
      };
      transport.onerror = (error) => {
        console.error(`[mcp] requestId=${id} transport error`, error);
      };
      await mcpServer.connect(transport);
      await withMcpRequestId(id, () => transport.handleRequest(request, response, request.body));
    } catch (error) {
      console.error(`[mcp] requestId=${id} request failed`, error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error", data: { requestId: id } },
          id: null,
        });
      }
    }
  });

  const handleExistingSession = async (request: Request, response: Response): Promise<void> => {
    const id = correlationId(request);
    const requestedSessionId = requestSessionId(request);
    const session = requestedSessionId ? sessions.get(requestedSessionId) : undefined;
    if (!session) {
      response.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing MCP session" },
        id: null,
      });
      return;
    }
    try {
      await withMcpRequestId(id, () => session.transport.handleRequest(request, response));
    } catch (error) {
      console.error(`[mcp] requestId=${id} session request failed`, error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error", data: { requestId: id } },
          id: null,
        });
      }
    }
  };
  web.get("/mcp", handleExistingSession);
  web.delete("/mcp", handleExistingSession);

  web.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const id = correlationId(request);
    console.error(`[http] requestId=${id} invalid request`, error);
    if (!response.headersSent) {
      response.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Invalid JSON", data: { requestId: id } },
        id: null,
      });
    }
  });

  sessionClosers.set(httpServer, async () => {
    const activeSessions = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(activeSessions.map(({ server }) => server.close()));
  });
  return httpServer;
}

export async function closeHttpServer(server: Server): Promise<void> {
  const closeSessions = sessionClosers.get(server);
  const closeListeningSocket = new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
  await closeSessions?.();
  server.closeIdleConnections();
  await closeListeningSocket;
  sessionClosers.delete(server);
}
