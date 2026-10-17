import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Shell } from "@/components/agentdb/shell";
import { Btn, Field, Panel, fieldClass } from "@/components/agentdb/ui";
import { getEngine, useConsole } from "@/lib/agentdb/store";
import type { Metric, Val } from "@/lib/agentdb/types";

export const Route = createFileRoute("/vectors")({ component: Page });

function Page() {
  return (
    <Shell>
      <VectorView />
    </Shell>
  );
}

type Point = { id: number; title: string; category: string; vec: number[]; x: number; y: number; dist?: number };

function VectorView() {
  const ready = useConsole((state) => state.ready);
  const rev = useConsole((state) => state.rev);
  const [query, setQuery] = useState("crash recovery after a power loss");
  const [mode, setMode] = useState<"exact" | "hnsw">("exact");
  const [metric, setMetric] = useState<Metric>("cosine");
  const [k, setK] = useState(5);
  const [hits, setHits] = useState<Point[]>([]);
  const [recall, setRecall] = useState(1);
  const [note, setNote] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  const cloud = useMemo(() => {
    if (!ready) return [] as Point[];
    const result = getEngine().exec("SELECT id, title, category, embedding FROM docs");
    const rows = result.rows
      .map((row) => {
        const vec = row[3];
        if (typeof row[0] !== "number" || typeof row[1] !== "string" || !Array.isArray(vec)) return null;
        return { id: row[0], title: row[1], category: String(row[2] ?? ""), vec: vec as number[], x: 0, y: 0 };
      })
      .filter((row): row is Point => row != null);
    const projected = project(rows.map((row) => row.vec));
    return rows.map((row, index) => ({ ...row, x: projected[index][0], y: projected[index][1] }));
  }, [ready, rev]);

  function search() {
    const found = getEngine().vectorSearch("docs", "embedding", query, k, mode, mode === "exact" ? metric : undefined);
    setRecall(found.recall);
    setNote(found.note);
    const byId = new Map(cloud.map((point) => [point.id, point]));
    setHits(
      found.rows.map((row) => {
        const point = byId.get(row.id);
        const data = row.data as Record<string, Val>;
        return {
          id: row.id,
          title: String(data.title ?? point?.title ?? row.id),
          category: String(data.category ?? ""),
          vec: point?.vec ?? [],
          x: point?.x ?? 0,
          y: point?.y ?? 0,
          dist: row.dist,
        };
      }),
    );
    setActive(found.rows[0]?.id ?? null);
  }

  useEffect(() => {
    if (ready && cloud.length && hits.length === 0) search();
    // initial probe only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, cloud.length]);

  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const parent = node.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = 320;
    const ratio = window.devicePixelRatio || 1;
    node.width = Math.floor(width * ratio);
    node.height = Math.floor(height * ratio);
    node.style.width = `${width}px`;
    node.style.height = `${height}px`;
    const ctx = node.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue("--color-bg-inset").trim() || "#090c0a";
    const fg = styles.getPropertyValue("--color-fg").trim() || "#e7f0e9";
    const signal = styles.getPropertyValue("--color-signal").trim() || "#dff25a";
    const muted = styles.getPropertyValue("--color-muted").trim() || "#8b9a90";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    if (!cloud.length) return;
    const xs = cloud.map((point) => point.x);
    const ys = cloud.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const sx = (value: number) => 28 + ((value - minX) / (maxX - minX || 1)) * (width - 56);
    const sy = (value: number) => 28 + ((value - minY) / (maxY - minY || 1)) * (height - 56);
    const chosen = new Set(hits.map((hit) => hit.id));
    for (const point of cloud) {
      ctx.fillStyle = point.id === active ? signal : chosen.has(point.id) ? fg : muted;
      const size = point.id === active ? 7 : 4;
      ctx.fillRect(sx(point.x) - size / 2, sy(point.y) - size / 2, size, size);
    }
  }, [cloud, hits, active]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-medium">Vectors</h1>
        <p className="max-w-2xl text-sm text-pretty text-muted">
          SQL order is exact. HNSW is the approximate path, and its recall is measured against that exact top-k. The map is a real 2-component projection of the stored embeddings.
        </p>
      </div>
      <Panel>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_8rem_8rem_6rem]">
          <Field label="Query text">
            <input className={fieldClass} value={query} onChange={(event) => setQuery(event.target.value)} />
          </Field>
          <Field label="Metric">
            <select className={fieldClass} value={metric} onChange={(event) => setMetric(event.target.value as Metric)}>
              <option value="cosine">cosine</option>
              <option value="l2">l2</option>
              <option value="dot">dot</option>
              <option value="hamming">hamming</option>
            </select>
          </Field>
          <Field label="Engine">
            <select className={fieldClass} value={mode} onChange={(event) => setMode(event.target.value as "exact" | "hnsw")}>
              <option value="exact">exact</option>
              <option value="hnsw">hnsw</option>
            </select>
          </Field>
          <Field label="k">
            <input className={fieldClass} type="number" min={1} max={16} value={k} onChange={(event) => setK(Number(event.target.value) || 5)} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Btn tone="signal" disabled={!ready} onClick={search}>
            Search
          </Btn>
          <span className="font-mono text-xs text-muted">
            recall {recall.toFixed(2)} {note ? `· ${note}` : ""}
          </span>
        </div>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Panel title="Projection">
          <canvas ref={canvas} className="w-full rounded-md" />
        </Panel>
        <Panel title="Neighbors">
          <ol className="flex flex-col gap-2">
            {hits.map((hit, index) => (
              <li key={hit.id}>
                <button
                  type="button"
                  onClick={() => setActive(hit.id)}
                  className={`flex w-full min-h-11 flex-col items-start rounded-md border px-3 py-2 text-left ${hit.id === active ? "border-signal" : "border-line"}`}
                >
                  <span className="text-sm">{hit.title}</span>
                  <span className="font-mono text-xs text-muted">
                    #{index + 1} · {hit.category} · dist {hit.dist?.toFixed(4)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}

function project(vectors: number[][]): [number, number][] {
  const n = vectors.length;
  if (!n) return [];
  const d = vectors[0].length;
  const mean = new Array(d).fill(0);
  for (const vec of vectors) for (let i = 0; i < d; i++) mean[i] += vec[i];
  for (let i = 0; i < d; i++) mean[i] /= n;
  const centered = vectors.map((vec) => vec.map((value, i) => value - mean[i]));
  const cov = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const row of centered) {
    for (let i = 0; i < d; i++) {
      for (let j = i; j < d; j++) cov[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < d; i++) {
    for (let j = i; j < d; j++) {
      cov[i][j] /= n;
      cov[j][i] = cov[i][j];
    }
  }
  const first = power(cov, 24);
  const second = power(deflate(cov, first), 24);
  return centered.map((row) => [dot(row, first), dot(row, second)]);
}

function power(matrix: number[][], steps: number): number[] {
  let vec: number[] = matrix.map((_, index) => (index === 0 ? 1 : 0.1));
  for (let step = 0; step < steps; step++) {
    const next = matrix.map((row) => dot(row, vec));
    const norm = Math.hypot(...next) || 1;
    vec = next.map((value) => value / norm);
  }
  return vec;
}

function deflate(matrix: number[][], axis: number[]): number[][] {
  return matrix.map((row, i) => row.map((value, j) => value - axis[i] * axis[j] * dot(matrix[i] ?? [], axis)));
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * (b[i] ?? 0);
  return s;
}
