import { distance } from "./text.ts";
import type { Metric } from "./types.ts";

type Node = {
  id: number;
  vec: number[];
  level: number;
  neighbors: number[][];
};

type Hit = { id: number; dist: number };

/**
 * Small HNSW graph. SQL ORDER BY stays exact; this index is the approximate
 * path MCP vector_search can ask for, with recall measured against exact.
 */
export class HnswIndex {
  readonly metric: Metric;
  private readonly M: number;
  private readonly efConstruction: number;
  private entryId: number | null = null;
  private maxLevel = -1;
  private nodes = new Map<number, Node>();

  constructor(metric: Metric = "cosine", M = 8, efConstruction = 64) {
    this.metric = metric;
    this.M = M;
    this.efConstruction = efConstruction;
  }

  get size(): number {
    return this.nodes.size;
  }

  get levels(): number {
    return this.maxLevel + 1;
  }

  add(id: number, vec: number[]): void {
    if (this.nodes.has(id)) this.remove(id);
    const level = this.randomLevel(id);
    const node: Node = {
      id,
      vec,
      level,
      neighbors: Array.from({ length: level + 1 }, () => []),
    };
    this.nodes.set(id, node);
    if (this.entryId == null) {
      this.entryId = id;
      this.maxLevel = level;
      return;
    }
    let ep = this.entryId;
    for (let lc = this.maxLevel; lc > level; lc--) {
      const nearest = this.searchLayer(vec, [ep], 1, lc);
      if (nearest[0]) ep = nearest[0].id;
    }
    for (let lc = Math.min(level, this.maxLevel); lc >= 0; lc--) {
      const neighbors = this.searchLayer(vec, [ep], this.efConstruction, lc);
      const selected = neighbors.slice(0, this.M);
      node.neighbors[lc] = selected.map((n) => n.id);
      for (const hit of selected) {
        const other = this.nodes.get(hit.id);
        if (!other) continue;
        const bucket = other.neighbors[lc] ?? (other.neighbors[lc] = []);
        bucket.push(id);
        const cap = lc === 0 ? this.M * 2 : this.M;
        if (bucket.length > cap) other.neighbors[lc] = this.closest(other.vec, bucket, cap);
      }
      if (neighbors[0]) ep = neighbors[0].id;
    }
    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryId = id;
    }
  }

  remove(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    for (let lc = 0; lc <= node.level; lc++) {
      for (const nid of node.neighbors[lc] ?? []) {
        const other = this.nodes.get(nid);
        if (!other) continue;
        other.neighbors[lc] = (other.neighbors[lc] ?? []).filter((x) => x !== id);
      }
    }
    this.nodes.delete(id);
    if (this.entryId === id) {
      let next: number | null = null;
      let top = -1;
      for (const n of this.nodes.values()) {
        if (n.level > top) {
          top = n.level;
          next = n.id;
        }
      }
      this.entryId = next;
      this.maxLevel = top;
    }
  }

  search(query: number[], k: number): Hit[] {
    if (this.entryId == null || k <= 0) return [];
    let ep = this.entryId;
    for (let lc = this.maxLevel; lc > 0; lc--) {
      const nearest = this.searchLayer(query, [ep], 1, lc);
      if (nearest[0]) ep = nearest[0].id;
    }
    return this.searchLayer(query, [ep], Math.max(this.efConstruction, k), 0).slice(0, k);
  }

  private closest(vec: number[], ids: number[], cap: number): number[] {
    return ids
      .map((id) => ({ id, dist: this.pair(vec, id) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, cap)
      .map((h) => h.id);
  }

  private pair(vec: number[], id: number): number {
    const node = this.nodes.get(id);
    if (!node) return Number.POSITIVE_INFINITY;
    return distance(vec, node.vec, this.metric);
  }

  private searchLayer(query: number[], entry: number[], ef: number, level: number): Hit[] {
    const visited = new Set<number>();
    const candidates: Hit[] = [];
    const found: Hit[] = [];
    for (const id of entry) {
      if (!this.nodes.has(id) || visited.has(id)) continue;
      visited.add(id);
      const hit = { id, dist: this.pair(query, id) };
      insert(candidates, hit);
      insert(found, hit);
    }
    if (found.length > ef) found.length = ef;
    while (candidates.length) {
      const current = candidates.shift();
      if (!current) break;
      const worst = found[found.length - 1];
      if (found.length >= ef && worst && current.dist > worst.dist) break;
      const node = this.nodes.get(current.id);
      const neighbors = node?.neighbors[level] ?? [];
      for (const nid of neighbors) {
        if (visited.has(nid) || !this.nodes.has(nid)) continue;
        visited.add(nid);
        const dist = this.pair(query, nid);
        const worstNow = found[found.length - 1];
        if (found.length < ef || !worstNow || dist < worstNow.dist) {
          const hit = { id: nid, dist };
          insert(candidates, hit);
          insert(found, hit);
          if (found.length > ef) found.pop();
        }
      }
    }
    return found;
  }

  private randomLevel(id: number): number {
    let level = 0;
    let guard = 0;
    while (unit(id, level) < 1 / this.M && level < 6 && guard < 8) {
      level += 1;
      guard += 1;
    }
    return level;
  }
}

function insert(list: Hit[], hit: Hit): void {
  let i = 0;
  while (i < list.length && list[i].dist <= hit.dist) i += 1;
  list.splice(i, 0, hit);
}

function unit(id: number, salt: number): number {
  let x = Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
