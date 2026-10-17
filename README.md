# AgentDB (Browser Demo)

> **This is a browser-based prototype, not the production AgentDB.**
> The planned production AgentDB is a Rust single-binary embedded database.
> This demo runs a TypeScript query engine in the browser and saves its state
> in `localStorage`.

## What Works

- SQL-like queries, exact vector search, HNSW, BM25, and hybrid RRF ranking
- Agent memory with store, recall, forget, importance, and decay
- 44 MCP-shaped tool calls executed as in-browser TypeScript functions, including
  an append-only SHA-256 evidence ledger
- Read/write/admin role switching for trying the demo; this is a UI control,
  not an authorization boundary
- Simulated operation log, JSON snapshot, checkpoint, and replay
- Snapshot export and import

## What Does Not Work Yet

- No real MCP server transport: no stdio, HTTP, or 2026-07-28 conformance
- The evidence ledger and deterministic receipt explanations are an early browser
  prototype; replay returns a read-only ledger reconstruction, and policy
  evaluation and the full audit explanation system are not done
- No operating-system database file; state is stored in browser `localStorage`
- No server-side authorization or security boundary in the demo
- Embeddings use a deterministic feature hash, not a neural model
- No production-grade crash durability, concurrent writers, or scale claims

## Run Locally

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open the local development URL printed by Vite. The application works in the
browser and does not require a database service.

## Tests

```bash
npm test
```

The engine suite uses Node's built-in test runner and currently contains eight
tests. `npm test` runs `src/lib/agentdb/engine.test.ts`.

The source also passes `npx tsc --noEmit`.

## Roadmap

See [MASTER_PROMPT.md](./MASTER_PROMPT.md) for the target architecture and
phased roadmap. The browser prototype is Phase 0 plus an initial Phase 1 ledger
slice. Phase 1 still targets a real MCP transport, policy evaluation, and the
complete plain-English explanation system.
