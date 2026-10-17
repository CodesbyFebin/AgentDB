import type { Metric } from "./types.ts";

export const DIM = 48;

const STOP = new Set(
  "a an the of to and or in on for with from by at as is are was were be this that it its into over under about than then so if not no".split(
    " ",
  ),
);

export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("ly") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

function fnv(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Feature-hashing embedder. Deterministic, offline, no model weights. */
export function embedText(text: string, dim = DIM): number[] {
  const v = new Float64Array(dim);
  const tokens = tokenize(text);
  const grams = tokens.slice();
  for (let i = 0; i < tokens.length - 1; i++) grams.push(`${tokens[i]}_${tokens[i + 1]}`);
  for (const gram of grams) {
    const h = fnv(gram);
    const sign = h & 0x100 ? 1 : -1;
    v[h % dim] += sign * (1 + ((h >>> 9) & 7) / 8);
  }
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length - 2; i++) {
    const tri = lower.slice(i, i + 3);
    if (!/[a-z0-9]{3}/.test(tri)) continue;
    const h = fnv(`#${tri}`);
    v[h % dim] += (h & 0x100 ? 0.35 : -0.35);
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) out[i] = v[i] / norm;
  return out;
}

export function distance(a: number[], b: number[], metric: Metric): number {
  const n = Math.min(a.length, b.length);
  if (metric === "l2") {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const d = a[i] - b[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }
  if (metric === "hamming") {
    let d = 0;
    for (let i = 0; i < n; i++) {
      if (a[i] === 0 && b[i] === 0) continue;
      if ((a[i] >= 0) !== (b[i] >= 0)) d += 1;
    }
    return d;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (metric === "dot") return -dot;
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return 1 - dot / denom;
}

export function similarity(a: number[], b: number[]): number {
  return 1 - distance(a, b, "cosine");
}

export function likeMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${escaped}$`).test(value.toLowerCase());
}

export function snippetAround(text: string, query: string, radius = 72): string {
  const terms = tokenize(query);
  const lower = text.toLowerCase();
  let at = -1;
  let hit = "";
  for (const term of terms) {
    const raw = term.length > 4 ? term : term;
    const idx = lower.indexOf(raw);
    if (idx >= 0 && (at < 0 || idx < at)) {
      at = idx;
      hit = raw;
    }
  }
  if (at < 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + hit.length + radius);
  const slice = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  return slice;
}

export function splitMarks(text: string, query: string): { text: string; hit: boolean }[] {
  const terms = tokenize(query).filter((t) => t.length > 2);
  if (!terms.length) return [{ text, hit: false }];
  const re = new RegExp(`(${terms.map(escapeReg).join("|")})`, "ig");
  const parts = text.split(re);
  return parts.filter((p) => p.length > 0).map((p) => ({ text: p, hit: terms.some((t) => p.toLowerCase().startsWith(t)) }));
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
