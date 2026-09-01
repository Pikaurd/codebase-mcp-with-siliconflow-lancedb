export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  metadata: {
    filePath: string;
    language: string;
    [key: string]: unknown;
  };
}

export interface Document {
  id: string;
  vector: number[];
  text: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  fileExtension: string;
  metadata: string; // JSON string
  codebasePath: string;
}

export interface SearchResult {
  id: string;
  text: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  fileExtension: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface Snapshot {
  formatVersion: string;
  codebases: Record<string, CodebaseSnapshot>;
  lastUpdated?: string;
}

export interface CodebaseSnapshot {
  status: "indexed" | "indexing" | "indexfailed";
  indexedFiles: number;
  totalChunks: number;
  indexStatus: "completed" | "in_progress" | "failed";
  requestSplitter: string;
  lastUpdated: string;
  fileHashes: Record<string, string>;
}

export interface IndexingResult {
  processedFiles: number;
  totalChunks: number;
  status: "completed" | "limit_reached";
}

export interface EmbeddingResult {
  vector: number[];
  dimension: number;
}

export interface EmbeddingLike {
  embed(texts: string[]): Promise<EmbeddingResult[]>;
  embedSingle(text: string): Promise<EmbeddingResult>;
}

export interface IndexOptions {
  force?: boolean;
  splitter?: "ast" | "langchain";
  customExtensions?: string[];
  ignorePatterns?: string[];
}

export interface IndexRequest extends IndexOptions {
  path: string;
}

export interface SearchRequest {
  path: string;
  query: string;
  limit?: number;
  extensionFilter?: string[];
}

export interface ClearRequest {
  path: string;
}

export interface StatusRequest {
  path?: string;
  jobId?: string;
}

export interface ServiceConfig {
  host: string;
  port: number;
  localAuthToken: string;
  allowedRoots: string[];
  indexMaxConcurrency: number;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  embeddingModel?: string;
}

export type ServiceErrorCode =
  | "UNAUTHORIZED"
  | "PATH_NOT_ALLOWED"
  | "PATH_NOT_FOUND"
  | "CODEBASE_NOT_INDEXED"
  | "JOB_REUSED"
  | "JOB_QUEUED"
  | "INDEX_FAILED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface McpError {
  code: ServiceErrorCode;
  message: string;
  suggestedAction: string;
  requestId: string;
}
