import { Engine } from "./engine.ts";
import { sqlQuote } from "./text.ts";

type Doc = { title: string; body: string; category: string; topic: string };

const DOCS: Doc[] = [
  {
    title: "Stateless MCP",
    body: "The 2026-07-28 MCP specification makes the server stateless. Every request carries _meta with the protocol version and client capabilities. server/discover returns supported versions. There is no initialize handshake and no Mcp-Session-Id.",
    category: "protocol",
    topic: "mcp",
  },
  {
    title: "Multi round-trip requests",
    body: "MRTR lets the server return InputRequiredResult when an agent must clarify an ambiguous table name or a missing argument before the tool can run.",
    category: "protocol",
    topic: "mrtr",
  },
  {
    title: "Write-ahead log crash recovery",
    body: "The write-ahead log records every committed mutation before the checkpoint is rewritten. After a crash, OpenBase replays the log from the last checkpoint so committed writes survive.",
    category: "storage",
    topic: "wal",
  },
  {
    title: "Single file storage",
    body: "The primary store is one file. No server, no Docker, and no cloud bucket is required to open it. Optional object storage is a backend trait and stays off unless you ask.",
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
    body: "memory_store keeps a key, a value, an embedding, metadata, a ttl, and an importance score. memory_recall ranks episodic notes by similarity times exponential decay. Memory survives a restart of the file.",
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
    body: "Each MCP tool is gated by role. A read-only session cannot insert. Admin is required to drop a table, vacuum, or rebuild indexes. Result sets are capped.",
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
    title: "Offline and no phone home",
    body: "OpenBase does not embed telemetry, a license server, or a network call. Every query in this console runs on the local file. The intended license is Apache-2.0.",
    category: "product",
    topic: "offline",
  },
];

const SOURCES: [number, number, string][] = [
  [1, 1, "MCP spec 2026-07-28"],
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
    `MEMORY STORE 'file' VALUE 'The working database file is named agent.db and stays on this origin.' IMPORTANCE 0.7`,
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
