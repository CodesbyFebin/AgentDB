import type { Engine } from "./engine.ts";
import { sqlQuote } from "./text.ts";

export type NlHit = { kind: "sql"; sql: string; note: string; confidence: number };
export type NlNeed = { kind: "need"; message: string; options: { label: string; sql: string }[] };
export type NlResult = NlHit | NlNeed;

export function nlToSql(engine: Engine, question: string): NlResult {
  const q = question.trim();
  if (!q) {
    return { kind: "need", message: "Ask about the file.", options: [] };
  }
  const learned = engine.patternFor(q);
  if (learned) return { kind: "sql", sql: learned, note: "Cached pattern for this intent.", confidence: 0.99 };

  if (/^(show|list)\s+(me\s+)?(all\s+)?(the\s+)?tables$/i.test(q)) {
    return { kind: "sql", sql: "SHOW TABLES", note: "Catalog listing.", confidence: 0.95 };
  }
  const schema = q.match(/^(?:show|describe)\s+(?:schema|table)\s+(?:of\s+|for\s+)?([A-Za-z_][\w]*)$/i);
  if (schema) return { kind: "sql", sql: `SHOW SCHEMA ${schema[1]}`, note: "DDL for one table.", confidence: 0.9 };

  const counted = q.match(/how many\s+(?:rows|records|documents|docs)\s+(?:are\s+)?(?:in|on)\s+([A-Za-z_][\w]*)/i);
  if (counted) return { kind: "sql", sql: `SELECT count(*) AS n FROM ${counted[1]}`, note: "Row count.", confidence: 0.9 };
  if (/how many\s+(?:documents|docs|rows)/i.test(q)) {
    return { kind: "sql", sql: "SELECT count(*) AS n FROM docs", note: "Assumed the docs table.", confidence: 0.72 };
  }
  if (/recent\s+(changes|events|writes)|what changed|change data|cdc/i.test(q)) {
    return { kind: "sql", sql: "SHOW EVENTS", note: "Change stream.", confidence: 0.84 };
  }

  const memory = q.match(/memor(?:y|ies)\b(?:\s+(?:about|like|for|related to))?\s+(.+)/i);
  if (memory && !/\b(store|save|forget|drop)\b/i.test(q)) {
    const topic = memory[1].replace(/[?.]+$/g, "").trim();
    return { kind: "sql", sql: `MEMORY RECALL ${sqlQuote(topic)} LIMIT 5`, note: "Semantic recall with decay.", confidence: 0.86 };
  }

  const about = q.match(/(?:find|search|show|list|which|what)\b[\s\S]*\b(?:about|on|for|matching|explain|explains|cover|covers)\s+(.+)/i);
  if (about) {
    const topic = about[1].replace(/[?.]+$/g, "").trim();
    return {
      kind: "sql",
      sql: `HYBRID ${sqlQuote(topic)} FROM docs VECTOR embedding TEXT title, body LIMIT 5`,
      note: "Hybrid fusion over docs.",
      confidence: 0.8,
    };
  }

  if (/^(select|insert|update|delete|show|hybrid|memory|explain|create|drop)\b/i.test(q)) {
    return { kind: "sql", sql: q, note: "Passed through as SQL.", confidence: 1 };
  }

  const names = engine.overview().tables.map((table) => table.name);
  const words = new Set(q.toLowerCase().split(/\W+/));
  const hits = names.filter((name) => words.has(name));
  if (hits.length > 1) {
    return {
      kind: "need",
      message: "Which table should I read?",
      options: hits.map((name) => ({ label: name, sql: `SELECT * FROM ${name} LIMIT 8` })),
    };
  }

  return {
    kind: "need",
    message: "I can search documents, recall memory, or count rows.",
    options: [
      { label: "Search docs", sql: `HYBRID ${sqlQuote(q)} FROM docs VECTOR embedding TEXT title, body LIMIT 5` },
      { label: "Recall memory", sql: `MEMORY RECALL ${sqlQuote(q)} LIMIT 5` },
      {
        label: "BM25 only",
        sql: `SELECT id, title, bm25(body, ${sqlQuote(q)}) AS score FROM docs WHERE bm25(body, ${sqlQuote(q)}) > 0 ORDER BY score DESC LIMIT 5`,
      },
    ],
  };
}
