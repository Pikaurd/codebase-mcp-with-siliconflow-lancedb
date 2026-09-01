import type { McpError, ServiceErrorCode } from "./types.js";

const ERROR_TEMPLATES: Record<ServiceErrorCode, Omit<McpError, "code" | "requestId">> = {
  UNAUTHORIZED: {
    message: "Token rejected",
    suggestedAction: "Set LOCAL_AUTH_TOKEN",
  },
  PATH_NOT_ALLOWED: {
    message: "The requested path is not allowed",
    suggestedAction: "Use a path inside CODEBASE_MCP_ALLOWED_ROOTS",
  },
  PATH_NOT_FOUND: {
    message: "The requested path was not found",
    suggestedAction: "Use an existing directory inside CODEBASE_MCP_ALLOWED_ROOTS",
  },
  CODEBASE_NOT_INDEXED: {
    message: "The codebase has not been indexed",
    suggestedAction: "Index the codebase before searching it",
  },
  JOB_REUSED: {
    message: "An equivalent indexing job is already active",
    suggestedAction: "Use the returned job id to check indexing status",
  },
  JOB_QUEUED: {
    message: "The indexing job is queued",
    suggestedAction: "Check indexing status using the job id",
  },
  INDEX_FAILED: {
    message: "Indexing failed",
    suggestedAction: "Retry indexing or check service logs with the request ID",
  },
  SERVICE_UNAVAILABLE: {
    message: "The service is unavailable",
    suggestedAction: "Retry the request later",
  },
  INTERNAL_ERROR: {
    message: "An unexpected service error occurred",
    suggestedAction: "Retry the request or check service logs with the request ID",
  },
};

export class ServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    message: string,
    public readonly suggestedAction: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export function toMcpError(error: unknown, requestId: string): McpError {
  if (error instanceof ServiceError && Object.hasOwn(ERROR_TEMPLATES, error.code)) {
    const template = ERROR_TEMPLATES[error.code];
    return {
      code: error.code,
      requestId,
      ...template,
    };
  }

  return { code: "INTERNAL_ERROR", requestId, ...ERROR_TEMPLATES.INTERNAL_ERROR };
}
