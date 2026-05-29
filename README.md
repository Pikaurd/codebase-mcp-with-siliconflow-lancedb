# Codebase MCP Local

A local Model Context Protocol (MCP) server for semantic code search using LanceDB and BGE-M3 embeddings.

## Features

- ✅ **Git submodule support**: Automatically detects nested git repositories (e.g., `modules/*`) and uses `git ls-files --cached --others --exclude-standard` to respect each submodule's own `.gitignore`
- ✅ **Automatic `.gitignore` loading**: Reads `.gitignore`, `.contextignore`, and global `~/.context/.contextignore` for robust file filtering
- ✅ **Smart fallback**: Non-git directories use optimized walk + ignore patterns
- ✅ **Comprehensive ignore list**: Built-in patterns for `build/`, `.dart_tool/`, `ephemeral/`, `.android/`, `.ios/`, `node_modules/`, IDE files, generated code, and assets
- ✅ **Type-safe TypeScript implementation** with full test coverage

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

## Standard Setup Flow (Used in Other Projects)

This is the standard flow used across all projects to ensure consistency and reproducibility:

1. **Project Configuration**
   - Create `.mcp.json` in the project root with stdio server definition
   - Use `${HOME}` for paths and environment variable references for secrets
   - Add `CODEBASE_MCP_DATA_DIR` to `~/.claude/settings.json` env block

2. **Environment Variables**
   - Set `OPENAI_API_KEY` and `OPENAI_BASE_URL` in `~/.claude/settings.json`
   - Avoid hardcoding keys in scripts or config files

3. **Startup Script**
   - Keep `codebase-mcp-local.sh` minimal: only set defaults and cd to source directory
   - Use `exec npx tsx src/index.ts --stdio` to start the server

4. **Indexing & Sync**
   - Indexing happens automatically on first use or via `index_codebase` tool
   - Background sync runs every 5 minutes to keep indexes up-to-date

5. **Verification**
   - Confirm MCP server is connected with `claude mcp list`
   - Verify scope is "Project config" with `claude mcp get <server-name>`
   - Test search functionality with known code patterns

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