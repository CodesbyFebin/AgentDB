import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Shell } from "@/components/openbase/shell";
import { Btn, Field, Panel, fieldClass } from "@/components/openbase/ui";
import { TOOLS, callTool, discover, prompts, resources, type ToolResponse } from "@/lib/openbase/mcp";
import { getEngine, useConsole } from "@/lib/openbase/store";

export const Route = createFileRoute("/mcp")({ component: Page });

function Page() {
  return (
    <Shell>
      <McpView />
    </Shell>
  );
}

function McpView() {
  const ready = useConsole((state) => state.ready);
  const rev = useConsole((state) => state.rev);
  const [name, setName] = useState("agent_context");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [response, setResponse] = useState<ToolResponse | null>(null);
  const tool = TOOLS.find((item) => item.name === name) ?? TOOLS[0];
  const info = useMemo(() => (ready ? discover(getEngine()) : null), [ready, rev]);
  const groups = [...new Set(TOOLS.map((item) => item.category))];

  function invoke(extra?: Record<string, string>) {
    const payload: Record<string, unknown> = { ...args, ...extra };
    for (const param of tool.params) {
      if (param.type === "number" && typeof payload[param.name] === "string" && payload[param.name] !== "") {
        payload[param.name] = Number(payload[param.name]);
      }
      if (param.type === "json" && typeof payload[param.name] === "string" && payload[param.name] !== "") {
        payload[param.name] = JSON.parse(String(payload[param.name]));
      }
      if (payload[param.name] === "") delete payload[param.name];
    }
    try {
      const next = callTool(getEngine(), tool.name, payload);
      setResponse(next);
      useConsole.setState((state) => ({ rev: state.rev + 1 }));
    } catch (error) {
      setResponse({ ok: false, error: error instanceof Error ? error.message : String(error), ms: 0 });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-medium">MCP</h1>
        <p className="max-w-2xl text-sm text-pretty text-muted">
          Stateless core. No initialize handshake and no session id. If a tool needs a choice, it returns InputRequired and waits for the next call.
        </p>
      </div>
      {info ? (
        <div className="grid gap-2 sm:grid-cols-4">
          <Stat label="Protocol" value={info.protocol} />
          <Stat label="Tools" value={String(info.tools)} />
          <Stat label="Role" value={String(info.role)} />
          <Stat label="Stateless" value={info.stateless ? "yes" : "no"} />
        </div>
      ) : (
        <p className="text-sm text-muted">Opening agent.db…</p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group}>
              <h2 className="mb-1 font-mono text-xs tracking-wide text-muted">{group}</h2>
              <div className="flex flex-col">
                {TOOLS.filter((item) => item.category === group).map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => {
                      setName(item.name);
                      setArgs({});
                      setResponse(null);
                    }}
                    className={`min-h-11 rounded-md px-2 text-left font-mono text-xs ${item.name === tool.name ? "bg-surface text-fg" : "text-muted"}`}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={tool.name} aside={<span className="font-mono text-xs text-muted">{tool.role}</span>}>
            <p className="text-sm text-pretty text-muted">{tool.description}</p>
            <div className="mt-3 flex flex-col gap-3">
              {tool.params.map((param) => (
                <Field key={param.name} label={`${param.name}${param.required ? "" : " (optional)"} · ${param.help}`}>
                  {param.type === "json" || param.name === "sql" || param.name === "question" || param.name === "text" ? (
                    <textarea
                      className={`${fieldClass} min-h-24 font-mono`}
                      value={args[param.name] ?? ""}
                      onChange={(event) => setArgs({ ...args, [param.name]: event.target.value })}
                    />
                  ) : (
                    <input
                      className={fieldClass}
                      value={args[param.name] ?? ""}
                      onChange={(event) => setArgs({ ...args, [param.name]: event.target.value })}
                    />
                  )}
                </Field>
              ))}
            </div>
            <div className="mt-3">
              <Btn tone="signal" disabled={!ready} onClick={() => invoke()}>
                Call
              </Btn>
            </div>
          </Panel>
          {response?.ok && response.inputRequired ? (
            <Panel title="Input required">
              <p className="text-sm">{response.inputRequired.message}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {response.inputRequired.options.map((option) => (
                  <Btn key={option.value} onClick={() => invoke({ [response.inputRequired?.field ?? "choice"]: option.value })}>
                    {option.label}
                  </Btn>
                ))}
              </div>
            </Panel>
          ) : null}
          {response ? (
            <Panel title={response.ok ? `Result · ${response.ms} ms` : "Error"}>
              <pre className="overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
                {JSON.stringify(response.ok ? (response.inputRequired ?? response.content) : { error: response.error }, null, 2)}
              </pre>
            </Panel>
          ) : null}
          <Panel title="Resources and prompts">
            <ul className="flex flex-col gap-1 font-mono text-xs text-muted">
              {(ready ? resources(getEngine()) : []).map((item) => (
                <li key={item.uri}>
                  {item.uri} — {item.description}
                </li>
              ))}
              {prompts().map((item) => (
                <li key={item.name}>
                  {item.name} — {item.description}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg-raised px-3 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="font-mono text-sm tabular-nums">{value}</div>
    </div>
  );
}
