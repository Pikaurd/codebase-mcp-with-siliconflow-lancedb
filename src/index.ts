#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { EmbeddingProvider } from "./embedding.js";
import { LanceDBStore } from "./store.js";
import { FileSynchronizer } from "./sync.js";
import { splitCode, generateId } from "./splitter.js";
import type { Chunk, Document, Snapshot } from "./types.js";

const DATA_DIR =
  process.env.CODEBASE_MCP_DATA_DIR || path.join(os.homedir(), ".codebase-mcp");

async function loadSnapshot(snapshotPath: string): Promise<Snapshot> {
  try {
    const raw = await fs.readFile(snapshotPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { formatVersion: "v1", codebases: {} };
  }
}

async function saveSnapshot(
  snapshotPath: string,
  snapshot: Snapshot
): Promise<void> {
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  snapshot.lastUpdated = new Date().toISOString();
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
}

async function main() {
  const embedding = new EmbeddingProvider();
  const store = new LanceDBStore(path.join(DATA_DIR, "data"));
  await store.connect();

  const snapshotPath = path.join(DATA_DIR, "snapshots.json");
  const snapshot = await loadSnapshot(snapshotPath);

  // Active indexing tasks (for cancellation)
  const indexingTasks = new Map<string, AbortController>();

  const server = new Server(
    { name: "codebase-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "index_codebase",
        description:
          "Index a codebase directory to enable semantic search. IMPORTANT: You MUST provide an absolute path.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "ABSOLUTE path to the codebase directory to index.",
            },
            force: {
              type: "boolean",
              description: "Force re-indexing even if already indexed",
              default: false,
            },
            splitter: {
              type: "string",
              enum: ["ast", "langchain"],
              description: "Code splitter type (currently only ast is supported)",
              default: "ast",
            },
            customExtensions: {
              type: "array",
              items: { type: "string" },
              description: "Additional file extensions to include",
            },
            ignorePatterns: {
              type: "array",
              items: { type: "string" },
              description: "Additional ignore patterns",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "search_code",
        description:
          "Search the indexed codebase using natural language queries within a specified absolute path.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "ABSOLUTE path to the codebase directory to search in.",
            },
            query: {
              type: "string",
              description: "Natural language query to search for in the codebase",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return",
              default: 10,
              maximum: 50,
            },
            extensionFilter: {
              type: "array",
              items: { type: "string" },
              description: "Optional file extensions filter (e.g., ['.ts','.py'])",
            },
          },
          required: ["path", "query"],
        },
      },
      {
        name: "clear_index",
        description:
          "Clear the search index. IMPORTANT: You MUST provide an absolute path.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "ABSOLUTE path to the codebase directory to clear.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_indexing_status",
        description: "Get the current indexing status of a codebase.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "ABSOLUTE path to the codebase directory.",
            },
          },
          required: ["path"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const absolutePath = path.resolve((args as Record<string, unknown>).path as string);

    try {
      switch (name) {
        case "index_codebase": {
          const force = (args as Record<string, unknown>).force as boolean | undefined;
          const additionalIgnorePatterns =
            ((args as Record<string, unknown>).ignorePatterns as string[]) || [];

          // Check if already indexed
          const existing = snapshot.codebases[absolutePath];
          if (existing && existing.status === "indexed" && !force) {
            return {
              content: [
                {
                  type: "text",
                  text: `Codebase '${absolutePath}' is already indexed (${existing.indexedFiles} files, ${existing.totalChunks} chunks). Use force=true to re-index.`,
                },
              ],
            };
          }

          // Cancel existing task for this codebase
          const existingTask = indexingTasks.get(absolutePath);
          if (existingTask) {
            existingTask.abort();
          }

          const controller = new AbortController();
          indexingTasks.set(absolutePath, controller);

          // Start indexing in background
          (async () => {
            try {
              const cs = snapshot.codebases[absolutePath] || {};
              cs.status = "indexing";
              cs.indexedFiles = 0;
              cs.totalChunks = 0;
              cs.indexStatus = "in_progress";
              cs.requestSplitter =
                ((args as Record<string, unknown>).splitter as string) || "ast";
              cs.lastUpdated = new Date().toISOString();
              cs.fileHashes = {};
              snapshot.codebases[absolutePath] = cs;
              await saveSnapshot(snapshotPath, snapshot);

              const syncer = new FileSynchronizer(
                absolutePath,
                additionalIgnorePatterns
              );
              await syncer.loadIgnoreFiles();
              const files = await syncer.discoverFiles();

              const BATCH_SIZE = Math.max(
                1,
                parseInt(process.env.EMBEDDING_BATCH_SIZE || "10", 10)
              );
              const colName = syncer.getCollectionName();
              const dim = await embedding.detectDimension();

              // Drop and recreate on force
              if (force) {
                await store.prepareTable(colName);
              }

              let chunkBuffer: Chunk[] = [];
              let processedFiles = 0;
              let totalChunks = 0;

              for (const filePath of files) {
                if (controller.signal.aborted) break;

                try {
                  const content = await syncer.readFile(filePath);
                  const chunks = splitCode(content, filePath, absolutePath);

                  for (const chunk of chunks) {
                    chunkBuffer.push(chunk);
                    totalChunks++;

                    if (chunkBuffer.length >= BATCH_SIZE) {
                      await processBatch(
                        chunkBuffer,
                        absolutePath,
                        colName,
                        embedding,
                        store,
                        syncer
                      );
                      chunkBuffer = [];
                    }
                  }

                  const relativePath = path.relative(absolutePath, filePath);
                  const hash = syncer.hashContent(content);
                  syncer.updateHash(relativePath, hash);
                  processedFiles++;
                } catch (err) {
                  // Skip failed files, clear partial buffer
                  console.error(`[index] file failed: ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err).substring(0, 80)}`);
                  chunkBuffer = [];
                }
              }

              // Process remaining
              if (chunkBuffer.length > 0 && !controller.signal.aborted) {
                try {
                  await processBatch(
                    chunkBuffer,
                    absolutePath,
                    colName,
                    embedding,
                    store,
                    syncer
                  );
                } catch (err) {
                  console.error(`[index] final batch failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              }

              // Update snapshot
              const cs2 = snapshot.codebases[absolutePath];
              if (cs2 && !controller.signal.aborted) {
                cs2.status = "indexed";
                cs2.indexedFiles = processedFiles;
                cs2.totalChunks = totalChunks;
                cs2.indexStatus = "completed";
                cs2.lastUpdated = new Date().toISOString();
                cs2.fileHashes = syncer.getHashes();
              }
              await saveSnapshot(snapshotPath, snapshot);
            } catch (err) {
              console.error(`[index] Fatal: ${err instanceof Error ? err.message : String(err)}`);
              const cs3 = snapshot.codebases[absolutePath];
              if (cs3) {
                cs3.status = "indexfailed";
                cs3.indexStatus = "failed";
                cs3.lastUpdated = new Date().toISOString();
              }
              await saveSnapshot(snapshotPath, snapshot);
            } finally {
              indexingTasks.delete(absolutePath);
            }
          })();

          return {
            content: [
              {
                type: "text",
                text: `Started background indexing for codebase '${absolutePath}' using AST splitter.\n\nIndexing is running in the background.`,
              },
            ],
          };
        }

        case "search_code": {
          const query = (args as Record<string, unknown>).query as string;
          const limit = Math.min(
            ((args as Record<string, unknown>).limit as number) || 10,
            50
          );
          const extensionFilter =
            ((args as Record<string, unknown>).extensionFilter as string[]) || [];

          const syncer = new FileSynchronizer(absolutePath);
          await syncer.loadIgnoreFiles();
          const colName = syncer.getCollectionName();

          const hasTable = await store.hasTable(colName);
          if (!hasTable) {
            const existing = snapshot.codebases[absolutePath];
            if (existing && existing.status === "indexed") {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: Index data for '${absolutePath}' has been lost. Please re-index.`,
                  },
                ],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Codebase '${absolutePath}' is not indexed. Please use the index_codebase tool to index it first.`,
                },
              ],
              isError: true,
            };
          }

          const queryEmbedding = await embedding.embedSingle(query);
          const results = await store.search(
            colName,
            queryEmbedding.vector,
            query,
            limit
          );

          const filtered = extensionFilter.length > 0
            ? results.filter((r) =>
                extensionFilter.some(
                  (ext) => r.fileExtension.toLowerCase() === ext.toLowerCase()
                )
              )
            : results;

          if (filtered.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No results found for query: "${query}" in codebase '${absolutePath}'`,
                },
              ],
            };
          }

          const formatted = filtered
            .map(
              (r, i) =>
                `${i + 1}. Code snippet (${r.metadata.language || "unknown"}) [${path.basename(absolutePath)}]\n` +
                `   Location: ${r.relativePath}:${r.startLine}-${r.endLine}\n` +
                `   Rank: ${i + 1}\n` +
                `   Context: \n\`\`\`${r.metadata.language || ""}\n${r.text}\n\`\`\`\n`
            )
            .join("\n");

          const indexingNote =
            snapshot.codebases[absolutePath]?.indexStatus === "in_progress"
              ? "\nNote: Indexing is still in progress. Results may be incomplete."
              : "";

          return {
            content: [
              {
                type: "text",
                text: `Found ${filtered.length} results for query: "${query}" in codebase '${absolutePath}'\n\n` +
                  formatted +
                  indexingNote,
              },
            ],
          };
        }

        case "clear_index": {
          // Cancel in-progress indexing
          const task = indexingTasks.get(absolutePath);
          if (task) {
            task.abort();
          }

          const syncer = new FileSynchronizer(absolutePath);
          const colName = syncer.getCollectionName();
          await store.dropTable(colName);

          delete snapshot.codebases[absolutePath];
          await saveSnapshot(snapshotPath, snapshot);

          return {
            content: [
              {
                type: "text",
                text: `Cleared index for '${absolutePath}'.`,
              },
            ],
          };
        }

        case "get_indexing_status": {
          const existing = snapshot.codebases[absolutePath];
          if (!existing) {
            return {
              content: [
                {
                  type: "text",
                  text: `Codebase '${absolutePath}' is not indexed.`,
                },
              ],
            };
          }

          if (existing.indexStatus === "in_progress") {
            // Check actual row count
            const syncer = new FileSynchronizer(absolutePath);
            const colName = syncer.getCollectionName();
            let actualRows = 0;
            try {
              actualRows = await store.getRowCount(colName);
            } catch {}
            return {
              content: [
                {
                  type: "text",
                  text: `Codebase '${absolutePath}' is currently being indexed.\n` +
                    `Progress: ${existing.indexedFiles} files processed, ${actualRows} chunks indexed so far.`,
                },
              ],
            };
          }

          if (existing.status === "indexed") {
            return {
              content: [
                {
                  type: "text",
                  text: `Codebase '${absolutePath}' is fully indexed.\n` +
                    `Statistics: ${existing.indexedFiles} files, ${existing.totalChunks} chunks\n` +
                    `Status: ${existing.indexStatus}\n` +
                    `Last updated: ${existing.lastUpdated}`,
                },
              ],
            };
          }

          if (existing.status === "indexfailed") {
            return {
              content: [
                {
                  type: "text",
                  text: `Codebase '${absolutePath}' indexing failed. Please re-index.`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Codebase '${absolutePath}' status: ${existing.status}`,
              },
            ],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start background sync for all indexed codebases
  startBackgroundSync(embedding, store, snapshot, snapshotPath);
}

async function startBackgroundSync(
  embedding: EmbeddingProvider,
  store: LanceDBStore,
  snapshot: Snapshot,
  snapshotPath: string
) {
  const INTERVAL = Math.max(
    60000,
    parseInt(process.env.CODEBASE_SYNC_INTERVAL_MS || "300000", 10)
  );

  const syncOne = async (codebasePath: string) => {
    try {
      const syncer = new FileSynchronizer(codebasePath);
      await syncer.loadIgnoreFiles();

      // Load stored hashes from snapshot
      const cs = snapshot.codebases[codebasePath];
      if (!cs || cs.status !== "indexed") return;

      syncer.setHashes(cs.fileHashes || {});
      const { changed, removed } = await syncer.detectChanges();

      if (changed.length === 0 && removed.length === 0) return;

      const colName = syncer.getCollectionName();
      const BATCH_SIZE = Math.max(1, parseInt(process.env.EMBEDDING_BATCH_SIZE || "25", 10));

      // Process changed files
      let chunkBuffer: Chunk[] = [];
      for (const filePath of changed) {
        try {
          const content = await syncer.readFile(filePath);
          const chunks = splitCode(content, filePath, codebasePath);

          // Remove old chunks for this file
          const relativePath = path.relative(codebasePath, filePath);
          // Old chunks will be overwritten by new insert (same id)

          for (const chunk of chunks) {
            chunkBuffer.push(chunk);
            if (chunkBuffer.length >= BATCH_SIZE) {
              await processBatch(chunkBuffer, codebasePath, colName, embedding, store, syncer);
              chunkBuffer = [];
            }
          }

          const hash = syncer.hashContent(content);
          syncer.updateHash(relativePath, hash);
        } catch (err) {
          chunkBuffer = [];
        }
      }

      // Process remaining
      if (chunkBuffer.length > 0) {
        try {
          await processBatch(chunkBuffer, codebasePath, colName, embedding, store, syncer);
        } catch {}
      }

      // Update snapshot
      const cs2 = snapshot.codebases[codebasePath];
      if (cs2) {
        cs2.fileHashes = syncer.getHashes();
        cs2.lastUpdated = new Date().toISOString();
      }
      await saveSnapshot(snapshotPath, snapshot);

      if (changed.length > 0 || removed.length > 0) {
        console.error(`[sync] ${path.basename(codebasePath)}: ${changed.length} changed, ${removed.length} removed`);
      }
    } catch {
      // Codebase might be deleted; skip silently
    }
  };

  const syncAll = async () => {
    for (const codebasePath of Object.keys(snapshot.codebases)) {
      await syncOne(codebasePath);
    }
  };

  // Initial sync after 10s
  setTimeout(() => syncAll(), 10000);

  // Periodic sync
  setInterval(() => syncAll(), INTERVAL);
}

async function processBatch(
  chunks: Chunk[],
  codebasePath: string,
  colName: string,
  embedding: EmbeddingProvider,
  store: LanceDBStore,
  syncer: FileSynchronizer
): Promise<void> {
  if (chunks.length === 0) return;

  const contents = chunks.map((c) => c.content);
  const embeddings = await embedding.embed(contents);

  const documents: Document[] = chunks.map((chunk, i) => {
    const relativePath = chunk.metadata.filePath.startsWith(codebasePath)
      ? path.relative(codebasePath, chunk.metadata.filePath)
      : chunk.metadata.filePath;
    return {
      id: generateId(relativePath, chunk.startLine, chunk.endLine, chunk.content),
      vector: normalize(embeddings[i].vector),
      text: chunk.content,
      relativePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      fileExtension: path.extname(chunk.metadata.filePath),
      metadata: JSON.stringify(chunk.metadata),
      codebasePath,
    };
  });

  try {
    await store.insert(colName, documents);
  } catch (err) {
    console.error(`[index] insert failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
