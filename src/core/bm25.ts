// A small BM25 text index held in memory. The company knowledge base for a firm of this size
// is a few thousand passages at most, so this avoids paying for a search service.

const STOP = new Set(
  'a an and are as at be but by for from has have how i if in into is it its of on or our that the their them then there these they this to was we were what when where which who will with would you your do does did can could should about tell me please'.split(' '),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().normalize('NFKD').split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Very light stemming so that "refunds" finds "refund" and "policies" finds "policy". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -1);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export interface Bm25Hit<T> {
  item: T;
  score: number;
}

export class Bm25Index<T> {
  private readonly docs: { item: T; length: number; tf: Map<string, number> }[] = [];
  private readonly df = new Map<string, number>();
  private totalLength = 0;

  constructor(
    items: T[],
    private readonly textOf: (item: T) => string,
    private readonly k1 = 1.4,
    private readonly b = 0.75,
  ) {
    for (const item of items) this.add(item);
  }

  get size(): number {
    return this.docs.length;
  }

  private add(item: T): void {
    const tokens = tokenize(this.textOf(item));
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.push({ item, length: tokens.length, tf });
    this.totalLength += tokens.length;
  }

  search(query: string, limit = 5, minScore = 0.01): Bm25Hit<T>[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || this.docs.length === 0) return [];
    const avg = this.totalLength / this.docs.length || 1;
    const n = this.docs.length;
    const hits: Bm25Hit<T>[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of terms) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * doc.length) / avg));
      }
      if (score > minScore) hits.push({ item: doc.item, score });
    }
    hits.sort((x, y) => y.score - x.score);
    return hits.slice(0, limit);
  }
}
