import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LanceDBStore } from "../src/store.js";
import type { Document } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

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
