import * as fs from "fs/promises";
import * as path from "path";
import ignore from "ignore";
import { createHash } from "crypto";

const SUPPORTED_EXTENSIONS = new Set([
  ".dart", ".ts", ".tsx", ".js", ".jsx", ".kt", ".java",
  ".swift", ".m", ".mm", ".h", ".py", ".go", ".rs", ".cpp", ".c",
  ".yaml", ".yml", ".json", ".xml", ".proto",
]);

const DEFAULT_IGNORE_PATTERNS = [
  // Build & tools
  "node_modules",
  ".git",
  ".dart_tool",
  "build",
  ".build",
  "buildSystem",
  ".gradle",
  "gradle",
  "Pods",
  "pubcachePath",
  // Platform generated dirs
  ".ios",
  ".android",
  "ios/Runner/Generated.xcconfig",
  // IDE & config
  ".idea",
  ".vscode",
  ".DS_Store",
  "*.lock",
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
  "*.ttf",
  "*.woff*",
  "*.mp4",
  "*.mp3",
  "*.webp",
  // IDE / project files
  "xcuserdata",
  "xcshareddata",
  ".bundle",
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
  "*.woff",
  "*.woff2",
  "*.otf",
  "*.mp4",
  "*.mp3",
  "*.wav",
  "*.webp",
  "*.cmake",
  "*.xcodeproj",
  "*.xcworkspace",
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

  private async walkDir(dir: string, result: string[]): Promise<void> {
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
