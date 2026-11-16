// Starts a meeting worker. In Azure that means starting one execution of a Container Apps job.
// The worker is given nothing about the meeting: it asks the control service for its assignment.

import { spawn } from 'node:child_process';
import { ContainerAppsAPIClient } from '@azure/arm-appcontainers';
import { DefaultAzureCredential } from '@azure/identity';
import type { ControlConfig } from '../core/config.js';
import { logger } from '../core/log.js';
import type { Dispatcher } from './service.js';

const log = logger('dispatcher');

// The worker runs a browser on meeting content, so it gets only what it needs, never the Claude,
// Speech, Communication Services or bot keys held by this service. This matches the Azure job,
// which receives only the shared secret (see infra/apps.bicep).
const WORKER_ENV_ALLOWLIST = [
  'TRANSPORT', 'CHROME_PATH', 'HEADLESS', 'CLAIM_WAIT_SECONDS', 'LOG_LEVEL', 'PLAYWRIGHT_BROWSERS_PATH',
  // Operating system basics that Node and Chrome need to start.
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec',
  'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'PROGRAMDATA', 'PATHEXT',
];

export function workerEnvironment(config: Pick<ControlConfig, 'controlUrlForWorker' | 'workerSharedSecret'>, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of WORKER_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.CONTROL_URL = config.controlUrlForWorker;
  env.WORKER_SHARED_SECRET = config.workerSharedSecret;
  return env;
}

/** Runs the worker as a child process on the same machine. For development. */
export class LocalDispatcher implements Dispatcher {
  constructor(private readonly config: ControlConfig) {}

  async start(): Promise<void> {
    const command = process.env.WORKER_COMMAND ?? 'node dist/worker/main.js';
    const [file, ...args] = command.split(' ');
    const child = spawn(file as string, args, {
      env: workerEnvironment(this.config),
      stdio: 'inherit',
    });
    child.on('exit', (code) => log.info('Local worker exited', { code }));
    child.on('error', (err) => log.error('Local worker could not start', { error: err.message }));
  }
}

/** Starts one execution of the worker job in Azure Container Apps, using the app's managed identity. */
export class ContainerAppsJobDispatcher implements Dispatcher {
  private readonly client: ContainerAppsAPIClient;
  private readonly resourceGroup: string;
  private readonly jobName: string;

  constructor(config: ControlConfig) {
    if (!config.azureSubscriptionId || !config.azureResourceGroup || !config.workerJobName) {
      throw new Error('AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP and WORKER_JOB_NAME are required when DISPATCH_MODE is aca');
    }
    this.client = new ContainerAppsAPIClient(new DefaultAzureCredential(), config.azureSubscriptionId);
    this.resourceGroup = config.azureResourceGroup;
    this.jobName = config.workerJobName;
  }

  async start(): Promise<void> {
    const poller = this.client.jobs.start(this.resourceGroup, this.jobName);
    // Wait until Azure has accepted the request, not until the meeting is over.
    await poller.submitted();
    log.info('Worker job execution requested', { job: this.jobName });
  }
}

/** For deployments where workers are started some other way. */
export class NoopDispatcher implements Dispatcher {
  async start(): Promise<void> {
    log.info('Dispatch mode is none: waiting for an external worker to claim the meeting');
  }
}

export function createDispatcher(config: ControlConfig): Dispatcher {
  if (config.dispatchMode === 'aca') return new ContainerAppsJobDispatcher(config);
  if (config.dispatchMode === 'none') return new NoopDispatcher();
  return new LocalDispatcher(config);
}
