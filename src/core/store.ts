// Storage contract plus an in memory implementation for tests and the local demo.
// The production implementation (Azure Table Storage and Blob Storage) is in store-azure.ts.

import { monthKey } from './ids.js';
import type { KbChunk, Meeting, MeetingStatus, Recap, Segment, UsageEntry } from './types.js';

export interface UserMeetingRef {
  meetingId: string;
  title: string;
  createdAt: string;
}

/** A member of staff the assistant has spoken to in Teams chat. */
export interface KnownUser {
  aadObjectId: string;
  name: string;
  /** Personal chat with the bot, used to send recaps directly. */
  conversationId?: string;
  tenantId: string;
  seenAt: string;
}

export interface Store {
  init(): Promise<void>;

  createMeeting(meeting: Meeting): Promise<void>;
  getMeeting(id: string): Promise<Meeting | null>;
  /** Merges the given fields into the stored meeting and returns the result. */
  updateMeeting(id: string, patch: Partial<Meeting>): Promise<Meeting>;
  /** Atomically moves one pending meeting to claimed. Two workers can never claim the same one. */
  claimPendingMeeting(): Promise<Meeting | null>;
  listMeetingsByStatus(statuses: MeetingStatus[]): Promise<Meeting[]>;
  findLatestMeetingForConversation(conversationId: string): Promise<Meeting | null>;
  /**
   * Every session of the same meeting: meetings whose chat (conversationId or threadId) is one of
   * the given ids, or that used the same join link. Newest first, at most `limit`.
   */
  listMeetingsForChat(chatIds: string[], joinUrl: string | undefined, limit: number): Promise<Meeting[]>;
  /** Meetings created before the cut off, for the retention purge. */
  listMeetingsCreatedBefore(isoCutoff: string): Promise<Meeting[]>;
  /** Removes the meeting, its transcript, its recap and every index entry that points to it. */
  deleteMeeting(id: string): Promise<void>;

  appendSegments(meetingId: string, segments: Segment[]): Promise<void>;
  getSegments(meetingId: string): Promise<Segment[]>;

  linkUserToMeeting(aadObjectId: string, ref: UserMeetingRef): Promise<void>;
  listUserMeetings(aadObjectId: string, limit: number): Promise<UserMeetingRef[]>;
  userHasMeeting(aadObjectId: string, meetingId: string): Promise<boolean>;

  saveUser(user: KnownUser): Promise<void>;
  getUser(aadObjectId: string): Promise<KnownUser | null>;

  saveRecap(meetingId: string, recap: Recap): Promise<void>;
  getRecap(meetingId: string): Promise<Recap | null>;
  saveTranscriptText(meetingId: string, text: string): Promise<void>;

  saveKb(chunks: KbChunk[]): Promise<void>;
  /** Returns the knowledge base and a version marker, or null when none has been uploaded. */
  loadKb(knownVersion?: string): Promise<{ chunks: KbChunk[]; version: string } | 'unchanged' | null>;

  addUsage(entry: UsageEntry, when?: Date): Promise<void>;
  sumUsage(month: string): Promise<number>;

  /** The assistant Teams account's sign-in cache, already encrypted by the caller. */
  loadIdentityCache(): Promise<string | null>;
  saveIdentityCache(encrypted: string): Promise<void>;
}

export class MemoryStore implements Store {
  private meetings = new Map<string, Meeting>();
  private segments = new Map<string, Segment[]>();
  private userMeetings = new Map<string, UserMeetingRef[]>();
  private users = new Map<string, KnownUser>();
  private recaps = new Map<string, Recap>();
  readonly transcripts = new Map<string, string>();
  private kb: { chunks: KbChunk[]; version: string } | null = null;
  private identityCache: string | null = null;

  async loadIdentityCache(): Promise<string | null> {
    return this.identityCache;
  }

  async saveIdentityCache(encrypted: string): Promise<void> {
    this.identityCache = encrypted;
  }
  readonly usage: { month: string; entry: UsageEntry }[] = [];

  async init(): Promise<void> {}

  async createMeeting(meeting: Meeting): Promise<void> {
    this.meetings.set(meeting.id, structuredClone(meeting));
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    const m = this.meetings.get(id);
    return m ? structuredClone(m) : null;
  }

  async updateMeeting(id: string, patch: Partial<Meeting>): Promise<Meeting> {
    const current = this.meetings.get(id);
    if (!current) throw new Error(`Meeting ${id} not found`);
    const next = { ...current, ...structuredClone(patch) };
    this.meetings.set(id, next);
    return structuredClone(next);
  }

  async claimPendingMeeting(): Promise<Meeting | null> {
    const pending = [...this.meetings.values()].filter((m) => m.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = pending[0];
    if (!first) return null;
    first.status = 'claimed';
    return structuredClone(first);
  }

  async listMeetingsByStatus(statuses: MeetingStatus[]): Promise<Meeting[]> {
    return [...this.meetings.values()].filter((m) => statuses.includes(m.status)).map((m) => structuredClone(m));
  }

  async findLatestMeetingForConversation(conversationId: string): Promise<Meeting | null> {
    const matches = [...this.meetings.values()].filter((m) => m.conversationId === conversationId || m.threadId === conversationId).sort((a, b) => a.id.localeCompare(b.id));
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  async listMeetingsForChat(chatIds: string[], joinUrl: string | undefined, limit: number): Promise<Meeting[]> {
    const ids = new Set(chatIds.filter(Boolean));
    return [...this.meetings.values()]
      .filter((m) => (m.conversationId && ids.has(m.conversationId)) || (m.threadId && ids.has(m.threadId)) || (joinUrl !== undefined && m.joinUrl === joinUrl))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((m) => structuredClone(m));
  }

  async listMeetingsCreatedBefore(isoCutoff: string): Promise<Meeting[]> {
    return [...this.meetings.values()].filter((m) => m.createdAt < isoCutoff).map((m) => structuredClone(m));
  }

  async deleteMeeting(id: string): Promise<void> {
    this.meetings.delete(id);
    this.segments.delete(id);
    this.recaps.delete(id);
    this.transcripts.delete(id);
    for (const [user, refs] of this.userMeetings) {
      this.userMeetings.set(user, refs.filter((r) => r.meetingId !== id));
    }
  }

  async appendSegments(meetingId: string, segments: Segment[]): Promise<void> {
    const list = this.segments.get(meetingId) ?? [];
    for (const s of segments) {
      const at = list.findIndex((x) => x.seq === s.seq);
      if (at >= 0) list[at] = s;
      else list.push(s);
    }
    list.sort((a, b) => a.seq - b.seq);
    this.segments.set(meetingId, list);
  }

  async getSegments(meetingId: string): Promise<Segment[]> {
    return structuredClone(this.segments.get(meetingId) ?? []);
  }

  async linkUserToMeeting(aadObjectId: string, ref: UserMeetingRef): Promise<void> {
    const list = (this.userMeetings.get(aadObjectId) ?? []).filter((r) => r.meetingId !== ref.meetingId);
    list.push(ref);
    list.sort((a, b) => a.meetingId.localeCompare(b.meetingId));
    this.userMeetings.set(aadObjectId, list);
  }

  async listUserMeetings(aadObjectId: string, limit: number): Promise<UserMeetingRef[]> {
    return (this.userMeetings.get(aadObjectId) ?? []).slice(0, limit);
  }

  async userHasMeeting(aadObjectId: string, meetingId: string): Promise<boolean> {
    return (this.userMeetings.get(aadObjectId) ?? []).some((r) => r.meetingId === meetingId);
  }

  async saveUser(user: KnownUser): Promise<void> {
    this.users.set(user.aadObjectId, { ...this.users.get(user.aadObjectId), ...user });
  }

  async getUser(aadObjectId: string): Promise<KnownUser | null> {
    return this.users.get(aadObjectId) ?? null;
  }

  async saveRecap(meetingId: string, recap: Recap): Promise<void> {
    this.recaps.set(meetingId, recap);
  }

  async getRecap(meetingId: string): Promise<Recap | null> {
    return this.recaps.get(meetingId) ?? null;
  }

  async saveTranscriptText(meetingId: string, text: string): Promise<void> {
    this.transcripts.set(meetingId, text);
  }

  async saveKb(chunks: KbChunk[]): Promise<void> {
    this.kb = { chunks, version: String(Date.now()) };
  }

  async loadKb(knownVersion?: string): Promise<{ chunks: KbChunk[]; version: string } | 'unchanged' | null> {
    if (!this.kb) return null;
    if (knownVersion && knownVersion === this.kb.version) return 'unchanged';
    return this.kb;
  }

  async addUsage(entry: UsageEntry, when: Date = new Date()): Promise<void> {
    this.usage.push({ month: monthKey(when), entry });
  }

  async sumUsage(month: string): Promise<number> {
    return this.usage.filter((u) => u.month === month).reduce((n, u) => n + u.entry.usd, 0);
  }
}
