import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Shell } from "@/components/openbase/shell";
import { Btn, Panel } from "@/components/openbase/ui";
import { getEngine, importFile, resetFile, runSql, useConsole } from "@/lib/openbase/store";
import type { Snapshot } from "@/lib/openbase/types";

export const Route = createFileRoute("/stats")({ component: Page });

function Page() {
  return (
    <Shell>
      <StatsView />
    </Shell>
  );
}

function StatsView() {
  const ready = useConsole((state) => state.ready);
  const rev = useConsole((state) => state.rev);
  const view = useMemo(() => (ready ? getEngine().overview() : null), [ready, rev]);
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState(false);
  const data = (view?.tables ?? []).map((table) => ({ name: table.name, rows: table.rows }));

  function act(sql: string) {
    const result = runSql(sql);
    setNote(result.ok ? result.message || result.rows.map((row) => row.join(" ")).join(" · ") : result.error ?? "failed");
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-medium">File</h1>
        <p className="max-w-2xl text-sm text-pretty text-muted">
          Checkpoint plus WAL is the whole durability story. Replay rebuilds the open file from that pair and checks the counts.
        </p>
      </div>
      {!view ? (
        <p className="text-sm text-muted">Opening agent.db…</p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Rows" value={String(view.tables.reduce((sum, table) => sum + table.rows, 0))} />
            <Stat label="Indexes" value={String(view.indexes.length)} />
            <Stat label="WAL records" value={String(view.wal)} />
            <Stat label="Cache hit" value={`${Math.round(view.hitRate * 100)}%`} />
            <Stat label="Queries" value={String(view.queries)} />
            <Stat label="Memories" value={String(view.memories.length)} />
            <Stat label="Patterns" value={String(view.patterns)} />
            <Stat label="File" value={`${(view.bytes / 1024).toFixed(1)} kb`} />
          </div>
          <Panel title="Rows by table">
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data}>
                  <XAxis dataKey="name" stroke="var(--color-muted)" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="var(--color-muted)" fontSize={12} allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                  <Tooltip
                    cursor={{ fill: "var(--color-surface)" }}
                    contentStyle={{ background: "var(--color-bg-raised)", border: "1px solid var(--color-line)", color: "var(--color-fg)" }}
                  />
                  <Bar dataKey="rows" fill="var(--color-signal)" radius={4} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
          <Panel title="Indexes">
            <ul className="flex flex-col gap-2 font-mono text-xs">
              {view.indexes.map((index) => (
                <li key={index.name} className="flex flex-wrap justify-between gap-2 border-t border-line pt-2 first:border-t-0 first:pt-0">
                  <span>
                    {index.name} · {index.kind} · {index.columns}
                    {index.metric ? ` · ${index.metric}` : ""}
                  </span>
                  <span className="text-muted">{index.detail}</span>
                </li>
              ))}
            </ul>
          </Panel>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={() => act("CHECK")}>Integrity</Btn>
            <Btn disabled={view.role !== "admin"} onClick={() => act("VACUUM")}>
              Vacuum
            </Btn>
            <Btn disabled={view.role === "read"} onClick={() => act("CHECKPOINT")}>
              Checkpoint
            </Btn>
            <Btn
              onClick={() => {
                setNote(getEngine().proveRecovery());
              }}
            >
              Replay WAL
            </Btn>
            <Btn
              onClick={() => {
                const blob = new Blob([JSON.stringify(getEngine().toSnapshot(), null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "agent.db.json";
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export
            </Btn>
            <label className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-line bg-bg-raised px-3 text-sm">
              Import
              <input
                className="sr-only"
                type="file"
                accept="application/json"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  try {
                    importFile(JSON.parse(await file.text()) as Snapshot);
                    setNote(`Imported ${file.name}`);
                  } catch (error) {
                    setNote(error instanceof Error ? error.message : "import failed");
                  }
                }}
              />
            </label>
            <Btn
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  setNote("Press reset again to replace agent.db with the seed file.");
                  return;
                }
                resetFile();
                setArmed(false);
                setNote("Seed file restored.");
              }}
            >
              {armed ? "Confirm reset" : "Reset file"}
            </Btn>
          </div>
          {note ? <p className="text-sm text-pretty">{note}</p> : null}
          <Panel title="What this file actually does">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h2 className="text-sm font-medium">Running here</h2>
                <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">
                  <li>SQL select, insert, update, delete, join, group</li>
                  <li>Exact vector order and an HNSW index with measured recall</li>
                  <li>BM25 and reciprocal rank fusion</li>
                  <li>Memory with importance and decay</li>
                  <li>34 MCP tools, discovery, and input-required follow-ups</li>
                  <li>WAL replay from the last checkpoint</li>
                </ul>
              </div>
              <div>
                <h2 className="text-sm font-medium">Not pretended</h2>
                <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">
                  <li>SQLite page compatibility</li>
                  <li>A million-vector latency claim</li>
                  <li>io_uring, Raft, or encryption at rest</li>
                  <li>OAuth or a hosted model</li>
                </ul>
              </div>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg-raised px-3 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="font-mono text-lg tabular-nums">{value}</div>
    </div>
  );
}
