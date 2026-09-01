import * as path from "node:path";
import { ServiceError } from "./errors.js";
import type { JobStatistics, MetadataRepository } from "./repository.js";
import { splitCode, generateId } from "./splitter.js";
import type { VectorStoreLike } from "./store.js";
import { FileSynchronizer } from "./sync.js";
import type { Chunk, Document, EmbeddingLike, IndexOptions } from "./types.js";

export interface SynchronizerLike {
  loadIgnoreFiles(): Promise<void>;
  discoverFiles(): Promise<string[]>;
  detectChanges(): Promise<{ changed: string[]; removed: string[] }>;
  readFile(filePath: string): Promise<string>;
  hashContent(content: string): string;
  setHashes(hashes: Record<string, string>): void;
  getHashes(): Record<string, string>;
  updateHash(relativePath: string, hash: string): void;
  removeHash(relativePath: string): void;
  getCollectionName(): string;
}

export type SynchronizerFactory = (
  codebasePath: string,
  ignorePatterns?: string[],
) => SynchronizerLike;

export interface IndexerDependencies {
  repository: MetadataRepository;
  store: VectorStoreLike;
  embedding: EmbeddingLike;
  createSynchronizer?: SynchronizerFactory;
}

export type IndexProgress = (statistics: JobStatistics) => void;

type Release = () => void;

interface AccessWaiter {
  kind: "read" | "write";
  resolve: (release: Release) => void;
}

interface AccessState {
  readers: number;
  writer: boolean;
  waiters: AccessWaiter[];
}

class CollectionAccessCoordinator {
  private readonly states = new Map<string, AccessState>();

  async read<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key, "read");
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async write<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key, "write");
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(key: string, kind: AccessWaiter["kind"]): Promise<Release> {
    const state = this.states.get(key) ?? { readers: 0, writer: false, waiters: [] };
    this.states.set(key, state);
    if (state.waiters.length === 0 && !state.writer && (kind === "read" || state.readers === 0)) {
      if (kind === "read") state.readers += 1;
      else state.writer = true;
      return Promise.resolve(this.releaseFor(key, state, kind));
    }
    return new Promise((resolve) => {
      state.waiters.push({ kind, resolve });
    });
  }

  private releaseFor(key: string, state: AccessState, kind: AccessWaiter["kind"]): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === "read") state.readers -= 1;
      else state.writer = false;
      this.drain(key, state);
    };
  }

  private drain(key: string, state: AccessState): void {
    if (state.writer || state.readers > 0) return;
    const first = state.waiters[0];
    if (!first) {
      this.states.delete(key);
      return;
    }
    if (first.kind === "write") {
      state.waiters.shift();
      state.writer = true;
      first.resolve(this.releaseFor(key, state, "write"));
      return;
    }
    while (state.waiters[0]?.kind === "read") {
      const reader = state.waiters.shift()!;
      state.readers += 1;
      reader.resolve(this.releaseFor(key, state, "read"));
    }
  }
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

function toDocuments(
  chunks: Chunk[],
  embeddings: Awaited<ReturnType<EmbeddingLike["embed"]>>,
  codebasePath: string,
): Document[] {
  if (embeddings.length !== chunks.length) {
    throw new Error("Embedding provider returned the wrong result count");
  }
  return chunks.map((chunk, index) => {
    const relativePath = chunk.metadata.filePath.startsWith(codebasePath)
      ? path.relative(codebasePath, chunk.metadata.filePath)
      : chunk.metadata.filePath;
    return {
      id: generateId(relativePath, chunk.startLine, chunk.endLine, chunk.content),
      vector: normalize(embeddings[index].vector),
      text: chunk.content,
      relativePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      fileExtension: path.extname(chunk.metadata.filePath),
      metadata: JSON.stringify(chunk.metadata),
      codebasePath,
    };
  });
}

export class Indexer {
  private readonly createSynchronizer: SynchronizerFactory;
  private readonly access = new CollectionAccessCoordinator();

  constructor(private readonly dependencies: IndexerDependencies) {
    this.createSynchronizer = dependencies.createSynchronizer
      ?? ((codebasePath, ignorePatterns) => new FileSynchronizer(codebasePath, ignorePatterns));
  }

  collectionName(pathname: string): string {
    return this.createSynchronizer(pathname).getCollectionName();
  }

  withCommittedRead<T>(codebasePath: string, operation: () => Promise<T>): Promise<T> {
    return this.access.read(codebasePath, operation);
  }

  async index(
    codebasePath: string,
    options: IndexOptions = {},
    onProgress: IndexProgress = () => undefined,
    completedJobId?: string,
  ): Promise<JobStatistics> {
    const { repository, store, embedding } = this.dependencies;
    const synchronizer = this.createSynchronizer(codebasePath, options.ignorePatterns);
    await synchronizer.loadIgnoreFiles();
    const collectionName = synchronizer.getCollectionName();
    const previous = repository.getCodebase(codebasePath);
    const hashes = repository.getFileHashes(codebasePath);
    synchronizer.setHashes(hashes);
    let processedFiles = 0;
    let totalChunks = previous?.totalChunks ?? 0;

    repository.upsertCodebase({
      path: codebasePath,
      collectionName,
      status: "indexing",
      indexedFiles: previous?.indexedFiles ?? Object.keys(hashes).length,
      totalChunks: previous?.totalChunks ?? 0,
      latestCompletedJobId: previous?.latestCompletedJobId,
    });

    try {
      const hasTable = await store.hasTable(collectionName);
      let changed: string[];
      let removed: string[];
      if (options.force || !hasTable) {
        changed = await synchronizer.discoverFiles();
        const current = new Set(changed.map((filePath) => path.relative(codebasePath, filePath)));
        removed = Object.keys(hashes).filter((relativePath) => !current.has(relativePath));
      } else {
        ({ changed, removed } = await synchronizer.detectChanges());
      }

      let failedFiles = 0;
      totalChunks = hasTable ? Math.max(0, await store.getRowCount(collectionName)) : 0;

      for (const relativePath of removed) {
        try {
          await this.access.write(
            codebasePath,
            () => store.deleteByRelativePaths(collectionName, [relativePath]),
          );
          synchronizer.removeHash(relativePath);
          repository.replaceFileHashes(codebasePath, synchronizer.getHashes());
          totalChunks = Math.max(0, await store.getRowCount(collectionName));
          onProgress({ processedFiles, totalChunks });
        } catch {
          // Keep the hash so deletion is retried by a later incremental job.
          failedFiles += 1;
        }
      }

      for (const filePath of changed) {
        const relativePath = path.relative(codebasePath, filePath);
        try {
          const content = await synchronizer.readFile(filePath);
          const chunks = splitCode(content, filePath, codebasePath);
          const embeddings = await embedding.embed(chunks.map((chunk) => chunk.content));
          const documents = toDocuments(chunks, embeddings, codebasePath);

          await this.access.write(
            codebasePath,
            () => store.replaceByRelativePath(collectionName, relativePath, documents),
          );
          synchronizer.updateHash(relativePath, synchronizer.hashContent(content));
          repository.replaceFileHashes(codebasePath, synchronizer.getHashes());
          processedFiles += 1;
          totalChunks = Math.max(0, await store.getRowCount(collectionName));
          onProgress({ processedFiles, totalChunks });
        } catch {
          // A failed file deliberately retains its previously committed chunks and hash.
          failedFiles += 1;
        }
      }

      if (failedFiles > 0) {
        throw new ServiceError(
          "INDEX_FAILED",
          "Indexing failed",
          "Retry indexing or check service logs with the request ID",
        );
      }

      repository.upsertCodebase({
        path: codebasePath,
        collectionName,
        status: "indexed",
        indexedFiles: Object.keys(synchronizer.getHashes()).length,
        totalChunks,
        latestCompletedJobId: completedJobId ?? previous?.latestCompletedJobId,
      });
      return { processedFiles, totalChunks };
    } catch (error) {
      repository.upsertCodebase({
        path: codebasePath,
        collectionName,
        status: "failed",
        indexedFiles: Object.keys(synchronizer.getHashes()).length,
        totalChunks,
        latestCompletedJobId: previous?.latestCompletedJobId,
      });
      throw error instanceof ServiceError
        ? error
        : new ServiceError(
          "INDEX_FAILED",
          "Indexing failed",
          "Retry indexing or check service logs with the request ID",
        );
    }
  }

  async clear(codebasePath: string): Promise<JobStatistics> {
    const collectionName = this.collectionName(codebasePath);
    await this.access.write(codebasePath, async () => {
      await this.dependencies.store.dropTable(collectionName);
      this.dependencies.repository.deleteCodebase(codebasePath);
    });
    return { processedFiles: 0, totalChunks: 0 };
  }
}
