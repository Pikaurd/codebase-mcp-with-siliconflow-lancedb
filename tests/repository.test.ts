import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MetadataRepository } from "../src/repository.js";

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
    ).toMatchObject({ id: "job-1", state: "queued" });
  });

  it("replaces all file hashes for a codebase atomically", () => {
    const repository = MetadataRepository.open(createDatabasePath());
    repository.replaceFileHashes("/repo", { "old.ts": "old-hash" });

    repository.replaceFileHashes("/repo", { "new.ts": "new-hash" });

    expect(repository.getFileHashes("/repo")).toEqual({ "new.ts": "new-hash" });
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
});
