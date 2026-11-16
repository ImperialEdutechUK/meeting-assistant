// Text to speech. Azure AI Speech in production, a tone generator for tests and the local demo.

export interface SpeechAudio {
  audio: Buffer;
  mime: string;
}

export interface Tts {
  synthesize(text: string): Promise<SpeechAudio>;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface AzureTtsOptions {
  key: string;
  region: string;
  /** For example en-GB-AdaMultilingualNeural, en-GB-OllieMultilingualNeural or en-GB-SoniaNeural. */
  voice: string;
  /**
   * Output format. The default is uncompressed WAV, which every browser build can decode,
   * including Chromium builds without licensed codecs.
   */
  format?: string;
  fetchImpl?: typeof fetch;
}

export class AzureTts implements Tts {
  constructor(private readonly o: AzureTtsOptions) {}

  async synthesize(text: string): Promise<SpeechAudio> {
    const format = this.o.format ?? 'riff-24khz-16bit-mono-pcm';
    const lang = this.o.voice.split('-').slice(0, 2).join('-');
    // Multilingual voices pick the language from the text; the lang element keeps them in the
    // voice's own accent (British English here) instead of guessing from a short sentence.
    const body = /Multilingual/i.test(this.o.voice) ? `<lang xml:lang="${lang}">${escapeXml(text)}</lang>` : escapeXml(text);
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${escapeXml(this.o.voice)}">${body}</voice></speak>`;
    const doFetch = this.o.fetchImpl ?? fetch;
    const response = await doFetch(`https://${this.o.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.o.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': format,
        'User-Agent': 'claude-meeting-assistant',
      },
      body: ssml,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`Azure Speech returned ${response.status} ${response.statusText}`);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    return { audio, mime: format.startsWith('riff') ? 'audio/wav' : format.includes('mp3') ? 'audio/mpeg' : 'audio/ogg' };
  }
}

/**
 * Produces a short tone whose length follows the length of the text. It lets the whole audio
 * path be exercised without calling a paid service.
 */
export class ToneTts implements Tts {
  readonly spoken: string[] = [];

  async synthesize(text: string): Promise<SpeechAudio> {
    this.spoken.push(text);
    const seconds = Math.min(4, Math.max(0.3, text.length / 60));
    return { audio: toneWav(seconds, 440), mime: 'audio/wav' };
  }
}

export function toneWav(seconds: number, hz: number, sampleRate = 24_000): Buffer {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    // Fade in and out over 10 ms to avoid clicks.
    const edge = Math.min(1, i / (sampleRate * 0.01), (samples - i) / (sampleRate * 0.01));
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.4 * edge * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Remembers audio for phrases that repeat, such as the join announcement. */
export class CachingTts implements Tts {
  private readonly cache = new Map<string, Promise<SpeechAudio>>();

  constructor(
    private readonly inner: Tts,
    private readonly maxEntries = 50,
  ) {}

  synthesize(text: string): Promise<SpeechAudio> {
    return this.inner.synthesize(text);
  }

  synthesizeCached(text: string): Promise<SpeechAudio> {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const pending = this.inner.synthesize(text);
    pending.catch(() => this.cache.delete(text));
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(text, pending);
    return pending;
  }
}
