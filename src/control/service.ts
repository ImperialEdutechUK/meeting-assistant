// The control service logic. It knows nothing about the Teams SDK or the web server: those are
// thin adapters in teams.ts and internal-api.ts. That separation is what lets the whole flow be
// tested on a laptop.

import { type Asker, type Brain, type EarlierSession, recapMarkdown } from '../core/brain.js';
import type { ControlConfig } from '../core/config.js';
import { meetingToken, monthKey, newMeetingId } from '../core/ids.js';
import type { KnowledgeBase } from '../core/kb.js';
import { type Logger, errorMessage, logger } from '../core/log.js';
import { type Prices, meetingCost, ttsCost } from '../core/pricing.js';
import { chatJoinNotice, joinAnnouncement, summaryCallGreeting } from '../core/prompts.js';
import type { Store } from '../core/store.js';
import { formatTranscript } from '../core/transcript.js';
import type { CachingTts } from '../core/tts.js';
import type { AnswerLine, IncomingCallInfo, Meeting, MeetingStatus, Participant, WorkerAssignment, WorkerEvent } from '../core/types.js';
import type { TeamsToken } from './teams-identity.js';

/** Sends a message into a Teams conversation. Implemented by the Teams adapter. */
export interface Notifier {
  send(conversationId: string, markdown: string): Promise<void>;
}

/** Starts a worker that will claim the next pending meeting. */
export interface Dispatcher {
  start(): Promise<void>;
}

/** Issues the calling identity a worker joins the meeting with. */
export interface CallIdentityIssuer {
  issue(validMinutes: number): Promise<{ token: string; userId: string }>;
  revoke(userId: string): Promise<void>;
}

export interface ChatMessage {
  /** Text with the mention of the bot already removed. */
  text: string;
  user: { aadObjectId: string; name: string };
  tenantId: string;
  conversationId: string;
  conversationType: 'personal' | 'groupChat' | 'channel';
  /** Looks up the join link of the meeting this chat belongs to, when the chat is a meeting chat. */
  resolveMeeting?: () => Promise<{ joinUrl: string; title?: string } | null>;
}

/** What the service needs from the assistant's Teams account. TeamsIdentity implements it. */
export interface TeamsAccount {
  status(): Promise<{ connected: boolean; account: string }>;
  connect(onCode: (instructions: string) => Promise<void>): Promise<string>;
  getToken(): Promise<TeamsToken>;
}

export interface ControlDeps {
  config: ControlConfig;
  store: Store;
  brain: Brain;
  kb: KnowledgeBase;
  tts: CachingTts;
  notifier: Notifier;
  dispatcher: Dispatcher;
  identities: CallIdentityIssuer;
  prices: Prices;
  /** The assistant's own Teams account, when configured (see teams-identity.ts). */
  teamsAccount?: TeamsAccount;
  now?: () => number;
  log?: Logger;
}

const ACTIVE: MeetingStatus[] = ['pending', 'claimed', 'lobby', 'live'];
const JOIN_URL = /https:\/\/teams\.microsoft\.com\/(?:v2\/\?meetingjoin=true#\/)?(?:l\/meetup-join\/|meet\/)[^\s"'<>]+/i;
const PERSONAL_TEAMS_URL = /https:\/\/teams\.live\.com\/meet\//i;

const PRIVATE_CALL_LOCKED = 'Someone else is in this call, so I can only talk about your meetings when it is just you and me.';

/**
 * A summary call may discuss the caller's meetings only when the question comes from the person
 * who started it and nobody else has been in the call. The roster lists everyone ever present.
 */
export function callerIsAlone(meeting: Meeting, speakerAadId: string | undefined): boolean {
  if (!speakerAadId || speakerAadId !== meeting.invitedByAadId) return false;
  return meeting.participants.length > 0 && meeting.participants.every((p) => p.aadObjectId === meeting.invitedByAadId);
}

/** Words that turn a pasted link into a private summary call rather than a normal meeting join. */
const SUMMARY_CALL = /\b(summary|summari[sz]e|catch[ -]?up|private call)\b/;

export function extractJoinUrl(text: string): string | null {
  const match = JOIN_URL.exec(text.replace(/&amp;/g, '&'));
  return match ? match[0].replace(/[).,]+$/, '') : null;
}

/** Meeting chat thread id, when the join link carries one. */
export function threadIdFromJoinUrl(url: string): string | undefined {
  const match = /meetup-join\/([^/]+)\//i.exec(url);
  if (!match?.[1]) return undefined;
  try {
    const decoded = decodeURIComponent(match[1]);
    return decoded.startsWith('19:') ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export class ControlService {
  private readonly log: Logger;
  private readonly now: () => number;
  private kbVersion: string | undefined;
  private spendCache: { at: number; month: string; usd: number } | null = null;
  private readonly finalising = new Set<string>();
  private readonly earlierCache = new Map<string, { at: number; sessions: EarlierSession[] }>();
  /** When a standby worker last asked for work and found none. */
  private standbyPolledAt = 0;

  constructor(private readonly d: ControlDeps) {
    this.log = d.log ?? logger('control');
    this.now = d.now ?? Date.now;
  }

  private get persona() {
    return { name: this.d.config.assistantName, organisation: this.d.config.organisation };
  }

  // ---------------------------------------------------------------------------------------
  // Teams chat
  // ---------------------------------------------------------------------------------------

  /** Handles one chat message and returns the replies to post in the same conversation. */
  async handleChat(message: ChatMessage): Promise<string[]> {
    const { config, store } = this.d;
    if (!config.allowedTenantIds.includes(message.tenantId)) {
      this.log.warn('Message from a tenant that is not allowed', { tenantId: message.tenantId });
      return [`Sorry, ${config.assistantName} is only available to ${config.organisation} staff.`];
    }
    await store.saveUser({
      aadObjectId: message.user.aadObjectId,
      name: message.user.name,
      tenantId: message.tenantId,
      seenAt: new Date(this.now()).toISOString(),
      ...(message.conversationType === 'personal' ? { conversationId: message.conversationId } : {}),
    });

    const text = message.text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();
    const hasLink = extractJoinUrl(message.text) !== null;

    if (lower === '' || /^(help|hi|hello|\?)$/.test(lower)) return [this.helpText()];
    if (PERSONAL_TEAMS_URL.test(message.text)) {
      return ['That link is for Teams personal accounts (teams.live.com), which I cannot join. I can join meetings hosted on Teams for work.'];
    }
    // Commands are recognised at the start of a message, or anywhere in a very short one
    // ("can you join", "please leave now"), so that longer questions are never mistaken for them.
    const brief = lower.split(' ').length <= 5;
    const command = (word: RegExp) => new RegExp(`^(please )?${word.source}\\b`).test(lower) || (brief && new RegExp(`\\b${word.source}\\b`).test(lower));
    // Admin only: connect the assistant's own Teams account, or check it.
    if (message.conversationType === 'personal' && /^connect (the )?assistant( teams)? account$/.test(lower)) return this.connectAssistantAccount(message);
    if (message.conversationType === 'personal' && /^assistant( teams)? account( status)?$/.test(lower)) return this.assistantAccountStatus(message);
    // "summary call <link>" in a personal chat: a private call to catch up on past meetings.
    if (hasLink && message.conversationType === 'personal' && SUMMARY_CALL.test(lower)) return this.join(message, 'summary');
    if (hasLink || command(/join/)) return this.join(message);
    if (command(/leave/) || /^(stop|go away)[.!]?$/.test(lower)) return this.leave(message);
    if (command(/recap/)) return this.recap(message);
    if (/^(status|usage)\b/.test(lower)) return this.status();
    return this.question(message, text);
  }

  /**
   * The app was installed in someone's personal Teams. Recording them now means they are
   * recognised as staff (for calls to the assistant and company answers) and can receive recaps,
   * without first sending a message. People from other organisations are ignored.
   */
  async registerInstall(user: { aadObjectId: string; name: string; tenantId: string; conversationId: string }): Promise<boolean> {
    if (!this.d.config.allowedTenantIds.includes(user.tenantId)) {
      this.log.warn('Installation from a tenant that is not allowed', { tenantId: user.tenantId });
      return false;
    }
    await this.d.store.saveUser({ ...user, seenAt: new Date(this.now()).toISOString() });
    this.log.info('App installed, person recorded as staff', { name: user.name });
    return true;
  }

  private isAdmin(message: ChatMessage): boolean {
    return this.d.config.adminAadIds.includes(message.user.aadObjectId);
  }

  private async connectAssistantAccount(message: ChatMessage): Promise<string[]> {
    const account = this.d.teamsAccount;
    if (!account) return ['The assistant Teams account is not configured. Set TEAMS_IDENTITY_CLIENT_ID and TEAMS_ASSISTANT_UPN first (see docs/TEAMS-ACCOUNT-SETUP.md).'];
    if (!this.isAdmin(message)) {
      this.log.warn('Someone who is not an admin tried to connect the assistant account', { by: message.user.name });
      return ['Only an administrator can connect the assistant account.'];
    }
    const send = (text: string) => this.d.notifier.send(message.conversationId, text).catch((err) => this.log.warn('Could not send a sign in message', { error: errorMessage(err) }));
    // The sign in takes as long as the admin needs, so it runs in the background and reports here.
    void account.connect(send).then(send);
    return ['Starting the sign in for the assistant account. A code follows in a moment.'];
  }

  private async assistantAccountStatus(message: ChatMessage): Promise<string[]> {
    const account = this.d.teamsAccount;
    if (!account) return ['The assistant Teams account is not configured.'];
    if (!this.isAdmin(message)) return ['Only an administrator can check the assistant account.'];
    const status = await account.status();
    if (!status.connected) return [`**${status.account}** is not connected. Send \`connect assistant account\` to connect it.`];
    const token = await this.teamsToken();
    return [token ? `**${status.account}** is connected and can take calls while the call receiver runs.` : `**${status.account}** is connected, but a calling token could not be made. Check the service logs.`];
  }

  helpText(): string {
    const name = this.d.config.assistantName;
    return [
      `**I am ${name}, an AI meeting assistant.** I can join a Teams meeting, follow it through live captions, answer questions aloud or in chat, and write a recap.`,
      '',
      '**In a meeting chat**',
      `* \`@${name} join\` and I join the call. Admit me from the lobby if asked.`,
      `* Say **"Hey ${name}, ..."** in the call to ask me something aloud.`,
      `* \`@${name} recap\` for a recap so far, \`@${name} leave\` to send me away.`,
      `* Or mention me with any question about the meeting.`,
      '',
      '**In this personal chat**',
      '* Paste a Teams meeting link and I will join it.',
      '* For a private voice catch-up: start a **Meet now** meeting, then send `summary call` with its link. Nobody else is invited.',
      '* Ask about meetings you attended, for example "What did I explain to each person yesterday?"',
      '* Ask about company information, for example "What is our refund policy?"',
      '',
      `I keep meeting transcripts for ${this.d.config.retentionDays} days. I do not record audio or video.`,
    ].join('\n');
  }

  private async join(message: ChatMessage, kind: 'meeting' | 'summary' = 'meeting'): Promise<string[]> {
    const { config, store } = this.d;
    let joinUrl = extractJoinUrl(message.text);
    let title = 'Teams meeting';
    if (!joinUrl && message.resolveMeeting) {
      try {
        const found = await message.resolveMeeting();
        if (found) {
          joinUrl = found.joinUrl;
          title = found.title?.trim() || title;
        }
      } catch (err) {
        this.log.warn('Could not look up the meeting for this chat', { error: errorMessage(err) });
      }
    }
    if (!joinUrl) {
      return ['I need the meeting link. Paste the Teams join link here and I will join. In a meeting chat you can simply mention me and type join.'];
    }

    const conversationId = message.conversationType === 'personal' ? threadIdFromJoinUrl(joinUrl) : message.conversationId;
    const active = await store.listMeetingsByStatus(ACTIVE);
    const already = active.find((m) => m.joinUrl === joinUrl || (conversationId !== undefined && (m.conversationId === conversationId || m.threadId === conversationId)));
    if (already) {
      return [already.status === 'live' ? 'I am already in that meeting.' : 'I am already on my way to that meeting.'];
    }
    if (active.length >= config.maxConcurrentMeetings) {
      return [`I am already in ${active.length} meetings, which is the limit set by your admin. Please try again when one ends.`];
    }
    const spend = await this.monthSpend();
    if (spend >= config.monthlyBudgetUsd) {
      this.log.warn('Monthly budget reached, refusing to join', { spend, budget: config.monthlyBudgetUsd });
      return ['The monthly budget for the meeting assistant has been reached, so I cannot join more meetings this month. Please contact your admin.'];
    }

    const nowIso = new Date(this.now()).toISOString();
    const meeting: Meeting = {
      id: newMeetingId(this.now()),
      status: 'pending',
      title,
      joinUrl,
      ...(conversationId ? { conversationId } : {}),
      ...(kind === 'summary' ? { kind } : {}),
      tenantId: message.tenantId,
      invitedByAadId: message.user.aadObjectId,
      invitedByName: message.user.name,
      createdAt: nowIso,
      heartbeatAt: nowIso,
      participants: [],
    };
    await store.createMeeting(meeting);
    await store.linkUserToMeeting(message.user.aadObjectId, { meetingId: meeting.id, title, createdAt: nowIso });
    try {
      if (this.standbyIsWaiting()) {
        // A warm standby worker will claim it within a second. If it does not, start one anyway.
        this.log.info('Leaving the meeting to the standby worker', { meetingId: meeting.id });
        setTimeout(() => void this.dispatchIfStillPending(meeting.id), 6000).unref?.();
      } else {
        await this.d.dispatcher.start();
      }
    } catch (err) {
      this.log.error('Could not start a worker', { error: errorMessage(err), meetingId: meeting.id });
      await store.updateMeeting(meeting.id, { status: 'failed', endReason: 'dispatch failed', endedAt: nowIso });
      return ['Sorry, I could not start. Your admin can find the reason in the service logs.'];
    }
    this.log.info('Join requested', { meetingId: meeting.id, by: message.user.name, kind });
    if (kind === 'summary') {
      return [`Joining your private summary call as **${config.displayName}**. Admit me from the lobby, then just ask, for example "summarise my last meeting". Nobody else is notified.`];
    }
    return [`On my way. I will appear as **${config.displayName}** in about a minute. If I land in the lobby, please admit me.`];
  }

  /** Safety net for the standby path: start a worker if nobody has claimed the meeting yet. */
  async dispatchIfStillPending(meetingId: string): Promise<void> {
    try {
      const meeting = await this.d.store.getMeeting(meetingId);
      if (meeting?.status !== 'pending') return;
      this.log.warn('Standby worker did not take the meeting, starting a worker', { meetingId });
      await this.d.dispatcher.start();
    } catch (err) {
      this.log.error('Could not start a fallback worker', { meetingId, error: errorMessage(err) });
    }
  }

  private async meetingForChat(message: ChatMessage, statuses?: MeetingStatus[]): Promise<Meeting | null> {
    const { store } = this.d;
    if (message.conversationType !== 'personal') {
      const m = await store.findLatestMeetingForConversation(message.conversationId);
      // A private summary call is never shown in a group chat, even its own meeting chat.
      return m && m.kind !== 'summary' && (!statuses || statuses.includes(m.status)) ? m : null;
    }
    // In a personal chat, use the newest meeting this person invited the assistant to.
    for (const ref of await store.listUserMeetings(message.user.aadObjectId, 10)) {
      const m = await store.getMeeting(ref.meetingId);
      // "recap" means a real meeting, never a private summary call; "leave" may end either.
      const eligible = m && m.invitedByAadId === message.user.aadObjectId && (!statuses || statuses.includes(m.status));
      if (eligible && (m.kind !== 'summary' || statuses !== undefined)) return m;
    }
    return null;
  }

  private async leave(message: ChatMessage): Promise<string[]> {
    const meeting = await this.meetingForChat(message, ACTIVE);
    if (!meeting) return ['I am not in a meeting for this chat.'];
    await this.d.store.updateMeeting(meeting.id, { leaveRequested: true });
    return ['Leaving now. I will post the recap in a moment.'];
  }

  /** Called when Teams reports that a meeting has ended, so the assistant does not linger. */
  async requestLeaveForConversation(conversationId: string): Promise<boolean> {
    const meeting = await this.d.store.findLatestMeetingForConversation(conversationId);
    if (!meeting || !ACTIVE.includes(meeting.status)) return false;
    await this.d.store.updateMeeting(meeting.id, { leaveRequested: true });
    return true;
  }

  private async recap(message: ChatMessage): Promise<string[]> {
    const { store, brain } = this.d;
    const meeting = await this.meetingForChat(message);
    if (!meeting) return ['I have no meeting on record for this chat yet.'];
    const people = meeting.participants.map((p) => p.displayName);
    const stored = await store.getRecap(meeting.id);
    if (stored) return [recapMarkdown(stored, { minutes: meeting.minutes, people })];
    const segments = await store.getSegments(meeting.id);
    if (segments.length === 0) return ['Nothing has been said yet that I could recap.'];
    const { recap, costUsd, usage } = await brain.buildRecap(meeting, segments);
    await store.addUsage({ kind: 'llm', meetingId: meeting.id, usd: costUsd, quantity: usage.inputTokens + usage.outputTokens, detail: 'interim recap' });
    return [`${recapMarkdown(recap, { people })}\n\n_This is a recap so far. The final recap follows when the meeting ends._`];
  }

  private async status(): Promise<string[]> {
    const { config, store } = this.d;
    const active = await store.listMeetingsByStatus(ACTIVE);
    const spend = await this.monthSpend(true);
    return [
      [
        `**${config.assistantName} status**`,
        `* Meetings in progress: ${active.length} of ${config.maxConcurrentMeetings} allowed`,
        `* Estimated spend this month: $${spend.toFixed(2)} of a $${config.monthlyBudgetUsd.toFixed(2)} budget`,
        `* Knowledge base passages loaded: ${this.d.kb.size}`,
        '_Spend is an estimate from list prices. The Azure and Anthropic invoices are the record._',
      ].join('\n'),
    ];
  }

  private async question(message: ChatMessage, text: string): Promise<string[]> {
    const { store, brain } = this.d;
    const asker: Asker = { name: message.user.name, aadObjectId: message.user.aadObjectId, trusted: true };
    const found = message.conversationType === 'personal' ? null : await store.findLatestMeetingForConversation(message.conversationId);
    const meeting = found?.kind === 'summary' ? null : found;
    try {
      if (meeting) {
        const [segments, earlier] = await Promise.all([store.getSegments(meeting.id), this.earlierSessions(meeting)]);
        const answer = await brain.answerLive({ meeting, segments, earlier, general: this.generalAllowance(meeting), question: text, asker, channel: 'chat' });
        if (answer.usedGeneral) await this.countGeneralAnswer(meeting.id);
        await store.addUsage({ kind: 'llm', meetingId: meeting.id, usd: answer.costUsd, quantity: answer.usage.inputTokens + answer.usage.outputTokens, detail: 'chat answer' });
        return [answer.text];
      }
      const answer = await brain.answerHistory({ question: text, asker, today: new Date(this.now()).toISOString().slice(0, 10) });
      await store.addUsage({ kind: 'llm', usd: answer.costUsd, quantity: answer.usage.inputTokens + answer.usage.outputTokens, detail: 'history answer' });
      return [answer.text];
    } catch (err) {
      this.log.error('Could not answer a chat question', { error: errorMessage(err) });
      return ['Sorry, something went wrong while I was working on that. Please try again.'];
    }
  }

  // ---------------------------------------------------------------------------------------
  // Worker side
  // ---------------------------------------------------------------------------------------

  /** A calling token for the receiver worker, signed in as the assistant's Teams account. */
  async teamsToken(): Promise<TeamsToken | null> {
    if (!this.d.teamsAccount) return null;
    try {
      return await this.d.teamsAccount.getToken();
    } catch (err) {
      this.log.warn('No calling token for the assistant account', { error: errorMessage(err) });
      return null;
    }
  }

  /**
   * Someone called the assistant's Teams account, or added it to a call. Decides whether to take
   * it and, if so, what kind of call it is. A direct call is a private summary call; being added to
   * a call with other people is a normal meeting.
   */
  async acceptIncomingCall(info: IncomingCallInfo): Promise<{ assignment: WorkerAssignment } | { reject: string }> {
    const { store, config } = this.d;
    const token = await this.teamsToken();
    if (!token) return { reject: 'the assistant account is not connected' };
    // Only staff the assistant recognises: the incoming call does not say which organisation the
    // caller belongs to, so they must have used the app in Teams at least once.
    const caller = info.callerAadId ? await store.getUser(info.callerAadId) : null;
    if (!caller || !config.allowedTenantIds.includes(caller.tenantId)) {
      this.log.info('Incoming call refused, the caller is not recognised', { group: info.groupCall });
      return { reject: 'caller not recognised' };
    }
    const problem = await this.capacityProblem();
    if (problem) return { reject: problem };

    const nowIso = new Date(this.now()).toISOString();
    const kind = info.groupCall ? 'meeting' : 'summary';
    const meeting: Meeting = {
      id: newMeetingId(this.now()),
      status: 'claimed',
      title: info.groupCall ? 'Teams call' : 'Private summary call',
      joinUrl: `teams-call:${info.threadId ?? newMeetingId(this.now())}`,
      ...(info.groupCall && info.threadId ? { threadId: info.threadId } : {}),
      ...(kind === 'summary' ? { kind } : {}),
      via: 'teams-user',
      tenantId: caller.tenantId,
      invitedByAadId: caller.aadObjectId,
      invitedByName: info.callerName || caller.name,
      createdAt: nowIso,
      heartbeatAt: nowIso,
      acsUserId: token.userId,
      participants: [],
    };
    await store.createMeeting(meeting);
    await store.linkUserToMeeting(caller.aadObjectId, { meetingId: meeting.id, title: meeting.title, createdAt: nowIso });
    this.log.info('Incoming call accepted', { meetingId: meeting.id, kind, by: meeting.invitedByName });
    return { assignment: this.assignmentFor(meeting, token.token, token.userId) };
  }

  /** Why a new meeting or call cannot be taken right now, or null when it can. */
  private async capacityProblem(): Promise<string | null> {
    const { config, store } = this.d;
    const active = await store.listMeetingsByStatus(ACTIVE);
    if (active.length >= config.maxConcurrentMeetings) return `the limit of ${config.maxConcurrentMeetings} meetings at once has been reached`;
    if ((await this.monthSpend()) >= config.monthlyBudgetUsd) return 'the monthly budget has been reached';
    return null;
  }

  /** True while a standby worker is polling for work and is not busy in a meeting. */
  private standbyIsWaiting(): boolean {
    return this.now() - this.standbyPolledAt < 4000;
  }

  /** Hands the next pending meeting to a worker, with everything it needs to join. */
  async claim(options: { standby?: boolean } = {}): Promise<WorkerAssignment | null> {
    const { config, store, identities } = this.d;
    const meeting = await store.claimPendingMeeting();
    if (options.standby) this.standbyPolledAt = meeting ? 0 : this.now();
    if (!meeting) return null;
    const identity = await identities.issue(config.maxMeetingMinutes + 60);
    await store.updateMeeting(meeting.id, { acsUserId: identity.userId, heartbeatAt: new Date(this.now()).toISOString() });
    this.log.info('Meeting claimed by a worker', { meetingId: meeting.id });
    return this.assignmentFor(meeting, identity.token, identity.userId);
  }

  /** Everything a worker needs to take part in a meeting. */
  private assignmentFor(meeting: Meeting, acsToken: string, acsUserId: string): WorkerAssignment {
    const { config } = this.d;
    return {
      meetingId: meeting.id,
      meetingToken: meetingToken(config.workerSharedSecret, meeting.id),
      joinUrl: meeting.joinUrl,
      displayName: config.displayName,
      acsToken,
      acsUserId,
      spokenLanguage: config.spokenLanguage,
      wakeNames: config.wakeNames,
      ...(meeting.kind === 'summary' ? { alwaysListening: true } : {}),
      // A summary call always greets the caller; it is their own private call.
      announceOnJoin: meeting.kind === 'summary' || config.announceOnJoin,
      announcement: meeting.kind === 'summary' ? summaryCallGreeting(this.persona) : joinAnnouncement(this.persona),
      maxMeetingMinutes: config.maxMeetingMinutes,
      aloneTimeoutSeconds: config.aloneTimeoutSeconds,
      lobbyTimeoutSeconds: config.lobbyTimeoutSeconds,
    };
  }

  /** Applies a batch of worker events. Doubles as the worker heartbeat. */
  async onWorkerEvents(meetingId: string, events: WorkerEvent[]): Promise<{ commands: string[] }> {
    const { store, config } = this.d;
    let meeting = await store.getMeeting(meetingId);
    // A worker reporting on a meeting that no longer exists or is already closed must leave.
    if (!meeting || meeting.status === 'ended' || meeting.status === 'failed') return { commands: ['leave'] };
    const nowIso = new Date(this.now()).toISOString();
    const patch: Partial<Meeting> = { heartbeatAt: nowIso };
    let ended: string | null = null;

    for (const event of events) {
      if (event.type === 'segments' && event.segments.length > 0) {
        await store.appendSegments(meetingId, event.segments);
        const top = Math.max(...event.segments.map((s) => s.seq)) + 1;
        patch.segmentCount = Math.max(patch.segmentCount ?? meeting.segmentCount ?? 0, top);
      } else if (event.type === 'participants') {
        patch.participants = mergeParticipants(patch.participants ?? meeting.participants, event.participants);
        // A private summary call stays with the person who started it; others never get access.
        if (meeting.kind !== 'summary') {
          for (const p of event.participants) {
            if (p.aadObjectId) await store.linkUserToMeeting(p.aadObjectId, { meetingId, title: meeting.title, createdAt: meeting.createdAt });
          }
        }
      } else if (event.type === 'state') {
        // Remember the meeting chat id the call reports, so the meeting chat can find this
        // meeting even when it was started from a personal chat with a short link.
        if (event.threadId && /^19:/.test(event.threadId) && !meeting.threadId) patch.threadId = event.threadId;
        if (event.state === 'lobby' && meeting.status !== 'lobby' && meeting.status !== 'live') {
          patch.status = 'lobby';
          await this.notify(meeting, `I am waiting in the lobby as **${config.displayName}**. Please admit me.`);
        } else if (event.state === 'connected' && meeting.status !== 'live') {
          patch.status = 'live';
          patch.startedAt = nowIso;
          if (meeting.kind !== 'summary') await this.notify(meeting, chatJoinNotice(this.persona, config.retentionDays));
        } else if (event.state === 'ended') {
          ended = event.reason ?? 'ended';
        }
      } else if (event.type === 'note') {
        this.log.info('Worker note', { meetingId, note: event.message });
      }
    }

    meeting = await store.updateMeeting(meetingId, patch);
    if (ended !== null) {
      // Recap writing takes a few seconds. Do it after replying so the worker can shut down.
      void this.finalise(meetingId, ended).catch((err) => this.log.error('Finalising failed', { meetingId, error: errorMessage(err) }));
      return { commands: [] };
    }
    const overLimit = this.now() - Date.parse(meeting.createdAt) > config.maxMeetingMinutes * 60_000;
    return { commands: meeting.leaveRequested || overLimit ? ['leave'] : [] };
  }

  /**
   * Earlier sessions of the same meeting chat or meeting link, newest first, so the assistant can
   * answer "what did we discuss last time?". Kept in memory for a few minutes per meeting, because
   * they do not change while a meeting runs and every spoken question needs them.
   */
  private async earlierSessions(meeting: Meeting): Promise<EarlierSession[]> {
    const cached = this.earlierCache.get(meeting.id);
    if (cached && this.now() - cached.at < 10 * 60_000) return cached.sessions;
    const { store } = this.d;
    const chatIds = [meeting.conversationId, meeting.threadId].filter((id): id is string => Boolean(id));
    const related = await store.listMeetingsForChat(chatIds, meeting.joinUrl, 12);
    // Private summary calls are never used as background: they contain one person's catch-up.
    const earlier = related.filter((m) => m.id !== meeting.id && m.createdAt < meeting.createdAt && m.status === 'ended' && m.kind !== 'summary').slice(0, 6);
    const sessions = await Promise.all(
      earlier.map(async (m, i): Promise<EarlierSession> => ({
        meeting: m,
        recap: await store.getRecap(m.id),
        // Full transcripts only for the two most recent sessions; older ones are represented by their recap.
        ...(i < 2 ? { segments: await store.getSegments(m.id) } : {}),
      })),
    );
    if (this.earlierCache.size > 50) this.earlierCache.clear();
    this.earlierCache.set(meeting.id, { at: this.now(), sessions });
    return sessions;
  }

  /**
   * For a private summary call: the meetings the caller attended (the same rule as questions in a
   * personal chat), newest first, with recaps and the two most recent transcripts.
   */
  private async attendedSessions(meeting: Meeting): Promise<EarlierSession[]> {
    const key = `attended:${meeting.id}`;
    const cached = this.earlierCache.get(key);
    if (cached && this.now() - cached.at < 10 * 60_000) return cached.sessions;
    const { store } = this.d;
    const refs = await store.listUserMeetings(meeting.invitedByAadId, 40);
    const found = await Promise.all(refs.map((r) => store.getMeeting(r.meetingId)));
    const attended = found
      .filter((m): m is Meeting => m !== null && m.id !== meeting.id && m.status === 'ended' && m.kind !== 'summary')
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
      .slice(0, 10);
    const sessions = await Promise.all(
      attended.map(async (m, i): Promise<EarlierSession> => ({
        meeting: m,
        recap: await store.getRecap(m.id),
        ...(i < 2 ? { segments: await store.getSegments(m.id) } : {}),
      })),
    );
    if (this.earlierCache.size > 50) this.earlierCache.clear();
    this.earlierCache.set(key, { at: this.now(), sessions });
    return sessions;
  }

  /** What is left of the meeting's general knowledge allowance, or undefined when it is switched off. */
  private generalAllowance(meeting: Meeting): { remaining: number; limit: number } | undefined {
    const limit = this.d.config.generalQuestionsPerMeeting;
    if (limit <= 0) return undefined;
    return { limit, remaining: Math.max(0, limit - (meeting.generalQuestions ?? 0)) };
  }

  /** Counts one general knowledge answer against the meeting. Reads fresh, as questions can overlap. */
  private async countGeneralAnswer(meetingId: string): Promise<void> {
    const current = await this.d.store.getMeeting(meetingId);
    if (!current) return;
    const used = (current.generalQuestions ?? 0) + 1;
    await this.d.store.updateMeeting(meetingId, { generalQuestions: used });
    this.log.info('General knowledge answer', { meetingId, used, limit: this.d.config.generalQuestionsPerMeeting });
  }

  private async isTrusted(meeting: Meeting, speakerAadId?: string): Promise<boolean> {
    if (this.d.config.kbAudience === 'everyone') return true;
    if (!speakerAadId) return false;
    if (speakerAadId === meeting.invitedByAadId) return true;
    return (await this.d.store.getUser(speakerAadId)) !== null;
  }

  /**
   * Answers a question that was spoken in the meeting. Each sentence is turned into speech as
   * soon as it is ready and written to the worker in order, so the reply starts quickly.
   */
  async answerVoice(
    meetingId: string,
    ask: { speakerAadId?: string; speakerName: string; question: string },
    write: (line: AnswerLine) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const { store, brain, tts, config } = this.d;
    const meeting = await store.getMeeting(meetingId);
    if (!meeting) {
      write({ type: 'error', message: 'Unknown meeting' });
      return;
    }
    const t0 = this.now();
    const isPrivate = meeting.kind === 'summary';
    if (isPrivate && !callerIsAlone(meeting, ask.speakerAadId)) {
      // Privacy lock: other meetings are only discussed with the person who started the call,
      // and only while nobody else is or has been in it.
      this.log.info('Summary call question refused, the caller is not alone', { meetingId });
      write(await this.speak(meetingId, PRIVATE_CALL_LOCKED));
      write({ type: 'done', text: PRIVATE_CALL_LOCKED });
      return;
    }
    const [segments, earlier, trusted] = await Promise.all([
      store.getSegments(meetingId),
      isPrivate ? this.attendedSessions(meeting) : this.earlierSessions(meeting),
      this.isTrusted(meeting, ask.speakerAadId),
    ]);
    const asker: Asker = { name: ask.speakerName, aadObjectId: ask.speakerAadId, trusted };
    // Where the time goes, so answer speed can be measured and tuned from the logs.
    const timing = { contextMs: this.now() - t0, firstSentenceMs: 0, firstAudioMs: 0 };
    let chain: Promise<void> = Promise.resolve();
    let characters = 0;
    let speechFailed = false;
    try {
      const answer = await brain.answerLive({
        meeting,
        segments,
        earlier,
        privateCall: isPrivate,
        general: this.generalAllowance(meeting),
        question: ask.question,
        asker,
        channel: 'voice',
        signal,
        onSentence: (sentence) => {
          if (!timing.firstSentenceMs) timing.firstSentenceMs = this.now() - t0;
          characters += sentence.length;
          const audio = tts.synthesize(sentence);
          audio.catch(() => undefined); // Handled in the chain below.
          chain = chain.then(async () => {
            if (signal?.aborted) return;
            try {
              const speech = await audio;
              if (!timing.firstAudioMs) timing.firstAudioMs = this.now() - t0;
              write({ type: 'sentence', text: sentence, audioB64: speech.audio.toString('base64'), mime: speech.mime });
            } catch (err) {
              speechFailed = true;
              this.log.error('Text to speech failed', { error: errorMessage(err) });
            }
          });
        },
      });
      await chain;
      if (answer.usedGeneral) await this.countGeneralAnswer(meetingId);
      this.log.info('Voice answer timing', { meetingId, ...timing, totalMs: this.now() - t0, inputTokens: answer.usage.inputTokens, cachedTokens: answer.usage.cacheReadTokens });
      await store.addUsage({ kind: 'llm', meetingId, usd: answer.costUsd, quantity: answer.usage.inputTokens + answer.usage.outputTokens, detail: 'voice answer' });
      if (characters > 0) await store.addUsage({ kind: 'tts', meetingId, usd: ttsCost(characters, this.d.prices), quantity: characters });
      if (answer.usage.webSearches > 0) this.log.info('Web searches used', { meetingId, searches: answer.usage.webSearches });
      write({ type: 'done', text: answer.text });
      // A private summary call stays private: nothing is posted to chat.
      if (answer.text && !isPrivate && (config.postVoiceAnswersToChat || speechFailed)) {
        await this.notify(meeting, `**${ask.speakerName} asked:** ${ask.question}\n\n${answer.text}`, false);
      }
    } catch (err) {
      await chain.catch(() => undefined);
      if (signal?.aborted) return;
      this.log.error('Could not answer a spoken question', { meetingId, error: errorMessage(err) });
      write({ type: 'error', message: 'The assistant could not answer.' });
    }
  }

  /** Speech for fixed phrases such as the join announcement. Cached, so it is paid for once. */
  async speak(meetingId: string, text: string): Promise<AnswerLine> {
    try {
      const speech = await this.d.tts.synthesizeCached(text);
      await this.d.store.addUsage({ kind: 'tts', meetingId, usd: ttsCost(text.length, this.d.prices), quantity: text.length, detail: 'phrase' });
      return { type: 'sentence', text, audioB64: speech.audio.toString('base64'), mime: speech.mime };
    } catch (err) {
      this.log.error('Text to speech failed', { error: errorMessage(err) });
      return { type: 'error', message: 'Speech is unavailable.' };
    }
  }

  // ---------------------------------------------------------------------------------------
  // After the meeting and housekeeping
  // ---------------------------------------------------------------------------------------

  /** Closes a meeting: records usage, writes the recap and tells the attendees. Safe to call twice. */
  async finalise(meetingId: string, reason: string): Promise<void> {
    const { store, brain, config } = this.d;
    if (this.finalising.has(meetingId)) return;
    this.finalising.add(meetingId);
    try {
      const meeting = await store.getMeeting(meetingId);
      if (!meeting || meeting.status === 'ended' || meeting.status === 'failed') return;
      const endedAt = this.now();
      const neverJoined = !meeting.startedAt;
      const minutes = Math.max(1, Math.ceil((endedAt - Date.parse(meeting.createdAt)) / 60_000));
      const status: MeetingStatus = neverJoined ? 'failed' : 'ended';
      await store.updateMeeting(meetingId, { status, endedAt: new Date(endedAt).toISOString(), endReason: reason, minutes });
      await store.addUsage({ kind: 'meeting', meetingId, usd: meetingCost(minutes, this.d.prices), quantity: minutes, detail: reason });
      // Guest identities are made per meeting and removed afterwards. The assistant's own Teams
      // account is never removed.
      if (meeting.acsUserId && meeting.via !== 'teams-user') {
        await this.d.identities.revoke(meeting.acsUserId).catch((err) => this.log.warn('Could not remove the calling identity', { error: errorMessage(err) }));
      }
      this.spendCache = null;

      if (neverJoined && meeting.via === 'teams-user') {
        // A call to Claude Assistant that was never answered (for example it stopped ringing).
        // The caller already saw an unanswered call, so no message is sent.
        this.log.info('Call to the assistant was not answered, closed quietly', { meetingId, reason });
        return;
      }
      if (neverJoined) {
        await this.notify(meeting, `I could not join the meeting (${plainReason(reason)}). Check that someone admitted **${config.displayName}** from the lobby and that anonymous join is allowed, then ask me again.`);
        return;
      }
      if (meeting.kind === 'summary') {
        // A private catch-up call: no recap, no messages, nobody else linked to it.
        this.log.info('Summary call finished', { meetingId, minutes });
        return;
      }
      const segments = await store.getSegments(meetingId);
      const people = meeting.participants.map((p) => p.displayName);
      for (const p of meeting.participants) {
        if (p.aadObjectId) await store.linkUserToMeeting(p.aadObjectId, { meetingId, title: meeting.title, createdAt: meeting.createdAt });
      }
      if (segments.filter((s) => s.kind === 'speech').length === 0) {
        await this.notify(meeting, 'The meeting has ended. I did not capture any speech, so there is no recap. If captions are turned off by policy for this meeting, I cannot follow it.');
        return;
      }
      const start = Date.parse(meeting.startedAt ?? meeting.createdAt);
      await store.saveTranscriptText(meetingId, formatTranscript(segments, start));
      const { recap, costUsd, usage } = await brain.buildRecap(meeting, segments);
      await store.saveRecap(meetingId, recap);
      await store.addUsage({ kind: 'llm', meetingId, usd: costUsd, quantity: usage.inputTokens + usage.outputTokens, detail: 'recap' });
      const title = meeting.title === 'Teams meeting' ? recap.title : meeting.title;
      await store.updateMeeting(meetingId, { summary: recap.summary.slice(0, 900), title });
      // Participants as stored now, including everyone who joined during the call.
      const latest = (await store.getMeeting(meetingId)) ?? meeting;
      await this.deliverRecap(latest, recapMarkdown(recap, { minutes, people }));
      this.log.info('Meeting finalised', { meetingId, minutes, segments: segments.length });
    } finally {
      this.finalising.delete(meetingId);
    }
  }

  /** Finds meetings whose worker has stopped reporting and closes them. Run on a timer. */
  async reapStale(): Promise<number> {
    const { store } = this.d;
    let reaped = 0;
    for (const meeting of await store.listMeetingsByStatus(ACTIVE)) {
      const last = Date.parse(meeting.heartbeatAt ?? meeting.createdAt);
      const limitMs = meeting.status === 'pending' ? 4 * 60_000 : 3 * 60_000;
      if (this.now() - last > limitMs) {
        this.log.warn('Meeting has gone quiet, closing it', { meetingId: meeting.id, status: meeting.status });
        await this.finalise(meeting.id, meeting.status === 'pending' ? 'no worker picked it up' : 'worker stopped responding');
        reaped++;
      }
    }
    return reaped;
  }

  /** Deletes meetings older than the retention period. Run daily. */
  async purgeExpired(): Promise<number> {
    const { store, config } = this.d;
    const cutoff = new Date(this.now() - config.retentionDays * 86_400_000).toISOString();
    const old = (await store.listMeetingsCreatedBefore(cutoff)).filter((m) => !ACTIVE.includes(m.status));
    for (const meeting of old) await store.deleteMeeting(meeting.id);
    if (old.length > 0) this.log.info('Purged expired meetings', { count: old.length });
    return old.length;
  }

  /** Reloads the knowledge base if it changed in storage. Run every few minutes. */
  async refreshKb(): Promise<void> {
    const loaded = await this.d.store.loadKb(this.kbVersion);
    if (loaded === null || loaded === 'unchanged') return;
    this.d.kb.replace(loaded.chunks);
    this.kbVersion = loaded.version;
    this.log.info('Knowledge base loaded', { passages: loaded.chunks.length });
  }

  private async monthSpend(fresh = false): Promise<number> {
    const month = monthKey(new Date(this.now()));
    const cache = this.spendCache;
    if (!fresh && cache && cache.month === month && this.now() - cache.at < 60_000) return cache.usd;
    const usd = await this.d.store.sumUsage(month);
    this.spendCache = { at: this.now(), month, usd };
    return usd;
  }

  /**
   * Posts to the meeting chat. If the bot has not been added to that chat (or the link was
   * pasted in a personal chat), falls back to a direct message to the person who invited it.
   */
  /**
   * Delivers the recap. With a meeting chat, it is posted there for everyone. Without one (for
   * example when Claude Assistant was added to a call), each person who was in the call gets it in
   * their own chat with the app, and so does whoever invited the assistant. Only colleagues from an
   * allowed organisation who use the app can receive it.
   */
  private async deliverRecap(meeting: Meeting, markdown: string): Promise<void> {
    if (meeting.conversationId) {
      await this.notify(meeting, markdown);
      return;
    }
    const { store, notifier, config } = this.d;
    const people = new Set<string>([meeting.invitedByAadId]);
    for (const p of meeting.participants) if (p.aadObjectId) people.add(p.aadObjectId);
    let delivered = 0;
    for (const aadObjectId of people) {
      const user = await store.getUser(aadObjectId);
      if (!user?.conversationId || !config.allowedTenantIds.includes(user.tenantId)) continue;
      try {
        await notifier.send(user.conversationId, markdown);
        delivered++;
      } catch (err) {
        this.log.warn('Could not send the recap to someone', { meetingId: meeting.id, error: errorMessage(err) });
      }
    }
    this.log.info('Recap delivered to attendees', { meetingId: meeting.id, recipients: delivered, attendees: people.size });
  }

  private async notify(meeting: Meeting, markdown: string, fallbackToInviter = true): Promise<void> {
    const { notifier, store } = this.d;
    if (meeting.conversationId) {
      try {
        await notifier.send(meeting.conversationId, markdown);
        return;
      } catch (err) {
        this.log.debug('Could not post to the meeting chat', { meetingId: meeting.id, error: errorMessage(err) });
      }
    }
    if (!fallbackToInviter) return;
    const inviter = await store.getUser(meeting.invitedByAadId);
    if (!inviter?.conversationId) {
      this.log.warn('No conversation available to notify', { meetingId: meeting.id });
      return;
    }
    try {
      await notifier.send(inviter.conversationId, markdown);
    } catch (err) {
      this.log.warn('Could not message the inviter', { meetingId: meeting.id, error: errorMessage(err) });
    }
  }
}

function plainReason(reason: string): string {
  return reason.replace(/[^\w\s,.:]/g, '').slice(0, 120) || 'unknown reason';
}

/** Keeps everyone who has been in the meeting, updating names as they change. */
export function mergeParticipants(known: Participant[], current: Participant[]): Participant[] {
  const byId = new Map(known.map((p) => [p.id, p]));
  for (const p of current) byId.set(p.id, { ...byId.get(p.id), ...p });
  return [...byId.values()];
}
