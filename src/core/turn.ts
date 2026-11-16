// Turns a stream of caption events into "someone asked the assistant a question" actions.
//
// The class is pure: it holds no timers. The host calls onCaption for every caption event and
// tick on a short interval, and acts on the returned actions. That keeps it fully testable.

import type { CaptionEvent } from './types.js';
import { WakeMatcher } from './wake.js';

export type TurnAction =
  | { type: 'wake'; speakerId: string; speakerName: string }
  | { type: 'question'; speakerId: string; speakerAadId?: string; speakerName: string; text: string }
  | { type: 'nudge'; speakerId: string; speakerName: string }
  | { type: 'stop' };

export interface TurnOptions {
  wakeNames: string[];
  /** Captions from the assistant itself are ignored. */
  selfId?: string;
  selfName?: string;
  /** Quiet time after the last final caption before the question is considered complete. */
  silenceMs?: number;
  /** A partial caption that never becomes final is accepted after this long. */
  stalePartialMs?: number;
  /** Hard limit on how long one question may run. */
  maxTurnMs?: number;
  /** After the wake phrase with nothing else, how long to wait before asking "Yes?". */
  emptyWaitMs?: number;
  /** After the nudge, how long to keep listening before giving up. */
  followUpMs?: number;
  /** Treat every utterance as addressed to the assistant, without the wake phrase (private calls). */
  alwaysListening?: boolean;
}

interface Listening {
  speakerId: string;
  speakerAadId?: string;
  speakerName: string;
  finals: string[];
  partial: string;
  wakeAt: number;
  lastActivityAt: number;
  nudged: boolean;
  /** False while the wake phrase has only been seen in a partial caption, which may still be revised. */
  confirmed: boolean;
}

export class TurnAssembler {
  private readonly matcher: WakeMatcher;
  private readonly opts: Required<Omit<TurnOptions, 'wakeNames' | 'selfId' | 'selfName' | 'alwaysListening'>> & Pick<TurnOptions, 'selfId' | 'selfName' | 'alwaysListening'>;
  private listening: Listening | null = null;
  private speaking = false;

  constructor(options: TurnOptions) {
    this.matcher = new WakeMatcher(options.wakeNames);
    this.opts = {
      selfId: options.selfId,
      selfName: options.selfName,
      alwaysListening: options.alwaysListening,
      // Teams marks a caption final when the speaker pauses, so a short wait after it is enough.
      silenceMs: options.silenceMs ?? 900,
      stalePartialMs: options.stalePartialMs ?? 4000,
      maxTurnMs: options.maxTurnMs ?? 25000,
      emptyWaitMs: options.emptyWaitMs ?? 5000,
      // Long enough for the person to hear "Yes?", start speaking, and for the caption to arrive
      // two or three seconds later. Measured against a real Teams meeting, 9 seconds was too short.
      followUpMs: options.followUpMs ?? 15000,
    };
  }

  /** The host reports when the assistant starts and stops talking, to enable stop commands. */
  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
  }

  get isListening(): boolean {
    return this.listening !== null;
  }

  isSelf(e: Pick<CaptionEvent, 'speakerId' | 'speakerName'>): boolean {
    if (this.opts.selfId && e.speakerId === this.opts.selfId) return true;
    if (this.opts.selfName && e.speakerName.trim().toLowerCase() === this.opts.selfName.trim().toLowerCase()) return true;
    return false;
  }

  onCaption(e: CaptionEvent): TurnAction[] {
    if (this.isSelf(e)) return [];
    const actions: TurnAction[] = [];

    if (this.speaking && e.final && this.matcher.isStop(e.text)) {
      this.listening = null;
      return [{ type: 'stop' }];
    }

    // In a private call everything said is for the assistant; the wake phrase is optional and is
    // still stripped when used.
    const wake = this.matcher.match(e.text) ?? (this.opts.alwaysListening && e.text.trim() ? { remainder: e.text.trim() } : null);

    if (!this.listening) {
      if (!wake) return [];
      if (this.speaking) actions.push({ type: 'stop' });
      this.listening = {
        speakerId: e.speakerId,
        speakerAadId: e.speakerAadId,
        speakerName: e.speakerName,
        finals: [],
        partial: '',
        wakeAt: e.at,
        lastActivityAt: e.at,
        nudged: false,
        confirmed: e.final,
      };
      actions.push({ type: 'wake', speakerId: e.speakerId, speakerName: e.speakerName });
      this.absorb(wake.remainder, e.final);
      return actions;
    }

    // While listening, only the person who woke the assistant is followed.
    if (e.speakerId !== this.listening.speakerId) return [];
    if (e.final && !this.listening.confirmed) {
      // The recogniser revised the utterance and the wake phrase is gone: it was a mishearing.
      if (!wake) {
        this.listening = null;
        return [];
      }
      this.listening.confirmed = true;
    }
    this.listening.lastActivityAt = e.at;
    // Later partials of the same utterance repeat the wake phrase, so strip it again.
    this.absorb(wake ? wake.remainder : e.text.trim(), e.final);
    return [];
  }

  tick(now: number): TurnAction[] {
    const l = this.listening;
    if (!l) return [];
    const content = l.finals.join(' ').replace(/\s+/g, ' ').trim();
    const partial = l.partial.trim();
    const quietFor = now - l.lastActivityAt;

    if (content && !partial && quietFor >= this.opts.silenceMs) return this.finish(content);
    if ((content || partial) && now - l.wakeAt >= this.opts.maxTurnMs) return this.finish(`${content} ${partial}`.trim());
    if (partial && quietFor >= this.opts.stalePartialMs) return this.finish(`${content} ${partial}`.trim());

    if (!content && !partial) {
      // The follow-up window starts when the assistant has finished saying "Yes?", not when it
      // decided to say it: making and playing the voice takes a few seconds.
      if (l.nudged && this.speaking) {
        l.lastActivityAt = now;
        return [];
      }
      if (!l.nudged && quietFor >= this.opts.emptyWaitMs) {
        l.nudged = true;
        l.lastActivityAt = now;
        return [{ type: 'nudge', speakerId: l.speakerId, speakerName: l.speakerName }];
      }
      if (l.nudged && quietFor >= this.opts.followUpMs) {
        this.listening = null;
      }
    }
    return [];
  }

  reset(): void {
    this.listening = null;
  }

  private absorb(text: string, final: boolean): void {
    const l = this.listening;
    if (!l) return;
    if (final) {
      if (text) l.finals.push(text);
      l.partial = '';
    } else {
      l.partial = text;
    }
  }

  private finish(text: string): TurnAction[] {
    const l = this.listening;
    this.listening = null;
    if (!l || !text) return [];
    return [{ type: 'question', speakerId: l.speakerId, speakerAadId: l.speakerAadId, speakerName: l.speakerName, text }];
  }
}
