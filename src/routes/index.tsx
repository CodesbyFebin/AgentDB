import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Shell } from "@/components/agentdb/shell";
import { Btn, Panel } from "@/components/agentdb/ui";
import { callTool, type ToolResponse } from "@/lib/agentdb/mcp";
import { getEngine, setRole, useConsole } from "@/lib/agentdb/store";

export const Route = createFileRoute("/")({ component: AgentDesk });

type TraceEntry = { tool: string; intent: string; response: ToolResponse };

function AgentDesk() {
  const ready = useConsole((state) => state.ready);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [runId, setRunId] = useState("");
  const [clarification, setClarification] = useState<ToolResponse | null>(null);
  const [summary, setSummary] = useState("");
  const [running, setRunning] = useState(false);
  const db = getEngine();

  function invoke(tool: string, args: Record<string, unknown>, intent: string): ToolResponse {
    const response = callTool(db, tool, {
      ...args,
      run_id: runId,
      intent,
      actor_chain: ["agentdb-demo-agent", `role:${db.role}`],
    });
    setTrace((previous) => [...previous, { tool, intent, response }]);
    useConsole.setState((state) => ({ rev: state.rev + 1 }));
    return response;
  }

  function start() {
    if (!ready || running) return;
    setRunning(true);
    setRole("read");
    setTrace([]);
    setSummary("");
    setClarification(null);
    const nextRunId = `agent-desk-${Date.now()}`;
    setRunId(nextRunId);
    const context = callTool(db, "agent_context", { run_id: nextRunId, intent: "Prepare context for the user's request", actor_chain: ["agentdb-demo-agent", "role:read"] });
    setTrace([{ tool: "agent_context", intent: "Prepare context for the user's request", response: context }]);
    const pending = callTool(db, "describe_table", {
      run_id: nextRunId,
      intent: "Resolve which table the user means before querying",
      actor_chain: ["agentdb-demo-agent", "role:read"],
    });
    setTrace((previous) => [...previous, { tool: "describe_table", intent: "Resolve which table the user means before querying", response: pending }]);
    setClarification(pending);
    setRunning(false);
  }

  function continueAfterClarification(table: string) {
    if (!table || !runId) return;
    invoke("describe_table", { name: table }, `User clarified the table as ${table}`);
    const search = invoke("hybrid_search", { query: "crash recovery", table, k: 5 }, "Search the selected table for crash recovery guidance");
    const recalled = invoke("memory_recall", { query: "what do we know about recovery", k: 3 }, "Recall relevant agent memory");
    const denied = invoke("memory_store", { key: "recovery_context", value: "Crash recovery guidance reviewed.", importance: 0.9 }, "Remember the recovery context from this turn");
    const explain = invoke("evidence_explain", { run_id: runId }, "Explain the recorded actions in this run");
    const receipt = db.evidenceRows().find((item) => item.runId === runId && item.intent === "Remember the recovery context from this turn");
    const searchCount = search.ok && !search.inputRequired && isRecord(search.content) && Array.isArray(search.content.rows) ? search.content.rows.length : 0;
    const memoryCount = recalled.ok && !recalled.inputRequired && Array.isArray(recalled.content) ? recalled.content.length : 0;
    const deniedText = denied.ok ? "completed" : denied.error;
    const receiptReason = receipt
      ? `Because the active read role denied memory_store (${receipt.decision.policy}); receipt #${receipt.receiptId} records the result: ${receipt.resultSummary}.`
      : `Because the active read role denied memory_store: ${deniedText}.`;
    const explanationCount = explain.ok && Array.isArray(explain.content) ? explain.content.length : 0;
    setSummary(`The ${table} table was searched for crash recovery (${searchCount} result${searchCount === 1 ? "" : "s"}); ${memoryCount} relevant memory item${memoryCount === 1 ? "" : "s"} were recalled. ${receiptReason} The evidence explanation returned ${explanationCount} receipt${explanationCount === 1 ? "" : "s"} for this run.`);
    setClarification(null);
    setRunning(false);
  }

  function resetDemo() {
    setRole("admin");
    setTrace([]);
    setRunId("");
    setClarification(null);
    setSummary("");
    setRunning(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">Agent Desk</h1>
          <p className="max-w-2xl text-sm text-pretty text-muted">
            Watch a deterministic tool sequence pause for clarification, search the selected table, and record a read-only refusal with evidence.
          </p>
        </div>
        <div className="flex gap-2">
          <Btn tone="signal" disabled={!ready || running} onClick={start}>Run 30-second demo</Btn>
          <Btn onClick={resetDemo}>Reset</Btn>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
        <Panel title="Agent tool trace" aside={<span className="font-mono text-xs text-muted">{db.role} role · {trace.length} calls</span>}>
          {trace.length === 0 ? (
            <p className="text-sm text-muted">Run the demo to see each browser tool call and its recorded result.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {trace.map((entry, index) => (
                <li key={`${index}-${entry.tool}`} className="rounded-md border border-line bg-bg-inset p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs"><span className="text-signal">{String(index + 1).padStart(2, "0")}</span> {entry.tool}</span>
                    <span className={`rounded border px-2 py-1 font-mono text-[10px] ${entry.response.ok ? entry.response.inputRequired ? "border-signal text-signal" : "border-line text-muted" : "border-red-500/50 text-red-300"}`}>
                      {entry.response.ok ? entry.response.inputRequired ? "INPUT REQUIRED" : "COMPLETE" : "DENIED / ERROR"}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted">{entry.intent}</p>
                  <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded bg-bg px-3 py-2 font-mono text-[11px] text-muted">
                    {entry.response.ok ? JSON.stringify(entry.response.inputRequired ?? entry.response.content, null, 2) : entry.response.error}
                  </pre>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          {clarification?.ok && clarification.inputRequired ? (
            <Panel title="Clarification required">
              <p className="text-sm">{clarification.inputRequired.message}</p>
              <p className="mt-2 text-xs text-muted">The agent pauses here. Choose a table so it can continue without guessing.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {clarification.inputRequired.options.map((option) => (
                  <Btn key={option.value} tone="signal" onClick={() => continueAfterClarification(option.value)}>{option.label}</Btn>
                ))}
              </div>
            </Panel>
          ) : null}
          {summary ? (
            <Panel title="Because line · evidence-backed explanation">
              <p className="text-sm leading-relaxed">{summary}</p>
              <p className="mt-3 break-all font-mono text-[11px] text-muted">Run {runId}</p>
            </Panel>
          ) : (
            <Panel title="What this demo shows">
              <ul className="list-disc space-y-2 pl-5 text-sm text-muted">
                <li>Ambiguity triggers a question and pauses the run.</li>
                <li>The selected table is searched with the existing tool registry.</li>
                <li>A read-only role refuses a memory write.</li>
                <li>The explanation links its because-clause to a ledger receipt.</li>
              </ul>
            </Panel>
          )}
          <p className="text-xs leading-relaxed text-muted">
            This walkthrough runs browser-local tool functions in sequence. It is not an autonomous model agent; the separate HTTP transport is documented in the README.
          </p>
        </div>
      </div>
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
