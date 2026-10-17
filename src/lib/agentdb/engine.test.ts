import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Engine } from "./engine.ts";
import { HnswIndex } from "./hnsw.ts";
import { callTool, discover, TOOLS } from "./mcp.ts";
import { sha256 } from "./evidence.ts";
import { nlToSql } from "./nl2sql.ts";
import { openSeed } from "./seed.ts";
import { distance } from "./text.ts";

describe("agentdb browser prototype", () => {
  it("seeds, filters, groups, joins, and reads JSON", () => {
    const db = openSeed();
    const tables = db.exec("SHOW TABLES");
    assert.equal(tables.ok, true);
    assert.equal(tables.rows.length, 3);

    const protocol = db.exec("SELECT id, title FROM docs WHERE category = 'protocol'");
    assert.equal(protocol.ok, true);
    assert.equal(protocol.rows.length, 2);
    assert.ok(protocol.plan.some((step) => step.op === "btree seek"));

    const topic = db.exec("SELECT title FROM docs WHERE json_extract(meta, '$.topic') = 'wal'");
    assert.equal(topic.rows.length, 1);
    assert.match(String(topic.rows[0][0]), /Write-ahead/);

    const groups = db.exec("SELECT category, count(*) AS n FROM docs GROUP BY category ORDER BY n DESC");
    assert.equal(groups.ok, true, groups.error);
    const top = new Map(groups.rows.map((row) => [String(row[0]), row[1]]));
    assert.equal(top.get("agent"), 3);
    assert.equal(top.get("storage"), 3);
    assert.ok(Number(groups.rows[0][1]) >= Number(groups.rows[groups.rows.length - 1][1]));

    const joined = db.exec("SELECT docs.title, sources.name FROM docs JOIN sources ON docs.id = sources.doc_id");
    assert.equal(joined.ok, true, joined.error);
    assert.equal(joined.rows.length, 5);
    assert.ok(joined.plan.some((step) => step.op === "hash join"));
  });

  it("ranks the write-ahead log by vector distance and BM25", () => {
    const db = openSeed();
    const nearest = db.exec(
      "SELECT id, title FROM docs ORDER BY vector_distance(embedding, embed('The write-ahead log records every committed mutation before the checkpoint is rewritten. After a crash, AgentDB replays the log from the last checkpoint so committed writes survive.')) LIMIT 1",
    );
    assert.equal(nearest.ok, true, nearest.error);
    assert.equal(nearest.rows[0][0], 3);

    const text = db.exec(
      "SELECT id FROM docs WHERE bm25(body, 'reciprocal rank fusion hybrid') > 0 ORDER BY bm25(body, 'reciprocal rank fusion hybrid') DESC LIMIT 1",
    );
    assert.equal(text.ok, true, text.error);
    assert.equal(text.rows[0][0], 8);

    const hybrid = db.exec("HYBRID 'agent memory decay ttl' FROM docs VECTOR embedding TEXT title, body LIMIT 3");
    assert.equal(hybrid.ok, true, hybrid.error);
    const titles = hybrid.rows.map((row) => String(row[1]));
    assert.ok(titles.some((title) => /memory/i.test(title)), titles.join(" | "));
  });

  it("recalls memory and replays the WAL", () => {
    const db = openSeed();
    const memory = db.exec("MEMORY RECALL 'license and telemetry' LIMIT 2");
    assert.equal(memory.rows[0][0], "license");

    db.exec("INSERT INTO sources (id, doc_id, name) VALUES (99, 1, 'replay-me')");
    const again = Engine.load(db.toSnapshot());
    const found = again.exec("SELECT name FROM sources WHERE id = 99");
    assert.equal(found.rows[0][0], "replay-me");
    assert.match(db.proveRecovery(), /match/);
  });

  it("enforces roles and rolls back a transaction", () => {
    const db = openSeed();
    db.setRole("read");
    const denied = db.exec("DELETE FROM sources WHERE id = 1");
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? "", /role read/);

    db.setRole("write");
    const drop = db.exec("DROP TABLE sources");
    assert.equal(drop.ok, false);

    db.setRole("admin");
    db.exec("BEGIN");
    db.exec("DELETE FROM sources WHERE id = 1");
    assert.equal(db.exec("SELECT count(*) AS n FROM sources").rows[0][0], 4);
    db.exec("ROLLBACK");
    assert.equal(db.exec("SELECT count(*) AS n FROM sources").rows[0][0], 5);
  });

  it("exposes the in-browser tool registry and clarification flow", () => {
    const db = openSeed();
    const info = discover(db);
    assert.equal(info.protocol, null);
    assert.equal(info.transport, "in-browser-demo");
    assert.equal(info.stateless, false);
    assert.equal(TOOLS.length, 44);

    const listed = callTool(db, "list_tables", {});
    assert.equal(listed.ok, true);
    const vague = callTool(db, "describe_table", {});
    assert.equal(vague.ok, true);
    assert.ok(vague.ok && vague.inputRequired);

    const mapped = nlToSql(db, "which documents explain crash recovery");
    assert.equal(mapped.kind, "sql");
    if (mapped.kind === "sql") {
      const ran = db.exec(mapped.sql);
      assert.equal(ran.ok, true, ran.error);
      assert.ok(ran.rows.length > 0);
    }
  });
});

describe("evidence ledger", () => {
  it("appends tool receipts and verifies a ten-entry SHA-256 chain", () => {
    const db = openSeed();
    assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (let i = 0; i < 10; i++) {
      const result = callTool(db, "list_tables", { run_id: "ledger-test" });
      assert.equal(result.ok, true);
    }
    assert.equal(db.evidenceRows().length, 10);
    assert.deepEqual(db.verifyEvidence(), { ok: true, count: 10 });
    const query = db.exec("SELECT receipt_id, run_id FROM evidence_ledger WHERE run_id = 'ledger-test'");
    assert.equal(query.ok, true, query.error);
    assert.equal(query.rows.length, 10);
    const reloaded = Engine.load(db.toSnapshot());
    assert.deepEqual(reloaded.verifyEvidence(), { ok: true, count: 10 });
    assert.equal(reloaded.exec("DELETE FROM evidence_ledger").ok, false);
  });

  it("detects a modified receipt after snapshot reload", () => {
    const db = openSeed();
    for (let i = 0; i < 10; i++) callTool(db, "list_tables", { run_id: "tamper-test" });
    const snap = db.toSnapshot();
    assert.ok(snap.evidence);
    snap.evidence[4].resultSummary = "tampered receipt";
    const tampered = Engine.load(snap);
    const verified = tampered.verifyEvidence();
    assert.equal(verified.ok, false);
    assert.match(verified.error ?? "", /hash mismatch/);
  });
});

describe("hnsw", () => {
  it("keeps recall against an exact scan", () => {
    const index = new HnswIndex("cosine", 8, 64);
    const vectors: number[][] = [];
    for (let i = 0; i < 80; i++) {
      const vec = Array.from({ length: 16 }, (_, d) => {
        const x = Math.sin(i * 1.3 + d * 0.7) * 0.8 + ((i * 17 + d * 3) % 10) / 50;
        return x;
      });
      const norm = Math.hypot(...vec) || 1;
      vectors.push(vec.map((n) => n / norm));
      index.add(i, vectors[i]);
    }
    let hit = 0;
    let total = 0;
    for (let q = 0; q < 12; q++) {
      const query = vectors[q];
      const exact = vectors
        .map((vec, id) => ({ id, dist: distance(query, vec, "cosine") }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 5)
        .map((row) => row.id);
      const approx = new Set(index.search(query, 5).map((row) => row.id));
      total += exact.length;
      hit += exact.filter((id) => approx.has(id)).length;
    }
    assert.ok(hit / total >= 0.8, `recall ${hit / total}`);
  });
});
