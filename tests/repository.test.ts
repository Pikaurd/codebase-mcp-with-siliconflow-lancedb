import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { MetadataRepository } from "../src/repository.js";
import { ServiceError } from "../src/errors.js";

const temporaryPaths: string[] = [];

function createDatabasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebase-mcp-repository-"));
  temporaryPaths.push(directory);
  return path.join(directory, "metadata.sqlite");
}

afterEach(() => {
  for (const directory of temporaryPaths.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("MetadataRepository", () => {
  it("migrates a new database and persists codebase hashes", () => {
    const dbPath = createDatabasePath();
    const first = MetadataRepository.open(dbPath);

    first.upsertCodebase({
      path: "/repo",
      collectionName: "repo_collection",
      status: "indexed",
      indexedFiles: 2,
      totalChunks: 5,
    });
    first.replaceFileHashes("/repo", { "src/a.ts": "hash-a", "src/b.ts": "hash-b" });

    const reopened = MetadataRepository.open(dbPath);
    expect(reopened.getFileHashes("/repo")).toEqual({
      "src/a.ts": "hash-a",
      "src/b.ts": "hash-b",
    });
  });

  it("finds an active job by canonical path and semantic options", () => {
    const repository = MetadataRepository.open(createDatabasePath());
    repository.createJob({
      id: "job-1",
      path: "/canonical/repo",
      kind: "index",
      options: '{"force":false,"include":"src"}',
    });

    expect(
      repository.findActiveJob("/canonical/repo", "index", '{"include":"src","force":false}'),
    ).toMatchObject({ id: "job-1", state: "queued", processedFiles: 0, totalChunks: 0 });
  });

  it("replaces all file hashes for a codebase atomically", () => {
    const repository = MetadataRepository.open(createDatabasePath());
    repository.replaceFileHashes("/repo", { "old.ts": "old-hash" });

    repository.replaceFileHashes("/repo", { "new.ts": "new-hash" });

    expect(repository.getFileHashes("/repo")).toEqual({ "new.ts": "new-hash" });
  });

  it("upserts and removes single file hashes incrementally", () => {
    const repository = MetadataRepository.open(createDatabasePath());
    repository.upsertFileHash("/repo", "src/a.ts", "hash-a");
    repository.upsertFileHash("/repo", "src/b.ts", "hash-b");

    // Re-processing a file refreshes its hash in place
    repository.upsertFileHash("/repo", "src/a.ts", "hash-a2");

    expect(repository.getFileHashes("/repo")).toEqual({
      "src/a.ts": "hash-a2",
      "src/b.ts": "hash-b",
    });

    repository.removeFileHash("/repo", "src/a.ts");

    expect(repository.getFileHashes("/repo")).toEqual({ "src/b.ts": "hash-b" });
  });

  it("rolls back hash replacement when a later insert fails", () => {
    const dbPath = createDatabasePath();
    const repository = MetadataRepository.open(dbPath);
    repository.replaceFileHashes("/repo", { "old.ts": "old-hash" });

    const connection = new Database(dbPath);
    connection.exec(`
      CREATE TRIGGER fail_hash_insert
      BEFORE INSERT ON file_hashes
      WHEN NEW.relative_path = 'fail.ts'
      BEGIN
        SELECT RAISE(ABORT, 'controlled hash insert failure');
      END;
    `);
    connection.close();

    expect(() => {
      repository.replaceFileHashes("/repo", {
        "first.ts": "first-hash",
        "fail.ts": "fail-hash",
      });
    }).toThrow("controlled hash insert failure");
    expect(repository.getFileHashes("/repo")).toEqual({ "old.ts": "old-hash" });
  });

  it("deletes a codebase's persisted hashes", () => {
    const repository = MetadataRepository.open(createDatabasePath());
    repository.upsertCodebase({
      path: "/repo",
      collectionName: "repo_collection",
      status: "indexed",
      indexedFiles: 1,
      totalChunks: 1,
    });
    repository.replaceFileHashes("/repo", { "src/a.ts": "hash-a" });

    repository.deleteCodebase("/repo");

    expect(repository.getFileHashes("/repo")).toEqual({});
  });

  it("marks persisted running jobs interrupted when reopened", () => {
    const dbPath = createDatabasePath();
    const first = MetadataRepository.open(dbPath);
    first.createJob({ id: "job-1", path: "/repo", kind: "index", options: "{}" });
    first.transitionJob("job-1", "running");

    const reopened = MetadataRepository.open(dbPath);
    reopened.markRunningJobsInterrupted();

    expect(reopened.getJob("job-1")?.state).toBe("interrupted");
  });

  it("clears an interrupted job mistakenly recorded as the completed codebase version", () => {
    const repository = MetadataRepository.open(createDatabasePath());
    repository.createJob({ id: "job-1", path: "/repo", kind: "index", options: "{}" });
    repository.transitionJob("job-1", "running");
    repository.upsertCodebase({
      path: "/repo",
      collectionName: "repo_collection",
      status: "indexed",
      indexedFiles: 1,
      totalChunks: 1,
      latestCompletedJobId: "job-1",
    });

    repository.markRunningJobsInterrupted();

    expect(repository.getJob("job-1")?.state).toBe("interrupted");
    expect(repository.getCodebase("/repo")).toMatchObject({
      status: "failed",
      latestCompletedJobId: undefined,
    });
  });

  it("persists job statistics and sanitized failure details", () => {
    const dbPath = createDatabasePath();
    const first = MetadataRepository.open(dbPath);
    first.createJob({ id: "job-1", path: "/repo", kind: "index", options: "{}" });
    first.transitionJob("job-1", "running");
    first.updateJobStatistics("job-1", { processedFiles: 3, totalChunks: 8 });
    first.transitionJob("job-1", "failed", {
      failure: new ServiceError("INDEX_FAILED", "provider returned raw secret: sk-test", "Retry"),
    });

    const restored = MetadataRepository.open(dbPath).getJob("job-1");
    expect(restored).toMatchObject({
      processedFiles: 3,
      totalChunks: 8,
      failureCode: "INDEX_FAILED",
      failureMessage: "Indexing failed",
    });
    expect(JSON.stringify(restored)).not.toContain("sk-test");
  });

  it("lists active jobs and limits recent terminal jobs", () => {
    const repository = MetadataRepository.open(createDatabasePath());
    repository.createJob({ id: "active", path: "/repo", kind: "index", options: "{}" });
    repository.transitionJob("active", "running");
    repository.updateJobStatistics("active", {
      processedFiles: 1,
      totalFiles: 3,
      currentFile: "src/a.ts",
      totalChunks: 8,
    });
    for (let index = 0; index < 21; index += 1) {
      const id = `done-${index}`;
      repository.createJob({ id, path: "/repo", kind: "clear", options: "{}" });
      repository.transitionJob(id, "running");
      repository.transitionJob(id, "completed", {
        statistics: { processedFiles: 0, totalFiles: 0, totalChunks: 0 },
      });
    }

    const snapshot = repository.listDashboardJobs();
    expect(snapshot.activeJobs).toHaveLength(1);
    expect(snapshot.activeJobs[0]).toMatchObject({
      id: "active",
      totalFiles: 3,
      currentFile: "src/a.ts",
    });
    expect(snapshot.recentJobs).toHaveLength(20);
  });
});
