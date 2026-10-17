import { Bm25Index } from "./bm25.ts";
import { HnswIndex } from "./hnsw.ts";
import { mutates, parseSql, type Expr, type Stmt } from "./parse.ts";
import { DIM, distance, embedText, likeMatch, similarity, sqlQuote } from "./text.ts";
import { DbError, STORAGE_KEY, type CdcEvent, type Col, type DataState, type ExecResult, type IndexDef, type Memory, type Metric, type PlanStep, type Role, type Row, type Snapshot, type StreamDef, type Val } from "./types.ts";

type Table = { name: string; cols: Col[]; rows: Row[]; nextId: number };
type Env = { by: Record<string, Record<string, Val>>; id: number; table: string };
type BTree = { def: IndexDef; entries: { key: string; id: number }[] };
type Live =
  | ({ kind: "btree" } & BTree)
  | { kind: "hnsw"; def: IndexDef; hnsw: HnswIndex }
  | { kind: "bm25"; def: IndexDef; bm: Bm25Index };

const MAX_ROWS = 500;
const AGG = new Set(["count", "sum", "avg", "min", "max"]);

export class Engine {
  role: Role = "admin";
  session = "default";
  private tables = new Map<string, Table>();
  private indexes = new Map<string, Live>();
  private streams: StreamDef[] = [];
  private memories: Memory[] = [];
  private cdc: CdcEvent[] = [];
  private cdcSeq = 0;
  private lsn = 0;
  private checkpointLsn = 0;
  private wal: { lsn: number; sql: string; ts: number }[] = [];
  private base: DataState = emptyData();
  private txn: DataState | null = null;
  private txnWal: string[] = [];
  private durable = false;
  private stats = { queries: 0, hits: 0, misses: 0 };
  private patterns = new Map<string, string>();
  private cache = new Map<string, ExecResult>();
  private bmCache = new Map<string, Map<number, number>>();

  static seed(sqls: string[]): Engine {
    const engine = new Engine();
    for (const sql of sqls) {
      const result = engine.exec(sql);
      if (!result.ok) throw new DbError(`seed failed: ${result.error}\n${sql.slice(0, 180)}`);
    }
    engine.checkpoint();
    return engine;
  }

  static load(snap: Snapshot): Engine {
    if (snap.version !== 1) throw new DbError("unsupported file version");
    const engine = new Engine();
    engine.restore(snap.checkpoint);
    engine.base = clone(snap.checkpoint);
    engine.checkpointLsn = snap.checkpointLsn;
    engine.lsn = snap.checkpointLsn;
    engine.role = snap.role;
    engine.session = snap.session;
    engine.stats = { ...snap.stats };
    engine.patterns = new Map(snap.patterns);
    for (const rec of snap.wal) {
      const result = engine.exec(rec.sql, true);
      if (!result.ok) throw new DbError(`WAL replay failed at LSN ${rec.lsn}: ${result.error}`);
    }
    engine.wal = snap.wal.map((rec) => ({ ...rec }));
    engine.lsn = snap.lsn;
    engine.session = snap.session;
    engine.durable = true;
    return engine;
  }

  persistNow(): void {
    this.durable = true;
    this.persist();
  }

  toSnapshot(): Snapshot {
    return {
      version: 1,
      lsn: this.lsn,
      checkpointLsn: this.checkpointLsn,
      role: this.role,
      session: this.session,
      stats: { ...this.stats },
      patterns: [...this.patterns.entries()],
      checkpoint: this.base,
      wal: this.wal.map((rec) => ({ ...rec })),
    };
  }

  setRole(role: Role): void {
    this.role = role;
    this.persist();
  }

  setSession(session: string): void {
    this.session = session.trim() || "default";
    this.persist();
  }

  learn(intent: string, sql: string): void {
    this.patterns.set(intent.trim().toLowerCase(), sql);
    this.persist();
  }

  patternFor(intent: string): string | undefined {
    return this.patterns.get(intent.trim().toLowerCase());
  }

  exec(sql: string, replay = false): ExecResult {
    const started = now();
    this.stats.queries += 1;
    this.bmCache.clear();
    try {
      if (/\b(attach|detach|load_extension)\b/i.test(sql)) {
        throw new DbError("statement blocked by the sandbox");
      }
      const pieces = parseSql(sql);
      if (!pieces.length) return done(blank("empty"), started);
      const readOnly = pieces.every(
        (piece) => !mutates(piece.stmt) && !["begin", "commit", "rollback"].includes(piece.stmt.k),
      );
      if (readOnly && !this.txn && !replay) {
        const hit = this.cache.get(sql);
        if (hit) {
          this.stats.hits += 1;
          return { ...hit, ms: 0, cached: true };
        }
        this.stats.misses += 1;
      }
      let last = blank("");
      let affected = 0;
      const messages: string[] = [];
      let mutated = false;
      for (const piece of pieces) {
        if (piece.stmt.k === "explain") {
          if (mutates(piece.stmt.inner)) {
            last = {
              ...blank("mutation was not executed"),
              columns: [{ name: "op" }, { name: "detail" }, { name: "rows" }],
              rows: [["explain", "mutation skipped", 0]],
              plan: [{ op: "explain", detail: "mutation skipped", rows: 0 }],
            };
            continue;
          }
          const inner = this.apply(piece.stmt.inner);
          last = {
            ...blank(""),
            columns: [{ name: "op" }, { name: "detail" }, { name: "rows" }],
            rows: inner.plan.map((step) => [step.op, step.detail, step.rows]),
            plan: inner.plan,
          };
          continue;
        }
        const out = this.apply(piece.stmt);
        last = out;
        affected += out.affected;
        if (out.message) messages.push(out.message);
        if (mutates(piece.stmt) && piece.stmt.k !== "checkpoint" && piece.stmt.k !== "vacuum") {
          mutated = true;
          const logged = out.canonical ?? piece.sql;
          if (!replay) {
            if (this.txn) this.txnWal.push(logged);
            else this.wal.push({ lsn: ++this.lsn, sql: logged, ts: Date.now() });
          }
        }
      }
      if ((mutated || last.message === "checkpoint" || last.message === "vacuum") && !this.txn && !replay) {
        this.cache.clear();
        this.persist();
      }
      const merged: ExecResult = {
        ...last,
        ok: true,
        affected,
        message: messages.filter(Boolean).join("; ") || last.message,
        ms: now() - started,
      };
      if (readOnly && !this.txn && !replay) this.cache.set(sql, merged);
      return merged;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...blank(""), ok: false, error: message, ms: now() - started };
    }
  }

  proveRecovery(): string {
    const snap = this.toSnapshot();
    const other = Engine.load({ ...snap, stats: { queries: 0, hits: 0, misses: 0 } });
    const same = JSON.stringify(this.counts()) === JSON.stringify(other.counts());
    return same
      ? `Replayed ${snap.wal.length} WAL record${snap.wal.length === 1 ? "" : "s"} from checkpoint LSN ${snap.checkpointLsn}. Table counts match.`
      : "Recovery mismatch: replayed state does not match the open file.";
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const table of this.tables.values()) out[table.name] = table.rows.length;
    out["memory"] = this.memories.length;
    return out;
  }

  bytes(): number {
    return new TextEncoder().encode(JSON.stringify(this.toSnapshot())).length;
  }

  overview() {
    const tables = [...this.tables.values()].map((table) => ({
      name: table.name,
      columns: table.cols.length,
      rows: table.rows.length,
      ddl: ddlOf(table),
      cols: table.cols,
      sample: table.rows.slice(0, 5).map((row) => hideVectors(table, row.data)),
    }));
    const indexes = [...this.indexes.values()].map((idx) => ({
      name: idx.def.name,
      table: idx.def.table,
      kind: idx.def.kind,
      columns: idx.def.columns.join(", "),
      metric: idx.def.metric ?? "",
      detail:
        idx.kind === "hnsw"
          ? `${idx.hnsw.size} nodes · ${idx.hnsw.levels} levels`
          : idx.kind === "bm25"
            ? `${idx.bm.docs} docs · ${idx.bm.terms} terms`
            : `${idx.entries.length} keys`,
    }));
    return {
      file: "localStorage snapshot",
      lsn: this.lsn,
      checkpointLsn: this.checkpointLsn,
      wal: this.wal.length,
      role: this.role,
      session: this.session,
      bytes: this.bytes(),
      queries: this.stats.queries,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: this.stats.hits + this.stats.misses ? this.stats.hits / (this.stats.hits + this.stats.misses) : 0,
      tables,
      indexes,
      streams: this.streams.map((stream) => ({ ...stream })),
      events: this.cdc.slice(-40).reverse(),
      memories: this.listMemories(),
      txn: this.txn != null,
      patterns: this.patterns.size,
    };
  }

  listMemories(session?: string) {
    const nowMs = Date.now();
    return this.memories
      .filter((memory) => !session || memory.session === session)
      .map((memory) => {
        const decay = decayOf(memory, nowMs);
        return {
          ...memory,
          decay,
          weight: decay * (0.25 + 0.75 * memory.importance),
          embedding: undefined,
        };
      })
      .sort((a, b) => b.weight - a.weight);
  }

  vectorSearch(tableName: string, column: string, query: string, k: number, mode: "exact" | "hnsw", metric?: Metric) {
    const table = this.requireTable(tableName);
    const col = requireCol(table, column);
    if (col.type !== "VECTOR") throw new DbError(`${column} is not a VECTOR column`);
    const q = embedText(query, col.dim ?? DIM);
    const use: Metric = metric ?? this.hnswOf(tableName, column)?.def.metric ?? "cosine";
    const exact = table.rows
      .filter((row) => Array.isArray(row.data[column]))
      .map((row) => ({
        id: row.__id,
        dist: distance(q, row.data[column] as number[], use),
        data: hideVectors(table, row.data),
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, k);
    const index = this.hnswOf(tableName, column);
    if (mode === "exact" || !index) {
      return { engine: "exact" as const, recall: 1, metric: use, rows: exact, note: index ? "" : "no HNSW index; exact scan" };
    }
    const approx = index.hnsw.search(q, k);
    const byId = new Map(table.rows.map((row) => [row.__id, row]));
    const rows = approx
      .map((hit) => {
        const row = byId.get(hit.id);
        if (!row) return null;
        return { id: hit.id, dist: hit.dist, data: hideVectors(table, row.data) };
      })
      .filter((row): row is NonNullable<typeof row> => row != null);
    const exactIds = new Set(exact.map((row) => row.id));
    const recall = exact.length ? rows.filter((row) => exactIds.has(row.id)).length / exact.length : 1;
    return { engine: "hnsw" as const, recall, metric: use, rows, note: `${index.hnsw.size} graph nodes` };
  }

  suggest(prefix: string, limit = 8): string[] {
    const out = new Set<string>();
    for (const idx of this.indexes.values()) {
      if (idx.kind !== "bm25") continue;
      for (const term of idx.bm.suggest(prefix, limit)) out.add(term);
    }
    return [...out].slice(0, limit);
  }

  private apply(stmt: Stmt): ExecResult & { canonical?: string } {
    switch (stmt.k) {
      case "create_table":
        return this.createTable(stmt);
      case "create_index":
        return this.createIndex(stmt);
      case "create_stream":
        return this.createStream(stmt);
      case "drop":
        return this.drop(stmt);
      case "insert":
        return this.insert(stmt);
      case "update":
        return this.update(stmt);
      case "delete":
        return this.delete(stmt);
      case "select":
        return this.select(stmt);
      case "hybrid":
        return this.hybrid(stmt);
      case "memory_store":
        return this.memoryStore(stmt);
      case "memory_recall":
        return this.memoryRecall(stmt);
      case "memory_forget":
        return this.memoryForget(stmt);
      case "memory_list":
        return this.memoryList(stmt);
      case "show":
        return this.show(stmt);
      case "vacuum":
        return this.vacuum();
      case "check":
        return this.check();
      case "checkpoint":
        this.need("write");
        this.checkpoint();
        return { ...blank("checkpoint"), message: "checkpoint" };
      case "begin":
        return this.begin();
      case "commit":
        return this.commit();
      case "rollback":
        return this.rollback();
      default:
        throw new DbError("statement not executable");
    }
  }

  private createTable(stmt: Extract<Stmt, { k: "create_table" }>): ExecResult {
    this.need("write");
    if (this.tables.has(stmt.name)) {
      if (stmt.ifNot) return blank(`table ${stmt.name} exists`);
      throw new DbError(`table ${stmt.name} already exists`);
    }
    const cols: Col[] = stmt.cols.map((col) => ({
      name: col.name,
      type: col.type as Col["type"],
      dim: col.dim,
      primary: col.primary,
      notNull: col.notNull || col.primary,
    }));
    this.tables.set(stmt.name, { name: stmt.name, cols, rows: [], nextId: 1 });
    return { ...blank(`created table ${stmt.name}`), affected: 0, plan: [{ op: "create table", detail: stmt.name, rows: 0 }] };
  }

  private createIndex(stmt: Extract<Stmt, { k: "create_index" }>): ExecResult {
    this.need("write");
    const table = this.requireTable(stmt.table);
    if (this.indexes.has(stmt.name)) {
      if (stmt.ifNot) return blank(`index ${stmt.name} exists`);
      throw new DbError(`index ${stmt.name} already exists`);
    }
    for (const name of stmt.cols) requireCol(table, name);
    if (stmt.kind === "hnsw") {
      const col = requireCol(table, stmt.cols[0]);
      if (col.type !== "VECTOR") throw new DbError("HNSW index needs a VECTOR column");
    }
    const def: IndexDef = {
      name: stmt.name,
      table: stmt.table,
      kind: stmt.kind,
      columns: stmt.cols,
      metric: stmt.metric ?? (stmt.kind === "hnsw" ? "cosine" : undefined),
    };
    this.indexes.set(stmt.name, this.buildIndex(def, table));
    return { ...blank(`created ${stmt.kind} index ${stmt.name}`), plan: [{ op: "create index", detail: stmt.name, rows: table.rows.length }] };
  }

  private createStream(stmt: Extract<Stmt, { k: "create_stream" }>): ExecResult {
    this.need("write");
    this.requireTable(stmt.table);
    if (this.streams.some((stream) => stream.name === stmt.name)) throw new DbError(`stream ${stmt.name} exists`);
    this.streams.push({ name: stmt.name, table: stmt.table });
    return blank(`stream ${stmt.name} on ${stmt.table}`);
  }

  private drop(stmt: Extract<Stmt, { k: "drop" }>): ExecResult {
    this.need("admin");
    if (stmt.kind === "table") {
      if (!this.tables.has(stmt.name)) {
        if (stmt.ifExists) return blank("nothing to drop");
        throw new DbError(`no table ${stmt.name}`);
      }
      this.tables.delete(stmt.name);
      for (const [name, idx] of this.indexes) if (idx.def.table === stmt.name) this.indexes.delete(name);
      this.streams = this.streams.filter((stream) => stream.table !== stmt.name);
      return blank(`dropped table ${stmt.name}`);
    }
    if (stmt.kind === "index") {
      if (!this.indexes.has(stmt.name)) {
        if (stmt.ifExists) return blank("nothing to drop");
        throw new DbError(`no index ${stmt.name}`);
      }
      this.indexes.delete(stmt.name);
      return blank(`dropped index ${stmt.name}`);
    }
    if (!this.streams.some((stream) => stream.name === stmt.name)) {
      if (stmt.ifExists) return blank("nothing to drop");
      throw new DbError(`no stream ${stmt.name}`);
    }
    this.streams = this.streams.filter((stream) => stream.name !== stmt.name);
    return blank(`dropped stream ${stmt.name}`);
  }

  private insert(stmt: Extract<Stmt, { k: "insert" }>): ExecResult {
    this.need("write");
    const table = this.requireTable(stmt.table);
    const cols = stmt.cols ?? table.cols.map((col) => col.name);
    let n = 0;
    for (const values of stmt.rows) {
      if (values.length !== cols.length) throw new DbError(`${stmt.table}: value count does not match columns`);
      const data: Record<string, Val> = {};
      for (const col of table.cols) data[col.name] = null;
      cols.forEach((name, i) => {
        const col = requireCol(table, name);
        data[name] = coerce(col, this.eval(values[i], blankEnv(), null));
      });
      const pk = table.cols.find((col) => col.primary && col.type === "INTEGER");
      let id = table.nextId;
      if (pk && typeof data[pk.name] === "number") id = data[pk.name] as number;
      else if (pk) data[pk.name] = id;
      if (table.rows.some((row) => row.__id === id)) throw new DbError(`primary key ${id} already exists`);
      for (const col of table.cols) {
        if ((col.notNull || col.primary) && data[col.name] == null) throw new DbError(`${col.name} cannot be null`);
      }
      const row: Row = { __id: id, data };
      table.rows.push(row);
      table.nextId = Math.max(table.nextId, id + 1);
      this.indexAdd(table.name, row);
      this.emit(table.name, "INSERT", null, data);
      n += 1;
    }
    return { ...blank(`inserted ${n}`), affected: n, plan: [{ op: "insert", detail: table.name, rows: n }] };
  }

  private update(stmt: Extract<Stmt, { k: "update" }>): ExecResult {
    this.need("write");
    const table = this.requireTable(stmt.table);
    const pk = table.cols.find((col) => col.primary);
    let n = 0;
    for (const row of table.rows) {
      const env = this.envOf(table.name, table.name, row);
      if (stmt.where && !truthy(this.eval(stmt.where, env, null))) continue;
      const before = { ...row.data };
      this.indexRemove(table.name, row);
      for (const set of stmt.sets) {
        if (pk && set.col === pk.name) throw new DbError("cannot update primary key");
        const col = requireCol(table, set.col);
        row.data[set.col] = coerce(col, this.eval(set.expr, env, null));
      }
      this.indexAdd(table.name, row);
      this.emit(table.name, "UPDATE", before, row.data);
      n += 1;
    }
    return { ...blank(`updated ${n}`), affected: n, plan: [{ op: "update", detail: table.name, rows: n }] };
  }

  private delete(stmt: Extract<Stmt, { k: "delete" }>): ExecResult {
    this.need("write");
    const table = this.requireTable(stmt.table);
    const keep: Row[] = [];
    let n = 0;
    for (const row of table.rows) {
      const env = this.envOf(table.name, table.name, row);
      if (stmt.where && !truthy(this.eval(stmt.where, env, null))) {
        keep.push(row);
        continue;
      }
      if (!stmt.where && stmt.where !== undefined) keep.push(row);
      this.indexRemove(table.name, row);
      this.emit(table.name, "DELETE", row.data, null);
      n += 1;
    }
    if (!stmt.where) {
      /* all rows matched */
    }
    table.rows = stmt.where ? keep : [];
    if (!stmt.where) {
      /* already counted */
    }
    return { ...blank(`deleted ${n}`), affected: n, plan: [{ op: "delete", detail: table.name, rows: n }] };
  }

  private select(stmt: Extract<Stmt, { k: "select" }>): ExecResult {
    const plan: PlanStep[] = [];
    let envs = this.scan(stmt, plan);
    if (stmt.where) {
      envs = envs.filter((env) => truthy(this.eval(stmt.where as Expr, env, null)));
      plan.push({ op: "filter", detail: "where", rows: envs.length });
    }
    const items = stmt.items;
    const hasAgg = items !== "*" && items.some((item) => containsAgg(item.expr));
    type Out = { env: Env; bucket: Env[] | null; names: string[]; values: Val[] };
    let projected: Out[];
    if (hasAgg || stmt.group.length) {
      if (items === "*") throw new DbError("SELECT * cannot be grouped");
      if (hasAgg && !stmt.group.length) {
        for (const item of items) {
          if (nakedCols(item.expr)) throw new DbError("mix of aggregated and bare columns needs GROUP BY");
        }
      }
      const buckets = new Map<string, Env[]>();
      for (const env of envs) {
        const key = stmt.group.length
          ? stmt.group.map((expr) => JSON.stringify(this.eval(expr, env, null))).join("\u0001")
          : "*";
        const list = buckets.get(key) ?? [];
        list.push(env);
        buckets.set(key, list);
      }
      projected = [...buckets.values()].map((bucket) => ({
        env: bucket[0],
        bucket,
        names: items.map((item, i) => item.alias ?? exprLabel(item.expr, i)),
        values: items.map((item) => this.eval(item.expr, bucket[0], bucket)),
      }));
      plan.push({ op: "aggregate", detail: `${projected.length} groups`, rows: projected.length });
    } else {
      projected = envs.map((env) => {
        if (items === "*") {
          const names: string[] = [];
          const values: Val[] = [];
          const seen = new Set<Record<string, Val>>();
          const aliases = Object.keys(env.by);
          for (const alias of aliases) {
            const rec = env.by[alias];
            if (seen.has(rec)) continue;
            seen.add(rec);
            const prefix = new Set(aliases.map((name) => env.by[name])).size > 1 ? `${alias}.` : "";
            for (const [key, value] of Object.entries(rec)) {
              if (key.startsWith("__")) continue;
              names.push(prefix + key);
              values.push(value);
            }
          }
          return { env, bucket: null, names, values };
        }
        return {
          env,
          bucket: null,
          names: items.map((item, i) => item.alias ?? exprLabel(item.expr, i)),
          values: items.map((item) => this.eval(item.expr, env, null)),
        };
      });
      plan.push({ op: "project", detail: "select list", rows: projected.length });
    }
    if (stmt.distinct) {
      const uniq = new Map<string, Out>();
      for (const row of projected) uniq.set(JSON.stringify(row.values), row);
      projected = [...uniq.values()];
      plan.push({ op: "distinct", detail: "hash", rows: projected.length });
    }
    if (stmt.order.length) {
      projected.sort((a, b) => {
        for (const key of stmt.order) {
          const av = this.orderValue(key.expr, a);
          const bv = this.orderValue(key.expr, b);
          const cmp = compare(av, bv);
          if (cmp !== 0) return key.dir === "desc" ? -cmp : cmp;
        }
        return 0;
      });
      plan.push({ op: "sort", detail: stmt.order.map((key) => key.dir).join(", "), rows: projected.length });
    }
    const offset = stmt.offset ?? 0;
    const requested = stmt.limit ?? MAX_ROWS;
    const limit = Math.min(requested, MAX_ROWS);
    const window = projected.slice(offset, offset + limit);
    const truncated = requested > window.length && requested > MAX_ROWS || (stmt.limit == null && projected.length - offset > window.length);
    if (stmt.limit != null || offset) plan.push({ op: "limit", detail: String(limit), rows: window.length });
    const names = window[0]?.names ?? (items === "*" ? [] : items.map((item, i) => item.alias ?? exprLabel(item.expr, i)));
    return {
      ...blank(truncated ? `truncated to ${MAX_ROWS} rows` : ""),
      columns: names.map((name) => ({ name })),
      rows: window.map((row) => row.values),
      plan,
      truncated,
    };
  }

  private hybrid(stmt: Extract<Stmt, { k: "hybrid" }>): ExecResult {
    const table = this.requireTable(stmt.table);
    const vectorCol = requireCol(table, stmt.vector);
    if (vectorCol.type !== "VECTOR") throw new DbError(`${stmt.vector} is not VECTOR`);
    for (const name of stmt.text) requireCol(table, name);
    let rows = table.rows;
    const plan: PlanStep[] = [{ op: "seq scan", detail: table.name, rows: rows.length }];
    if (stmt.where) {
      rows = rows.filter((row) => truthy(this.eval(stmt.where as Expr, this.envOf(table.name, table.name, row), null)));
      plan.push({ op: "filter", detail: "where pushdown", rows: rows.length });
    }
    const qv = embedText(stmt.query, vectorCol.dim ?? DIM);
    const metric = this.hnswOf(table.name, stmt.vector)?.def.metric ?? "cosine";
    const byVector = rows
      .filter((row) => Array.isArray(row.data[stmt.vector]))
      .map((row) => ({ row, dist: distance(qv, row.data[stmt.vector] as number[], metric) }))
      .sort((a, b) => a.dist - b.dist);
    const byText = rows
      .map((row) => ({
        row,
        score: Math.max(...stmt.text.map((col) => this.scoreBm(table.name, col, stmt.query, row.__id)), 0),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
    plan.push({ op: "vector rank", detail: metric, rows: byVector.length });
    plan.push({ op: "bm25 rank", detail: stmt.text.join(", "), rows: byText.length });
    const fused = new Map<number, { row: Row; rrf: number; vr: number | null; tr: number | null }>();
    byVector.forEach((hit, i) => {
      const rec = fused.get(hit.row.__id) ?? { row: hit.row, rrf: 0, vr: null, tr: null };
      rec.vr = i + 1;
      rec.rrf += 1 / (60 + i + 1);
      fused.set(hit.row.__id, rec);
    });
    byText.forEach((hit, i) => {
      const rec = fused.get(hit.row.__id) ?? { row: hit.row, rrf: 0, vr: null, tr: null };
      rec.tr = i + 1;
      rec.rrf += 1 / (60 + i + 1);
      fused.set(hit.row.__id, rec);
    });
    const ranked = [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, stmt.limit);
    plan.push({ op: "rrf fuse", detail: "k=60", rows: ranked.length });
    return {
      ...blank(""),
      columns: [
        { name: "id" },
        { name: "title" },
        { name: "category" },
        { name: "rrf" },
        { name: "vector_rank" },
        { name: "text_rank" },
        { name: "body" },
      ],
      rows: ranked.map((rec) => [
        rec.row.__id,
        rec.row.data.title ?? null,
        rec.row.data.category ?? null,
        round4(rec.rrf),
        rec.vr,
        rec.tr,
        rec.row.data.body ?? null,
      ]),
      plan,
    };
  }

  private memoryStore(stmt: Extract<Stmt, { k: "memory_store" }>): ExecResult & { canonical: string } {
    this.need("write");
    const at = stmt.at ?? Date.now();
    const importance = stmt.importance ?? 0.5;
    const session = stmt.session ?? this.session;
    const ttl = stmt.ttl ?? 0;
    this.memories = this.memories.filter((memory) => !(memory.key === stmt.key && memory.session === session));
    this.memories.push({
      key: stmt.key,
      value: stmt.value,
      embedding: embedText(`${stmt.key} ${stmt.value}`, DIM),
      metadata: {},
      importance,
      expiresAt: ttl > 0 ? at + ttl * 1000 : null,
      session,
      createdAt: at,
    });
    const canonical = `MEMORY STORE ${sqlQuote(stmt.key)} VALUE ${sqlQuote(stmt.value)} IMPORTANCE ${importance} TTL ${ttl} SESSION ${sqlQuote(session)} AT ${at}`;
    return { ...blank(`stored memory ${stmt.key}`), affected: 1, canonical };
  }

  private memoryRecall(stmt: Extract<Stmt, { k: "memory_recall" }>): ExecResult {
    const nowMs = stmt.query ? Date.now() : Date.now();
    const qv = embedText(stmt.query, DIM);
    const rows = this.memories
      .filter((memory) => !stmt.session || memory.session === stmt.session)
      .map((memory) => {
        const decay = decayOf(memory, nowMs);
        const score = similarity(qv, memory.embedding) * (0.25 + 0.75 * memory.importance) * decay;
        return { memory, decay, score };
      })
      .filter((hit) => hit.decay > 0 && hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, stmt.limit);
    return {
      ...blank(""),
      columns: [
        { name: "key" },
        { name: "value" },
        { name: "score" },
        { name: "importance" },
        { name: "decay" },
        { name: "session" },
      ],
      rows: rows.map((hit) => [
        hit.memory.key,
        hit.memory.value,
        round4(hit.score),
        hit.memory.importance,
        round4(hit.decay),
        hit.memory.session,
      ]),
      plan: [{ op: "memory recall", detail: "cosine × importance × decay", rows: rows.length }],
    };
  }

  private memoryForget(stmt: Extract<Stmt, { k: "memory_forget" }>): ExecResult {
    this.need("write");
    const before = this.memories.length;
    this.memories = this.memories.filter((memory) => memory.key !== stmt.key);
    return { ...blank(`forgot ${before - this.memories.length}`), affected: before - this.memories.length };
  }

  private memoryList(stmt: Extract<Stmt, { k: "memory_list" }>): ExecResult {
    const rows = this.listMemories(stmt.session).slice(0, stmt.limit);
    return {
      ...blank(""),
      columns: [
        { name: "key" },
        { name: "value" },
        { name: "importance" },
        { name: "decay" },
        { name: "weight" },
        { name: "session" },
      ],
      rows: rows.map((memory) => [
        memory.key,
        memory.value,
        memory.importance,
        round4(memory.decay),
        round4(memory.weight),
        memory.session,
      ]),
      plan: [{ op: "memory list", detail: stmt.session ?? "all sessions", rows: rows.length }],
    };
  }

  private show(stmt: Extract<Stmt, { k: "show" }>): ExecResult {
    if (stmt.what === "tables") {
      const tables = [...this.tables.values()];
      return {
        ...blank(""),
        columns: [{ name: "name" }, { name: "columns" }, { name: "rows" }],
        rows: tables.map((table) => [table.name, table.cols.length, table.rows.length]),
        plan: [{ op: "catalog", detail: "tables", rows: tables.length }],
      };
    }
    if (stmt.what === "indexes") {
      const indexes = [...this.indexes.values()];
      return {
        ...blank(""),
        columns: [{ name: "name" }, { name: "table" }, { name: "kind" }, { name: "columns" }],
        rows: indexes.map((idx) => [idx.def.name, idx.def.table, idx.def.kind, idx.def.columns.join(", ")]),
        plan: [{ op: "catalog", detail: "indexes", rows: indexes.length }],
      };
    }
    if (stmt.what === "streams") {
      return {
        ...blank(""),
        columns: [{ name: "name" }, { name: "table" }],
        rows: this.streams.map((stream) => [stream.name, stream.table]),
        plan: [{ op: "catalog", detail: "streams", rows: this.streams.length }],
      };
    }
    if (stmt.what === "events") {
      const events = this.cdc.slice(-50).reverse();
      return {
        ...blank(""),
        columns: [{ name: "id" }, { name: "stream" }, { name: "op" }, { name: "table" }, { name: "summary" }],
        rows: events.map((event) => [event.id, event.stream, event.op, event.table, eventSummary(event)]),
        plan: [{ op: "cdc", detail: "recent", rows: events.length }],
      };
    }
    const table = this.requireTable(stmt.name ?? "");
    return {
      ...blank(""),
      columns: [{ name: "ddl" }],
      rows: [[ddlOf(table)]],
      plan: [{ op: "catalog", detail: table.name, rows: 1 }],
    };
  }

  private vacuum(): ExecResult {
    this.need("admin");
    const nowMs = Date.now();
    const before = this.memories.length;
    this.memories = this.memories.filter((memory) => decayOf(memory, nowMs) > 0);
    if (this.cdc.length > 200) this.cdc = this.cdc.slice(-200);
    for (const table of this.tables.values()) {
      for (const idx of this.indexes.values()) {
        if (idx.def.table === table.name) this.indexes.set(idx.def.name, this.buildIndex(idx.def, table));
      }
    }
    this.checkpoint();
    return {
      ...blank("vacuum"),
      message: "vacuum",
      affected: before - this.memories.length,
      plan: [{ op: "vacuum", detail: "rebuild indexes, drop expired memory, checkpoint", rows: this.tables.size }],
    };
  }

  private check(): ExecResult {
    const issues: string[] = [];
    for (const table of this.tables.values()) {
      const ids = new Set<number>();
      for (const row of table.rows) {
        if (ids.has(row.__id)) issues.push(`${table.name}: duplicate id ${row.__id}`);
        ids.add(row.__id);
        for (const col of table.cols) {
          if (col.type === "VECTOR" && Array.isArray(row.data[col.name])) {
            const vec = row.data[col.name] as Val[];
            if (col.dim && vec.length !== col.dim) issues.push(`${table.name}.${col.name} row ${row.__id} dim ${vec.length}`);
          }
          if (col.primary && row.data[col.name] == null) issues.push(`${table.name}.${col.name} null primary key`);
        }
      }
      for (const idx of this.indexes.values()) {
        if (idx.def.table !== table.name) continue;
        if (idx.kind === "btree") {
          for (const entry of idx.entries) {
            if (!ids.has(entry.id)) issues.push(`index ${idx.def.name} dangling id ${entry.id}`);
          }
        }
        if (idx.kind === "bm25" && idx.bm.docs > table.rows.length) {
          issues.push(`index ${idx.def.name} has more docs than rows`);
        }
      }
    }
    return {
      ...blank(issues.length ? `${issues.length} issues` : "integrity ok"),
      columns: [{ name: "status" }, { name: "detail" }],
      rows: issues.length ? issues.map((issue) => ["issue", issue]) : [["ok", "indexes, keys, and vector dims check out"]],
      plan: [{ op: "integrity", detail: "catalog", rows: issues.length }],
    };
  }

  private begin(): ExecResult {
    this.need("write");
    if (this.txn) throw new DbError("transaction already open");
    this.txn = this.capture();
    this.txnWal = [];
    return blank("begin");
  }

  private commit(): ExecResult {
    this.need("write");
    if (!this.txn) throw new DbError("no transaction");
    for (const sql of this.txnWal) this.wal.push({ lsn: ++this.lsn, sql, ts: Date.now() });
    this.txn = null;
    this.txnWal = [];
    this.cache.clear();
    this.persist();
    return { ...blank(`commit`), affected: 0 };
  }

  private rollback(): ExecResult {
    this.need("write");
    if (!this.txn) throw new DbError("no transaction");
    this.restore(this.txn);
    this.txn = null;
    this.txnWal = [];
    return blank("rollback");
  }

  checkpoint(): void {
    this.base = this.capture();
    this.wal = [];
    this.checkpointLsn = this.lsn;
    this.persist();
  }

  private scan(stmt: Extract<Stmt, { k: "select" }>, plan: PlanStep[]): Env[] {
    if (!stmt.from) {
      plan.push({ op: "constant", detail: "no from", rows: 1 });
      return [blankEnv()];
    }
    const table = this.requireTable(stmt.from.name);
    const alias = stmt.from.alias ?? table.name;
    let rows = table.rows;
    let usedIndex = false;
    if (!stmt.joins.length && stmt.where) {
      const parts = conjuncts(stmt.where);
      if (parts) {
        for (const part of parts) {
          const eq = equality(part);
          if (!eq) continue;
          const col = columnOf(eq.name, table.name, alias);
          if (!col) continue;
          const idx = this.btreeOf(table.name, col);
          if (!idx) continue;
          const ids = idx.entries.filter((entry) => entry.key === keyOf(eq.value)).map((entry) => entry.id);
          const byId = new Map(table.rows.map((row) => [row.__id, row]));
          rows = ids.map((id) => byId.get(id)).filter((row): row is Row => row != null);
          plan.push({ op: "btree seek", detail: `${idx.def.name} ${col}=${preview(eq.value)}`, rows: rows.length });
          usedIndex = true;
          break;
        }
      }
    }
    if (!usedIndex) plan.push({ op: "seq scan", detail: table.name, rows: rows.length });
    let envs = rows.map((row) => this.envOf(table.name, alias, row));
    for (const join of stmt.joins) {
      const right = this.requireTable(join.name);
      const ralias = join.alias ?? right.name;
      const spec = joinEq(join.on);
      const rightSide = spec ? sideOf(spec, ralias, right.name) : null;
      if (spec && rightSide) {
        const buildExpr = rightSide === "r" ? spec.r : spec.l;
        const probeExpr = rightSide === "r" ? spec.l : spec.r;
        const buckets = new Map<string, Row[]>();
        for (const row of right.rows) {
          const key = JSON.stringify(this.eval({ k: "name", parts: buildExpr }, this.envOf(right.name, ralias, row), null));
          const list = buckets.get(key) ?? [];
          list.push(row);
          buckets.set(key, list);
        }
        const joined: Env[] = [];
        for (const left of envs) {
          const key = JSON.stringify(this.eval({ k: "name", parts: probeExpr }, left, null));
          for (const row of buckets.get(key) ?? []) joined.push(this.merge(left, this.envOf(right.name, ralias, row)));
        }
        plan.push({ op: "hash join", detail: `${alias} = ${ralias}`, rows: joined.length });
        envs = joined;
        continue;
      }
      const joined: Env[] = [];
      for (const left of envs) {
        for (const row of right.rows) {
          const env = this.merge(left, this.envOf(right.name, ralias, row));
          if (truthy(this.eval(join.on, env, null))) joined.push(env);
        }
      }
      plan.push({ op: "nested loop join", detail: `${alias} ⋈ ${ralias}`, rows: joined.length });
      envs = joined;
    }
    return envs;
  }

  private orderValue(expr: Expr, row: { env: Env; bucket: Env[] | null; names: string[]; values: Val[] }): Val {
    if (expr.k === "name" && expr.parts.length === 1) {
      const idx = row.names.indexOf(expr.parts[0]);
      if (idx >= 0) return row.values[idx];
    }
    return this.eval(expr, row.env, row.bucket);
  }

  private eval(expr: Expr, env: Env, bucket: Env[] | null): Val {
    switch (expr.k) {
      case "num":
      case "str":
      case "bool":
      case "vec":
        return expr.v;
      case "null":
      case "star":
        return null;
      case "name":
        return lookup(env, expr.parts);
      case "unary": {
        const value = this.eval(expr.x, env, bucket);
        if (expr.op === "-") return typeof value === "number" ? -value : null;
        if (value == null) return null;
        return !truthy(value);
      }
      case "bin": {
        if (expr.op === "and" || expr.op === "or") return logic(expr.op, this.eval(expr.l, env, bucket), this.eval(expr.r, env, bucket));
        const l = this.eval(expr.l, env, bucket);
        const r = this.eval(expr.r, env, bucket);
        if (expr.op === "+" || expr.op === "-" || expr.op === "*" || expr.op === "/") {
          if (typeof l !== "number" || typeof r !== "number") return null;
          if (expr.op === "+") return l + r;
          if (expr.op === "-") return l - r;
          if (expr.op === "*") return l * r;
          return r === 0 ? null : l / r;
        }
        if (l == null || r == null) return null;
        if (expr.op === "=") return same(l, r);
        if (expr.op === "!=" || expr.op === "<>") return !same(l, r);
        const cmp = compare(l, r);
        if (expr.op === "<") return cmp < 0;
        if (expr.op === ">") return cmp > 0;
        if (expr.op === "<=") return cmp <= 0;
        if (expr.op === ">=") return cmp >= 0;
        return null;
      }
      case "like": {
        const value = this.eval(expr.x, env, bucket);
        const pat = this.eval(expr.pat, env, bucket);
        if (typeof value !== "string" || typeof pat !== "string") return null;
        const hit = likeMatch(value, pat);
        return expr.not ? !hit : hit;
      }
      case "in": {
        const value = this.eval(expr.x, env, bucket);
        if (value == null) return null;
        const hit = expr.list.some((item) => same(value, this.eval(item, env, bucket)));
        return expr.not ? !hit : hit;
      }
      case "is": {
        const value = this.eval(expr.x, env, bucket);
        const hit = value == null;
        return expr.not ? !hit : hit;
      }
      case "call":
        return this.call(expr.name, expr.args, env, bucket);
      default:
        return null;
    }
  }

  private call(name: string, args: Expr[], env: Env, bucket: Env[] | null): Val {
    if (AGG.has(name)) {
      if (!bucket) throw new DbError(`${name}() outside an aggregate query`);
      if (name === "count") {
        if (!args.length || args[0].k === "star") return bucket.length;
        return bucket.filter((row) => this.eval(args[0], row, null) != null).length;
      }
      const nums = bucket
        .map((row) => this.eval(args[0], row, null))
        .filter((value): value is number => typeof value === "number");
      if (!nums.length) return null;
      if (name === "sum") return nums.reduce((a, b) => a + b, 0);
      if (name === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
      if (name === "min") return Math.min(...nums);
      return Math.max(...nums);
    }
    const values = args.map((arg) => this.eval(arg, env, bucket));
    if (name === "embed") {
      const text = String(values[0] ?? "");
      const dim = typeof values[1] === "number" ? values[1] : DIM;
      return embedText(text, dim);
    }
    if (name === "vector_distance" || name === "l2_distance" || name === "cosine_distance") {
      const metric: Metric =
        name === "l2_distance" ? "l2" : name === "cosine_distance" ? "cosine" : metricArg(values[2]) ?? "cosine";
      return distance(asVec(values[0]), asVec(values[1]), metric);
    }
    if (name === "dot_product") {
      const a = asVec(values[0]);
      const b = asVec(values[1]);
      let dot = 0;
      for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
      return dot;
    }
    if (name === "bm25") {
      if (args[0].k !== "name") throw new DbError("bm25() first argument must be a column");
      const col = args[0].parts[args[0].parts.length - 1];
      const query = String(values[1] ?? "");
      return this.scoreBm(env.table, col, query, env.id);
    }
    if (name === "lower") return String(values[0] ?? "").toLowerCase();
    if (name === "upper") return String(values[0] ?? "").toUpperCase();
    if (name === "length") return String(values[0] ?? "").length;
    if (name === "abs") return typeof values[0] === "number" ? Math.abs(values[0]) : null;
    if (name === "round") return typeof values[0] === "number" ? Math.round(values[0]) : null;
    if (name === "coalesce") return values.find((value) => value != null) ?? null;
    if (name === "json") {
      if (typeof values[0] !== "string") throw new DbError("json() expects a string");
      try {
        return JSON.parse(values[0]) as Val;
      } catch {
        throw new DbError("json() value is not valid JSON");
      }
    }
    if (name === "json_extract") return jsonWalk(values[0], String(values[1] ?? ""));
    if (name === "typeof") return values[0] == null ? "null" : Array.isArray(values[0]) ? "vector" : typeof values[0];
    throw new DbError(`unknown function ${name}`);
  }

  private scoreBm(table: string, col: string, query: string, id: number): number {
    const key = `${table}\0${col}\0${query}`;
    let scores = this.bmCache.get(key);
    if (!scores) {
      scores = new Map();
      const live = this.bm25Of(table, col);
      const rows = this.requireTable(table).rows;
      if (live) {
        for (const row of rows) scores.set(row.__id, live.bm.score(row.__id, query));
      } else {
        const tmp = new Bm25Index();
        for (const row of rows) tmp.add(row.__id, stringify(row.data[col]));
        for (const row of rows) scores.set(row.__id, tmp.score(row.__id, query));
      }
      this.bmCache.set(key, scores);
    }
    return scores.get(id) ?? 0;
  }

  private emit(tableName: string, op: CdcEvent["op"], before: Record<string, Val> | null, after: Record<string, Val> | null): void {
    const table = this.tables.get(tableName);
    if (!table) return;
    for (const stream of this.streams) {
      if (stream.table !== tableName) continue;
      this.cdc.push({
        id: ++this.cdcSeq,
        stream: stream.name,
        table: tableName,
        op,
        before: before ? hideVectors(table, before) : null,
        after: after ? hideVectors(table, after) : null,
        ts: Date.now(),
      });
    }
    if (this.cdc.length > 300) this.cdc.splice(0, this.cdc.length - 300);
  }

  private indexAdd(tableName: string, row: Row): void {
    for (const idx of this.indexes.values()) {
      if (idx.def.table !== tableName) continue;
      if (idx.kind === "btree") idx.entries.push({ key: composite(row, idx.def.columns), id: row.__id });
      else if (idx.kind === "hnsw") {
        const value = row.data[idx.def.columns[0]];
        if (Array.isArray(value) && value.every((n) => typeof n === "number")) idx.hnsw.add(row.__id, value as number[]);
      } else idx.bm.add(row.__id, idx.def.columns.map((col) => stringify(row.data[col])).join("\n"));
    }
    for (const idx of this.indexes.values()) {
      if (idx.kind === "btree" && idx.def.table === tableName) idx.entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id - b.id));
    }
  }

  private indexRemove(tableName: string, row: Row): void {
    for (const idx of this.indexes.values()) {
      if (idx.def.table !== tableName) continue;
      if (idx.kind === "btree") idx.entries = idx.entries.filter((entry) => entry.id !== row.__id);
      else if (idx.kind === "hnsw") idx.hnsw.remove(row.__id);
      else idx.bm.remove(row.__id);
    }
  }

  private buildIndex(def: IndexDef, table: Table): Live {
    if (def.kind === "hnsw") {
      const hnsw = new HnswIndex(def.metric ?? "cosine");
      for (const row of table.rows) {
        const value = row.data[def.columns[0]];
        if (Array.isArray(value) && value.every((n) => typeof n === "number")) hnsw.add(row.__id, value as number[]);
      }
      return { kind: "hnsw", def, hnsw };
    }
    if (def.kind === "bm25") {
      const bm = new Bm25Index();
      for (const row of table.rows) bm.add(row.__id, def.columns.map((col) => stringify(row.data[col])).join("\n"));
      return { kind: "bm25", def, bm };
    }
    const entries = table.rows
      .map((row) => ({ key: composite(row, def.columns), id: row.__id }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id - b.id));
    return { kind: "btree", def, entries };
  }

  private btreeOf(table: string, col: string): Extract<Live, { kind: "btree" }> | undefined {
    for (const idx of this.indexes.values()) {
      if (idx.kind === "btree" && idx.def.table === table && idx.def.columns[0] === col) return idx;
    }
    return undefined;
  }

  private hnswOf(table: string, col: string): Extract<Live, { kind: "hnsw" }> | undefined {
    for (const idx of this.indexes.values()) {
      if (idx.kind === "hnsw" && idx.def.table === table && idx.def.columns[0] === col) return idx;
    }
    return undefined;
  }

  private bm25Of(table: string, col: string): Extract<Live, { kind: "bm25" }> | undefined {
    for (const idx of this.indexes.values()) {
      if (idx.kind === "bm25" && idx.def.table === table && idx.def.columns.includes(col)) return idx;
    }
    return undefined;
  }

  private envOf(table: string, alias: string, row: Row): Env {
    const by: Record<string, Record<string, Val>> = { [table]: row.data };
    if (alias !== table) by[alias] = row.data;
    return { by, id: row.__id, table };
  }

  private merge(left: Env, right: Env): Env {
    return { by: { ...left.by, ...right.by }, id: left.id, table: left.table };
  }

  private requireTable(name: string): Table {
    const table = this.tables.get(name);
    if (!table) throw new DbError(`no table ${name}`);
    return table;
  }

  private need(role: Role): void {
    const rank: Record<Role, number> = { read: 0, write: 1, admin: 2 };
    if (rank[this.role] < rank[role]) throw new DbError(`role ${this.role} cannot do that (needs ${role})`);
  }

  private capture(): DataState {
    return {
      tables: [...this.tables.values()].map((table) => ({
        name: table.name,
        cols: table.cols.map((col) => ({ ...col })),
        rows: table.rows.map((row) => ({ __id: row.__id, data: clone(row.data) })),
        nextId: table.nextId,
      })),
      indexes: [...this.indexes.values()].map((idx) => ({ ...idx.def, columns: [...idx.def.columns] })),
      streams: this.streams.map((stream) => ({ ...stream })),
      memories: this.memories.map((memory) => ({ ...memory, embedding: [...memory.embedding], metadata: clone(memory.metadata) })),
      cdc: this.cdc.map((event) => clone(event)),
      cdcSeq: this.cdcSeq,
      session: this.session,
    };
  }

  private restore(data: DataState): void {
    this.tables = new Map(
      data.tables.map((table) => [
        table.name,
        {
          name: table.name,
          cols: table.cols.map((col) => ({ ...col })),
          rows: table.rows.map((row) => ({ __id: row.__id, data: clone(row.data) })),
          nextId: table.nextId,
        },
      ]),
    );
    this.streams = data.streams.map((stream) => ({ ...stream }));
    this.memories = data.memories.map((memory) => ({ ...memory, embedding: [...memory.embedding], metadata: clone(memory.metadata) }));
    this.cdc = data.cdc.map((event) => clone(event));
    this.cdcSeq = data.cdcSeq;
    this.session = data.session;
    this.indexes = new Map();
    for (const def of data.indexes) {
      const table = this.tables.get(def.table);
      if (!table) continue;
      this.indexes.set(def.name, this.buildIndex(def, table));
    }
  }

  private persist(): void {
    if (!this.durable) return;
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toSnapshot()));
    } catch {
      /* quota or private mode: the open file stays in memory */
    }
  }
}

function emptyData(): DataState {
  return { tables: [], indexes: [], streams: [], memories: [], cdc: [], cdcSeq: 0, session: "default" };
}

function blank(message: string): ExecResult {
  return { ok: true, ms: 0, columns: [], rows: [], affected: 0, message, plan: [] };
}

function done(result: ExecResult, started: number): ExecResult {
  return { ...result, ms: now() - started };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function blankEnv(): Env {
  return { by: {}, id: 0, table: "" };
}

function requireCol(table: Table, name: string): Col {
  const col = table.cols.find((item) => item.name === name);
  if (!col) throw new DbError(`no column ${table.name}.${name}`);
  return col;
}

function coerce(col: Col, value: Val): Val {
  if (value == null) return null;
  if (col.type === "INTEGER") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) throw new DbError(`${col.name} expects INTEGER`);
    return Math.trunc(n);
  }
  if (col.type === "REAL") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) throw new DbError(`${col.name} expects REAL`);
    return n;
  }
  if (col.type === "BOOLEAN") {
    if (typeof value === "boolean") return value;
    throw new DbError(`${col.name} expects BOOLEAN`);
  }
  if (col.type === "TEXT" || col.type === "TIMESTAMP") {
    if (typeof value === "string" || typeof value === "number") return String(value);
    throw new DbError(`${col.name} expects TEXT`);
  }
  if (col.type === "JSON") {
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as Val;
      } catch {
        return value;
      }
    }
    return value;
  }
  if (col.type === "VECTOR") {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "number")) throw new DbError(`${col.name} expects VECTOR`);
    if (col.dim && value.length !== col.dim) throw new DbError(`${col.name} expects VECTOR(${col.dim}), got ${value.length}`);
    return value;
  }
  return value;
}

function ddlOf(table: Table): string {
  const cols = table.cols
    .map((col) => {
      const type = col.type === "VECTOR" ? `VECTOR(${col.dim ?? DIM})` : col.type;
      return `  ${col.name} ${type}${col.primary ? " PRIMARY KEY" : ""}`;
    })
    .join(",\n");
  return `CREATE TABLE ${table.name} (\n${cols}\n);`;
}

function hideVectors(table: Table, data: Record<string, Val>): Record<string, Val> {
  const out: Record<string, Val> = {};
  for (const col of table.cols) {
    const value = data[col.name];
    out[col.name] = col.type === "VECTOR" && Array.isArray(value) ? `vector(${value.length})` : value ?? null;
  }
  return out;
}

function lookup(env: Env, parts: string[]): Val {
  if (!parts.length) return null;
  if (parts.length >= 2 && env.by[parts[0]]) {
    const base = env.by[parts[0]][parts[1]] ?? null;
    return parts.length === 2 ? base : jsonWalk(base, parts.slice(2).join("."));
  }
  if (parts.length === 1) {
    const seen = new Set<Record<string, Val>>();
    const hits: Val[] = [];
    for (const rec of Object.values(env.by)) {
      if (seen.has(rec)) continue;
      seen.add(rec);
      if (Object.prototype.hasOwnProperty.call(rec, parts[0])) hits.push(rec[parts[0]]);
    }
    if (hits.length > 1) throw new DbError(`ambiguous column ${parts[0]}`);
    if (hits.length === 1) return hits[0];
    throw new DbError(`unknown column ${parts[0]}`);
  }
  const base = lookup(env, [parts[0]]);
  return jsonWalk(base, parts.slice(1).join("."));
}

function jsonWalk(value: Val, path: string): Val {
  let rest = path.startsWith("$") ? path.slice(1) : path;
  if (rest.startsWith(".")) rest = rest.slice(1);
  if (!rest) return value;
  let cur = value;
  for (const part of rest.split(".")) {
    if (cur == null || typeof cur !== "object" || Array.isArray(cur)) return null;
    cur = (cur as Record<string, Val>)[part] ?? null;
  }
  return cur;
}

function truthy(value: Val): boolean {
  return value !== null && value !== false && value !== 0 && value !== "";
}

function logic(op: "and" | "or", left: Val, right: Val): Val {
  if (op === "or") {
    if (left === true || right === true) return true;
    if (left === false && right === false) return false;
    return null;
  }
  if (left === false || right === false) return false;
  if (left === true && right === true) return true;
  return null;
}

function same(a: Val, b: Val): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "number" && typeof b === "string" && b.trim() !== "" && Number(b) === a) return true;
  if (typeof b === "number" && typeof a === "string" && a.trim() !== "" && Number(a) === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(a: Val, b: Val): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = typeof a === "string" ? a : JSON.stringify(a);
  const bs = typeof b === "string" ? b : JSON.stringify(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function containsAgg(expr: Expr): boolean {
  if (expr.k === "call" && AGG.has(expr.name)) return true;
  if (expr.k === "unary") return containsAgg(expr.x);
  if (expr.k === "bin") return containsAgg(expr.l) || containsAgg(expr.r);
  if (expr.k === "call") return expr.args.some(containsAgg);
  if (expr.k === "in") return containsAgg(expr.x) || expr.list.some(containsAgg);
  if (expr.k === "like" || expr.k === "is") return containsAgg(expr.k === "is" ? expr.x : expr.x) || (expr.k === "like" && containsAgg(expr.pat));
  return false;
}

function nakedCols(expr: Expr, inside = false): boolean {
  if (expr.k === "call" && AGG.has(expr.name)) return expr.args.some((arg) => nakedCols(arg, true));
  if (expr.k === "name") return !inside;
  if (expr.k === "unary") return nakedCols(expr.x, inside);
  if (expr.k === "bin") return nakedCols(expr.l, inside) || nakedCols(expr.r, inside);
  if (expr.k === "call") return expr.args.some((arg) => nakedCols(arg, inside));
  if (expr.k === "in") return nakedCols(expr.x, inside) || expr.list.some((arg) => nakedCols(arg, inside));
  if (expr.k === "like") return nakedCols(expr.x, inside) || nakedCols(expr.pat, inside);
  if (expr.k === "is") return nakedCols(expr.x, inside);
  return false;
}

function exprLabel(expr: Expr, index: number): string {
  if (expr.k === "name") return expr.parts[expr.parts.length - 1];
  if (expr.k === "call") return expr.name;
  return `col${index + 1}`;
}

function conjuncts(expr: Expr): Expr[] | null {
  if (expr.k === "bin" && expr.op === "or") return null;
  if (expr.k === "bin" && expr.op === "and") {
    const left = conjuncts(expr.l);
    const right = conjuncts(expr.r);
    if (!left || !right) return null;
    return [...left, ...right];
  }
  return [expr];
}

function equality(expr: Expr): { name: string[]; value: Val } | null {
  if (expr.k !== "bin" || expr.op !== "=") return null;
  const right = literalOf(expr.r);
  if (expr.l.k === "name" && right) return { name: expr.l.parts, value: right.value };
  const left = literalOf(expr.l);
  if (expr.r.k === "name" && left) return { name: expr.r.parts, value: left.value };
  return null;
}

function literalOf(expr: Expr): { value: Val } | null {
  if (expr.k === "num" || expr.k === "str" || expr.k === "bool") return { value: expr.v };
  if (expr.k === "null") return { value: null };
  return null;
}

function columnOf(parts: string[], table: string, alias: string): string | null {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2 && (parts[0] === table || parts[0] === alias)) return parts[1];
  return null;
}

function joinEq(expr: Expr): { l: string[]; r: string[] } | null {
  if (expr.k !== "bin" || expr.op !== "=" || expr.l.k !== "name" || expr.r.k !== "name") return null;
  return { l: expr.l.parts, r: expr.r.parts };
}

function sideOf(spec: { l: string[]; r: string[] }, alias: string, table: string): "l" | "r" | null {
  const hit = (parts: string[]) => parts[0] === alias || parts[0] === table;
  if (hit(spec.r) && !hit(spec.l)) return "r";
  if (hit(spec.l) && !hit(spec.r)) return "l";
  return null;
}

function keyOf(value: Val): string {
  if (value == null) return "0";
  if (typeof value === "number") return `1${value.toFixed(6).padStart(24, "0")}`;
  if (typeof value === "boolean") return value ? "2t" : "2f";
  if (typeof value === "string") return `3${value}`;
  return `4${JSON.stringify(value)}`;
}

function composite(row: Row, cols: string[]): string {
  return cols.map((col) => keyOf(row.data[col] ?? null)).join("\u0001");
}

function stringify(value: Val): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function asVec(value: Val): number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number")) throw new DbError("expected a vector");
  return value as number[];
}

function metricArg(value: Val): Metric | null {
  if (value === "cosine" || value === "l2" || value === "dot" || value === "hamming") return value;
  return null;
}

function decayOf(memory: Memory, nowMs: number): number {
  if (memory.expiresAt != null && nowMs > memory.expiresAt) return 0;
  const half = 1000 * 60 * 60 * 24 * 14;
  return Math.exp(-(nowMs - memory.createdAt) / half);
}

function eventSummary(event: CdcEvent): string {
  const row = event.after ?? event.before;
  if (!row) return event.op;
  const title = row.title ?? row.name ?? row.key;
  return title != null ? `${event.op} ${String(title)}` : event.op;
}

function preview(value: Val): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
