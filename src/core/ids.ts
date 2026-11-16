import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_MS = 9_999_999_999_999;

/**
 * Meeting ids sort newest first: a 13 digit reversed timestamp followed by random characters.
 * Azure Table Storage returns rows in key order, so listing a user's meetings needs no sorting.
 */
export function newMeetingId(now: number = Date.now()): string {
  const reversed = String(MAX_MS - now).padStart(13, '0');
  return `${reversed}${randomBytes(5).toString('hex')}`;
}

export function meetingIdTime(id: string): number {
  return MAX_MS - Number(id.slice(0, 13));
}

/** Ids for append only rows. They sort oldest first. */
export function newEventId(now: number = Date.now()): string {
  return `${String(now).padStart(13, '0')}${randomBytes(5).toString('hex')}`;
}

export function seqKey(seq: number): string {
  return String(seq).padStart(8, '0');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A token that lets one worker act on one meeting only. */
export function meetingToken(secret: string, meetingId: string): string {
  return createHmac('sha256', secret).update(`meeting:${meetingId}`).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function monthKey(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
