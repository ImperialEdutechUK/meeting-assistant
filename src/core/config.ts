// Reads settings from environment variables. Every setting is listed in .env.example.

function str(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required setting ${name}`);
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function num(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Setting ${name} must be a number`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function list(name: string, fallback: string[]): string[] {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export interface ControlConfig {
  port: number;
  /** Assistant name used in speech and prompts. */
  assistantName: string;
  organisation: string;
  /** Name shown in the meeting roster. It must make clear that this is an AI that transcribes. */
  displayName: string;
  wakeNames: string[];
  spokenLanguage: string;
  tenantId: string;
  allowedTenantIds: string[];
  teamsClientId?: string;
  teamsClientSecret?: string;
  anthropicApiKey?: string;
  models: { live: string; chat: string; recap: string };
  liveEffort: 'low' | 'medium' | 'high';
  webSearch: boolean;
  /** "staff" keeps company knowledge answers for recognised staff. "everyone" removes that check. */
  kbAudience: 'staff' | 'everyone';
  storageConnectionString?: string;
  storageAccountName?: string;
  acsConnectionString?: string;
  speechKey?: string;
  speechRegion: string;
  ttsVoice: string;
  workerSharedSecret: string;
  dispatchMode: 'local' | 'aca' | 'none';
  azureSubscriptionId?: string;
  azureResourceGroup?: string;
  workerJobName?: string;
  /** Address the worker uses to reach this service. */
  controlUrlForWorker: string;
  maxMeetingMinutes: number;
  maxConcurrentMeetings: number;
  monthlyBudgetUsd: number;
  retentionDays: number;
  aloneTimeoutSeconds: number;
  lobbyTimeoutSeconds: number;
  announceOnJoin: boolean;
  postVoiceAnswersToChat: boolean;
  /** General knowledge questions allowed per meeting or call. 0 keeps answers to the meeting and documents only. */
  generalQuestionsPerMeeting: number;
  /**
   * The assistant's own Teams account, so people can call it and add it to calls. Both must be set
   * to switch the feature on: the Entra app used to sign in, and the account's sign-in name.
   */
  teamsIdentityClientId?: string;
  teamsAssistantUpn?: string;
  /** Entra object ids of the admins allowed to connect the assistant's Teams account from chat. */
  adminAadIds: string[];
  pricesJson?: string;
}

export function loadControlConfig(): ControlConfig {
  const tenantId = str('TENANT_ID', 'local');
  const assistantName = str('ASSISTANT_NAME', 'Claude');
  const effort = str('LIVE_EFFORT', 'low');
  const dispatch = str('DISPATCH_MODE', 'local');
  const audience = str('KB_AUDIENCE', 'staff');
  const port = num('PORT', 3978);
  return {
    port,
    assistantName,
    organisation: str('ORGANISATION_NAME', 'our company'),
    displayName: str('BOT_DISPLAY_NAME', `${assistantName} (AI assistant)`),
    wakeNames: list('WAKE_NAMES', [assistantName.toLowerCase()]),
    spokenLanguage: str('SPOKEN_LANGUAGE', 'en-gb'),
    tenantId,
    allowedTenantIds: list('ALLOWED_TENANT_IDS', [tenantId]),
    teamsClientId: optional('CLIENT_ID'),
    teamsClientSecret: optional('CLIENT_SECRET'),
    anthropicApiKey: optional('ANTHROPIC_API_KEY'),
    models: {
      live: str('LIVE_MODEL', 'claude-haiku-5-5'),
      chat: str('CHAT_MODEL', 'claude-sonnet-5-5'),
      recap: str('RECAP_MODEL', 'claude-sonnet-5-5'),
    },
    liveEffort: effort === 'medium' || effort === 'high' ? effort : 'low',
    webSearch: bool('ENABLE_WEB_SEARCH', false),
    kbAudience: audience === 'everyone' ? 'everyone' : 'staff',
    storageConnectionString: optional('STORAGE_CONNECTION_STRING'),
    storageAccountName: optional('STORAGE_ACCOUNT_NAME'),
    acsConnectionString: optional('ACS_CONNECTION_STRING'),
    speechKey: optional('SPEECH_KEY'),
    speechRegion: str('SPEECH_REGION', 'uksouth'),
    ttsVoice: str('TTS_VOICE', 'en-GB-AdaMultilingualNeural'),
    workerSharedSecret: str('WORKER_SHARED_SECRET'),
    dispatchMode: dispatch === 'aca' || dispatch === 'none' ? dispatch : 'local',
    azureSubscriptionId: optional('AZURE_SUBSCRIPTION_ID'),
    azureResourceGroup: optional('AZURE_RESOURCE_GROUP'),
    workerJobName: optional('WORKER_JOB_NAME'),
    controlUrlForWorker: str('CONTROL_URL', `http://127.0.0.1:${port}`),
    maxMeetingMinutes: num('MAX_MEETING_MINUTES', 180),
    maxConcurrentMeetings: num('MAX_CONCURRENT_MEETINGS', 5),
    monthlyBudgetUsd: num('MONTHLY_BUDGET_USD', 200),
    retentionDays: num('RETENTION_DAYS', 90),
    // Leave quickly once everyone else has gone.
    aloneTimeoutSeconds: num('ALONE_TIMEOUT_SECONDS', 10),
    lobbyTimeoutSeconds: num('LOBBY_TIMEOUT_SECONDS', 300),
    announceOnJoin: bool('ANNOUNCE_ON_JOIN', true),
    postVoiceAnswersToChat: bool('POST_VOICE_ANSWERS_TO_CHAT', true),
    generalQuestionsPerMeeting: Math.max(0, num('GENERAL_QUESTIONS_PER_MEETING', 20)),
    teamsIdentityClientId: optional('TEAMS_IDENTITY_CLIENT_ID'),
    teamsAssistantUpn: optional('TEAMS_ASSISTANT_UPN')?.toLowerCase(),
    adminAadIds: list('ADMIN_AAD_IDS', []),
    pricesJson: optional('PRICES_JSON'),
  };
}

export interface WorkerConfig {
  controlUrl: string;
  workerSharedSecret: string;
  transport: 'acs' | 'fake';
  /** Path to a Chrome or Chromium binary. Leave empty to use the browser Playwright installed. */
  chromePath?: string;
  headless: boolean;
  /** How long to wait for a meeting to claim before giving up. */
  claimWaitSeconds: number;
  /**
   * job: started for one meeting, then exits (the default, nothing runs between meetings).
   * standby: started on a schedule, keeps Chrome ready and takes meetings until standbyUntil.
   * receiver: started on a schedule, signed in as the assistant's Teams account, answers calls to
   * it and invitations into calls until standbyUntil.
   */
  mode: 'job' | 'standby' | 'receiver';
  /** UK time (HH:MM) when a standby worker stops taking new meetings. */
  standbyUntil: string;
}

export function loadWorkerConfig(): WorkerConfig {
  return {
    controlUrl: str('CONTROL_URL').replace(/\/$/, ''),
    workerSharedSecret: str('WORKER_SHARED_SECRET'),
    transport: str('TRANSPORT', 'acs') === 'fake' ? 'fake' : 'acs',
    chromePath: optional('CHROME_PATH'),
    headless: bool('HEADLESS', true),
    claimWaitSeconds: num('CLAIM_WAIT_SECONDS', 45),
    mode: ((m) => (m === 'standby' || m === 'receiver' ? m : 'job'))(str('WORKER_MODE', 'job')),
    standbyUntil: str('STANDBY_UNTIL', '18:00'),
  };
}

/** Seconds from now until the given UK time (HH:MM) today, or 0 if it has passed. */
export function secondsUntilUkTime(hhmm: string, now = new Date()): number {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const nowSeconds = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return Math.max(0, (h as number) * 3600 + (m as number) * 60 - nowSeconds);
}
