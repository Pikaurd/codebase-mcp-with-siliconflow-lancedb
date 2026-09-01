import type { ServiceConfig } from "./types.js";

type Environment = Record<string, string | undefined>;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function configuredRoots(value: string): string[] {
  const roots = value.split(",").map((root) => root.trim()).filter(Boolean);
  if (roots.length === 0) {
    throw new Error("CODEBASE_MCP_ALLOWED_ROOTS must include at least one root");
  }
  return roots;
}

function configuredPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function configuredHost(value: string | undefined): string {
  const host = value?.trim() || DEFAULT_HOST;
  if (host !== DEFAULT_HOST) {
    throw new Error("HOST must be 127.0.0.1 for local-only service binding");
  }
  return host;
}

export function loadConfig(env: Environment = process.env): ServiceConfig {
  return {
    host: configuredHost(env.HOST),
    port: configuredPort(env.PORT),
    localAuthToken: required(env, "LOCAL_AUTH_TOKEN"),
    allowedRoots: configuredRoots(required(env, "CODEBASE_MCP_ALLOWED_ROOTS")),
    openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
    openaiBaseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
    embeddingModel: env.EMBEDDING_MODEL?.trim() || undefined,
  };
}
