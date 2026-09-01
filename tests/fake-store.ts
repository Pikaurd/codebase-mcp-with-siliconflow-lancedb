import type { Document, SearchResult } from "../src/types.js";

interface FakeRow {
  id: string;
  relativePath: string;
  vector: number[];
  text: string;
  startLine: number;
  endLine: number;
  fileExtension: string;
  metadata: string;
  codebasePath: string;
}

/**
 * Minimal in-memory store that mirrors LanceDBStore's core interface.
 * No external dependencies — used for unit testing incremental indexing logic.
 */
export class FakeStore {
  private tables: Map<string, FakeRow[]> = new Map();

  async hasTable(name: string): Promise<boolean> {
    return this.tables.has(name);
  }

  async prepareTable(name: string): Promise<void> {
    this.tables.set(name, []);
  }

  async insert(name: string, documents: Document[]): Promise<void> {
    if (documents.length === 0) return;
    if (!this.tables.has(name)) {
      this.tables.set(name, []);
    }
    const rows: FakeRow[] = documents.map((doc) => ({
      id: doc.id,
      relativePath: doc.relativePath,
      vector: doc.vector,
      text: doc.text,
      startLine: doc.startLine,
      endLine: doc.endLine,
      fileExtension: doc.fileExtension,
      metadata: doc.metadata,
      codebasePath: doc.codebasePath,
    }));
    this.tables.get(name)!.push(...rows);
  }

  async replaceByRelativePath(
    name: string,
    relativePath: string,
    documents: Document[],
  ): Promise<void> {
    const rows = this.tables.get(name) ?? [];
    const replacement = documents.map((doc) => ({ ...doc }));
    this.tables.set(
      name,
      rows.filter((row) => row.relativePath !== relativePath).concat(replacement),
    );
  }

  async deleteByRelativePaths(name: string, relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    const rows = this.tables.get(name);
    if (!rows) return;
    const pathSet = new Set(relativePaths);
    this.tables.set(name, rows.filter((r) => !pathSet.has(r.relativePath)));
  }

  async dropTable(name: string): Promise<void> {
    this.tables.delete(name);
  }

  async getRowCount(name: string): Promise<number> {
    return this.tables.get(name)?.length ?? 0;
  }

  async search(
    name: string,
    _queryVector: number[],
    _queryText: string,
    limit = 10,
  ): Promise<SearchResult[]> {
    return (this.tables.get(name) ?? []).slice(0, limit).map((row) => ({
      id: row.id,
      text: row.text,
      relativePath: row.relativePath,
      startLine: row.startLine,
      endLine: row.endLine,
      fileExtension: row.fileExtension,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      score: 1,
    }));
  }

  getRows(name: string): FakeRow[] {
    return this.tables.get(name) ?? [];
  }

  getRelativePaths(name: string): string[] {
    const rows = this.tables.get(name) ?? [];
    return [...new Set(rows.map((r) => r.relativePath))];
  }
}
