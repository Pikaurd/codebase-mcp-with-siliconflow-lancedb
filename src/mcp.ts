import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { CodebaseService } from "./app.js";
import { ServiceError, toMcpError } from "./errors.js";
import type { McpError } from "./types.js";

const TOOLS = [
  {
    name: "index_codebase",
    description: "Queue indexing for an allowed absolute codebase path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the codebase directory." },
        force: { type: "boolean", default: false },
        splitter: { type: "string", enum: ["ast", "langchain"], default: "ast" },
        customExtensions: { type: "array", items: { type: "string" } },
        ignorePatterns: { type: "array", items: { type: "string" } },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_code",
    description: "Search the latest committed index for an allowed absolute codebase path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the codebase directory." },
        query: { type: "string", description: "Natural-language or code search query." },
        limit: { type: "number", minimum: 1, maximum: 50, default: 10 },
        extensionFilter: { type: "array", items: { type: "string" } },
      },
      required: ["path", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "clear_index",
    description: "Queue removal of the index for an allowed absolute codebase path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the codebase directory." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "get_indexing_status",
    description: "Read durable indexing status by absolute path or job id.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the codebase directory." },
        jobId: { type: "string", description: "Durable indexing job id." },
      },
      oneOf: [{ required: ["path"] }, { required: ["jobId"] }],
      additionalProperties: false,
    },
  },
] as const;

const requestIds = new AsyncLocalStorage<string>();

export function withMcpRequestId<T>(requestId: string, callback: () => Promise<T>): Promise<T> {
  return requestIds.run(requestId, callback);
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ServiceError("INTERNAL_ERROR", `${name} must be a non-empty string`, `Provide ${name}`);
  }
  return value;
}

function optionalStringArray(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ServiceError("INTERNAL_ERROR", `${name} must be a string array`, `Provide valid ${name}`);
  }
  return value;
}

function requestCorrelationId(headers: Record<string, string | string[] | undefined> | undefined): string {
  const contextualId = requestIds.getStore();
  if (contextualId) return contextualId;
  const value = headers?.["x-request-id"];
  return typeof value === "string" && value.length > 0 ? value : randomUUID();
}

function result(output: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error: unknown, requestId: string, requestedPath?: string): CallToolResult {
  const safeError: McpError & { requestedPath?: string } = toMcpError(error, requestId);
  if (
    requestedPath !== undefined
    && (safeError.code === "PATH_NOT_ALLOWED" || safeError.code === "PATH_NOT_FOUND")
  ) safeError.requestedPath = requestedPath;
  return result({ ...safeError }, true);
}

export function createMcpServer(app: CodebaseService): Server {
  const server = new Server(
    { name: "codebase-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const requestId = requestCorrelationId(extra.requestInfo?.headers);
    const requestedPath = typeof args.path === "string" ? args.path : undefined;

    try {
      switch (request.params.name) {
        case "index_codebase": {
          const queued = await app.index({
            path: requiredString(args, "path"),
            force: args.force === undefined ? undefined : Boolean(args.force),
            splitter: args.splitter as "ast" | "langchain" | undefined,
            customExtensions: optionalStringArray(args, "customExtensions"),
            ignorePatterns: optionalStringArray(args, "ignorePatterns"),
          });
          return result({
            code: queued.reused ? "JOB_REUSED" : "JOB_QUEUED",
            message: queued.reused
              ? "An equivalent indexing job is already active"
              : "The indexing job was accepted",
            jobId: queued.jobId,
            state: queued.state,
            reused: queued.reused,
            suggestedAction: "Check indexing status using the returned job id",
            requestId,
          });
        }
        case "search_code": {
          const search = await app.search({
            path: requiredString(args, "path"),
            query: requiredString(args, "query"),
            limit: typeof args.limit === "number" ? args.limit : undefined,
            extensionFilter: optionalStringArray(args, "extensionFilter"),
          });
          return result({
            ...search,
            suggestedAction: search.results.length === 0
              ? "Try a broader query or verify indexing status"
              : "Use the returned relative paths and line ranges",
            requestId,
          });
        }
        case "clear_index": {
          const queued = await app.clear({ path: requiredString(args, "path") });
          return result({
            code: queued.reused ? "JOB_REUSED" : "JOB_QUEUED",
            message: queued.reused
              ? "An equivalent clear job is already active"
              : "The clear job was accepted",
            jobId: queued.jobId,
            state: queued.state,
            reused: queued.reused,
            suggestedAction: "Check indexing status using the returned job id",
            requestId,
          });
        }
        case "get_indexing_status": {
          const status = await app.getStatus({
            path: args.path === undefined ? undefined : requiredString(args, "path"),
            jobId: args.jobId === undefined ? undefined : requiredString(args, "jobId"),
          });
          return result({
            ...status,
            jobId: status.job?.id,
            state: status.job?.state ?? status.codebase?.status ?? "not_found",
            suggestedAction: status.job
              ? "Poll this tool until the job reaches a terminal state"
              : "Submit an indexing request or verify the path or job id",
            requestId,
          });
        }
        default:
          throw new ServiceError("INTERNAL_ERROR", "Unknown tool", "Call a listed tool");
      }
    } catch (error) {
      return errorResult(error, requestId, requestedPath);
    }
  });

  return server;
}
