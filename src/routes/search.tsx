import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Shell } from "@/components/agentdb/shell";
import { Btn, Field, Panel, fieldClass } from "@/components/agentdb/ui";
import { getEngine, useConsole } from "@/lib/agentdb/store";
import { splitMarks, sqlQuote } from "@/lib/agentdb/text";
import type { ExecResult } from "@/lib/agentdb/types";

export const Route = createFileRoute("/search")({ component: Page });

function Page() {
  return (
    <Shell>
      <SearchView />
    </Shell>
  );
}

function SearchView() {
  const ready = useConsole((state) => state.ready);
  const rev = useConsole((state) => state.rev);
  const [query, setQuery] = useState("reciprocal rank fusion");
  const [mode, setMode] = useState<"hybrid" | "bm25" | "vector">("hybrid");
  const [category, setCategory] = useState("");
  const [result, setResult] = useState<ExecResult | null>(null);
  const categories = useMemo(() => {
    if (!ready) return [];
    const rows = getEngine().exec("SELECT DISTINCT category FROM docs ORDER BY category").rows;
    return rows.map((row) => String(row[0]));
  }, [ready, rev]);

  function run() {
    const where = category ? ` WHERE category = ${sqlQuote(category)}` : "";
    const and = category ? ` AND category = ${sqlQuote(category)}` : "";
    const q = sqlQuote(query);
    const sql =
      mode === "hybrid"
        ? `HYBRID ${q} FROM docs VECTOR embedding TEXT title, body${where} LIMIT 6`
        : mode === "bm25"
          ? `SELECT id, title, category, bm25(body, ${q}) AS score, body FROM docs WHERE bm25(body, ${q}) > 0${and} ORDER BY score DESC LIMIT 6`
          : `SELECT id, title, category, vector_distance(embedding, embed(${q})) AS dist, body FROM docs${where} ORDER BY dist LIMIT 6`;
    setResult(getEngine().exec(sql));
  }

  const suggestions = ready && query.length >= 2 ? getEngine().suggest(query.split(/\s+/).pop() ?? "", 6) : [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-medium">Search</h1>
        <p className="max-w-2xl text-sm text-pretty text-muted">
          BM25, exact vector distance, or both fused with reciprocal rank fusion. Filters run before the ranks are combined.
        </p>
      </div>
      <Panel>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_10rem]">
          <Field label="Query">
            <input className={fieldClass} value={query} onChange={(event) => setQuery(event.target.value)} />
          </Field>
          <Field label="Mode">
            <select className={fieldClass} value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
              <option value="hybrid">hybrid</option>
              <option value="bm25">bm25</option>
              <option value="vector">vector</option>
            </select>
          </Field>
          <Field label="Category">
            <select className={fieldClass} value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">any</option>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {suggestions.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestions.map((term) => (
              <button key={term} type="button" className="min-h-11 rounded-md border border-line px-3 font-mono text-xs text-muted" onClick={() => setQuery(term)}>
                {term}
              </button>
            ))}
          </div>
        ) : null}
        <div className="mt-3">
          <Btn tone="signal" disabled={!ready} onClick={run}>
            Search
          </Btn>
        </div>
      </Panel>
      {result && !result.ok ? (
        <p role="alert" className="text-sm">
          {result.error}
        </p>
      ) : null}
      <div className="flex flex-col gap-3">
        {result?.ok
          ? result.rows.map((row) => {
              const title = String(row[1] ?? "");
              const cat = String(row[2] ?? "");
              const score = row[3];
              const body = String(row[row.length - 1] ?? "");
              const label = mode === "vector" ? "dist" : mode === "bm25" ? "bm25" : "rrf";
              return (
                <article key={String(row[0])} className="rounded-lg border border-line bg-bg-raised p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-base font-medium">{title}</h2>
                    <span className="font-mono text-xs text-muted">
                      {cat} · {label} {typeof score === "number" ? score.toFixed(4) : String(score ?? "")}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-pretty text-muted">
                    {splitMarks(body, query).map((part, index) =>
                      part.hit ? (
                        <mark key={index} className="bg-signal text-signal-ink">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={index}>{part.text}</span>
                      ),
                    )}
                  </p>
                </article>
              );
            })
          : (
            <p className="text-sm text-muted">Run a search. The seeded corpus is sixteen short notes on the engine itself.</p>
          )}
      </div>
      {result?.plan.length ? (
        <p className="font-mono text-xs text-muted">{result.plan.map((step) => step.op).join(" → ")}</p>
      ) : null}
    </div>
  );
}
