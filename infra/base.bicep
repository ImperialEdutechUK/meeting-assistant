// Pass 1 of 2: the shared Azure resources for the Claude Meeting Assistant.
// Creates the container registry, storage, calling, speech, logging, the managed identity and
// the Container Apps environment. Run this first, then build and push the images, then deploy
// apps.bicep. The steps are in docs/SETUP.md.

@description('Azure region for all regional resources.')
param location string = resourceGroup().location

@description('Short prefix for resource names. Lower case letters and digits only.')
@minLength(3)
@maxLength(10)
param namePrefix string = 'cma'

@description('Where Azure Communication Services keeps its data at rest.')
param communicationDataLocation string = 'UK'

@description('Speech pricing tier. F0 is free (0.5 million neural voice characters a month, then requests are refused rather than billed). Only one F0 Speech resource is allowed per subscription; use S0 if F0 is taken.')
@allowed(['F0', 'S0'])
param speechSku string = 'F0'

@description('Daily cap on log ingestion in GB. 0.15 a day stays inside the 5 GB a month that Log Analytics gives free. Logs beyond the cap are dropped until the next day.')
param logDailyCapGb string = '0.15'

var suffix = uniqueString(resourceGroup().id)

// Built in role ids. These are the same in every Azure tenant.
var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var roleBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var roleTableDataContributor = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    // 30 days is inside the free retention period.
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json(logDailyCapGb) }
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-identity'
  location: location
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${namePrefix}acr${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('${namePrefix}st${suffix}', 24)
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource communication 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: '${namePrefix}-acs-${suffix}'
  location: 'global'
  properties: { dataLocation: communicationDataLocation }
}

resource speech 'Microsoft.CognitiveServices/accounts@2023-05-01' = {
  name: '${namePrefix}-speech-${suffix}'
  location: location
  kind: 'SpeechServices'
  sku: { name: speechSku }
  properties: { publicNetworkAccess: 'Enabled' }
}

resource pullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, roleAcrPull)
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull)
  }
}

resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identity.id, roleBlobDataContributor)
  scope: storage
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleBlobDataContributor)
  }
}

resource tableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identity.id, roleTableDataContributor)
  scope: storage
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleTableDataContributor)
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  // No workloadProfiles: a Consumption only environment, billed per second of use with no fixed fee.
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output storageAccountName string = storage.name
output communicationServiceName string = communication.name
output speechAccountName string = speech.name
output identityName string = identity.name
output environmentName string = environment.name
