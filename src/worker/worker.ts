// The meeting worker. One worker serves one meeting: it claims a meeting from the control
// service, opens headless Chrome, joins the call, forwards what it hears and plays the answers.

import { readFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, chromium } from 'playwright-core';
import type { WorkerConfig } from '../core/config.js';
import { type Logger, errorMessage, logger } from '../core/log.js';
import { SegmentBuilder } from '../core/transcript.js';
import { type TurnAction, TurnAssembler } from '../core/turn.js';
import type { AnswerLine, CallState, FakeScriptStep, IncomingCallInfo, PageConfig, PageEvent, Participant, WorkerAssignment, WorkerEvent } from '../core/types.js';

const CHROME_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-dev-shm-usage',
  '--no-sandbox',
];

const NUDGE_TEXT = 'Yes? I am listening.';
/** How long the receiver waits for the control service to decide on a ringing call. */
export const INCOMING_CHECK_TIMEOUT_MS = 45_000;
/** While waiting for calls, the receiver pings the control service this often so it never sleeps. */
export const KEEP_AWAKE_MS = 60_000;
const SORRY_TEXT = 'Sorry, I could not work that out. Please ask me again.';

export interface WorkerOptions {
  config: WorkerConfig;
  /** Only for the fake transport: the scripted meeting to replay. */
  fakeScript?: FakeScriptStep[];
  /** Folder holding index.html and page.js. Defaults to dist/page next to the compiled code. */
  pageDir?: string;
  /** Test hook that sees every event the page raises. */
  onPageEvent?: (event: PageEvent) => void;
  log?: Logger;
}

export interface WorkerResult {
  meetingId?: string;
  outcome: 'no-meeting' | 'ended' | 'failed';
  reason: string;
}

class ControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
    private readonly standby = false,
  ) {}

  private token = '';
  private meetingId = '';

  async claim(): Promise<WorkerAssignment | null> {
    // A standby worker says so, which tells the control service it need not start a new worker.
    const headers: Record<string, string> = { Authorization: `Bearer ${this.sharedSecret}`, ...(this.standby ? { 'X-Worker-Standby': '1' } : {}) };
    const response = await fetch(`${this.baseUrl}/internal/claim`, { method: 'POST', headers, signal: AbortSignal.timeout(15_000) });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`Claim failed with status ${response.status}`);
    const assignment = (await response.json()) as WorkerAssignment;
    this.token = assignment.meetingToken;
    this.meetingId = assignment.meetingId;
    return assignment;
  }

  private post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/internal/meetings/${this.meetingId}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** Receiver: a calling token for the assistant's Teams account, or null if it is not connected. */
  async teamsToken(): Promise<string | null> {
    const response = await fetch(`${this.baseUrl}/internal/teams/token`, { method: 'POST', headers: { Authorization: `Bearer ${this.sharedSecret}` }, signal: AbortSignal.timeout(15_000) });
    if (response.status === 503) return null;
    if (!response.ok) throw new Error(`Token request failed with status ${response.status}`);
    return ((await response.json()) as { token: string }).token;
  }

  /**
   * Receiver: asks whether to take an incoming call. Returns the assignment, or null to decline.
   * The wait is generous because a call rings for longer than this, and a control service waking
   * from idle needs time to start and fetch the assistant's calling token. Giving up early once
   * declined a call that the control service then accepted.
   */
  async incoming(info: IncomingCallInfo): Promise<WorkerAssignment | null> {
    const response = await fetch(`${this.baseUrl}/internal/teams/incoming`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.sharedSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(info),
      signal: AbortSignal.timeout(INCOMING_CHECK_TIMEOUT_MS),
    });
    if (response.status === 403) return null;
    if (!response.ok) throw new Error(`Incoming call check failed with status ${response.status}`);
    const assignment = (await response.json()) as WorkerAssignment;
    this.token = assignment.meetingToken;
    this.meetingId = assignment.meetingId;
    return assignment;
  }

  /** Receiver: a light request that keeps the control service awake while waiting for calls. */
  async keepAwake(): Promise<void> {
    await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
  }

  async events(events: WorkerEvent[]): Promise<string[]> {
    const response = await this.post('events', { events }, AbortSignal.timeout(15_000));
    if (!response.ok) throw new Error(`Events failed with status ${response.status}`);
    const body = (await response.json()) as { commands?: string[] };
    return body.commands ?? [];
  }

  async speak(text: string): Promise<AnswerLine> {
    const response = await this.post('speak', { text }, AbortSignal.timeout(25_000));
    if (!response.ok) throw new Error(`Speak failed with status ${response.status}`);
    return (await response.json()) as AnswerLine;
  }

  /** Asks a question and yields the answer line by line as the control service produces it. */
  async *ask(body: { question: string; speakerName: string; speakerAadId?: string }, signal: AbortSignal): AsyncGenerator<AnswerLine> {
    const response = await this.post('ask', body, signal);
    if (!response.ok || !response.body) throw new Error(`Ask failed with status ${response.status}`);
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield JSON.parse(line) as AnswerLine;
        newline = buffered.indexOf('\n');
      }
    }
    if (buffered.trim()) yield JSON.parse(buffered) as AnswerLine;
  }
}

async function servePage(dir: string): Promise<{ url: string; server: Server }> {
  const files: Record<string, { type: string; body: Buffer }> = {
    '/index.html': { type: 'text/html; charset=utf-8', body: await readFile(join(dir, 'index.html')) },
    '/page.js': { type: 'text/javascript; charset=utf-8', body: await readFile(join(dir, 'page.js')) },
  };
  const server = createServer((req, res) => {
    const file = files[(req.url ?? '/').split('?')[0] ?? ''];
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' }).end(file.body);
  });
  // localhost counts as a secure context, which the calling SDK and the Web Audio API require.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://localhost:${port}/index.html`, server };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface PreparedBrowser {
  server: Server;
  browser: Browser;
  page: Page;
}

/** Starts Chrome and loads the calling page. Done while waiting for a meeting, so joining starts at once. */
async function prepareBrowser(
  pageDir: string,
  config: WorkerConfig,
  onPageEvent: (event: PageEvent) => void,
  teamsToken?: () => Promise<string>,
): Promise<PreparedBrowser> {
  const served = await servePage(pageDir);
  try {
    // Without an explicit path, ask Playwright for full Chromium (not the cut down headless shell),
    // because the calling SDK needs the complete WebRTC stack.
    const browser = await chromium.launch({ headless: config.headless, ...(config.chromePath ? { executablePath: config.chromePath } : { channel: 'chromium' }), args: CHROME_ARGS });
    const context = await browser.newContext();
    await context.grantPermissions(['microphone'], { origin: new URL(served.url).origin }).catch(() => undefined);
    const page = await context.newPage();
    await page.exposeFunction('__host', onPageEvent);
    if (teamsToken) await page.exposeFunction('__teamsToken', teamsToken);
    await page.goto(served.url);
    return { server: served.server, browser, page };
  } catch (err) {
    served.server.close();
    throw err;
  }
}

/**
 * Receiver: signs the page in as the assistant's Teams account and waits for calls until the
 * deadline. Each call is checked with the control service; the first one it accepts is returned
 * (and answered later, once the meeting handlers are in place). Others are declined.
 */
async function waitForCall(
  prepared: Promise<PreparedBrowser>,
  control: ControlClient,
  config: WorkerConfig,
  deadline: number,
  log: Logger,
  setForward: (handler: (event: PageEvent) => void) => void,
): Promise<WorkerAssignment | null> {
  const { page } = await prepared;
  const token = await control.teamsToken();
  if (!token) {
    log.warn('The assistant Teams account is not connected; an admin must send "connect assistant account" in Teams');
    await sleep(Math.min(60_000, Math.max(0, deadline - Date.now())));
    return null;
  }
  const calls: IncomingCallInfo[] = [];
  setForward((event) => {
    if (event.type === 'incoming') {
      const { type: _type, ...info } = event;
      calls.push(info);
    } else if (event.type === 'log') {
      log[event.level](`Page: ${event.message}`);
    }
  });
  const listenConfig: PageConfig = { transport: config.transport, joinUrl: '', displayName: '', acsToken: token, spokenLanguage: 'en-gb' };
  await page.evaluate((c) => window.__listen(c), listenConfig);
  // The control service scales to zero when idle. Keep it awake while waiting, so a ringing call
  // is decided in a second instead of waiting for it to start.
  let lastPing = Date.now();
  while (Date.now() < deadline) {
    if (Date.now() - lastPing >= KEEP_AWAKE_MS) {
      lastPing = Date.now();
      void control.keepAwake();
    }
    const call = calls.shift();
    if (!call) {
      await sleep(250);
      continue;
    }
    let assignment: WorkerAssignment | null = null;
    const checkStarted = Date.now();
    try {
      assignment = await control.incoming(call);
    } catch (err) {
      log.warn('Could not check an incoming call', { error: errorMessage(err), ms: Date.now() - checkStarted });
    }
    log.info('Incoming call checked', { ms: Date.now() - checkStarted, accepted: assignment !== null });
    if (assignment) {
      log.info('Answering a call', { group: call.groupCall });
      return assignment;
    }
    log.info('Declining a call', { group: call.groupCall });
    await page.evaluate(() => window.__reject()).catch(() => undefined);
  }
  return null;
}

export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const { config } = options;
  const log = options.log ?? logger('worker');
  const control = new ControlClient(config.controlUrl, config.workerSharedSecret, config.mode === 'standby');

  // 1. Start the browser while claiming, so no time is lost once a meeting is assigned. Page events
  // go through a forwarder because the handler needs the assignment, which is not known yet.
  const pageDir = options.pageDir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'page');
  let forward: (event: PageEvent) => void = () => undefined;
  const receiver = config.mode === 'receiver';
  const refreshTeamsToken = async (): Promise<string> => {
    const token = await control.teamsToken();
    if (!token) throw new Error('The assistant Teams account is not connected');
    return token;
  };
  const prepared = prepareBrowser(pageDir, config, (event) => forward(event), receiver ? refreshTeamsToken : undefined);
  prepared.catch(() => undefined); // Reported after the claim, where it can fail the meeting.

  // 2. Get something to do: claim a meeting, or (receiver) wait for a call to the assistant.
  let assignment: WorkerAssignment | null = null;
  const claimDeadline = Date.now() + config.claimWaitSeconds * 1000;
  if (receiver) {
    assignment = await waitForCall(prepared, control, config, claimDeadline, log, (handler) => {
      forward = handler;
    }).catch((err) => {
      log.error('Could not wait for calls', { error: errorMessage(err) });
      return null;
    });
  }
  while (!receiver && !assignment && Date.now() < claimDeadline) {
    try {
      assignment = await control.claim();
    } catch (err) {
      log.warn('Claim attempt failed', { error: errorMessage(err) });
    }
    if (!assignment) await sleep(1000);
  }
  if (!assignment) {
    log.info('No meeting to claim, exiting');
    await prepared.then(async (p) => {
      await p.browser.close().catch(() => undefined);
      p.server.close();
    }, () => undefined);
    return { outcome: 'no-meeting', reason: 'nothing pending' };
  }
  const a = assignment;
  log.info('Claimed meeting', { meetingId: a.meetingId });

  let server: Server | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;

  // ---- State -------------------------------------------------------------------------------
  const turn = new TurnAssembler({ wakeNames: a.wakeNames, selfId: a.acsUserId, selfName: a.displayName, alwaysListening: a.alwaysListening === true });
  const segments = new SegmentBuilder();
  const outbox: WorkerEvent[] = [];
  const startedAt = Date.now();
  let state: CallState = 'connecting';
  let connectedAt = 0;
  let lobbySince = 0;
  let aloneSince = 0;
  let others = 0;
  let seenOthers = false;
  let playing = false;
  let answering: AbortController | null = null;
  let busy = 0;
  let finished: { reason: string } | null = null;
  let lastFlush = 0;
  let lastContact = Date.now();
  let muteTimer: NodeJS.Timeout | undefined;

  const finish = (reason: string) => {
    if (!finished) finished = { reason };
  };

  const inPage = async <T>(fn: (arg: T) => unknown, arg: T): Promise<void> => {
    if (!page || page.isClosed()) return;
    try {
      await page.evaluate(fn as (arg: unknown) => unknown, arg);
    } catch (err) {
      // Once the call has ended (for example the assistant was removed), an action already in
      // flight fails as expected. Only failures during a live call are worth a warning.
      const message = errorMessage(err).split('\n')[0] ?? '';
      if (finished || /Call ended for this participant/i.test(message)) log.debug('Page call after the call ended', { error: message });
      else log.warn('Page call failed', { error: message });
    }
  };
  const setMuted = (muted: boolean) => inPage((m: boolean) => window.__setMuted(m), muted);
  const play = (line: AnswerLine) => (line.type === 'sentence' && line.audioB64 ? inPage((b64: string) => window.__play(b64), line.audioB64) : Promise.resolve());
  const stopAudio = () => inPage(() => window.__stopAudio(), undefined);

  /** Mutes again once the assistant has nothing left to say. */
  const scheduleMute = () => {
    clearTimeout(muteTimer);
    muteTimer = setTimeout(() => {
      if (!playing && busy === 0 && !turn.isListening) void setMuted(true);
    }, 600);
  };

  const flush = async (force: boolean) => {
    const drained = segments.drain(Date.now(), force);
    if (drained.length > 0) outbox.push({ type: 'segments', segments: drained });
    const batch = outbox.splice(0, outbox.length);
    lastFlush = Date.now();
    try {
      const commands = await control.events(batch);
      lastContact = Date.now();
      if (commands.includes('leave')) finish('asked to leave');
    } catch (err) {
      // Keep the events and try again on the next flush.
      outbox.unshift(...batch);
      log.warn('Could not reach the control service', { error: errorMessage(err) });
      // Never sit in a meeting unsupervised: without the control service nobody can ask it to leave.
      if (Date.now() - lastContact > 3 * 60_000) finish('lost contact with the control service');
    }
  };

  const sayPhrase = async (text: string) => {
    busy++;
    try {
      const line = await control.speak(text);
      if (line.type !== 'sentence') return;
      await setMuted(false);
      await play(line);
      segments.addAssistant(a.displayName, text, Date.now());
    } catch (err) {
      log.warn('Could not say a phrase', { error: errorMessage(err) });
    } finally {
      busy--;
      scheduleMute();
    }
  };

  const answer = async (action: Extract<TurnAction, { type: 'question' }>) => {
    answering?.abort();
    const abort = new AbortController();
    answering = abort;
    busy++;
    const askedAt = Date.now();
    try {
      // Make sure the control service has everything said so far, including the question itself.
      await flush(true);
      await setMuted(false);
      let spoke = false;
      for await (const line of control.ask({ question: action.text, speakerName: action.speakerName, speakerAadId: action.speakerAadId }, abort.signal)) {
        if (abort.signal.aborted) break;
        if (line.type === 'sentence') {
          // Time from the end of the question to the first audio, to measure answer speed.
          if (!spoke) log.info('Answer started', { ms: Date.now() - askedAt });
          spoke = true;
          await play(line);
        } else if (line.type === 'done') {
          if (line.text) segments.addAssistant(a.displayName, line.text, Date.now());
        } else if (line.type === 'error') {
          log.warn('The control service could not answer', { message: line.message });
          if (!spoke) await sayPhrase(SORRY_TEXT);
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        log.error('Answer failed', { error: errorMessage(err) });
        await sayPhrase(SORRY_TEXT);
      }
    } finally {
      busy--;
      if (answering === abort) answering = null;
      scheduleMute();
    }
  };

  const act = (actions: TurnAction[]) => {
    for (const action of actions) {
      if (action.type === 'stop') {
        answering?.abort();
        void stopAudio();
        scheduleMute();
      } else if (action.type === 'wake') {
        clearTimeout(muteTimer);
        // In a private call every sentence is a question, so a chime each time would be tiresome.
        void setMuted(false).then(() => (a.alwaysListening ? undefined : inPage(() => window.__chime(), undefined)));
      } else if (action.type === 'nudge') {
        void sayPhrase(NUDGE_TEXT);
      } else if (action.type === 'question') {
        log.info('Question heard', { from: action.speakerName, text: action.text });
        void answer(action);
      }
    }
  };

  const onPageEvent = (event: PageEvent) => {
    options.onPageEvent?.(event);
    if (event.type === 'caption') {
      if (turn.isSelf(event.caption)) return;
      segments.add(event.caption);
      // Captions arrive a second or two after the words were spoken. Pauses are judged by when
      // captions arrive, so that delay cannot be mistaken for silence.
      act(turn.onCaption({ ...event.caption, at: Date.now() }));
    } else if (event.type === 'playback') {
      playing = event.playing;
      turn.setSpeaking(event.playing);
      if (!event.playing) scheduleMute();
    } else if (event.type === 'participants') {
      const list: Participant[] = event.participants.filter((p) => p.id !== a.acsUserId);
      others = list.length;
      outbox.push({ type: 'participants', participants: list });
    } else if (event.type === 'state') {
      if (event.state === state && event.state !== 'ended') return;
      state = event.state;
      log.info('Call state', { state: event.state, reason: event.reason });
      if (event.state === 'lobby') {
        lobbySince = Date.now();
        outbox.push({ type: 'state', state: 'lobby' });
      } else if (event.state === 'connected') {
        connectedAt = Date.now();
        lobbySince = 0;
        outbox.push({ type: 'state', state: 'connected', ...(event.threadId ? { threadId: event.threadId } : {}) });
        if (a.announceOnJoin) setTimeout(() => void sayPhrase(a.announcement), 2500);
      } else if (event.state === 'ended') {
        finish(event.reason ?? 'call ended');
      }
    } else if (event.type === 'log') {
      log[event.level](`Page: ${event.message}`);
      if (event.level === 'error') outbox.push({ type: 'note', message: event.message.slice(0, 500) });
    }
  };

  // ---- Run ---------------------------------------------------------------------------------
  let failure: string | null = null;
  try {
    const ready = await prepared;
    server = ready.server;
    browser = ready.browser;
    page = ready.page;
    forward = onPageEvent;
    page.on('console', (message) => {
      if (message.type() === 'error') log.debug('Browser console error', { text: message.text().slice(0, 300) });
    });
    page.on('crash', () => finish('browser page crashed'));
    if (receiver) {
      // The call is ringing; answer it now that everything that handles it is in place.
      await page.evaluate((language) => window.__accept(language), a.spokenLanguage);
    } else {
      const pageConfig: PageConfig = {
        transport: config.transport,
        joinUrl: a.joinUrl,
        displayName: a.displayName,
        acsToken: a.acsToken,
        spokenLanguage: a.spokenLanguage,
        ...(options.fakeScript ? { fakeScript: options.fakeScript } : {}),
      };
      await page.evaluate((c) => window.__start(c), pageConfig);
    }

    while (!finished) {
      await sleep(200);
      const now = Date.now();
      act(turn.tick(now));
      // The state changes inside event callbacks, which the type checker cannot see.
      const current = state as CallState;
      if (current === 'lobby' && lobbySince && now - lobbySince > a.lobbyTimeoutSeconds * 1000) finish('nobody admitted the assistant from the lobby');
      if (current === 'connecting' && now - startedAt > 90_000) finish('could not connect to the meeting');
      if (current === 'connected') {
        // Once people have been seen and have all gone, leave after the short alone timeout. If
        // nobody has been seen yet, give the roster half a minute to arrive first.
        if (others > 0) seenOthers = true;
        if (others === 0 && (seenOthers || now - connectedAt > 30_000)) {
          aloneSince ||= now;
          if (now - aloneSince > a.aloneTimeoutSeconds * 1000) finish('everyone else left');
        } else {
          aloneSince = 0;
        }
      }
      if (now - startedAt > a.maxMeetingMinutes * 60_000) finish('maximum meeting length reached');
      if (now - lastFlush > 2000) await flush(false);
    }
  } catch (err) {
    failure = errorMessage(err);
    log.error('Worker failed', { error: failure });
    finish(`worker error: ${failure}`);
  }

  // ---- Leave and report --------------------------------------------------------------------
  const reason = (finished as { reason: string } | null)?.reason ?? 'ended';
  clearTimeout(muteTimer);
  (answering as AbortController | null)?.abort();
  try {
    await inPage(() => window.__leave(), undefined);
  } catch {
    // The page may already be gone.
  }
  const final = segments.drain(Date.now(), true);
  if (final.length > 0) outbox.push({ type: 'segments', segments: final });
  outbox.push({ type: 'state', state: 'ended', reason });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await control.events([...outbox]);
      outbox.length = 0;
      break;
    } catch (err) {
      log.warn('Could not send the final report, retrying', { error: errorMessage(err) });
      await sleep(2000 * (attempt + 1));
    }
  }
  await browser?.close().catch(() => undefined);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  log.info('Worker finished', { meetingId: a.meetingId, reason });
  return { meetingId: a.meetingId, outcome: failure ? 'failed' : 'ended', reason };
}

// The functions below exist in the browser page. These declarations let page.evaluate callbacks type check.
declare const window: {
  __start(config: PageConfig): Promise<void>;
  __listen(config: PageConfig): Promise<void>;
  __accept(language: string): Promise<void>;
  __reject(): Promise<void>;
  __play(audioB64: string): Promise<void>;
  __chime(): Promise<void>;
  __stopAudio(): void;
  __setMuted(muted: boolean): Promise<void>;
  __leave(): Promise<void>;
};
