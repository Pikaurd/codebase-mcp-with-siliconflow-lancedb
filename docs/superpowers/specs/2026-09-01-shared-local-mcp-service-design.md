# Shared Local MCP Service Design

## Purpose and scope

Convert Codebase MCP from a per-client stdio process into one persistent local
service that safely serves multiple agents on one Mac. The service owns the
LanceDB connection, embedding configuration, indexing scheduler, and durable
metadata.

This release implements a local Streamable HTTP MCP endpoint. Docker and
remote deployment are explicitly out of scope, but configuration and module
boundaries must not preclude them.

## Decisions

- Use Streamable HTTP as the primary MCP transport, bound to `127.0.0.1`.
- Keep a future stdio compatibility shim as a possible adapter. It must proxy
  to the persistent service rather than open the database or execute indexing
  itself.
- Do not implement Redis, multi-process coordination, or horizontal scaling.
- The service is the sole writer for its LanceDB data directory.
- Store durable metadata in SQLite; replace `snapshots.json`.
- The embedding key and provider configuration are service environment
  settings. MCP callers never supply or receive an embedding API key.

## Architecture

`src/app.ts` composes a singleton application core:

- `EmbeddingProvider` for embedding calls.
- `LanceDBStore` for vector storage.
- `MetadataRepository` for SQLite metadata and transactions.
- `IndexJobScheduler` for keyed scheduling and recovery.
- `Indexer` for the extracted indexing workflow.

The presentation adapters contain no indexing state:

- `src/mcp.ts` exposes tools and maps protocol requests to application calls.
- `src/http.ts` hosts Streamable HTTP MCP at `/mcp` and a limited `/healthz`.
- `src/stdio.ts`, if added later, is only a forwarding adapter.

`src/store.ts`, `src/sync.ts`, and `src/embedding.ts` remain lower-level
dependencies. Global state must not live in an MCP request handler.

## Configuration

Local defaults:

```text
HOST=127.0.0.1
PORT=3000
LOCAL_AUTH_TOKEN=<required random secret>
CODEBASE_MCP_ALLOWED_ROOTS=<configured local roots>
OPENAI_API_KEY=<service secret>
OPENAI_BASE_URL=<optional provider setting>
EMBEDDING_MODEL=<optional model setting>
```

The design leaves `HOST`, public base URL, token, and allowed roots configurable
so a future Docker deployment can mount persistent state and inject secrets.
That deployment is not delivered in this release.

## Data model

SQLite owns these durable records:

- `codebases`: canonical path, collection name, index status, file/chunk counts,
  timestamps, and latest completed job id.
- `file_hashes`: canonical codebase path, relative path, and content hash.
- `index_jobs`: UUID, canonical path, operation (`index`, `force`, `clear`),
  state (`queued`, `running`, `completed`, `failed`, `cancelled`,
  `interrupted`), request options, timestamps, statistics, and sanitized error
  details.

Collection naming continues to derive from the canonical codebase path. Schema
migrations are versioned and applied at service startup.

## Scheduling and tool behavior

All paths are canonicalized (`resolve` followed by `realpath`) and checked to
be existing directories inside `CODEBASE_MCP_ALLOWED_ROOTS`.

`index_codebase` creates a background job and returns its job id and state. A
request matching an active job for the same path and semantic options returns
the existing job id (single-flight). A `force` request and `clear_index` are
exclusive operations and queue behind the active job for that path.

Only one job can mutate one codebase collection at a time. Jobs for different
codebases may run concurrently, subject to a configurable global limit of two.
Search is read-only and may run during indexing. It returns the latest committed
data with the current index status. An unindexed codebase returns a structured
not-indexed response. `get_indexing_status` returns durable job and codebase
status; it may be extended to accept a job id.

The indexer retains the existing safe per-file order: read, split, embed,
replace old chunks, then update that file's hash. A failed file must not advance
its hash or destroy the last known searchable chunks. Service startup converts
jobs left as `running` to `interrupted`; a subsequent index request can retry.

## Security and diagnostics

Every `/mcp` request requires `Authorization: Bearer <LOCAL_AUTH_TOKEN>`.
The server validates Origin and Host and binds only to loopback. No health
endpoint response reveals secrets, configured roots, paths, documents, or stack
traces.

Errors are designed for agents to act on. MCP error responses include a stable
machine-readable code, human-readable cause, relevant safe context (for example
requested path, job id, job state, retryability), and an explicit suggested
action. Examples include `UNAUTHORIZED`, `PATH_NOT_ALLOWED`, `PATH_NOT_FOUND`,
`CODEBASE_NOT_INDEXED`, `JOB_REUSED`, `JOB_QUEUED`, `INDEX_FAILED`, and
`SERVICE_UNAVAILABLE`.

Errors never include authorization tokens, embedding credentials, full allowed
root configuration, raw provider response bodies, or unfiltered stack traces.
Full diagnostics remain in service logs, correlated by an opaque request id.

## TDD and acceptance tests

Before production code, create an HTTP integration harness using temporary
LanceDB and SQLite directories plus a fake embedding provider. Every behavior
follows red-green-refactor: add one failing test, run it and verify the expected
failure, implement the smallest change, re-run the focused and full suites, then
refactor only while green.

Required tests:

1. Missing or invalid token returns a detailed, sanitized unauthorized error;
   valid token reaches MCP tools.
2. A disallowed path, nonexistent path, and symlink escape return distinct,
   actionable errors.
3. Two clients indexing the same path receive the same active job id and only
   one job is created.
4. Different codebases obey the global concurrency limit.
5. `force` and `clear` serialize exclusively behind ongoing work for a path.
6. Restart recovery marks unfinished jobs as `interrupted`.
7. Embedding/indexing failure preserves previous searchable chunks and hashes.
8. Multiple clients can search concurrently and observe consistent job status.
9. Every public failure has a stable code, suggested action, correlation id,
   and no secret or stack-trace leakage.

## Non-goals

- Docker image, compose files, TLS termination, remote networking, OAuth, or
  multi-host access.
- Multiple service replicas or distributed locks.
- A new queueing platform such as Redis.
- Changes to search ranking beyond work needed for safe service behavior.
