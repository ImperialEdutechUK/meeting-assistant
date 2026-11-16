// Joins a Teams meeting through the Azure Communication Services Calling SDK, as an external
// participant, and listens through Teams live captions.

import { CallClient, Features, LocalAudioStream } from '@azure/communication-calling';
import type { CallCommon, RemoteParticipant, TeamsCaptions, TeamsCaptionsInfo, TeamsIncomingCall } from '@azure/communication-calling';
import { AzureCommunicationTokenCredential, type CommunicationIdentifierKind } from '@azure/communication-common';
import type { CallState, IncomingCallInfo, PageConfig, Participant } from '../../core/types.js';
import type { CallTransport, TransportEvents } from './transport.js';

function describe(identifier: CommunicationIdentifierKind | undefined): { id: string; aadObjectId?: string; kind: Participant['kind'] } {
  if (!identifier) return { id: 'unknown', kind: 'unknown' };
  switch (identifier.kind) {
    case 'microsoftTeamsUser':
      // For signed in Teams users this id is the Entra object id. Anonymous guests get a random one.
      return identifier.isAnonymous
        ? { id: identifier.microsoftTeamsUserId, kind: 'unknown' }
        : { id: identifier.microsoftTeamsUserId, aadObjectId: identifier.microsoftTeamsUserId, kind: 'teams' };
    case 'communicationUser':
      return { id: identifier.communicationUserId, kind: 'acs' };
    case 'phoneNumber':
      return { id: identifier.phoneNumber, kind: 'phone' };
    default:
      return { id: 'id' in identifier && typeof identifier.id === 'string' ? identifier.id : 'unknown', kind: 'unknown' };
  }
}

/** New style short links carry a meeting id and passcode instead of a long join link. */
function parseShortLink(url: string): { meetingId: string; passcode?: string } | null {
  const match = /teams\.microsoft\.com\/meet\/(\d+)(?:\?p=([^&#\s]+))?/i.exec(url);
  if (!match?.[1]) return null;
  return { meetingId: match[1], ...(match[2] ? { passcode: decodeURIComponent(match[2]) } : {}) };
}

export class AcsTransport implements CallTransport {
  private agent: { dispose(): Promise<void> } | undefined;
  private call: CallCommon | undefined;
  private pending: TeamsIncomingCall | undefined;
  private outgoing: MediaStream | undefined;
  private events: TransportEvents | undefined;
  private captionsStarted = false;
  private waitingForKind = false;
  private language = 'en-gb';

  private async newClient(config: PageConfig, events: TransportEvents): Promise<CallClient> {
    this.events = events;
    this.language = config.spokenLanguage.toLowerCase();
    const client = new CallClient();
    try {
      // The assistant never uses a real microphone, but the SDK expects the permission to exist.
      const devices = await client.getDeviceManager();
      await devices.askDevicePermission({ audio: true, video: false });
    } catch (err) {
      events.onLog('warn', `Device permission request failed, continuing: ${String(err)}`);
    }
    return client;
  }

  /** Joins a Teams meeting by link as an outside guest. */
  async join(config: PageConfig, outgoing: MediaStream, events: TransportEvents): Promise<void> {
    const client = await this.newClient(config, events);
    const agent = await client.createCallAgent(new AzureCommunicationTokenCredential(config.acsToken), { displayName: config.displayName });
    this.agent = agent;
    const options = { audioOptions: { muted: true, localAudioStreams: [new LocalAudioStream(outgoing)] } };
    const short = parseShortLink(config.joinUrl);
    this.attach(short ? agent.join(short, options) : agent.join({ meetingLink: config.joinUrl }, options));
  }

  /**
   * Signs in as the assistant's own Teams account and waits for calls: someone calling it, or
   * adding it to a call. Each call is reported, and answered only if the host says so.
   */
  async listen(config: PageConfig, outgoing: MediaStream, events: TransportEvents, refreshToken: () => Promise<string>, onIncoming: (info: IncomingCallInfo) => void): Promise<void> {
    const client = await this.newClient(config, events);
    this.outgoing = outgoing;
    const credential = new AzureCommunicationTokenCredential({ token: config.acsToken, tokenRefresher: refreshToken, refreshProactively: true });
    const agent = await client.createTeamsCallAgent(credential);
    this.agent = agent;
    agent.on('incomingCall', ({ incomingCall }) => {
      // One call at a time. Anything else rings out; Teams treats it as a missed call.
      if (this.call || this.pending) {
        void incomingCall.reject().catch(() => undefined);
        return;
      }
      this.pending = incomingCall;
      const who = describe(incomingCall.callerInfo.identifier);
      let threadId: string | undefined;
      try {
        threadId = incomingCall.info?.threadId;
      } catch {
        threadId = undefined;
      }
      events.onLog('info', `Incoming call, ${threadId ? 'with a chat thread (group call)' : 'no chat thread (direct call)'}`);
      onIncoming({
        ...(who.aadObjectId ? { callerAadId: who.aadObjectId } : {}),
        callerName: incomingCall.callerInfo.displayName ?? 'Someone',
        groupCall: Boolean(threadId),
        ...(threadId ? { threadId } : {}),
      });
    });
    events.onLog('info', 'Signed in as the assistant account, waiting for calls');
  }

  async accept(language?: string): Promise<void> {
    const incoming = this.pending;
    if (!incoming || !this.outgoing) throw new Error('There is no call to answer');
    if (language) this.language = language.toLowerCase();
    const call = await incoming.accept({ audioOptions: { muted: true, localAudioStreams: [new LocalAudioStream(this.outgoing)] } });
    this.pending = undefined;
    this.attach(call);
  }

  async reject(): Promise<void> {
    const incoming = this.pending;
    this.pending = undefined;
    await incoming?.reject().catch(() => undefined);
  }

  /** Follows a call, whichever way it started: state, people, captions. */
  private attach(call: CallCommon): void {
    const events = this.events;
    if (!events) return;
    this.call = call;
    events.onState('connecting');
    call.on('stateChanged', () => this.onCallState());
    call.on('remoteParticipantsUpdated', (change) => {
      for (const p of change.added) this.watch(p);
      this.reportParticipants();
    });
    for (const p of call.remoteParticipants) this.watch(p);
    this.onCallState();
  }

  get waiting(): boolean {
    return this.pending !== undefined;
  }

  async setMuted(muted: boolean): Promise<void> {
    const call = this.call;
    if (!call || call.state !== 'Connected') return;
    try {
      if (muted && !call.isMuted) await call.mute();
      if (!muted && call.isMuted) await call.unmute();
    } catch (err) {
      // Typically the organiser has stopped attendees from unmuting.
      this.events?.onLog('warn', `Could not ${muted ? 'mute' : 'unmute'}: ${String(err)}`);
    }
  }

  async leave(): Promise<void> {
    try {
      await this.call?.hangUp();
    } finally {
      await this.agent?.dispose().catch(() => undefined);
    }
  }

  private onCallState(): void {
    const call = this.call;
    const events = this.events;
    if (!call || !events) return;
    const map: Partial<Record<CallCommon['state'], CallState>> = {
      Connecting: 'connecting',
      Ringing: 'connecting',
      EarlyMedia: 'connecting',
      InLobby: 'lobby',
      Connected: 'connected',
      Disconnected: 'ended',
    };
    const state = map[call.state];
    if (!state) return;
    if (state === 'ended') {
      const reason = call.callEndReason ? `code ${call.callEndReason.code}, subcode ${call.callEndReason.subCode ?? 0}` : 'call ended';
      events.onState('ended', reason);
      return;
    }
    if (state === 'connected') {
      // The meeting chat id. Short join links do not carry it, so it is the only way to tie a
      // meeting joined from a personal chat to its meeting chat.
      let threadId: string | undefined;
      try {
        threadId = (call as unknown as { info?: { threadId?: string } }).info?.threadId;
      } catch {
        threadId = undefined;
      }
      events.onState(state, undefined, threadId);
    } else {
      events.onState(state);
    }
    if (state === 'connected') {
      this.reportParticipants();
      void this.startCaptions();
    }
  }

  private watch(participant: RemoteParticipant): void {
    participant.on('stateChanged', () => this.reportParticipants());
    participant.on('displayNameChanged', () => this.reportParticipants());
  }

  private reportParticipants(): void {
    const call = this.call;
    if (!call) return;
    const present = call.remoteParticipants
      .filter((p) => p.state === 'Connected' || p.state === 'Hold')
      .map((p): Participant => {
        const who = describe(p.identifier);
        return { id: who.id, ...(who.aadObjectId ? { aadObjectId: who.aadObjectId } : {}), displayName: p.displayName ?? 'Unknown', kind: who.kind };
      });
    this.events?.onParticipants(present);
  }

  private async startCaptions(): Promise<void> {
    const call = this.call;
    const events = this.events;
    if (!call || !events || this.captionsStarted) return;
    this.captionsStarted = true;
    try {
      const feature = call.feature(Features.Captions);
      const captions = feature.captions;
      if (captions.kind !== 'TeamsCaptions') {
        // The kind can switch to Teams captions shortly after joining. Try again when it does.
        events.onLog('warn', `Waiting for Teams captions, the call currently offers "${captions.kind}".`);
        this.captionsStarted = false;
        if (!this.waitingForKind) {
          this.waitingForKind = true;
          feature.on('CaptionsKindChanged', () => void this.startCaptions());
        }
        return;
      }
      const teamsCaptions = captions as TeamsCaptions;
      teamsCaptions.on('CaptionsReceived', (data: TeamsCaptionsInfo) => {
        const who = describe(data.speaker.identifier);
        const text = data.spokenText || data.captionText;
        if (!text) return;
        events.onCaption({
          speakerId: who.id,
          ...(who.aadObjectId ? { speakerAadId: who.aadObjectId } : {}),
          speakerName: data.speaker.displayName ?? 'Unknown',
          text,
          final: data.resultType === 'Final',
          at: data.timestamp instanceof Date ? data.timestamp.getTime() : Date.now(),
        });
      });
      teamsCaptions.on('CaptionsActiveChanged', () => events.onLog('info', `Captions active: ${teamsCaptions.isCaptionsFeatureActive}`));
      const supported = teamsCaptions.supportedSpokenLanguages.map((l) => l.toLowerCase());
      const language = supported.length === 0 || supported.includes(this.language) ? this.language : 'en-us';
      if (language !== this.language) events.onLog('warn', `Spoken language ${this.language} is not offered, using ${language}`);
      // Start captions for this participant. In Teams the spoken language is shared by the whole meeting.
      if (!teamsCaptions.isCaptionsFeatureActive) await teamsCaptions.startCaptions({ spokenLanguage: language });
      events.onLog('info', `Captions started in ${language}`);
    } catch (err) {
      this.captionsStarted = false;
      events.onLog('error', `Could not start captions: ${String(err)}. Check the Teams meeting policy for live captions.`);
    }
  }
}
