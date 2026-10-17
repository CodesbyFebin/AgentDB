export const STORAGE_KEY = "agentdb.browser-demo.v1";
export const FILE_NAME = "localStorage snapshot";
export const ENGINE_VERSION = "0.4.0";

export type Role = "read" | "write" | "admin";
export type Metric = "cosine" | "l2" | "dot" | "hamming";
export type ColType =
  | "INTEGER"
  | "REAL"
  | "TEXT"
  | "JSON"
  | "BOOLEAN"
  | "VECTOR"
  | "TIMESTAMP";

export type Val =
  | null
  | boolean
  | number
  | string
  | Val[]
  | { [key: string]: Val };

export type Col = {
  name: string;
  type: ColType;
  dim?: number;
  primary: boolean;
  notNull: boolean;
};

export type Row = { __id: number; data: Record<string, Val> };

export type IndexDef = {
  name: string;
  table: string;
  kind: "btree" | "hnsw" | "bm25";
  columns: string[];
  metric?: Metric;
};

export type StreamDef = { name: string; table: string };

export type Memory = {
  key: string;
  value: string;
  embedding: number[];
  metadata: Record<string, Val>;
  importance: number;
  expiresAt: number | null;
  session: string;
  createdAt: number;
};

export type CdcEvent = {
  id: number;
  stream: string;
  table: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  before: Record<string, Val> | null;
  after: Record<string, Val> | null;
  ts: number;
};

export type WalRec = { lsn: number; sql: string; ts: number };

export type EvidenceReceipt = {
  receiptId: number;
  runId: string;
  sessionId: string;
  actorChain: string[];
  intent: string;
  decision: { approved: boolean; policy: string; latencyMs: number };
  action: string;
  resultHash: string;
  resultSummary: string;
  prevHash: string;
  timestamp: string;
  audienceExplanation: string;
  hash: string;
};

export type DataState = {
  tables: { name: string; cols: Col[]; rows: Row[]; nextId: number }[];
  indexes: IndexDef[];
  streams: StreamDef[];
  memories: Memory[];
  cdc: CdcEvent[];
  cdcSeq: number;
  session: string;
};

export type Snapshot = {
  version: 1;
  lsn: number;
  checkpointLsn: number;
  role: Role;
  session: string;
  stats: { queries: number; hits: number; misses: number };
  patterns: [string, string][];
  checkpoint: DataState;
  wal: WalRec[];
  evidence?: EvidenceReceipt[];
};

export type PlanStep = { op: string; detail: string; rows: number };

export type ExecResult = {
  ok: boolean;
  ms: number;
  cached?: boolean;
  error?: string;
  columns: { name: string }[];
  rows: Val[][];
  affected: number;
  message?: string;
  plan: PlanStep[];
  truncated?: boolean;
};

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbError";
  }
}
