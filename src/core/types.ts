// Shared types. This file is imported by both the Node services and the browser page,
// so it must not reference Node or DOM specific types.

export type MeetingStatus = 'pending' | 'claimed' | 'lobby' | 'live' | 'ended' | 'failed';

export interface Participant {
  /** Stable id from the calling platform. For Teams users this is the Entra object id. */
  id: string;
  /** Entra object id when the participant is a Teams user in a tenant, otherwise undefined. */
  aadObjectId?: string;
  displayName: string;
  kind: 'teams' | 'acs' | 'phone' | 'unknown';
}

export interface Meeting {
  id: string;
  status: MeetingStatus;
  title: string;
  joinUrl: string;
  /** Teams chat thread id of the meeting chat, when known. Used to post recaps and answer chat questions. */
  conversationId?: string;
  /**
   * The meeting chat's thread id as reported by the call itself once connected. Lets the meeting
   * chat find a meeting that was started from a personal chat with a short link (which carries
   * no thread id). Only used for lookups; notices still go to conversationId or the inviter.
   */
  threadId?: string;
  /**
   * meeting (default): a normal meeting the assistant follows and recaps.
   * summary: a private call the inviter started to ask about meetings they attended. No wake word,
   * no recap, and other meetings are only discussed while the inviter is alone with the assistant.
   */
  kind?: 'meeting' | 'summary';
  /** General knowledge questions answered in this meeting, counted against the per meeting allowance. */
  generalQuestions?: number;
  /** 'teams-user' when the assistant took part as its own Teams account (a call to it, or added to a call). */
  via?: 'guest' | 'teams-user';
  tenantId: string;
  invitedByAadId: string;
  invitedByName: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  endReason?: string;
  leaveRequested?: boolean;
  /** Last time the worker reported in. Used to spot a worker that has died. */
  heartbeatAt?: string;
  /** Azure Communication Services identity created for this meeting, deleted afterwards. */
  acsUserId?: string;
  participants: Participant[];
  /** Short summary shown in meeting lists. The full recap lives in blob storage. */
  summary?: string;
  minutes?: number;
  segmentCount?: number;
}

export type SegmentKind = 'speech' | 'assistant';

export interface Segment {
  seq: number;
  /** ISO timestamp of when the words were spoken. */
  ts: string;
  speakerId: string;
  speakerName: string;
  text: string;
  kind: SegmentKind;
}

/** A caption event as the calling layer delivers it. Partial events refine the current utterance. */
export interface CaptionEvent {
  speakerId: string;
  speakerAadId?: string;
  speakerName: string;
  text: string;
  final: boolean;
  /** Epoch milliseconds. */
  at: number;
}

export type CallState = 'connecting' | 'lobby' | 'connected' | 'ended';

export interface RecapAction {
  owner: string;
  task: string;
  due?: string;
}

export interface RecapExplained {
  speaker: string;
  /** Who the explanation was aimed at. "everyone" when it was to the whole meeting. */
  to: string;
  points: string[];
}

export interface Recap {
  title: string;
  summary: string;
  decisions: string[];
  actions: RecapAction[];
  explained: RecapExplained[];
  openQuestions: string[];
}

export interface KbChunk {
  id: string;
  docTitle: string;
  source: string;
  text: string;
}

export interface UsageEntry {
  kind: 'llm' | 'tts' | 'meeting' | 'search';
  meetingId?: string;
  usd: number;
  /** Tokens, characters, minutes or searches depending on kind. */
  quantity: number;
  detail?: string;
}

/** What the control service hands a worker when it claims a meeting. */
export interface WorkerAssignment {
  meetingId: string;
  meetingToken: string;
  joinUrl: string;
  displayName: string;
  acsToken: string;
  acsUserId: string;
  spokenLanguage: string;
  wakeNames: string[];
  /** Treat everything said as addressed to the assistant (private summary calls), no wake word needed. */
  alwaysListening?: boolean;
  announceOnJoin: boolean;
  announcement: string;
  maxMeetingMinutes: number;
  aloneTimeoutSeconds: number;
  lobbyTimeoutSeconds: number;
}

/** Events a worker posts to the control service. */
export type WorkerEvent =
  | { type: 'state'; state: CallState; reason?: string; threadId?: string }
  | { type: 'participants'; participants: Participant[] }
  | { type: 'segments'; segments: Segment[] }
  | { type: 'note'; message: string };

/** Lines of the streaming answer the control service sends back to a worker. */
export type AnswerLine =
  | { type: 'sentence'; text: string; audioB64: string; mime: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

/** Configuration passed from the Node host into the browser page. */
export interface PageConfig {
  transport: 'acs' | 'fake';
  joinUrl: string;
  displayName: string;
  acsToken: string;
  spokenLanguage: string;
  /** Only used by the fake transport, for local demos and tests. */
  fakeScript?: FakeScriptStep[];
}

export interface FakeScriptStep {
  atMs: number;
  type: 'state' | 'participants' | 'caption' | 'end';
  state?: CallState;
  participants?: Participant[];
  caption?: Omit<CaptionEvent, 'at'>;
}

/** Events the browser page raises to the Node host. */
/** An incoming call to the assistant's own Teams account. */
export interface IncomingCallInfo {
  callerAadId?: string;
  callerName: string;
  /** True when the assistant is being added to a call with other people, not called directly. */
  groupCall: boolean;
  threadId?: string;
}

export type PageEvent =
  | { type: 'state'; state: CallState; reason?: string; threadId?: string }
  | ({ type: 'incoming' } & IncomingCallInfo)
  | { type: 'participants'; participants: Participant[] }
  | { type: 'caption'; caption: CaptionEvent }
  | { type: 'playback'; playing: boolean }
  | { type: 'audioLevel'; rms: number; muted: boolean }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
