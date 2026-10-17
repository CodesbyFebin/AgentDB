import { DbError, type Metric } from "./types.ts";

export type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "vec"; v: number[] }
  | { k: "name"; parts: string[] }
  | { k: "star" }
  | { k: "unary"; op: "-" | "not"; x: Expr }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "call"; name: string; args: Expr[] }
  | { k: "in"; x: Expr; list: Expr[]; not: boolean }
  | { k: "like"; x: Expr; pat: Expr; not: boolean }
  | { k: "is"; x: Expr; not: boolean };

export type ColDef = {
  name: string;
  type: string;
  dim?: number;
  primary: boolean;
  notNull: boolean;
};

export type Join = { name: string; alias?: string; on: Expr };

export type Stmt =
  | { k: "create_table"; name: string; ifNot: boolean; cols: ColDef[] }
  | { k: "drop"; kind: "table" | "index" | "stream"; name: string; ifExists: boolean }
  | {
      k: "create_index";
      name: string;
      table: string;
      kind: "btree" | "hnsw" | "bm25";
      cols: string[];
      metric?: Metric;
      ifNot: boolean;
    }
  | { k: "create_stream"; name: string; table: string }
  | { k: "insert"; table: string; cols?: string[]; rows: Expr[][] }
  | { k: "update"; table: string; sets: { col: string; expr: Expr }[]; where?: Expr }
  | { k: "delete"; table: string; where?: Expr }
  | {
      k: "select";
      distinct: boolean;
      items: { expr: Expr; alias?: string }[] | "*";
      from?: { name: string; alias?: string };
      joins: Join[];
      where?: Expr;
      group: Expr[];
      order: { expr: Expr; dir: "asc" | "desc" }[];
      limit?: number;
      offset?: number;
    }
  | { k: "hybrid"; query: string; table: string; vector: string; text: string[]; where?: Expr; limit: number }
  | {
      k: "memory_store";
      key: string;
      value: string;
      importance?: number;
      ttl?: number;
      session?: string;
      at?: number;
    }
  | { k: "memory_recall"; query: string; limit: number; session?: string }
  | { k: "memory_forget"; key: string }
  | { k: "memory_list"; limit: number; session?: string }
  | { k: "show"; what: "tables" | "indexes" | "streams" | "events" | "schema"; name?: string }
  | { k: "explain"; inner: Stmt }
  | { k: "vacuum" }
  | { k: "check" }
  | { k: "checkpoint" }
  | { k: "begin" }
  | { k: "commit" }
  | { k: "rollback" };

export type Piece = { stmt: Stmt; sql: string };

type Tok =
  | { t: "ident"; v: string; at: number }
  | { t: "num"; v: number; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "sym"; v: string; at: number }
  | { t: "eof"; at: number };

const RESERVED = new Set(
  "from where group order limit offset join inner left on and or not in is like as by asc desc union having primary key null".split(
    " ",
  ),
);

export function parseSql(source: string): Piece[] {
  const toks = lex(source);
  const p = new Parser(source, toks);
  return p.parseAll();
}

export function mutates(stmt: Stmt): boolean {
  if (stmt.k === "explain") return false;
  return (
    stmt.k === "create_table" ||
    stmt.k === "drop" ||
    stmt.k === "create_index" ||
    stmt.k === "create_stream" ||
    stmt.k === "insert" ||
    stmt.k === "update" ||
    stmt.k === "delete" ||
    stmt.k === "memory_store" ||
    stmt.k === "memory_forget" ||
    stmt.k === "vacuum" ||
    stmt.k === "checkpoint"
  );
}

class Parser {
  private i = 0;
  private src: string;
  private toks: Tok[];
  constructor(src: string, toks: Tok[]) {
    this.src = src;
    this.toks = toks;
  }

  parseAll(): Piece[] {
    const out: Piece[] = [];
    while (!this.eof()) {
      this.skipSemi();
      if (this.eof()) break;
      const start = this.peek().at;
      const stmt = this.parseStmt();
      const end = this.peek().at;
      const sql = stripSemi(this.src.slice(start, end));
      out.push({ stmt, sql });
      this.skipSemi();
    }
    return out;
  }

  private parseStmt(): Stmt {
    if (this.kw("explain")) {
      this.bump();
      return { k: "explain", inner: this.parseStmt() };
    }
    if (this.kw("create")) return this.parseCreate();
    if (this.kw("drop")) return this.parseDrop();
    if (this.kw("insert")) return this.parseInsert();
    if (this.kw("update")) return this.parseUpdate();
    if (this.kw("delete")) return this.parseDelete();
    if (this.kw("select")) return this.parseSelect();
    if (this.kw("hybrid")) return this.parseHybrid();
    if (this.kw("memory")) return this.parseMemory();
    if (this.kw("show")) return this.parseShow();
    if (this.kw("vacuum")) {
      this.bump();
      return { k: "vacuum" };
    }
    if (this.kw("check") || this.kw("integrity")) {
      this.bump();
      if (this.kw("integrity")) this.bump();
      return { k: "check" };
    }
    if (this.kw("checkpoint")) {
      this.bump();
      return { k: "checkpoint" };
    }
    if (this.kw("begin")) {
      this.bump();
      if (this.kw("transaction")) this.bump();
      return { k: "begin" };
    }
    if (this.kw("commit")) {
      this.bump();
      return { k: "commit" };
    }
    if (this.kw("rollback")) {
      this.bump();
      return { k: "rollback" };
    }
    throw this.err(`unexpected ${this.describe()}`);
  }

  private parseCreate(): Stmt {
    this.bump();
    if (this.kw("table")) return this.parseCreateTable();
    if (this.kw("vector")) {
      this.bump();
      this.expectKw("index");
      return this.parseCreateIndex("hnsw");
    }
    if (this.kw("fts")) {
      this.bump();
      this.expectKw("index");
      return this.parseCreateIndex("bm25");
    }
    if (this.kw("index")) {
      this.bump();
      return this.parseCreateIndex("btree");
    }
    if (this.kw("stream")) return this.parseCreateStream();
    throw this.err("expected TABLE, INDEX, VECTOR INDEX, FTS INDEX, or STREAM");
  }

  private parseCreateTable(): Stmt {
    this.bump();
    const ifNot = this.eatIfNotExists();
    const name = this.ident();
    this.expect("(");
    const cols: ColDef[] = [];
    if (!this.eat(")")) {
      do {
        cols.push(this.parseCol());
      } while (this.eat(","));
      this.expect(")");
    }
    if (!cols.length) throw this.err("table needs at least one column");
    return { k: "create_table", name, ifNot, cols };
  }

  private parseCol(): ColDef {
    const name = this.ident();
    const typeTok = this.ident().toUpperCase();
    let dim: number | undefined;
    if (typeTok === "VECTOR") {
      this.expect("(");
      dim = this.num();
      this.expect(")");
    } else if (!["INTEGER", "REAL", "TEXT", "JSON", "BOOLEAN", "TIMESTAMP"].includes(typeTok)) {
      throw this.err(`unknown type ${typeTok}`);
    }
    let primary = false;
    let notNull = false;
    for (;;) {
      if (this.kw("primary")) {
        this.bump();
        this.expectKw("key");
        primary = true;
        continue;
      }
      if (this.kw("not")) {
        this.bump();
        this.expectKw("null");
        notNull = true;
        continue;
      }
      break;
    }
    return { name, type: typeTok, dim, primary, notNull };
  }

  private parseCreateIndex(kind: "btree" | "hnsw" | "bm25"): Stmt {
    const ifNot = this.eatIfNotExists();
    const name = this.ident();
    this.expectKw("on");
    const table = this.ident();
    this.expect("(");
    const cols = [this.ident()];
    while (this.eat(",")) cols.push(this.ident());
    this.expect(")");
    let metric: Metric | undefined;
    if (this.kw("metric")) {
      this.bump();
      const m = this.ident().toLowerCase();
      if (m !== "cosine" && m !== "l2" && m !== "dot" && m !== "hamming") throw this.err(`unknown metric ${m}`);
      metric = m;
    }
    if (this.kw("using")) {
      this.bump();
      this.ident();
    }
    return { k: "create_index", name, table, kind, cols, metric, ifNot };
  }

  private parseCreateStream(): Stmt {
    this.bump();
    const name = this.ident();
    this.expectKw("on");
    const table = this.ident();
    return { k: "create_stream", name, table };
  }

  private parseDrop(): Stmt {
    this.bump();
    const kindTok = this.ident().toLowerCase();
    if (kindTok !== "table" && kindTok !== "index" && kindTok !== "stream") {
      throw this.err("DROP needs TABLE, INDEX, or STREAM");
    }
    const ifExists = this.eatIfExists();
    const name = this.ident();
    return { k: "drop", kind: kindTok, name, ifExists };
  }

  private parseInsert(): Stmt {
    this.bump();
    this.expectKw("into");
    const table = this.ident();
    let cols: string[] | undefined;
    if (this.eat("(")) {
      cols = [this.ident()];
      while (this.eat(",")) cols.push(this.ident());
      this.expect(")");
    }
    this.expectKw("values");
    const rows: Expr[][] = [];
    do {
      this.expect("(");
      const vals: Expr[] = [];
      if (!this.eat(")")) {
        vals.push(this.parseExpr());
        while (this.eat(",")) vals.push(this.parseExpr());
        this.expect(")");
      }
      rows.push(vals);
    } while (this.eat(","));
    return { k: "insert", table, cols, rows };
  }

  private parseUpdate(): Stmt {
    this.bump();
    const table = this.ident();
    this.expectKw("set");
    const sets: { col: string; expr: Expr }[] = [];
    do {
      const col = this.ident();
      this.expect("=");
      sets.push({ col, expr: this.parseExpr() });
    } while (this.eat(","));
    let where: Expr | undefined;
    if (this.kw("where")) {
      this.bump();
      where = this.parseExpr();
    }
    return { k: "update", table, sets, where };
  }

  private parseDelete(): Stmt {
    this.bump();
    this.expectKw("from");
    const table = this.ident();
    let where: Expr | undefined;
    if (this.kw("where")) {
      this.bump();
      where = this.parseExpr();
    }
    return { k: "delete", table, where };
  }

  private parseSelect(): Stmt {
    this.bump();
    const distinct = this.kw("distinct") ? (this.bump(), true) : false;
    let items: { expr: Expr; alias?: string }[] | "*";
    if (this.eat("*")) items = "*";
    else {
      const list: { expr: Expr; alias?: string }[] = [];
      do {
        const expr = this.parseExpr();
        let alias: string | undefined;
        const word = this.word();
        if (this.kw("as")) {
          this.bump();
          alias = this.ident();
        } else if (word && !RESERVED.has(word)) {
          alias = this.ident();
        }
        list.push({ expr, alias });
      } while (this.eat(","));
      items = list;
    }
    let from: { name: string; alias?: string } | undefined;
    if (this.kw("from")) {
      this.bump();
      const name = this.ident();
      let alias: string | undefined;
      if (this.kw("as")) {
        this.bump();
        alias = this.ident();
      } else if (this.peek().t === "ident" && !RESERVED.has((this.peek() as { v: string }).v.toLowerCase())) {
        alias = this.ident();
      }
      from = { name, alias };
    }
    const joins: Join[] = [];
    while (this.kw("join") || this.kw("inner") || this.kw("left")) {
      if (this.kw("inner") || this.kw("left")) this.bump();
      this.expectKw("join");
      const name = this.ident();
      let alias: string | undefined;
      if (this.kw("as")) {
        this.bump();
        alias = this.ident();
      } else if (this.peek().t === "ident" && !["on", "where", "join", "group", "order", "limit"].includes((this.peek() as { v: string }).v.toLowerCase())) {
        alias = this.ident();
      }
      this.expectKw("on");
      joins.push({ name, alias, on: this.parseExpr() });
    }
    let where: Expr | undefined;
    if (this.kw("where")) {
      this.bump();
      where = this.parseExpr();
    }
    const group: Expr[] = [];
    if (this.kw("group")) {
      this.bump();
      this.expectKw("by");
      group.push(this.parseExpr());
      while (this.eat(",")) group.push(this.parseExpr());
    }
    const order: { expr: Expr; dir: "asc" | "desc" }[] = [];
    if (this.kw("order")) {
      this.bump();
      this.expectKw("by");
      do {
        const expr = this.parseExpr();
        let dir: "asc" | "desc" = "asc";
        if (this.kw("asc")) {
          this.bump();
          dir = "asc";
        } else if (this.kw("desc")) {
          this.bump();
          dir = "desc";
        }
        order.push({ expr, dir });
      } while (this.eat(","));
    }
    let limit: number | undefined;
    let offset: number | undefined;
    if (this.kw("limit")) {
      this.bump();
      limit = this.num();
    }
    if (this.kw("offset")) {
      this.bump();
      offset = this.num();
    }
    return { k: "select", distinct, items, from, joins, where, group, order, limit, offset };
  }

  private parseHybrid(): Stmt {
    this.bump();
    const query = this.str();
    this.expectKw("from");
    const table = this.ident();
    this.expectKw("vector");
    const vector = this.ident();
    this.expectKw("text");
    const text = [this.ident()];
    while (this.eat(",")) text.push(this.ident());
    let where: Expr | undefined;
    if (this.kw("where")) {
      this.bump();
      where = this.parseExpr();
    }
    let limit = 10;
    if (this.kw("limit")) {
      this.bump();
      limit = this.num();
    }
    return { k: "hybrid", query, table, vector, text, where, limit };
  }

  private parseMemory(): Stmt {
    this.bump();
    const kind = this.ident().toLowerCase();
    if (kind === "store") {
      const key = this.str();
      this.expectKw("value");
      const value = this.str();
      let importance: number | undefined;
      let ttl: number | undefined;
      let session: string | undefined;
      let at: number | undefined;
      for (;;) {
        if (this.kw("importance")) {
          this.bump();
          importance = this.num();
          continue;
        }
        if (this.kw("ttl")) {
          this.bump();
          ttl = this.num();
          continue;
        }
        if (this.kw("session")) {
          this.bump();
          session = this.str();
          continue;
        }
        if (this.kw("at")) {
          this.bump();
          at = this.num();
          continue;
        }
        break;
      }
      return { k: "memory_store", key, value, importance, ttl, session, at };
    }
    if (kind === "recall") {
      const query = this.str();
      let limit = 5;
      let session: string | undefined;
      if (this.kw("limit")) {
        this.bump();
        limit = this.num();
      }
      if (this.kw("session")) {
        this.bump();
        session = this.str();
      }
      return { k: "memory_recall", query, limit, session };
    }
    if (kind === "forget") return { k: "memory_forget", key: this.str() };
    if (kind === "list") {
      let limit = 20;
      let session: string | undefined;
      if (this.kw("limit")) {
        this.bump();
        limit = this.num();
      }
      if (this.kw("session")) {
        this.bump();
        session = this.str();
      }
      return { k: "memory_list", limit, session };
    }
    throw this.err("MEMORY needs STORE, RECALL, FORGET, or LIST");
  }

  private parseShow(): Stmt {
    this.bump();
    const what = this.ident().toLowerCase();
    if (what !== "tables" && what !== "indexes" && what !== "streams" && what !== "events" && what !== "schema") {
      throw this.err("SHOW needs TABLES, INDEXES, STREAMS, EVENTS, or SCHEMA");
    }
    let name: string | undefined;
    if (what === "schema") name = this.ident();
    return { k: "show", what, name };
  }

  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.kw("or")) {
      this.bump();
      left = { k: "bin", op: "or", l: left, r: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.kw("and")) {
      this.bump();
      left = { k: "bin", op: "and", l: left, r: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.kw("not")) {
      this.bump();
      return { k: "unary", op: "not", x: this.parseNot() };
    }
    return this.parseCmp();
  }

  private parseCmp(): Expr {
    const left = this.parseAdd();
    if (this.kw("is")) {
      this.bump();
      const not = this.kw("not") ? (this.bump(), true) : false;
      this.expectKw("null");
      return { k: "is", x: left, not };
    }
    const not = this.kw("not") ? (this.bump(), true) : false;
    if (this.kw("like")) {
      this.bump();
      return { k: "like", x: left, pat: this.parseAdd(), not };
    }
    if (this.kw("in")) {
      this.bump();
      this.expect("(");
      const list: Expr[] = [];
      if (!this.eat(")")) {
        list.push(this.parseExpr());
        while (this.eat(",")) list.push(this.parseExpr());
        this.expect(")");
      }
      return { k: "in", x: left, list, not };
    }
    if (not) throw this.err("expected LIKE or IN after NOT");
    const op = this.symbol();
    if (op && ["=", "!=", "<>", "<", ">", "<=", ">="].includes(op)) {
      this.bump();
      return { k: "bin", op, l: left, r: this.parseAdd() };
    }
    return left;
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.symbol() === "+" || this.symbol() === "-") {
      const op = this.symbol() ?? "+";
      this.bump();
      left = { k: "bin", op, l: left, r: this.parseMul() };
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.symbol() === "*" || this.symbol() === "/") {
      const op = this.symbol() ?? "*";
      this.bump();
      left = { k: "bin", op, l: left, r: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.eat("-")) return { k: "unary", op: "-", x: this.parseUnary() };
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const tok = this.peek();
    if (tok.t === "num") {
      this.bump();
      return { k: "num", v: tok.v };
    }
    if (tok.t === "str") {
      this.bump();
      return { k: "str", v: tok.v };
    }
    if (this.eat("*")) return { k: "star" };
    if (this.eat("(")) {
      const expr = this.parseExpr();
      this.expect(")");
      return expr;
    }
    if (this.eat("[")) {
      const nums: number[] = [];
      if (!this.eat("]")) {
        nums.push(this.signedNum());
        while (this.eat(",")) nums.push(this.signedNum());
        this.expect("]");
      }
      return { k: "vec", v: nums };
    }
    if (tok.t === "ident") {
      const name = this.ident();
      const lower = name.toLowerCase();
      if (lower === "null") return { k: "null" };
      if (lower === "true") return { k: "bool", v: true };
      if (lower === "false") return { k: "bool", v: false };
      if (this.eat("(")) {
        const args: Expr[] = [];
        if (!this.eat(")")) {
          args.push(this.parseExpr());
          while (this.eat(",")) args.push(this.parseExpr());
          this.expect(")");
        }
        return { k: "call", name: lower, args };
      }
      const parts = [name];
      while (this.eat(".")) parts.push(this.ident());
      return { k: "name", parts };
    }
    throw this.err(`expected expression, got ${this.describe()}`);
  }

  private signedNum(): number {
    const neg = this.eat("-");
    const n = this.num();
    return neg ? -n : n;
  }

  private eatIfNotExists(): boolean {
    if (!this.kw("if")) return false;
    this.bump();
    this.expectKw("not");
    this.expectKw("exists");
    return true;
  }

  private eatIfExists(): boolean {
    if (!this.kw("if")) return false;
    this.bump();
    this.expectKw("exists");
    return true;
  }

  private skipSemi(): void {
    while (this.eat(";")) {
      /* delimiters */
    }
  }

  private eof(): boolean {
    return this.peek().t === "eof";
  }

  private peek(): Tok {
    return this.toks[this.i] ?? { t: "eof", at: this.src.length };
  }

  private word(): string | null {
    const tok = this.peek();
    return tok.t === "ident" ? tok.v.toLowerCase() : null;
  }

  private symbol(): string | null {
    const tok = this.peek();
    return tok.t === "sym" ? tok.v : null;
  }

  private bump(): Tok {
    const tok = this.peek();
    if (tok.t !== "eof") this.i += 1;
    return tok;
  }

  private kw(word: string): boolean {
    const tok = this.peek();
    return tok.t === "ident" && tok.v.toLowerCase() === word;
  }

  private expectKw(word: string): void {
    if (!this.kw(word)) throw this.err(`expected ${word.toUpperCase()}`);
    this.bump();
  }

  private ident(): string {
    const tok = this.peek();
    if (tok.t !== "ident") throw this.err("expected identifier");
    this.bump();
    return tok.v;
  }

  private str(): string {
    const tok = this.peek();
    if (tok.t !== "str") throw this.err("expected string");
    this.bump();
    return tok.v;
  }

  private num(): number {
    const tok = this.peek();
    if (tok.t !== "num") throw this.err("expected number");
    this.bump();
    return tok.v;
  }

  private eat(sym: string): boolean {
    const tok = this.peek();
    if (tok.t === "sym" && tok.v === sym) {
      this.bump();
      return true;
    }
    return false;
  }

  private expect(sym: string): void {
    if (!this.eat(sym)) throw this.err(`expected '${sym}'`);
  }

  private describe(): string {
    const tok = this.peek();
    if (tok.t === "eof") return "end of statement";
    if (tok.t === "ident") return tok.v;
    if (tok.t === "sym") return tok.v;
    if (tok.t === "str") return "string";
    return "number";
  }

  private err(message: string): DbError {
    const at = this.peek().at;
    let line = 1;
    let col = 1;
    for (let i = 0; i < at && i < this.src.length; i++) {
      if (this.src[i] === "\n") {
        line += 1;
        col = 1;
      } else col += 1;
    }
    return new DbError(`${message} (line ${line}, column ${col})`);
  }
}

function stripSemi(sql: string): string {
  return sql.replace(/;+\s*$/, "").trim();
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "-" && src[i + 1] === "-") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === "'") {
      const at = i;
      i += 1;
      let value = "";
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          i += 1;
          break;
        }
        value += src[i];
        i += 1;
      }
      toks.push({ t: "str", v: value, at });
      continue;
    }
    if (c >= "0" && c <= "9") {
      const at = i;
      let n = "";
      while (i < src.length && ((src[i] >= "0" && src[i] <= "9") || src[i] === ".")) {
        n += src[i];
        i += 1;
      }
      toks.push({ t: "num", v: Number(n), at });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const at = i;
      let id = "";
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) {
        id += src[i];
        i += 1;
      }
      toks.push({ t: "ident", v: id, at });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["!=", "<>", "<=", ">="].includes(two)) {
      toks.push({ t: "sym", v: two, at: i });
      i += 2;
      continue;
    }
    toks.push({ t: "sym", v: c, at: i });
    i += 1;
  }
  toks.push({ t: "eof", at: src.length });
  return toks;
}
