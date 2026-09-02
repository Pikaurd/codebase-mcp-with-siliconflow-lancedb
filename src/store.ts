import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import type { Document, SearchResult } from "./types.js";

export interface VectorStoreLike {
  insert(name: string, documents: Document[]): Promise<void>;
  prepareTable(name: string): Promise<void>;
  replaceByRelativePath(name: string, relativePath: string, documents: Document[]): Promise<void>;
  deleteByRelativePaths(name: string, relativePaths: string[]): Promise<void>;
  retainRelativePaths(name: string, keepPaths: Set<string>): Promise<void>;
  dropTable(name: string): Promise<void>;
  hasTable(name: string): Promise<boolean>;
  getRowCount(name: string): Promise<number>;
  getAllRelativePaths(name: string): Promise<string[]>;
  search(
    name: string,
    queryVector: number[],
    queryText: string,
    limit?: number,
  ): Promise<SearchResult[]>;
}

const TABLE_SCHEMA = {
  id: "string",
  vector: new Array(1024),
  text: "string",
  relativePath: "string",
  startLine: 0,
  endLine: 0,
  fileExtension: "string",
  metadata: "string",
  codebasePath: "string",
};

export class LanceDBStore {
  private db: Connection | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async connect(): Promise<void> {
    const fs = await import("fs/promises");
    await fs.mkdir(this.dbPath, { recursive: true });
    this.db = await lancedb.connect(this.dbPath);
  }

  private ensureConnected(): Connection {
    if (!this.db) throw new Error("Not connected. Call connect() first.");
    return this.db;
  }

  async prepareTable(name: string): Promise<void> {
    // Just drop if exists; actual creation happens on first insert
    const db = this.ensureConnected();
    try {
      await db.dropTable(name);
    } catch { }
  }

  async compactTable(name: string): Promise<void> {
    const db = this.ensureConnected();
    try {
      const tbl = await db.openTable(name);
      const compactable = tbl as Table & {
        compactFiles?: () => Promise<unknown>;
        cleanupOldVersions?: (olderThan?: Date, deleteUnverified?: boolean) => Promise<unknown>;
      };
      await compactable.compactFiles?.();
      await compactable.cleanupOldVersions?.(undefined, true);
    } catch {
      // silently skip if compact fails (Node.js LanceDB may not support these)
    }
  }

  async getTableSize(name: string): Promise<string> {
    const db = this.ensureConnected();
    try {
      const tbl = await db.openTable(name);
      const stats = await (tbl as any).countRows?.();
      return `${stats} rows`;
    } catch {
      return "unknown";
    }
  }

  async insert(name: string, documents: Document[]): Promise<void> {
    const db = this.ensureConnected();
    if (documents.length === 0) return;

    const records = this.recordsFor(documents);

    const exists = await this.hasTable(name);
    if (exists) {
      const tbl = await db.openTable(name);
      await tbl.add(records);
    } else {
      const tbl = await db.createTable(name, records);
      try {
        await tbl.createIndex("text", {
          config: lancedb.Index.fts(),
          replace: true,
        });
      } catch {
        // FTS not available; vector search still works
      }
    }
  }

  async replaceByRelativePath(
    name: string,
    relativePath: string,
    documents: Document[],
  ): Promise<void> {
    const db = this.ensureConnected();
    if (!(await db.tableNames()).includes(name)) {
      await this.insert(name, documents);
      return;
    }
    const table = await db.openTable(name);
    await this.deleteByRelativePaths(name, [relativePath]);
    if (documents.length > 0) {
      await (await db.openTable(name)).add(this.recordsFor(documents) as lancedb.Data);
    }
  }

  private recordsFor(documents: Document[]): Array<Record<string, unknown>> {
    return documents.map((doc) => ({
      id: doc.id,
      vector: doc.vector,
      text: doc.text,
      relativePath: doc.relativePath,
      startLine: doc.startLine,
      endLine: doc.endLine,
      fileExtension: doc.fileExtension,
      metadata: doc.metadata,
      codebasePath: doc.codebasePath,
    }));
  }

  private idPrefixFilter(relativePath: string, column = "id"): string {
    const likeSafe = relativePath.replace(/[\\%_]/g, (character) => `\\${character}`);
    const quoted = likeSafe.replace(/'/g, "''");
    return `${column} LIKE '${quoted}:%' ESCAPE '\\'`;
  }

  private async documentsByRelativePath(name: string, relativePath: string): Promise<Document[]> {
    if (!(await this.hasTable(name))) return [];
    const table = await this.ensureConnected().openTable(name);
    const rows = await table.query().limit(Number.MAX_SAFE_INTEGER).toArray();
    return rows
      .filter((row: Record<string, unknown>) => row.relativePath === relativePath)
      .map((row: Record<string, unknown>) => ({
        id: row.id as string,
        vector: Array.from(row.vector as ArrayLike<number>),
        text: row.text as string,
        relativePath: row.relativePath as string,
        startLine: row.startLine as number,
        endLine: row.endLine as number,
        fileExtension: row.fileExtension as string,
        metadata: row.metadata as string,
        codebasePath: row.codebasePath as string,
      }));
  }

  async search(
    name: string,
    queryVector: number[],
    queryText: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    const db = this.ensureConnected();
    const tbl = await db.openTable(name);

    // Vector search
    const candidateLimit = Math.max(limit * 2, 20);
    const vectorResults = await tbl.search(queryVector).limit(candidateLimit).toArray();

    // Hybrid: merge with FTS results (RRF-style ranking)
    // If FTS is available, we do a separate FTS search and merge
    let ftsScores = new Map<string, number>();
    const ftsResultsCache = new Map<string, Record<string, unknown>>();
    let ftsWorked = false;
    try {
      const ftsResults = await tbl.search(queryText).limit(candidateLimit).toArray();
      ftsWorked = ftsResults.length > 0;
      if (ftsWorked) {
        ftsResults.forEach((r: Record<string, unknown>, i: number) => {
          const id = r.id as string;
          ftsResultsCache.set(id, r);
          const rankScore = 1 / (60 + i + 1); // RRF k=60
          ftsScores.set(id, rankScore);
        });
      }
    } catch {
      // FTS might not be available; vector-only results are fine
    }

    const FTS_WEIGHT = 15;
    const scoreThreshold = 0.15;

    const vectorScores = new Map<string, number>();
    vectorResults.forEach((r: Record<string, unknown>) => {
      const distance = (r._distance as number) ?? 0;
      vectorScores.set(r.id as string, 1 - distance / 2);
    });
    const rows = new Map<string, Record<string, unknown>>();
    vectorResults.forEach((r: Record<string, unknown>) => rows.set(r.id as string, r));
    if (ftsWorked) ftsScores.forEach((_, id) => {
      const row = ftsResultsCache.get(id);
      if (row) rows.set(id, row);
    });
    const results: SearchResult[] = [...rows.values()].map(
      (r: Record<string, unknown>) => {
        const id = r.id as string;
        const vectorScore = vectorScores.get(id) ?? 0;
        const ftsScore = ftsScores.get(id) || 0;
        const finalScore = vectorScore + FTS_WEIGHT * ftsScore;

        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse((r.metadata as string) || "{}");
        } catch { }

        return {
          id,
          text: (r.text as string) || "",
          relativePath: (r.relativePath as string) || "",
          startLine: (r.startLine as number) || 0,
          endLine: (r.endLine as number) || 0,
          fileExtension: (r.fileExtension as string) || "",
          metadata,
          score: finalScore,
        };
      }
    );

    return results
      .sort((a, b) => b.score - a.score)
      .filter((r) => r.score > scoreThreshold);
  }

  async deleteByIds(name: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const table = await this.ensureConnected().openTable(name);
    const escaped = ids.map((id) => `'${id.replace(/'/g, "''")}'`);
    const batchSize = 200;
    for (let index = 0; index < escaped.length; index += batchSize) {
      const batch = escaped.slice(index, index + batchSize).join(", ");
      await table.delete(`id IN (${batch})`);
    }
  }

  /**
   * Delete all chunks belonging to the given relative paths.
   * Deletes by `id LIKE '<relativePath>:%'` (chunk ids embed the relative
   * path) because LanceDB's SQL planner cannot reliably match the camelCase
   * `relativePath` column. Avoids the destructive drop+recreate pattern.
   * Falls back to drop+recreate if native delete is unavailable.
   */
  async deleteByRelativePaths(name: string, relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    const db = this.ensureConnected();
    const tbl = await db.openTable(name);

    // Try native row-level delete first.
    // NOTE: LanceDB's SQL planner cannot reliably match the camelCase
    // `relativePath` column -- an unquoted reference errors with
    // "No field named relativepath", while a double-quoted one silently
    // matches 0 rows. Chunk ids are built as
    // `${relativePath}:${start}-${end}:${hash}`, so instead of filtering on
    // relativePath we delete by `id LIKE '<escaped path>:%'`, which is
    // reliable in @lancedb/lancedb ^0.17.0.
    try {
      // Escape LIKE wildcards (\, %, _) in each path, then match the id prefix
      const escaped = relativePaths.map((p) => {
        const likeSafe = p.replace(/[\\%_]/g, (c) => "\\" + c);
        const quoted = likeSafe.replace(/'/g, "''");
        return `id LIKE '${quoted}:%' ESCAPE '\\'`;
      });
      // Batch deletes in chunks to avoid overly long SQL strings
      const BATCH = 200;
      for (let i = 0; i < escaped.length; i += BATCH) {
        const batch = escaped.slice(i, i + BATCH).join(" OR ");
        await tbl.delete(batch);
      }
      return;
    } catch {
      // Native delete failed; fall back to drop+recreate for compatibility
      console.error("[store] native delete failed, falling back to drop+recreate");
    }

    // Fallback: full table rebuild
    const pathSet = new Set(relativePaths);
    const all = await tbl.query().limit(Number.MAX_SAFE_INTEGER).toArray();
    const filtered = all.filter(
      (r: Record<string, unknown>) => !pathSet.has(r.relativePath as string)
    );
    await db.dropTable(name);
    if (filtered.length > 0) {
      const newTbl = await db.createTable(name, filtered as lancedb.Data);
      try {
        await newTbl.createIndex("text", {
          config: lancedb.Index.fts(),
          replace: true,
        });
      } catch { }
    } else {
      await db.createTable(name, [], { mode: "create" });
    }
  }

  async dropTable(name: string): Promise<void> {
    const db = this.ensureConnected();
    try {
      await db.dropTable(name);
    } catch { }
  }

  async hasTable(name: string): Promise<boolean> {
    try {
      const db = this.ensureConnected();
      const names = await db.tableNames();
      return names.includes(name);
    } catch {
      return false;
    }
  }

  async getRowCount(name: string): Promise<number> {
    try {
      const db = this.ensureConnected();
      const tbl = await db.openTable(name);
      const count = await tbl.countRows();
      return count;
    } catch {
      return -1;
    }
  }

  async getAllRelativePaths(name: string): Promise<string[]> {
    try {
      const db = this.ensureConnected();
      const tbl = await db.openTable(name);
      // NOTE: `.query().toArray()` without an explicit limit returns only the
      // first 10 rows (LanceDB's default query limit). A full scan needs an
      // explicit limit; getAllRelativePaths is used by orphan reconcile, so a
      // truncated scan would silently miss orphaned files.
      const all = await tbl.query().limit(Number.MAX_SAFE_INTEGER).toArray();
      return [...new Set(all.map((r: Record<string, unknown>) => r.relativePath as string))];
    } catch {
      return [];
    }
  }

  async listTables(): Promise<string[]> {
    const db = this.ensureConnected();
    return db.tableNames();
  }

  /**
   * Drop+recreate the table keeping only rows whose relativePath is in the
   * keep set. Much faster than deleteByRelativePaths when the orphan set is
   * large — O(total rows) scan once + recreate, instead of O(orphans × versions)
   * of per-path deletes.
   */
  async retainRelativePaths(name: string, keepPaths: Set<string>): Promise<void> {
    const db = this.ensureConnected();
    const tbl = await db.openTable(name);
    const all = await tbl.query().limit(Number.MAX_SAFE_INTEGER).toArray();
    const filtered = all.filter(
      (r: Record<string, unknown>) => keepPaths.has(r.relativePath as string),
    );
    await db.dropTable(name);
    if (filtered.length > 0) {
      const newTbl = await db.createTable(name, filtered as lancedb.Data);
      try {
        await newTbl.createIndex("text", {
          config: lancedb.Index.fts(),
          replace: true,
        });
      } catch { }
    } else {
      await db.createTable(name, [], { mode: "create" });
    }
  }

  getDbPath(): string {
    return this.dbPath;
  }
}
