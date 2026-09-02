import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeHttpServer, createHttpServer } from "../src/http.js";
import { dashboardHtml } from "../src/dashboard.js";
import { MetadataRepository } from "../src/repository.js";
import type { ServiceConfig } from "../src/types.js";
import {
  createServiceFixture,
  type ServiceFixture,
  waitForJob,
  writeFixtureFile,
} from "./helpers/service.js";

const TOKEN = "test-token";
const SECRET = "provider-secret-that-must-not-leak";

interface RunningFixture {
  baseUrl: string;
  config: ServiceConfig;
  service: ServiceFixture;
  server: Server;
}

interface McpSession {
  id: string;
  post(method: string, params?: Record<string, unknown>): Promise<Response>;
}

const running: RunningFixture[] = [];
const temporaryDirectories: string[] = [];

function configFor(service: ServiceFixture): ServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    localAuthToken: TOKEN,
    allowedRoots: [path.dirname(service.root)],
    indexMaxConcurrency: 2,
    openaiApiKey: SECRET,
  };
}

async function start(): Promise<RunningFixture> {
  const service = await createServiceFixture();
  const config = configFor(service);
  const server = createHttpServer(service.service, config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const fixture = { baseUrl: `http://${config.host}:${port}`, config, service, server };
  running.push(fixture);
  return fixture;
}

function mcpHeaders(token = TOKEN): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function postJson(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = mcpHeaders(),
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function postWithRawHeaders(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, any> }> {
  const target = new URL(`${baseUrl}/mcp`);
  const payload = JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(payload) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode!,
        body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, any>,
      }));
    });
    request.once("error", reject);
    request.end(payload);
  });
}

async function connect(baseUrl: string): Promise<McpSession> {
  let requestId = 1;
  const initialized = await postJson(baseUrl, {
    jsonrpc: "2.0",
    id: requestId++,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "http-test", version: "1.0.0" },
    },
  });
  expect(initialized.status).toBe(200);
  const id = initialized.headers.get("mcp-session-id");
  expect(id).toEqual(expect.any(String));

  const notification = await postJson(
    baseUrl,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { ...mcpHeaders(), "mcp-session-id": id! },
  );
  expect(notification.status).toBe(202);

  return {
    id: id!,
    post: (method, params = {}) => postJson(
      baseUrl,
      { jsonrpc: "2.0", id: requestId++, method, params },
      { ...mcpHeaders(), "mcp-session-id": id! },
    ),
  };
}

async function responseBody(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(
    (error) => error ? reject(error) : resolve(),
  ));
  return port;
}

async function waitForStderr(
  child: ChildProcessWithoutNullStreams,
  text: string,
  stderr: { value: string },
): Promise<void> {
  if (stderr.value.includes(text)) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for child stderr: ${stderr.value}`)),
      5_000,
    );
    const onData = (): void => {
      if (!stderr.value.includes(text)) return;
      clearTimeout(timeout);
      child.stderr.off("data", onData);
      resolve();
    };
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Service exited early (${code ?? signal}): ${stderr.value}`));
    });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map(async ({ server, service }) => {
    await closeHttpServer(server);
    await service.cleanup();
  }));
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe("local Streamable HTTP MCP", () => {
  it("refuses to construct a server configured for non-loopback binding", async () => {
    const service = await createServiceFixture();
    const config = { ...configFor(service), host: "0.0.0.0" };

    try {
      expect(() => createHttpServer(service.service, config)).toThrow(/127\.0\.0\.1/);
    } finally {
      await service.cleanup();
    }
  });

  it("rejects requests when the underlying socket was bound to a wildcard address", async () => {
    const service = await createServiceFixture();
    const config = configFor(service);
    const server = createHttpServer(service.service, config);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;
    running.push({ baseUrl: `http://127.0.0.1:${port}`, config, service, server });

    const response = await fetch(`http://127.0.0.1:${port}/healthz`);

    expect(response.status).toBe(403);
    expect(await responseBody(response)).toMatchObject({
      code: "UNAUTHORIZED",
      requestId: expect.any(String),
    });
  });

  it.each([undefined, "Bearer bad", "Basic test-token"])(
    "returns a safe actionable error for authorization %s",
    async (authorization) => {
      const { baseUrl } = await start();
      const headers = mcpHeaders();
      if (authorization === undefined) delete headers.authorization;
      else headers.authorization = authorization;

      const response = await postJson(baseUrl, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "unauthorized", version: "1.0.0" },
        },
      }, headers);
      const body = await responseBody(response);

      expect(response.status).toBe(401);
      expect(body).toMatchObject({
        code: "UNAUTHORIZED",
        message: expect.any(String),
        suggestedAction: expect.any(String),
        requestId: expect.any(String),
      });
      expect(response.headers.get("x-request-id")).toBe(body.requestId);
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    },
  );

  it("rejects non-loopback Host and Origin headers", async () => {
    const { baseUrl } = await start();
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "rebinding-test", version: "1.0.0" },
      },
    };

    const badHost = await postWithRawHeaders(
      baseUrl,
      request,
      { ...mcpHeaders(), host: "evil.example" },
    );
    const badOrigin = await postJson(baseUrl, request, {
      ...mcpHeaders(),
      origin: "https://evil.example",
    });

    expect(badHost.status).toBe(403);
    expect(badHost.body).toMatchObject({
      code: "UNAUTHORIZED",
      requestId: expect.any(String),
    });
    expect(badOrigin.status).toBe(403);
    expect(await responseBody(badOrigin)).toMatchObject({
      code: "UNAUTHORIZED",
      requestId: expect.any(String),
    });
  });

  it("serves a non-sensitive unauthenticated health response", async () => {
    const { baseUrl, service } = await start();

    const response = await fetch(`${baseUrl}/healthz`);
    const body = await responseBody(response);
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(service.root);
  });

  it("does not log malformed JSON bodies or parser error details", async () => {
    const { baseUrl } = await start();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secretBody = `{"payload":"${SECRET}"`;

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(),
      body: secretBody,
    });
    const body = await responseBody(response);
    const logs = errorLog.mock.calls.flat().map(String).join("\n");

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      error: {
        code: -32700,
        data: {
          code: "INTERNAL_ERROR",
          requestId: expect.any(String),
          suggestedAction: expect.any(String),
        },
      },
    });
    expect(logs).toMatch(/requestId=.*invalid JSON/);
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain(secretBody);
    expect(errorLog.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it("returns the stable public error contract for an invalid MCP session", async () => {
    const { baseUrl } = await start();

    const response = await postJson(
      baseUrl,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { ...mcpHeaders(), "mcp-session-id": "missing-session" },
    );
    const body = await responseBody(response);

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        data: {
          code: "SERVICE_UNAVAILABLE",
          requestId: expect.any(String),
          suggestedAction: expect.any(String),
        },
      },
    });
    expect(response.headers.get("x-request-id")).toBe(body.error.data.requestId);
  });

  it("discovers the four shared codebase tools with a valid token", async () => {
    const { baseUrl } = await start();
    const client = await connect(baseUrl);

    const response = await client.post("tools/list");
    const body = await responseBody(response);

    expect(response.status).toBe(200);
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "index_codebase",
      "search_code",
      "clear_index",
      "get_indexing_status",
    ]);
  });

  it.each([
    ["force type", "index_codebase", { path: "ROOT", force: "false" }],
    ["splitter enum", "index_codebase", { path: "ROOT", splitter: "regex" }],
    ["custom extension items", "index_codebase", { path: "ROOT", customExtensions: [7] }],
    ["ignore patterns", "index_codebase", { path: "ROOT", ignorePatterns: "dist" }],
    ["index extras", "index_codebase", { path: "ROOT", unexpected: true }],
    ["search path", "search_code", { path: 7, query: "query" }],
    ["search query", "search_code", { path: "ROOT", query: "" }],
    ["search limit minimum", "search_code", { path: "ROOT", query: "query", limit: 0 }],
    ["search limit integer", "search_code", { path: "ROOT", query: "query", limit: 1.5 }],
    ["search filters", "search_code", { path: "ROOT", query: "query", extensionFilter: [7] }],
    ["clear path", "clear_index", { path: null }],
    ["status selector required", "get_indexing_status", {}],
    ["status selector exclusivity", "get_indexing_status", { path: "ROOT", jobId: "job" }],
    ["status job id", "get_indexing_status", { jobId: 7 }],
  ] as const)("rejects malformed %s arguments before application dispatch", async (
    _case,
    name,
    rawArguments,
  ) => {
    const { baseUrl, service } = await start();
    const client = await connect(baseUrl);
    const arguments_ = Object.fromEntries(
      Object.entries(rawArguments).map(([key, value]) => [key, value === "ROOT" ? service.root : value]),
    );

    const response = await client.post("tools/call", { name, arguments: arguments_ });
    const body = await responseBody(response);

    expect(response.status).toBe(200);
    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "INTERNAL_ERROR",
        suggestedAction: expect.any(String),
        requestId: expect.any(String),
      },
    });
  });

  it("returns detailed sanitized PATH_NOT_ALLOWED tool output", async () => {
    const { baseUrl, service } = await start();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "codebase-mcp-http-outside-"));
    temporaryDirectories.push(outside);
    const client = await connect(baseUrl);

    const response = await client.post("tools/call", {
      name: "index_codebase",
      arguments: { path: outside },
    });
    const body = await responseBody(response);
    const output = body.result.structuredContent;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(output).toMatchObject({
      code: "PATH_NOT_ALLOWED",
      message: expect.any(String),
      suggestedAction: expect.any(String),
      requestId: expect.any(String),
      requestedPath: outside,
    });
    expect(response.headers.get("x-request-id")).toBe(output.requestId);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(path.dirname(service.root));
    expect(serialized).not.toContain("at canonicalizeAllowedPath");
  });

  it("lets two MCP clients observe the same active indexing job id", async () => {
    const { baseUrl, service } = await start();
    await writeFixtureFile(service.root, "src/a.ts", "export const shared = 1;");
    const gate = service.embedding.pauseTextContaining("shared = 1");
    const first = await connect(baseUrl);
    const second = await connect(baseUrl);

    const firstResponse = await first.post("tools/call", {
      name: "index_codebase",
      arguments: { path: service.root },
    });
    await gate.entered;
    const secondResponse = await second.post("tools/call", {
      name: "index_codebase",
      arguments: { path: service.root },
    });
    const firstOutput = (await responseBody(firstResponse)).result.structuredContent;
    const secondOutput = (await responseBody(secondResponse)).result.structuredContent;

    try {
      expect(firstOutput).toMatchObject({
        jobId: expect.any(String),
        state: expect.stringMatching(/queued|running/),
        suggestedAction: expect.any(String),
      });
      expect(secondOutput).toMatchObject({
        jobId: firstOutput.jobId,
        reused: true,
        suggestedAction: expect.any(String),
      });
    } finally {
      gate.release();
    }
  });

  it("keeps an accepted indexing job running after its MCP client disconnects", async () => {
    const { baseUrl, service } = await start();
    await writeFixtureFile(service.root, "src/a.ts", "export const detached = 1;");
    const gate = service.embedding.pauseTextContaining("detached = 1");
    const client = await connect(baseUrl);
    const response = await client.post("tools/call", {
      name: "index_codebase",
      arguments: { path: service.root },
    });
    const jobId = (await responseBody(response)).result.structuredContent.jobId as string;
    await gate.entered;

    await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { ...mcpHeaders(), "mcp-session-id": client.id },
    });
    expect((await service.service.getStatus({ jobId })).job?.state).toBe("running");

    gate.release();
    await waitForJob(service.service, jobId);
    expect((await service.service.getStatus({ jobId })).job?.state).toBe("completed");
  });

  it("recovers active jobs and drains on SIGTERM with stderr-only lifecycle logs", async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "codebase-mcp-runtime-"));
    temporaryDirectories.push(dataDirectory);
    const root = path.join(dataDirectory, "repo");
    await fs.mkdir(root);
    const repository = MetadataRepository.open(path.join(dataDirectory, "metadata.sqlite"));
    const job = repository.createJob({ id: "recover-me", path: root, kind: "index", options: "{}" });
    repository.transitionJob(job.id, "running");
    const port = await unusedLoopbackPort();
    const child = spawn(
      process.execPath,
      [path.resolve("node_modules/tsx/dist/cli.mjs"), "src/index.ts"],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: String(port),
          LOCAL_AUTH_TOKEN: TOKEN,
          CODEBASE_MCP_ALLOWED_ROOTS: root,
          CODEBASE_MCP_DATA_DIR: dataDirectory,
          OPENAI_API_KEY: SECRET,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout = { value: "" };
    const stderr = { value: "" };
    child.stdout.on("data", (chunk: Buffer) => { stdout.value += chunk.toString("utf-8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr.value += chunk.toString("utf-8"); });

    try {
      await waitForStderr(child, "listening", stderr);
      expect(repository.getJob(job.id)?.state).toBe("interrupted");
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      child.kill("SIGTERM");
      const outcome = await exited;

      expect(outcome).toEqual({ code: 0, signal: null });
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain("metadata recovery complete");
      expect(stderr.value).toContain("SIGTERM received; draining HTTP sessions");
      expect(stderr.value).toContain("[shutdown] complete");
      expect(stderr.value).not.toContain(TOKEN);
      expect(stderr.value).not.toContain(SECRET);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);
});

describe("Dashboard", () => {
  it("serves a non-sensitive shell with client-side polling", async () => {
    const { baseUrl, service } = await start();
    const response = await fetch(`${baseUrl}/dashboard`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("LOCAL_AUTH_TOKEN");
    expect(html).toContain("2000");
    expect(html).toContain("textContent");
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(service.root);
    expect(html).not.toContain("sessionStorage");
    expect(dashboardHtml()).toBe(html);
  });

  it("protects the jobs API and returns a redacted dashboard snapshot", async () => {
    const { baseUrl, service } = await start();
    const job = service.repository.createJob({ id: "dashboard-job", path: service.root, kind: "index", options: `{"secret":"${SECRET}"}` });
    service.repository.transitionJob(job.id, "running");

    const unauthorized = await fetch(`${baseUrl}/api/dashboard/jobs`);
    expect(unauthorized.status).toBe(401);
    const badOrigin = await fetch(`${baseUrl}/api/dashboard/jobs`, { headers: { origin: "https://evil.example" } });
    expect(badOrigin.status).toBe(403);
    const response = await fetch(`${baseUrl}/api/dashboard/jobs`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await responseBody(response);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ runningCount: 1, queuedCount: 0, maxConcurrency: 2 });
    expect(body.activeJobs[0]).toMatchObject({ id: job.id, path: service.root, state: "running" });
    expect(JSON.stringify(body)).not.toContain("options");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});
