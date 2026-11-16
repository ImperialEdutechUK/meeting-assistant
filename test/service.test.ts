import { ExpressAdapter } from '@microsoft/teams.apps';
import { describe, expect, it } from 'vitest';
import { FakeIdentityIssuer } from '../src/control/acs-identity.js';
import { mountInternalApi } from '../src/control/internal-api.js';
import { type ChatMessage, ControlService, type TeamsAccount, callerIsAlone, extractJoinUrl, mergeParticipants, threadIdFromJoinUrl } from '../src/control/service.js';
import { decryptCache, encryptCache } from '../src/control/teams-identity.js';
import type { AnswerLine } from '../src/core/types.js';
import { createTeamsApp, stripBotMention, wireTeams } from '../src/control/teams.js';
import { Brain } from '../src/core/brain.js';
import { loadControlConfig } from '../src/core/config.js';
import { meetingToken, newMeetingId } from '../src/core/ids.js';
import { KnowledgeBase, chunkDocument } from '../src/core/kb.js';
import { ScriptedLlm, type ScriptedReply } from '../src/core/llm.js';
import { DEFAULT_PRICES } from '../src/core/pricing.js';
import { MemoryStore } from '../src/core/store.js';
import { CachingTts, ToneTts } from '../src/core/tts.js';
import { SAMPLE_SEGMENTS, sampleMeeting } from './helpers.js';

const SECRET = 'unit-test-secret-of-sufficient-length';

function build(options: { reply?: (i: number) => ScriptedReply; env?: Record<string, string>; now?: () => number; teamsAccount?: TeamsAccount } = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, { WORKER_SHARED_SECRET: SECRET, TENANT_ID: 'tenant-1', ORGANISATION_NAME: 'Imperial Edutech', DISPATCH_MODE: 'none', ...options.env });
  const config = loadControlConfig();
  process.env = saved;
  const store = new MemoryStore();
  const kb = new KnowledgeBase(chunkDocument('Refund policy', 'refunds.md', 'Learners may ask for a full refund within 14 days of enrolment.'));
  const llm = new ScriptedLlm((_r, i) => options.reply?.(i) ?? { text: 'An answer.' });
  const sent: { conversationId: string; markdown: string }[] = [];
  let dispatched = 0;
  const identities = new FakeIdentityIssuer();
  const service = new ControlService({
    config,
    store,
    brain: new Brain({ llm, store, kb, persona: { name: config.assistantName, organisation: config.organisation }, prices: DEFAULT_PRICES, models: config.models, webSearch: false }),
    kb,
    tts: new CachingTts(new ToneTts()),
    notifier: { send: async (conversationId, markdown) => void sent.push({ conversationId, markdown }) },
    dispatcher: { start: async () => void dispatched++ },
    identities,
    prices: DEFAULT_PRICES,
    ...(options.now ? { now: options.now } : {}),
    ...(options.teamsAccount ? { teamsAccount: options.teamsAccount } : {}),
  });
  return { service, store, llm, sent, config, identities, dispatched: () => dispatched };
}

const alex = { aadObjectId: 'aad-alex', name: 'Alex Morgan' };
const LINK = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz%40thread.v2/0?context=%7b%7d';
const personal = (text: string, user = alex): ChatMessage => ({ text, user, tenantId: 'tenant-1', conversationId: `a:${user.aadObjectId}`, conversationType: 'personal' });
const meetingChat = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ text, user: alex, tenantId: 'tenant-1', conversationId: '19:meeting_xyz@thread.v2', conversationType: 'groupChat', ...extra });

describe('join links', () => {
  it('finds Teams join links in chat text, including HTML wrapped and short links', () => {
    expect(extractJoinUrl(`join ${LINK}`)).toBe(LINK);
    expect(extractJoinUrl('<a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_a%40thread.v2/0?context=x&amp;y=1">link</a>')).toBe('https://teams.microsoft.com/l/meetup-join/19%3ameeting_a%40thread.v2/0?context=x&y=1');
    expect(extractJoinUrl('please join https://teams.microsoft.com/meet/4925781234567?p=AbCdEf.')).toBe('https://teams.microsoft.com/meet/4925781234567?p=AbCdEf');
    expect(extractJoinUrl('see https://example.com/meet/1')).toBeNull();
    expect(threadIdFromJoinUrl(LINK)).toBe('19:meeting_xyz@thread.v2');
    expect(threadIdFromJoinUrl('https://teams.microsoft.com/meet/4925781234567?p=AbCdEf')).toBeUndefined();
  });

  it('keeps everyone who was ever in the meeting', () => {
    const a = { id: '1', displayName: 'A', kind: 'teams' as const };
    const b = { id: '2', displayName: 'B', kind: 'teams' as const };
    expect(mergeParticipants([a, b], [{ ...a, displayName: 'A renamed' }]).map((p) => p.displayName)).toEqual(['A renamed', 'B']);
  });
});

describe('ControlService chat handling', () => {
  it('explains itself and refuses other tenants', async () => {
    const { service } = build();
    expect((await service.handleChat(personal('help')))[0]).toContain('AI meeting assistant');
    expect((await service.handleChat({ ...personal('help'), tenantId: 'someone-else' }))[0]).toContain('only available to Imperial Edutech staff');
    expect((await service.handleChat(personal('https://teams.live.com/meet/123')))[0]).toContain('personal accounts');
    expect((await service.handleChat(personal('join')))[0]).toContain('I need the meeting link');
  });

  it('joins from a meeting chat by looking the link up, then hands the meeting to one worker', async () => {
    const { service, store, dispatched } = build();
    const replies = await service.handleChat(meetingChat('join', { resolveMeeting: async () => ({ joinUrl: LINK, title: 'CDD weekly' }) }));
    expect(replies[0]).toContain('On my way');
    expect(dispatched()).toBe(1);
    const assignment = await service.claim();
    expect(assignment).toMatchObject({ joinUrl: LINK, displayName: 'Claude (AI assistant)', wakeNames: ['claude'], spokenLanguage: 'en-gb' });
    expect(assignment?.meetingToken).toBe(meetingToken(SECRET, assignment?.meetingId as string));
    // Short, but it still tells people that the meeting is being transcribed.
    expect(assignment?.announcement).toBe("Claude assistant has joined. I'm transcribing this meeting.");
    expect(await service.claim()).toBeNull();
    const meeting = await store.getMeeting(assignment?.meetingId as string);
    expect(meeting).toMatchObject({ title: 'CDD weekly', conversationId: '19:meeting_xyz@thread.v2', status: 'claimed' });
  });

  it('lets the meeting chat find a meeting started from a personal chat with a short link', async () => {
    // Found in the first Azure test: short links carry no chat id, so "recap" in the meeting chat
    // answered "I have no meeting on record". The call reports its thread id once connected.
    const { service, store, sent } = build();
    await service.handleChat(personal('https://teams.microsoft.com/meet/4925781234567?p=AbCdEf'));
    const assignment = await service.claim();
    const id = assignment?.meetingId as string;
    expect((await store.getMeeting(id))?.conversationId).toBeUndefined();
    expect((await service.handleChat(meetingChat('recap')))[0]).toContain('no meeting on record');

    await service.onWorkerEvents(id, [{ type: 'state', state: 'connected', threadId: '19:meeting_xyz@thread.v2' }]);
    await store.appendSegments(id, SAMPLE_SEGMENTS);
    expect(await store.getMeeting(id)).toMatchObject({ threadId: '19:meeting_xyz@thread.v2' });
    expect((await service.handleChat(meetingChat('recap')))[0]).toContain('recap so far');
    // A second join from the meeting chat is recognised as the same meeting.
    expect((await service.handleChat(meetingChat('join', { resolveMeeting: async () => ({ joinUrl: LINK }) })))[0]).toContain('already in that meeting');
    // Notices still go to the personal chat it was started from, not the meeting chat.
    expect(sent.every((s) => s.conversationId !== '19:meeting_xyz@thread.v2')).toBe(true);
    // A thread id that is not a Teams chat id is ignored.
    await service.onWorkerEvents(id, [{ type: 'state', state: 'connected', threadId: 'not-a-thread' }]);
    expect((await store.getMeeting(id))?.threadId).toBe('19:meeting_xyz@thread.v2');
  });

  it('remembers earlier sessions of the same meeting chat when asked later', async () => {
    const { service, store, llm } = build();
    const chat = '19:meeting_xyz@thread.v2';
    const day1 = Date.parse('2026-11-16T09:00:00Z');
    const day3 = Date.parse('2026-11-18T09:00:00Z');
    const first = sampleMeeting({ id: newMeetingId(day1), conversationId: chat, status: 'ended', createdAt: new Date(day1).toISOString(), startedAt: new Date(day1).toISOString() });
    await store.createMeeting(first);
    await store.appendSegments(first.id, SAMPLE_SEGMENTS);
    await store.saveRecap(first.id, { title: 'Publishing sync', summary: 'Batch one goes to Marketing on Friday.', decisions: ['Batch one first.'], actions: [{ owner: 'Jordan', task: 'Publish batch one', due: 'Monday' }], explained: [], openQuestions: [] });
    // Two days later the same meeting chat meets again, and someone asks about last time.
    const second = sampleMeeting({ id: newMeetingId(day3), conversationId: chat, status: 'live', createdAt: new Date(day3).toISOString(), startedAt: new Date(day3).toISOString() });
    await store.createMeeting(second);
    await service.handleChat(meetingChat('what did we agree last time?'));
    const sent = JSON.stringify(llm.requests.at(-1)?.messages);
    expect(sent).toContain('<earlier_sessions>');
    expect(sent).toContain('Batch one goes to Marketing on Friday.');
    expect(sent).toContain('Jordan: Publish batch one (due Monday)');
    expect(sent).toContain('Monday, 16 November 2026 at 09:00 (UK time)');
    // A meeting in another chat is never mixed in.
    expect(sent).not.toContain('meeting_other');
  });

  it('leaves a new meeting to a waiting standby worker, with a fallback if it does not take it', async () => {
    const { service, store, dispatched } = build();
    // The standby worker polls and finds nothing, so it is waiting.
    expect(await service.claim({ standby: true })).toBeNull();
    await service.handleChat(personal(LINK));
    expect(dispatched()).toBe(0);
    // It takes the meeting; a later join must start a normal worker again.
    const assignment = await service.claim({ standby: true });
    expect(assignment?.joinUrl).toBe(LINK);
    await service.handleChat(personal('https://teams.microsoft.com/meet/111?p=a'));
    expect(dispatched()).toBe(1);
    // The safety net starts a worker only for a meeting nobody claimed.
    await service.dispatchIfStillPending(assignment?.meetingId as string);
    expect(dispatched()).toBe(1);
    const pending = (await store.listMeetingsByStatus(['pending']))[0];
    await service.dispatchIfStillPending(pending?.id as string);
    expect(dispatched()).toBe(2);
  });

  it('runs a private summary call about the caller\'s own meetings, and locks when anyone else joins', async () => {
    const { service, store, llm, sent } = build({ reply: () => ({ text: 'Batch one goes to Marketing on Friday.' }) });
    // A meeting Alex attended, and one Alex did not.
    const day1 = Date.parse('2026-11-16T09:00:00Z');
    const attended = sampleMeeting({ id: newMeetingId(day1), status: 'ended', createdAt: new Date(day1).toISOString() });
    await store.createMeeting(attended);
    await store.appendSegments(attended.id, SAMPLE_SEGMENTS);
    await store.saveRecap(attended.id, { title: 'Publishing sync', summary: 'Batch one goes to Marketing on Friday.', decisions: [], actions: [], explained: [], openQuestions: [] });
    await store.linkUserToMeeting('aad-alex', { meetingId: attended.id, title: attended.title, createdAt: attended.createdAt });
    const other = sampleMeeting({ id: newMeetingId(day1 + 1000), status: 'ended', conversationId: '19:meeting_other@thread.v2', createdAt: new Date(day1 + 1000).toISOString() });
    await store.createMeeting(other);
    await store.saveRecap(other.id, { title: 'Board pay review', summary: 'Confidential salary figures were discussed.', decisions: [], actions: [], explained: [], openQuestions: [] });

    // Alex starts a Meet now and asks for a summary call in the personal chat.
    const reply = await service.handleChat(personal('summary call https://teams.microsoft.com/meet/999?p=x'));
    expect(reply[0]).toContain('private summary call');
    const assignment = await service.claim();
    expect(assignment).toMatchObject({ alwaysListening: true, announceOnJoin: true, announcement: "Hi, it's Claude. Which meeting would you like to catch up on?" });
    const id = assignment?.meetingId as string;
    expect((await store.getMeeting(id))?.kind).toBe('summary');
    await service.onWorkerEvents(id, [
      { type: 'state', state: 'connected' },
      { type: 'participants', participants: [{ id: 'aad-alex', aadObjectId: 'aad-alex', displayName: 'Alex Morgan', kind: 'teams' }] },
    ]);
    expect(sent.some((s) => s.markdown.includes('transcribing'))).toBe(false);

    // Alone with the assistant: it answers from the meetings Alex attended, and only those.
    const lines: AnswerLine[] = [];
    await service.answerVoice(id, { speakerAadId: 'aad-alex', speakerName: 'Alex Morgan', question: 'Summarise my last meeting' }, (l) => void lines.push(l));
    expect(lines.some((l) => l.type === 'sentence')).toBe(true);
    const request = llm.requests.at(-1);
    expect(JSON.stringify(request?.system)).toContain('private voice call');
    expect(JSON.stringify(request?.messages)).toContain('Meetings Alex Morgan attended');
    expect(JSON.stringify(request?.messages)).toContain('Publishing sync');
    expect(JSON.stringify(request?.messages)).not.toContain('Confidential salary');
    // Nothing from a private call is posted to chat.
    expect(sent.some((s) => s.markdown.includes('asked:'))).toBe(false);

    // Someone else joins: the lock engages and the model is not called.
    const before = llm.requests.length;
    await service.onWorkerEvents(id, [{ type: 'participants', participants: [{ id: 'aad-jordan', aadObjectId: 'aad-jordan', displayName: 'Jordan', kind: 'teams' }] }]);
    const locked: AnswerLine[] = [];
    await service.answerVoice(id, { speakerAadId: 'aad-alex', speakerName: 'Alex Morgan', question: 'And the one before?' }, (l) => void locked.push(l));
    expect(llm.requests.length).toBe(before);
    expect(locked.find((l) => l.type === 'done')).toMatchObject({ text: expect.stringContaining('just you and me') });
    // Jordan was never given access to the private call.
    expect(await store.userHasMeeting('aad-jordan', id)).toBe(false);

    // When it ends there is no recap and no message.
    const messagesBefore = sent.length;
    await service.finalise(id, 'everyone else left');
    expect(await store.getRecap(id)).toBeNull();
    expect(sent.length).toBe(messagesBefore);
    // A "recap" in the personal chat refers to a real meeting, never the private call.
    expect((await service.handleChat(personal('recap')))[0]).not.toContain('private');
  });

  it('treats the caller as alone only when nobody else has been in the call', () => {
    const alex = { id: 'aad-alex', aadObjectId: 'aad-alex', displayName: 'Alex Morgan', kind: 'teams' as const };
    const base = sampleMeeting({ kind: 'summary', participants: [alex] });
    expect(callerIsAlone(base, 'aad-alex')).toBe(true);
    expect(callerIsAlone(base, 'aad-jordan')).toBe(false);
    expect(callerIsAlone(base, undefined)).toBe(false);
    expect(callerIsAlone({ ...base, participants: [] }, 'aad-alex')).toBe(false);
    expect(callerIsAlone({ ...base, participants: [alex, { id: 'guest', displayName: 'Guest', kind: 'unknown' }] }, 'aad-alex')).toBe(false);
  });

  it('answers general knowledge questions up to the per meeting allowance, and counts only those', async () => {
    let reply = '[general] KPI stands for key performance indicator. That is general knowledge, not from this meeting.';
    const { service, store, llm } = build({ reply: () => ({ text: reply }) });
    const live = sampleMeeting({ conversationId: '19:meeting_xyz@thread.v2', status: 'live' });
    await store.createMeeting(live);

    const answer = await service.handleChat(meetingChat('what does KPI stand for?'));
    expect(answer[0]).toBe('KPI stands for key performance indicator. That is general knowledge, not from this meeting.');
    expect(JSON.stringify(llm.requests.at(-1)?.system)).toContain('20 general questions remain');
    expect((await store.getMeeting(live.id))?.generalQuestions).toBe(1);

    // An answer about the meeting itself does not use the allowance.
    reply = 'Alex said batch one goes to Marketing on Friday.';
    await service.handleChat(meetingChat('what did Alex say?'));
    expect((await store.getMeeting(live.id))?.generalQuestions).toBe(1);

    // Once the allowance is used, the model is told to say so.
    await store.updateMeeting(live.id, { generalQuestions: 20 });
    await service.handleChat(meetingChat('what is the capital of Peru?'));
    expect(JSON.stringify(llm.requests.at(-1)?.system)).toContain('limit of 20 general questions for this meeting has been reached');

    // Switched off entirely with 0.
    const off = build({ env: { GENERAL_QUESTIONS_PER_MEETING: '0' } });
    await off.store.createMeeting(sampleMeeting({ conversationId: '19:meeting_xyz@thread.v2', status: 'live' }));
    await off.service.handleChat(meetingChat('what does KPI stand for?'));
    expect(JSON.stringify(off.llm.requests.at(-1)?.system)).not.toContain('General knowledge');
  });

  it('lets only admins connect the assistant Teams account, and reports the code and the result in chat', async () => {
    const connects: string[] = [];
    const account: TeamsAccount = {
      status: async () => ({ connected: false, account: 'claude.assistant@example.com' }),
      connect: async (onCode) => {
        await onCode('Open the sign in page and enter the code ABC123.');
        connects.push('done');
        return 'Connected.';
      },
      getToken: async () => ({ token: 't', expiresOn: Date.now() + 3_600_000, userId: 'aad-assistant' }),
    };
    const { service, sent } = build({ teamsAccount: account, env: { ADMIN_AAD_IDS: 'aad-admin' } });
    expect((await service.handleChat(personal('connect assistant account')))[0]).toContain('Only an administrator');
    expect(connects).toHaveLength(0);
    const admin = { aadObjectId: 'aad-admin', name: 'IT Admin' };
    expect((await service.handleChat(personal('connect assistant account', admin)))[0]).toContain('Starting the sign in');
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.map((s) => s.markdown)).toEqual(['Open the sign in page and enter the code ABC123.', 'Connected.']);
    expect(sent.every((s) => s.conversationId === 'a:aad-admin')).toBe(true);
    // Not offered in group chats at all.
    expect((await service.handleChat(meetingChat('connect assistant account')))[0]).not.toContain('Starting the sign in');
  });

  it('answers calls to the assistant account from staff only, as a private call or a meeting', async () => {
    let connected = false;
    const account: TeamsAccount = {
      status: async () => ({ connected, account: 'claude.assistant@example.com' }),
      connect: async () => 'Connected.',
      getToken: async () => {
        if (!connected) throw new Error('not connected');
        return { token: 'teams-token', expiresOn: Date.now() + 3_600_000, userId: 'aad-assistant' };
      },
    };
    const { service, store, identities } = build({ teamsAccount: account });
    const direct = { callerAadId: 'aad-alex', callerName: 'Alex Morgan', groupCall: false };
    expect(await service.acceptIncomingCall(direct)).toEqual({ reject: 'the assistant account is not connected' });
    connected = true;
    // Alex has never used the app, so the call is refused.
    expect(await service.acceptIncomingCall(direct)).toEqual({ reject: 'caller not recognised' });
    await service.handleChat(personal('help'));

    // A direct call becomes a private summary call, signed in as the assistant account.
    const one = await service.acceptIncomingCall(direct);
    if (!('assignment' in one)) throw new Error('expected the call to be taken');
    expect(one.assignment).toMatchObject({ acsToken: 'teams-token', acsUserId: 'aad-assistant', alwaysListening: true });
    const privateCall = await store.getMeeting(one.assignment.meetingId);
    expect(privateCall).toMatchObject({ kind: 'summary', via: 'teams-user', status: 'claimed', invitedByAadId: 'aad-alex' });

    // Being added to a call with others is a normal meeting with the transcribing announcement.
    const two = await service.acceptIncomingCall({ ...direct, groupCall: true, threadId: '19:call_abc@thread.v2' });
    if (!('assignment' in two)) throw new Error('expected the call to be taken');
    expect(two.assignment.alwaysListening).toBeUndefined();
    expect(two.assignment.announcement).toContain("I'm transcribing");
    expect(await store.getMeeting(two.assignment.meetingId)).toMatchObject({ threadId: '19:call_abc@thread.v2', via: 'teams-user' });
    expect((await store.getMeeting(two.assignment.meetingId))?.kind).toBeUndefined();

    // The assistant's own account is never deleted the way a guest identity is.
    await service.onWorkerEvents(one.assignment.meetingId, [{ type: 'state', state: 'connected' }]);
    await service.finalise(one.assignment.meetingId, 'call ended');
    expect(identities.revoked).not.toContain('aad-assistant');
  });

  it('recognises staff as soon as the app is installed for them, but not people from other organisations', async () => {
    let connected = true;
    const account: TeamsAccount = {
      status: async () => ({ connected, account: 'claude.assistant@example.com' }),
      connect: async () => 'Connected.',
      getToken: async () => ({ token: 'teams-token', expiresOn: Date.now() + 3_600_000, userId: 'aad-assistant' }),
    };
    const { service, store } = build({ teamsAccount: account });
    const jordan = { aadObjectId: 'aad-jordan', name: 'Jordan', tenantId: 'tenant-1', conversationId: 'a:jordan' };
    expect(await service.registerInstall(jordan)).toBe(true);
    expect(await store.getUser('aad-jordan')).toMatchObject({ name: 'Jordan', conversationId: 'a:jordan' });
    // Jordan never sent a message, yet a call from Jordan is now taken.
    expect('assignment' in (await service.acceptIncomingCall({ callerAadId: 'aad-jordan', callerName: 'Jordan', groupCall: false }))).toBe(true);
    // Another organisation's install is ignored, so its people stay unrecognised.
    expect(await service.registerInstall({ ...jordan, aadObjectId: 'aad-outsider', tenantId: 'tenant-other' })).toBe(false);
    expect(await store.getUser('aad-outsider')).toBeNull();
    connected = false;
  });

  it('sends the recap of a call to every attendee in their own chat with the app, and closes unanswered calls quietly', async () => {
    const account: TeamsAccount = {
      status: async () => ({ connected: true, account: 'claude.assistant@example.com' }),
      connect: async () => 'Connected.',
      getToken: async () => ({ token: 'teams-token', expiresOn: Date.now() + 3_600_000, userId: 'aad-assistant' }),
    };
    const { service, store, sent } = build({ teamsAccount: account, reply: () => ({ text: JSON.stringify({ title: 'Course fees', summary: 'Alex and Jordan agreed the course fees.', decisions: [], actions: [], explained: [], openQuestions: [] }) }) });
    // Alex and Jordan both use the app; a guest in the call does not.
    await service.registerInstall({ aadObjectId: 'aad-alex', name: 'Alex Morgan', tenantId: 'tenant-1', conversationId: 'a:alex' });
    await service.registerInstall({ aadObjectId: 'aad-jordan', name: 'Jordan', tenantId: 'tenant-1', conversationId: 'a:jordan' });

    // Alex adds Claude Assistant to a one-to-one call with Jordan.
    const taken = await service.acceptIncomingCall({ callerAadId: 'aad-alex', callerName: 'Alex Morgan', groupCall: true, threadId: '19:call_xyz@thread.v2' });
    if (!('assignment' in taken)) throw new Error('expected the call to be taken');
    const id = taken.assignment.meetingId;
    await service.onWorkerEvents(id, [
      { type: 'state', state: 'connected' },
      { type: 'participants', participants: [
        { id: 'aad-alex', aadObjectId: 'aad-alex', displayName: 'Alex Morgan', kind: 'teams' },
        { id: 'aad-jordan', aadObjectId: 'aad-jordan', displayName: 'Jordan', kind: 'teams' },
        { id: 'guest-1', displayName: 'Visitor', kind: 'unknown' },
      ] },
      { type: 'segments', segments: SAMPLE_SEGMENTS },
    ]);
    sent.length = 0;
    await service.finalise(id, 'everyone else left');
    const recaps = sent.filter((s) => s.markdown.startsWith('**Recap: Course fees**'));
    expect(recaps.map((s) => s.conversationId).sort()).toEqual(['a:alex', 'a:jordan']);

    // A call to Claude Assistant that was taken but never connected closes without any message.
    const unanswered = await service.acceptIncomingCall({ callerAadId: 'aad-alex', callerName: 'Alex Morgan', groupCall: true, threadId: '19:call_abc@thread.v2' });
    if (!('assignment' in unanswered)) throw new Error('expected the call to be taken');
    sent.length = 0;
    await service.finalise(unanswered.assignment.meetingId, 'worker stopped responding');
    expect(sent).toEqual([]);
    expect((await store.getMeeting(unanswered.assignment.meetingId))?.status).toBe('failed');
  });

  it('still posts the recap once in the meeting chat when there is one', async () => {
    const { service, store, sent } = build({ reply: () => ({ text: JSON.stringify({ title: 'Weekly', summary: 'A weekly meeting.', decisions: [], actions: [], explained: [], openQuestions: [] }) }) });
    await service.registerInstall({ aadObjectId: 'aad-jordan', name: 'Jordan', tenantId: 'tenant-1', conversationId: 'a:jordan' });
    const meeting = sampleMeeting({ conversationId: '19:meeting_xyz@thread.v2', status: 'live' });
    await store.createMeeting(meeting);
    await store.appendSegments(meeting.id, SAMPLE_SEGMENTS);
    await service.finalise(meeting.id, 'meeting ended');
    const recaps = sent.filter((s) => s.markdown.startsWith('**Recap: Weekly**'));
    expect(recaps.map((s) => s.conversationId)).toEqual(['19:meeting_xyz@thread.v2']);
  });

  it('encrypts the stored sign in so it is useless without the service secret', () => {
    const secret = 'a-long-enough-shared-secret-for-the-test';
    const sealed = encryptCache('{"RefreshToken":{"x":"secret-refresh-token"}}', secret);
    expect(sealed).not.toContain('secret-refresh-token');
    expect(decryptCache(sealed, secret)).toContain('secret-refresh-token');
    expect(() => decryptCache(sealed, 'some-other-secret-of-similar-length')).toThrow();
    // Tampering is detected.
    const tampered = Buffer.from(sealed, 'base64');
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    expect(() => decryptCache(tampered.toString('base64'), secret)).toThrow();
  });

  it('enforces the concurrency limit and the monthly budget', async () => {
    const limited = build({ env: { MAX_CONCURRENT_MEETINGS: '1' } });
    await limited.service.handleChat(personal(LINK));
    expect((await limited.service.handleChat(personal('https://teams.microsoft.com/meet/111?p=a')))[0]).toContain('limit set by your admin');

    const broke = build({ env: { MONTHLY_BUDGET_USD: '5' } });
    await broke.store.addUsage({ kind: 'meeting', usd: 5.01, quantity: 200 });
    expect((await broke.service.handleChat(personal(LINK)))[0]).toContain('monthly budget');
    expect(broke.dispatched()).toBe(0);
    expect((await broke.service.handleChat(personal('status')))[0]).toContain('$5.01 of a $5.00 budget');
  });

  it('answers a question in the meeting chat from that meeting, and a personal question with tools', async () => {
    const { service, store, llm } = build({ reply: (i) => (i === 0 ? { text: 'Batch one goes to Marketing on Friday.' } : i === 1 ? { toolName: 'list_meetings', toolInput: {} } : { text: 'You have one meeting on record.' }) });
    const meeting = sampleMeeting({ conversationId: '19:meeting_xyz@thread.v2' });
    await store.createMeeting(meeting);
    await store.appendSegments(meeting.id, SAMPLE_SEGMENTS);
    await store.linkUserToMeeting(alex.aadObjectId, { meetingId: meeting.id, title: meeting.title, createdAt: meeting.createdAt });

    expect(await service.handleChat(meetingChat('when does batch one go out?'))).toEqual(['Batch one goes to Marketing on Friday.']);
    expect(llm.requests[0]?.model).toBe('claude-haiku-5-5');
    expect(llm.requests[0]?.system[0]?.text).toContain('Teams chat');

    expect(await service.handleChat(personal('which meetings do I have?'))).toEqual(['You have one meeting on record.']);
    expect(llm.requests[1]?.model).toBe('claude-sonnet-5-5');
    expect(JSON.stringify(llm.requests[2]?.messages)).toContain('Course page publishing sync');
    expect(store.usage.map((u) => u.entry.detail)).toEqual(['chat answer', 'history answer']);
  });

  it('closes meetings whose worker died and purges expired ones', async () => {
    let now = Date.parse('2026-11-16T09:00:00Z');
    const { service, store, sent } = build({ now: () => now });
    await service.handleChat(personal(LINK));
    now += 5 * 60_000;
    expect(await service.reapStale()).toBe(1);
    const failed = (await store.listMeetingsByStatus(['failed']))[0];
    expect(failed?.endReason).toBe('no worker picked it up');
    expect(sent.at(-1)?.markdown).toContain('I could not join the meeting');

    const old = sampleMeeting({ id: newMeetingId(now - 100 * 86_400_000), status: 'ended', createdAt: new Date(now - 100 * 86_400_000).toISOString(), conversationId: 'c-old' });
    await store.createMeeting(old);
    await store.appendSegments(old.id, SAMPLE_SEGMENTS);
    expect(await service.purgeExpired()).toBe(1);
    expect(await store.getMeeting(old.id)).toBeNull();
    expect(await store.getMeeting(failed?.id as string)).not.toBeNull();
  });
});

describe('commands and mentions', () => {
  it('removes the mention of the bot from the message text', () => {
    const entities = [{ type: 'mention', text: '<at>Claude Meeting Assistant</at>', mentioned: { id: '28:bot' } }, { type: 'mention', text: '<at>Jordan</at>', mentioned: { id: '29:user' } }];
    expect(stripBotMention('<at>Claude Meeting Assistant</at> join', entities, '28:bot')).toBe('join');
    expect(stripBotMention('<at>Claude Meeting Assistant</at> what did <at>Jordan</at> agree?', entities, '28:bot')).toBe('what did Jordan agree?');
    expect(stripBotMention('recap please', undefined, '28:bot')).toBe('recap please');
  });

  it('recognises short commands but treats longer sentences as questions', async () => {
    const { service, llm, dispatched } = build({ reply: () => ({ text: 'A considered answer.' }) });
    const resolveMeeting = async () => ({ joinUrl: LINK, title: 'Weekly' });
    expect((await service.handleChat(meetingChat('can you join', { resolveMeeting })))[0]).toContain('On my way');
    expect(dispatched()).toBe(1);
    expect((await service.handleChat(meetingChat('Please leave now.')))[0]).toContain('Leaving now');
    const asked = await service.handleChat(meetingChat('Who did we agree should join the pilot programme next month?'));
    expect(asked).toEqual(['A considered answer.']);
    expect(llm.requests).toHaveLength(1);
    expect((await service.handleChat(meetingChat('give me a recap')))[0]).toContain('Nothing has been said yet');
  });
});

describe('Teams SDK wiring', () => {
  it('serves the worker API and the Teams endpoint from one server, and Teams rejects unsigned calls', async () => {
    const { service, config } = build({ env: { CLIENT_ID: '00000000-0000-0000-0000-000000000001', CLIENT_SECRET: 'not-a-real-secret' } });
    const adapter = new ExpressAdapter();
    const app = createTeamsApp(config, adapter);
    mountInternalApi(adapter, service, SECRET);
    wireTeams(app, service);
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    await app.start(port);
    try {
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/internal/claim`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } })).status).toBe(204);
      const unsigned = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'message', text: 'hi' }) });
      expect([401, 403]).toContain(unsigned.status);
    } finally {
      await app.stop();
    }
  }, 30_000);
});
