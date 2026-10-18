import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { createAgentDbHttpServer, listen, MCP_PROTOCOL_VERSION } from "./http.ts";
import { openSeed } from "./seed.ts";

const secret = "phase-one-test-secret-with-at-least-32-characters";
const clientMeta = {
  "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "AgentDB conformance test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function request(method: string, params: Record<string, unknown> = {}, name?: string, id = "test-1") {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "Mcp-Method": method,
  };
  if (name) headers["Mcp-Name"] = name;
  return fetch(testUrl, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: clientMeta } }) });
}

let serverA: Server;
let serverB: Server;
let testUrl: string;
let urlB: string;
before(async () => {
  serverA = createAgentDbHttpServer({ engine: openSeed(), stateSecret: secret });
  serverB = createAgentDbHttpServer({ engine: openSeed(), stateSecret: secret });
  testUrl = await listen(serverA);
  urlB = await listen(serverB);
});
after(() => { serverA.close(); serverB.close(); });

describe("AgentDB 2026-07-28 HTTP gates", () => {
  it("matches the server/discover result shape, including cache and identity metadata", async () => {
    const response = await request("server/discover", { _meta: clientMeta }, undefined, "discover-1");
    assert.equal(response.status, 200);
    const wire = await response.json();
    assert.deepEqual(wire, {
      jsonrpc: "2.0",
      id: "discover-1",
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "AgentDB", version: "0.4.0" } },
        instructions: "AgentDB provides embedded query, search, memory, and evidence tools.",
        ttlMs: 60_000,
        cacheScope: "public",
      },
    });
  });

  it("routes by headers and rejects header/body disagreement", async () => {
    const bad = await fetch(testUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, "Mcp-Method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: clientMeta } }),
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /Mcp-Method/);
    const list = await request("tools/list");
    const body = await list.json();
    assert.equal(body.result.tools.length, 44);
  });

  it("resumes clarification on another server instance without session memory", async () => {
    const start = await request("tools/call", { name: "describe_table", arguments: {} }, "describe_table", "mrtr-start");
    const pending = await start.json();
    assert.equal(pending.result.resultType, "input_required");
    assert.deepEqual(Object.keys(pending.result.inputRequests), ["name"]);
    assert.equal(serverA.listening, true);
    const retry = await fetch(urlB, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "describe_table",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "mrtr-resume", method: "tools/call",
        params: {
          name: "describe_table", arguments: {}, requestState: pending.result.requestState,
          inputResponses: { name: { action: "accept", content: { name: "docs" } } }, _meta: clientMeta,
        },
      }),
    });
    const resumed = await retry.json();
    assert.equal(resumed.result.resultType, "complete");
    assert.equal(resumed.result.isError, false);
    assert.match(resumed.result.content[0].text, /"name":"docs"/);
  });

  it("rejects a modified requestState token", async () => {
    const start = await request("tools/call", { name: "describe_table", arguments: {} }, "describe_table");
    const pending = await start.json();
    const retry = await fetch(urlB, {
      method: "POST",
      headers: { "content-type": "application/json", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "describe_table" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "describe_table", arguments: {}, requestState: `${pending.result.requestState}x`, inputResponses: { name: { action: "accept", content: { name: "docs" } } }, _meta: clientMeta } }),
    });
    const body = await retry.json();
    assert.equal(body.error.code, -32602);
    assert.match(body.error.message, /requestState/);
  });

  it("accepts only values offered by the signed clarification", async () => {
    const start = await request("tools/call", { name: "describe_table", arguments: {} }, "describe_table");
    const pending = await start.json();
    const retry = await fetch(urlB, {
      method: "POST",
      headers: { "content-type": "application/json", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, "Mcp-Method": "tools/call", "Mcp-Name": "describe_table" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "describe_table", arguments: {}, requestState: pending.result.requestState, inputResponses: { name: { action: "accept", content: { name: "users" } } }, _meta: clientMeta } }),
    });
    const body = await retry.json();
    assert.equal(body.error.code, -32602);
    assert.match(body.error.message, /not offered/);
  });
});
