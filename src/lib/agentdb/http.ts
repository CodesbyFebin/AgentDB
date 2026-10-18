import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Engine } from "./engine.ts";
import { callTool, TOOLS } from "./mcp.ts";
import { ENGINE_VERSION } from "./types.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const MAX_BODY_BYTES = 1024 * 1024;

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
type ClarificationState = { method: "tools/call"; name: string; argumentHash: string; field: string; allowedValues: string[]; expiresAt: number };

export type AgentDbHttpOptions = { engine: Engine; stateSecret: string; instructions?: string; cacheTtlMs?: number };

/** Create a stateless HTTP JSON-RPC endpoint for AgentDB's MCP-shaped tool registry. */
export function createAgentDbHttpServer(options: AgentDbHttpOptions): Server {
  if (options.stateSecret.length < 32) throw new Error("stateSecret must be at least 32 characters");
  const ttlMs = options.cacheTtlMs ?? 60_000;
  return createServer((req, res) => { void handle(req, res, options, ttlMs); });
}

async function handle(req: IncomingMessage, res: ServerResponse, options: AgentDbHttpOptions, ttlMs: number): Promise<void> {
  if (req.method !== "POST" || req.url !== "/mcp") return send(res, 404, { error: "POST /mcp only" });
  let body: unknown;
  try { body = await readJson(req); }
  catch (error) { return send(res, 400, { error: error instanceof Error ? error.message : "invalid request body" }); }
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string" || !("id" in body)) {
    return send(res, 400, { error: "expected a JSON-RPC 2.0 request with id and method" });
  }
  const rpc = body as RpcRequest;
  const params = isRecord(rpc.params) ? rpc.params : {};
  const headers = validateRoutingHeaders(req, rpc, params);
  if (headers) return send(res, 400, rpcError(rpc.id, -32600, headers));
  const meta = isRecord(params._meta) ? params._meta : {};
  const metaError = validateMeta(meta);
  if (metaError) return send(res, 400, rpcError(rpc.id, -32022, metaError));

  switch (rpc.method) {
    case "server/discover": {
      const result = {
        resultType: "complete",
        supportedVersions: [MCP_PROTOCOL_VERSION],
        capabilities: { tools: {} },
        _meta: { [SERVER_INFO_KEY]: { name: "AgentDB", version: ENGINE_VERSION } },
        instructions: options.instructions ?? "AgentDB provides embedded query, search, memory, and evidence tools.",
        ttlMs,
        cacheScope: "public",
      };
      return send(res, 200, rpcResult(rpc.id, result));
    }
    case "tools/list": {
      const result = {
        resultType: "complete",
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(tool.params.map((param) => [param.name, { type: param.type === "json" ? "object" : param.type, description: param.help }])),
            required: tool.params.filter((param) => param.required).map((param) => param.name),
            additionalProperties: true,
          },
        })),
        ttlMs,
        cacheScope: "private",
      };
      return send(res, 200, rpcResult(rpc.id, result));
    }
    case "tools/call": {
      const name = params.name;
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (typeof name !== "string") return send(res, 200, rpcError(rpc.id, -32602, "tools/call requires params.name"));
      const state = typeof params.requestState === "string" ? decodeState(params.requestState, options.stateSecret) : null;
      if (params.requestState !== undefined && !state) return send(res, 200, rpcError(rpc.id, -32602, "Invalid or expired requestState"));
      if (state) {
        if (state.method !== "tools/call" || state.name !== name || state.argumentHash !== sha256(stableJson(args))) {
          return send(res, 200, rpcError(rpc.id, -32602, "requestState does not match this tool call"));
        }
        const responses = isRecord(params.inputResponses) ? params.inputResponses : {};
        const response = responses[state.field];
        if (!isRecord(response) || response.action !== "accept" || !isRecord(response.content)) {
          return send(res, 200, rpcError(rpc.id, -32602, `inputResponses.${state.field} must contain an accepted form response`));
        }
        const value = response.content[state.field];
        if (typeof value !== "string") return send(res, 200, rpcError(rpc.id, -32602, `inputResponses.${state.field}.content.${state.field} must be a string`));
        if (!state.allowedValues.includes(value)) return send(res, 200, rpcError(rpc.id, -32602, "The selected clarification value was not offered by the server"));
        args[state.field] = value;
      }
      const result = callTool(options.engine, name, args);
      if (result.ok && result.inputRequired) {
        const field = result.inputRequired.field;
        const signed = encodeState({
          method: "tools/call", name, argumentHash: sha256(stableJson(isRecord(params.arguments) ? params.arguments : {})),
          field, allowedValues: result.inputRequired.options.map((item) => item.value), expiresAt: Date.now() + 5 * 60_000,
        }, options.stateSecret);
        const response = {
          resultType: "input_required",
          inputRequests: {
            [field]: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: result.inputRequired.message,
                requestedSchema: {
                  type: "object",
                  properties: { [field]: { type: "string", enum: result.inputRequired.options.map((item) => item.value), description: "Select a matching value." } },
                  required: [field],
                },
              },
            },
          },
          requestState: signed,
        };
        return send(res, 200, rpcResult(rpc.id, response));
      }
      const payload = result.ok ? result.content : { error: result.error };
      return send(res, 200, rpcResult(rpc.id, {
        resultType: "complete",
        content: [{ type: "text", text: JSON.stringify(payload) }],
        isError: !result.ok,
      }));
    }
    default:
      return send(res, 200, rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`));
  }
}

function validateRoutingHeaders(req: IncomingMessage, rpc: RpcRequest, params: Record<string, unknown>): string | null {
  if (req.headers["mcp-protocol-version"] !== MCP_PROTOCOL_VERSION) return `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}`;
  if (req.headers["mcp-method"] !== rpc.method) return "Mcp-Method must match the JSON-RPC method";
  const routedName = rpc.method === "tools/call" && typeof params.name === "string" ? params.name : undefined;
  const headerName = req.headers["mcp-name"];
  if (routedName && headerName !== routedName) return "Mcp-Name must match params.name";
  if (!routedName && headerName !== undefined) return "Mcp-Name is not valid for this method";
  return null;
}

function validateMeta(meta: Record<string, unknown>): string | null {
  if (meta[PROTOCOL_VERSION_KEY] !== MCP_PROTOCOL_VERSION) return `Unsupported protocol version; supported: ${MCP_PROTOCOL_VERSION}`;
  const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
  if (!isRecord(clientInfo) || typeof clientInfo.name !== "string" || typeof clientInfo.version !== "string") return "_meta.io.modelcontextprotocol/clientInfo requires name and version strings";
  if (!isRecord(meta["io.modelcontextprotocol/clientCapabilities"])) return "_meta.io.modelcontextprotocol/clientCapabilities must be an object";
  return null;
}

function rpcResult(id: RpcRequest["id"], result: unknown) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: RpcRequest["id"], code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function encodeState(value: ClarificationState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
function decodeState(token: string, secret: string): ClarificationState | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const state: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isRecord(state) || state.method !== "tools/call" || typeof state.name !== "string" || typeof state.field !== "string" || typeof state.argumentHash !== "string" || !Array.isArray(state.allowedValues) || !state.allowedValues.every((value) => typeof value === "string") || typeof state.expiresAt !== "number" || state.expiresAt < Date.now()) return null;
    return state as ClarificationState;
  } catch { return null; }
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("request body must be valid JSON"); }
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/mcp`;
}
