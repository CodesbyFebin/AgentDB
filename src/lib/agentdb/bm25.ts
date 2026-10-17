import { tokenize } from "./text.ts";

export class Bm25Index {
  private k1 = 1.2;
  private b = 0.75;
  private postings = new Map<string, Map<number, number>>();
  private docLen = new Map<number, number>();
  private df = new Map<string, number>();
  private totalLen = 0;

  get docs(): number {
    return this.docLen.size;
  }

  get terms(): number {
    return this.postings.size;
  }

  add(id: number, text: string): void {
    this.remove(id);
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    this.docLen.set(id, tokens.length);
    this.totalLen += tokens.length;
    for (const [term, freq] of tf) {
      let posting = this.postings.get(term);
      if (!posting) {
        posting = new Map();
        this.postings.set(term, posting);
      }
      posting.set(id, freq);
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
  }

  remove(id: number): void {
    if (!this.docLen.has(id)) return;
    this.totalLen -= this.docLen.get(id) ?? 0;
    this.docLen.delete(id);
    const drop: string[] = [];
    for (const [term, posting] of this.postings) {
      if (!posting.has(id)) continue;
      posting.delete(id);
      const next = (this.df.get(term) ?? 1) - 1;
      if (next <= 0 || posting.size === 0) drop.push(term);
      else this.df.set(term, next);
    }
    for (const term of drop) {
      this.postings.delete(term);
      this.df.delete(term);
    }
  }

  score(id: number, query: string): number {
    const terms = [...new Set(tokenize(query))];
    const dl = this.docLen.get(id) ?? 0;
    const n = this.docLen.size || 1;
    const avg = this.totalLen / n || 1;
    let score = 0;
    for (const term of terms) {
      const freq = this.postings.get(term)?.get(id) ?? 0;
      if (!freq) continue;
      const nq = this.df.get(term) ?? 0;
      const idf = Math.log(1 + (n - nq + 0.5) / (nq + 0.5));
      const denom = freq + this.k1 * (1 - this.b + this.b * (dl / avg));
      score += idf * ((freq * (this.k1 + 1)) / (denom || 1));
    }
    return score;
  }

  search(query: string, limit: number): { id: number; score: number }[] {
    const terms = [...new Set(tokenize(query))];
    const ids = new Set<number>();
    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      for (const id of posting.keys()) ids.add(id);
    }
    return [...ids]
      .map((id) => ({ id, score: this.score(id, query) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  suggest(prefix: string, limit: number): string[] {
    const p = prefix.toLowerCase();
    return [...this.df.keys()]
      .filter((term) => term.startsWith(p))
      .sort((a, b) => (this.df.get(b) ?? 0) - (this.df.get(a) ?? 0) || a.localeCompare(b))
      .slice(0, limit);
  }

  dictionary(): string[] {
    return [...this.df.keys()];
  }
}
