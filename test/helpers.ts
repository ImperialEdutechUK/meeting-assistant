import type { Meeting, Segment } from '../src/core/types.js';

export function sampleMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: '8200000000000aaaaaaaaaa',
    status: 'live',
    title: 'Course page publishing sync',
    joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d',
    conversationId: '19:meeting_abc@thread.v2',
    tenantId: 'tenant-1',
    invitedByAadId: 'aad-alex',
    invitedByName: 'Alex Morgan',
    createdAt: '2026-11-16T09:00:00.000Z',
    startedAt: '2026-11-16T09:00:30.000Z',
    participants: [
      { id: 'aad-alex', aadObjectId: 'aad-alex', displayName: 'Alex Morgan', kind: 'teams' },
      { id: 'aad-jordan', aadObjectId: 'aad-jordan', displayName: 'Jordan', kind: 'teams' },
    ],
    ...overrides,
  };
}

export function seg(seq: number, speakerName: string, text: string, offsetSeconds: number, kind: Segment['kind'] = 'speech'): Segment {
  return {
    seq,
    ts: new Date(Date.parse('2026-11-16T09:00:30.000Z') + offsetSeconds * 1000).toISOString(),
    speakerId: speakerName === 'Alex Morgan' ? 'aad-alex' : speakerName === 'Jordan' ? 'aad-jordan' : 'assistant',
    speakerName,
    text,
    kind,
  };
}

export const SAMPLE_SEGMENTS: Segment[] = [
  seg(0, 'Alex Morgan', 'Jordan, the first batch of course pages goes to Marketing on Friday.', 20),
  seg(1, 'Alex Morgan', 'Each page needs the course fee checked before it is published.', 35),
  seg(2, 'Jordan', 'Understood. I will publish batch one on Monday and send you the links.', 50),
  seg(3, 'Alex Morgan', 'Good. Batch two follows a week later.', 62),
];
