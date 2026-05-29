import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { FileSynchronizer } from "../src/sync.js";

const TMP_DIR = path.join(import.meta.dirname, "..", ".tmp_test");

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

describe("FileSynchronizer", () => {
  afterEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  describe("discoverFiles", () => {
    it("respects .gitignore when discovering files in root repo", async () => {
      await ensureDir(TMP_DIR);

      // Source file (should be indexed)
      await writeFile(path.join(TMP_DIR, "src", "main.ts"), `console.log("hello");`);

      // Build artifact (should be ignored via .gitignore)
      await writeFile(path.join(TMP_DIR, "build", "output.js"), `console.log("out");`);
      await writeFile(path.join(TMP_DIR, ".gitignore"), "/build/\n");

      const syncer = new FileSynchronizer(TMP_DIR);
      await syncer.loadIgnoreFiles();
      const files = await syncer.discoverFiles();

      expect(files).toEqual([path.join(TMP_DIR, "src", "main.ts")]);
    });

    it("respects DEFAULT_IGNORE_PATTERNS (build, node_modules, .dart_tool)", async () => {
      await ensureDir(TMP_DIR);

      await writeFile(path.join(TMP_DIR, "src", "main.ts"), `console.log("hello");`);
      await writeFile(path.join(TMP_DIR, "build", "output.js"), `console.log("out");`);
      await writeFile(path.join(TMP_DIR, "node_modules", "dep", "index.js"), `// dep`);
      await writeFile(path.join(TMP_DIR, ".dart_tool", "config.json"), `{}`);

      const syncer = new FileSynchronizer(TMP_DIR);
      const files = await syncer.discoverFiles();

      expect(files).toEqual([path.join(TMP_DIR, "src", "main.ts")]);
    });

    it("handles non-git directories via fallback walk + ignore patterns", async () => {
      await ensureDir(path.join(TMP_DIR, "mysrc"));
      await writeFile(path.join(TMP_DIR, "mysrc", "util.py"), `def foo(): pass`);
      await writeFile(path.join(TMP_DIR, "node_modules", "dep", "index.js"), `// dep`);
      await writeFile(path.join(TMP_DIR, "build", "out.py"), `# out`);

      const syncer = new FileSynchronizer(TMP_DIR);
      const files = await syncer.discoverFiles();

      expect(files).toEqual([path.join(TMP_DIR, "mysrc", "util.py")]);
    });
  });

  describe("submodule support", () => {
    it("uses git ls-files for nested git repos (submodules)", async () => {
      const subDir = path.join(TMP_DIR, "submodule");
      await ensureDir(subDir);

      const { execSync } = await import("child_process");
      execSync("git init", { cwd: subDir });

      // Source files
      await writeFile(path.join(TMP_DIR, "root.ts"), `export const x = 1;`);
      await writeFile(path.join(subDir, "lib", "mod.ts"), `export const y = 2;`);

      // Build artifacts in submodule (should be excluded by its .gitignore)
      await writeFile(path.join(subDir, "build", "out.js"), `// out`);
      await writeFile(path.join(subDir, ".gitignore"), "/build/\n");

      execSync("git add -A", { cwd: subDir });
      execSync("git commit -m init --allow-empty", { cwd: subDir });

      const syncer = new FileSynchronizer(TMP_DIR);
      await syncer.loadIgnoreFiles();
      const files = await syncer.discoverFiles();

      const rootFile = path.join(TMP_DIR, "root.ts");
      const subFile = path.join(subDir, "lib", "mod.ts");
      const buildFile = path.join(subDir, "build", "out.js");

      expect(files).toContain(rootFile);
      expect(files).toContain(subFile);
      expect(files).not.toContain(buildFile);
    });
  });

  describe("SUPPORTED_EXTENSIONS filter", () => {
    it("only returns files with supported extensions", async () => {
      await ensureDir(TMP_DIR);

      await writeFile(path.join(TMP_DIR, "file.ts"), `// ts`);
      await writeFile(path.join(TMP_DIR, "file.dart"), `// dart`);
      await writeFile(path.join(TMP_DIR, "file.py"), `# py`);
      await writeFile(path.join(TMP_DIR, "readme.md"), `# readme`);
      await writeFile(path.join(TMP_DIR, "Makefile"), `all:`);

      const syncer = new FileSynchronizer(TMP_DIR);
      const files = await syncer.discoverFiles();

      expect(files.sort()).toEqual([
        path.join(TMP_DIR, "file.dart"),
        path.join(TMP_DIR, "file.py"),
        path.join(TMP_DIR, "file.ts"),
      ]);
    });
  });

  describe("loadIgnoreFiles", () => {
    it("loads .gitignore, .contextignore, and ~/.context/.contextignore", async () => {
      await ensureDir(TMP_DIR);
      await writeFile(path.join(TMP_DIR, ".gitignore"), "*.tmp\n");

      await writeFile(path.join(TMP_DIR, "src", "a.ts"), `// a`);
      await writeFile(path.join(TMP_DIR, "src", "a.tmp"), `tmp`);

      const syncer = new FileSynchronizer(TMP_DIR);
      await syncer.loadIgnoreFiles();
      const files = await syncer.discoverFiles();

      expect(files).toEqual([path.join(TMP_DIR, "src", "a.ts")]);
    });
  });

  describe("detectChanges", () => {
    it("detects new, modified, and removed files", async () => {
      await ensureDir(TMP_DIR);
      await writeFile(path.join(TMP_DIR, "existing.ts"), `// existing`);

      const syncer = new FileSynchronizer(TMP_DIR);
      syncer.setHashes({
        "existing.ts": syncer.hashContent("// existing"),
        "removed.ts": syncer.hashContent("// removed"),
      });

      const { changed, removed } = await syncer.detectChanges();

      expect(changed).toEqual([]);
      expect(removed).toEqual(["removed.ts"]);
    });
  });
});
