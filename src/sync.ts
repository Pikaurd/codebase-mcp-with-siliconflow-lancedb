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
  private canonicalCodebasePath?: Promise<string>;
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
      const gitignore = await this.readFile(path.join(this.codebasePath, ".gitignore"));
      this.ig.add(gitignore);
    } catch {}

    // Load .contextignore
    try {
      const contextignore = await this.readFile(path.join(this.codebasePath, ".contextignore"));
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
    const canonicalRoot = await this.getCanonicalCodebasePath();
    await this.walkDir(this.codebasePath, canonicalRoot, new Set(), allFiles);
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

  private async walkGitRepo(
    dir: string,
    canonicalRoot: string,
    visitedDirectories: Set<string>,
    result: string[],
  ): Promise<void> {
    try {
      const output = execSync(
        "git ls-files --cached --others --exclude-standard",
        { cwd: dir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
      );
      for (const line of output.split("\n")) {
        const relativePath = line.trim();
        if (!relativePath) continue;
        await this.addDiscoveredFile(path.join(dir, relativePath), canonicalRoot, result);
      }
    } catch {
      // git failed, fallback to walk + ignore
      await this.walkDirFallback(dir, canonicalRoot, visitedDirectories, result, true);
    }
  }

  private async walkDir(
    dir: string,
    canonicalRoot: string,
    visitedDirectories: Set<string>,
    result: string[],
  ): Promise<void> {
    const canonicalDirectory = await this.realPathWithinRoot(dir, canonicalRoot);
    if (!canonicalDirectory || visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);
    // Nested git repo (submodule): use git ls-files so its own .gitignore is respected
    // The root directory (codebasePath) is already covered by loadIgnoreFiles, so skip git ls-files there
    if (dir !== this.codebasePath && (await this.isGitRepo(dir))) {
      await this.walkGitRepo(dir, canonicalRoot, visitedDirectories, result);
      return;
    }
    await this.walkDirFallback(dir, canonicalRoot, visitedDirectories, result, true);
  }

  private async walkDirFallback(
    dir: string,
    canonicalRoot: string,
    visitedDirectories: Set<string>,
    result: string[],
    alreadyVisited = false,
  ): Promise<void> {
    const canonicalDirectory = await this.realPathWithinRoot(dir, canonicalRoot);
    if (!canonicalDirectory) return;
    if (!alreadyVisited) {
      if (visitedDirectories.has(canonicalDirectory)) return;
      visitedDirectories.add(canonicalDirectory);
    }
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
          const canonicalTarget = await this.realPathWithinRoot(fullPath, canonicalRoot);
          if (!canonicalTarget) continue;
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            await this.walkDir(fullPath, canonicalRoot, visitedDirectories, result);
          } else if (stat.isFile()) {
            result.push(fullPath);
          }
        } catch {
          // broken symlink, skip
        }
      } else if (entry.isFile()) {
        await this.addDiscoveredFile(fullPath, canonicalRoot, result);
      }
    }
  }

  private async getCanonicalCodebasePath(): Promise<string> {
    this.canonicalCodebasePath ??= fs.realpath(this.codebasePath);
    return this.canonicalCodebasePath;
  }

  private async realPathWithinRoot(
    candidate: string,
    canonicalRoot: string,
  ): Promise<string | undefined> {
    try {
      const canonicalTarget = await fs.realpath(candidate);
      const relative = path.relative(canonicalRoot, canonicalTarget);
      if (
        relative === ""
        || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      ) {
        return canonicalTarget;
      }
    } catch {
      // Missing and broken targets are not discoverable.
    }
    return undefined;
  }

  private async addDiscoveredFile(
    filePath: string,
    canonicalRoot: string,
    result: string[],
  ): Promise<void> {
    const canonicalTarget = await this.realPathWithinRoot(filePath, canonicalRoot);
    if (!canonicalTarget) return;
    try {
      if ((await fs.stat(canonicalTarget)).isFile()) result.push(filePath);
    } catch {
      // The file changed between discovery checks; retry on the next sync.
    }
  }

  hashContent(content: string): string {
    return createHash("md5").update(content).digest("hex");
  }

  async computeFileHash(filePath: string): Promise<string> {
    const content = await this.readFile(filePath);
    return this.hashContent(content);
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

      let newHash: string;
      try {
        newHash = await this.computeFileHash(filePath);
      } catch {
        // File is unreadable (deleted between discover and read, permissions, etc.)
        // Skip it — it will be picked up on the next sync.
        console.error(`[sync] cannot read file: ${relativePath}`);
        continue;
      }

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
    const canonicalRoot = await this.getCanonicalCodebasePath();
    if (!(await this.realPathWithinRoot(filePath, canonicalRoot))) {
      throw new Error("Refusing to read a file outside the codebase root");
    }
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
