import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Shell } from "@/components/agentdb/shell";
import { Btn, Field, Panel, fieldClass, formatCell } from "@/components/agentdb/ui";
import { getEngine, runSql, useConsole } from "@/lib/agentdb/store";

export const Route = createFileRoute("/schema")({ component: Page });

const TYPES = ["INTEGER", "TEXT", "REAL", "JSON", "BOOLEAN", "VECTOR(48)", "TIMESTAMP"];

function Page() {
  return (
    <Shell>
      <SchemaView />
    </Shell>
  );
}

function SchemaView() {
  const ready = useConsole((state) => state.ready);
  const rev = useConsole((state) => state.rev);
  const view = useMemo(() => (ready ? getEngine().overview() : null), [ready, rev]);
  const [active, setActive] = useState("docs");
  const [name, setName] = useState("notes");
  const [cols, setCols] = useState([
    { name: "id", type: "INTEGER" },
    { name: "body", type: "TEXT" },
  ]);
  const [error, setError] = useState("");
  const table = view?.tables.find((item) => item.name === active) ?? view?.tables[0];

  function createTable() {
    if (!/^[A-Za-z_][\w]*$/.test(name)) {
      setError("Table name must be letters, numbers, and underscores.");
      return;
    }
    const defined = cols.filter((col) => /^[A-Za-z_][\w]*$/.test(col.name));
    if (!defined.length) {
      setError("Add at least one column.");
      return;
    }
    const body = defined
      .map((col, index) => `  ${col.name} ${col.type}${index === 0 && col.type === "INTEGER" ? " PRIMARY KEY" : ""}`)
      .join(",\n");
    const result = runSql(`CREATE TABLE ${name} (\n${body}\n)`);
    if (!result.ok) setError(result.error ?? "create failed");
    else {
      setError("");
      setActive(name);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-medium">Schema</h1>
        <p className="text-sm text-muted">Tables, indexes, and the DDL preview for this browser demo.</p>
      </div>
      {!view ? (
        <p className="text-sm text-muted">Opening browser snapshot…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="flex flex-col gap-2">
            {view.tables.map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={() => setActive(item.name)}
                className={`flex min-h-11 items-center justify-between rounded-md border px-3 text-left text-sm ${item.name === table?.name ? "border-signal bg-surface text-fg" : "border-line text-muted"}`}
              >
                <span className="font-mono">{item.name}</span>
                <span className="tabular-nums text-xs">{item.rows}</span>
              </button>
            ))}
          </div>
          {table ? (
            <div className="flex min-w-0 flex-col gap-4">
              <Panel title={table.name} aside={<span className="font-mono text-xs text-muted">{table.rows} rows</span>}>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-muted">
                      <tr>
                        <th className="py-1 pr-3 font-medium">column</th>
                        <th className="py-1 pr-3 font-medium">type</th>
                        <th className="py-1 font-medium">key</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.cols.map((col) => (
                        <tr key={col.name} className="border-t border-line font-mono text-xs">
                          <td className="py-2 pr-3">{col.name}</td>
                          <td className="py-2 pr-3 text-muted">{col.type === "VECTOR" ? `VECTOR(${col.dim})` : col.type}</td>
                          <td className="py-2">{col.primary ? "primary" : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <pre className="mt-4 overflow-x-auto rounded-md bg-bg-inset p-3 font-mono text-xs leading-relaxed text-fg">{table.ddl}</pre>
              </Panel>
              <Panel title="Sample rows">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <tbody>
                      {table.sample.map((row, index) => (
                        <tr key={index} className="border-t border-line">
                          {table.cols.map((col) => (
                            <td key={col.name} className="max-w-xs py-2 pr-3 font-mono align-top">
                              <span className="line-clamp-2">{formatCell(row[col.name])}</span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
              {view.role === "admin" ? (
                <Btn
                  className="self-start"
                  onClick={() => {
                    const result = runSql(`DROP TABLE ${table.name}`);
                    if (!result.ok) setError(result.error ?? "drop failed");
                  }}
                >
                  Drop {table.name}
                </Btn>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <Panel title="Create table">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {cols.map((col, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_12rem]">
              <input
                className={fieldClass}
                value={col.name}
                aria-label={`Column ${index + 1} name`}
                onChange={(event) => setCols(cols.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))}
              />
              <select
                className={fieldClass}
                value={col.type}
                aria-label={`Column ${index + 1} type`}
                onChange={(event) => setCols(cols.map((item, i) => (i === index ? { ...item, type: event.target.value } : item)))}
              >
                {TYPES.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Btn onClick={() => setCols([...cols, { name: "", type: "TEXT" }])}>Add column</Btn>
          <Btn tone="signal" disabled={!ready} onClick={createTable}>
            Create
          </Btn>
        </div>
        {error ? <p className="mt-3 text-sm text-fg" role="alert">{error}</p> : null}
      </Panel>
    </div>
  );
}
