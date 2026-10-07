# mcp-vector-memory

A self-hosted MCP server that gives AI coding agents a shared, persistent memory: it indexes your code and documentation into a vector database, and lets every agent search it and store what it learns.

Built for teams (or solo developers) running several agents across several projects: Claude Code, Codex or any MCP client connects over Streamable HTTP and works on the same knowledge base.

## Features

- **Code-aware indexing**: AST-based chunking with tree-sitter, so functions and classes stay whole; plain text chunking for docs
- **Hybrid search**: dense embeddings plus a sparse keyword encoder, with per-project relevance thresholds for code, docs and memories
- **Agent memory**: `remember`, `update_memory`, `forget` tools so agents can store decisions and lessons, not just read code
- **Local embeddings**: Ollama (default `qwen3-embedding`), no data sent to a third-party API
- **Multi-project, multi-token**: each bearer token is scoped to a list of projects
- **Auto re-indexing**: optional webhook per repository, triggered on push
- **Hardened**: rate limiting, request size limits, security headers

## MCP tools

| Tool | Purpose |
| --- | --- |
| `search` | Semantic + keyword search across code, docs and memories |
| `index_file` | Index or re-index a file |
| `remember` | Store a memory (decision, convention, lesson learned) |
| `update_memory` | Update an existing memory |
| `forget` | Delete a memory |
| `stats` | Collection statistics per project |

## Stack

TypeScript · Node.js 22 · MCP SDK · Qdrant · Ollama · tree-sitter · Docker Compose

## Quick start

```bash
cp .env.example .env                 # set QDRANT_API_KEY
# edit config/projects.yml: your projects and a random token
docker compose up -d                 # Qdrant + Ollama + the MCP server
```

Then add the server to your MCP client, for example in Claude Code:

```bash
claude mcp add --transport http vector-memory https://your-host/mcp \
  --header "Authorization: Bearer <your-token>"
```

## License

MIT
