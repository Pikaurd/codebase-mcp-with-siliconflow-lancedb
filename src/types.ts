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
