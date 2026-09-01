import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config.js";
import { ServiceError, toMcpError } from "../src/errors.js";

describe("runtime configuration", () => {
  const requiredEnvironment = {
    LOCAL_AUTH_TOKEN: "local-token",
    CODEBASE_MCP_ALLOWED_ROOTS: os.tmpdir(),
  };

  it("rejects a missing local auth token", () => {
    expect(() => loadConfig({ CODEBASE_MCP_ALLOWED_ROOTS: "/tmp" })).toThrow("LOCAL_AUTH_TOKEN");
  });

  it.each(["0.0.0.0", "192.168.1.25"])("rejects a non-loopback host: %s", (host) => {
    expect(() => loadConfig({
      HOST: host,
      LOCAL_AUTH_TOKEN: "local-token",
      CODEBASE_MCP_ALLOWED_ROOTS: "/tmp",
    })).toThrow("HOST must be 127.0.0.1");
  });

  it("defaults scheduler concurrency to two and accepts a configured positive limit", () => {
    expect(loadConfig(requiredEnvironment).indexMaxConcurrency).toBe(2);
    expect(loadConfig({ ...requiredEnvironment, INDEX_MAX_CONCURRENCY: "3" }).indexMaxConcurrency)
      .toBe(3);
  });

  it.each(["0", "1.5", "not-a-number"])("rejects an invalid scheduler concurrency: %s", (value) => {
    expect(() => loadConfig({ ...requiredEnvironment, INDEX_MAX_CONCURRENCY: value }))
      .toThrow("INDEX_MAX_CONCURRENCY must be a positive integer");
  });

  it("rejects missing allowed roots with a safe actionable configuration error", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codebase-mcp-missing-root-"));
    try {
      expect(() => loadConfig({
        LOCAL_AUTH_TOKEN: "local-token",
        CODEBASE_MCP_ALLOWED_ROOTS: path.join(parent, "missing"),
      })).toThrow("CODEBASE_MCP_ALLOWED_ROOTS must contain existing readable directories");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("safe diagnostic errors", () => {
  it("formats actionable errors without secret values", () => {
    expect(toMcpError(new ServiceError("UNAUTHORIZED", "Token rejected", "Set LOCAL_AUTH_TOKEN"), "req-1"))
      .toMatchObject({ code: "UNAUTHORIZED", requestId: "req-1", suggestedAction: "Set LOCAL_AUTH_TOKEN" });
  });

  it("uses trusted templates instead of ServiceError text", () => {
    const secret = "token=super-secret-value";
    const root = "/private/allowed-root";
    const providerBody = '{"provider":"raw failure"}';
    const stack = "Error: failure\\n    at internal.ts:1:1";

    const result = toMcpError(
      new ServiceError("UNAUTHORIZED", `${secret} ${root} ${providerBody} ${stack}`, `${secret} ${root}`),
      "req-2",
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      code: "UNAUTHORIZED",
      message: "Token rejected",
      suggestedAction: "Set LOCAL_AUTH_TOKEN",
      requestId: "req-2",
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(providerBody);
    expect(serialized).not.toContain(stack);
  });
});
