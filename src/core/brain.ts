// The assistant's reasoning: live answers in a meeting, answers about past meetings, and recaps.

import { KnowledgeBase } from './kb.js';
import type { Llm, LlmContentBlock, LlmMessage, LlmRequest, LlmSystemBlock, LlmTool } from './llm.js';
import { type LlmUsage, type Prices, ZERO_USAGE, addUsage, llmCost } from './pricing.js';
import { GENERAL_MARKER, type PersonaConfig, RECAP_SYSTEM_PROMPT, RECAP_SCHEMA, historySystemPrompt, liveSystemPrompt, privateCallSystemPrompt } from './prompts.js';
import { SentenceBuffer, toSpeakable } from './sentences.js';
import type { Store } from './store.js';
import { estimateTokens, formatTranscript, transcriptBlocks } from './transcript.js';
import type { KbChunk, Meeting, Recap, Segment } from './types.js';

export interface BrainOptions {
  llm: Llm;
  store: Store;
  kb: KnowledgeBase;
  persona: PersonaConfig;
  prices: Prices;
  models: { live: string; chat: string; recap: string };
  /** Lets the model search the web for current facts. Billed per search by Anthropic. */
  webSearch: boolean;
  liveEffort?: 'low' | 'medium' | 'high';
}

export interface Asker {
  name: string;
  aadObjectId?: string;
  /**
   * True for staff the assistant recognises. Only they get answers drawn from the company
   * knowledge base, so a guest in an external meeting cannot read internal documents aloud.
   */
  trusted: boolean;
}

/** An earlier session of the same meeting or meeting chat, given as background. */
export interface EarlierSession {
  meeting: Meeting;
  recap: Recap | null;
  /** Only for the most recent sessions, to keep the prompt small. */
  segments?: Segment[];
}

// About 40,000 tokens. Keeps Haiku under the 100,000 token mark above which it costs five times more.
const EARLIER_BUDGET_CHARS = 160_000;
const EARLIER_TRANSCRIPT_MAX_CHARS = 100_000;

function earlierBlock(sessions: EarlierSession[], heading = 'Earlier sessions of this meeting, for background:'): string {
  if (sessions.length === 0) return '';
  let budget = EARLIER_BUDGET_CHARS;
  // Sessions arrive newest first, so the most recent ones get their transcript before the budget runs out.
  const parts = sessions.map((s) => {
    const start = Date.parse(s.meeting.startedAt ?? s.meeting.createdAt);
    const when = new Date(start).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
    const lines = [`<session date="${escapeAttr(when)} (UK time)" title="${escapeAttr(s.recap?.title ?? s.meeting.title)}">`];
    if (s.recap) {
      lines.push(`Recap: ${s.recap.summary}`);
      if (s.recap.decisions.length > 0) lines.push(`Decisions: ${s.recap.decisions.join(' | ')}`);
      if (s.recap.actions.length > 0) lines.push(`Actions: ${s.recap.actions.map((a) => `${a.owner}: ${a.task}${a.due ? ` (due ${a.due})` : ''}`).join(' | ')}`);
      if (s.recap.openQuestions.length > 0) lines.push(`Open questions: ${s.recap.openQuestions.join(' | ')}`);
    }
    budget -= lines.join('\n').length;
    if (s.segments && s.segments.length > 0 && budget > 2_000) {
      const transcript = clip(formatTranscript(s.segments, start), Math.min(EARLIER_TRANSCRIPT_MAX_CHARS, budget));
      budget -= transcript.length;
      lines.push(`<transcript>\n${transcript}\n</transcript>`);
    }
    lines.push('</session>');
    return lines.join('\n');
  });
  // Present them oldest first, the way people remember them.
  return `${heading}\n<earlier_sessions>\n${parts.reverse().join('\n')}\n</earlier_sessions>`;
}

export interface LiveAnswerInput {
  meeting: Meeting;
  segments: Segment[];
  /** Earlier sessions of the same meeting or meeting chat, newest first. */
  earlier?: EarlierSession[];
  /** A private summary call: `earlier` then holds the meetings the caller attended. */
  privateCall?: boolean;
  /** General knowledge allowance for this meeting. Omit to keep answers grounded only. */
  general?: { remaining: number; limit: number };
  question: string;
  asker: Asker;
  channel: 'voice' | 'chat';
  /** Called for each complete sentence while the answer is still being generated. */
  onSentence?: (sentence: string) => void;
  signal?: AbortSignal;
}

export interface AnswerResult {
  text: string;
  usage: LlmUsage;
  costUsd: number;
  model: string;
  /** True when the answer drew on general knowledge, which counts against the meeting's allowance. */
  usedGeneral?: boolean;
}

const MARKER_RE = new RegExp(`^\\s*${GENERAL_MARKER.replace(/[[\]]/g, '\\$&')}\\s*`, 'i');

/** Removes the general knowledge marker from the start of a reply, and says whether it was there. */
export function stripGeneralMarker(text: string): { text: string; marked: boolean } {
  return MARKER_RE.test(text) ? { text: text.replace(MARKER_RE, ''), marked: true } : { text, marked: false };
}

const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 2 } as unknown as LlmTool;

function cached(text: string): LlmSystemBlock {
  return { type: 'text', text, cache_control: { type: 'ephemeral' } };
}

function knowledgeBlock(chunks: KbChunk[]): string {
  if (chunks.length === 0) return '';
  const passages = chunks.map((c) => `<passage document="${escapeAttr(c.docTitle)}">\n${c.text}\n</passage>`).join('\n');
  return `<company_knowledge>\n${passages}\n</company_knowledge>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function meetingStart(meeting: Meeting): number {
  return Date.parse(meeting.startedAt ?? meeting.createdAt);
}

export class Brain {
  constructor(private readonly o: BrainOptions) {}

  /** Builds the request for a question asked during (or about) one meeting. Exposed for tests. */
  buildLiveRequest(input: LiveAnswerInput): LlmRequest {
    const { meeting, segments, question, asker, channel } = input;
    const start = meetingStart(meeting);
    const blocks = transcriptBlocks(segments, start);
    const content: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [];

    // Earlier sessions do not change during the meeting, so they are cached ahead of the live transcript.
    const earlier = earlierBlock(input.earlier ?? [], input.privateCall ? `Meetings ${asker.name} attended, oldest first:` : undefined);
    if (earlier) content.push({ type: 'text', text: earlier, cache_control: { type: 'ephemeral' } });

    content.push({
      type: 'text',
      text: `Meeting: ${meeting.title}\nStarted (UTC): ${new Date(start).toISOString()}\n${
        blocks.truncated ? 'Note: the earliest part of the transcript was left out because the meeting is very long.\n' : ''
      }\nTranscript so far. Each line shows the time since the start of the meeting, the speaker and what was said.\n<transcript>`,
    });
    blocks.frozen.forEach((chunk, i) => {
      // Everything up to the last complete chunk is identical between questions, so mark it cacheable.
      const last = i === blocks.frozen.length - 1;
      content.push({ type: 'text', text: chunk, ...(last ? { cache_control: { type: 'ephemeral' as const } } : {}) });
    });
    content.push({ type: 'text', text: `${blocks.tail}\n</transcript>` });

    const people = meeting.participants.map((p) => p.displayName).filter(Boolean);
    const kbHits = asker.trusted ? this.o.kb.search(question, 5) : [];
    const closing = [
      people.length > 0 ? `People in the meeting: ${people.join(', ')}.` : '',
      knowledgeBlock(kbHits),
      !asker.trusted && this.o.kb.size > 0
        ? 'The person asking is not a recognised member of staff, so company knowledge passages are withheld. If they ask about internal company information, say that you can only share that with staff.'
        : '',
      `Question from ${asker.name}: ${question}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    content.push({ type: 'text', text: closing });

    return {
      model: this.o.models.live,
      system: [cached(input.privateCall ? privateCallSystemPrompt(this.o.persona, input.general) : liveSystemPrompt(this.o.persona, channel, input.general))],
      messages: [{ role: 'user', content }],
      maxTokens: channel === 'voice' ? 1024 : 2000,
      ...(this.o.webSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
      effort: channel === 'voice' ? (this.o.liveEffort ?? 'low') : undefined,
      // Spoken answers are short and drawn from the transcript, so skip thinking for speed.
      // Only Haiku accepts this; other models keep their default adaptive thinking.
      ...(channel === 'voice' && /^claude-haiku-/.test(this.o.models.live) ? { thinking: 'off' as const } : {}),
      signal: input.signal,
    };
  }

  /** Answers a question using the transcript of one meeting, streaming sentences as they form. */
  async answerLive(input: LiveAnswerInput): Promise<AnswerResult> {
    const request = this.buildLiveRequest(input);
    // For speech, cut a long first sentence at a comma so the first audio is ready sooner.
    const sentences = input.channel === 'voice' ? new SentenceBuffer(24, 260, 70) : new SentenceBuffer();
    let first = true;
    const emit = (parts: string[]) => {
      for (const raw of parts) {
        // The general knowledge marker can only open the reply, so only the first piece is checked.
        const part = first ? stripGeneralMarker(raw).text : raw;
        first = false;
        const speakable = input.channel === 'voice' ? toSpeakable(part) : part;
        if (speakable) input.onSentence?.(speakable);
      }
    };
    const result = await this.o.llm.stream(request, (delta) => emit(sentences.push(delta)));
    emit(sentences.flush());
    const stripped = stripGeneralMarker(result.text);
    const text = input.channel === 'voice' ? toSpeakable(stripped.text) : stripped.text.trim();
    return { text, usage: result.usage, costUsd: llmCost(request.model, result.usage, this.o.prices), model: request.model, usedGeneral: stripped.marked };
  }

  /**
   * Answers a question in a personal chat, where the person may be asking about any meeting
   * they attended. The model is given tools and decides what to look up. Every tool checks that
   * the person really attended the meeting it is asked about.
   */
  async answerHistory(input: { question: string; asker: Asker; today?: string; signal?: AbortSignal }): Promise<AnswerResult> {
    const { asker } = input;
    const userId = asker.aadObjectId;
    const tools: LlmTool[] = [
      {
        name: 'list_meetings',
        description: 'List the meetings this person attended with the assistant, newest first. Use it to find which meeting a question is about.',
        input_schema: { type: 'object', properties: { limit: { type: 'integer', description: 'How many meetings to return, 1 to 30. Default 10.' } } },
      },
      {
        name: 'get_recap',
        description: 'Get the recap of one meeting: summary, decisions, actions, who explained what to whom, and open questions.',
        input_schema: { type: 'object', required: ['meeting_id'], properties: { meeting_id: { type: 'string' } } },
      },
      {
        name: 'get_transcript',
        description: 'Get the transcript of one meeting. Optionally keep only lines by one speaker or lines that contain a word or phrase, with a few lines of context around each.',
        input_schema: {
          type: 'object',
          required: ['meeting_id'],
          properties: {
            meeting_id: { type: 'string' },
            speaker: { type: 'string', description: 'Part of a speaker name to filter by.' },
            contains: { type: 'string', description: 'Word or phrase to filter by.' },
          },
        },
      },
      {
        name: 'search_company_knowledge',
        description: 'Search the company knowledge base (policies, course information, procedures) and return the most relevant passages.',
        input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
      },
    ];
    if (this.o.webSearch) tools.push(WEB_SEARCH_TOOL);

    const runTool = async (name: string, raw: unknown): Promise<string> => {
      const args = (raw ?? {}) as Record<string, unknown>;
      if (name === 'search_company_knowledge') {
        if (!asker.trusted) return 'Company knowledge is only available to recognised staff.';
        const hits = this.o.kb.search(String(args.query ?? ''), 6);
        return hits.length > 0 ? knowledgeBlock(hits) : 'No matching passages were found in the company knowledge base.';
      }
      if (!userId) return 'This person could not be identified, so no meetings can be shown.';
      if (name === 'list_meetings') {
        const limit = Math.min(30, Math.max(1, Number(args.limit) || 10));
        const refs = await this.o.store.listUserMeetings(userId, limit);
        if (refs.length === 0) return 'This person has no meetings on record.';
        const rows = await Promise.all(
          refs.map(async (r) => {
            const m = await this.o.store.getMeeting(r.meetingId);
            return {
              meeting_id: r.meetingId,
              title: m?.title ?? r.title,
              date: m?.startedAt ?? r.createdAt,
              status: m?.status ?? 'unknown',
              people: m?.participants.map((p) => p.displayName) ?? [],
              summary: m?.summary ?? '',
            };
          }),
        );
        return JSON.stringify(rows, null, 1);
      }
      const meetingId = String(args.meeting_id ?? '');
      if (!meetingId || !(await this.o.store.userHasMeeting(userId, meetingId))) {
        return 'No such meeting is on record for this person.';
      }
      if (name === 'get_recap') {
        const recap = await this.o.store.getRecap(meetingId);
        return recap ? JSON.stringify(recap, null, 1) : 'This meeting has no recap yet. Use get_transcript instead.';
      }
      if (name === 'get_transcript') {
        const meeting = await this.o.store.getMeeting(meetingId);
        const all = await this.o.store.getSegments(meetingId);
        if (!meeting || all.length === 0) return 'This meeting has no transcript on record.';
        const lines = filterSegments(all, args.speaker ? String(args.speaker) : undefined, args.contains ? String(args.contains) : undefined);
        if (lines.length === 0) return 'No lines matched that filter. Try get_transcript without a filter.';
        return clip(formatTranscript(lines, meetingStart(meeting)), 60_000);
      }
      return `Unknown tool ${name}.`;
    };

    const today = input.today ?? new Date().toISOString().slice(0, 10);
    const messages: LlmMessage[] = [{ role: 'user', content: `Question from ${asker.name}: ${input.question}` }];
    let usage = ZERO_USAGE;
    let finalText = '';
    for (let round = 0; round < 6; round++) {
      const result = await this.o.llm.create({
        model: this.o.models.chat,
        system: [cached(historySystemPrompt(this.o.persona, today))],
        messages,
        // Thinking counts towards this limit on Sonnet 5.5; only tokens used are billed.
        maxTokens: 8000,
        tools,
        signal: input.signal,
      });
      usage = addUsage(usage, result.usage);
      finalText = result.text.trim() || finalText;
      const calls = result.content.filter((b): b is Extract<LlmContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (result.stopReason === 'pause_turn') {
        messages.push({ role: 'assistant', content: result.content as never });
        continue;
      }
      if (calls.length === 0) break;
      messages.push({ role: 'assistant', content: result.content as never });
      const results = [];
      for (const call of calls) {
        let output: string;
        try {
          output = await runTool(call.name, call.input);
        } catch (err) {
          output = `The tool failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        results.push({ type: 'tool_result' as const, tool_use_id: call.id, content: output });
      }
      messages.push({ role: 'user', content: results });
    }
    return {
      text: finalText || 'I cannot confirm that. I could not find the information needed to answer.',
      usage,
      costUsd: llmCost(this.o.models.chat, usage, this.o.prices),
      model: this.o.models.chat,
    };
  }

  /** Writes the structured recap of a meeting from its transcript. */
  async buildRecap(meeting: Meeting, segments: Segment[]): Promise<{ recap: Recap; usage: LlmUsage; costUsd: number }> {
    const start = meetingStart(meeting);
    const people = meeting.participants.map((p) => p.displayName).filter(Boolean);
    const transcript = clip(formatTranscript(segments, start), 600_000);
    const result = await this.o.llm.create({
      model: this.o.models.recap,
      system: [cached(RECAP_SYSTEM_PROMPT)],
      messages: [
        {
          role: 'user',
          content: `Meeting title: ${meeting.title}\nStarted (UTC): ${new Date(start).toISOString()}\nPeople in the meeting: ${people.join(', ') || 'not recorded'}\n\n<transcript>\n${transcript}\n</transcript>\n\nWrite the recap.`,
        },
      ],
      // Thinking tokens count towards this limit. A low limit cuts the JSON short; only the
      // tokens actually used are billed.
      maxTokens: 16000,
      outputSchema: RECAP_SCHEMA,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      parsed = undefined;
    }
    // If the reply was refused or cut short there is no JSON; never show raw JSON as the summary.
    const recap = normaliseRecap(parsed, meeting.title, parsed === undefined && !result.text.trimStart().startsWith('{') ? result.text : '');
    return { recap, usage: result.usage, costUsd: llmCost(this.o.models.recap, result.usage, this.o.prices) };
  }
}

function filterSegments(all: Segment[], speaker?: string, contains?: string): Segment[] {
  if (!speaker && !contains) return all;
  const s = speaker?.toLowerCase();
  const c = contains?.toLowerCase();
  const keep = new Set<number>();
  all.forEach((seg, i) => {
    const speakerOk = !s || seg.speakerName.toLowerCase().includes(s);
    const textOk = !c || seg.text.toLowerCase().includes(c);
    if (speakerOk && textOk) {
      // Keep two lines either side so the model can see who was being addressed.
      for (let j = Math.max(0, i - 2); j <= Math.min(all.length - 1, i + 2); j++) keep.add(j);
    }
  });
  return all.filter((_, i) => keep.has(i));
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[The transcript was cut here because it is very long.]`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()) : [];
}

/** Accepts whatever the model returned and produces a well formed recap, never throwing. */
export function normaliseRecap(raw: unknown, fallbackTitle: string, fallbackText = ''): Recap {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const actions = Array.isArray(r.actions)
    ? r.actions
        .map((a) => (a && typeof a === 'object' ? (a as Record<string, unknown>) : {}))
        .filter((a) => typeof a.task === 'string' && a.task.trim())
        .map((a) => ({
          owner: typeof a.owner === 'string' && a.owner.trim() ? a.owner.trim() : 'Unassigned',
          task: String(a.task).trim(),
          ...(typeof a.due === 'string' && a.due.trim() ? { due: a.due.trim() } : {}),
        }))
    : [];
  const explained = Array.isArray(r.explained)
    ? r.explained
        .map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>) : {}))
        .map((e) => ({
          speaker: typeof e.speaker === 'string' ? e.speaker.trim() : '',
          to: typeof e.to === 'string' && e.to.trim() ? e.to.trim() : 'everyone',
          points: strings(e.points),
        }))
        .filter((e) => e.speaker && e.points.length > 0)
    : [];
  return {
    title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : fallbackTitle,
    summary: typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim() : fallbackText.trim() || 'No summary could be produced for this meeting.',
    decisions: strings(r.decisions),
    actions,
    explained,
    openQuestions: strings(r.openQuestions),
  };
}

/** Renders a recap as Teams chat markdown. */
export function recapMarkdown(recap: Recap, meta: { minutes?: number; people?: string[] } = {}): string {
  const lines: string[] = [`**Recap: ${recap.title}**`];
  const facts = [meta.minutes ? `${meta.minutes} ${meta.minutes === 1 ? "minute" : "minutes"}` : '', meta.people && meta.people.length > 0 ? `with ${meta.people.join(', ')}` : ''].filter(Boolean);
  if (facts.length > 0) lines.push(`_${facts.join(' ')}_`);
  lines.push('', recap.summary);
  if (recap.decisions.length > 0) {
    lines.push('', '**Decisions**', ...recap.decisions.map((d) => `* ${d}`));
  }
  if (recap.actions.length > 0) {
    lines.push('', '**Actions**', ...recap.actions.map((a) => `* **${a.owner}**: ${a.task}${a.due ? ` (due ${a.due})` : ''}`));
  }
  if (recap.explained.length > 0) {
    lines.push('', '**Who explained what**');
    for (const e of recap.explained) {
      lines.push(`* **${e.speaker}** to ${e.to}: ${e.points.join(' ')}`);
    }
  }
  if (recap.openQuestions.length > 0) {
    lines.push('', '**Open questions**', ...recap.openQuestions.map((q) => `* ${q}`));
  }
  lines.push('', '_Written by AI from live captions. Check important details before relying on them._');
  return lines.join('\n');
}

export { estimateTokens };
