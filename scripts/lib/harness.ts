// Shared wiring for the local demo and the day one spike. It runs the real control service and
// the real worker in one process, with stand ins for whatever credentials are not provided.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExpressAdapter } from '@microsoft/teams.apps';
import { AcsIdentityIssuer, FakeIdentityIssuer } from '../../src/control/acs-identity.js';
import { mountInternalApi } from '../../src/control/internal-api.js';
import { ControlService } from '../../src/control/service.js';
import { Brain } from '../../src/core/brain.js';
import { loadControlConfig } from '../../src/core/config.js';
import { KnowledgeBase, chunkDocument } from '../../src/core/kb.js';
import { AnthropicLlm, type Llm, ScriptedLlm } from '../../src/core/llm.js';
import { DEFAULT_PRICES } from '../../src/core/pricing.js';
import { MemoryStore } from '../../src/core/store.js';
import { AzureTts, CachingTts, ToneTts } from '../../src/core/tts.js';
import type { FakeScriptStep } from '../../src/core/types.js';
import { type WorkerResult, runWorker } from '../../src/worker/worker.js';

export function findChrome(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((p): p is string => Boolean(p && existsSync(p)));
}

export interface Harness {
  service: ControlService;
  store: MemoryStore;
  worker: () => Promise<WorkerResult> | undefined;
  stop: () => Promise<void>;
  usingRealClaude: boolean;
  usingRealSpeech: boolean;
}

export async function startHarness(options: { transport: 'acs' | 'fake'; fakeScript?: FakeScriptStep[]; headless?: boolean }): Promise<Harness> {
  // ||= rather than ??=, because an empty line in .env sets a variable to an empty string.
  process.env.WORKER_SHARED_SECRET ||= 'local-development-secret-change-me-please';
  process.env.TENANT_ID ||= 'local';
  process.env.DISPATCH_MODE = 'none';
  process.env.PORT ||= '3979';
  const config = loadControlConfig();
  const store = new MemoryStore();
  const kb = new KnowledgeBase(
    chunkDocument('Sample refund policy', 'sample/refunds.md', 'This is sample knowledge for the demo. Learners may ask for a full refund within 14 days of enrolment, provided they have completed less than 20 percent of the course.'),
  );

  const usingRealClaude = Boolean(config.anthropicApiKey);
  const llm: Llm = config.anthropicApiKey
    ? new AnthropicLlm({ apiKey: config.anthropicApiKey })
    : new ScriptedLlm((request) => {
        if (request.outputSchema) {
          return { text: JSON.stringify({ title: 'Demo meeting', summary: 'This recap was produced by the scripted stand in because no Claude API key is set.', decisions: [], actions: [], explained: [], openQuestions: [] }) };
        }
        const last = request.messages.at(-1)?.content;
        const text = Array.isArray(last) ? String((last.at(-1) as { text?: string })?.text ?? '') : String(last ?? '');
        const question = /Question from [^:]+: (.*)$/s.exec(text)?.[1]?.trim() ?? 'your question';
        return { text: `This is the scripted stand in, so I cannot really answer. I heard you ask: ${question}` };
      });
  const usingRealSpeech = Boolean(config.speechKey);
  const tts = new CachingTts(config.speechKey ? new AzureTts({ key: config.speechKey, region: config.speechRegion, voice: config.ttsVoice }) : new ToneTts());

  let workerRun: Promise<WorkerResult> | undefined;
  const pageDir = fileURLToPath(new URL('../../dist/page', import.meta.url));
  const service = new ControlService({
    config,
    store,
    brain: new Brain({ llm, store, kb, persona: { name: config.assistantName, organisation: config.organisation }, prices: DEFAULT_PRICES, models: config.models, webSearch: config.webSearch, liveEffort: config.liveEffort }),
    kb,
    tts,
    notifier: {
      async send(conversationId, markdown) {
        if (conversationId.startsWith('19:')) throw new Error('not in the meeting chat');
        console.log(`\n--- message to Teams chat ---\n${markdown}\n-----------------------------\n`);
      },
    },
    dispatcher: {
      async start() {
        workerRun = runWorker({
          config: { controlUrl: `http://127.0.0.1:${config.port}`, workerSharedSecret: config.workerSharedSecret, transport: options.transport, chromePath: findChrome(), headless: options.headless ?? true, claimWaitSeconds: 15, mode: 'job', standbyUntil: '18:00' },
          ...(options.fakeScript ? { fakeScript: options.fakeScript } : {}),
          pageDir,
          onPageEvent: (event) => {
            if (event.type === 'caption' && event.caption.final) console.log(`[caption] ${event.caption.speakerName}: ${event.caption.text}`);
          },
        });
      },
    },
    identities: options.transport === 'acs' ? new AcsIdentityIssuer(requireEnv('ACS_CONNECTION_STRING')) : new FakeIdentityIssuer(),
    prices: DEFAULT_PRICES,
  });

  const adapter = new ExpressAdapter();
  mountInternalApi(adapter, service, config.workerSharedSecret);
  await adapter.start(config.port);
  return { service, store, worker: () => workerRun, stop: () => adapter.stop(), usingRealClaude, usingRealSpeech };
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Please set ${name}. See .env.example.`);
    process.exit(2);
  }
  return value;
}
