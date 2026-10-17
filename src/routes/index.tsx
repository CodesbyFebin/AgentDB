import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Shell } from "@/components/openbase/shell";
import { Btn, Panel, fieldClass } from "@/components/openbase/ui";
import { getEngine, useConsole } from "@/lib/openbase/store";
import { TURN_PROMPTS, runTurn, type Turn } from "@/lib/openbase/turn";

export const Route = createFileRoute("/")({ component: Home });

const OPENING = TURN_PROMPTS[0];
let live: Turn | null = null;

function Home() {
  return (
    <Shell>
      <Session />
    </Shell>
  );
}

function Session() {
  const ready = useConsole((state) => state.ready);
  const rev = useConsole((state) => state.rev);
  const [question, setQuestion] = useState(OPENING);
  const [turn, setTurn] = useState<Turn | null>(live);

  useEffect(() => {
    if (!ready) return;
    if (live) {
      setTurn(live);
      setQuestion(live.question);
      return;
    }
    play(OPENING);
  }, [ready]);

  function play(text: string, choice?: string) {
    live = runTurn(getEngine(), text, choice);
    setQuestion(text);
    setTurn(live);
    useConsole.setState((state) => ({ rev: state.rev + 1 }));
  }

  const ledger = useMemo(() => {
    if (!ready) return [];
    const result = getEngine().exec("SELECT id, question, because FROM evidence_ledger ORDER BY id DESC LIMIT 6");
    return result.ok ? result.rows : [];
  }, [ready, rev]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-medium">Agent</h1>
        <p className="max-w-2xl text-sm text-pretty text-muted">
          A local tool router opens the file, calls MCP tools, and writes a because-line. No hosted model. Nothing leaves the browser.
        </p>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {TURN_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="min-h-11 shrink-0 rounded-md border border-line px-3 text-left text-xs text-muted hover:text-fg"
            onClick={() => {
              setQuestion(prompt);
              if (ready) play(prompt);
            }}
          >
            {prompt}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-2">
        <span className="sr-only">Question for the agent</span>
        <textarea
          className={`${fieldClass} min-h-24`}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
      </label>
      <div>
        <Btn tone="signal" disabled={!ready || !question.trim()} onClick={() => play(question)}>
          {ready ? "Run turn" : "Opening file"}
        </Btn>
      </div>
      {!turn ? <p className="text-sm text-muted">Opening agent.db…</p> : <TurnView turn={turn} onChoice={(sql) => play(turn.question, sql)} />}
      {ledger.length ? (
        <Panel title="evidence_ledger">
          <ul className="flex flex-col gap-3">
            {ledger.map((row) => (
              <li key={String(row[0])} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                <p className="text-sm">{String(row[1])}</p>
                <p className="mt-1 text-sm text-pretty text-muted">{String(row[2])}</p>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

function TurnView({ turn, onChoice }: { turn: Turn; onChoice: (sql: string) => void }) {
  const waiting = turn.steps.find((step) => step.inputRequired);
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-2">
        {turn.steps.map((step, index) => (
          <li key={`${step.call}-${index}`} className="rounded-lg border border-line bg-bg-raised">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span className="font-mono text-xs">
                <span className="text-muted">{String(index + 1).padStart(2, "0")}</span> {step.call}
              </span>
              <span className="font-mono text-xs text-muted tabular-nums">{step.ok ? `${step.ms} ms` : "refused"}</span>
            </div>
            <p className="border-t border-line px-4 py-3 text-sm text-pretty text-muted">{step.summary}</p>
          </li>
        ))}
      </ol>
      {waiting?.inputRequired ? (
        <Panel title="Input required">
          <p className="text-sm">{waiting.inputRequired.message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {waiting.inputRequired.options.map((option) => (
              <Btn key={option.label} onClick={() => onChoice(option.value)}>
                {option.label}
              </Btn>
            ))}
          </div>
        </Panel>
      ) : (
        <Panel title="Answer" aside={<span className="font-mono text-xs text-muted">because</span>}>
          <p className="text-sm text-pretty">{turn.answer}</p>
          <p className="mt-3 text-sm text-pretty text-muted">{turn.because}</p>
        </Panel>
      )}
    </div>
  );
}
