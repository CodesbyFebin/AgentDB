import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callTool } from "./mcp.ts";
import { openSeed } from "./seed.ts";

describe("agent desk demo sequence", () => {
  it("pauses for table choice, records a read denial, then explains the run", () => {
    const db = openSeed();
    const runId = "agent-desk-test";
    db.setRole("read");
    const context = callTool(db, "agent_context", { run_id: runId, intent: "Prepare context" });
    assert.equal(context.ok, true);

    const pending = callTool(db, "describe_table", { run_id: runId, intent: "Resolve the table" });
    assert.ok(pending.ok && pending.inputRequired);
    assert.equal(db.evidenceRows().length, 2);

    const selected = callTool(db, "describe_table", { run_id: runId, intent: "User selected docs", name: "docs" });
    assert.ok(selected.ok && !selected.inputRequired);
    const search = callTool(db, "hybrid_search", { run_id: runId, intent: "Search recovery guidance", query: "crash recovery", table: "docs", k: 5 });
    assert.ok(search.ok && !search.inputRequired);
    assert.ok(typeof search.content === "object" && search.content !== null && "rows" in search.content && Array.isArray(search.content.rows) && search.content.rows.length > 0);
    const recall = callTool(db, "memory_recall", { run_id: runId, intent: "Recall recovery context", query: "what do we know about recovery", k: 3 });
    assert.ok(recall.ok && !recall.inputRequired);

    const denied = callTool(db, "memory_store", { run_id: runId, intent: "Attempt to remember recovery context", key: "recovery_context", value: "Crash recovery guidance reviewed.", importance: 0.9 });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /role read cannot call memory_store/);
    const receipt = db.evidenceRows().find((item) => item.runId === runId && item.intent === "Attempt to remember recovery context");
    assert.ok(receipt);
    assert.equal(receipt.decision.approved, false);

    const explanation = callTool(db, "evidence_explain", { run_id: runId, intent: "Explain this run" });
    assert.ok(explanation.ok && !explanation.inputRequired);
    assert.ok(Array.isArray(explanation.content));
    assert.equal(explanation.content.length, 6);
    assert.deepEqual(db.verifyEvidence(), { ok: true, count: 7 });
  });
});
