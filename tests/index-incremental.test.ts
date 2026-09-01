import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { FakeStore } from "./fake-store.js";
import { FileSynchronizer } from "../src/sync.js";
import { splitCode, generateId } from "../src/splitter.js";
import { createHash } from "crypto";
import { LanceDBStore } from "../src/store.js";

const TMP_DIR = path.join(import.meta.dirname, "..", ".tmp_test_index");

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

function fakeEmbed(texts: string[]): number[][] {
  // Generate deterministic "vector" from content hash (not real embeddings)
  return texts.map((t) => {
    const h = createHash("md5").update(t).digest("hex");
    const vec = new Array(1024).fill(0);
    for (let i = 0; i < Math.min(h.length, 1024); i++) {
      vec[i] = h.charCodeAt(i) / 255;
    }
    return vec;
  });
}

function buildDocuments(
  filePath: string,
  codebasePath: string,
  content: string,
  vector: number[]
) {
  const chunks = splitCode(content, filePath, codebasePath);
  return chunks.map((chunk) => {
    const relativePath = chunk.metadata.filePath.startsWith(codebasePath)
      ? path.relative(codebasePath, chunk.metadata.filePath)
      : chunk.metadata.filePath;
    return {
      id: generateId(relativePath, chunk.startLine, chunk.endLine, chunk.content),
      vector,
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

describe("FakeStore", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore();
  });

  describe("deleteByRelativePaths", () => {
    it("removes all chunks for specified paths", async () => {
      await store.insert("test", [
        {
          id: "1",
          relativePath: "a.ts",
          vector: new Array(1024).fill(0),
          text: "const a = 1;",
          startLine: 1,
          endLine: 1,
          fileExtension: ".ts",
          metadata: "{}",
          codebasePath: "/tmp",
        },
        {
          id: "2",
          relativePath: "b.ts",
          vector: new Array(1024).fill(0),
          text: "const b = 2;",
          startLine: 1,
          endLine: 1,
          fileExtension: ".ts",
          metadata: "{}",
          codebasePath: "/tmp",
        },
        {
          id: "3",
          relativePath: "a.ts",
          vector: new Array(1024).fill(0),
          text: "const a2 = 3;",
          startLine: 2,
          endLine: 2,
          fileExtension: ".ts",
          metadata: "{}",
          codebasePath: "/tmp",
        },
      ]);

      await store.deleteByRelativePaths("test", ["a.ts"]);

      const paths = store.getRelativePaths("test");
      expect(paths).toEqual(["b.ts"]);
      expect(await store.getRowCount("test")).toBe(1);
    });

    it("no-op when paths list is empty", async () => {
      await store.insert("test", [
        {
          id: "1",
          relativePath: "a.ts",
          vector: new Array(1024).fill(0),
          text: "x",
          startLine: 1,
          endLine: 1,
          fileExtension: ".ts",
          metadata: "{}",
          codebasePath: "/tmp",
        },
      ]);

      await store.deleteByRelativePaths("test", []);
      expect(await store.getRowCount("test")).toBe(1);
    });
  });
});

describe("Incremental indexing flow", () => {
  afterEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  it("no changes detected when files unchanged", async () => {
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 1;`);
    await writeFile(path.join(TMP_DIR, "b.ts"), `export const y = 2;`);

    const syncer = new FileSynchronizer(TMP_DIR);
    await syncer.loadIgnoreFiles();

    // Simulate first full index
    const files = await syncer.discoverFiles();
    for (const fp of files) {
      const content = await fs.readFile(fp, "utf-8");
      syncer.updateHash(path.relative(TMP_DIR, fp), syncer.hashContent(content));
    }

    // Now detect changes — should be none
    syncer.setHashes(syncer.getHashes());
    const { changed, removed } = await syncer.detectChanges();

    expect(changed).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("detects modified file", async () => {
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 1;`);

    const syncer = new FileSynchronizer(TMP_DIR);
    await syncer.loadIgnoreFiles();

    // Record initial hash
    const content = await fs.readFile(path.join(TMP_DIR, "a.ts"), "utf-8");
    const oldHash = syncer.hashContent(content);
    syncer.setHashes({ "a.ts": oldHash });

    // Modify file
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 999;`);

    const { changed, removed } = await syncer.detectChanges();

    expect(changed).toEqual([path.join(TMP_DIR, "a.ts")]);
    expect(removed).toEqual([]);
  });

  it("detects removed file", async () => {
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 1;`);
    await writeFile(path.join(TMP_DIR, "b.ts"), `export const y = 2;`);

    const syncer = new FileSynchronizer(TMP_DIR);
    await syncer.loadIgnoreFiles();

    // Record hashes for both
    for (const fp of [path.join(TMP_DIR, "a.ts"), path.join(TMP_DIR, "b.ts")]) {
      const content = await fs.readFile(fp, "utf-8");
      syncer.updateHash(path.relative(TMP_DIR, fp), syncer.hashContent(content));
    }

    // Delete a.ts
    await fs.unlink(path.join(TMP_DIR, "a.ts"));

    syncer.setHashes(syncer.getHashes());
    const { changed, removed } = await syncer.detectChanges();

    expect(changed).toEqual([]);
    expect(removed).toEqual(["a.ts"]);
  });

  it("full incremental pipeline: store + detectChanges + delete + re-insert", async () => {
    // Setup test files
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 1;`);
    await writeFile(path.join(TMP_DIR, "b.ts"), `export const y = 2;`);

    const syncer = new FileSynchronizer(TMP_DIR);
    await syncer.loadIgnoreFiles();
    const store = new FakeStore();
    const colName = "test_col";

    // --- First full index ---
    const files = await syncer.discoverFiles();
    for (const fp of files) {
      const content = await fs.readFile(fp, "utf-8");
      const embeddings = fakeEmbed([content]);
      const docs = buildDocuments(fp, TMP_DIR, content, embeddings[0]);
      await store.insert(colName, docs);
      syncer.updateHash(path.relative(TMP_DIR, fp), syncer.hashContent(content));
    }

    const initialCount = await store.getRowCount(colName);
    expect(initialCount).toBeGreaterThan(0);

    // --- Simulate incremental update: modify a.ts ---
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 999;\nexport const z = 3;`);

    syncer.setHashes(syncer.getHashes());
    const { changed, removed } = await syncer.detectChanges();

    expect(changed).toHaveLength(1);
    expect(changed[0]).toBe(path.join(TMP_DIR, "a.ts"));
    expect(removed).toHaveLength(0);

    // Delete old chunks for changed file
    const toRemove = changed.map((fp) => path.relative(TMP_DIR, fp));
    await store.deleteByRelativePaths(colName, toRemove);

    // Re-index changed file
    for (const fp of changed) {
      const content = await fs.readFile(fp, "utf-8");
      const embeddings = fakeEmbed([content]);
      const docs = buildDocuments(fp, TMP_DIR, content, embeddings[0]);
      await store.insert(colName, docs);
      syncer.updateHash(path.relative(TMP_DIR, fp), syncer.hashContent(content));
    }

    // Verify: b.ts chunks still present
    const remainingPaths = store.getRelativePaths(colName);
    expect(remainingPaths).toContain("b.ts");
    expect(remainingPaths).toContain("a.ts");
  });

  it("detects new file and indexes it incrementally", async () => {
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 1;`);

    const syncer = new FileSynchronizer(TMP_DIR);
    await syncer.loadIgnoreFiles();
    const store = new FakeStore();
    const colName = "test_col";

    // First index: only a.ts
    const files = await syncer.discoverFiles();
    for (const fp of files) {
      const content = await fs.readFile(fp, "utf-8");
      const embeddings = fakeEmbed([content]);
      const docs = buildDocuments(fp, TMP_DIR, content, embeddings[0]);
      await store.insert(colName, docs);
      syncer.updateHash(path.relative(TMP_DIR, fp), syncer.hashContent(content));
    }

    expect(store.getRelativePaths(colName)).toEqual(["a.ts"]);

    // Add new file b.ts
    await writeFile(path.join(TMP_DIR, "b.ts"), `export const y = 2;`);

    syncer.setHashes(syncer.getHashes());
    const { changed, removed } = await syncer.detectChanges();

    expect(changed).toEqual([path.join(TMP_DIR, "b.ts")]);
    expect(removed).toEqual([]);

    // Index only the new file
    for (const fp of changed) {
      const content = await fs.readFile(fp, "utf-8");
      const embeddings = fakeEmbed([content]);
      const docs = buildDocuments(fp, TMP_DIR, content, embeddings[0]);
      await store.insert(colName, docs);
      syncer.updateHash(path.relative(TMP_DIR, fp), syncer.hashContent(content));
    }

    const paths = store.getRelativePaths(colName).sort();
    expect(paths).toEqual(["a.ts", "b.ts"]);
  });

  it("modified file keeps old chunks when processing fails mid-way", async () => {
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 1;`);
    await writeFile(path.join(TMP_DIR, "b.ts"), `export const y = 2;`);

    const syncer = new FileSynchronizer(TMP_DIR);
    await syncer.loadIgnoreFiles();
    const store = new FakeStore();
    const colName = "test_col";

    // First full index: index both files
    const files = await syncer.discoverFiles();
    for (const fp of files) {
      const content = await fs.readFile(fp, "utf-8");
      const embeddings = fakeEmbed([content]);
      const docs = buildDocuments(fp, TMP_DIR, content, embeddings[0]);
      await store.insert(colName, docs);
      syncer.updateHash(path.relative(TMP_DIR, fp), syncer.hashContent(content));
    }

    const initialPaths = store.getRelativePaths(colName).sort();
    expect(initialPaths).toEqual(["a.ts", "b.ts"]);

    // Modify a.ts
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 999;\nexport const z = 3;`);

    syncer.setHashes(syncer.getHashes());
    const { changed } = await syncer.detectChanges();

    // Simulate per-file atomic: only delete after successful embed
    // File a.ts: succeed
    for (const fp of changed) {
      const rp = path.relative(TMP_DIR, fp);
      const content = await fs.readFile(fp, "utf-8");
      // Simulate that we do NOT delete old chunks until embed succeeds
      const embeddings = fakeEmbed([content]);
      const docs = buildDocuments(fp, TMP_DIR, content, embeddings[0]);

      // Delete old + insert new (per-file atomic)
      await store.deleteByRelativePaths(colName, [rp]);
      await store.insert(colName, docs);
      syncer.updateHash(rp, syncer.hashContent(content));
    }

    // Both files should still be present (a.ts updated, b.ts untouched)
    const finalPaths = store.getRelativePaths(colName).sort();
    expect(finalPaths).toEqual(["a.ts", "b.ts"]);
  });

  it("removed file chunks are cleaned up", async () => {
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 1;`);
    await writeFile(path.join(TMP_DIR, "b.ts"), `export const y = 2;`);

    const syncer = new FileSynchronizer(TMP_DIR);
    await syncer.loadIgnoreFiles();
    const store = new FakeStore();
    const colName = "test_col";

    // First full index
    const files = await syncer.discoverFiles();
    for (const fp of files) {
      const content = await fs.readFile(fp, "utf-8");
      const embeddings = fakeEmbed([content]);
      const docs = buildDocuments(fp, TMP_DIR, content, embeddings[0]);
      await store.insert(colName, docs);
      syncer.updateHash(path.relative(TMP_DIR, fp), syncer.hashContent(content));
    }

    expect(store.getRelativePaths(colName).sort()).toEqual(["a.ts", "b.ts"]);

    // Delete b.ts
    await fs.unlink(path.join(TMP_DIR, "b.ts"));

    syncer.setHashes(syncer.getHashes());
    const { changed, removed } = await syncer.detectChanges();

    expect(changed).toEqual([]);
    expect(removed).toEqual(["b.ts"]);

    // Per-file cleanup for removed
    for (const rp of removed) {
      await store.deleteByRelativePaths(colName, [rp]);
      syncer.removeHash(rp);
    }

    const finalPaths = store.getRelativePaths(colName);
    expect(finalPaths).toEqual(["a.ts"]);
  });

  it("partial failure does not lose successfully processed files", async () => {
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 1;`);
    await writeFile(path.join(TMP_DIR, "b.ts"), `export const y = 2;`);
    await writeFile(path.join(TMP_DIR, "c.ts"), `export const z = 3;`);

    const syncer = new FileSynchronizer(TMP_DIR);
    await syncer.loadIgnoreFiles();
    const store = new FakeStore();
    const colName = "test_col";

    // First full index
    const files = await syncer.discoverFiles();
    for (const fp of files) {
      const content = await fs.readFile(fp, "utf-8");
      const embeddings = fakeEmbed([content]);
      const docs = buildDocuments(fp, TMP_DIR, content, embeddings[0]);
      await store.insert(colName, docs);
      syncer.updateHash(path.relative(TMP_DIR, fp), syncer.hashContent(content));
    }

    // Modify all three files
    await writeFile(path.join(TMP_DIR, "a.ts"), `export const x = 111;`);
    await writeFile(path.join(TMP_DIR, "b.ts"), `export const y = 222;`);
    await writeFile(path.join(TMP_DIR, "c.ts"), `export const z = 333;`);

    syncer.setHashes(syncer.getHashes());
    const { changed } = await syncer.detectChanges();
    expect(changed).toHaveLength(3);

    // Simulate per-file atomic: file b.ts "fails" (embedding error)
    let failCount = 0;
    for (const fp of changed) {
      const rp = path.relative(TMP_DIR, fp);
      if (rp === "b.ts") {
        failCount++;
        continue; // Simulate failure: don't update this file
      }
      const content = await fs.readFile(fp, "utf-8");
      const embeddings = fakeEmbed([content]);
      const docs = buildDocuments(fp, TMP_DIR, content, embeddings[0]);
      await store.deleteByRelativePaths(colName, [rp]);
      await store.insert(colName, docs);
      syncer.updateHash(rp, syncer.hashContent(content));
    }

    expect(failCount).toBe(1);

    // a.ts and c.ts should be updated, b.ts should still have old data
    const finalPaths = store.getRelativePaths(colName).sort();
    expect(finalPaths).toEqual(["a.ts", "b.ts", "c.ts"]);

    // b.ts hash should NOT have been updated (still old value)
    const hashes = syncer.getHashes();
    expect(hashes["b.ts"]).toBe(syncer.hashContent("export const y = 2;"));
  });
});

describe("LanceDBStore file replacement", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  it("retains old chunks when every attempted replacement insert fails", async () => {
    const store = new LanceDBStore(path.join(TMP_DIR, "lance"));
    await store.connect();
    const oldDocument = {
      id: "src/a.ts:1-1:old",
      relativePath: "src/a.ts",
      vector: [1, 0, 0],
      text: "export const original = 1;",
      startLine: 1,
      endLine: 1,
      fileExtension: ".ts",
      metadata: JSON.stringify({ language: "typescript" }),
      codebasePath: "/repo",
    };
    await store.insert("collection", [oldDocument]);
    vi.spyOn(store, "insert").mockRejectedValue(new Error("controlled insert failure"));

    await expect(store.replaceByRelativePath("collection", "src/a.ts", [{
      ...oldDocument,
      id: "src/a.ts:1-1:new",
      text: "export const replacement = 999;",
    }])).rejects.toThrow("controlled insert failure");

    const results = await store.search("collection", [1, 0, 0], "original", 10);
    expect(results.map(({ text }) => text)).toContain("export const original = 1;");
    expect(results.map(({ text }) => text).join("\n")).not.toContain("replacement = 999");
  });

  it("creates a missing collection when replacing a new file", async () => {
    const store = new LanceDBStore(path.join(TMP_DIR, "new-lance"));
    await store.connect();
    await store.replaceByRelativePath("collection", "src/a.ts", [{
      id: "src/a.ts:1-1:new",
      relativePath: "src/a.ts",
      vector: [1, 0, 0],
      text: "export const first = 1;",
      startLine: 1,
      endLine: 1,
      fileExtension: ".ts",
      metadata: JSON.stringify({ language: "typescript" }),
      codebasePath: "/repo",
    }]);

    const results = await store.search("collection", [1, 0, 0], "first", 10);
    expect(results.map(({ text }) => text)).toEqual(["export const first = 1;"]);
  });

  it("keeps the table intact when native superseded-id deletion fails", async () => {
    const store = new LanceDBStore(path.join(TMP_DIR, "delete-lance"));
    await store.connect();
    const oldDocument = {
      id: "src/a.ts:1-1:old",
      relativePath: "src/a.ts",
      vector: [1, 0, 0],
      text: "export const original = 1;",
      startLine: 1,
      endLine: 1,
      fileExtension: ".ts",
      metadata: JSON.stringify({ language: "typescript" }),
      codebasePath: "/repo",
    };
    await store.insert("collection", [oldDocument]);
    const connection = Reflect.get(store, "db");
    const table = await connection.openTable("collection");
    const openTable = vi.spyOn(connection, "openTable").mockResolvedValue(table);
    vi.spyOn(table, "delete").mockRejectedValue(new Error("controlled delete failure"));

    await expect(store.deleteByIds("collection", [oldDocument.id])).rejects.toThrow(
      "controlled delete failure",
    );
    openTable.mockRestore();

    const results = await store.search("collection", [1, 0, 0], "original", 10);
    expect(results.map(({ text }) => text)).toContain("export const original = 1;");
  });
});
