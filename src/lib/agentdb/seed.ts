import { Engine } from "./engine.ts";
import { sqlQuote } from "./text.ts";

type Doc = { title: string; body: string; category: string; topic: string };

const DOCS: Doc[] = [
  {
    title: "MCP transport roadmap",
    body: "The current browser demo has no MCP transport. It previews tool-shaped calls in TypeScript. A future server implementation must be tested against the selected MCP specification before claiming conformance.",
    category: "protocol",
    topic: "mcp",
  },
  {
    title: "Multi round-trip requests",
    body: "This browser preview can pause a tool-shaped call and ask the user to choose a table. That UI behavior does not implement the MCP MRTR protocol.",
    category: "protocol",
    topic: "mrtr",
  },
  {
    title: "Write-ahead log crash recovery",
    body: "The browser prototype records mutations in a simulated operation log and can replay it from a JSON snapshot. This is not a crash-durable write-ahead log.",
    category: "storage",
    topic: "wal",
  },
  {
    title: "Browser-local snapshot",
    body: "The prototype serializes its demo state to localStorage in the current browser profile. It does not create or open an operating-system database file.",
    category: "storage",
    topic: "file",
  },
  {
    title: "HNSW vector index",
    body: "VECTOR columns hold fixed-width float embeddings. The HNSW graph is the approximate nearest neighbor index. Distance metrics are cosine, L2, dot product, and Hamming. SQL ORDER BY vector_distance stays exact.",
    category: "vector",
    topic: "hnsw",
  },
  {
    title: "Quantization at larger scale",
    body: "Scalar quantization, product quantization, and binary quantization cut memory when a catalog no longer fits in cache. They trade a little recall for a smaller working set.",
    category: "vector",
    topic: "quant",
  },
  {
    title: "BM25 full text ranking",
    body: "BM25 scores a document from term frequency, inverse document frequency, and length normalization. It is a ranker, not a LIKE scan. The inverted index keeps positions for later phrase queries.",
    category: "search",
    topic: "bm25",
  },
  {
    title: "Reciprocal rank fusion",
    body: "Hybrid search fuses a vector ranking and a BM25 ranking with reciprocal rank fusion. A row that is decent on both lists outranks a row that wins only one. Structured filters apply before fusion.",
    category: "search",
    topic: "rrf",
  },
  {
    title: "Agent memory decay",
    body: "The demo memory calls keep a key, value, embedding, metadata, ttl, and importance score. Recall ranks notes by similarity and decay. Data persists through browser reloads in the same profile.",
    category: "agent",
    topic: "decay",
  },
  {
    title: "Episodic sessions",
    body: "Episodic memory is timestamped and session scoped. Cross-session recall searches the persistent set. agent_session switches the scope the next write lands in.",
    category: "agent",
    topic: "session",
  },
  {
    title: "Natural language to SQL",
    body: "NL2SQL maps an intent onto a cached SQL pattern without a hosted model. Ambiguous intents return InputRequiredResult instead of guessing the wrong table.",
    category: "agent",
    topic: "nl2sql",
  },
  {
    title: "Change data capture",
    body: "CREATE STREAM docs_stream ON docs emits insert, update, and delete events into an in-memory queue the agent can read. There is no external broker.",
    category: "stream",
    topic: "cdc",
  },
  {
    title: "Query sandbox",
    body: "The demo engine applies read, write, and admin role checks in client-side state. These checks are useful for trying the UI, but they are not an authorization boundary.",
    category: "security",
    topic: "sandbox",
  },
  {
    title: "Snapshot on one connection",
    body: "BEGIN opens a snapshot for this connection. ROLLBACK restores it. Concurrent multi-writer MVCC is a binary roadmap item and is not simulated here.",
    category: "storage",
    topic: "snapshot",
  },
  {
    title: "JSON columns",
    body: "JSON is a first-class column. Filters read nested keys with json_extract or dotted paths, so a metadata predicate can sit beside vector distance in one statement.",
    category: "sql",
    topic: "json",
  },
  {
    title: "Browser-side execution",
    body: "The query engine runs in the browser and does not send query data to a database service. The UI may load external fonts. This demo is intended to be licensed under Apache-2.0.",
    category: "product",
    topic: "offline",
  },
];

const SOURCES: [number, number, string][] = [
  [1, 1, "MCP transport roadmap"],
  [2, 3, "WAL recovery notes"],
  [3, 5, "HNSW paper"],
  [4, 8, "RRF fusion note"],
  [5, 9, "Memory decay model"],
];

function statements(): string[] {
  const sql: string[] = [
    `CREATE TABLE docs (
      id INTEGER PRIMARY KEY,
      title TEXT,
      body TEXT,
      category TEXT,
      meta JSON,
      embedding VECTOR(48)
    )`,
    `CREATE TABLE sources (
      id INTEGER PRIMARY KEY,
      doc_id INTEGER,
      name TEXT
    )`,
    `CREATE INDEX docs_category ON docs (category)`,
    `CREATE VECTOR INDEX docs_emb ON docs (embedding) METRIC cosine`,
    `CREATE FTS INDEX docs_fts ON docs (title, body)`,
    `CREATE INDEX sources_doc ON sources (doc_id)`,
    `CREATE STREAM docs_stream ON docs`,
  ];
  DOCS.forEach((doc, index) => {
    const text = `${doc.title} ${doc.body}`;
    const meta = JSON.stringify({ topic: doc.topic });
    sql.push(
      `INSERT INTO docs (id, title, body, category, meta, embedding) VALUES (${index + 1}, ${sqlQuote(doc.title)}, ${sqlQuote(doc.body)}, ${sqlQuote(doc.category)}, json(${sqlQuote(meta)}), embed(${sqlQuote(text)}))`,
    );
  });
  for (const [id, docId, name] of SOURCES) {
    sql.push(`INSERT INTO sources (id, doc_id, name) VALUES (${id}, ${docId}, ${sqlQuote(name)})`);
  }
  sql.push(
    `MEMORY STORE 'license' VALUE 'User requires Apache-2.0 and no phone-home telemetry.' IMPORTANCE 0.95`,
    `MEMORY STORE 'storage' VALUE 'The working demo state is a JSON snapshot in this browser profile.' IMPORTANCE 0.7`,
    `MEMORY STORE 'vectors' VALUE 'Prefer exact vector order for SQL. Report HNSW recall separately.' IMPORTANCE 0.8`,
    `MEMORY STORE 'place' VALUE 'Built as an offline agent desk, not a cloud account.' IMPORTANCE 0.6`,
  );
  return sql;
}

export function openSeed(): Engine {
  return Engine.seed(statements());
}

export const SAMPLES: { label: string; sql: string }[] = [
  { label: "Tables", sql: "SHOW TABLES" },
  { label: "Protocol", sql: "SELECT id, title, category FROM docs WHERE category = 'protocol'" },
  {
    label: "Vector",
    sql: "SELECT id, title, vector_distance(embedding, embed('crash recovery after a power loss')) AS dist\nFROM docs\nORDER BY dist\nLIMIT 5",
  },
  {
    label: "BM25",
    sql: "SELECT id, title, bm25(body, 'reciprocal rank fusion hybrid') AS score\nFROM docs\nWHERE bm25(body, 'reciprocal rank fusion hybrid') > 0\nORDER BY score DESC\nLIMIT 5",
  },
  {
    label: "Hybrid",
    sql: "HYBRID 'agent memory decay ttl' FROM docs VECTOR embedding TEXT title, body LIMIT 5",
  },
  {
    label: "Join",
    sql: "SELECT docs.title, sources.name\nFROM docs\nJOIN sources ON docs.id = sources.doc_id",
  },
  {
    label: "JSON",
    sql: "SELECT title, json_extract(meta, '$.topic') AS topic\nFROM docs\nWHERE json_extract(meta, '$.topic') = 'wal'",
  },
  { label: "Groups", sql: "SELECT category, count(*) AS n FROM docs GROUP BY category ORDER BY n DESC" },
  { label: "Memory", sql: "MEMORY RECALL 'license and telemetry' LIMIT 4" },
];
