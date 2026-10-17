import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Shell } from "@/components/agentdb/shell";
import { Btn, Field, Panel, fieldClass } from "@/components/agentdb/ui";
import { getEngine, runSql, useConsole } from "@/lib/agentdb/store";

export const Route = createFileRoute("/streams")({ component: Page });

function Page() {
  return (
    <Shell>
      <StreamView />
    </Shell>
  );
}

function StreamView() {
  const ready = useConsole((state) => state.ready);
  const rev = useConsole((state) => state.rev);
  const view = useMemo(() => (ready ? getEngine().overview() : null), [ready, rev]);
  const [name, setName] = useState("notes_stream");
  const [table, setTable] = useState("docs");
  const [error, setError] = useState("");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-medium">Streams</h1>
        <p className="max-w-2xl text-sm text-pretty text-muted">
          CREATE STREAM attaches an in-memory change feed to a table. Inserts, updates, and deletes show up here. There is no broker.
        </p>
      </div>
      <Panel title="Create stream">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Table">
            <select className={fieldClass} value={table} onChange={(event) => setTable(event.target.value)}>
              {(view?.tables ?? []).map((item) => (
                <option key={item.name}>{item.name}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-3">
          <Btn
            tone="signal"
            disabled={!ready}
            onClick={() => {
              if (!/^[A-Za-z_][\w]*$/.test(name)) {
                setError("Use a plain stream name.");
                return;
              }
              const result = runSql(`CREATE STREAM ${name} ON ${table}`);
              setError(result.ok ? "" : result.error ?? "create failed");
            }}
          >
            Create
          </Btn>
        </div>
        {error ? <p className="mt-3 text-sm" role="alert">{error}</p> : null}
      </Panel>
      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Panel title="Streams">
          <ul className="flex flex-col gap-2 font-mono text-sm">
            {(view?.streams ?? []).map((stream) => (
              <li key={stream.name} className="flex items-center justify-between gap-2">
                <span>{stream.name}</span>
                <span className="text-xs text-muted">{stream.table}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Events">
          <ol className="flex flex-col">
            {(view?.events ?? []).length === 0 ? <li className="text-sm text-muted">No events yet.</li> : null}
            {(view?.events ?? []).map((event) => (
              <li key={event.id} className="grid gap-1 border-t border-line py-3 first:border-t-0 sm:grid-cols-[5rem_6rem_minmax(0,1fr)]">
                <span className="font-mono text-xs text-muted tabular-nums">#{event.id}</span>
                <span className="font-mono text-xs">{event.op}</span>
                <span className="text-sm">
                  {event.stream}
                  <span className="text-muted"> · {eventSummary(event.after ?? event.before)}</span>
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}

function eventSummary(row: Record<string, unknown> | null): string {
  if (!row) return "";
  const title = row.title ?? row.name ?? row.key;
  return title != null ? String(title) : "";
}
