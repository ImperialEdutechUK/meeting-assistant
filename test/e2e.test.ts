// End to end run of the whole system on one machine: the control service over real HTTP, the
// worker in real headless Chrome, a scripted meeting in place of Teams, a scripted model in place
// of Claude and tones in place of speech. Nothing here needs an account or a network.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ExpressAdapter } from '@microsoft/teams.apps';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeIdentityIssuer } from '../src/control/acs-identity.js';
import { mountInternalApi } from '../src/control/internal-api.js';
import { ControlService } from '../src/control/service.js';
import { Brain } from '../src/core/brain.js';
import type { ControlConfig } from '../src/core/config.js';
import { KnowledgeBase, chunkDocument } from '../src/core/kb.js';
import { ScriptedLlm } from '../src/core/llm.js';
import { DEFAULT_PRICES } from '../src/core/pricing.js';
import { MemoryStore } from '../src/core/store.js';
import { CachingTts, ToneTts } from '../src/core/tts.js';
import type { FakeScriptStep, PageEvent } from '../src/core/types.js';
import { type WorkerResult, runWorker } from '../src/worker/worker.js';

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
  (p): p is string => Boolean(p && existsSync(p)),
);
const SECRET = 'test-secret-that-is-long-enough-123456';
const root = fileURLToPath(new URL('..', import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

function testConfig(port: number, overrides: Partial<ControlConfig> = {}): ControlConfig {
  return {
    port,
    assistantName: 'Claude',
    organisation: 'Imperial Edutech',
    displayName: 'Claude (AI assistant)',
    wakeNames: ['claude'],
    spokenLanguage: 'en-gb',
    tenantId: 'tenant-1',
    allowedTenantIds: ['tenant-1'],
    models: { live: 'claude-haiku-5-5', chat: 'claude-sonnet-5-5', recap: 'claude-sonnet-5-5' },
    liveEffort: 'low',
    webSearch: false,
    kbAudience: 'staff',
    speechRegion: 'uksouth',
    ttsVoice: 'en-GB-SoniaNeural',
    workerSharedSecret: SECRET,
    dispatchMode: 'none',
    controlUrlForWorker: `http://127.0.0.1:${port}`,
    maxMeetingMinutes: 180,
    maxConcurrentMeetings: 5,
    monthlyBudgetUsd: 150,
    retentionDays: 90,
    aloneTimeoutSeconds: 120,
    lobbyTimeoutSeconds: 300,
    announceOnJoin: true,
    postVoiceAnswersToChat: true,
    generalQuestionsPerMeeting: 20,
    adminAadIds: [],
    ...overrides,
  };
}

interface Rig {
  service: ControlService;
  store: MemoryStore;
  llm: ScriptedLlm;
  tts: ToneTts;
  identities: FakeIdentityIssuer;
  sent: { conversationId: string; markdown: string }[];
  pageEvents: PageEvent[];
  worker: () => Promise<WorkerResult> | undefined;
  stop: () => Promise<void>;
}

async function rig(script: FakeScriptStep[], overrides: Partial<ControlConfig> = {}): Promise<Rig> {
  const port = await freePort();
  const config = testConfig(port, overrides);
  const store = new MemoryStore();
  const kb = new KnowledgeBase(chunkDocument('Refund policy', 'policies/refunds.md', 'Learners may ask for a full refund within 14 days of enrolment.'));
  const llm = new ScriptedLlm((request) => {
    if (request.outputSchema) {
      return {
        text: JSON.stringify({
          title: 'Course page publishing',
          summary: 'Alex briefed Jordan on the first batch of course pages.',
          decisions: ['Batch one goes to Marketing on Friday.'],
          actions: [{ owner: 'Jordan', task: 'Publish batch one', due: 'Monday' }],
          explained: [{ speaker: 'Alex Morgan', to: 'Jordan', points: ['Batch one goes to Marketing on Friday.'] }],
          openQuestions: [],
        }),
      };
    }
    return { text: 'You told Jordan that the first batch of course pages goes to Marketing on Friday. She agreed to publish it on Monday.' };
  });
  const tts = new ToneTts();
  const identities = new FakeIdentityIssuer();
  const sent: Rig['sent'] = [];
  const pageEvents: PageEvent[] = [];
  let workerRun: Promise<WorkerResult> | undefined;

  const service = new ControlService({
    config,
    store,
    brain: new Brain({ llm, store, kb, persona: { name: 'Claude', organisation: 'Imperial Edutech' }, prices: DEFAULT_PRICES, models: config.models, webSearch: false }),
    kb,
    tts: new CachingTts(tts),
    notifier: {
      async send(conversationId, markdown) {
        // The bot has not been added to the meeting chat in this scenario.
        if (conversationId.startsWith('19:meeting')) throw new Error('403 bot is not in this conversation');
        sent.push({ conversationId, markdown });
      },
    },
    dispatcher: {
      async start() {
        workerRun = runWorker({
          config: { controlUrl: `http://127.0.0.1:${port}`, workerSharedSecret: SECRET, transport: 'fake', chromePath: CHROME, headless: true, claimWaitSeconds: 10, mode: 'job', standbyUntil: '18:00' },
          fakeScript: script,
          pageDir: `${root}dist/page`,
          onPageEvent: (e) => pageEvents.push(e),
        });
      },
    },
    identities,
    prices: DEFAULT_PRICES,
  });
  const adapter = new ExpressAdapter();
  mountInternalApi(adapter, service, SECRET);
  await adapter.start(port);
  return { service, store, llm, tts, identities, sent, pageEvents, worker: () => workerRun, stop: () => adapter.stop() };
}

const alex = { aadObjectId: 'aad-alex', name: 'Alex Morgan' };
const JOIN_URL = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d';
const alexP = { id: 'aad-alex', aadObjectId: 'aad-alex', displayName: 'Alex Morgan', kind: 'teams' as const };
const jordanP = { id: 'aad-jordan', aadObjectId: 'aad-jordan', displayName: 'Jordan', kind: 'teams' as const };
const people = [alexP, jordanP];
const caption = (atMs: number, who: typeof alexP, text: string, final = true): FakeScriptStep => ({
  atMs,
  type: 'caption',
  caption: { speakerId: who.id, speakerAadId: who.aadObjectId, speakerName: who.displayName, text, final },
});

async function until(check: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Condition was not met in time');
}

describe.skipIf(!CHROME)('end to end with a scripted meeting', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['src/worker/build-page.mjs'], { cwd: root, stdio: 'pipe' });
  }, 60_000);

  const rigs: Rig[] = [];
  afterAll(async () => {
    for (const r of rigs) await r.stop().catch(() => undefined);
  });

  it('joins, listens, answers a spoken question aloud, then writes and delivers the recap', async () => {
    const r = await rig([
      { atMs: 300, type: 'state', state: 'lobby' },
      { atMs: 900, type: 'state', state: 'connected' },
      { atMs: 1000, type: 'participants', participants: people },
      caption(1500, alexP, 'Jordan, the first batch of course pages goes to Marketing on Friday.'),
      caption(2600, jordanP, 'Understood. I will publish it on Monday.'),
      caption(9000, alexP, 'Hey Claude what did', false),
      caption(9600, alexP, 'Hey Claude, what did I explain to Jordan?'),
      { atMs: 18_500, type: 'end' },
    ]);
    rigs.push(r);

    // A member of staff pastes the meeting link in their personal chat with the bot.
    const replies = await r.service.handleChat({ text: `join ${JOIN_URL}`, user: alex, tenantId: 'tenant-1', conversationId: 'a:personal-alex', conversationType: 'personal' });
    expect(replies[0]).toContain('On my way');
    const again = await r.service.handleChat({ text: JOIN_URL, user: alex, tenantId: 'tenant-1', conversationId: 'a:personal-alex', conversationType: 'personal' });
    expect(again[0]).toContain('already');

    const result = await r.worker();
    expect(result).toMatchObject({ outcome: 'ended', reason: 'script finished' });
    const meetingId = result?.meetingId as string;
    await until(async () => (await r.store.getRecap(meetingId)) !== null);

    // The transcript holds what people said, the question, and what the assistant said.
    const segments = await r.store.getSegments(meetingId);
    const lines = segments.map((s) => `${s.kind}|${s.speakerName}|${s.text}`);
    expect(lines).toContain('speech|Alex Morgan|Jordan, the first batch of course pages goes to Marketing on Friday.');
    expect(lines).toContain('speech|Jordan|Understood. I will publish it on Monday.');
    expect(lines).toContain('speech|Alex Morgan|Hey Claude, what did I explain to Jordan?');
    expect(lines.some((l) => l.startsWith('assistant|Claude (AI assistant)|You told Jordan'))).toBe(true);
    expect(lines).toContain("assistant|Claude (AI assistant)|Claude assistant has joined. I'm transcribing this meeting.");
    expect(segments.map((s) => s.seq)).toEqual(segments.map((_, i) => i));

    // The model was asked the right question with the right context.
    const live = r.llm.requests.find((q) => !q.outputSchema);
    const prompt = (live?.messages[0]?.content as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(live?.model).toBe('claude-haiku-5-5');
    expect(prompt).toContain('Question from Alex Morgan: what did I explain to Jordan?');
    expect(prompt).toContain('Alex Morgan: Jordan, the first batch of course pages goes to Marketing on Friday.');
    expect(prompt).toContain('People in the meeting: Alex Morgan, Jordan.');
    expect(r.llm.requests.some((q) => q.outputSchema && q.model === 'claude-sonnet-5-5')).toBe(true);
    // Sonnet 5.5 rejects forced tool use, so no request may send one.
    expect(r.llm.requests.every((q) => q.toolChoice?.type !== 'tool' && q.toolChoice?.type !== 'any')).toBe(true);

    // Speech was produced sentence by sentence and actually reached the call audio, only while unmuted.
    expect(r.tts.spoken).toContain('You told Jordan that the first batch of course pages goes to Marketing on Friday.');
    expect(r.tts.spoken).toContain('She agreed to publish it on Monday.');
    const levels = r.pageEvents.filter((e): e is Extract<PageEvent, { type: 'audioLevel' }> => e.type === 'audioLevel');
    expect(levels.filter((e) => !e.muted && e.rms > 0.05).length).toBeGreaterThan(10);
    expect(levels.filter((e) => e.muted && e.rms > 0.05)).toEqual([]);

    // The inviter was kept informed by direct message, because the bot is not in the meeting chat.
    const messages = r.sent.filter((m) => m.conversationId === 'a:personal-alex').map((m) => m.markdown);
    expect(messages.some((m) => m.includes('waiting in the lobby'))).toBe(true);
    expect(messages.some((m) => m.includes('assistant has joined** and is transcribing this meeting'))).toBe(true);
    expect(messages.some((m) => m.startsWith('**Recap: Course page publishing**') && m.includes('**Jordan**: Publish batch one (due Monday)'))).toBe(true);

    // The meeting is closed properly, costs are recorded and both attendees can ask about it later.
    const meeting = await r.store.getMeeting(meetingId);
    expect(meeting).toMatchObject({ status: 'ended', title: 'Course page publishing', endReason: 'script finished' });
    expect(meeting?.participants.map((p) => p.displayName)).toEqual(['Alex Morgan', 'Jordan']);
    expect(await r.store.userHasMeeting('aad-jordan', meetingId)).toBe(true);
    expect(r.store.transcripts.get(meetingId)).toContain('Jordan: Understood. I will publish it on Monday.');
    const kinds = r.store.usage.map((u) => u.entry.kind);
    expect(kinds).toEqual(expect.arrayContaining(['llm', 'tts', 'meeting']));
    expect(r.identities.revoked).toHaveLength(1);

    // Afterwards the recap is available on request, and a stranger from another tenant is refused.
    const recap = await r.service.handleChat({ text: 'recap', user: alex, tenantId: 'tenant-1', conversationId: 'a:personal-alex', conversationType: 'personal' });
    expect(recap[0]).toContain('Batch one goes to Marketing on Friday.');
    const outsider = await r.service.handleChat({ text: 'recap', user: { aadObjectId: 'x', name: 'X' }, tenantId: 'other-tenant', conversationId: 'a:x', conversationType: 'personal' });
    expect(outsider[0]).toContain('only available to Imperial Edutech staff');
  }, 60_000);

  it('leaves when asked in chat and refuses to speak company knowledge to an unrecognised guest', async () => {
    const guest = { id: 'guest-1', displayName: 'External Guest', kind: 'unknown' as const };
    const r = await rig(
      [
        { atMs: 400, type: 'state', state: 'connected' },
        { atMs: 500, type: 'participants', participants: [alexP, guest] },
        { atMs: 1200, type: 'caption', caption: { speakerId: guest.id, speakerName: guest.displayName, text: 'Hey Claude, what is your refund policy?', final: true } },
      ],
      { announceOnJoin: false },
    );
    rigs.push(r);
    await r.service.handleChat({ text: JOIN_URL, user: alex, tenantId: 'tenant-1', conversationId: 'a:personal-alex', conversationType: 'personal' });
    await until(() => r.llm.requests.length > 0, 15_000);
    const prompt = (r.llm.requests[0]?.messages[0]?.content as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(prompt).toContain('Question from External Guest: what is your refund policy?');
    expect(prompt).not.toContain('<company_knowledge>');
    expect(prompt).toContain('only share that with staff');

    const leaving = await r.service.handleChat({ text: 'leave', user: alex, tenantId: 'tenant-1', conversationId: 'a:personal-alex', conversationType: 'personal' });
    expect(leaving[0]).toContain('Leaving now');
    const result = await r.worker();
    expect(result).toMatchObject({ outcome: 'ended', reason: 'asked to leave' });
    await until(async () => (await r.store.getMeeting(result?.meetingId as string))?.status === 'ended');
  }, 60_000);

  it('rejects worker calls without a valid token', async () => {
    const r = await rig([]);
    rigs.push(r);
    const base = `http://127.0.0.1:${(r.service as unknown as { d: { config: ControlConfig } }).d.config.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/internal/claim`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/internal/claim`, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/internal/claim`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } })).status).toBe(204);
    const events = await fetch(`${base}/internal/meetings/some-id/events`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: '{"events":[]}' });
    expect(events.status).toBe(401);
  }, 30_000);
});
