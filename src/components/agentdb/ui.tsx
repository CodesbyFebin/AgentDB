import type { ButtonHTMLAttributes, ReactNode } from "react";

export const fieldClass =
  "w-full rounded-md border border-line bg-bg-inset px-3 py-2 text-sm text-fg outline-none placeholder:text-muted";

export function Btn({
  tone = "line",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "signal" | "line" | "ghost" }) {
  const tones = {
    signal: "bg-signal text-signal-ink hover:opacity-90",
    line: "border border-line bg-bg-raised text-fg hover:border-signal",
    ghost: "text-muted hover:bg-surface hover:text-fg",
  };
  return (
    <button
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-opacity ${tones[tone]} disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...props}
    />
  );
}

export function Panel({
  title,
  aside,
  children,
  className = "",
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`min-w-0 rounded-lg border border-line bg-bg-raised ${className}`}>
      {title ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium text-fg">{title}</h2>
          {aside}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function formatCell(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return String(Math.round(value * 10000) / 10000);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (value.length > 4 && value.every((item) => typeof item === "number")) return `vector(${value.length})`;
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  }
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 96 ? `${text.slice(0, 93)}…` : text;
  }
  const text = String(value);
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}
