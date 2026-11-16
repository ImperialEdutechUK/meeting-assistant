// Builds transcript segments from final captions and formats them for the model.

import type { CaptionEvent, Segment } from './types.js';

/** Rough token estimate for English text. Deliberately a little high. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function offset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function formatSegment(segment: Segment, meetingStartMs: number): string {
  const label = segment.kind === 'assistant' ? `${segment.speakerName} (assistant)` : segment.speakerName;
  return `[${offset(Date.parse(segment.ts) - meetingStartMs)}] ${label}: ${segment.text}`;
}

export function formatTranscript(segments: Segment[], meetingStartMs: number): string {
  return segments.map((s) => formatSegment(s, meetingStartMs)).join('\n');
}

export interface TranscriptBlocks {
  /** Complete chunks. Their text never changes once written, so the model can cache them. */
  frozen: string[];
  /** The most recent lines, which change with every question. */
  tail: string;
  /** True when early chunks were left out to respect the token budget. */
  truncated: boolean;
}

/**
 * Splits the transcript into fixed chunks. Because a chunk never changes after it fills up,
 * two questions asked minutes apart send an identical prefix and the second one is read from
 * the prompt cache instead of being processed again.
 */
export function transcriptBlocks(
  segments: Segment[],
  meetingStartMs: number,
  options: { chunkSize?: number; maxTokens?: number } = {},
): TranscriptBlocks {
  const chunkSize = options.chunkSize ?? 120;
  const maxTokens = options.maxTokens ?? 80_000;
  const frozen: string[] = [];
  const complete = Math.floor(segments.length / chunkSize);
  for (let i = 0; i < complete; i++) {
    frozen.push(formatTranscript(segments.slice(i * chunkSize, (i + 1) * chunkSize), meetingStartMs));
  }
  const tail = formatTranscript(segments.slice(complete * chunkSize), meetingStartMs);

  let truncated = false;
  let total = estimateTokens(tail) + frozen.reduce((n, c) => n + estimateTokens(c), 0);
  while (total > maxTokens && frozen.length > 0) {
    const dropped = frozen.shift() as string;
    total -= estimateTokens(dropped);
    truncated = true;
  }
  return { frozen, tail, truncated };
}

/**
 * Merges consecutive final captions from one speaker into a single segment, so a long
 * explanation is stored as one passage instead of a dozen fragments.
 */
export class SegmentBuilder {
  private open: { speakerId: string; speakerName: string; text: string; startedAt: number; lastAt: number } | null = null;
  private ready: Omit<Segment, 'seq'>[] = [];
  private nextSeq: number;

  constructor(
    startSeq = 0,
    private readonly mergeGapMs = 8000,
    private readonly maxChars = 700,
  ) {
    this.nextSeq = startSeq;
  }

  add(caption: CaptionEvent): void {
    if (!caption.final) return;
    const text = caption.text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const o = this.open;
    if (o && o.speakerId === caption.speakerId && caption.at - o.lastAt <= this.mergeGapMs && o.text.length + text.length < this.maxChars) {
      o.text = `${o.text} ${text}`;
      o.lastAt = caption.at;
      return;
    }
    this.close();
    this.open = { speakerId: caption.speakerId, speakerName: caption.speakerName, text, startedAt: caption.at, lastAt: caption.at };
  }

  /** Adds something the assistant said, which never merges with speech. */
  addAssistant(name: string, text: string, at: number): void {
    this.close();
    this.ready.push({ ts: new Date(at).toISOString(), speakerId: 'assistant', speakerName: name, text, kind: 'assistant' });
  }

  /** Returns finished segments. With force, also closes the passage still being built. */
  drain(now: number, force = false): Segment[] {
    if (this.open && (force || now - this.open.lastAt > this.mergeGapMs)) this.close();
    const out = this.ready.map((s) => ({ ...s, seq: this.nextSeq++ }));
    this.ready = [];
    return out;
  }

  private close(): void {
    const o = this.open;
    if (!o) return;
    this.ready.push({ ts: new Date(o.startedAt).toISOString(), speakerId: o.speakerId, speakerName: o.speakerName, text: o.text, kind: 'speech' });
    this.open = null;
  }
}
