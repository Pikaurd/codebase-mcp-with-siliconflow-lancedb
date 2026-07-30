import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import type { Document, SearchResult } from "./types.js";

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
      await tbl.compactFiles();
      await tbl.cleanupOldVersions(undefined, true);
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

    const records = documents.map((doc) => ({
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

  async search(
    name: string,
    queryVector: number[],
    queryText: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    const db = this.ensureConnected();
    const tbl = await db.openTable(name);

    // Vector search
    const vectorResults = await tbl
      .search(queryVector)
      .limit(limit)
      .toArray();

    // Hybrid: merge with FTS results (RRF-style ranking)
    // If FTS is available, we do a separate FTS search and merge
    let ftsScores = new Map<string, number>();
    let ftsWorked = false;
    try {
      const ftsResults = await tbl.search(queryText).limit(limit).toArray();
      ftsWorked = ftsResults.length > 0;
      if (ftsWorked) {
        ftsResults.forEach((r: Record<string, unknown>, i: number) => {
          const id = r.id as string;
          const rankScore = 1 / (60 + i + 1); // RRF k=60
          ftsScores.set(id, rankScore);
        });
      }
    } catch {
      // FTS might not be available; vector-only results are fine
    }

    const vectorWeight = 1.0;
    const ftsWeight = ftsWorked ? 0.0 : 0.0;
    const scoreThreshold = 0.15;

    const results: SearchResult[] = vectorResults.map(
      (r: Record<string, unknown>, i: number) => {
        const id = r.id as string;
        const l2Dist = (r._distance as number) ?? 0;
        const vectorScore = 1 - l2Dist / 2;
        const ftsScore = ftsScores.get(id) || 0;
        const ftsBonus = ftsWorked ? ftsScore * 5 : 0;
        const finalScore = vectorScore * vectorWeight + ftsBonus;

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
      .slice(0, limit)
      .filter((r) => r.score > scoreThreshold);
  }

  async deleteByIds(name: string, ids: string[]): Promise<void> {
    const db = this.ensureConnected();
    const tbl = await db.openTable(name);

    // Try native row-level delete first
    try {
      const escaped = ids.map((id) => `'${id.replace(/'/g, "''")}'`);
      const BATCH = 200;
      for (let i = 0; i < escaped.length; i += BATCH) {
        const batch = escaped.slice(i, i + BATCH).join(", ");
        await tbl.delete(`id IN (${batch})`);
      }
      return;
    } catch {
      console.error("[store] native delete (by id) failed, falling back to drop+recreate");
    }

    // Fallback: full table rebuild
    const all = await tbl.toArray();
    const filtered = all.filter(
      (r: Record<string, unknown>) => !ids.includes(r.id as string)
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

  /**
   * Delete all chunks belonging to the given relative paths.
   * Uses LanceDB native row-level delete (SQL predicate) to avoid
   * the destructive drop+recreate pattern.
   * Falls back to drop+recreate if native delete is unavailable.
   */
  async deleteByRelativePaths(name: string, relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    const db = this.ensureConnected();
    const tbl = await db.openTable(name);

    // Try native row-level delete first (LanceDB ^0.17.0 supports it)
    try {
      // Escape single quotes and wrap each path in quotes for SQL IN clause
      const escaped = relativePaths.map((p) => `'${p.replace(/'/g, "''")}'`);
      // Batch deletes in chunks to avoid overly long SQL strings
      const BATCH = 200;
      for (let i = 0; i < escaped.length; i += BATCH) {
        const batch = escaped.slice(i, i + BATCH).join(", ");
        await tbl.delete(`relativePath IN (${batch})`);
      }
      return;
    } catch {
      // Native delete failed; fall back to drop+recreate for compatibility
      console.error("[store] native delete failed, falling back to drop+recreate");
    }

    // Fallback: full table rebuild
    const pathSet = new Set(relativePaths);
    const all = await tbl.toArray();
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
      const all = await tbl.toArray();
      return [...new Set(all.map((r: Record<string, unknown>) => r.relativePath as string))];
    } catch {
      return [];
    }
  }

  async listTables(): Promise<string[]> {
    const db = this.ensureConnected();
    return db.tableNames();
  }

  getDbPath(): string {
    return this.dbPath;
  }
}
