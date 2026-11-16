// Audio the assistant sends into the call. Speech arrives as encoded audio, is decoded with the
// Web Audio API and played into a MediaStream that the calling SDK uses as its "microphone".

export class AudioOut {
  readonly context: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly active = new Set<AudioScheduledSourceNode>();
  private queue: Promise<void> = Promise.resolve();
  private nextStart = 0;
  private generation = 0;
  onPlaying?: (playing: boolean) => void;

  constructor() {
    this.context = new AudioContext({ sampleRate: 48_000 });
    this.destination = this.context.createMediaStreamDestination();
    this.gain = this.context.createGain();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.gain.connect(this.destination);
    this.gain.connect(this.analyser);
  }

  /** The stream to hand to the calling SDK. */
  get stream(): MediaStream {
    return this.destination.stream;
  }

  /** Current output level, 0 to 1. Used by the fake transport to prove that audio flowed. */
  level(): number {
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    return Math.sqrt(sum / data.length);
  }

  /** Queues encoded audio (WAV, MP3 or Ogg Opus). Clips play in the order they were queued. */
  enqueue(bytes: ArrayBuffer): Promise<void> {
    const generation = this.generation;
    this.queue = this.queue
      .then(async () => {
        if (generation !== this.generation) return; // stop() was called while this clip waited.
        await this.context.resume();
        const buffer = await this.context.decodeAudioData(bytes);
        if (generation !== this.generation) return;
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        this.schedule(source, buffer.duration);
      })
      .catch((err) => console.error('Audio clip could not be played', err));
    return this.queue;
  }

  /** A short soft tone that tells people the assistant heard its name. */
  async chime(): Promise<void> {
    await this.context.resume();
    const osc = this.context.createOscillator();
    const env = this.context.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    const now = this.context.currentTime;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.25, now + 0.02);
    env.gain.linearRampToValueAtTime(0, now + 0.16);
    osc.connect(env);
    env.connect(this.gain);
    this.track(osc);
    osc.start(now);
    osc.stop(now + 0.18);
  }

  /** Stops everything that is playing or queued. */
  stop(): void {
    this.generation++;
    for (const node of this.active) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Already stopped.
      }
    }
    const wasPlaying = this.active.size > 0;
    this.active.clear();
    this.nextStart = 0;
    if (wasPlaying) this.onPlaying?.(false);
  }

  private schedule(source: AudioBufferSourceNode, duration: number): void {
    source.connect(this.gain);
    const startAt = Math.max(this.context.currentTime + 0.03, this.nextStart);
    // Leave a short breath between sentences.
    this.nextStart = startAt + duration + 0.1;
    this.track(source);
    source.start(startAt);
  }

  private track(node: AudioScheduledSourceNode): void {
    const first = this.active.size === 0;
    this.active.add(node);
    if (first) this.onPlaying?.(true);
    node.onended = () => {
      this.active.delete(node);
      if (this.active.size === 0) {
        this.nextStart = 0;
        this.onPlaying?.(false);
      }
    };
  }
}
