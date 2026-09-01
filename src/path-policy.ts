import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ServiceError } from "./errors.js";

function pathNotFound(): ServiceError {
  return new ServiceError(
    "PATH_NOT_FOUND",
    "The requested path was not found",
    "Use an existing directory inside CODEBASE_MCP_ALLOWED_ROOTS",
  );
}

function pathNotAllowed(): ServiceError {
  return new ServiceError(
    "PATH_NOT_ALLOWED",
    "The requested path is not allowed",
    "Use a path inside CODEBASE_MCP_ALLOWED_ROOTS",
  );
}

function isWithin(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

async function canonicalDirectory(input: string): Promise<string> {
  try {
    const canonicalPath = await realpath(resolve(input));
    if (!(await stat(canonicalPath)).isDirectory()) throw pathNotFound();
    return canonicalPath;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw pathNotFound();
  }
}

export async function canonicalizeAllowedPath(input: string, allowedRoots: string[]): Promise<string> {
  const canonicalPath = await canonicalDirectory(input);

  for (const root of allowedRoots) {
    try {
      if (isWithin(await canonicalDirectory(root), canonicalPath)) return canonicalPath;
    } catch {
      // An unavailable configured root cannot authorize a requested path.
    }
  }

  throw pathNotAllowed();
}
