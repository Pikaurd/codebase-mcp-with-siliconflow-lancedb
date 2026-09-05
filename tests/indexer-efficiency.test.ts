import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileSynchronizer } from "../src/sync.js";
import { Indexer } from "../src/indexer.js";
import { FakeStore } from "./fake-store.js";
import { createServiceFixture, type ServiceFixture, waitForJob, writeFixtureFile } from "./helpers/service.js";

const fixtures: ServiceFixture[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(({ cleanup }) => cleanup())); });

class CountingStore extends FakeStore {
  replacements = 0;
  deletions = 0;
  override async replaceByRelativePath(...args: Parameters<FakeStore["replaceByRelativePath"]>) {
    this.replacements += 1;
    return super.replaceByRelativePath(...args);
  }
  override async deleteByRelativePaths(...args: Parameters<FakeStore["deleteByRelativePaths"]>) {
    this.deletions += args[1].length;
    return super.deleteByRelativePaths(...args);
  }
}

describe("indexer efficiency regressions", () => {
  it("discovers exactly once for initial, unchanged, and force tasks", async () => {
    const fixture = await createServiceFixture(); fixtures.push(fixture);
    await writeFixtureFile(fixture.root, "src/a.ts", "export const value = 1;");
    const discover = vi.spyOn(FileSynchronizer.prototype, "discoverFiles");
    for (const force of [false, false, true]) {
      discover.mockClear();
      const job = await fixture.service.index({ path: fixture.root, force });
      await waitForJob(fixture.service, job.jobId);
      expect(discover).toHaveBeenCalledTimes(1);
      expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("completed");
    }
  });

  it("detects an equal-length edit and persists its new hash and text", async () => {
    const fixture = await createServiceFixture(); fixtures.push(fixture);
    await writeFixtureFile(fixture.root, "src/a.ts", "export const value = 1;");
    const first = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, first.jobId);
    const oldHash = fixture.repository.getFileHashes(fixture.root)["src/a.ts"];
    await writeFixtureFile(fixture.root, "src/a.ts", "export const value = 2;");
    const second = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, second.jobId);
    expect(fixture.repository.getFileHashes(fixture.root)["src/a.ts"]).not.toBe(oldHash);
    expect(fixture.store.getRows((fixture.service as any).indexer.collectionName(fixture.root)).map((row) => row.text)).toContain("export const value = 2;");
    expect((await fixture.service.getStatus({ jobId: second.jobId })).job?.state).toBe("completed");
  });

  it("does no embedding replacement work for an unchanged incremental task", async () => {
    const store = new CountingStore();
    const fixture = await createServiceFixture({ store }); fixtures.push(fixture);
    await writeFixtureFile(fixture.root, "src/a.ts", "export const stable = true;");
    const first = await fixture.service.index({ path: fixture.root });
    await waitForJob(fixture.service, first.jobId);
    store.replacements = 0;
    const embed = vi.spyOn(fixture.embedding, "embed");
    const second = await fixture.service.index({ path: fixture.root });
    await waitForJob(fixture.service, second.jobId);
    expect(store.replacements).toBe(0);
    expect(store.deletions).toBe(0);
    expect(embed).not.toHaveBeenCalled();
    expect((await fixture.service.getStatus({ jobId: second.jobId })).job?.state).toBe("completed");
  });

  it("reconciles an orphan row while retaining normal rows", async () => {
    const store = new CountingStore();
    const fixture = await createServiceFixture({ store }); fixtures.push(fixture);
    await writeFixtureFile(fixture.root, "src/a.ts", "export const kept = true;");
    const first = await fixture.service.index({ path: fixture.root });
    await waitForJob(fixture.service, first.jobId);
    const collection = (fixture.service as any).indexer.collectionName(fixture.root) as string;
    await store.insert(collection, [{
      id: "orphan:1-1", relativePath: "orphan.ts", vector: [0], text: "orphan", startLine: 1, endLine: 1,
      fileExtension: ".ts", metadata: "{}", codebasePath: fixture.root,
    }]);
    const second = await fixture.service.index({ path: fixture.root });
    await waitForJob(fixture.service, second.jobId);
    expect(store.getRelativePaths(collection)).toEqual(["src/a.ts"]);
  });

  it("compacts once at the twentieth accumulated successful change and not again at 21", async () => {
    const store = new CountingStore();
    const fixture = await createServiceFixture({ store }); fixtures.push(fixture);
    await writeFixtureFile(fixture.root, "src/a.ts", "export const n = 0;");
    let job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId);
    const compact = vi.spyOn(store, "compactTable");
    for (let n = 1; n <= 19; n++) {
      await writeFixtureFile(fixture.root, "src/a.ts", `export const n = ${n};`);
      job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId);
    }
    expect(compact).not.toHaveBeenCalled();
    await writeFixtureFile(fixture.root, "src/a.ts", "export const n = 20;");
    job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId);
    expect(compact).toHaveBeenCalledTimes(1);
    await writeFixtureFile(fixture.root, "src/a.ts", "export const n = 21;");
    job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("keeps maintenance counters isolated for two roots on one Indexer", async () => {
    const fixture = await createServiceFixture(); fixtures.push(fixture);
    const secondRoot = path.join(path.dirname(fixture.root), "repo-two"); await fs.mkdir(secondRoot);
    await writeFixtureFile(fixture.root, "a.ts", "export const n = 0;");
    await writeFixtureFile(secondRoot, "b.ts", "export const n = 0;");
    const indexer = new Indexer({ repository: fixture.repository, store: fixture.store, embedding: fixture.embedding });
    await indexer.index(fixture.root); await indexer.index(secondRoot);
    const compact = vi.spyOn(fixture.store, "compactTable");
    for (let n = 1; n <= 19; n++) { await writeFixtureFile(fixture.root, "a.ts", `export const n = ${n};`); await indexer.index(fixture.root); }
    for (let n = 1; n <= 19; n++) { await writeFixtureFile(secondRoot, "b.ts", `export const n = ${n};`); await indexer.index(secondRoot); }
    expect(compact).not.toHaveBeenCalled();
    await writeFixtureFile(fixture.root, "a.ts", "export const n = 20;");
    const stats = await indexer.index(fixture.root);
    expect(stats).toBeDefined(); expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith(indexer.collectionName(fixture.root));
    expect(compact).not.toHaveBeenCalledWith(indexer.collectionName(secondRoot));
    expect(fixture.repository.getCodebase(fixture.root)?.status).toBe("indexed");
    expect(fixture.repository.getCodebase(secondRoot)?.status).toBe("indexed");
  });

  it("retries failed maintenance on the next successful unchanged job", async () => {
    const store = new CountingStore(); const fixture = await createServiceFixture({ store }); fixtures.push(fixture);
    await writeFixtureFile(fixture.root, "a.ts", "export const n = 0;"); let job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId);
    for (let n = 1; n <= 19; n++) { await writeFixtureFile(fixture.root, "a.ts", `export const n = ${n};`); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); }
    const oldHash = fixture.repository.getFileHashes(fixture.root)["a.ts"];
    const compact = vi.spyOn(store, "compactTable").mockRejectedValueOnce(new Error("maintenance")); const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await writeFixtureFile(fixture.root, "a.ts", "export const n = 20;"); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId);
    expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("completed"); expect(compact).toHaveBeenCalledTimes(1);
    expect(fixture.repository.getFileHashes(fixture.root)["a.ts"]).not.toBe(oldHash); expect(store.getRows((fixture.service as any).indexer.collectionName(fixture.root)).map((row) => row.text)).toContain("export const n = 20;"); expect(error).toHaveBeenCalled();
    job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("completed"); expect(compact).toHaveBeenCalledTimes(2);
    job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("completed"); expect(compact).toHaveBeenCalledTimes(2);
  });

  it("retains the counter across an embedding failure", async () => {
    const store = new CountingStore(); const fixture = await createServiceFixture({ store }); fixtures.push(fixture);
    await writeFixtureFile(fixture.root, "a.ts", "export const n = 0;"); let job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId);
    for (let n = 1; n <= 19; n++) { await writeFixtureFile(fixture.root, "a.ts", `export const n = ${n};`); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); }
    const compact = vi.spyOn(store, "compactTable"); fixture.embedding.rejectTextContaining("fail_marker"); await writeFixtureFile(fixture.root, "a.ts", "export const fail_marker = true;"); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId);
    expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("failed"); expect(compact).not.toHaveBeenCalled();
    fixture.embedding.rejectTextContaining("never"); await writeFixtureFile(fixture.root, "a.ts", "export const n = 20;"); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("completed"); expect(compact).toHaveBeenCalledTimes(1);
  });

  it.each(["force", "clear"] as const)("resets maintenance after %s", async (mode) => {
    const store = new CountingStore(); const fixture = await createServiceFixture({ store }); fixtures.push(fixture);
    await writeFixtureFile(fixture.root, "a.ts", "export const n = 0;"); let job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId);
    for (let n = 1; n <= 19; n++) { await writeFixtureFile(fixture.root, "a.ts", `export const n = ${n};`); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); }
    const compact = vi.spyOn(store, "compactTable");
    if (mode === "force") { job = await fixture.service.index({ path: fixture.root, force: true }); await waitForJob(fixture.service, job.jobId); } else { await fs.access(fixture.root); const clearJob = await fixture.service.clear({ path: fixture.root }); await waitForJob(fixture.service, clearJob.jobId); await writeFixtureFile(fixture.root, "a.ts", "export const n = 0;"); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); }
    await writeFixtureFile(fixture.root, "a.ts", "export const n = 1;"); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("completed"); expect(compact).not.toHaveBeenCalled();
    for (let n = 2; n <= 20; n++) { await writeFixtureFile(fixture.root, "a.ts", `export const n = ${n};`); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("completed"); }
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("compacts once for a batch of 25 edits", async () => {
    const store = new CountingStore(); const fixture = await createServiceFixture({ store }); fixtures.push(fixture);
    for (let n = 0; n < 25; n++) await writeFixtureFile(fixture.root, `f${n}.ts`, `export const n = ${n};`);
    const compact = vi.spyOn(store, "compactTable"); let job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("completed"); expect(compact).not.toHaveBeenCalled();
    for (let n = 0; n < 25; n++) await writeFixtureFile(fixture.root, `f${n}.ts`, `export const n = ${n + 1};`);
    job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("completed"); expect(compact).toHaveBeenCalledTimes(1);
  });

  it("resets after large orphan retention and does not compact the next edit", async () => {
    const store = new CountingStore(); const fixture = await createServiceFixture({ store }); fixtures.push(fixture);
    await writeFixtureFile(fixture.root, "a.ts", "export const n = 0;"); let job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId);
    for (let n = 1; n <= 19; n++) { await writeFixtureFile(fixture.root, "a.ts", `export const n = ${n};`); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); }
    const collection = (fixture.service as any).indexer.collectionName(fixture.root); const rows = Array.from({ length: 51 }, (_, n) => ({ id: `orphan-${n}`, relativePath: `orphan-${n}.ts`, vector: [0], text: "o", startLine: 1, endLine: 1, fileExtension: ".ts", metadata: "{}", codebasePath: fixture.root })); await store.insert(collection, rows as any);
    const retain = vi.spyOn(store, "retainRelativePaths"); const compact = vi.spyOn(store, "compactTable"); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("completed"); expect(retain).toHaveBeenCalledTimes(1); expect(compact).not.toHaveBeenCalled();
    await writeFixtureFile(fixture.root, "a.ts", "export const n = 20;"); job = await fixture.service.index({ path: fixture.root }); await waitForJob(fixture.service, job.jobId); expect((await fixture.service.getStatus({ jobId: job.jobId })).job?.state).toBe("completed"); expect(compact).not.toHaveBeenCalled();
  });
});
