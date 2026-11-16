// Pass 2 of 2: the control service, the worker job and the Azure Bot registration.
// Deploy after base.bicep and after both images have been pushed to the registry.
// Use the same resource group, location and namePrefix as in pass 1.

@description('Azure region. Must match pass 1.')
param location string = resourceGroup().location

@description('Name prefix. Must match pass 1.')
@minLength(3)
@maxLength(10)
param namePrefix string = 'cma'

@description('Image tag to run, for example 0.1.0.')
param imageTag string

@description('Microsoft 365 tenant id.')
param tenantId string = subscription().tenantId

@description('Client id of the single tenant app registration used by the bot.')
param botClientId string

@secure()
@description('Client secret of the bot app registration.')
param botClientSecret string

@secure()
@description('Claude API key from the Claude Console.')
param anthropicApiKey string

@secure()
@minLength(32)
@description('Long random string shared by the control service and the worker.')
param workerSharedSecret string

@description('Name the assistant uses for itself.')
param assistantName string = 'Claude'

@description('Name of your organisation, used in prompts and messages.')
param organisationName string = 'Imperial Learning Ltd'

@description('Name shown in the meeting roster.')
param botDisplayName string = 'Claude (AI assistant)'

@description('Teams captions language code for your meetings.')
param spokenLanguage string = 'en-gb'

@description('Azure Speech voice.')
param ttsVoice string = 'en-GB-AdaMultilingualNeural'

// Pilot defaults, chosen to keep spend low. Raise them when the pilot widens.
@description('The assistant refuses new meetings once estimated monthly spend passes this figure (US dollars).')
param monthlyBudgetUsd int = 50

@description('Longest meeting the assistant stays in, in minutes. Also caps how long a worker container can run.')
param maxMeetingMinutes int = 120

@description('Most meetings the assistant attends at once, so at most this many worker containers run.')
param maxConcurrentMeetings int = 2

@description('Days to keep transcripts and recaps.')
param retentionDays int = 90

// Warm standby: a worker that starts on a schedule with Chrome ready, so joins during working
// hours take seconds instead of about half a minute. It runs (and bills) for the whole window.
@description('Run a warm standby worker during working hours for near instant joins.')
param standbyEnabled bool = false

@description('When the standby worker starts, as a cron expression in UTC. Default 07:00 UTC Monday to Friday, which is 07:00 in winter and 08:00 in summer in the UK.')
param standbyStartCron string = '0 7 * * 1-5'

@description('UK time (HH:MM) when the standby worker stops taking new meetings and exits.')
param standbyUntil string = '18:00'

@description('General knowledge questions Claude may answer per meeting or call. 0 turns it off.')
param generalQuestionsPerMeeting int = 20

// The assistant's own Teams account (docs/TEAMS-ACCOUNT-SETUP.md). Leave empty until the admin
// steps are done. Not secrets: an app id, a sign in name and object ids.
@description('Client id of the Entra app used to sign in the assistant Teams account.')
param teamsIdentityClientId string = ''

@description('Sign in name of the assistant Teams account, for example claude.assistant@example.com.')
param teamsAssistantUpn string = ''

@description('Comma separated Entra object ids of the admins allowed to connect the assistant account from Teams chat.')
param adminAadIds string = ''

@description('Run the call receiver during the standby hours, so people can call the assistant account and add it to calls.')
param receiverEnabled bool = false

var suffix = uniqueString(resourceGroup().id)
var controlAppName = '${namePrefix}-control'
var workerJobName = '${namePrefix}-worker'
var roleContributor = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${namePrefix}-identity'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: '${namePrefix}acr${suffix}'
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: take('${namePrefix}st${suffix}', 24)
}

resource communication 'Microsoft.Communication/communicationServices@2023-04-01' existing = {
  name: '${namePrefix}-acs-${suffix}'
}

resource speech 'Microsoft.CognitiveServices/accounts@2023-05-01' existing = {
  name: '${namePrefix}-speech-${suffix}'
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: '${namePrefix}-env'
}

resource control 'Microsoft.App/containerApps@2024-03-01' = {
  name: controlAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3978
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        { server: registry.properties.loginServer, identity: identity.id }
      ]
      secrets: [
        { name: 'bot-client-secret', value: botClientSecret }
        { name: 'anthropic-api-key', value: anthropicApiKey }
        { name: 'worker-shared-secret', value: workerSharedSecret }
        { name: 'acs-connection-string', value: communication.listKeys().primaryConnectionString }
        { name: 'speech-key', value: speech.listKeys().key1 }
      ]
    }
    template: {
      containers: [
        {
          name: 'control'
          image: '${registry.properties.loginServer}/meeting-assistant-control:${imageTag}'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'PORT', value: '3978' }
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'TENANT_ID', value: tenantId }
            { name: 'CLIENT_ID', value: botClientId }
            { name: 'CLIENT_SECRET', secretRef: 'bot-client-secret' }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'WORKER_SHARED_SECRET', secretRef: 'worker-shared-secret' }
            { name: 'ACS_CONNECTION_STRING', secretRef: 'acs-connection-string' }
            { name: 'SPEECH_KEY', secretRef: 'speech-key' }
            { name: 'SPEECH_REGION', value: location }
            { name: 'TTS_VOICE', value: ttsVoice }
            { name: 'STORAGE_ACCOUNT_NAME', value: storage.name }
            { name: 'ASSISTANT_NAME', value: assistantName }
            { name: 'ORGANISATION_NAME', value: organisationName }
            { name: 'BOT_DISPLAY_NAME', value: botDisplayName }
            { name: 'SPOKEN_LANGUAGE', value: spokenLanguage }
            { name: 'DISPATCH_MODE', value: 'aca' }
            { name: 'AZURE_SUBSCRIPTION_ID', value: subscription().subscriptionId }
            { name: 'AZURE_RESOURCE_GROUP', value: resourceGroup().name }
            { name: 'WORKER_JOB_NAME', value: workerJobName }
            { name: 'MONTHLY_BUDGET_USD', value: string(monthlyBudgetUsd) }
            { name: 'MAX_MEETING_MINUTES', value: string(maxMeetingMinutes) }
            { name: 'MAX_CONCURRENT_MEETINGS', value: string(maxConcurrentMeetings) }
            { name: 'RETENTION_DAYS', value: string(retentionDays) }
            { name: 'ALONE_TIMEOUT_SECONDS', value: '10' }
            { name: 'GENERAL_QUESTIONS_PER_MEETING', value: string(generalQuestionsPerMeeting) }
            { name: 'TEAMS_IDENTITY_CLIENT_ID', value: teamsIdentityClientId }
            { name: 'TEAMS_ASSISTANT_UPN', value: teamsAssistantUpn }
            { name: 'ADMIN_AAD_IDS', value: adminAadIds }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 3978 }
              periodSeconds: 30
            }
          ]
        }
      ]
      // Scales to zero when idle, so nothing is billed between meetings and chats. A Teams message
      // or a worker report wakes it in a few seconds. During a meeting the worker reports every
      // two seconds, which keeps it awake. Housekeeping runs at every start (src/control/main.ts).
      // At most one replica: the service runs timers that must not run twice.
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '50' } } }
        ]
      }
    }
  }
}

resource worker 'Microsoft.App/jobs@2024-03-01' = {
  name: workerJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      // A worker lives for one meeting. Allow the longest meeting plus time to join and report.
      replicaTimeout: (maxMeetingMinutes + 20) * 60
      replicaRetryLimit: 0
      registries: [
        { server: registry.properties.loginServer, identity: identity.id }
      ]
      secrets: [
        { name: 'worker-shared-secret', value: workerSharedSecret }
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: '${registry.properties.loginServer}/meeting-assistant-worker:${imageTag}'
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'CONTROL_URL', value: 'https://${control.properties.configuration.ingress.fqdn}' }
            { name: 'WORKER_SHARED_SECRET', secretRef: 'worker-shared-secret' }
            { name: 'TRANSPORT', value: 'acs' }
            { name: 'HEADLESS', value: 'true' }
          ]
        }
      ]
    }
  }
}

resource standby 'Microsoft.App/jobs@2024-03-01' = if (standbyEnabled) {
  name: '${namePrefix}-standby'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: { cronExpression: standbyStartCron, parallelism: 1, replicaCompletionCount: 1 }
      // The whole window plus the longest meeting that may still be running when it closes.
      replicaTimeout: 12 * 3600 + (maxMeetingMinutes + 20) * 60
      replicaRetryLimit: 1
      registries: [
        { server: registry.properties.loginServer, identity: identity.id }
      ]
      secrets: [
        { name: 'worker-shared-secret', value: workerSharedSecret }
      ]
    }
    template: {
      containers: [
        {
          name: 'standby'
          image: '${registry.properties.loginServer}/meeting-assistant-worker:${imageTag}'
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'CONTROL_URL', value: 'https://${control.properties.configuration.ingress.fqdn}' }
            { name: 'WORKER_SHARED_SECRET', secretRef: 'worker-shared-secret' }
            { name: 'TRANSPORT', value: 'acs' }
            { name: 'HEADLESS', value: 'true' }
            { name: 'WORKER_MODE', value: 'standby' }
            { name: 'STANDBY_UNTIL', value: standbyUntil }
          ]
        }
      ]
    }
  }
}

// Call receiver: signed in as the assistant's Teams account during the standby hours, it answers
// calls to the assistant and invitations into calls. One call at a time.
resource receiver 'Microsoft.App/jobs@2024-03-01' = if (receiverEnabled) {
  name: '${namePrefix}-receiver'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: { cronExpression: standbyStartCron, parallelism: 1, replicaCompletionCount: 1 }
      replicaTimeout: 12 * 3600 + (maxMeetingMinutes + 20) * 60
      replicaRetryLimit: 1
      registries: [
        { server: registry.properties.loginServer, identity: identity.id }
      ]
      secrets: [
        { name: 'worker-shared-secret', value: workerSharedSecret }
      ]
    }
    template: {
      containers: [
        {
          name: 'receiver'
          image: '${registry.properties.loginServer}/meeting-assistant-worker:${imageTag}'
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'CONTROL_URL', value: 'https://${control.properties.configuration.ingress.fqdn}' }
            { name: 'WORKER_SHARED_SECRET', secretRef: 'worker-shared-secret' }
            { name: 'TRANSPORT', value: 'acs' }
            { name: 'HEADLESS', value: 'true' }
            { name: 'WORKER_MODE', value: 'receiver' }
            { name: 'STANDBY_UNTIL', value: standbyUntil }
          ]
        }
      ]
    }
  }
}

// Lets the control service start executions of the worker job: Contributor on this one job only.
// To tighten it further, replace this with a custom role that holds only
// Microsoft.App/jobs/start/action, Microsoft.App/jobs/read and Microsoft.App/jobs/execution/read.
resource jobStartRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(worker.id, identity.id, roleContributor)
  scope: worker
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleContributor)
  }
}

resource bot 'Microsoft.BotService/botServices@2022-09-15' = {
  name: '${namePrefix}-bot-${suffix}'
  location: 'global'
  kind: 'azurebot'
  sku: { name: 'F0' }
  properties: {
    displayName: '${assistantName} Meeting Assistant'
    endpoint: 'https://${control.properties.configuration.ingress.fqdn}/api/messages'
    msaAppId: botClientId
    msaAppType: 'SingleTenant'
    msaAppTenantId: tenantId
  }
}

resource teamsChannel 'Microsoft.BotService/botServices/channels@2022-09-15' = {
  parent: bot
  name: 'MsTeamsChannel'
  location: 'global'
  properties: {
    channelName: 'MsTeamsChannel'
    properties: { isEnabled: true }
  }
}

output controlUrl string = 'https://${control.properties.configuration.ingress.fqdn}'
output messagingEndpoint string = 'https://${control.properties.configuration.ingress.fqdn}/api/messages'
output workerJobName string = worker.name
