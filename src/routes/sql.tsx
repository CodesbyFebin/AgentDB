import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ResultGrid } from "@/components/openbase/grid";
import { Shell } from "@/components/openbase/shell";
import { Btn, fieldClass } from "@/components/openbase/ui";
import { nlToSql, type NlNeed } from "@/lib/openbase/nl2sql";
import { SAMPLES } from "@/lib/openbase/seed";
import { getEngine, runSql, useConsole } from "@/lib/openbase/store";

export const Route = createFileRoute("/sql")({ component: Page });

function Page() {
  return (
    <Shell>
      <Workbench />
    </Shell>
  );
}

function Workbench() {
  const ready = useConsole((state) => state.ready);
  const sql = useConsole((state) => state.sql);
  const ask = useConsole((state) => state.ask);
  const mode = useConsole((state) => state.mode);
  const result = useConsole((state) => state.result);
  const [explain, setExplain] = useState(false);
  const [clarify, setClarify] = useState<NlNeed | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function submit(text = mode === "sql" ? sql : ask) {
    if (!ready) return;
    setClarify(null);
    if (mode === "ask") {
      const mapped = nlToSql(getEngine(), text);
      if (mapped.kind === "need") {
        setClarify(mapped);
        setNote(mapped.message);
        return;
      }
      setNote(`${mapped.note} ${Math.round(mapped.confidence * 100)}%`);
      runSql(mapped.sql);
      useConsole.setState({ sql: mapped.sql });
      return;
    }
    const rewritten = rewriteDot(text);
    if (rewritten.help) {
      setNote(rewritten.help);
      return;
    }
    const statement = explain && !/^\s*explain\b/i.test(rewritten.sql) ? `EXPLAIN ${rewritten.sql}` : rewritten.sql;
    runSql(statement);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">Workbench</h1>
          <p className="max-w-xl text-sm text-pretty text-muted">
            The engineer’s view of the same file. The agent desk is the front page.
          </p>
        </div>
        <div className="flex rounded-md border border-line p-1" role="group" aria-label="Editor mode">
          {(["sql", "ask"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => useConsole.setState({ mode: item })}
              className={`min-h-11 rounded-md px-3 font-mono text-xs ${mode === item ? "bg-signal text-signal-ink" : "text-muted"}`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {SAMPLES.map((sample) => (
          <button
            key={sample.label}
            type="button"
            className="min-h-11 shrink-0 rounded-md border border-line px-3 font-mono text-xs text-muted hover:text-fg"
            onClick={() => {
              useConsole.setState({ mode: "sql", sql: sample.sql });
              if (ready) runSql(explain ? `EXPLAIN ${sample.sql}` : sample.sql);
            }}
          >
            {sample.label}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-2">
        <span className="sr-only">{mode === "sql" ? "SQL" : "Question"}</span>
        <textarea
          className={`${fieldClass} min-h-44 font-mono leading-relaxed`}
          value={mode === "sql" ? sql : ask}
          spellCheck={mode === "ask"}
          onChange={(event) => useConsole.setState(mode === "sql" ? { sql: event.target.value } : { ask: event.target.value })}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Btn tone="signal" disabled={!ready} onClick={() => submit()}>
          {ready ? "Run" : "Opening file"}
        </Btn>
        {mode === "sql" ? (
          <label className="inline-flex min-h-11 items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={explain} onChange={(event) => setExplain(event.target.checked)} />
            Explain
          </label>
        ) : null}
        <span className="font-mono text-xs text-muted">Ctrl+Enter</span>
        {note ? <span className="text-sm text-muted">{note}</span> : null}
      </div>
      {clarify ? (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg-raised p-4">
          <p className="text-sm">{clarify.message}</p>
          <div className="flex flex-wrap gap-2">
            {clarify.options.map((option) => (
              <Btn
                key={option.label}
                onClick={() => {
                  getEngine().learn(ask, option.sql);
                  useConsole.setState({ sql: option.sql, mode: "sql" });
                  runSql(option.sql);
                  setClarify(null);
                  setNote("Pinned this intent to the pattern cache.");
                }}
              >
                {option.label}
              </Btn>
            ))}
          </div>
        </div>
      ) : null}
      <ResultGrid result={ready ? result : null} />
    </div>
  );
}

function rewriteDot(sql: string): { sql: string; help?: string } {
  const text = sql.trim();
  if (text === ".help") {
    return {
      sql: text,
      help: "Try .tables, .indexes, .schema docs, .streams, .events, or any SQL statement.",
    };
  }
  if (text === ".tables") return { sql: "SHOW TABLES" };
  if (text === ".indexes") return { sql: "SHOW INDEXES" };
  if (text === ".streams") return { sql: "SHOW STREAMS" };
  if (text === ".events") return { sql: "SHOW EVENTS" };
  const schema = text.match(/^\.schema\s+([A-Za-z_][\w]*)$/);
  if (schema) return { sql: `SHOW SCHEMA ${schema[1]}` };
  return { sql };
}
