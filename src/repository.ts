import Database from "better-sqlite3";
import { ServiceError, toMcpError } from "./errors.js";
import type { ServiceErrorCode } from "./types.js";

const SCHEMA_VERSION = 2;

export type IndexJobKind = "index" | "force" | "clear";
export type IndexJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface CreateJobInput {
  id: string;
  path: string;
  kind: IndexJobKind;
  options: string;
}

export interface IndexJob {
  id: string;
  path: string;
  kind: IndexJobKind;
  state: IndexJobState;
  options: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  processedFiles: number;
  totalChunks: number;
  failureCode?: ServiceErrorCode;
  failureMessage?: string;
}

export interface JobStatistics {
  processedFiles: number;
  totalChunks: number;
}

export interface TransitionJobUpdate {
  statistics?: JobStatistics;
  failure?: ServiceError;
}

export interface UpsertCodebaseInput {
  path: string;
  collectionName: string;
  status: string;
  indexedFiles: number;
  totalChunks: number;
  latestCompletedJobId?: string;
}

export interface CodebaseRecord {
  path: string;
  collectionName: string;
  status: string;
  indexedFiles: number;
  totalChunks: number;
  latestCompletedJobId?: string;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  path: string;
  kind: IndexJobKind;
  state: IndexJobState;
  options: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  processed_files: number;
  total_chunks: number;
  failure_code: ServiceErrorCode | null;
  failure_message: string | null;
}

interface CodebaseRow {
  path: string;
  collection_name: string;
  index_status: string;
  indexed_files: number;
  total_chunks: number;
  latest_completed_job_id: string | null;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function normalizedOptions(options: string): string {
  try {
    return JSON.stringify(sortJson(JSON.parse(options)));
  } catch {
    throw new ServiceError(
      "INTERNAL_ERROR",
      "Index job options must be valid JSON",
      "Submit valid JSON options for the indexing job",
    );
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function toIndexJob(row: JobRow): IndexJob {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind,
    state: row.state,
    options: row.options,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    processedFiles: row.processed_files,
    totalChunks: row.total_chunks,
    failureCode: row.failure_code ?? undefined,
    failureMessage: row.failure_message ?? undefined,
  };
}

function canTransition(from: IndexJobState, to: IndexJobState): boolean {
  const transitions: Record<IndexJobState, readonly IndexJobState[]> = {
    queued: ["running", "cancelled", "interrupted"],
    running: ["completed", "failed", "cancelled", "interrupted"],
    completed: [],
    failed: [],
    cancelled: [],
    interrupted: [],
  };
  return transitions[from].includes(to);
}

export class MetadataRepository {
  private constructor(private readonly db: Database.Database) {}

  static open(dbPath: string): MetadataRepository {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    const repository = new MetadataRepository(db);
    repository.migrate();
    return repository;
  }

  createJob(input: CreateJobInput): IndexJob {
    const createdAt = now();
    this.db.prepare(
      `INSERT INTO index_jobs
        (id, path, kind, state, options, options_key, created_at, updated_at)
       VALUES (@id, @path, @kind, 'queued', @options, @optionsKey, @createdAt, @createdAt)`,
    ).run({ ...input, optionsKey: normalizedOptions(input.options), createdAt });
    return this.getJob(input.id)!;
  }

  findActiveJob(path: string, kind: IndexJobKind, options: string): IndexJob | undefined {
    const row = this.db.prepare(
      `SELECT id, path, kind, state, options, created_at, started_at, completed_at,
              processed_files, total_chunks, failure_code, failure_message
       FROM index_jobs
       WHERE path = ? AND kind = ? AND options_key = ? AND state IN ('queued', 'running')
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(path, kind, normalizedOptions(options)) as JobRow | undefined;
    return row && toIndexJob(row);
  }

  transitionJob(id: string, state: IndexJobState, update: TransitionJobUpdate = {}): IndexJob {
    const transition = this.db.transaction(() => {
      const current = this.getJob(id);
      if (!current || !canTransition(current.state, state) || (update.failure && state !== "failed")) {
        throw new ServiceError(
          "INTERNAL_ERROR",
          "Invalid index job transition",
          "Check the job lifecycle before updating its state",
        );
      }

      const updatedAt = now();
      const failure = update.failure && toMcpError(update.failure, "job-failure");
      this.db.prepare(
        `UPDATE index_jobs
         SET state = ?, updated_at = ?,
             started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
             completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled', 'interrupted') THEN ? ELSE completed_at END,
             processed_files = COALESCE(?, processed_files),
             total_chunks = COALESCE(?, total_chunks),
             failure_code = ?,
             failure_message = ?
         WHERE id = ?`,
      ).run(
        state,
        updatedAt,
        state,
        updatedAt,
        state,
        updatedAt,
        update.statistics?.processedFiles ?? null,
        update.statistics?.totalChunks ?? null,
        failure?.code ?? null,
        failure?.message ?? null,
        id,
      );
      if (state === "completed" && current.kind !== "clear") {
        this.db.prepare(
          `UPDATE codebases
           SET index_status = 'indexed',
               indexed_files = (SELECT COUNT(*) FROM file_hashes WHERE codebase_path = ?),
               total_chunks = ?,
               latest_completed_job_id = ?,
               updated_at = ?
           WHERE path = ?`,
        ).run(
          current.path,
          update.statistics?.totalChunks ?? current.totalChunks,
          id,
          updatedAt,
          current.path,
        );
      } else if (state === "interrupted" && current.state === "running") {
        this.reconcileInterruptedCodebase(current.path, id, updatedAt);
      }
      return this.getJob(id)!;
    });
    return transition();
  }

  getJob(id: string): IndexJob | undefined {
    const row = this.db.prepare(
      `SELECT id, path, kind, state, options, created_at, started_at, completed_at,
              processed_files, total_chunks, failure_code, failure_message
       FROM index_jobs WHERE id = ?`,
    ).get(id) as JobRow | undefined;
    return row && toIndexJob(row);
  }

  getLatestJob(path: string): IndexJob | undefined {
    const row = this.db.prepare(
      `SELECT id, path, kind, state, options, created_at, started_at, completed_at,
              processed_files, total_chunks, failure_code, failure_message
       FROM index_jobs WHERE path = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(path) as JobRow | undefined;
    return row && toIndexJob(row);
  }

  updateJobStatistics(id: string, statistics: JobStatistics): IndexJob {
    const update = this.db.transaction(() => {
      if (!this.getJob(id)) {
        throw new ServiceError(
          "INTERNAL_ERROR",
          "Index job was not found",
          "Check the job id before recording its progress",
        );
      }
      this.db.prepare(
        `UPDATE index_jobs
         SET processed_files = ?, total_chunks = ?, updated_at = ?
         WHERE id = ?`,
      ).run(statistics.processedFiles, statistics.totalChunks, now(), id);
      return this.getJob(id)!;
    });
    return update();
  }

  upsertCodebase(input: UpsertCodebaseInput): void {
    const updatedAt = now();
    this.db.prepare(
      `INSERT INTO codebases
        (path, collection_name, index_status, indexed_files, total_chunks, latest_completed_job_id, created_at, updated_at)
       VALUES (@path, @collectionName, @status, @indexedFiles, @totalChunks, @latestCompletedJobId, @updatedAt, @updatedAt)
       ON CONFLICT(path) DO UPDATE SET
         collection_name = excluded.collection_name,
         index_status = excluded.index_status,
         indexed_files = excluded.indexed_files,
         total_chunks = excluded.total_chunks,
         latest_completed_job_id = excluded.latest_completed_job_id,
         updated_at = excluded.updated_at`,
    ).run({ ...input, latestCompletedJobId: input.latestCompletedJobId ?? null, updatedAt });
  }

  getCodebase(path: string): CodebaseRecord | undefined {
    const row = this.db.prepare(
      `SELECT path, collection_name, index_status, indexed_files, total_chunks,
              latest_completed_job_id, created_at, updated_at
       FROM codebases WHERE path = ?`,
    ).get(path) as CodebaseRow | undefined;
    if (!row) return undefined;
    return {
      path: row.path,
      collectionName: row.collection_name,
      status: row.index_status,
      indexedFiles: row.indexed_files,
      totalChunks: row.total_chunks,
      latestCompletedJobId: row.latest_completed_job_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  replaceFileHashes(path: string, hashes: Record<string, string>): void {
    const replace = this.db.transaction(() => {
      this.db.prepare("DELETE FROM file_hashes WHERE codebase_path = ?").run(path);
      const insert = this.db.prepare(
        "INSERT INTO file_hashes (codebase_path, relative_path, content_hash) VALUES (?, ?, ?)",
      );
      for (const [relativePath, contentHash] of Object.entries(hashes)) {
        insert.run(path, relativePath, contentHash);
      }
    });
    replace();
  }

  getFileHashes(path: string): Record<string, string> {
    const rows = this.db.prepare(
      "SELECT relative_path, content_hash FROM file_hashes WHERE codebase_path = ? ORDER BY relative_path",
    ).all(path) as Array<{ relative_path: string; content_hash: string }>;
    return Object.fromEntries(rows.map((row) => [row.relative_path, row.content_hash]));
  }

  markRunningJobsInterrupted(): void {
    const interruptedAt = now();
    this.db.transaction(() => {
      const running = this.db.prepare(
        "SELECT id, path FROM index_jobs WHERE state = 'running'",
      ).all() as Array<{ id: string; path: string }>;
      for (const job of running) {
        this.reconcileInterruptedCodebase(job.path, job.id, interruptedAt);
      }
      this.db.prepare(
        `UPDATE index_jobs
         SET state = 'interrupted', updated_at = ?, completed_at = ?
         WHERE state = 'running'`,
      ).run(interruptedAt, interruptedAt);
    })();
  }

  markActiveJobsInterrupted(): void {
    const interruptedAt = now();
    this.db.transaction(() => {
      const running = this.db.prepare(
        "SELECT id, path FROM index_jobs WHERE state = 'running'",
      ).all() as Array<{ id: string; path: string }>;
      for (const job of running) {
        this.reconcileInterruptedCodebase(job.path, job.id, interruptedAt);
      }
      this.db.prepare(
        `UPDATE index_jobs
         SET state = 'interrupted', updated_at = ?, completed_at = ?
         WHERE state IN ('queued', 'running')`,
      ).run(interruptedAt, interruptedAt);
    })();
  }

  deleteCodebase(path: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM file_hashes WHERE codebase_path = ?").run(path);
      this.db.prepare("DELETE FROM codebases WHERE path = ?").run(path);
    })();
  }

  private reconcileInterruptedCodebase(
    path: string,
    interruptedJobId: string,
    updatedAt: string,
  ): void {
    this.db.prepare(
      `UPDATE codebases
       SET index_status = CASE
             WHEN latest_completed_job_id IS NOT NULL AND latest_completed_job_id <> ?
               THEN 'indexed'
             ELSE 'failed'
           END,
           latest_completed_job_id = CASE
             WHEN latest_completed_job_id = ? THEN NULL
             ELSE latest_completed_job_id
           END,
           updated_at = ?
       WHERE path = ? AND (index_status = 'indexing' OR latest_completed_job_id = ?)`,
    ).run(interruptedJobId, interruptedJobId, updatedAt, path, interruptedJobId);
  }

  private migrate(): void {
    const currentVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (currentVersion > SCHEMA_VERSION) {
      throw new ServiceError(
        "SERVICE_UNAVAILABLE",
        "The metadata database was created by a newer service version",
        "Upgrade this service before opening the metadata database",
      );
    }
    this.db.transaction(() => {
      if (currentVersion < 1) {
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS codebases (
          path TEXT PRIMARY KEY,
          collection_name TEXT NOT NULL,
          index_status TEXT NOT NULL,
          indexed_files INTEGER NOT NULL DEFAULT 0,
          total_chunks INTEGER NOT NULL DEFAULT 0,
          latest_completed_job_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS file_hashes (
          codebase_path TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          PRIMARY KEY (codebase_path, relative_path)
        );

        CREATE TABLE IF NOT EXISTS index_jobs (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          kind TEXT NOT NULL,
          state TEXT NOT NULL,
          options TEXT NOT NULL,
          options_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS index_jobs_active_lookup
          ON index_jobs(path, kind, options_key, state, created_at);
        `);
        this.db.pragma("user_version = 1");
      }
      if (currentVersion < 2) {
        this.db.exec(`
          ALTER TABLE index_jobs ADD COLUMN processed_files INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE index_jobs ADD COLUMN total_chunks INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE index_jobs ADD COLUMN failure_code TEXT;
          ALTER TABLE index_jobs ADD COLUMN failure_message TEXT;
        `);
        this.db.pragma("user_version = 2");
      }
    })();
  }
}
