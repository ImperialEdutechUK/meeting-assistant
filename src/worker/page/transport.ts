import type { CallState, CaptionEvent, PageConfig, Participant } from '../../core/types.js';

export interface TransportEvents {
  /** threadId is the Teams meeting chat id, reported with "connected" when the call knows it. */
  onState(state: CallState, reason?: string, threadId?: string): void;
  onParticipants(participants: Participant[]): void;
  onCaption(caption: CaptionEvent): void;
  onLog(level: 'info' | 'warn' | 'error', message: string): void;
}

/** The calling layer. The real one talks to Teams, the fake one replays a script for tests. */
export interface CallTransport {
  join(config: PageConfig, outgoing: MediaStream, events: TransportEvents): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  leave(): Promise<void>;
}
