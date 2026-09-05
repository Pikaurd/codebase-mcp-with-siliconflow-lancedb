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
  detectChanges(currentFiles?: string[]): Promise<{ changed: string[]; removed: string[] }>;
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
  private readonly maintenanceChanges = new Map<string, number>();

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

    this.ensureJobRunning(completedJobId);
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
      const currentFiles = await synchronizer.discoverFiles();
      let changed: string[];
      let removed: string[];
      if (options.force || !hasTable) {
        changed = currentFiles;
        const current = new Set(changed.map((filePath) => path.relative(codebasePath, filePath)));
        removed = Object.keys(hashes).filter((relativePath) => !current.has(relativePath));
        // Force rebuild: start from an empty table so per-file replaceByRelativePath
        // (delete + add) doesn't scan tens of thousands of stale rows on every file.
        await store.prepareTable(collectionName);
        this.maintenanceChanges.delete(codebasePath);
      } else {
        ({ changed, removed } = await synchronizer.detectChanges(currentFiles));
      }
      const discovered = new Set(
        currentFiles
          .map((filePath) => path.relative(codebasePath, filePath)),
      );

      const isFullRebuild = options.force || !hasTable;
      let failedFiles = 0;
      totalChunks = hasTable ? Math.max(0, await store.getRowCount(collectionName)) : 0;
      const totalFiles = removed.length + changed.length;
      onProgress({ processedFiles, totalFiles, totalChunks });

      if (!isFullRebuild) {
        for (const relativePath of removed) {
          try {
            this.ensureJobRunning(completedJobId);
            onProgress({ processedFiles, totalFiles, totalChunks, currentFile: relativePath });
            await this.access.write(
              codebasePath,
              () => store.deleteByRelativePaths(collectionName, [relativePath]),
            );
            this.maintenanceChanges.set(codebasePath, (this.maintenanceChanges.get(codebasePath) ?? 0) + 1);
            this.ensureJobRunning(completedJobId);
            synchronizer.removeHash(relativePath);
            repository.removeFileHash(codebasePath, relativePath);
          } catch {
            // Keep the hash so deletion is retried by a later incremental job.
            failedFiles += 1;
          } finally {
            processedFiles += 1;
            onProgress({ processedFiles, totalFiles, totalChunks, currentFile: relativePath });
          }
        }
      }

      // Provider rate-limits aggressively under concurrency (429s observed
      // with 5 parallel embed calls); 2 keeps throughput while staying under
      // the limit. Override with INDEX_EMBED_CONCURRENCY if needed.
      const configuredConcurrency = Number(process.env.INDEX_EMBED_CONCURRENCY);
      const EMBED_CONCURRENCY = configuredConcurrency > 0 ? Math.floor(configuredConcurrency) : 2;
      // Stage 1 (parallel, bounded): read + split + embed for up to 5 files at a
      // time. Pure per-file work with no shared state — the embedding provider
      // round-trip dominates wall time, so files wait on the network instead of
      // on each other. Failures are captured per file and resolved serially below.
      const prepared = new Map<string, Promise<
        { documents: Document[]; contentHash: string } | { error: unknown }
      >>();
      const pending = [...changed];
      let nextIndex = 0;
      const startNext = (): void => {
        while (prepared.size < EMBED_CONCURRENCY && nextIndex < pending.length) {
          const filePath = pending[nextIndex];
          nextIndex += 1;
          const relativePath = path.relative(codebasePath, filePath);
          onProgress({ processedFiles, totalFiles, totalChunks, currentFile: relativePath });
          prepared.set(
            filePath,
            (async () => {
              try {
                const content = await synchronizer.readFile(filePath);
                const chunks = splitCode(content, filePath, codebasePath);
                const embeddings = await embedding.embed(chunks.map((chunk) => chunk.content));
                return { documents: toDocuments(chunks, embeddings, codebasePath), contentHash: synchronizer.hashContent(content) };
              } catch (error) {
                return { error };
              }
            })(),
          );
        }
      };
      startNext();

      // Full rebuild: the table was cleared by prepareTable, so per-file
      // replaceByRelativePath (delete + add) is both pointless and harmful —
      // every add creates a LanceDB version, and delete scans fragment
      // versions, degrading from ~3ms to ~900ms per file as versions pile up.
      // Collect prepared documents and commit in large batched adds instead.
      const batched: Document[] = [];
      // Incremental: keep the original per-file replace so a failed file
      // retains its previously committed chunks and hash (unchanged semantics).
      while (prepared.size > 0) {
        const settled = await Promise.race(
          [...prepared.entries()].map(async ([filePath, work]) => ({ filePath, result: await work })),
        );
        prepared.delete(settled.filePath);
        startNext();
        const relativePath = path.relative(codebasePath, settled.filePath);
        try {
          if ("error" in settled.result) throw settled.result.error;
          const { documents, contentHash } = settled.result;
          this.ensureJobRunning(completedJobId);
          if (isFullRebuild) {
            batched.push(...documents);
          } else {
            await this.access.write(
              codebasePath,
              () => store.replaceByRelativePath(collectionName, relativePath, documents),
            );
            this.maintenanceChanges.set(codebasePath, (this.maintenanceChanges.get(codebasePath) ?? 0) + 1);
          }
          this.ensureJobRunning(completedJobId);
          synchronizer.updateHash(relativePath, contentHash);
          repository.upsertFileHash(codebasePath, relativePath, contentHash);
        } catch {
          // A failed file deliberately retains its previously committed chunks and hash.
          failedFiles += 1;
        } finally {
          processedFiles += 1;
          onProgress({ processedFiles, totalFiles, totalChunks, currentFile: relativePath });
        }
      }

      // Commit the accumulated full-rebuild rows in one batched add.
      if (isFullRebuild && batched.length > 0) {
        this.ensureJobRunning(completedJobId);
        await this.access.write(codebasePath, () => store.insert(collectionName, batched));
        totalChunks = Math.max(0, await store.getRowCount(collectionName));
      }
      // Full rebuild: sync hashes now contain only successfully-processed
      // changed files. Atomically replace sqlite file_hashes so old entries
      // (files that were removed since the last index) are cleaned up.
      if (isFullRebuild) {
        repository.replaceFileHashes(codebasePath, synchronizer.getHashes());
        this.maintenanceChanges.delete(codebasePath);
      }

      if (failedFiles > 0) {
        throw new ServiceError(
          "INDEX_FAILED",
          "Indexing failed",
          "Retry indexing or check service logs with the request ID",
        );
      }

      const indexedPaths = await store.getAllRelativePaths(collectionName);
      const orphanPaths = indexedPaths.filter((relativePath) => !discovered.has(relativePath));
      if (orphanPaths.length > 0) {
        await this.access.write(codebasePath, async () => {
          // For large orphan sets the per-path id LIKE deletion creates
          // hundreds of LanceDB versions at ~8k rows/minute. Drop+recreate
          // is O(n) instead of O(orphans × versions) — run it for >50.
          if (orphanPaths.length > 50) {
            await store.retainRelativePaths(collectionName, discovered);
          } else {
            await store.deleteByRelativePaths(collectionName, orphanPaths);
          }
        });
        if (orphanPaths.length <= 50) {
          this.maintenanceChanges.set(codebasePath, (this.maintenanceChanges.get(codebasePath) ?? 0) + orphanPaths.length);
        } else {
          this.maintenanceChanges.delete(codebasePath);
        }
        totalChunks = Math.max(0, await store.getRowCount(collectionName));
      }

      if ((this.maintenanceChanges.get(codebasePath) ?? 0) >= 20) {
        this.ensureJobRunning(completedJobId);
        try {
          await this.access.write(codebasePath, () => store.compactTable(collectionName));
          this.maintenanceChanges.delete(codebasePath);
        } catch {
          console.error("[indexer] collection maintenance failed; retrying on next successful index");
        }
      }

      this.ensureJobRunning(completedJobId);
      if (completedJobId === undefined) {
        repository.upsertCodebase({
          path: codebasePath,
          collectionName,
          status: "indexed",
          indexedFiles: Object.keys(synchronizer.getHashes()).length,
          totalChunks,
          latestCompletedJobId: previous?.latestCompletedJobId,
        });
      }
      return { processedFiles, totalChunks };
    } catch (error) {
      if (completedJobId === undefined || repository.getJob(completedJobId)?.state === "running") {
        repository.upsertCodebase({
          path: codebasePath,
          collectionName,
          status: "failed",
          indexedFiles: Object.keys(synchronizer.getHashes()).length,
          totalChunks,
          latestCompletedJobId: previous?.latestCompletedJobId,
        });
      }
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
      this.maintenanceChanges.delete(codebasePath);
    });
    return { processedFiles: 0, totalFiles: 0, totalChunks: 0 };
  }

  private ensureJobRunning(jobId: string | undefined): void {
    if (jobId === undefined || this.dependencies.repository.getJob(jobId)?.state === "running") return;
    throw new ServiceError(
      "SERVICE_UNAVAILABLE",
      "The indexing job was interrupted",
      "Submit a new indexing job after the service restarts",
    );
  }
}
