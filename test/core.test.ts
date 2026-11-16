import { describe, expect, it } from 'vitest';
import { Bm25Index } from '../src/core/bm25.js';
import { Brain, normaliseRecap, recapMarkdown, stripGeneralMarker } from '../src/core/brain.js';
import { KnowledgeBase, chunkDocument } from '../src/core/kb.js';
import { ScriptedLlm } from '../src/core/llm.js';
import { DEFAULT_PRICES, llmCost, meetingCost, ttsCost, ZERO_USAGE } from '../src/core/pricing.js';
import { SentenceBuffer, toSpeakable } from '../src/core/sentences.js';
import { secondsUntilUkTime } from '../src/core/config.js';
import { MemoryStore } from '../src/core/store.js';
import { SegmentBuilder, transcriptBlocks } from '../src/core/transcript.js';
import { meetingIdTime, meetingToken, newMeetingId, safeEqual } from '../src/core/ids.js';
import { SAMPLE_SEGMENTS, sampleMeeting, seg } from './helpers.js';

const persona = { name: 'Claude', organisation: 'Imperial Edutech' };
const models = { live: 'claude-haiku-5-5', chat: 'claude-sonnet-5-5', recap: 'claude-sonnet-5-5' };

function kbFixture(): KnowledgeBase {
  return new KnowledgeBase([
    ...chunkDocument('Refund policy', 'policies/refunds.md', 'Learners may ask for a full refund within 14 days of enrolment, provided they have completed less than 20 percent of the course.\n\nRefunds are paid to the original payment method within 10 working days.'),
    ...chunkDocument('Virtual classes', 'courses/classes.md', 'Virtual classes with a tutor run every month. Classes are held on the first Saturday of each month.'),
  ]);
}

describe('pricing', () => {
  it('prices a Haiku request and applies the long prompt multiplier', () => {
    const small = llmCost('claude-haiku-5-5', { ...ZERO_USAGE, inputTokens: 11_000, outputTokens: 120 });
    expect(small).toBeCloseTo(11_000 * 0.1e-6 + 120 * 0.5e-6, 10);
    const large = llmCost('claude-haiku-5-5', { ...ZERO_USAGE, inputTokens: 120_000, outputTokens: 100 });
    expect(large).toBeCloseTo((120_000 * 0.1e-6 + 100 * 0.5e-6) * 5, 10);
  });

  it('prices cache use, speech and meeting minutes', () => {
    const cost = llmCost('claude-sonnet-5-5', { inputTokens: 1000, outputTokens: 1000, cacheWriteTokens: 10_000, cacheReadTokens: 10_000, webSearches: 1 });
    expect(cost).toBeCloseTo(0.002 + 0.01 + 0.025 + 0.001 + 0.01, 10);
    expect(ttsCost(1_000_000)).toBe(15);
    expect(meetingCost(60, DEFAULT_PRICES)).toBeCloseTo(60 * (0.004 + 0.021 + 0.00252), 10);
  });
});

describe('ids', () => {
  it('orders meeting ids newest first and round trips the time', () => {
    const older = newMeetingId(1_800_000_000_000);
    const newer = newMeetingId(1_800_000_600_000);
    expect(newer < older).toBe(true);
    expect(meetingIdTime(newer)).toBe(1_800_000_600_000);
    expect(safeEqual(meetingToken('s', older), meetingToken('s', older))).toBe(true);
    expect(safeEqual(meetingToken('s', older), meetingToken('s', newer))).toBe(false);
  });
});

describe('general knowledge marker', () => {
  it('is removed from the start of a reply and nowhere else', () => {
    expect(stripGeneralMarker('[general] A KPI is a key performance indicator.')).toEqual({ text: 'A KPI is a key performance indicator.', marked: true });
    expect(stripGeneralMarker('  [General]  Paris.')).toEqual({ text: 'Paris.', marked: true });
    expect(stripGeneralMarker('Alex said [general] terms apply.')).toEqual({ text: 'Alex said [general] terms apply.', marked: false });
  });

  it('never reaches the voice', async () => {
    const llm = new ScriptedLlm(() => ({ text: '[general] Photosynthesis is how plants turn light into energy, using water and carbon dioxide. That is general knowledge.' }));
    const brain = new Brain({ llm, store: new MemoryStore(), kb: new KnowledgeBase(), persona, prices: DEFAULT_PRICES, models, webSearch: false });
    const spoken: string[] = [];
    const result = await brain.answerLive({ meeting: sampleMeeting(), segments: SAMPLE_SEGMENTS, question: 'what is photosynthesis?', asker: { name: 'Alex Morgan', trusted: true }, channel: 'voice', general: { remaining: 5, limit: 20 }, onSentence: (s) => spoken.push(s) });
    expect(result.usedGeneral).toBe(true);
    expect(spoken.join(' ')).not.toContain('[general]');
    expect(spoken[0]?.startsWith('Photosynthesis')).toBe(true);
  });
});

describe('speed of the first spoken words', () => {
  it('cuts a long first sentence at a comma so speech can start sooner, then works normally', () => {
    const b = new SentenceBuffer(24, 260, 70);
    const out = b.push('You told Jordan that the first batch of course pages goes to Marketing on Friday, and that each page needs its fee checked. ');
    expect(out).toEqual(['You told Jordan that the first batch of course pages goes to Marketing on Friday,', 'and that each page needs its fee checked.']);
    // After the first piece, sentences are no longer cut at commas.
    const later = b.push('Then you said batch two follows a week later, after the review, once the fees are agreed with finance. ');
    expect(later).toEqual(['Then you said batch two follows a week later, after the review, once the fees are agreed with finance.']);
  });

  it('works out the time left until a UK clock time, across the clock change', () => {
    // 16 November is GMT, so 17:00 UTC is 17:00 in London.
    expect(secondsUntilUkTime('18:00', new Date('2026-11-16T17:00:00Z'))).toBe(3600);
    // 16 July is BST (UTC+1), so 16:00 UTC is 17:00 in London.
    expect(secondsUntilUkTime('18:00', new Date('2026-07-16T16:00:00Z'))).toBe(3600);
    expect(secondsUntilUkTime('18:00', new Date('2026-11-16T19:00:00Z'))).toBe(0);
  });
});

describe('SentenceBuffer', () => {
  it('releases complete sentences from a stream of small pieces', () => {
    const b = new SentenceBuffer();
    const text = 'You told Jordan that batch one goes to Marketing on Friday. Dr. Perera owns version 3.5 of the plan. Is that right?';
    const out: string[] = [];
    for (let i = 0; i < text.length; i += 7) out.push(...b.push(text.slice(i, i + 7)));
    out.push(...b.flush());
    expect(out).toEqual(['You told Jordan that batch one goes to Marketing on Friday.', 'Dr. Perera owns version 3.5 of the plan.', 'Is that right?']);
  });

  it('strips markup that should not be read aloud', () => {
    expect(toSpeakable('**Two** actions:\n* Send the [brief](https://example.com/x)\n* See https://example.com')).toBe('Two actions: Send the brief See a link');
  });
});

describe('search', () => {
  it('ranks the matching passage first and ignores unrelated queries', () => {
    const index = new Bm25Index(['refund within 14 days of enrolment', 'classes on the first Saturday', 'certificates are posted to learners'], (s) => s);
    expect(index.search('when are refunds allowed')[0]?.item).toContain('refund');
    expect(index.search('quantum physics')).toEqual([]);
  });

  it('chunks long documents with overlap and finds passages by topic', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} explains step ${i} of the enrolment process in enough words to take up some space.`).join('\n\n');
    const chunks = chunkDocument('Enrolment guide', 'guides/enrolment.md', long, 600, 80);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((c) => c.text.length <= 700)).toBe(true);
    expect(kbFixture().search('How long do refunds take to be paid?')[0]?.docTitle).toBe('Refund policy');
  });
});

describe('transcript', () => {
  it('merges consecutive captions from one speaker and keeps order', () => {
    const b = new SegmentBuilder();
    const cap = (speakerId: string, text: string, at: number) => ({ speakerId, speakerName: speakerId, text, final: true, at });
    b.add(cap('a', 'First part.', 1000));
    b.add(cap('a', 'Second part.', 3000));
    b.add(cap('b', 'Reply.', 4000));
    expect(b.drain(4500).map((s) => s.text)).toEqual(['First part. Second part.']);
    b.addAssistant('Claude', 'An answer.', 5000);
    const rest = b.drain(6000);
    expect(rest.map((s) => [s.seq, s.kind, s.text])).toEqual([[1, 'speech', 'Reply.'], [2, 'assistant', 'An answer.']]);
  });

  it('keeps earlier chunks byte identical as the meeting grows, so they can be cached', () => {
    const start = Date.parse('2026-11-16T09:00:30.000Z');
    const many = Array.from({ length: 250 }, (_, i) => seg(i, i % 2 ? 'Jordan' : 'Alex Morgan', `Line number ${i}.`, i * 5));
    const early = transcriptBlocks(many.slice(0, 130), start);
    const later = transcriptBlocks(many, start);
    expect(early.frozen).toHaveLength(1);
    expect(later.frozen).toHaveLength(2);
    expect(later.frozen[0]).toBe(early.frozen[0]);
    expect(later.tail.split('\n')).toHaveLength(10);
    expect(transcriptBlocks(many, start, { maxTokens: 100 }).truncated).toBe(true);
  });
});

describe('Brain', () => {
  it('builds a live request with a cacheable prefix, knowledge for staff only, and the asker named', () => {
    const brain = new Brain({ llm: new ScriptedLlm(() => ({ text: 'ok' })), store: new MemoryStore(), kb: kbFixture(), persona, prices: DEFAULT_PRICES, models, webSearch: false });
    const many = Array.from({ length: 130 }, (_, i) => seg(i, 'Alex Morgan', `Point ${i}.`, i * 5));
    const staff = brain.buildLiveRequest({ meeting: sampleMeeting(), segments: many, question: 'What is our refund policy?', asker: { name: 'Alex Morgan', trusted: true }, channel: 'voice' });
    const blocks = staff.messages[0]?.content as Array<{ text: string; cache_control?: unknown }>;
    expect(staff.model).toBe('claude-haiku-5-5');
    expect(staff.effort).toBe('low');
    expect(blocks.filter((b) => b.cache_control)).toHaveLength(1);
    expect(blocks.at(-1)?.text).toContain('<company_knowledge>');
    expect(blocks.at(-1)?.text).toContain('Question from Alex Morgan: What is our refund policy?');
    expect(staff.system[0]?.text).toContain('converted to speech');

    const guest = brain.buildLiveRequest({ meeting: sampleMeeting(), segments: many, question: 'What is our refund policy?', asker: { name: 'Guest', trusted: false }, channel: 'chat' });
    const guestBlocks = guest.messages[0]?.content as Array<{ text: string }>;
    expect(guestBlocks.at(-1)?.text).not.toContain('<company_knowledge>');
    expect(guestBlocks.at(-1)?.text).toContain('only share that with staff');
    expect(guest.system[0]?.text).toContain('Teams chat');
  });

  it('streams a spoken answer sentence by sentence and reports cost', async () => {
    const llm = new ScriptedLlm(() => ({ text: 'You told Jordan that batch one goes to **Marketing** on Friday. She will publish it on Monday.' }));
    const brain = new Brain({ llm, store: new MemoryStore(), kb: new KnowledgeBase(), persona, prices: DEFAULT_PRICES, models, webSearch: true });
    const spoken: string[] = [];
    const result = await brain.answerLive({ meeting: sampleMeeting(), segments: SAMPLE_SEGMENTS, question: 'what did I explain to Jordan?', asker: { name: 'Alex Morgan', trusted: true }, channel: 'voice', onSentence: (s) => spoken.push(s) });
    expect(spoken).toEqual(['You told Jordan that batch one goes to Marketing on Friday.', 'She will publish it on Monday.']);
    expect(result.text).toBe(spoken.join(' '));
    expect(result.costUsd).toBeGreaterThan(0);
    expect(llm.requests[0]?.tools?.[0]).toMatchObject({ type: 'web_search_20250305', max_uses: 2 });
    const transcript = (llm.requests[0]?.messages[0]?.content as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(transcript).toContain('[00:00:20] Alex Morgan: Jordan, the first batch');
  });

  it('answers history questions with tools and never shows a meeting the person did not attend', async () => {
    const store = new MemoryStore();
    const mine = sampleMeeting({ status: 'ended', summary: 'Publishing plan agreed.' });
    const theirs = sampleMeeting({ id: '8100000000000bbbbbbbbbb', title: 'Directors only', invitedByAadId: 'aad-rushan' });
    await store.createMeeting(mine);
    await store.createMeeting(theirs);
    await store.appendSegments(mine.id, SAMPLE_SEGMENTS);
    await store.appendSegments(theirs.id, [seg(0, 'Director', 'Confidential budget figure.', 5)]);
    await store.linkUserToMeeting('aad-alex', { meetingId: mine.id, title: mine.title, createdAt: mine.createdAt });

    const script = [
      { toolName: 'list_meetings', toolInput: {} },
      { toolName: 'get_transcript', toolInput: { meeting_id: theirs.id } },
      { toolName: 'get_transcript', toolInput: { meeting_id: mine.id, speaker: 'Alex' } },
      { text: 'In the course page sync you told Jordan that batch one goes to Marketing on Friday.' },
    ];
    const llm = new ScriptedLlm((_req, i) => script[i] ?? { text: 'done' });
    const brain = new Brain({ llm, store, kb: kbFixture(), persona, prices: DEFAULT_PRICES, models, webSearch: false });
    const result = await brain.answerHistory({ question: 'What did I explain to Jordan yesterday?', asker: { name: 'Alex Morgan', aadObjectId: 'aad-alex', trusted: true } });

    expect(result.text).toContain('batch one goes to Marketing on Friday');
    const toolResults = llm.requests.flatMap((r) => r.messages).filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content as Array<{ type: string; content?: string }>).filter((b) => b.type === 'tool_result').map((b) => b.content ?? '');
    expect(toolResults[0]).toContain('Course page publishing sync');
    expect(toolResults[0]).not.toContain('Directors only');
    expect(toolResults[1]).toBe('No such meeting is on record for this person.');
    expect(toolResults.join('\n')).not.toContain('Confidential budget figure');
    expect(toolResults[2]).toContain('course fee checked');
  });

  it('builds a recap through structured output and tolerates a malformed reply', async () => {
    const good = { title: 'Publishing sync', summary: 'Batch one goes out Friday.', decisions: ['Batch one first.'], actions: [{ owner: 'Jordan', task: 'Publish batch one', due: 'Monday' }, { task: '' }], explained: [{ speaker: 'Alex Morgan', to: 'Jordan', points: ['Check course fees.'] }, { speaker: '', points: [] }], openQuestions: [] };
    const llm = new ScriptedLlm(() => ({ text: JSON.stringify(good) }));
    const brain = new Brain({ llm, store: new MemoryStore(), kb: new KnowledgeBase(), persona, prices: DEFAULT_PRICES, models, webSearch: false });
    const { recap } = await brain.buildRecap(sampleMeeting(), SAMPLE_SEGMENTS);
    expect(llm.requests[0]?.toolChoice).toBeUndefined();
    expect(llm.requests[0]?.outputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(recap.actions).toEqual([{ owner: 'Jordan', task: 'Publish batch one', due: 'Monday' }]);
    expect(recap.explained).toHaveLength(1);
    const md = recapMarkdown(recap, { minutes: 12, people: ['Alex Morgan', 'Jordan'] });
    expect(md).toContain('**Jordan**: Publish batch one (due Monday)');
    expect(md).toContain('**Alex Morgan** to Jordan: Check course fees.');
    expect(normaliseRecap('nonsense', 'Fallback title').title).toBe('Fallback title');
    expect(normaliseRecap(null, 'T', 'Some text').summary).toBe('Some text');
  });
});
