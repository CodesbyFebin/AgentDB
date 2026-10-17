import type { Engine } from "./engine.ts";
import { canonicalJson, sha256, summarizeResult } from "./evidence.ts";
import { nlToSql } from "./nl2sql.ts";
import { sqlQuote } from "./text.ts";
import { ENGINE_VERSION, type Role, type Val } from "./types.ts";

export type ToolSpec = {
  name: string;
  category: string;
  description: string;
  role: Role;
  params: { name: string; type: "string" | "number" | "json"; required?: boolean; help: string }[];
};

export type ToolOk = { ok: true; content: Val; ms: number; inputRequired?: undefined };
export type ToolNeed = {
  ok: true;
  ms: number;
  inputRequired: { message: string; field: string; options: { label: string; value: string }[] };
  content?: undefined;
};
export type ToolErr = { ok: false; error: string; ms: number };
export type ToolResponse = ToolOk | ToolNeed | ToolErr;

const RANK: Record<Role, number> = { read: 0, write: 1, admin: 2 };

export const TOOLS: ToolSpec[] = [
  { name: "list_tables", category: "Schema", role: "read", description: "List tables in the browser snapshot.", params: [] },
  { name: "describe_table", category: "Schema", role: "read", description: "Columns, indexes, and a few sample rows.", params: [{ name: "name", type: "string", help: "Table name" }] },
  { name: "list_indexes", category: "Schema", role: "read", description: "Every B+Tree, HNSW, and BM25 index.", params: [] },
  { name: "get_schema_ddl", category: "Schema", role: "read", description: "DDL for one table or the whole file.", params: [{ name: "name", type: "string", help: "Optional table" }] },
  { name: "execute_query", category: "Query", role: "read", description: "Run a structured table query with filters, ordering, and a limit.", params: [{ name: "table", type: "string", required: true, help: "Table" }, { name: "columns", type: "string", help: "Comma-separated columns, default *" }, { name: "filter", type: "json", help: "Column equality filters" }, { name: "order_by", type: "string", help: "Column name, optionally DESC" }, { name: "limit", type: "number", help: "Maximum rows" }] },
  { name: "execute_sql", category: "Query", role: "admin", description: "Run raw SQL for advanced use. Writes still obey the session role.", params: [{ name: "sql", type: "string", required: true, help: "Statement" }] },
  { name: "explain_query", category: "Query", role: "read", description: "Plan for a read statement.", params: [{ name: "sql", type: "string", required: true, help: "SELECT, HYBRID, or SHOW" }] },
  { name: "nl_to_sql", category: "Query", role: "read", description: "Map an intent to SQL. Ambiguous intents ask back.", params: [{ name: "question", type: "string", required: true, help: "Intent" }, { name: "choice", type: "string", help: "Follow-up SQL from InputRequired" }] },
  { name: "vector_search", category: "Vector", role: "read", description: "Nearest rows. Exact, or HNSW with recall vs exact.", params: [{ name: "query", type: "string", required: true, help: "Text to embed" }, { name: "table", type: "string", help: "Default docs" }, { name: "column", type: "string", help: "Default embedding" }, { name: "k", type: "number", help: "Default 5" }, { name: "mode", type: "string", help: "exact or hnsw" }] },
  { name: "hybrid_search", category: "Vector", role: "read", description: "Vector plus BM25, fused with RRF.", params: [{ name: "query", type: "string", required: true, help: "Query" }, { name: "table", type: "string", help: "Default docs" }, { name: "k", type: "number", help: "Default 5" }] },
  { name: "upsert_vectors", category: "Vector", role: "write", description: "Embed text into a VECTOR column for one row.", params: [{ name: "table", type: "string", required: true, help: "Table" }, { name: "id", type: "number", required: true, help: "Primary key" }, { name: "column", type: "string", required: true, help: "VECTOR column" }, { name: "text", type: "string", required: true, help: "Source text" }] },
  { name: "delete_vectors", category: "Vector", role: "write", description: "Null a VECTOR column. Does not delete the row.", params: [{ name: "table", type: "string", required: true, help: "Table" }, { name: "column", type: "string", required: true, help: "VECTOR column" }, { name: "id", type: "number", help: "Optional row id" }] },
  { name: "full_text_search", category: "FTS", role: "read", description: "BM25 over a text column.", params: [{ name: "query", type: "string", required: true, help: "Query" }, { name: "table", type: "string", help: "Default docs" }, { name: "column", type: "string", help: "Default body" }, { name: "k", type: "number", help: "Default 5" }] },
  { name: "suggest", category: "FTS", role: "read", description: "Prefix terms from the inverted index.", params: [{ name: "prefix", type: "string", required: true, help: "Prefix" }] },
  { name: "highlight", category: "FTS", role: "read", description: "Window of text around the first matching term.", params: [{ name: "text", type: "string", required: true, help: "Document" }, { name: "query", type: "string", required: true, help: "Query" }] },
  { name: "memory_store", category: "Memory", role: "write", description: "Store an episodic note with importance and ttl.", params: [{ name: "key", type: "string", required: true, help: "Key" }, { name: "value", type: "string", required: true, help: "Value" }, { name: "importance", type: "number", help: "0 to 1" }, { name: "ttl", type: "number", help: "Seconds, 0 keeps it" }] },
  { name: "memory_recall", category: "Memory", role: "read", description: "Semantic recall with decay.", params: [{ name: "query", type: "string", required: true, help: "Query" }, { name: "k", type: "number", help: "Default 5" }] },
  { name: "memory_forget", category: "Memory", role: "write", description: "Drop a memory key.", params: [{ name: "key", type: "string", required: true, help: "Key" }] },
  { name: "memory_list", category: "Memory", role: "read", description: "List memories by current weight.", params: [{ name: "k", type: "number", help: "Default 20" }] },
  { name: "create_table", category: "Admin", role: "write", description: "Create a table from a column list.", params: [{ name: "sql", type: "string", required: true, help: "CREATE TABLE ..." }] },
  { name: "drop_table", category: "Admin", role: "admin", description: "Drop a table and its indexes.", params: [{ name: "name", type: "string", required: true, help: "Table" }] },
  { name: "create_index", category: "Admin", role: "write", description: "Create a btree, vector, or fts index.", params: [{ name: "sql", type: "string", required: true, help: "CREATE INDEX ..." }] },
  { name: "drop_index", category: "Admin", role: "write", description: "Drop an index.", params: [{ name: "name", type: "string", required: true, help: "Index" }] },
  { name: "insert", category: "Data", role: "write", description: "Insert one row from a JSON object of column values. Strings only; use execute_sql for embed().", params: [{ name: "table", type: "string", required: true, help: "Table" }, { name: "row", type: "json", required: true, help: "{\"col\":\"value\"}" }] },
  { name: "update", category: "Data", role: "write", description: "Update rows matching a SQL predicate.", params: [{ name: "sql", type: "string", required: true, help: "UPDATE ..." }] },
  { name: "delete", category: "Data", role: "write", description: "Delete rows matching a SQL statement.", params: [{ name: "sql", type: "string", required: true, help: "DELETE ..." }] },
  { name: "batch_insert", category: "Data", role: "write", description: "Run several INSERT statements.", params: [{ name: "sql", type: "string", required: true, help: "INSERT ...; INSERT ..." }] },
  { name: "export_csv", category: "Data", role: "read", description: "CSV for one table.", params: [{ name: "table", type: "string", required: true, help: "Table" }] },
  { name: "import_csv", category: "Data", role: "write", description: "Import CSV rows using the first row as column names.", params: [{ name: "table", type: "string", required: true, help: "Destination table" }, { name: "csv", type: "string", required: true, help: "CSV text with a header row" }] },
  { name: "create_stream", category: "Streams", role: "write", description: "Create a CDC stream on a table.", params: [{ name: "name", type: "string", required: true, help: "Stream name" }, { name: "table", type: "string", required: true, help: "Source table" }] },
  { name: "stream_read", category: "Streams", role: "read", description: "Read recent CDC events from a stream.", params: [{ name: "name", type: "string", required: true, help: "Stream name" }] },
  { name: "drop_stream", category: "Streams", role: "admin", description: "Drop a CDC stream.", params: [{ name: "name", type: "string", required: true, help: "Stream name" }] },
  { name: "evidence_append", category: "Evidence", role: "write", description: "Append a hash-chained receipt to the evidence ledger.", params: [{ name: "intent", type: "string", required: true, help: "Action intent" }, { name: "run_id", type: "string", help: "Optional run identifier" }, { name: "result_summary", type: "string", help: "Optional summary" }] },
  { name: "evidence_query", category: "Evidence", role: "read", description: "Query receipts by run, session, or actor.", params: [{ name: "run_id", type: "string", help: "Run identifier" }, { name: "session_id", type: "string", help: "Session identifier" }, { name: "actor", type: "string", help: "Actor-chain member" }] },
  { name: "evidence_verify", category: "Evidence", role: "read", description: "Verify the SHA-256 receipt chain.", params: [] },
  { name: "evidence_explain", category: "Evidence", role: "read", description: "Explain a receipt or run from its recorded action and outcome.", params: [{ name: "receipt_id", type: "number", help: "Receipt number" }, { name: "run_id", type: "string", help: "Run identifier" }] },
  { name: "evidence_replay", category: "Evidence", role: "read", description: "Return ordered recorded actions for a run; does not re-execute them.", params: [{ name: "run_id", type: "string", required: true, help: "Run identifier" }] },
  { name: "vacuum", category: "Analytics", role: "admin", description: "Rebuild indexes, drop expired memory, checkpoint.", params: [] },
  { name: "integrity_check", category: "Analytics", role: "admin", description: "Keys, dims, dangling index ids, and evidence chain.", params: [] },
  { name: "checkpoint", category: "Admin", role: "admin", description: "Force a WAL checkpoint.", params: [] },
  { name: "stats", category: "Analytics", role: "read", description: "Table counts, index detail, and query cache hit rate.", params: [] },
  { name: "agent_context", category: "Agent", role: "read", description: "Schema, memories, and recent changes for a new turn.", params: [] },
  { name: "agent_session", category: "Agent", role: "write", description: "Read or set the memory session name.", params: [{ name: "session", type: "string", help: "Omit to read" }] },
  { name: "agent_tools_list", category: "Agent", role: "read", description: "The tool registry this server exposes.", params: [] },
];

export function discover(engine: Engine) {
  const view = engine.overview();
  return {
    protocol: null,
    transport: "in-browser-demo",
    stateless: false,
    identity: { name: "agentdb", version: ENGINE_VERSION, storage: "localStorage" },
    capabilities: {
      toolRegistryPreview: true,
      protocolCompliance: false,
    },
    toolCount: TOOLS.length,
    role: view.role,
  };
}

export function resources(engine: Engine) {
  const view = engine.overview();
  return [
    { uri: "agentdb-demo://schema", description: "Full DDL preview" },
    ...view.tables.map((table) => ({ uri: `agentdb-demo://tables/${table.name}`, description: `${table.rows} rows` })),
    ...view.indexes.map((index) => ({ uri: `agentdb-demo://indexes/${index.name}`, description: index.kind })),
    { uri: "agentdb-demo://docs", description: "How to use this browser demo" },
  ];
}

export function readResource(engine: Engine, uri: string): Val {
  const view = engine.overview();
  if (uri === "agentdb-demo://schema") return view.tables.map((table) => table.ddl).join("\n\n");
  if (uri === "agentdb-demo://docs") {
    return "This is an in-browser preview. Tool calls are local TypeScript function calls, not an MCP server transport.";
  }
  const table = uri.match(/^agentdb-demo:\/\/tables\/([\w]+)$/);
  if (table) {
    const found = view.tables.find((item) => item.name === table[1]);
    if (!found) return { error: "unknown table" };
    return { ddl: found.ddl, sample: found.sample as unknown as Val };
  }
  const index = uri.match(/^agentdb-demo:\/\/indexes\/([\w]+)$/);
  if (index) return (view.indexes.find((item) => item.name === index[1]) as unknown as Val) ?? { error: "unknown index" };
  return { error: `unknown resource ${uri}` };
}

export function prompts() {
  return [
    { name: "agentdb-demo:query", description: "Help me write a query for..." },
    { name: "agentdb-demo:explain", description: "Explain this query plan..." },
    { name: "agentdb-demo:optimize", description: "How can I optimize this schema for..." },
  ];
}

export function callTool(engine: Engine, name: string, args: Record<string, unknown>): ToolResponse {
  const response = callToolInner(engine, name, args);
  const result: Val = response.ok
    ? response.inputRequired
      ? { inputRequired: response.inputRequired }
      : response.content ?? null
    : { error: response.error };
  const actorChain = Array.isArray(args.actor_chain)
    ? args.actor_chain.filter((item): item is string => typeof item === "string")
    : ["browser-user", `role:${engine.role}`];
  engine.appendEvidence({
    runId: str(args.run_id) || engine.session,
    sessionId: engine.session,
    actorChain,
    intent: str(args.intent) || `Tool call ${name}`,
    decision: { approved: response.ok, policy: response.ok ? "role-check:allowed" : "role-check:denied-or-error", latencyMs: response.ms },
    action: canonicalJson({ tool: name, paramsSha256: sha256(canonicalJson(args)) }),
    resultHash: sha256(canonicalJson(result)),
    resultSummary: summarizeResult(result),
    timestamp: new Date().toISOString(),
    audienceExplanation: `${name} ${response.ok ? "completed" : "failed"}${response.ok && response.inputRequired ? " and requested clarification" : ""}.`,
  });
  return response;
}

function callToolInner(engine: Engine, name: string, args: Record<string, unknown>): ToolResponse {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const finish = (content: Val): ToolOk => ({ ok: true, content, ms: elapsed(started) });
  const fail = (error: string): ToolErr => ({ ok: false, error, ms: elapsed(started) });
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) return fail(`unknown tool ${name}`);
  if (RANK[engine.role] < RANK[tool.role]) return fail(`role ${engine.role} cannot call ${name} (needs ${tool.role})`);

  try {
    switch (name) {
      case "list_tables":
        return finish(engine.exec("SHOW TABLES").rows as unknown as Val);
      case "stats": {
        const view = engine.overview();
        return finish({ tables: view.tables.map((table) => ({ name: table.name, rows: table.rows, columns: table.columns })) as unknown as Val, indexes: view.indexes as unknown as Val, queries: view.queries, cacheHits: view.hits, cacheMisses: view.misses, cacheHitRate: view.hitRate });
      }
      case "list_indexes":
        return finish(engine.exec("SHOW INDEXES").rows as unknown as Val);
      case "describe_table": {
        const table = str(args.name);
        const names = engine.overview().tables.map((item) => item.name);
        if (!table) return need(started, "Which table?", "name", names.map((item) => ({ label: item, value: item })));
        const matches = names.filter((item) => item.toLowerCase().startsWith(table.toLowerCase()));
        if (!names.includes(table) && matches.length > 1) {
          return need(started, `“${table}” matches more than one table.`, "name", matches.map((item) => ({ label: item, value: item })));
        }
        const chosen = names.includes(table) ? table : matches[0];
        if (!chosen) return fail(`no table ${table}`);
        const view = engine.overview().tables.find((item) => item.name === chosen);
        return finish({ name: chosen, ddl: view?.ddl ?? "", columns: view?.cols as unknown as Val, sample: view?.sample as unknown as Val });
      }
      case "get_schema_ddl": {
        const table = str(args.name);
        if (!table) return finish(engine.overview().tables.map((item) => item.ddl).join("\n\n"));
        const result = engine.exec(`SHOW SCHEMA ${table}`);
        if (!result.ok) return fail(result.error ?? "schema failed");
        return finish(result.rows[0]?.[0] ?? "");
      }
      case "execute_sql":
      case "update":
      case "delete":
      case "batch_insert":
      case "create_table":
      case "create_index": {
        const sql = str(args.sql);
        if (!sql) return fail("sql is required");
        const result = engine.exec(sql);
        if (!result.ok) return fail(result.error ?? "sql failed");
        return finish({ columns: result.columns.map((col) => col.name), rows: result.rows as unknown as Val, affected: result.affected, message: result.message ?? "", plan: result.plan as unknown as Val });
      }
      case "execute_query": {
        const table = identifier(str(args.table));
        if (!table) return fail("table is required and must be a simple identifier");
        const columns = str(args.columns) || "*";
        if (columns !== "*" && !columns.split(",").every((item) => identifier(item.trim()))) return fail("columns must be simple identifiers");
        const filter = asRecord(args.filter);
        const predicates = Object.entries(filter).map(([key, value]) => {
          const col = identifier(key);
          if (!col) throw new Error(`invalid filter column ${key}`);
          if (value === null) return `${col} IS NULL`;
          return `${col} = ${typeof value === "number" || typeof value === "boolean" ? String(value) : sqlQuote(String(value))}`;
        });
        const order = str(args.order_by);
        if (order && !/^[A-Za-z_][\w]*(?:\s+(?:ASC|DESC))?$/i.test(order)) return fail("order_by must be a column name with optional ASC or DESC");
        const limit = num(args.limit);
        if (limit != null && (!Number.isInteger(limit) || limit < 0 || limit > 500)) return fail("limit must be an integer from 0 to 500");
        const sql = `SELECT ${columns} FROM ${table}${predicates.length ? ` WHERE ${predicates.join(" AND ")}` : ""}${order ? ` ORDER BY ${order}` : ""}${limit == null ? "" : ` LIMIT ${limit}`}`;
        const result = engine.exec(sql);
        if (!result.ok) return fail(result.error ?? "query failed");
        return finish({ columns: result.columns.map((col) => col.name), rows: result.rows as unknown as Val, plan: result.plan as unknown as Val });
      }
      case "explain_query": {
        const sql = str(args.sql);
        if (!sql) return fail("sql is required");
        const result = engine.exec(`EXPLAIN ${sql}`);
        if (!result.ok) return fail(result.error ?? "explain failed");
        return finish(result.rows as unknown as Val);
      }
      case "nl_to_sql": {
        const choice = str(args.choice);
        const question = str(args.question);
        if (choice) {
          engine.learn(question || choice, choice);
          const result = engine.exec(choice);
          if (!result.ok) return fail(result.error ?? "sql failed");
          return finish({ sql: choice, columns: result.columns.map((col) => col.name), rows: result.rows as unknown as Val, message: result.message ?? "" });
        }
        if (!question) return fail("question is required");
        const mapped = nlToSql(engine, question);
        if (mapped.kind === "need") {
          return need(started, mapped.message, "choice", mapped.options.map((option) => ({ label: option.label, value: option.sql })));
        }
        return finish({ sql: mapped.sql, note: mapped.note, confidence: mapped.confidence });
      }
      case "vector_search": {
        const query = str(args.query);
        if (!query) return fail("query is required");
        const mode = str(args.mode) === "hnsw" ? "hnsw" : "exact";
        const found = engine.vectorSearch(str(args.table) || "docs", str(args.column) || "embedding", query, num(args.k) || 5, mode);
        return finish(found as unknown as Val);
      }
      case "hybrid_search": {
        const query = str(args.query);
        if (!query) return fail("query is required");
        const table = str(args.table) || "docs";
        const k = num(args.k) || 5;
        const result = engine.exec(`HYBRID ${sqlQuote(query)} FROM ${table} VECTOR embedding TEXT title, body LIMIT ${k}`);
        if (!result.ok) return fail(result.error ?? "hybrid failed");
        return finish({ columns: result.columns.map((col) => col.name), rows: result.rows as unknown as Val, plan: result.plan as unknown as Val });
      }
      case "upsert_vectors": {
        const table = str(args.table);
        const column = str(args.column);
        const text = str(args.text);
        const id = num(args.id);
        if (!table || !column || !text || id == null) return fail("table, id, column, and text are required");
        const result = engine.exec(`UPDATE ${table} SET ${column} = embed(${sqlQuote(text)}) WHERE id = ${id}`);
        if (!result.ok) return fail(result.error ?? "update failed");
        if (result.affected === 0) return fail(`no row ${id}`);
        return finish({ updated: result.affected });
      }
      case "delete_vectors": {
        const table = str(args.table);
        const column = str(args.column);
        if (!table || !column) return fail("table and column are required");
        const id = num(args.id);
        const where = id == null ? "" : ` WHERE id = ${id}`;
        const result = engine.exec(`UPDATE ${table} SET ${column} = NULL${where}`);
        if (!result.ok) return fail(result.error ?? "update failed");
        return finish({ updated: result.affected });
      }
      case "full_text_search": {
        const query = str(args.query);
        if (!query) return fail("query is required");
        const table = str(args.table) || "docs";
        const column = str(args.column) || "body";
        const k = num(args.k) || 5;
        const result = engine.exec(
          `SELECT id, title, ${column} AS text, bm25(${column}, ${sqlQuote(query)}) AS score FROM ${table} WHERE bm25(${column}, ${sqlQuote(query)}) > 0 ORDER BY score DESC LIMIT ${k}`,
        );
        if (!result.ok) return fail(result.error ?? "search failed");
        return finish(result.rows as unknown as Val);
      }
      case "suggest":
        return finish(engine.suggest(str(args.prefix), 8) as unknown as Val);
      case "highlight": {
        const text = str(args.text);
        const query = str(args.query);
        if (!text || !query) return fail("text and query are required");
        const { snippetAround } = awaitSnippet();
        return finish(snippetAround(text, query));
      }
      case "memory_store": {
        const key = str(args.key);
        const value = str(args.value);
        if (!key || !value) return fail("key and value are required");
        const importance = num(args.importance);
        const ttl = num(args.ttl);
        const result = engine.exec(
          `MEMORY STORE ${sqlQuote(key)} VALUE ${sqlQuote(value)}${importance == null ? "" : ` IMPORTANCE ${importance}`}${ttl == null ? "" : ` TTL ${ttl}`}`,
        );
        if (!result.ok) return fail(result.error ?? "store failed");
        return finish(result.message ?? "stored");
      }
      case "memory_recall": {
        const query = str(args.query);
        if (!query) return fail("query is required");
        const result = engine.exec(`MEMORY RECALL ${sqlQuote(query)} LIMIT ${num(args.k) || 5}`);
        if (!result.ok) return fail(result.error ?? "recall failed");
        return finish(result.rows as unknown as Val);
      }
      case "memory_forget": {
        const key = str(args.key);
        if (!key) return fail("key is required");
        const result = engine.exec(`MEMORY FORGET ${sqlQuote(key)}`);
        if (!result.ok) return fail(result.error ?? "forget failed");
        return finish(result.message ?? "forgot");
      }
      case "memory_list": {
        const result = engine.exec(`MEMORY LIST LIMIT ${num(args.k) || 20}`);
        if (!result.ok) return fail(result.error ?? "list failed");
        return finish(result.rows as unknown as Val);
      }
      case "drop_table":
      case "drop_index": {
        const item = str(args.name);
        if (!item) return fail("name is required");
        const kind = name === "drop_table" ? "TABLE" : "INDEX";
        const result = engine.exec(`DROP ${kind} ${item}`);
        if (!result.ok) return fail(result.error ?? "drop failed");
        return finish(result.message ?? "dropped");
      }
      case "export_csv": {
        const table = str(args.table);
        if (!table) return fail("table is required");
        const result = engine.exec(`SELECT * FROM ${table}`);
        if (!result.ok) return fail(result.error ?? "export failed");
        return finish(toCsv(result.columns.map((col) => col.name), result.rows));
      }
      case "import_csv": {
        const table = identifier(str(args.table));
        const csv = str(args.csv);
        if (!table || !csv) return fail("table and csv are required");
        const records = parseCsv(csv);
        const headers = records.shift()?.map((item) => identifier(item.trim()));
        if (!headers?.length || headers.some((item) => !item)) return fail("CSV must start with simple column names");
        if (records.length > 10_000) return fail("CSV import is limited to 10,000 rows");
        const begin = engine.exec("BEGIN");
        if (!begin.ok) return fail(begin.error ?? "could not begin CSV import");
        let inserted = 0;
        for (const row of records) {
          if (row.length !== headers.length) {
            engine.exec("ROLLBACK");
            return fail("CSV row has a different number of fields than the header");
          }
          const values = row.map((value) => sqlQuote(value));
          const result = engine.exec(`INSERT INTO ${table} (${headers.join(", ")}) VALUES (${values.join(", ")})`);
          if (!result.ok) {
            engine.exec("ROLLBACK");
            return fail(result.error ?? "CSV import failed");
          }
          inserted += result.affected;
        }
        const commit = engine.exec("COMMIT");
        if (!commit.ok) return fail(commit.error ?? "CSV import could not commit");
        return finish({ inserted });
      }
      case "create_stream": {
        const name = identifier(str(args.name));
        const table = identifier(str(args.table));
        if (!name || !table) return fail("name and table must be simple identifiers");
        const result = engine.exec(`CREATE STREAM ${name} ON ${table}`);
        if (!result.ok) return fail(result.error ?? "stream creation failed");
        return finish(result.message ?? "stream created");
      }
      case "stream_read": {
        const name = identifier(str(args.name));
        if (!name) return fail("name must be a simple identifier");
        const result = engine.exec("SHOW EVENTS");
        if (!result.ok) return fail(result.error ?? "stream read failed");
        const rows = result.rows.filter((row) => row[1] === name);
        return finish(rows as unknown as Val);
      }
      case "drop_stream": {
        const name = identifier(str(args.name));
        if (!name) return fail("name must be a simple identifier");
        const result = engine.exec(`DROP STREAM ${name}`);
        if (!result.ok) return fail(result.error ?? "stream drop failed");
        return finish(result.message ?? "stream dropped");
      }
      case "evidence_append": {
        const intent = str(args.intent);
        if (!intent) return fail("intent is required");
        const receipt = engine.appendEvidence({
          runId: str(args.run_id) || engine.session,
          sessionId: engine.session,
          actorChain: ["browser-user", `role:${engine.role}`],
          intent,
          decision: { approved: true, policy: "explicit-evidence-append", latencyMs: 0 },
          action: canonicalJson({ tool: "evidence_append", paramsSha256: sha256(canonicalJson(args)) }),
          resultHash: sha256(canonicalJson(args.result_summary ?? "receipt appended")),
          resultSummary: str(args.result_summary) || "Explicit evidence receipt appended.",
          timestamp: new Date().toISOString(),
          audienceExplanation: `Recorded the requested intent: ${intent}.`,
        });
        return finish(receipt as unknown as Val);
      }
      case "evidence_query": {
        const runId = str(args.run_id);
        const sessionId = str(args.session_id);
        const actor = str(args.actor);
        const receipts = engine.evidenceRows().filter((receipt) =>
          (!runId || receipt.runId === runId) &&
          (!sessionId || receipt.sessionId === sessionId) &&
          (!actor || receipt.actorChain.includes(actor)),
        );
        return finish(receipts as unknown as Val);
      }
      case "evidence_verify":
        return finish(engine.verifyEvidence() as unknown as Val);
      case "evidence_explain": {
        const receiptId = num(args.receipt_id);
        const runId = str(args.run_id);
        const receipts = engine.evidenceRows().filter((receipt) =>
          (receiptId == null || receipt.receiptId === receiptId) && (!runId || receipt.runId === runId),
        );
        return finish(receipts.map((receipt) => ({ receipt_id: receipt.receiptId, run_id: receipt.runId, explanation: receipt.audienceExplanation, action: receipt.action, result: receipt.resultSummary })) as unknown as Val);
      }
      case "evidence_replay": {
        const runId = str(args.run_id);
        if (!runId) return fail("run_id is required");
        const receipts = engine.evidenceRows().filter((receipt) => receipt.runId === runId);
        return finish({ run_id: runId, mode: "read-only ledger reconstruction", executed: false, actions: receipts.map((receipt) => ({ receipt_id: receipt.receiptId, timestamp: receipt.timestamp, action: receipt.action, result_hash: receipt.resultHash, result_summary: receipt.resultSummary })) } as unknown as Val);
      }
      case "vacuum": {
        const result = engine.exec("VACUUM");
        if (!result.ok) return fail(result.error ?? "vacuum failed");
        return finish(result.message ?? "vacuum");
      }
      case "integrity_check": {
        const result = engine.exec("CHECK");
        if (!result.ok) return fail(result.error ?? "check failed");
        return finish({ database: result.rows as unknown as Val, evidence: engine.verifyEvidence() } as unknown as Val);
      }
      case "checkpoint": {
        const result = engine.exec("CHECKPOINT");
        if (!result.ok) return fail(result.error ?? "checkpoint failed");
        return finish(result.message ?? "checkpoint");
      }
      case "agent_context": {
        const view = engine.overview();
        return finish({
          file: view.file,
          role: view.role,
          session: view.session,
          lsn: view.lsn,
          wal: view.wal,
          tables: view.tables.map((table) => ({ name: table.name, rows: table.rows, columns: table.cols.map((col) => col.name) })) as unknown as Val,
          memories: view.memories.slice(0, 5).map((memory) => ({ key: memory.key, value: memory.value, weight: memory.weight })) as unknown as Val,
          recent: view.events.slice(0, 5).map((event) => ({ op: event.op, stream: event.stream, id: event.id })) as unknown as Val,
        });
      }
      case "agent_session": {
        const session = str(args.session);
        if (!session) return finish({ session: engine.session });
        engine.setSession(session);
        return finish({ session: engine.session });
      }
      case "agent_tools_list":
        return finish(TOOLS.map((item) => ({ name: item.name, category: item.category, role: item.role })) as unknown as Val);
      default:
        return fail(`unhandled tool ${name}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function need(started: number, message: string, field: string, options: { label: string; value: string }[]): ToolNeed {
  return { ok: true, ms: elapsed(started), inputRequired: { message, field, options } };
}

function elapsed(started: number): number {
  const end = typeof performance !== "undefined" ? performance.now() : Date.now();
  return Math.round((end - started) * 100) / 100;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function identifier(value: string): string | null {
  return /^[A-Za-z_][\w]*$/.test(value) ? value : null;
}

function asRecord(value: unknown): Record<string, Val> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, Val>;
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field");
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

function toCsv(columns: string[], rows: Val[][]): string {
  const esc = (value: Val) => {
    const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(","), ...rows.map((row) => row.map(esc).join(","))].join("\n");
}

function awaitSnippet(): { snippetAround: (text: string, query: string) => string } {
  return { snippetAround: snippetSync };
}

function snippetSync(text: string, query: string): string {
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (at < 0 || idx < at)) at = idx;
  }
  if (at < 0) return text.slice(0, 180);
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + 80);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
