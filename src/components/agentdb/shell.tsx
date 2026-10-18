import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Brain, Cable, Gauge, Search, TableProperties, Terminal, Waypoints } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { boot, getEngine, setRole, useConsole } from "@/lib/agentdb/store";
import type { Role } from "@/lib/agentdb/types";

const NAV = [
  { to: "/", label: "Agent Desk", icon: Brain },
  { to: "/sql", label: "SQL", icon: Terminal },
  { to: "/schema", label: "Schema", icon: TableProperties },
  { to: "/vectors", label: "Vectors", icon: Waypoints },
  { to: "/search", label: "Search", icon: Search },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/mcp", label: "MCP", icon: Cable },
  { to: "/streams", label: "Streams", icon: Activity },
  { to: "/stats", label: "Stats", icon: Gauge },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const ready = useConsole((state) => state.ready);
  const rev = useConsole((state) => state.rev);
  const path = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => {
    boot();
  }, []);
  const view = ready ? getEngine().overview() : null;
  void rev;

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 md:px-6">
        <Link to="/" className="flex items-center gap-3">
          <Mark />
          <span>
            <span className="block font-mono text-sm font-medium tracking-widest">AGENTDB</span>
            <span className="block text-xs text-muted">Browser prototype · Phase 1 slice</span>
          </span>
        </Link>
        <RoleSwitch role={view?.role ?? "admin"} disabled={!ready} />
      </header>
      <div className="lg:grid lg:grid-cols-12">
        <nav className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2 lg:col-span-2 lg:flex-col lg:border-r lg:border-b-0 lg:px-3 lg:py-4">
          {NAV.map((item) => {
            const active = item.to === "/" ? path === "/" : path.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm ${active ? "bg-surface text-fg" : "text-muted hover:bg-surface hover:text-fg"}`}
              >
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0 lg:col-span-10">
          {view?.role === "read" ? (
            <p className="border-b border-line px-4 py-2 text-xs text-muted md:px-6">Read-only session. Writes are rejected until the role changes.</p>
          ) : null}
          <main className="px-4 py-4 md:px-6 md:py-6">{children}</main>
          <footer className="flex flex-wrap gap-x-3 gap-y-1 px-4 pb-6 font-mono text-xs text-muted md:px-6">
            <span>{ready ? "localStorage snapshot" : "opening browser snapshot"}</span>
            <span className="tabular-nums">LSN {String(view?.lsn ?? 0).padStart(4, "0")}</span>
            <span className="tabular-nums">WAL {view?.wal ?? 0}</span>
            <span>44 in-browser tool calls</span>
            <span>browser-local calls · separate HTTP prototype</span>
            {view ? <span className="tabular-nums">{(view.bytes / 1024).toFixed(1)} kb</span> : null}
          </footer>
        </div>
      </div>
    </div>
  );
}

function RoleSwitch({ role, disabled }: { role: Role; disabled: boolean }) {
  const roles: Role[] = ["read", "write", "admin"];
  return (
    <div className="flex rounded-md border border-line p-1" role="group" aria-label="Session role">
      {roles.map((item) => (
        <button
          key={item}
          type="button"
          disabled={disabled}
          onClick={() => setRole(item)}
          className={`min-h-11 rounded-md px-3 font-mono text-xs ${item === role ? "bg-signal text-signal-ink" : "text-muted"}`}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 32 32" className="size-9 text-fg" aria-hidden="true">
      <rect x="3" y="5" width="16" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="9" width="16" height="18" fill="var(--color-bg)" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 23 L25 11" stroke="var(--color-signal)" strokeWidth="1.75" />
    </svg>
  );
}
