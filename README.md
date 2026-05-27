# Codebase MCP Local

A local Model Context Protocol (MCP) server for semantic code search using LanceDB and BGE-M3 embeddings.

## Installation

```bash
# Install dependencies
cd ~/.local/share/codebase-mcp
npm install

# Ensure the executable script exists
chmod +x ~/.local/bin/codebase-mcp-local.sh
```

## Usage

The MCP server is automatically started by Claude Code when needed. You should **not** run it manually as a daemon.

### Correct Usage (Automatic)
- Claude Code will automatically start the server when you use MCP tools
- The server runs as a child process and terminates when Claude Code exits
- No manual management required

### Manual Testing (For Development Only)
```bash
# Start in stdio mode (required for Claude Code)
~/.local/bin/codebase-mcp-local.sh

# Or run directly with tsx
cd ~/.local/share/codebase-mcp
npx tsx src/index.ts --stdio
```

## Configuration

Environment variables can be set in `~/.local/bin/codebase-mcp-local.sh`:

- `EMBEDDING_MODEL`: Embedding model (default: `BAAI/bge-m3`)
- `EMBEDDING_BATCH_SIZE`: Batch size for embedding (default: `10`)
- `OPENAI_BASE_URL`: API endpoint (default: `https://api.siliconflow.cn/v1`)
- `OPENAI_API_KEY`: API key
- `CODEBASE_MCP_DATA_DIR`: Data storage directory (default: `~/.codebase-mcp`)

## Troubleshooting

### Search not working?
- Check if FTS is working: Chinese search falls back to vector search, English search uses hybrid scoring
- Clear and re-index if results seem stale:
  ```bash
  # In Claude Code
  mcp__codebase-mcp-local__clear_index --path /path/to/codebase
  mcp__codebase-mcp-local__index_codebase --path /path/to/codebase
  ```

### Server not starting?
- Verify the `--stdio` flag is present in the startup script
- Check that `tsx` is installed globally: `npm install -g tsx`
- Ensure Node.js version is compatible (v20+)

## Development

To make changes:
1. Edit files in `~/.local/share/codebase-mcp/src/`
2. The server automatically reloads on file changes (via tsx)
3. Test with Claude Code MCP tools