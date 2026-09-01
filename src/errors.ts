import type { McpError, ServiceErrorCode } from "./types.js";

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
  if (error instanceof ServiceError) {
    return {
      code: error.code,
      message: error.message,
      suggestedAction: error.suggestedAction,
      requestId,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected service error occurred",
    suggestedAction: "Retry the request or check service logs with the request ID",
    requestId,
  };
}
