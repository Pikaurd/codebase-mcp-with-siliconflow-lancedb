import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";
import ignore from "ignore";
import { createHash } from "crypto";

const SUPPORTED_EXTENSIONS = new Set([
  ".dart", ".ts", ".tsx", ".js", ".jsx", ".kt", ".java",
  ".swift", ".m", ".mm", ".h", ".py", ".go", ".rs", ".cpp", ".c",
  ".yaml", ".yml", ".json", ".xml", ".proto",
]);

const DEFAULT_IGNORE_PATTERNS = [
  // Version control
  ".git",
  // Build & tools
  "node_modules",
  "build",
  ".build",
  "buildSystem",
  ".dart_tool",
  "ephemeral",
  ".gradle",
  "gradle",
  "Pods",
  "pubcachePath",
  ".pub-cache",
  // Platform generated dirs
  ".ios",
  ".android",
  "ios/Runner/Generated.xcconfig",
  "ios/Flutter/Generated.xcconfig",
  // IDE & config
  ".idea",
  ".vscode",
  ".DS_Store",
  "*.lock",
  "xcuserdata",
  "xcshareddata",
  ".bundle",
  // Generated code
  "*.g.dart",
  "*.freezed.dart",
  "*.gr.dart",
  "*.g.yaml",
  // Assets (not code)
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.svg",
  "*.ico",
  "*.pdf",
  "*.zip",
  "*.tar.gz",
  "*.ttf",
  "*.otf",
  "*.woff",
  "*.woff2",
  "*.mp4",
  "*.mp3",
  "*.wav",
  "*.webp",
  // Xcode / CMake
  "*.xcodeproj",
  "*.xcworkspace",
  "*.cmake",
];

export class FileSynchronizer {
  private codebasePath: string;
  private hashes: Map<string, string> = new Map();
  private ig: ReturnType<typeof ignore>;

  constructor(
    codebasePath: string,
    customIgnorePatterns: string[] = []
  ) {
    this.codebasePath = path.resolve(codebasePath);
    this.ig = ignore().add([...DEFAULT_IGNORE_PATTERNS, ...customIgnorePatterns]);
  }

  async loadIgnoreFiles(): Promise<void> {
    // Load .gitignore
    try {
      const gitignore = await fs.readFile(
        path.join(this.codebasePath, ".gitignore"),
        "utf-8"
      );
      this.ig.add(gitignore);
    } catch {}

    // Load .contextignore
    try {
      const contextignore = await fs.readFile(
        path.join(this.codebasePath, ".contextignore"),
        "utf-8"
      );
      this.ig.add(contextignore);
    } catch {}

    // Load global ~/.context/.contextignore
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
      const globalIgnore = await fs.readFile(
        path.join(homeDir, ".context", ".contextignore"),
        "utf-8"
      );
      this.ig.add(globalIgnore);
    } catch {}
  }

  async discoverFiles(): Promise<string[]> {
    const allFiles: string[] = [];
    await this.walkDir(this.codebasePath, allFiles);
    return allFiles.filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return SUPPORTED_EXTENSIONS.has(ext);
    });
  }

  private async isGitRepo(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(dir, ".git"));
      // .git can be a directory (regular repo) or a file (gitlinks, submodules)
      return stat.isDirectory() || stat.isFile();
    } catch {
      return false;
    }
  }

  private async walkGitRepo(dir: string, result: string[]): Promise<void> {
    try {
      const output = execSync(
        "git ls-files --cached --others --exclude-standard",
        { cwd: dir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
      );
      for (const line of output.split("\n")) {
        const relativePath = line.trim();
        if (!relativePath) continue;
        result.push(path.join(dir, relativePath));
      }
    } catch {
      // git failed, fallback to walk + ignore
      await this.walkDirFallback(dir, result);
    }
  }

  private async walkDir(dir: string, result: string[]): Promise<void> {
    // Nested git repo (submodule): use git ls-files so its own .gitignore is respected
    // The root directory (codebasePath) is already covered by loadIgnoreFiles, so skip git ls-files there
    if (dir !== this.codebasePath && (await this.isGitRepo(dir))) {
      await this.walkGitRepo(dir, result);
      return;
    }
    await this.walkDirFallback(dir, result);
  }

  private async walkDirFallback(dir: string, result: string[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(this.codebasePath, fullPath);

      if (this.ig.ignores(relativePath)) continue;

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // Resolve symlink to check if it points to a directory
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            await this.walkDir(fullPath, result);
          } else if (stat.isFile()) {
            result.push(fullPath);
          }
        } catch {
          // broken symlink, skip
        }
      } else if (entry.isFile()) {
        result.push(fullPath);
      }
    }
  }

  hashContent(content: string): string {
    return createHash("md5").update(content).digest("hex");
  }

  async computeFileHash(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return this.hashContent(content);
    } catch {
      return "";
    }
  }

  setHashes(hashes: Record<string, string>): void {
    for (const [k, v] of Object.entries(hashes)) {
      this.hashes.set(k, v);
    }
  }

  getHashes(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of this.hashes) {
      result[k] = v;
    }
    return result;
  }

  /**
   * Returns paths of files that have changed (new or modified) and
   * paths of files that have been removed.
   */
  async detectChanges(): Promise<{
    changed: string[];
    removed: string[];
  }> {
    const currentFiles = await this.discoverFiles();
    const changed: string[] = [];
    const currentPaths = new Set<string>();

    for (const filePath of currentFiles) {
      const relativePath = path.relative(this.codebasePath, filePath);
      currentPaths.add(relativePath);
      const newHash = await this.computeFileHash(filePath);
      if (newHash === "") continue;

      const oldHash = this.hashes.get(relativePath);
      if (!oldHash || oldHash !== newHash) {
        changed.push(filePath);
      }
    }

    const removed: string[] = [];
    for (const relativePath of this.hashes.keys()) {
      if (!currentPaths.has(relativePath)) {
        removed.push(relativePath);
      }
    }

    return { changed, removed };
  }

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, "utf-8");
  }

  updateHash(relativePath: string, hash: string): void {
    this.hashes.set(relativePath, hash);
  }

  removeHash(relativePath: string): void {
    this.hashes.delete(relativePath);
  }

  getCodebasePath(): string {
    return this.codebasePath;
  }

  getCollectionName(): string {
    const hash = createHash("md5")
      .update(this.codebasePath)
      .digest("hex")
      .substring(0, 16);
    return `codebase_${hash}`;
  }
}
