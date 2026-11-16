import { describe, expect, it } from 'vitest';
import { workerEnvironment } from '../src/control/dispatcher.js';
import { redact } from '../src/core/log.js';

// Obviously fake values, built at run time so no key-shaped string sits in the source.
const FAKE_CLAUDE_KEY = ['sk', 'ant', 'api03', 'FAKEFAKEFAKEFAKEFAKE'].join('-');
const FAKE_SPEECH_KEY = 'speech0000fake0000key';

describe('log redaction', () => {
  it('removes values of secret settings', () => {
    const env = { SPEECH_KEY: FAKE_SPEECH_KEY, WORKER_SHARED_SECRET: 'shared-secret-value-123', SPEECH_REGION: 'uksouth' };
    const out = redact(`key ${FAKE_SPEECH_KEY} secret shared-secret-value-123 region uksouth`, env);
    expect(out).not.toContain(FAKE_SPEECH_KEY);
    expect(out).not.toContain('shared-secret-value-123');
    expect(out).toContain('uksouth');
  });

  it('removes known key formats even when no setting holds them', () => {
    const out = redact(
      `claude ${FAKE_CLAUDE_KEY}; endpoint=https://x.communication.azure.com/;accesskey=abc123def456; AccountKey=zzz999yyy; Authorization: Bearer abcdefghijklmnopqrstuvwxyz; https://a.blob.core.windows.net/c?sv=1&sig=SIGNATURE123`,
      {},
    );
    expect(out).not.toContain(FAKE_CLAUDE_KEY);
    expect(out).not.toContain('abc123def456');
    expect(out).not.toContain('zzz999yyy');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(out).not.toContain('SIGNATURE123');
    expect(out).toContain('accesskey=[redacted]');
    expect(out).toContain('Bearer [redacted]');
  });

  it('leaves ordinary text alone', () => {
    expect(redact('Hey Claude, what did I explain to Jordan?', { SPEECH_KEY: FAKE_SPEECH_KEY })).toBe('Hey Claude, what did I explain to Jordan?');
  });
});

describe('local worker environment', () => {
  it('passes only what the worker needs, never the service keys', () => {
    const source = {
      PATH: '/usr/bin',
      HEADLESS: 'true',
      ANTHROPIC_API_KEY: FAKE_CLAUDE_KEY,
      SPEECH_KEY: FAKE_SPEECH_KEY,
      CLIENT_SECRET: 'bot-secret',
      ACS_CONNECTION_STRING: 'endpoint=x;accesskey=y',
      STORAGE_CONNECTION_STRING: 'AccountKey=z',
    };
    const env = workerEnvironment({ controlUrlForWorker: 'http://127.0.0.1:3978', workerSharedSecret: 's'.repeat(32) }, source);
    expect(env).toEqual({ PATH: '/usr/bin', HEADLESS: 'true', CONTROL_URL: 'http://127.0.0.1:3978', WORKER_SHARED_SECRET: 's'.repeat(32) });
  });
});
