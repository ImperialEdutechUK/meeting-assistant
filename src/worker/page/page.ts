// Runs inside headless Chrome. The Node host drives it through the functions on window and
// receives events through window.__host.

import type { PageConfig, PageEvent } from '../../core/types.js';
import { AudioOut } from './audio.js';
import type { CallTransport, TransportEvents } from './transport.js';
import { AcsTransport } from './transport-acs.js';
import { FakeTransport } from './transport-fake.js';

declare global {
  interface Window {
    __host: (event: PageEvent) => Promise<void> | void;
    __start: (config: PageConfig) => Promise<void>;
    __play: (audioB64: string) => Promise<void>;
    __chime: () => Promise<void>;
    __stopAudio: () => void;
    __setMuted: (muted: boolean) => Promise<void>;
    __leave: () => Promise<void>;
    /** Receiver: sign in as the assistant's Teams account and wait for calls. */
    __listen: (config: PageConfig) => Promise<void>;
    __accept: (language: string) => Promise<void>;
    __reject: () => Promise<void>;
    /** Provided by the host: a fresh calling token for the assistant's Teams account. */
    __teamsToken: () => Promise<string>;
  }
}

let audio: AudioOut | undefined;
let transport: CallTransport | undefined;

function raise(event: PageEvent): void {
  try {
    void window.__host(event);
  } catch (err) {
    console.error('Could not reach the host', err);
  }
}

function decode(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const transportEvents: TransportEvents = {
  onState: (state, reason, threadId) => raise({ type: 'state', state, ...(reason ? { reason } : {}), ...(threadId ? { threadId } : {}) }),
  onParticipants: (participants) => raise({ type: 'participants', participants }),
  onCaption: (caption) => raise({ type: 'caption', caption }),
  onLog: (level, message) => raise({ type: 'log', level, message }),
};

function newAudio(): AudioOut {
  const out = new AudioOut();
  out.onPlaying = (playing) => raise({ type: 'playback', playing });
  return out;
}

window.__start = async (config: PageConfig) => {
  audio = newAudio();
  transport = config.transport === 'fake' ? new FakeTransport(audio, raise) : new AcsTransport();
  await transport.join(config, audio.stream, transportEvents);
};

let receiver: AcsTransport | undefined;

window.__listen = async (config: PageConfig) => {
  audio = newAudio();
  receiver = new AcsTransport();
  transport = receiver;
  await receiver.listen(config, audio.stream, transportEvents, () => window.__teamsToken(), (info) => raise({ type: 'incoming', ...info }));
};
window.__accept = async (language: string) => {
  await receiver?.accept(language);
};
window.__reject = async () => {
  await receiver?.reject();
};

window.__play = async (audioB64: string) => {
  await audio?.enqueue(decode(audioB64));
};
window.__chime = async () => {
  await audio?.chime();
};
window.__stopAudio = () => audio?.stop();
window.__setMuted = async (muted: boolean) => {
  await transport?.setMuted(muted);
};
window.__leave = async () => {
  audio?.stop();
  await transport?.leave();
};

window.addEventListener('error', (e) => raise({ type: 'log', level: 'error', message: `Page error: ${e.message}` }));
window.addEventListener('unhandledrejection', (e) => raise({ type: 'log', level: 'error', message: `Unhandled rejection: ${String(e.reason)}` }));
