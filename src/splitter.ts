import type { Chunk } from "./types.js";

interface SplitRule {
  /** Check if a line starts a new block */
  startsBlock(line: string): boolean;
  /** Check if a line looks like a block boundary */
  isBoundary(line: string): boolean;
}

// Dart/Flutter
const dartRule: SplitRule = {
  startsBlock(line: string) {
    return /^(class\s+\w+|enum\s+\w+|mixin\s+\w+|extension\s+\w+|typedef\s)/.test(line);
  },
  isBoundary(line: string) {
    return /^(\s*\/\/\/|\s*@\w+)/.test(line) || dartRule.startsBlock(line);
  },
};

// JS/TS/Kotlin/Java
const jsLikeRule: SplitRule = {
  startsBlock(line: string) {
    return /^(class\s+\w+|interface\s+\w+|enum\s+\w+|abstract\s+class|@\w+)/.test(line);
  },
  isBoundary(line: string) {
    return (
      /^(\s*\/\*\*|\s*\*\/|\s*\/\/\/|\s*@\w+)/.test(line) ||
      /^(export\s+)?(class|interface|enum|abstract|function)\s+\w+/.test(line) ||
      /^(export\s+)?(async\s+)?function\s+\w+/.test(line)
    );
  },
};

// Python
const pythonRule: SplitRule = {
  startsBlock(line: string) {
    return /^(class\s+\w+|def\s+\w+|async\s+def\s+\w+)/.test(line);
  },
  isBoundary(line: string) {
    return (
      /^(class\s+\w+|def\s+\w+|async\s+def\s+\w+|@\w+|if\s+__name__)/.test(line)
    );
  },
};

// ObjC/Swift
const objcRule: SplitRule = {
  startsBlock(line: string) {
    return /^(@interface\s+\w+|@implementation\s+\w+|@protocol\s+\w+|class\s+\w+)/.test(line);
  },
  isBoundary(line: string) {
    return (
      /^(@interface\s+\w+|@implementation\s+\w+|@protocol\s+\w+|@end|#pragma\s+mark)/.test(
        line
      ) ||
      /^(class\s+\w+|struct\s+\w+|extension\s+\w+|protocol\s+\w+)/.test(line)
    );
  },
};

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    dart: "dart",
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    kt: "kotlin",
    java: "java",
    swift: "swift",
    m: "objective-c",
    mm: "objective-c",
    h: "c",
    py: "python",
    go: "go",
    rs: "rust",
    cpp: "cpp",
    c: "c",
  };
  return map[ext] || ext;
}

function getRule(language: string): SplitRule | null {
  switch (language) {
    case "dart":
    case "kotlin":
      return dartRule;
    case "typescript":
    case "tsx":
    case "javascript":
    case "jsx":
    case "java":
      return jsLikeRule;
    case "python":
      return pythonRule;
    case "objective-c":
    case "swift":
    case "c":
    case "cpp":
      return objcRule;
    default:
      return null;
  }
}

function generateId(
  relativePath: string,
  startLine: number,
  endLine: number,
  content: string
): string {
  const hash = simpleHash(content);
  return `${relativePath}:${startLine}-${endLine}:${hash}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

const MIN_CHUNK_CHARS = 50;
const MAX_CHUNK_CHARS = 1500;

export function splitCode(
  content: string,
  filePath: string,
  codebasePath: string
): Chunk[] {
  const language = detectLanguage(filePath);
  const rule = getRule(language);
  const lines = content.split("\n");

  if (!rule || lines.length < 5) {
    // Fallback: simple paragraph-based splitting
    return simpleSplit(content, filePath, codebasePath, language);
  }

  // AST-aware splitting: group lines into logical blocks
  const blocks: { startLine: number; endLine: number }[] = [];
  let blockStart = 0;

  for (let i = 1; i < lines.length; i++) {
    const isBlockStart =
      rule.startsBlock(lines[i]) || (rule.isBoundary(lines[i]) && lines[i].trim() !== "");
    if (isBlockStart && i - blockStart > 2) {
      blocks.push({ startLine: blockStart, endLine: i - 1 });
      blockStart = i;
    }
  }
  // Don't forget the last block
  if (blockStart < lines.length) {
    blocks.push({ startLine: blockStart, endLine: lines.length - 1 });
  }

  // Merge small blocks with neighbors
  const merged: typeof blocks = [];
  for (const block of blocks) {
    const blockContent = lines.slice(block.startLine, block.endLine + 1).join("\n");
    if (
      merged.length > 0 &&
      blockContent.length < MIN_CHUNK_CHARS &&
      merged[merged.length - 1].startLine !== 0 // don't merge imports/header
    ) {
      merged[merged.length - 1].endLine = block.endLine;
    } else {
      merged.push(block);
    }
  }

  // Split oversized blocks
  const chunks: Chunk[] = [];
  for (const block of merged) {
    const blockLines = lines.slice(block.startLine, block.endLine + 1);
    const blockContent = blockLines.join("\n");

    if (blockContent.length <= MAX_CHUNK_CHARS) {
      chunks.push(makeChunk(content, block.startLine, block.endLine, filePath, codebasePath, language));
    } else {
      // Split large block into smaller pieces
      const subChunks = splitLargeBlock(lines, block.startLine, block.endLine, rule);
      for (const sc of subChunks) {
        chunks.push(makeChunk(content, sc.startLine, sc.endLine, filePath, codebasePath, language));
      }
    }
  }

  return chunks.filter((c) => c.content.trim().length > 10);
}

function splitLargeBlock(
  lines: string[],
  start: number,
  end: number,
  rule: SplitRule
): { startLine: number; endLine: number }[] {
  const result: { startLine: number; endLine: number }[] = [];
  let subStart = start;

  for (let i = start + 1; i <= end; i++) {
    const currentContent = lines.slice(subStart, i + 1).join("\n");
    if (currentContent.length > MAX_CHUNK_CHARS) {
      result.push({ startLine: subStart, endLine: i - 1 });
      subStart = i;
    }
  }

  if (subStart <= end) {
    result.push({ startLine: subStart, endLine: end });
  }

  return result.length > 0 ? result : [{ startLine: start, endLine: end }];
}

function simpleSplit(
  content: string,
  filePath: string,
  codebasePath: string,
  language: string
): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  let blockStart = 0;

  for (let i = 1; i < lines.length; i++) {
    const currentBlock = lines.slice(blockStart, i + 1).join("\n");
    if (currentBlock.length > MAX_CHUNK_CHARS) {
      chunks.push(makeChunk(content, blockStart, i - 1, filePath, codebasePath, language));
      blockStart = i;
    }
  }

  if (blockStart < lines.length) {
    chunks.push(makeChunk(content, blockStart, lines.length - 1, filePath, codebasePath, language));
  }

  return chunks;
}

function makeChunk(
  content: string,
  startLine: number,
  endLine: number,
  filePath: string,
  codebasePath: string,
  language: string
): Chunk {
  const lines = content.split("\n");
  const chunkContent = lines.slice(startLine, endLine + 1).join("\n");
  const relativePath = filePath.startsWith(codebasePath)
    ? filePath.slice(codebasePath.length + 1)
    : filePath;

  return {
    content: chunkContent,
    startLine: startLine + 1, // 1-indexed
    endLine: endLine + 1,
    metadata: {
      filePath,
      language,
    },
  };
}

export { generateId, detectLanguage };
