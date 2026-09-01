import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ServiceError } from "../src/errors.js";
import { canonicalizeAllowedPath } from "../src/path-policy.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codebase-mcp-path-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("canonicalizeAllowedPath", () => {
  it("returns the resolved real path for an existing directory inside an allowed root", async () => {
    const root = createTemporaryDirectory();
    const project = path.join(root, "project");
    fs.mkdirSync(project);

    await expect(canonicalizeAllowedPath(path.join(project, "."), [root])).resolves.toBe(
      fs.realpathSync(project),
    );
  });

  it("rejects a path that does not exist with an actionable PATH_NOT_FOUND error", async () => {
    const root = createTemporaryDirectory();

    await expect(canonicalizeAllowedPath(path.join(root, "missing"), [root]))
      .rejects.toMatchObject<ServiceError>({
        code: "PATH_NOT_FOUND",
        suggestedAction: "Use an existing directory inside CODEBASE_MCP_ALLOWED_ROOTS",
      });
  });

  it("rejects a directory outside every allowed root", async () => {
    const root = createTemporaryDirectory();
    const outside = createTemporaryDirectory();

    await expect(canonicalizeAllowedPath(outside, [root]))
      .rejects.toMatchObject<ServiceError>({
        code: "PATH_NOT_ALLOWED",
        suggestedAction: "Use a path inside CODEBASE_MCP_ALLOWED_ROOTS",
      });
  });

  it("rejects a symlink inside an allowed root that resolves outside it", async () => {
    const root = createTemporaryDirectory();
    const outside = createTemporaryDirectory();
    const escapedPath = path.join(root, "escape");
    fs.symlinkSync(outside, escapedPath, "dir");

    await expect(canonicalizeAllowedPath(escapedPath, [root]))
      .rejects.toMatchObject<ServiceError>({ code: "PATH_NOT_ALLOWED" });
  });

  it("rejects an existing file because codebases must be directories", async () => {
    const root = createTemporaryDirectory();
    const file = path.join(root, "README.md");
    fs.writeFileSync(file, "not a codebase");

    await expect(canonicalizeAllowedPath(file, [root]))
      .rejects.toMatchObject<ServiceError>({ code: "PATH_NOT_FOUND" });
  });
});
