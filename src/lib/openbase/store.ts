import { create } from "zustand";
import { Engine } from "./engine.ts";
import { SAMPLES, openSeed } from "./seed.ts";
import { STORAGE_KEY, type ExecResult, type Role, type Snapshot } from "./types.ts";

let engine: Engine | null = null;
let booted = false;

type ConsoleState = {
  ready: boolean;
  rev: number;
  sql: string;
  ask: string;
  mode: "sql" | "ask";
  result: ExecResult | null;
};

export const useConsole = create<ConsoleState>(() => ({
  ready: false,
  rev: 0,
  sql: SAMPLES[2].sql,
  ask: "which documents explain crash recovery",
  mode: "sql",
  result: null,
}));

export function getEngine(): Engine {
  if (!engine) engine = openSeed();
  return engine;
}

export function boot(): void {
  if (booted) return;
  booted = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    engine = raw ? Engine.load(JSON.parse(raw) as Snapshot) : openSeed();
    if (!raw) engine.persistNow();
    else engine.persistNow();
  } catch {
    engine = openSeed();
    engine.persistNow();
  }
  const result = engine.exec(useConsole.getState().sql);
  useConsole.setState({ ready: true, rev: 1, result });
}

function bump(partial?: Partial<ConsoleState>): void {
  useConsole.setState((state) => ({ ...partial, rev: state.rev + 1 }));
}

export function runSql(sql: string): ExecResult {
  const result = getEngine().exec(sql);
  bump({ result, sql });
  return result;
}

export function setRole(role: Role): void {
  getEngine().setRole(role);
  bump();
}

export function setSession(session: string): void {
  getEngine().setSession(session);
  bump();
}

export function resetFile(): void {
  localStorage.removeItem(STORAGE_KEY);
  engine = openSeed();
  engine.persistNow();
  const result = engine.exec(useConsole.getState().sql);
  bump({ result });
}

export function importFile(snap: Snapshot): void {
  engine = Engine.load(snap);
  engine.persistNow();
  bump({ result: null });
}
