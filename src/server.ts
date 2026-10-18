import { createAgentDbHttpServer } from "./lib/agentdb/http.ts";
import { openSeed } from "./lib/agentdb/seed.ts";

const port = Number(process.env.PORT ?? 3000);
const stateSecret = process.env.AGENTDB_REQUEST_STATE_SECRET;
if (!stateSecret || stateSecret.length < 32) {
  throw new Error("Set AGENTDB_REQUEST_STATE_SECRET to at least 32 characters before starting the HTTP server.");
}

const server = createAgentDbHttpServer({ engine: openSeed(), stateSecret });
server.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`AgentDB MCP HTTP endpoint listening on http://${process.env.HOST ?? "127.0.0.1"}:${port}/mcp`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
