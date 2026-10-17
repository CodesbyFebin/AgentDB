import type { ExecResult } from "@/lib/openbase/types";
import { formatCell } from "./ui";

export function ResultGrid({ result }: { result: ExecResult | null }) {
  if (!result) {
    return <p className="text-sm text-pretty text-muted">Run a statement. Rows, plans, and errors show up here.</p>;
  }
  if (!result.ok) {
    return (
      <p className="text-sm text-pretty text-fg" role="alert">
        <span className="font-mono text-xs tracking-wide text-muted">ERROR </span>
        {result.error}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted">
        <span className="tabular-nums">{result.rows.length} rows</span>
        <span className="tabular-nums">{result.ms < 0.05 ? "<0.1" : result.ms.toFixed(1)} ms</span>
        {result.cached ? <span>cache hit</span> : null}
        {result.affected ? <span className="tabular-nums">{result.affected} affected</span> : null}
        {result.truncated ? <span>capped at 500</span> : null}
        {result.message ? <span className="text-fg">{result.message}</span> : null}
      </div>
      {result.plan.length ? (
        <ol className="flex flex-wrap gap-2">
          {result.plan.map((step, index) => (
            <li key={`${step.op}-${index}`} className="rounded-md border border-line bg-bg-inset px-2 py-1 font-mono text-xs text-muted">
              <span className="text-fg">{step.op}</span> {step.detail}
              <span className="tabular-nums"> · {step.rows}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {result.columns.length ? (
        <div className="max-w-full overflow-x-auto rounded-md border border-line">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">Query results</caption>
            <thead className="bg-bg-inset text-xs text-muted">
              <tr>
                {result.columns.map((column) => (
                  <th key={column.name} className="px-3 py-2 font-medium whitespace-nowrap">
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-muted" colSpan={result.columns.length}>
                    No rows.
                  </td>
                </tr>
              ) : (
                result.rows.map((row, index) => (
                  <tr key={index} className="border-t border-line">
                    {row.map((cell, cellIndex) => (
                      <td
                        key={`${result.columns[cellIndex]?.name ?? cellIndex}`}
                        className={`max-w-xs px-3 py-2 align-top font-mono text-xs ${cell == null ? "text-muted" : "text-fg"}`}
                      >
                        <span className="line-clamp-4 break-words tabular-nums">{formatCell(cell)}</span>
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
