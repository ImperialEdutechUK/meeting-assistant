// Production storage on one Azure Storage account: Table Storage for rows, Blob Storage for
// recaps, transcript exports and the knowledge base. Costs pennies a month at this scale and has
// no fixed fee, unlike a database server.

import { DefaultAzureCredential } from '@azure/identity';
import { RestError, TableClient, type TableEntity, type TableEntityResult, type TransactionAction, odata } from '@azure/data-tables';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { meetingIdTime, monthKey, newEventId, seqKey } from './ids.js';
import type { KnownUser, Store, UserMeetingRef } from './store.js';
import type { KbChunk, Meeting, MeetingStatus, Recap, Segment, UsageEntry } from './types.js';

export interface AzureStoreOptions {
  /** Use a connection string locally (for example with the Azurite emulator). */
  connectionString?: string;
  /** In Azure, give the account name and the app's managed identity is used instead of a key. */
  accountName?: string;
  tablePrefix?: string;
  containerName?: string;
}

const MEETING_PK = 'm';
const USER_PK = 'u';

type MeetingRow = TableEntity<{
  status: string;
  title: string;
  joinUrl: string;
  conversationId?: string;
  threadId?: string;
  kind?: string;
  generalQuestions?: number;
  via?: string;
  tenantId: string;
  invitedByAadId: string;
  invitedByName: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  endReason?: string;
  leaveRequested?: boolean;
  heartbeatAt?: string;
  acsUserId?: string;
  participantsJson: string;
  summary?: string;
  minutes?: number;
  segmentCount?: number;
}>;

function isStatus(err: unknown, status: number): boolean {
  return err instanceof RestError && err.statusCode === status;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function toRow(m: Partial<Meeting> & { id: string }): Partial<MeetingRow> & { partitionKey: string; rowKey: string } {
  const { id, participants, ...rest } = m;
  return compact({
    partitionKey: MEETING_PK,
    rowKey: id,
    ...rest,
    ...(participants ? { participantsJson: JSON.stringify(participants) } : {}),
  }) as Partial<MeetingRow> & { partitionKey: string; rowKey: string };
}

function fromRow(row: MeetingRow): Meeting {
  return compact({
    id: row.rowKey,
    status: row.status as MeetingStatus,
    title: row.title,
    joinUrl: row.joinUrl,
    conversationId: row.conversationId,
    threadId: row.threadId,
    kind: row.kind === 'summary' ? 'summary' : undefined,
    generalQuestions: row.generalQuestions,
    via: row.via === 'teams-user' ? 'teams-user' : undefined,
    tenantId: row.tenantId,
    invitedByAadId: row.invitedByAadId,
    invitedByName: row.invitedByName,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
    leaveRequested: row.leaveRequested,
    heartbeatAt: row.heartbeatAt,
    acsUserId: row.acsUserId,
    participants: row.participantsJson ? JSON.parse(row.participantsJson) : [],
    summary: row.summary,
    minutes: row.minutes,
    segmentCount: row.segmentCount,
  }) as Meeting;
}

export class AzureStore implements Store {
  private readonly meetings: TableClient;
  private readonly segments: TableClient;
  private readonly userMeetings: TableClient;
  private readonly users: TableClient;
  private readonly usage: TableClient;
  private readonly container: ContainerClient;

  constructor(options: AzureStoreOptions) {
    const prefix = options.tablePrefix ?? 'cma';
    const names = ['Meetings', 'Segments', 'UserMeetings', 'Users', 'Usage'].map((n) => `${prefix}${n}`);
    const containerName = options.containerName ?? 'meeting-assistant';
    let tables: TableClient[];
    let blobs: BlobServiceClient;
    if (options.connectionString) {
      const insecure = options.connectionString.includes('http://');
      tables = names.map((n) => TableClient.fromConnectionString(options.connectionString as string, n, { allowInsecureConnection: insecure }));
      blobs = BlobServiceClient.fromConnectionString(options.connectionString);
    } else if (options.accountName) {
      const credential = new DefaultAzureCredential();
      tables = names.map((n) => new TableClient(`https://${options.accountName}.table.core.windows.net`, n, credential));
      blobs = new BlobServiceClient(`https://${options.accountName}.blob.core.windows.net`, credential);
    } else {
      throw new Error('AzureStore needs either connectionString or accountName');
    }
    [this.meetings, this.segments, this.userMeetings, this.users, this.usage] = tables as [TableClient, TableClient, TableClient, TableClient, TableClient];
    this.container = blobs.getContainerClient(containerName);
  }

  async init(): Promise<void> {
    await Promise.all([this.meetings, this.segments, this.userMeetings, this.users, this.usage].map((t) => t.createTable()));
    await this.ensureContainer();
  }

  /** Creates only the blob container. Enough for uploading the knowledge base. */
  async ensureContainer(): Promise<void> {
    await this.container.createIfNotExists();
  }

  async createMeeting(meeting: Meeting): Promise<void> {
    await this.meetings.createEntity(toRow(meeting));
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    try {
      return fromRow(await this.meetings.getEntity<MeetingRow>(MEETING_PK, id));
    } catch (err) {
      if (isStatus(err, 404)) return null;
      throw err;
    }
  }

  async updateMeeting(id: string, patch: Partial<Meeting>): Promise<Meeting> {
    await this.meetings.updateEntity(toRow({ ...patch, id }), 'Merge');
    const updated = await this.getMeeting(id);
    if (!updated) throw new Error(`Meeting ${id} not found`);
    return updated;
  }

  async claimPendingMeeting(): Promise<Meeting | null> {
    const pending: TableEntityResult<MeetingRow>[] = [];
    const filter = odata`PartitionKey eq ${MEETING_PK} and status eq ${'pending'}`;
    for await (const row of this.meetings.listEntities<MeetingRow>({ queryOptions: { filter } })) pending.push(row);
    // Oldest request first. Ids sort newest first, so walk the list backwards.
    pending.sort((a, b) => b.rowKey.localeCompare(a.rowKey));
    for (const row of pending) {
      try {
        // The update only succeeds if nobody changed the row since it was read.
        await this.meetings.updateEntity({ partitionKey: MEETING_PK, rowKey: row.rowKey, status: 'claimed' }, 'Merge', { etag: row.etag });
        return { ...fromRow(row), status: 'claimed' };
      } catch (err) {
        if (isStatus(err, 412) || isStatus(err, 404)) continue;
        throw err;
      }
    }
    return null;
  }

  async listMeetingsByStatus(statuses: MeetingStatus[]): Promise<Meeting[]> {
    const out: Meeting[] = [];
    for await (const row of this.meetings.listEntities<MeetingRow>({ queryOptions: { filter: odata`PartitionKey eq ${MEETING_PK}` } })) {
      if (statuses.includes(row.status as MeetingStatus)) out.push(fromRow(row));
    }
    return out;
  }

  async findLatestMeetingForConversation(conversationId: string): Promise<Meeting | null> {
    // A meeting chat matches either the chat the meeting was started from or the thread id the call reported.
    const filter = odata`PartitionKey eq ${MEETING_PK} and (conversationId eq ${conversationId} or threadId eq ${conversationId})`;
    for await (const row of this.meetings.listEntities<MeetingRow>({ queryOptions: { filter } })) {
      return fromRow(row); // Rows come back in key order, which is newest first.
    }
    return null;
  }

  async listMeetingsForChat(chatIds: string[], joinUrl: string | undefined, limit: number): Promise<Meeting[]> {
    const conditions: string[] = [];
    for (const id of new Set(chatIds.filter(Boolean))) conditions.push(odata`conversationId eq ${id}`, odata`threadId eq ${id}`);
    if (joinUrl) conditions.push(odata`joinUrl eq ${joinUrl}`);
    if (conditions.length === 0) return [];
    const filter = `${odata`PartitionKey eq ${MEETING_PK}`} and (${conditions.join(' or ')})`;
    const out: Meeting[] = [];
    // Rows come back in key order, which is newest first.
    for await (const row of this.meetings.listEntities<MeetingRow>({ queryOptions: { filter } })) {
      out.push(fromRow(row));
      if (out.length >= limit) break;
    }
    return out;
  }

  async listMeetingsCreatedBefore(isoCutoff: string): Promise<Meeting[]> {
    const cutoff = Date.parse(isoCutoff);
    const out: Meeting[] = [];
    for await (const row of this.meetings.listEntities<MeetingRow>({ queryOptions: { filter: odata`PartitionKey eq ${MEETING_PK}` } })) {
      if (meetingIdTime(row.rowKey) < cutoff) out.push(fromRow(row));
    }
    return out;
  }

  async deleteMeeting(id: string): Promise<void> {
    const meeting = await this.getMeeting(id);
    const keys: string[] = [];
    for await (const row of this.segments.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${id}`, select: ['rowKey'] } })) {
      keys.push(row.rowKey as string);
    }
    for (let i = 0; i < keys.length; i += 100) {
      const actions: TransactionAction[] = keys.slice(i, i + 100).map((rowKey) => ['delete', { partitionKey: id, rowKey }]);
      await this.segments.submitTransaction(actions);
    }
    const people = new Set<string>();
    if (meeting) {
      people.add(meeting.invitedByAadId);
      for (const p of meeting.participants) if (p.aadObjectId) people.add(p.aadObjectId);
    }
    for (const person of people) await this.deleteIfExists(this.userMeetings, person, id);
    await this.container.getBlockBlobClient(`recaps/${id}.json`).deleteIfExists();
    await this.container.getBlockBlobClient(`transcripts/${id}.txt`).deleteIfExists();
    await this.deleteIfExists(this.meetings, MEETING_PK, id);
  }

  private async deleteIfExists(table: TableClient, partitionKey: string, rowKey: string): Promise<void> {
    try {
      await table.deleteEntity(partitionKey, rowKey);
    } catch (err) {
      if (!isStatus(err, 404)) throw err;
    }
  }

  async appendSegments(meetingId: string, segments: Segment[]): Promise<void> {
    for (let i = 0; i < segments.length; i += 100) {
      const actions: TransactionAction[] = segments.slice(i, i + 100).map((s) => [
        'upsert',
        { partitionKey: meetingId, rowKey: seqKey(s.seq), ts: s.ts, speakerId: s.speakerId, speakerName: s.speakerName, text: s.text, kind: s.kind },
        'Replace',
      ]);
      await this.segments.submitTransaction(actions);
    }
  }

  async getSegments(meetingId: string): Promise<Segment[]> {
    const out: Segment[] = [];
    for await (const row of this.segments.listEntities<{ ts: string; speakerId: string; speakerName: string; text: string; kind: string }>({
      queryOptions: { filter: odata`PartitionKey eq ${meetingId}` },
    })) {
      out.push({ seq: Number(row.rowKey), ts: row.ts, speakerId: row.speakerId, speakerName: row.speakerName, text: row.text, kind: row.kind === 'assistant' ? 'assistant' : 'speech' });
    }
    return out;
  }

  async linkUserToMeeting(aadObjectId: string, ref: UserMeetingRef): Promise<void> {
    await this.userMeetings.upsertEntity({ partitionKey: aadObjectId, rowKey: ref.meetingId, title: ref.title, createdAt: ref.createdAt }, 'Replace');
  }

  async listUserMeetings(aadObjectId: string, limit: number): Promise<UserMeetingRef[]> {
    const out: UserMeetingRef[] = [];
    for await (const row of this.userMeetings.listEntities<{ title: string; createdAt: string }>({ queryOptions: { filter: odata`PartitionKey eq ${aadObjectId}` } })) {
      out.push({ meetingId: String(row.rowKey), title: row.title, createdAt: row.createdAt });
      if (out.length >= limit) break;
    }
    return out;
  }

  async userHasMeeting(aadObjectId: string, meetingId: string): Promise<boolean> {
    try {
      await this.userMeetings.getEntity(aadObjectId, meetingId);
      return true;
    } catch (err) {
      if (isStatus(err, 404)) return false;
      throw err;
    }
  }

  async saveUser(user: KnownUser): Promise<void> {
    await this.users.upsertEntity(compact({ partitionKey: USER_PK, rowKey: user.aadObjectId, name: user.name, conversationId: user.conversationId, tenantId: user.tenantId, seenAt: user.seenAt }), 'Merge');
  }

  async getUser(aadObjectId: string): Promise<KnownUser | null> {
    try {
      const row = await this.users.getEntity<{ name: string; conversationId?: string; tenantId: string; seenAt: string }>(USER_PK, aadObjectId);
      return compact({ aadObjectId, name: row.name, conversationId: row.conversationId, tenantId: row.tenantId, seenAt: row.seenAt });
    } catch (err) {
      if (isStatus(err, 404)) return null;
      throw err;
    }
  }

  private async putText(path: string, text: string, contentType: string): Promise<void> {
    const data = Buffer.from(text, 'utf8');
    await this.container.getBlockBlobClient(path).upload(data, data.byteLength, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  private async getText(path: string): Promise<{ text: string; etag: string } | null> {
    try {
      const blob = this.container.getBlockBlobClient(path);
      const buffer = await blob.downloadToBuffer();
      const props = await blob.getProperties();
      return { text: buffer.toString('utf8'), etag: props.etag ?? '' };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }

  async loadIdentityCache(): Promise<string | null> {
    return (await this.getText('identity/teams-signin.enc'))?.text ?? null;
  }

  async saveIdentityCache(encrypted: string): Promise<void> {
    await this.putText('identity/teams-signin.enc', encrypted, 'text/plain; charset=utf-8');
  }

  async saveRecap(meetingId: string, recap: Recap): Promise<void> {
    await this.putText(`recaps/${meetingId}.json`, JSON.stringify(recap, null, 2), 'application/json');
  }

  async getRecap(meetingId: string): Promise<Recap | null> {
    const found = await this.getText(`recaps/${meetingId}.json`);
    return found ? (JSON.parse(found.text) as Recap) : null;
  }

  async saveTranscriptText(meetingId: string, text: string): Promise<void> {
    await this.putText(`transcripts/${meetingId}.txt`, text, 'text/plain; charset=utf-8');
  }

  async saveKb(chunks: KbChunk[]): Promise<void> {
    await this.putText('kb/index.json', JSON.stringify({ updatedAt: new Date().toISOString(), chunks }), 'application/json');
  }

  async loadKb(knownVersion?: string): Promise<{ chunks: KbChunk[]; version: string } | 'unchanged' | null> {
    const blob = this.container.getBlockBlobClient('kb/index.json');
    try {
      const props = await blob.getProperties();
      const version = props.etag ?? '';
      if (knownVersion && knownVersion === version) return 'unchanged';
      const buffer = await blob.downloadToBuffer();
      const parsed = JSON.parse(buffer.toString('utf8')) as { chunks: KbChunk[] };
      return { chunks: parsed.chunks ?? [], version };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }

  async addUsage(entry: UsageEntry, when: Date = new Date()): Promise<void> {
    await this.usage.createEntity(compact({ partitionKey: monthKey(when), rowKey: newEventId(when.getTime()), ...entry }));
  }

  async sumUsage(month: string): Promise<number> {
    let total = 0;
    for await (const row of this.usage.listEntities<{ usd: number }>({ queryOptions: { filter: odata`PartitionKey eq ${month}`, select: ['usd'] } })) {
      total += Number(row.usd) || 0;
    }
    return total;
  }
}
