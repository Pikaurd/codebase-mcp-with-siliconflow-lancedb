# Codebase MCP Local

Codebase MCP Local is one persistent, local-only MCP service for semantic code
search. Start the service once; MCP clients connect to its Streamable HTTP
endpoint. The service is the sole owner of its SQLite metadata, LanceDB data,
embedding configuration, and indexing scheduler.

## Local setup

Install dependencies from this checkout:

```bash
npm install
```

Configure the service environment before starting it. `LOCAL_AUTH_TOKEN` and
`CODEBASE_MCP_ALLOWED_ROOTS` are required. The allowed roots are a
comma-separated list of existing, readable directories; every tool path must
be inside one of them.

```bash
export LOCAL_AUTH_TOKEN="$(openssl rand -hex 32)"
export CODEBASE_MCP_ALLOWED_ROOTS="$HOME/src,$HOME/work"

# Optional local defaults shown explicitly.
export HOST=127.0.0.1
export PORT=3000
export CODEBASE_MCP_DATA_DIR="$HOME/.codebase-mcp"
export INDEX_MAX_CONCURRENCY=2

# Required only when indexing/search needs the configured embedding provider.
export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://api.siliconflow.cn/v1" # optional provider URL
export EMBEDDING_MODEL="BAAI/bge-m3"                    # optional model
```

Keep `OPENAI_API_KEY` and all embedding-provider configuration in the service
environment only. MCP clients never send, receive, or store an embedding key.
Do not put service secrets in a client MCP configuration file.

## Start the service

Start the service first, in a terminal that has the environment above:

```bash
npm run start
```

It binds only to `http://127.0.0.1:3000` by default and logs lifecycle events
to stderr. Use `Ctrl-C` (SIGINT) or send SIGTERM for a graceful shutdown; the
service stops accepting HTTP work, closes MCP sessions, and drains indexing
jobs for up to five seconds. Do not run a separate stdio server per client.

Check the limited unauthenticated health endpoint:

```bash
curl http://127.0.0.1:3000/healthz
# {"status":"ok"}
```

## Connect an MCP client

Configure each local MCP client for Streamable HTTP:

```text
URL:     http://127.0.0.1:3000/mcp
Header:  Authorization: Bearer <LOCAL_AUTH_TOKEN>
```

For example, an authenticated initialization request is:

```bash
curl -sS http://127.0.0.1:3000/mcp \
  -X POST \
  -H "Authorization: Bearer $LOCAL_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"local-example","version":"1.0"}}}'
```

Save the returned `mcp-session-id` and include it with subsequent MCP requests.
The service accepts only loopback requests whose `Host` (and, when supplied,
`Origin`) matches its local address.

## Index and search

Use the connected client's tools in this order:

1. Call `index_codebase` with an absolute allowed path, for example
   `{"path":"/Users/me/src/project"}`. It queues a job and returns `jobId`.
2. Poll `get_indexing_status` with that `jobId` (or the path) until its state
   is terminal.
3. Call `search_code` with the same path and a query, for example
   `{"path":"/Users/me/src/project","query":"authentication middleware"}`.

Search reads the latest committed index while an update is running. Indexing
the same path and options again reuses the active job; `force` and
`clear_index` serialize behind current work for that path.

## Safe errors and troubleshooting

Public failures are sanitized and include a stable `code`, `suggestedAction`,
and opaque `requestId`. They do not disclose tokens, embedding credentials,
full allowed-root configuration, raw provider responses, or stack traces.

| Code | What to do |
| --- | --- |
| `UNAUTHORIZED` | Check the exact `Authorization: Bearer <LOCAL_AUTH_TOKEN>` header. |
| `PATH_NOT_ALLOWED` | Use an existing absolute path under `CODEBASE_MCP_ALLOWED_ROOTS`. |
| `PATH_NOT_FOUND` | Use an existing directory under the configured roots. |
| `CODEBASE_NOT_INDEXED` | Call `index_codebase` before searching. |
| `JOB_QUEUED` / `JOB_REUSED` | Poll `get_indexing_status` using the returned job id. |
| `INDEX_FAILED` | Retry indexing; correlate service logs with the returned request id. |
| `SERVICE_UNAVAILABLE` / `INTERNAL_ERROR` | Retry later; if it persists, inspect service logs using the request id. |

If startup fails, check that the required variables are present, each allowed
root exists and is readable, `HOST` is exactly `127.0.0.1`, and `PORT` is an
integer from 1 through 65535. If `/healthz` works but `/mcp` returns 401, the
client token does not match the service token. If an index remains interrupted
after a restart, submit `index_codebase` again to retry it.

## Deployment boundary

This release is a single-machine loopback service. Docker, TLS termination,
remote networking, OAuth, and multi-host deployment are future work—not
included here. The configuration is intentionally suitable for a future
container deployment that mounts persistent data and injects secrets, but it
does not ship a Docker image or Compose configuration.

## Development

```bash
npm test
npx tsc --noEmit
```
