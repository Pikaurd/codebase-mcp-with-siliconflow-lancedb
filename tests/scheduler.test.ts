import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IndexJob } from "../src/repository.js";
import { MetadataRepository } from "../src/repository.js";
import { IndexJobScheduler } from "../src/scheduler.js";
import { loadConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebase-mcp-scheduler-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "metadata.sqlite");
}

function createRepository(): MetadataRepository {
  return MetadataRepository.open(createDatabasePath());
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("IndexJobScheduler", () => {
  it("reconciles persisted running and queued jobs so a restart can enqueue equivalent work", async () => {
    const databasePath = createDatabasePath();
    const beforeRestart = MetadataRepository.open(databasePath);
    beforeRestart.createJob({
      id: "running-job",
      path: "/canonical/running",
      kind: "index",
      options: "{}",
    });
    beforeRestart.transitionJob("running-job", "running");
    beforeRestart.createJob({
      id: "queued-job",
      path: "/canonical/queued",
      kind: "index",
      options: "{}",
    });
    const repository = MetadataRepository.open(databasePath);
    const started: string[] = [];

    const scheduler = new IndexJobScheduler(repository, async (job) => {
      started.push(job.id);
    });

    expect(repository.getJob("running-job")?.state).toBe("interrupted");
    expect(repository.getJob("queued-job")?.state).toBe("interrupted");

    const replacement = scheduler.enqueue({
      path: "/canonical/queued",
      kind: "index",
      options: {},
    });
    expect(replacement).toMatchObject({ reused: false, state: "queued" });
    await vi.waitFor(() => expect(started).toEqual([replacement.jobId]));
  });

  it("reuses one active index job for two clients targeting the same path", async () => {
    const repository = createRepository();
    const execution = deferred();
    const started: string[] = [];
    const scheduler = new IndexJobScheduler(repository, async (job) => {
      started.push(job.id);
      await execution.promise;
    });

    const first = scheduler.enqueue({
      path: "/canonical/repo",
      kind: "index",
      options: { include: "src", force: false },
    });
    const second = scheduler.enqueue({
      path: "/canonical/repo",
      kind: "index",
      options: { force: false, include: "src" },
    });

    expect(second).toEqual({ jobId: first.jobId, reused: true, state: "queued" });
    expect(repository.getJob(first.jobId)?.state).toBe("queued");

    await vi.waitFor(() => expect(started).toEqual([first.jobId]));
    expect(repository.getJob(first.jobId)?.state).toBe("running");

    execution.resolve();
    await vi.waitFor(() => expect(repository.getJob(first.jobId)?.state).toBe("completed"));
  });

  it("runs force and clear after earlier work for their canonical path", async () => {
    const repository = createRepository();
    const executions: Array<{ job: IndexJob; complete: () => void }> = [];
    const scheduler = new IndexJobScheduler(repository, async (job) => {
      const gate = deferred();
      executions.push({ job, complete: gate.resolve });
      await gate.promise;
    });

    const index = scheduler.enqueue({ path: "/canonical/repo", kind: "index", options: {} });
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    const force = scheduler.enqueue({ path: "/canonical/repo", kind: "force", options: {} });
    const clear = scheduler.enqueue({ path: "/canonical/repo", kind: "clear", options: {} });

    expect(executions.map(({ job }) => job.kind)).toEqual(["index"]);
    expect(repository.getJob(force.jobId)?.state).toBe("queued");
    expect(repository.getJob(clear.jobId)?.state).toBe("queued");

    executions[0].complete();
    await vi.waitFor(() => expect(executions.map(({ job }) => job.kind)).toEqual(["index", "force"]));
    executions[1].complete();
    await vi.waitFor(() => expect(executions.map(({ job }) => job.kind)).toEqual(["index", "force", "clear"]));
    executions[2].complete();

    await vi.waitFor(() => expect(repository.getJob(index.jobId)?.state).toBe("completed"));
    await vi.waitFor(() => expect(repository.getJob(force.jobId)?.state).toBe("completed"));
    await vi.waitFor(() => expect(repository.getJob(clear.jobId)?.state).toBe("completed"));
  });

  it("runs at most two distinct paths concurrently and queues a third", async () => {
    const repository = createRepository();
    const executions: Array<{ job: IndexJob; complete: () => void }> = [];
    const scheduler = new IndexJobScheduler(repository, async (job) => {
      const gate = deferred();
      executions.push({ job, complete: gate.resolve });
      await gate.promise;
    });

    const first = scheduler.enqueue({ path: "/canonical/one", kind: "index", options: {} });
    const second = scheduler.enqueue({ path: "/canonical/two", kind: "index", options: {} });
    const third = scheduler.enqueue({ path: "/canonical/three", kind: "index", options: {} });

    await vi.waitFor(() => expect(executions).toHaveLength(2));
    expect(executions.map(({ job }) => job.path).sort()).toEqual(["/canonical/one", "/canonical/two"]);
    expect(repository.getJob(third.jobId)?.state).toBe("queued");

    executions[0].complete();
    await vi.waitFor(() => expect(executions).toHaveLength(3));
    expect(executions[2].job.path).toBe("/canonical/three");

    executions[1].complete();
    executions[2].complete();
    await vi.waitFor(() => expect(repository.getJob(first.jobId)?.state).toBe("completed"));
    await vi.waitFor(() => expect(repository.getJob(second.jobId)?.state).toBe("completed"));
    await vi.waitFor(() => expect(repository.getJob(third.jobId)?.state).toBe("completed"));
  });

  it("uses the configured concurrency limit when composed from ServiceConfig", async () => {
    const repository = createRepository();
    const executions: Array<{ job: IndexJob; complete: () => void }> = [];
    const scheduler = IndexJobScheduler.fromConfig(
      repository,
      loadConfig({
        LOCAL_AUTH_TOKEN: "local-token",
        CODEBASE_MCP_ALLOWED_ROOTS: os.tmpdir(),
        INDEX_MAX_CONCURRENCY: "1",
      }),
      async (job) => {
        const gate = deferred();
        executions.push({ job, complete: gate.resolve });
        await gate.promise;
      },
    );

    const first = scheduler.enqueue({ path: "/canonical/one", kind: "index", options: {} });
    const second = scheduler.enqueue({ path: "/canonical/two", kind: "index", options: {} });

    await vi.waitFor(() => expect(executions).toHaveLength(1));
    expect(executions[0].job.id).toBe(first.jobId);
    expect(repository.getJob(second.jobId)?.state).toBe("queued");

    executions[0].complete();
    await vi.waitFor(() => expect(executions).toHaveLength(2));
    expect(executions[1].job.id).toBe(second.jobId);
    executions[1].complete();
  });
});
