// A scripted stand in for a Teams meeting. It replays caption and roster events on a timeline
// and measures the audio the assistant sends, so the complete flow can run without Teams.

import type { PageConfig, PageEvent } from '../../core/types.js';
import type { AudioOut } from './audio.js';
import type { CallTransport, TransportEvents } from './transport.js';

export class FakeTransport implements CallTransport {
  private muted = true;
  private timers: number[] = [];
  private meter: number | undefined;
  private ended = false;

  constructor(
    private readonly audio: AudioOut,
    private readonly raise: (event: PageEvent) => void,
  ) {}

  async join(config: PageConfig, _outgoing: MediaStream, events: TransportEvents): Promise<void> {
    events.onState('connecting');
    for (const step of config.fakeScript ?? []) {
      this.timers.push(
        window.setTimeout(() => {
          if (this.ended) return;
          if (step.type === 'state' && step.state) events.onState(step.state);
          if (step.type === 'participants' && step.participants) events.onParticipants(step.participants);
          if (step.type === 'caption' && step.caption) events.onCaption({ ...step.caption, at: Date.now() });
          if (step.type === 'end') {
            this.ended = true;
            events.onState('ended', 'script finished');
          }
        }, step.atMs),
      );
    }
    // Report the outgoing audio level a few times a second, with the mute state at that moment.
    this.meter = window.setInterval(() => {
      const rms = this.audio.level();
      if (rms > 0.005) this.raise({ type: 'audioLevel', rms, muted: this.muted });
    }, 100);
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
  }

  async leave(): Promise<void> {
    this.ended = true;
    for (const t of this.timers) window.clearTimeout(t);
    if (this.meter !== undefined) window.clearInterval(this.meter);
  }
}
