import { randomUUID } from "node:crypto";
import { ServiceError } from "./errors.js";
import type { ServiceConfig } from "./types.js";
import type {
  IndexJob,
  IndexJobKind,
  IndexJobState,
  JobStatistics,
  MetadataRepository,
} from "./repository.js";

const DEFAULT_MAX_CONCURRENCY = 2;

export interface EnqueueRequest {
  path: string;
  kind: IndexJobKind;
  options: Record<string, unknown>;
}

export interface EnqueueResult {
  jobId: string;
  reused: boolean;
  state: IndexJobState;
}

export interface ShutdownResult {
  drained: boolean;
}

export type IndexJobExecutor = (job: IndexJob) => Promise<JobStatistics | void>;

interface ScheduledJob {
  job: IndexJob;
}

export class IndexJobScheduler {
  private readonly queues = new Map<string, ScheduledJob[]>();
  private readonly activePaths = new Set<string>();
  private runningCount = 0;
  private pumpPending = false;
  private stopping = false;
  private shutdownPromise?: Promise<ShutdownResult>;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly repository: MetadataRepository,
    private readonly executeJob: IndexJobExecutor = async () => undefined,
    private readonly maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new ServiceError(
        "INTERNAL_ERROR",
        "Scheduler concurrency must be positive",
        "Configure a positive scheduler concurrency limit",
      );
    }
    this.repository.markActiveJobsInterrupted();
  }

  static fromConfig(
    repository: MetadataRepository,
    config: ServiceConfig,
    executeJob: IndexJobExecutor = async () => undefined,
  ): IndexJobScheduler {
    return new IndexJobScheduler(repository, executeJob, config.indexMaxConcurrency);
  }

  enqueue(request: EnqueueRequest): EnqueueResult {
    if (this.stopping) {
      throw new ServiceError(
        "SERVICE_UNAVAILABLE",
        "The scheduler is shutting down",
        "Retry after the service restarts",
      );
    }
    const options = JSON.stringify(request.options);
    const existing = this.repository.findActiveJob(request.path, request.kind, options);
    if (existing) {
      return { jobId: existing.id, reused: true, state: existing.state };
    }

    const job = this.repository.createJob({
      id: randomUUID(),
      path: request.path,
      kind: request.kind,
      options,
    });
    const queue = this.queues.get(job.path) ?? [];
    queue.push({ job });
    this.queues.set(job.path, queue);
    this.requestPump();

    return { jobId: job.id, reused: false, state: job.state };
  }

  shutdown(timeoutMs: number): Promise<ShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.shutdownPromise = this.finishShutdown(Math.max(0, timeoutMs));
    return this.shutdownPromise;
  }

  private async finishShutdown(timeoutMs: number): Promise<ShutdownResult> {
    const queuedJobs = [...this.queues.values()].flat().map(({ job }) => job);
    this.queues.clear();
    for (const job of queuedJobs) {
      try {
        this.repository.transitionJob(job.id, "interrupted");
      } catch {
        // A concurrent transition already made the job terminal.
      }
    }
    if (this.runningCount === 0) return { drained: true };

    const drained = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.idleWaiters.delete(onIdle);
        resolve(value);
      };
      const onIdle = (): void => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      this.idleWaiters.add(onIdle);
    });
    if (!drained) this.repository.markRunningJobsInterrupted();
    return { drained };
  }

  private requestPump(): void {
    if (this.stopping || this.pumpPending) return;
    this.pumpPending = true;
    queueMicrotask(() => {
      this.pumpPending = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.stopping) return;
    while (this.runningCount < this.maxConcurrency) {
      const next = this.nextRunnableJob();
      if (!next) return;

      this.runningCount += 1;
      this.activePaths.add(next.job.path);
      void this.run(next);
    }
  }

  private nextRunnableJob(): ScheduledJob | undefined {
    for (const [path, queue] of this.queues) {
      if (this.activePaths.has(path)) continue;

      const next = queue.shift();
      if (!next) {
        this.queues.delete(path);
        continue;
      }
      if (queue.length === 0) this.queues.delete(path);
      return next;
    }
    return undefined;
  }

  private async run(scheduled: ScheduledJob): Promise<void> {
    try {
      const running = this.repository.transitionJob(scheduled.job.id, "running");
      const statistics = await this.executeJob(running);
      this.repository.transitionJob(
        scheduled.job.id,
        "completed",
        statistics ? { statistics } : {},
      );
    } catch (error) {
      const failure = error instanceof ServiceError
        ? error
        : new ServiceError(
          "INDEX_FAILED",
          "Indexing failed",
          "Retry indexing or check service logs with the request ID",
        );
      try {
        this.repository.transitionJob(scheduled.job.id, "failed", { failure });
      } catch {
        // The original lifecycle transition failure remains durable for diagnosis.
      }
    } finally {
      this.runningCount -= 1;
      this.activePaths.delete(scheduled.job.path);
      if (this.runningCount === 0) {
        for (const waiter of [...this.idleWaiters]) waiter();
      }
      this.requestPump();
    }
  }
}
