# AgentDB (Browser Demo)

> **This is a browser-based prototype, not the production AgentDB.**
> The planned production AgentDB is a Rust single-binary embedded database.
> This demo runs a TypeScript query engine in the browser and saves its state
> in `localStorage`.

## What Works

- SQL-like queries, exact vector search, HNSW, BM25, and hybrid RRF ranking
- Agent memory with store, recall, forget, importance, and decay
- 44 browser tool calls, including an append-only SHA-256 evidence ledger
- Agent Desk walkthrough: clarification pause, table search, read-role write
  refusal, and a receipt-backed because-line; SQL remains in the developer nav
- A Node HTTP prototype at `POST /mcp` with `server/discover`, `tools/list`, and
  `tools/call`, version/routing headers, and signed stateless clarification
- Read/write/admin role switching for trying the demo; this is a UI control,
  not an authorization boundary
- Simulated operation log, JSON snapshot, checkpoint, and replay
- Snapshot export and import

## What Does Not Work Yet

- The HTTP implementation covers discovery, tool listing/calls, routing headers,
  and cross-instance clarification; other MCP methods, stdio, authorization, and
  full protocol conformance remain unfinished
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

To run the separate HTTP transport prototype, set a secret of at least 32
characters and start the seeded in-memory server:

```bash
AGENTDB_REQUEST_STATE_SECRET='replace-with-a-long-random-secret' npm run start:http
```

It listens on `http://127.0.0.1:3000/mcp` by default. The server currently seeds
an in-memory demo engine at startup; it is not persistent storage or an
authorization boundary.

## Tests

```bash
npm test
```

The Node test runner executes 14 engine, evidence, agent-desk-flow,
discovery-shape, header-routing, and cross-instance clarification tests across
`src/lib/agentdb/*.test.ts`.

The source also passes `npx tsc --noEmit`.

## Roadmap

See [MASTER_PROMPT.md](./MASTER_PROMPT.md) for the target architecture and
phased roadmap. Phase 1 still targets full MCP transport coverage, policy
evaluation, and the complete plain-English explanation system.
