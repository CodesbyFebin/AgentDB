import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Shell } from "@/components/openbase/shell";
import { Btn, Field, Panel, fieldClass } from "@/components/openbase/ui";
import { getEngine, runSql, setSession, useConsole } from "@/lib/openbase/store";
import { sqlQuote } from "@/lib/openbase/text";

export const Route = createFileRoute("/memory")({ component: Page });

function Page() {
  return (
    <Shell>
      <MemoryView />
    </Shell>
  );
}

function MemoryView() {
  const ready = useConsole((state) => state.ready);
  const rev = useConsole((state) => state.rev);
  const view = useMemo(() => (ready ? getEngine().overview() : null), [ready, rev]);
  const [keyName, setKeyName] = useState("note");
  const [value, setValue] = useState("");
  const [importance, setImportance] = useState(0.7);
  const [ttl, setTtl] = useState(0);
  const [query, setQuery] = useState("license telemetry");
  const [hits, setHits] = useState<string[][]>([]);
  const [error, setError] = useState("");

  function recall() {
    const result = runSql(`MEMORY RECALL ${sqlQuote(query)} LIMIT 5`);
    if (!result.ok) setError(result.error ?? "recall failed");
    else {
      setError("");
      setHits(result.rows.map((row) => row.map((cell) => String(cell ?? ""))));
    }
  }

  function store() {
    if (!keyName.trim() || !value.trim()) {
      setError("Key and value are required.");
      return;
    }
    const result = runSql(
      `MEMORY STORE ${sqlQuote(keyName.trim())} VALUE ${sqlQuote(value.trim())} IMPORTANCE ${importance} TTL ${ttl}`,
    );
    if (!result.ok) setError(result.error ?? "store failed");
    else {
      setError("");
      setValue("");
      recall();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-medium">Memory</h1>
        <p className="max-w-2xl text-sm text-pretty text-muted">
          Episodic notes live in the file. Recall score is cosine similarity times importance times a 14-day half-life. Expired notes drop out.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Store">
          <div className="flex flex-col gap-3">
            <Field label="Session">
              <input
                className={fieldClass}
                value={view?.session ?? "default"}
                onChange={(event) => setSession(event.target.value)}
                disabled={!ready}
              />
            </Field>
            <Field label="Key">
              <input className={fieldClass} value={keyName} onChange={(event) => setKeyName(event.target.value)} />
            </Field>
            <Field label="Value">
              <textarea className={`${fieldClass} min-h-24`} value={value} onChange={(event) => setValue(event.target.value)} />
            </Field>
            <Field label={`Importance ${importance.toFixed(2)}`}>
              <input
                className="w-full accent-signal"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={importance}
                onChange={(event) => setImportance(Number(event.target.value))}
              />
            </Field>
            <Field label="TTL seconds (0 keeps it)">
              <input className={fieldClass} type="number" min={0} value={ttl} onChange={(event) => setTtl(Number(event.target.value) || 0)} />
            </Field>
            <Btn tone="signal" disabled={!ready} onClick={store}>
              Store
            </Btn>
          </div>
        </Panel>
        <Panel title="Recall">
          <div className="flex flex-col gap-3">
            <Field label="Query">
              <input className={fieldClass} value={query} onChange={(event) => setQuery(event.target.value)} />
            </Field>
            <Btn disabled={!ready} onClick={recall}>
              Recall
            </Btn>
            <ul className="flex flex-col gap-2">
              {hits.map((hit) => (
                <li key={hit[0]} className="rounded-md border border-line px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-xs">{hit[0]}</span>
                    <span className="font-mono text-xs text-muted tabular-nums">score {hit[2]}</span>
                  </div>
                  <p className="mt-1 text-sm text-pretty">{hit[1]}</p>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>
      {error ? (
        <p className="text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <Panel title="Living set">
        <ul className="flex flex-col gap-3">
          {(view?.memories ?? []).map((memory) => (
            <li key={`${memory.session}:${memory.key}`} className="grid gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
              <div className="min-w-0">
                <div className="font-mono text-xs text-muted">
                  {memory.key} · {memory.session}
                </div>
                <p className="text-sm text-pretty">{memory.value}</p>
              </div>
              <div>
                <div className="mb-1 font-mono text-xs text-muted tabular-nums">weight {memory.weight.toFixed(2)}</div>
                <div className="h-2 rounded-full bg-bg-inset">
                  <div className="h-2 rounded-full bg-signal" style={{ width: `${Math.max(4, Math.min(100, memory.weight * 100))}%` }} />
                </div>
              </div>
              <Btn
                onClick={() => {
                  const result = runSql(`MEMORY FORGET ${sqlQuote(memory.key)}`);
                  if (!result.ok) setError(result.error ?? "forget failed");
                }}
              >
                Forget
              </Btn>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
