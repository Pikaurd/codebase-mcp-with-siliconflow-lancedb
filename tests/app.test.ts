import { afterEach, describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.js";
import type { Document } from "../src/types.js";
import { FakeStore } from "./fake-store.js";
import {
  createServiceFixture,
  type ServiceFixture,
  waitForJob,
  writeFixtureFile,
} from "./helpers/service.js";

const fixtures: ServiceFixture[] = [];

async function fixture(): Promise<ServiceFixture> {
  const created = await createServiceFixture();
  fixtures.push(created);
  return created;
}

class PausingReplacementStore extends FakeStore {
  private pause?: { entered: () => void; wait: Promise<void> };

  pauseNextReplacement(): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pause = { entered: markEntered, wait };
    return { entered, release };
  }

  override async replaceByRelativePath(
    name: string,
    relativePath: string,
    documents: Document[],
  ): Promise<void> {
    if (!this.pause) return super.replaceByRelativePath(name, relativePath, documents);
    const pause = this.pause;
    this.pause = undefined;
    await this.deleteByRelativePaths(name, [relativePath]);
    pause.entered();
    await pause.wait;
    await this.insert(name, documents);
  }
}

class ConcurrentSearchStore extends FakeStore {
  private startedSearches = 0;
  private bothStarted?: () => void;
  private wait?: Promise<void>;

  pauseTwoSearches(): { bothStarted: Promise<void>; release: () => void } {
    let markBothStarted!: () => void;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    this.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.bothStarted = markBothStarted;
    return { bothStarted, release };
  }

  override async search(...arguments_: Parameters<FakeStore["search"]>) {
    this.startedSearches += 1;
    if (this.startedSearches === 2) this.bothStarted?.();
    await this.wait;
    return super.search(...arguments_);
  }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(({ cleanup }) => cleanup()));
});

describe("CodebaseService", () => {
  it("returns a durable background job id from an index request", async () => {
    const { root, service } = await fixture();
    await writeFixtureFile(root, "src/a.ts", "export const original = 1;");

    const result = await service.index({ path: root });

    expect(result).toMatchObject({ jobId: expect.any(String), reused: false });
    expect((await service.getStatus({ jobId: result.jobId })).job).toMatchObject({
      id: result.jobId,
      path: root,
    });
  });

  it("exposes the durable indexing job from path-based status", async () => {
    const { root, service } = await fixture();
    await writeFixtureFile(root, "src/a.ts", "export const original = 1;");
    const indexed = await service.index({ path: root });

    expect((await service.getStatus({ path: root })).job).toMatchObject({
      id: indexed.jobId,
      path: root,
    });
  });

  it("returns CODEBASE_NOT_INDEXED instead of touching a missing collection", async () => {
    const { root, service } = await fixture();

    await expect(service.search({ path: root, query: "anything" })).rejects.toMatchObject({
      code: "CODEBASE_NOT_INDEXED",
    } satisfies Partial<ServiceError>);
  });

  it("keeps the old searchable chunks and hash when changed-file embedding fails", async () => {
    const { root, service, repository, embedding } = await fixture();
    await writeFixtureFile(root, "src/a.ts", "export const original = 1;");
    const initial = await service.index({ path: root });
    await waitForJob(service, initial.jobId);
    const oldHash = repository.getFileHashes(root)["src/a.ts"];

    await writeFixtureFile(root, "src/a.ts", "export const replacement = 999;");
    embedding.rejectTextContaining("replacement = 999");
    const update = await service.index({ path: root });
    await waitForJob(service, update.jobId);

    expect((await service.getStatus({ jobId: update.jobId })).job).toMatchObject({
      state: "failed",
      failureCode: "INDEX_FAILED",
    });
    expect(repository.getFileHashes(root)["src/a.ts"]).toBe(oldHash);
    const search = await service.search({ path: root, query: "original" });
    expect(search.results.map(({ text }) => text)).toContain("export const original = 1;");
    expect(search.results.map(({ text }) => text).join("\n")).not.toContain("replacement = 999");
  });

  it("serves last committed search results while an update job is running", async () => {
    const { root, service, embedding } = await fixture();
    await writeFixtureFile(root, "src/a.ts", "export const original = 1;");
    const initial = await service.index({ path: root });
    await waitForJob(service, initial.jobId);

    await writeFixtureFile(root, "src/a.ts", "export const replacement = 2;");
    const gate = embedding.pauseTextContaining("replacement = 2");
    const update = await service.index({ path: root });
    await Promise.race([
      gate.entered,
      new Promise((_, reject) => setTimeout(() => reject(new Error("embedding was not reached")), 1_000)),
    ]);

    try {
      expect((await service.getStatus({ path: root })).job).toMatchObject({
        id: update.jobId,
        state: "running",
      });
      const duringUpdate = await service.search({ path: root, query: "original" });
      expect(duringUpdate.indexStatus).toBe("indexing");
      expect(duringUpdate.results.map(({ text }) => text)).toContain("export const original = 1;");
    } finally {
      gate.release();
    }
    await waitForJob(service, update.jobId);
  });

  it("does not expose a store replacement's transient delete window", async () => {
    const store = new PausingReplacementStore();
    const created = await createServiceFixture({ store });
    fixtures.push(created);
    const { root, service } = created;
    await writeFixtureFile(root, "src/a.ts", "export const original = 1;");
    const initial = await service.index({ path: root });
    await waitForJob(service, initial.jobId);

    await writeFixtureFile(root, "src/a.ts", "export const replacement = 2;");
    const gate = store.pauseNextReplacement();
    const update = await service.index({ path: root });
    await gate.entered;

    const search = service.search({ path: root, query: "replacement" });
    const state = await Promise.race([
      search.then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 20)),
    ]);
    expect(state).toBe("waiting");

    gate.release();
    expect((await search).results.map(({ text }) => text)).toContain("export const replacement = 2;");
    await waitForJob(service, update.jobId);
  });

  it("allows independent searches to read concurrently", async () => {
    const store = new ConcurrentSearchStore();
    const created = await createServiceFixture({ store });
    fixtures.push(created);
    const { root, service } = created;
    await writeFixtureFile(root, "src/a.ts", "export const original = 1;");
    const initial = await service.index({ path: root });
    await waitForJob(service, initial.jobId);

    const gate = store.pauseTwoSearches();
    const first = service.search({ path: root, query: "first" });
    const second = service.search({ path: root, query: "second" });
    await Promise.race([
      gate.bothStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("searches were serialized")), 1_000)),
    ]);
    gate.release();

    expect((await first).results).toHaveLength(1);
    expect((await second).results).toHaveLength(1);
  });

  it("queues clear work and removes searchable codebase metadata", async () => {
    const { root, service } = await fixture();
    await writeFixtureFile(root, "src/a.ts", "export const original = 1;");
    const initial = await service.index({ path: root });
    await waitForJob(service, initial.jobId);

    const cleared = await service.clear({ path: root });
    await waitForJob(service, cleared.jobId);

    expect((await service.getStatus({ jobId: cleared.jobId })).job).toMatchObject({
      kind: "clear",
      state: "completed",
    });
    await expect(service.search({ path: root, query: "original" })).rejects.toMatchObject({
      code: "CODEBASE_NOT_INDEXED",
    });
  });
});
