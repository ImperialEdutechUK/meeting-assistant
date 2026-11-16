# Operations runbook

Day to day care of the assistant once it is deployed. Resource names assume the prefix `cma` and the resource group `rg-meeting-assistant`.

## Where to look when something is wrong

Step 1. Follow the control service log.

```
az containerapp logs show --name cma-control --resource-group rg-meeting-assistant --follow
```

Step 2. List recent worker runs. Each meeting is one execution.

```
az containerapp job execution list --name cma-worker --resource-group rg-meeting-assistant --output table
```

Step 3. Read the log of one worker run in Log Analytics. Replace the execution name.

```
az monitor log-analytics query --workspace REPLACE_WITH_WORKSPACE_ID --analytics-query "ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith 'REPLACE_WITH_EXECUTION_NAME' | project TimeGenerated, Log_s | order by TimeGenerated asc"
```

Every log line is one JSON object with a `scope` (main, control, teams, worker, dispatcher) and a `message`.

## Common situations

| Situation | What to check |
| --- | --- |
| The bot says "On my way" but never appears | Worker executions list. If none started, the control identity cannot start the job (role assignment). If one started and failed, read its log |
| The bot waits in the lobby | Someone must admit it. After five minutes it gives up and tells the inviter |
| The bot is in the meeting but does not respond to its name | Captions. Look for "Captions started" in the worker log. Then check how the name is transcribed and add variants to `WAKE_NAMES` |
| The bot answers in chat but not aloud | "Could not unmute" (attendees are stopped from unmuting) or "Text to speech failed" (speech key or region) |
| No recap arrived | The control log around "Meeting finalised". With no captured speech there is no recap |
| "The monthly budget has been reached" | Raise `MONTHLY_BUDGET_USD`, or wait for the new month. Send `status` to the bot to see the estimate |
| Company answers are refused in a meeting | The person asking is not recognised as staff. They become recognised once they have sent the bot any message in Teams, or set `KB_AUDIENCE=everyone` |

## Updating the software

Step 1. Build new images with a new tag.

```
az acr build --registry REPLACE_WITH_REGISTRY_NAME --image meeting-assistant-control:0.1.1 --file docker/control.Dockerfile .
```

Step 2. Build the worker image with the same tag.

```
az acr build --registry REPLACE_WITH_REGISTRY_NAME --image meeting-assistant-worker:0.1.1 --file docker/worker.Dockerfile .
```

Step 3. Point the control service at the new image.

```
az containerapp update --name cma-control --resource-group rg-meeting-assistant --image REPLACE_WITH_REGISTRY_LOGIN_SERVER/meeting-assistant-control:0.1.1
```

Step 4. Point the worker job at the new image. Meetings in progress finish on the old one.

```
az containerapp job update --name cma-worker --resource-group rg-meeting-assistant --image REPLACE_WITH_REGISTRY_LOGIN_SERVER/meeting-assistant-worker:0.1.1
```

To change a setting, either redeploy `infra/apps.bicep` with the new parameter, or set it directly:

```
az containerapp update --name cma-control --resource-group rg-meeting-assistant --set-env-vars MONTHLY_BUDGET_USD=300
```

## Keeping versions in step

* The base image in `docker/worker.Dockerfile` (`mcr.microsoft.com/playwright:v1.65.0-noble`) must match the `playwright-core` version in `package.json`. Change both together.
* All dependency versions are pinned exactly. Update them deliberately, run `npm test`, then run the spike against a real meeting before releasing.
* On 13 November 2026 `npm audit --omit=dev` reported no known vulnerabilities in the packages that ship. `npm audit` reported four of moderate severity, all in the `uuid` package as pulled in by the Azurite storage emulator, which only the tests use.

## Calling SDK lifecycle

Microsoft announced in September 2026 that Azure Communication Services is being retired as a standalone product on 30 September 2028. This is what its retirement guide (linked in `docs/COSTS.md`) said when read on 13 November 2026:

* The calling SDK and closed captions are in the group that stays supported with breaking changes. After 30 September 2028 they are for use in Teams scenarios only, on a new major version of the SDK, and with an applicable Teams licence.
* The guide does not say how the licence condition applies to an external participant without a licence, which is how this assistant joins. Put that question to Microsoft well before 2028.
* Since 23 October 2026 Microsoft has limited onboarding to the retiring services. The guide says the limits are for retiring services only and that resources needed for Teams scenarios can still be created. If `infra/base.bicep` fails to create the Communication Services resource in a subscription that never had one, raise a support request with Microsoft and quote the guide.
* The services retired outright include chat, rooms, phone numbers, SMS, email and the UI libraries. This project uses none of them. It does rely on the identity service for the assistant's access token, so check what the guide says about identity when you review it.

This project uses `@azure/communication-calling` 2.0.0. The npm registry shows that 2.0.0 was published on 24 September 2026, the week of the announcement, and that the stable release before it was 1.46.1. That suggests 2.0.0 is the new major version the guide refers to, but I could not read its release notes to confirm it.

What to do: once a year, and no later than early 2028, read the retirement guide, update the SDK, run the tests and the spike. All SDK use is in one file, `src/worker/page/transport-acs.ts`.

## Secrets

| Secret | Where it lives | How to rotate |
| --- | --- | --- |
| Claude API key | Container App secret `anthropic-api-key` | Create a new key in the Claude Console, update the secret, restart the revision |
| Bot client secret | Container App secret `bot-client-secret` | `az ad app credential reset`, update the secret. It expires after a year |
| Worker shared secret | Secret `worker-shared-secret` on both the app and the job | Generate a new value and update both at a quiet time |
| Calling connection string, speech key | Container App secrets, read from Azure at deployment | Regenerate the key in Azure, then redeploy `infra/apps.bicep` |

To update one secret:

```
az containerapp secret set --name cma-control --resource-group rg-meeting-assistant --secrets anthropic-api-key=REPLACE_WITH_NEW_VALUE
```

## Data and retention

* Transcripts, recaps and usage rows are in the storage account. Tables start with `cma`. Blobs are in the `meeting-assistant` container.
* Meetings older than `RETENTION_DAYS` are deleted automatically every six hours, with their transcript, recap and index entries. `npm run purge` does the same by hand.
* To delete one meeting on request, delete it through the same code path: write a short script that calls `deleteMeeting` on the store with the meeting id, which is shown in the logs.
* No audio or video is ever stored.

## Cost watch

* Send `status` to the bot for the current estimate against the budget.
* The estimate is conservative and is not the invoice. Check Azure Cost analysis and the Claude Console monthly.
* After the first week, check Cost analysis for a "Closed Captions" meter. If there is none, set the captions price to zero so the budget guard stops counting it:

```
az containerapp update --name cma-control --resource-group rg-meeting-assistant --set-env-vars PRICES_JSON='{"captionsPerMinute":0}'
```
