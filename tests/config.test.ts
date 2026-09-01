import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ServiceError, toMcpError } from "../src/errors.js";

describe("runtime configuration", () => {
  it("rejects a missing local auth token", () => {
    expect(() => loadConfig({ CODEBASE_MCP_ALLOWED_ROOTS: "/tmp" })).toThrow("LOCAL_AUTH_TOKEN");
  });
});

describe("safe diagnostic errors", () => {
  it("formats actionable errors without secret values", () => {
    expect(toMcpError(new ServiceError("UNAUTHORIZED", "Token rejected", "Set LOCAL_AUTH_TOKEN"), "req-1"))
      .toMatchObject({ code: "UNAUTHORIZED", requestId: "req-1", suggestedAction: "Set LOCAL_AUTH_TOKEN" });
  });
});
