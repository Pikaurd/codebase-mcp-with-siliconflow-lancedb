import { ServiceError } from "./errors.js";
import { Indexer } from "./indexer.js";
import { canonicalizeAllowedPath } from "./path-policy.js";
import type { CodebaseRecord, IndexJob, MetadataRepository } from "./repository.js";
import { IndexJobScheduler, type EnqueueResult } from "./scheduler.js";
import type { VectorStoreLike } from "./store.js";
import type {
  ClearRequest,
  EmbeddingLike,
  IndexOptions,
  IndexRequest,
  SearchRequest,
  SearchResult,
  ServiceConfig,
  StatusRequest,
} from "./types.js";

export interface CodebaseServiceDependencies {
  config: ServiceConfig;
  repository: MetadataRepository;
  store: VectorStoreLike;
  embedding: EmbeddingLike;
  indexer?: Indexer;
  scheduler?: IndexJobScheduler;
}

export interface SearchResponse {
  path: string;
  results: SearchResult[];
  indexStatus: string;
}

export interface StatusResponse {
  job?: IndexJob;
  codebase?: CodebaseRecord;
}

export class CodebaseService {
  private constructor(
    private readonly config: ServiceConfig,
    private readonly repository: MetadataRepository,
    private readonly store: VectorStoreLike,
    private readonly embedding: EmbeddingLike,
    private readonly indexer: Indexer,
    private scheduler: IndexJobScheduler,
  ) {}

  static create(dependencies: CodebaseServiceDependencies): CodebaseService {
    const indexer = dependencies.indexer ?? new Indexer(dependencies);
    let service!: CodebaseService;
    const scheduler = dependencies.scheduler ?? IndexJobScheduler.fromConfig(
      dependencies.repository,
      dependencies.config,
      (job) => service.runIndexJob(job),
    );
    service = new CodebaseService(
      dependencies.config,
      dependencies.repository,
      dependencies.store,
      dependencies.embedding,
      indexer,
      scheduler,
    );
    return service;
  }

  async index(request: IndexRequest): Promise<EnqueueResult> {
    const canonicalPath = await this.canonicalPath(request.path);
    const { path: _path, force = false, ...options } = request;
    return this.scheduler.enqueue({
      path: canonicalPath,
      kind: force ? "force" : "index",
      options,
    });
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const canonicalPath = await this.canonicalPath(request.path);
    return this.indexer.withCommittedRead(canonicalPath, async () => {
      const codebase = this.repository.getCodebase(canonicalPath);
      const collectionName = codebase?.collectionName ?? this.indexer.collectionName(canonicalPath);
      if (!codebase || !(await this.store.hasTable(collectionName))) {
        throw new ServiceError(
          "CODEBASE_NOT_INDEXED",
          "The codebase has not been indexed",
          "Index the codebase before searching it",
        );
      }

      const limit = Math.min(Math.max(1, request.limit ?? 10), 50);
      const queryEmbedding = await this.embedding.embedSingle(request.query);
      const results = await this.store.search(
        collectionName,
        queryEmbedding.vector,
        request.query,
        limit,
      );
      const extensionFilter = request.extensionFilter ?? [];
      const filtered = extensionFilter.length === 0
        ? results
        : results.filter((result) => extensionFilter.some(
          (extension) => extension.toLowerCase() === result.fileExtension.toLowerCase(),
        ));
      return { path: canonicalPath, results: filtered, indexStatus: codebase.status };
    });
  }

  async clear(request: ClearRequest): Promise<EnqueueResult> {
    const canonicalPath = await this.canonicalPath(request.path);
    return this.scheduler.enqueue({ path: canonicalPath, kind: "clear", options: {} });
  }

  async getStatus(request: StatusRequest): Promise<StatusResponse> {
    if (request.path && request.jobId) {
      throw new ServiceError(
        "INTERNAL_ERROR",
        "Status request selectors are ambiguous",
        "Provide either a path or a job id",
      );
    }
    const canonicalRequestPath = request.path
      ? await this.canonicalPath(request.path)
      : undefined;
    const job = request.jobId
      ? this.repository.getJob(request.jobId)
      : canonicalRequestPath
        ? this.repository.getLatestJob(canonicalRequestPath)
        : undefined;
    const requestedPath = canonicalRequestPath ?? job?.path;
    return {
      job,
      codebase: requestedPath ? this.repository.getCodebase(requestedPath) : undefined,
    };
  }

  async runIndexJob(job: IndexJob): Promise<{ processedFiles: number; totalChunks: number }> {
    if (job.kind === "clear") return this.indexer.clear(job.path);

    let options: IndexOptions;
    try {
      options = JSON.parse(job.options) as IndexOptions;
    } catch {
      throw new ServiceError(
        "INDEX_FAILED",
        "Indexing failed",
        "Retry indexing or check service logs with the request ID",
      );
    }
    if (job.kind === "force") options.force = true;
    return this.indexer.index(
      job.path,
      options,
      (statistics) => this.repository.updateJobStatistics(job.id, statistics),
      job.id,
    );
  }

  private canonicalPath(input: string): Promise<string> {
    return canonicalizeAllowedPath(input, this.config.allowedRoots);
  }
}
