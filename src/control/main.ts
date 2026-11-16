// Entry point of the control service: the Teams bot endpoint plus the API for meeting workers.

import { ExpressAdapter } from '@microsoft/teams.apps';
import { Brain } from '../core/brain.js';
import { type ControlConfig, loadControlConfig } from '../core/config.js';
import { KnowledgeBase } from '../core/kb.js';
import { AnthropicLlm } from '../core/llm.js';
import { errorMessage, logger } from '../core/log.js';
import { loadPrices } from '../core/pricing.js';
import { AzureStore } from '../core/store-azure.js';
import { MemoryStore, type Store } from '../core/store.js';
import { AzureTts, CachingTts, ToneTts } from '../core/tts.js';
import { AcsIdentityIssuer, FakeIdentityIssuer } from './acs-identity.js';
import { createDispatcher } from './dispatcher.js';
import { mountInternalApi } from './internal-api.js';
import { ControlService, type Notifier } from './service.js';
import { TeamsIdentity } from './teams-identity.js';
import { createTeamsApp, teamsNotifier, wireTeams } from './teams.js';

const log = logger('main');

function createStore(config: ControlConfig): Store {
  if (config.storageConnectionString) return new AzureStore({ connectionString: config.storageConnectionString });
  if (config.storageAccountName) return new AzureStore({ accountName: config.storageAccountName });
  log.warn('No storage configured: using memory only. Everything is lost on restart. Fine for a first local run, never for production.');
  return new MemoryStore();
}

async function main(): Promise<void> {
  const config = loadControlConfig();
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is required');
  const prices = loadPrices(config.pricesJson);
  const store = createStore(config);
  await store.init();

  const kb = new KnowledgeBase();
  const brain = new Brain({
    llm: new AnthropicLlm({ apiKey: config.anthropicApiKey }),
    store,
    kb,
    persona: { name: config.assistantName, organisation: config.organisation },
    prices,
    models: config.models,
    webSearch: config.webSearch,
    liveEffort: config.liveEffort,
  });
  const tts = new CachingTts(
    config.speechKey ? new AzureTts({ key: config.speechKey, region: config.speechRegion, voice: config.ttsVoice }) : new ToneTts(),
  );
  if (!config.speechKey) log.warn('SPEECH_KEY is not set: the assistant will play tones instead of speech.');

  const adapter = new ExpressAdapter();
  const teamsEnabled = Boolean(config.teamsClientId && config.teamsClientSecret);
  const app = teamsEnabled ? createTeamsApp(config, adapter) : null;
  const notifier: Notifier = app
    ? teamsNotifier(app)
    : { send: async (conversationId, markdown) => log.info('Notification (Teams is not configured)', { conversationId, markdown }) };

  // The assistant's own Teams account: only when both settings and the calling resource are present.
  const teamsAccount =
    config.teamsIdentityClientId && config.teamsAssistantUpn && config.acsConnectionString
      ? new TeamsIdentity({
          clientId: config.teamsIdentityClientId,
          tenantId: config.tenantId,
          upn: config.teamsAssistantUpn,
          acsConnectionString: config.acsConnectionString,
          store,
          secret: config.workerSharedSecret,
        })
      : undefined;
  log.info('Assistant Teams account', { configured: Boolean(teamsAccount) });

  const service = new ControlService({
    config,
    store,
    brain,
    kb,
    tts,
    notifier,
    dispatcher: createDispatcher(config),
    identities: config.acsConnectionString ? new AcsIdentityIssuer(config.acsConnectionString) : new FakeIdentityIssuer(),
    prices,
    ...(teamsAccount ? { teamsAccount } : {}),
  });

  mountInternalApi(adapter, service, config.workerSharedSecret);
  if (app) {
    wireTeams(app, service);
    await app.start(config.port);
  } else {
    log.warn('CLIENT_ID and CLIENT_SECRET are not set: Teams chat is disabled, only the worker API is served.');
    await adapter.start(config.port);
  }
  log.info('Control service listening', { port: config.port, teams: teamsEnabled, dispatch: config.dispatchMode });

  const safely = (name: string, task: () => Promise<unknown>) => () => {
    task().catch((err) => log.error(`${name} failed`, { error: errorMessage(err) }));
  };
  safely('Knowledge base load', () => service.refreshKb())();
  setInterval(safely('Knowledge base refresh', () => service.refreshKb()), 5 * 60_000).unref();
  setInterval(safely('Stale meeting check', () => service.reapStale()), 60_000).unref();
  setInterval(safely('Retention purge', () => service.purgeExpired()), 6 * 3_600_000).unref();
  // In Azure the service scales to zero when idle, so timers only run while it is awake. Run the
  // housekeeping once at every start as well, so a cold start never sees stale meetings or old data.
  safely('Stale meeting check', () => service.reapStale())();
  safely('Retention purge', () => service.purgeExpired())();
}

main().catch((err) => {
  log.error('Control service failed to start', { error: errorMessage(err) });
  process.exit(1);
});
