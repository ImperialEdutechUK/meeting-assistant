import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AzureStore } from '../src/core/store-azure.js';
import { MemoryStore, type Store } from '../src/core/store.js';
import { monthKey, newMeetingId } from '../src/core/ids.js';
import { startAzurite } from './azurite.js';
import { SAMPLE_SEGMENTS, sampleMeeting, seg } from './helpers.js';

let azurite: { connectionString: string; stop: () => void };

beforeAll(async () => {
  azurite = await startAzurite();
  // Azurite can take 25 seconds or more to start on Windows while other test files run in parallel.
}, 120_000);

afterAll(() => azurite?.stop());

function contract(name: string, make: () => Store) {
  describe(`Store contract: ${name}`, () => {
    let store: Store;
    beforeAll(async () => {
      store = make();
      await store.init();
      await store.init(); // Safe to run twice.
    });

    it('creates, reads and merges meetings', async () => {
      const m = sampleMeeting({ id: newMeetingId(), status: 'pending' });
      await store.createMeeting(m);
      expect(await store.getMeeting(m.id)).toEqual(m);
      const updated = await store.updateMeeting(m.id, { status: 'live', minutes: 12, participants: [...m.participants, { id: 'x', displayName: 'Guest', kind: 'acs' }] });
      expect(updated.status).toBe('live');
      expect(updated.title).toBe(m.title);
      expect(updated.participants).toHaveLength(3);
      expect(await store.getMeeting('missing')).toBeNull();
      expect((await store.findLatestMeetingForConversation(m.conversationId as string))?.id).toBe(m.id);
    });

    it('finds a meeting by the thread id the call reported, as well as by its own chat', async () => {
      const short = { ...sampleMeeting(), id: newMeetingId(), conversationId: undefined, joinUrl: 'https://teams.microsoft.com/meet/123?p=x' };
      delete (short as { conversationId?: string }).conversationId;
      await store.createMeeting(short);
      const thread = `19:meeting_${short.id}@thread.v2`;
      expect(await store.findLatestMeetingForConversation(thread)).toBeNull();
      await store.updateMeeting(short.id, { threadId: thread });
      expect(await store.findLatestMeetingForConversation(thread)).toMatchObject({ id: short.id, threadId: thread });
    });

    it('lets exactly one worker claim each pending meeting, oldest first', async () => {
      const first = sampleMeeting({ id: newMeetingId(Date.now() - 5000), status: 'pending', conversationId: 'c-claim-1', createdAt: new Date(Date.now() - 5000).toISOString() });
      const second = sampleMeeting({ id: newMeetingId(), status: 'pending', conversationId: 'c-claim-2', createdAt: new Date().toISOString() });
      await store.createMeeting(first);
      await store.createMeeting(second);
      const claims = await Promise.all([store.claimPendingMeeting(), store.claimPendingMeeting(), store.claimPendingMeeting(), store.claimPendingMeeting()]);
      const ids = claims.filter(Boolean).map((c) => c?.id);
      expect(ids.sort()).toEqual([first.id, second.id].sort());
      expect(new Set(ids).size).toBe(2);
      expect((await store.getMeeting(first.id))?.status).toBe('claimed');
      expect(await store.claimPendingMeeting()).toBeNull();
    });

    it('stores transcript segments in order and is safe to resend', async () => {
      const id = newMeetingId();
      await store.createMeeting(sampleMeeting({ id, conversationId: 'c-seg' }));
      const many = Array.from({ length: 230 }, (_, i) => seg(i, i % 2 ? 'Jordan' : 'Alex Morgan', `Line ${i} with "quotes" and 'apostrophes'.`, i));
      await store.appendSegments(id, many.slice(0, 150));
      await store.appendSegments(id, many.slice(140));
      const back = await store.getSegments(id);
      expect(back).toHaveLength(230);
      expect(back.map((s) => s.seq)).toEqual(many.map((s) => s.seq));
      expect(back[229]).toEqual(many[229]);
    });

    it('indexes meetings per person, newest first', async () => {
      const older = newMeetingId(Date.now() - 86_400_000);
      const newer = newMeetingId();
      await store.linkUserToMeeting('aad-index', { meetingId: older, title: 'Older', createdAt: 'a' });
      await store.linkUserToMeeting('aad-index', { meetingId: newer, title: 'Newer', createdAt: 'b' });
      await store.linkUserToMeeting('aad-index', { meetingId: newer, title: 'Newer renamed', createdAt: 'b' });
      expect((await store.listUserMeetings('aad-index', 10)).map((r) => r.title)).toEqual(['Newer renamed', 'Older']);
      expect(await store.listUserMeetings('aad-index', 1)).toHaveLength(1);
      expect(await store.userHasMeeting('aad-index', older)).toBe(true);
      expect(await store.userHasMeeting('aad-other', older)).toBe(false);
    });

    it('remembers people, recaps, the knowledge base and usage', async () => {
      await store.saveUser({ aadObjectId: 'aad-u', name: 'Alex Morgan', tenantId: 't', seenAt: '2026-11-16T09:00:00Z' });
      await store.saveUser({ aadObjectId: 'aad-u', name: 'Alex Morgan', tenantId: 't', seenAt: '2026-11-17T09:00:00Z', conversationId: 'a:personal' });
      expect(await store.getUser('aad-u')).toMatchObject({ conversationId: 'a:personal', seenAt: '2026-11-17T09:00:00Z' });
      expect(await store.getUser('nobody')).toBeNull();

      const recap = { title: 'T', summary: 'S', decisions: ['D'], actions: [{ owner: 'O', task: 'K' }], explained: [], openQuestions: [] };
      await store.saveRecap('m-recap', recap);
      expect(await store.getRecap('m-recap')).toEqual(recap);
      expect(await store.getRecap('m-none')).toBeNull();

      const chunks = [{ id: 'c1', docTitle: 'Doc', source: 's', text: 'Hello' }];
      await store.saveKb(chunks);
      const loaded = await store.loadKb();
      expect(loaded && loaded !== 'unchanged' ? loaded.chunks : null).toEqual(chunks);
      const version = loaded && loaded !== 'unchanged' ? loaded.version : '';
      expect(await store.loadKb(version)).toBe('unchanged');

      const when = new Date('2031-03-05T00:00:00Z');
      await store.addUsage({ kind: 'llm', meetingId: 'm', usd: 0.0125, quantity: 1000 }, when);
      await store.addUsage({ kind: 'meeting', meetingId: 'm', usd: 1.5, quantity: 60 }, when);
      expect(await store.sumUsage(monthKey(when))).toBeCloseTo(1.5125, 10);
      expect(await store.sumUsage('209901')).toBe(0);
    });

    it('deletes a meeting with everything that points to it', async () => {
      const m = sampleMeeting({ id: newMeetingId(Date.parse('2026-01-01T00:00:00Z')), conversationId: 'c-del', createdAt: '2026-01-01T00:00:00.000Z' });
      await store.createMeeting(m);
      await store.appendSegments(m.id, SAMPLE_SEGMENTS);
      await store.saveRecap(m.id, { title: 'T', summary: 'S', decisions: [], actions: [], explained: [], openQuestions: [] });
      await store.saveTranscriptText(m.id, 'text');
      await store.linkUserToMeeting('aad-alex', { meetingId: m.id, title: m.title, createdAt: m.createdAt });
      const old = await store.listMeetingsCreatedBefore('2026-06-01T00:00:00.000Z');
      expect(old.map((x) => x.id)).toContain(m.id);
      await store.deleteMeeting(m.id);
      expect(await store.getMeeting(m.id)).toBeNull();
      expect(await store.getSegments(m.id)).toEqual([]);
      expect(await store.getRecap(m.id)).toBeNull();
      expect(await store.userHasMeeting('aad-alex', m.id)).toBe(false);
      await store.deleteMeeting(m.id); // Deleting twice is harmless.
    });
  });
}

contract('memory', () => new MemoryStore());
contract('Azure Table and Blob Storage (Azurite emulator)', () => new AzureStore({ connectionString: azurite.connectionString, tablePrefix: `t${Date.now()}` }));
