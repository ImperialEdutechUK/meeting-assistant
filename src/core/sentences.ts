// Splits a stream of text deltas into speakable sentences so speech can start before the
// whole answer has been generated.

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'no', 'approx', 'inc', 'ltd', 'co']);

export class SentenceBuffer {
  private buffer = '';
  private emitted = 0;

  /**
   * firstMaxChars: the first piece is cut at a comma or similar once it grows past this, so the
   * first audio can be made sooner. Speech takes about as long to make as the piece is long.
   */
  constructor(
    private readonly minChars = 24,
    private readonly maxChars = 260,
    private readonly firstMaxChars = maxChars,
  ) {}

  /** Adds text and returns any sentences that are now complete. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const sentence = this.buffer.slice(0, cut).replace(/\s+/g, ' ').trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence) {
        out.push(sentence);
        this.emitted++;
      }
    }
    return out;
  }

  /** Returns whatever is left at the end of the stream. */
  flush(): string[] {
    const rest = this.buffer.replace(/\s+/g, ' ').trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }

  private findCut(): number {
    const cut = this.findSentenceCut();
    if (this.emitted > 0 || this.firstMaxChars >= this.maxChars) return cut;
    // First piece: if the sentence is (or is growing) longer than the limit, cut at a natural
    // pause instead. Never at a plain space, which would put a pause mid-phrase.
    const end = cut < 0 ? this.buffer.length : cut;
    if (end <= this.firstMaxChars) return cut;
    // Cut at the first natural pause, so the opening words are spoken as early as possible.
    const pauses = /, |; |: | - /g;
    const head = this.buffer.slice(0, end);
    for (let m = pauses.exec(head); m; m = pauses.exec(head)) {
      if (m.index > this.minChars) return m.index + 1;
    }
    return cut;
  }

  private findSentenceCut(): number {
    const text = this.buffer;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '\n') continue;
      const next = text[i + 1];
      if (ch === '\n') {
        if (text.slice(0, i).trim().length >= 1) return i + 1;
        continue;
      }
      // Need to see what follows before deciding, unless this is a question or exclamation mark.
      if (next === undefined) return -1;
      if (!/\s/.test(next)) continue; // "3.5", "example.com", "..."
      if (ch === '.') {
        const before = text.slice(0, i);
        const lastWord = (before.match(/([A-Za-z.]+)$/)?.[1] ?? '').toLowerCase();
        if (ABBREVIATIONS.has(lastWord)) continue;
        if (/^[a-z]$/i.test(lastWord)) continue; // initials such as "J. Smith"
      }
      if (text.slice(0, i + 1).trim().length < this.minChars) continue;
      return i + 1;
    }
    if (text.length > this.maxChars) {
      const window = text.slice(0, this.maxChars);
      const soft = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
      if (soft > this.minChars) return soft + 1;
      const space = window.lastIndexOf(' ');
      if (space > this.minChars) return space + 1;
    }
    return -1;
  }
}

/** Removes markup that should never be read aloud. */
export function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*•]\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s+/g, ' ')
    .trim();
}
