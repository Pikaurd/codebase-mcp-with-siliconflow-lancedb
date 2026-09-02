import Database from "better-sqlite3";
import * as lancedb from "@lancedb/lancedb";
import path from "node:path";

const dataDir = process.env.CODEBASE_MCP_DATA_DIR ?? ".data";
const db = new Database(path.join(dataDir, "metadata.sqlite"), { readonly: true });
const registered = new Set<string>(
  (db.prepare("SELECT collection_name FROM codebases").all() as { collection_name: string }[])
    .map((row) => row.collection_name),
);
db.close();
const lance = await lancedb.connect(path.join(dataDir, "data"));
const tables = await lance.tableNames();
for (const table of tables) {
  if (registered.has(table)) continue;
  try {
    const rows = await (await lance.openTable(table)).countRows();
    console.log(`${table}\t${rows}`);
    if (process.argv.includes("--apply")) await lance.dropTable(table);
  } catch (error) {
    console.warn(`[prune] unable to inspect ${table}: ${String(error)}`);
  }
}
