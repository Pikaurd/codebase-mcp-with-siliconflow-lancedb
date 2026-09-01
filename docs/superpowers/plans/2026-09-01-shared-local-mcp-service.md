# Shared Local MCP Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Codebase MCP as one authenticated local Streamable HTTP service that safely shares indexes among multiple agents.

**Architecture:** A single application core owns LanceDB, SQLite metadata, embedding configuration, and a keyed job scheduler. The HTTP/MCP adapter is stateless; indexing is scheduled per canonical codebase path and durable metadata replaces `snapshots.json`.

**Tech Stack:** TypeScript, Node.js, MCP TypeScript SDK Streamable HTTP transport, Express, SQLite via `better-sqlite3`, LanceDB, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-shared-local-mcp-service-design.md`

## Global Constraints

- Bind the first release only to `127.0.0.1`; Docker and remote deployment are documentation/configuration seams, not deliverables.
- Require `LOCAL_AUTH_TOKEN` on every `/mcp` request; callers never send embedding credentials.
- Canonicalize a path with `resolve` then `realpath`, and reject paths outside `CODEBASE_MCP_ALLOWED_ROOTS`.
- Use SQLite for codebase, file-hash, and job metadata; no `snapshots.json` writes remain.
- Serialize mutations per canonical codebase, while different codebases may run up to `INDEX_MAX_CONCURRENCY` (default `2`) jobs.
- Error replies need stable code, safe context, suggested action, and request id; never expose secrets, configured roots, provider bodies, or stacks.
- No production code before a focused test has failed for the expected reason. Commit each green task separately.

---

## File structure

- Create `src/config.ts`: validated local-service environment configuration.
- Create `src/errors.ts`: typed safe error contract and MCP error formatter.
- Create `src/path-policy.ts`: canonicalization and allowed-root policy.
- Create `src/repository.ts`: SQLite schema, migrations, and job/codebase/hash persistence.
- Create `src/scheduler.ts`: single-flight, per-path exclusivity, concurrency limit, and restart recovery.
- Create `src/indexer.ts`: extracted full/incremental/clear indexing workflow behind injected dependencies.
- Create `src/app.ts`: application service that composes dependencies and implements tool operations.
- Create `src/mcp.ts`: tool registration and consistent result/error conversion.
- Create `src/http.ts`: Express app, auth/Origin/Host middleware, `/mcp`, and `/healthz`.
- Replace `src/index.ts`: service startup and graceful shutdown only.
- Create `tests/helpers/service.ts`: isolated HTTP/service fixture and fake embedding provider.
- Create `tests/config.test.ts`, `tests/path-policy.test.ts`, `tests/repository.test.ts`, `tests/scheduler.test.ts`, `tests/app.test.ts`, `tests/http.test.ts`.
- Modify `package.json`, `package-lock.json`, `README.md`, `src/types.ts`, and legacy tests as needed.

### Task 1: Establish runtime configuration and safe diagnostic errors

**Files:**
- Create: `src/config.ts`, `src/errors.ts`, `tests/config.test.ts`
- Modify: `src/types.ts`, `package.json`, `package-lock.json`

**Interfaces:**
- Produces `loadConfig(env): ServiceConfig`, `ServiceError`, and `toMcpError(error, requestId)` for all following tasks.

- [ ] **Step 1: Write the failing configuration and error-contract tests.**

```ts
it("rejects a missing local auth token", () => {
  expect(() => loadConfig({ CODEBASE_MCP_ALLOWED_ROOTS: "/tmp" })).toThrow("LOCAL_AUTH_TOKEN");
});

it("formats actionable errors without secret values", () => {
  expect(toMcpError(new ServiceError("UNAUTHORIZED", "Token rejected", "Set LOCAL_AUTH_TOKEN"), "req-1"))
    .toMatchObject({ code: "UNAUTHORIZED", requestId: "req-1", suggestedAction: "Set LOCAL_AUTH_TOKEN" });
});
```

- [ ] **Step 2: Run `npm test -- tests/config.test.ts`; verify it fails because the module does not exist.**
- [ ] **Step 3: Add direct dependencies `express`, `better-sqlite3` and their TypeScript types; then implement `ServiceConfig`, `loadConfig`, `ServiceError`, and the sanitized error formatter.**
- [ ] **Step 4: Re-run `npm test -- tests/config.test.ts`; verify it passes.**
- [ ] **Step 5: Run `npm test` and `npx tsc --noEmit`; fix only regressions introduced by this task.**
- [ ] **Step 6: Commit `git add package.json package-lock.json src/config.ts src/errors.ts src/types.ts tests/config.test.ts && git commit -m "feat: add service configuration and error contract"`.**

### Task 2: Persist shared state in SQLite

**Files:**
- Create: `src/repository.ts`, `tests/repository.test.ts`

**Interfaces:**
- Consumes `ServiceError`.
- Produces `MetadataRepository.open(path)`, `createJob`, `findActiveJob`, `transitionJob`, `getJob`, `upsertCodebase`, `replaceFileHashes`, `getFileHashes`, `markRunningJobsInterrupted`, and `deleteCodebase`.

- [ ] **Step 1: Write failing repository tests for migration, creating/finding an active job by canonical path and semantic options, atomic hash replacement, and restart recovery.**

```ts
it("marks persisted running jobs interrupted when reopened", () => {
  const first = MetadataRepository.open(dbPath);
  first.createJob({ id: "job-1", path: "/repo", kind: "index", options: "{}" });
  first.transitionJob("job-1", "running");
  const reopened = MetadataRepository.open(dbPath);
  reopened.markRunningJobsInterrupted();
  expect(reopened.getJob("job-1")?.state).toBe("interrupted");
});
```

- [ ] **Step 2: Run `npm test -- tests/repository.test.ts`; verify the missing repository causes failure.**
- [ ] **Step 3: Implement versioned schema migrations for `codebases`, `file_hashes`, and `index_jobs`; wrap state transitions and hash replacement in SQLite transactions.**
- [ ] **Step 4: Re-run the focused repository test; verify it passes.**
- [ ] **Step 5: Run the full test suite and TypeScript check.**
- [ ] **Step 6: Commit `git add src/repository.ts tests/repository.test.ts && git commit -m "feat: persist codebase jobs and hashes"`.**

### Task 3: Enforce local path policy and schedule jobs safely

**Files:**
- Create: `src/path-policy.ts`, `src/scheduler.ts`, `tests/path-policy.test.ts`, `tests/scheduler.test.ts`

**Interfaces:**
- Consumes `ServiceConfig`, `ServiceError`, and `MetadataRepository`.
- Produces `canonicalizeAllowedPath(input, allowedRoots): Promise<string>` and `IndexJobScheduler.enqueue(request): EnqueueResult`.

- [ ] **Step 1: Write failing path tests for nonexistent paths, outside roots, and symlink escapes.**
- [ ] **Step 2: Run `npm test -- tests/path-policy.test.ts`; verify it fails because path policy is absent.**
- [ ] **Step 3: Implement realpath-based canonicalization and `PATH_NOT_FOUND`/`PATH_NOT_ALLOWED` errors with suggested actions.**
- [ ] **Step 4: Re-run path tests; verify they pass.**
- [ ] **Step 5: Write failing scheduler tests for same-path job reuse, force/clear serialization, distinct-path concurrency two, and third-path queuing.**

```ts
it("reuses one active index job for two clients targeting the same path", async () => {
  const first = scheduler.enqueue({ path: "/repo", kind: "index", options: {} });
  const second = scheduler.enqueue({ path: "/repo", kind: "index", options: {} });
  expect(second).toEqual({ jobId: first.jobId, reused: true, state: "queued" });
});
```

- [ ] **Step 6: Run `npm test -- tests/scheduler.test.ts`; verify it fails before scheduler implementation.**
- [ ] **Step 7: Implement per-path FIFO queues, same-operation single-flight, exclusive `force`/`clear`, global semaphore, and persisted lifecycle transitions.**
- [ ] **Step 8: Re-run scheduler tests, then the full suite and TypeScript check.**
- [ ] **Step 9: Commit `git add src/path-policy.ts src/scheduler.ts tests/path-policy.test.ts tests/scheduler.test.ts && git commit -m "feat: schedule shared index jobs safely"`.**

### Task 4: Extract the indexer and application service

**Files:**
- Create: `src/indexer.ts`, `src/app.ts`, `tests/helpers/service.ts`, `tests/app.test.ts`
- Modify: `src/store.ts`, `src/types.ts`, `tests/index-incremental.test.ts`

**Interfaces:**
- Consumes repository, scheduler, store, synchronizer, and `EmbeddingLike` fakeable interface.
- Produces `CodebaseService.index`, `search`, `clear`, `getStatus`, and `runIndexJob`.

- [ ] **Step 1: Write failing app tests proving an index request returns a job id, an unindexed search returns `CODEBASE_NOT_INDEXED`, and a failed changed-file embedding leaves its old hash and chunks searchable.**
- [ ] **Step 2: Run `npm test -- tests/app.test.ts`; verify it fails because application services do not exist.**
- [ ] **Step 3: Extract indexing code from `src/index.ts` into `Indexer`; inject dependencies and persist file hashes only after each successful file replacement.**
- [ ] **Step 4: Implement `CodebaseService` to validate paths, enqueue operations, expose persisted status, and make reads coexist with jobs.**
- [ ] **Step 5: Re-run app tests; verify they pass.**
- [ ] **Step 6: Run legacy incremental tests and full suite; preserve all currently covered incremental behavior.**
- [ ] **Step 7: Commit `git add src/indexer.ts src/app.ts src/store.ts src/types.ts tests/helpers/service.ts tests/app.test.ts tests/index-incremental.test.ts && git commit -m "feat: move indexing into shared application service"`.**

### Task 5: Expose authenticated Streamable HTTP MCP

**Files:**
- Create: `src/mcp.ts`, `src/http.ts`, `tests/http.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes `CodebaseService`, `loadConfig`, and `toMcpError`.
- Produces `createHttpServer(app, config)` and registers `index_codebase`, `search_code`, `clear_index`, and `get_indexing_status` through Streamable HTTP at `/mcp`.

- [ ] **Step 1: Write failing HTTP integration tests for missing/invalid bearer tokens, valid token tool discovery, detailed sanitized `PATH_NOT_ALLOWED`, `/healthz`, and two clients observing the same job id.**

```ts
it("returns a safe actionable error to an unauthorized MCP caller", async () => {
  const response = await postMcp(initializeRequest, { authorization: "Bearer bad" });
  expect(response.status).toBe(401);
  expect(response.body).toMatchObject({ code: "UNAUTHORIZED", suggestedAction: expect.any(String), requestId: expect.any(String) });
  expect(JSON.stringify(response.body)).not.toContain(process.env.OPENAI_API_KEY!);
});
```

- [ ] **Step 2: Run `npm test -- tests/http.test.ts`; verify it fails because no HTTP server exists.**
- [ ] **Step 3: Implement Express middleware for request id, bearer authentication, Origin/Host validation, JSON parsing, and a non-sensitive health response.**
- [ ] **Step 4: Create a `StreamableHTTPServerTransport` per MCP session as required by the SDK; delegate tools to `CodebaseService`, including job id/state/suggested action in tool output.**
- [ ] **Step 5: Replace the stdio-only `main` with local HTTP startup, startup recovery, SIGINT/SIGTERM draining, and stderr-only operational logging.**
- [ ] **Step 6: Re-run HTTP tests; then run `npm test` and `npx tsc --noEmit`.**
- [ ] **Step 7: Commit `git add src/mcp.ts src/http.ts src/index.ts tests/http.test.ts && git commit -m "feat: serve shared MCP over authenticated HTTP"`.**

### Task 6: Document local-service operation and verify end-to-end behavior

**Files:**
- Modify: `README.md`
- Test: `tests/http.test.ts`, full Vitest suite

**Interfaces:**
- Documents `npm run start`, required service environment variables, `/mcp` URL, client token header, shutdown, troubleshooting error codes, and future Docker boundary.

- [ ] **Step 1: Write a failing README smoke assertion or manual checklist requiring a clean local startup command and authenticated MCP endpoint example.**
- [ ] **Step 2: Run the new focused documentation/smoke test or execute the checklist; verify the old README fails because it says the client starts stdio automatically.**
- [ ] **Step 3: Replace duplicated stdio instructions with a “start service first” quickstart: configure service secrets, launch `npm run start`, configure clients for `http://127.0.0.1:<port>/mcp` with bearer token, then index/search.**
- [ ] **Step 4: Document stable errors and suggested caller actions; state that the embedding key is server-only and that Docker is a future deployment path.**
- [ ] **Step 5: Run `npm test`, `npx tsc --noEmit`, and manually call `/healthz` plus an authenticated MCP initialization against a temporary local data directory.**
- [ ] **Step 6: Commit `git add README.md tests/http.test.ts && git commit -m "docs: explain shared local MCP service"`.**

## Plan self-review

- Spec coverage: Tasks 1–5 cover configuration, secrets, SQLite, scheduler, path policy, indexing, Streamable HTTP, diagnostics, and recovery. Task 6 covers the required README update and end-to-end verification.
- TDD coverage: every task begins with a focused failing test and explicitly verifies red before minimal implementation.
- Consistency: `CodebaseService`, `MetadataRepository`, `IndexJobScheduler`, `ServiceError`, and canonical path semantics are defined before consumers use them.
