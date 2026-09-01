#!/usr/bin/env node

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CodebaseService } from "./app.js";
import { loadConfig } from "./config.js";
import { EmbeddingProvider } from "./embedding.js";
import { closeHttpServer, createHttpServer } from "./http.js";
import { MetadataRepository } from "./repository.js";
import { LanceDBStore } from "./store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const dataDirectory = process.env.CODEBASE_MCP_DATA_DIR
    ? path.resolve(process.env.CODEBASE_MCP_DATA_DIR)
    : path.join(os.homedir(), ".codebase-mcp");
  await fs.mkdir(dataDirectory, { recursive: true });

  const repository = MetadataRepository.open(path.join(dataDirectory, "metadata.sqlite"));
  const store = new LanceDBStore(path.join(dataDirectory, "data"));
  await store.connect();
  const app = CodebaseService.create({
    config,
    repository,
    store,
    embedding: new EmbeddingProvider(),
  });
  const server = createHttpServer(app, config);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.error(`[startup] codebase MCP listening on http://${config.host}:${config.port}/mcp`);
  console.error("[startup] metadata recovery complete");

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.error(`[shutdown] ${signal} received; draining HTTP sessions and indexing jobs`);
    try {
      const httpShutdown = closeHttpServer(server);
      const indexing = await app.shutdown();
      await httpShutdown;
      console.error(`[shutdown] complete; indexing jobs drained=${indexing.drained}`);
    } catch (error) {
      console.error("[shutdown] failed", error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    console.error("[startup] failed", error);
    process.exitCode = 1;
  });
}
