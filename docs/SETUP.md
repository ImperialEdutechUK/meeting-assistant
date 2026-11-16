# Setup guide

This guide takes a developer from an empty Azure resource group to the assistant working in Teams. It is written for the Azure CLI in a Bash shell. In PowerShell, set variables with `$env:NAME="value"` instead of `export NAME="value"`.

The order matters. Part B proves the one thing that cannot be tested without your tenant (joining a real meeting and hearing captions) before any time is spent on the rest.

## What you need

* Node 22 or newer, Google Chrome, and the Azure CLI with Bicep.
* An Azure subscription where you are Owner of the resource group, because the templates create role assignments.
* A Teams administrator (to allow and upload the app) and someone who can create an app registration in Microsoft Entra.
* A Claude API key from the Claude Console.

## Part A. Run it locally

Step 1. Install the dependencies.

```
npm ci
```

Step 2. Run the tests.

```
npm test
```

Step 3. Run the scripted demo.

```
npm run demo
```

If all three succeed, the code is sound on your machine and you can move on.

## Part B. Day one spike against a real meeting

Step 1. Sign in to Azure.

```
az login
```

Step 2. Create the resource group. UK South keeps the data in the United Kingdom.

```
az group create --name rg-meeting-assistant --location uksouth
```

Step 3. Check that the first template compiles. Neither template has been compiled before, so do this before deploying.

```
az bicep build --file infra/base.bicep --stdout > /dev/null
```

Step 4. Deploy the shared resources. Note the outputs, which name the registry, storage, calling and speech resources.

```
az deployment group create --resource-group rg-meeting-assistant --template-file infra/base.bicep --parameters namePrefix=cma --query properties.outputs
```

If this step refuses to create the Communication Services resource, read "Calling SDK lifecycle" in `docs/OPERATIONS.md`. Microsoft has limited some onboarding to that service since 23 October 2026.

Step 5. Add the Communication Services commands to the Azure CLI.

```
az extension add --name communication
```

Step 6. Read the calling connection string into a variable. Replace the name with the `communicationServiceName` output from step 4.

```
export ACS_CONNECTION_STRING="$(az communication list-key --name REPLACE_WITH_COMMUNICATION_SERVICE_NAME --resource-group rg-meeting-assistant --query primaryConnectionString --output tsv)"
```

Step 7. Read the speech key into a variable. Replace the name with the `speechAccountName` output from step 4.

```
export SPEECH_KEY="$(az cognitiveservices account keys list --name REPLACE_WITH_SPEECH_ACCOUNT_NAME --resource-group rg-meeting-assistant --query key1 --output tsv)"
```

Step 8. Set the speech region.

```
export SPEECH_REGION=uksouth
```

Step 9. Start a Teams meeting from your own account (Calendar, then Meet now, then copy the join link) and put the link in a variable.

```
export MEETING_URL="PASTE_THE_TEAMS_JOIN_LINK_HERE"
```

Step 10. Run the spike. Add `HEADLESS=false` in front to watch the browser.

```
npm run spike
```

### What to check during the spike

Tick each item. If any of the first four fails, stop and read "If the spike fails" below before building further.

1. Within about a minute, "Claude (AI assistant)" appears in the meeting lobby.
2. After you admit it, the terminal prints captions with the right speaker names as people talk.
3. When you say "Hey Claude, what did I just say?", everyone hears a short chime and then a spoken reply. Without a Claude API key the reply is an echo of your question, which is enough for this test.
4. The roster shows the assistant muted except while it speaks.
5. Pressing Ctrl+C makes the assistant leave, and the terminal prints the captured transcript.
6. Two days later, open Cost analysis for the resource group, group by meter, and note whether a "Closed Captions" meter shows a charge. This settles the one open cost question (see `docs/COSTS.md`).

### Teams settings the spike depends on

A Teams administrator should confirm these in the Teams admin centre before the spike:

1. Meetings, then Meeting settings: "Anonymous users can join a meeting" is on.
2. Meetings, then Meeting policies, the policy that applies to the organiser: "Anonymous users can join a meeting" is on, and live captions are not disabled.
3. Clients built on Azure Communication Services are not blocked from anonymous join.

The same checks in Teams PowerShell:

Step 1. Connect.

```
Connect-MicrosoftTeams
```

Step 2. Check the organisation setting. `DisableAnonymousJoin` should be False.

```
Get-CsTeamsMeetingConfiguration | Select-Object DisableAnonymousJoin
```

Step 3. Check the meeting policy. `AllowAnonymousUsersToJoinMeeting` should be True, `BlockedAnonymousJoinClientTypes` should not contain ACS, and `LiveCaptionsEnabledType` should not be Disabled.

```
Get-CsTeamsMeetingPolicy -Identity Global | Select-Object AllowAnonymousUsersToJoinMeeting, BlockedAnonymousJoinClientTypes, LiveCaptionsEnabledType
```

### If the spike fails

| What you see | Likely cause | What to do |
| --- | --- | --- |
| Never reaches the lobby, worker reports "could not connect" | Anonymous join is off, or ACS clients are blocked | Fix the Teams settings above. Policy changes can take up to a day to apply |
| Sits in the lobby until the timeout | Nobody admitted it | Admit it, or review the lobby setting for that meeting |
| Connected but no captions arrive | Live captions disabled by policy, or the spoken language is not offered | Check the worker log line that starts "Page:", then the captions policy and `SPOKEN_LANGUAGE` |
| Captions arrive but nothing is heard | The organiser stopped attendees from unmuting, or speech failed | Check "Could not unmute" or "Text to speech failed" in the logs |
| The browser fails to start | Chrome not found | Set `CHROME_PATH`, or run `npx playwright-core install chromium` |

If joining through Azure Communication Services cannot be made to work in your tenant, the code is built so that only one file needs replacing: `src/worker/page/transport-acs.ts` implements a small interface (`src/worker/page/transport.ts`). The handover document describes the fallback options.

## Part C. Deploy to Azure

### C1. Register the bot identity

Step 1. Create a single tenant app registration and note the id it prints.

```
az ad app create --display-name "Claude Meeting Assistant Bot" --sign-in-audience AzureADMyOrg --query appId --output tsv
```

Step 2. Create its service principal. Replace the id.

```
az ad sp create --id REPLACE_WITH_APP_ID
```

Step 3. Create a client secret and note it. It is shown once.

```
az ad app credential reset --id REPLACE_WITH_APP_ID --append --display-name "bot secret" --years 1 --query password --output tsv
```

### C2. Build the images in the registry

The registry builds the images in the cloud, so Docker is not needed on your machine. Replace the registry name with the `registryName` output from Part B.

Step 1. Build the control service image.

```
az acr build --registry REPLACE_WITH_REGISTRY_NAME --image meeting-assistant-control:0.1.0 --file docker/control.Dockerfile .
```

Step 2. Build the worker image. This one is large because it contains Chromium.

```
az acr build --registry REPLACE_WITH_REGISTRY_NAME --image meeting-assistant-worker:0.1.0 --file docker/worker.Dockerfile .
```

### C3. Deploy the services

Step 1. Generate the secret shared by the control service and the worker, and note it.

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Step 2. Check that the second template compiles.

```
az bicep build --file infra/apps.bicep --stdout > /dev/null
```

Step 3. Deploy. The command asks for the three secrets (bot client secret, Claude API key, shared secret) so they never appear in a file or in your shell history.

```
az deployment group create --resource-group rg-meeting-assistant --template-file infra/apps.bicep --parameters namePrefix=cma imageTag=0.1.0 botClientId=REPLACE_WITH_APP_ID organisationName="Imperial Learning Ltd" --query properties.outputs
```

Step 4. Check that the control service is healthy. Replace the address with the `controlUrl` output.

```
curl https://REPLACE_WITH_CONTROL_URL/healthz
```

### C4. Build and upload the Teams app

Step 1. Copy the example configuration.

```
cp teams-app/app.config.example.json teams-app/app.config.json
```

Step 2. Generate an id for the Teams app and paste it into `teamsAppId` in that file. Also fill in `botClientId` and the three web addresses (your website, privacy notice and terms).

```
node -e "console.log(crypto.randomUUID())"
```

Step 3. Build the package. It is written to `teams-app/build/claude-meeting-assistant.zip`.

```
npm run teams:package
```

Step 4. A Teams administrator uploads the package: Teams admin centre, Teams apps, Manage apps, Upload new app. Then allow it for a pilot group with an app permission policy, and optionally pin it with an app setup policy.

### C5. First test in Teams

1. Open a personal chat with the app and send `help`. It should reply with its introduction.
2. Start a meeting, open the meeting chat, add the app to the chat, mention it and type `join`.
3. Admit it from the lobby, talk for a minute, then say "Hey Claude, what have we covered so far?".
4. Mention it in the chat and type `leave`. The recap should arrive within a minute.
5. In the personal chat, ask "What did I say in my last meeting?".

If `join` in a meeting chat answers that it needs the meeting link, the lookup of the meeting details was refused. The usual cause is that resource specific consent for chats is switched off in the tenant. Either have an administrator allow it, or paste the meeting link in a personal chat with the bot, which needs no such permission.

## Part D. Load the company knowledge base

Step 1. Put the documents the assistant may quote in one folder. Supported types are Markdown, plain text, CSV, HTML and Word. Leave out anything that staff in general should not hear read aloud.

Step 2. Preview what will be indexed, with a test question.

```
npm run kb:ingest -- ./knowledge --dry-run --test "what is the refund policy"
```

Step 3. Upload. Replace the account name with the `storageAccountName` output. Your own Azure sign in needs the Storage Blob Data Contributor role on the account.

```
STORAGE_ACCOUNT_NAME=REPLACE_WITH_STORAGE_ACCOUNT_NAME npm run kb:ingest -- ./knowledge
```

The control service picks up a new knowledge base within five minutes. Rerun the upload whenever the documents change.
