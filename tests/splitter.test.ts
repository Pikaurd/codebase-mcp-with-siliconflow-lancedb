import { describe, it, expect } from "vitest";
import { splitCode } from "../src/splitter.js";

describe("splitCode oversized single-line handling", () => {
  it("splits a giant single-line JSON into bounded chunks (<= MAX_CHUNK_CHARS)", () => {
    // Mimics a minified data file like gift_6.json: one enormous line.
    const giant =
      "[" +
      Array.from(
        { length: 30000 },
        (_, i) => `{"id":${i},"name":"item number ${i}","fields":["a","b","c"]}`,
      ).join(",") +
      "]";
    expect(giant.length).toBeGreaterThan(1_000_000);
    const chunks = splitCode(giant, "/repo/assets/dice/gift.json", "/repo");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(1500);
      expect(c.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps normal code files unchanged", () => {
    const code = "class Foo {\n  void a() {}\n  void b() {}\n}\n";
    const chunks = splitCode(code, "/repo/lib/a.dart", "/repo");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.content.trim().length > 0)).toBe(true);
  });
});
