# OpenBase

The agent is the primary user.

This repository is the **browser console** for OpenBase: one local file (`agent.db`) with SQL, exact vectors, HNSW, BM25, hybrid reciprocal rank fusion, memory, change streams, and 34 MCP tools. It runs entirely in the page. State is a checkpoint plus a write-ahead log, stored in `localStorage` on this origin. Nothing phones home.

It is **not** the Rust single-binary server. That target — SQLite page compatibility, io_uring, Raft, encryption at rest, OAuth 2.1, and million-vector latency — is the roadmap in [MASTER_PROMPT.md](./MASTER_PROMPT.md). This console does not pretend those exist.

## What runs here

- SQL select, insert, update, delete, one join, group by, JSON
- Exact vector order, plus an HNSW index that reports recall against exact
- BM25 and hybrid search (vector + BM25, RRF k=60)
- Memory: store, recall, forget, importance, and time decay
- 34 tools, discovery, resources, prompts, and input-required follow-ups
- Role switch: read, write, admin
- Checkpoint, integrity check, vacuum, WAL replay, export, import, reset

Embeddings are a deterministic feature hash, not a neural model. Tool calls run in-process in the browser. There is no stdio or HTTP MCP transport, no OAuth, and no per-action policy beyond the session role.

## Run

Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open the URL Vite prints. No database service is required.

```bash
npm test
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
