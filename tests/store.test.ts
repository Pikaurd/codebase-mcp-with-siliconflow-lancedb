import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LanceDBStore } from "../src/store.js";
import type { Document } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

function doc(id: string, text: string): Document {
  return { id, text, relativePath: "src/a.ts", startLine: 1, endLine: 1, fileExtension: ".ts", vector: new Array(1024).fill(0), metadata: {}, codebasePath: "/repo" };
}

describe("LanceDBStore replacement", () => {
  it("removes superseded chunks and supports empty replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codebase-store-")); roots.push(root);
    const store = new LanceDBStore(root); await store.connect();
    await store.insert("test", [doc("src/a.ts:1-1:old", "old")]);
    await store.replaceByRelativePath("test", "src/a.ts", [doc("src/a.ts:1-1:new", "new")]);
    expect((await store.getAllRelativePaths("test"))).toEqual(["src/a.ts"]);
    expect((await store.search("test", new Array(1024).fill(0), "new", 10)).map((row) => row.id)).toEqual(["src/a.ts:1-1:new"]);
    await store.replaceByRelativePath("test", "src/a.ts", []);
    expect(await store.getAllRelativePaths("test")).toEqual([]);
  });
});

describe("LanceDBStore maintenance and path scans", () => {
  it("scans every row while projecting only relativePath and deduplicates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codebase-store-")); roots.push(root);
    const store = new LanceDBStore(root); await store.connect();
    const rows = Array.from({ length: 30 }, (_, index) => ({ ...doc(`id-${index}`, `text-${index}`), relativePath: `src/${index}.ts` }));
    rows.push({ ...rows[0], id: "duplicate", text: "duplicate" });
    await store.insert("paths", rows);
    const db = (store as any).db;
    const openTable = db.openTable.bind(db);
    const selectArguments: unknown[][] = [];
    const returnedKeys: string[][] = [];
    vi.spyOn(db, "openTable").mockImplementation(async (name: string) => {
      const table = await openTable(name);
      const query = table.query.bind(table);
      vi.spyOn(table, "query").mockImplementation(() => {
        const queryBuilder = query();
        const select = queryBuilder.select.bind(queryBuilder);
        vi.spyOn(queryBuilder, "select").mockImplementation((columns: string[]) => {
          selectArguments.push(columns);
          return select(columns);
        });
        const toArray = queryBuilder.toArray.bind(queryBuilder);
        vi.spyOn(queryBuilder, "toArray").mockImplementation(async () => {
          const result = await toArray();
          returnedKeys.push(...result.map((row: Record<string, unknown>) => Object.keys(row)));
          return result;
        });
        return queryBuilder;
      });
      return table;
    });
    const paths = await store.getAllRelativePaths("paths");
    expect(paths).toHaveLength(30);
    expect(new Set(paths).size).toBe(30);
    expect(paths).toContain("src/29.ts");
    expect(selectArguments).toEqual([["relativePath"]]);
    expect(returnedKeys.length).toBeGreaterThan(25);
    expect(returnedKeys.every((keys) => keys.length === 1 && keys[0] === "relativePath")).toBe(true);
  });

  it("compacts a real table and propagates optimize failures", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codebase-store-")); roots.push(root);
    const store = new LanceDBStore(root); await store.connect();
    await store.insert("compact", [doc("src/a.ts:1-1:x", "x")]);
    const beforeRows = await store.getRowCount("compact");
    const beforeSearch = await store.search("compact", new Array(1024).fill(0), "x", 10);
    await expect(store.compactTable("compact")).resolves.toBeUndefined();
    expect(await store.getRowCount("compact")).toBe(beforeRows);
    const afterSearch = await store.search("compact", new Array(1024).fill(0), "x", 10);
    expect(afterSearch.map(({ id, text }) => ({ id, text }))).toEqual(beforeSearch.map(({ id, text }) => ({ id, text })));
    expect(await store.getAllRelativePaths("compact")).toEqual(["src/a.ts"]);
    const db = (store as any).db;
    const table = await db.openTable("compact");
    const failure = new Error("controlled optimize failure");
    vi.spyOn(table, "optimize").mockRejectedValueOnce(failure);
    vi.spyOn(db, "openTable").mockResolvedValue(table);
    await expect(store.compactTable("compact")).rejects.toBe(failure);
  });
});
