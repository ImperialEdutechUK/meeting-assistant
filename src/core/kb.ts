// The company knowledge base: passages of text with a keyword index over them.

import { Bm25Index } from './bm25.js';
import { sha256 } from './ids.js';
import type { KbChunk } from './types.js';

export class KnowledgeBase {
  private index: Bm25Index<KbChunk>;
  private chunks: KbChunk[];

  constructor(chunks: KbChunk[] = []) {
    this.chunks = chunks;
    this.index = this.build(chunks);
  }

  private build(chunks: KbChunk[]): Bm25Index<KbChunk> {
    // The document title is indexed with each passage so a search for the document name finds it.
    return new Bm25Index(chunks, (c) => `${c.docTitle} ${c.docTitle} ${c.text}`);
  }

  replace(chunks: KbChunk[]): void {
    this.chunks = chunks;
    this.index = this.build(chunks);
  }

  get size(): number {
    return this.chunks.length;
  }

  search(query: string, limit = 5): KbChunk[] {
    const hits = this.index.search(query, limit * 2);
    if (hits.length === 0) return [];
    // Drop weak matches: anything scoring under a third of the best hit is usually noise.
    const best = hits[0]?.score ?? 0;
    return hits
      .filter((h) => h.score >= best * 0.34)
      .slice(0, limit)
      .map((h) => h.item);
  }
}

/** Splits a document into overlapping passages on paragraph boundaries. */
export function chunkDocument(docTitle: string, source: string, text: string, targetChars = 1800, overlapChars = 200): KbChunk[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  const pieces: string[] = [];
  let current = '';
  const pushCurrent = () => {
    if (current.trim()) pieces.push(current.trim());
  };
  for (const paragraph of paragraphs) {
    // A single very long paragraph is cut on sentence ends.
    const parts = paragraph.length > targetChars ? splitLong(paragraph, targetChars) : [paragraph];
    for (const part of parts) {
      if (current && current.length + part.length + 2 > targetChars) {
        pushCurrent();
        current = overlapChars > 0 ? `${current.slice(-overlapChars).replace(/^\S*\s/, '')}\n\n${part}` : part;
      } else {
        current = current ? `${current}\n\n${part}` : part;
      }
    }
  }
  pushCurrent();
  return pieces.map((piece, i) => ({
    id: `${sha256(`${source}#${i}`).slice(0, 16)}`,
    docTitle,
    source,
    text: piece,
  }));
}

function splitLong(paragraph: string, targetChars: number): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > targetChars) {
      out.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
    while (current.length > targetChars * 1.5) {
      out.push(current.slice(0, targetChars));
      current = current.slice(targetChars);
    }
  }
  if (current) out.push(current);
  return out;
}
