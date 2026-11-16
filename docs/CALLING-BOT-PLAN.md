# Plan: a direct "Call" button for the assistant (not built yet)

**Superseded on 16 November 2026.** The assistant now has its own licensed Teams account, which
gives a real Call button with live conversation and the ability to be added to calls. See
`docs/TEAMS-ACCOUNT-SETUP.md`. This plan is kept only as a fallback if that route cannot be used.

Status: planned, 16 November 2026. Not built. Today, staff get a private voice catch-up through a
summary call (Meet now, then `summary call <link>` in the personal chat). This plan replaces that
with pressing **Call** on the Claude Meeting Assistant chat in Teams.

## What the person sees

1. They open their chat with Claude Meeting Assistant and press **Call** (Teams desktop or web).
2. The assistant answers: "Hi, it's Claude. Which meeting would you like to catch up on?"
3. They speak, pause, and hear the answer. They keep asking until they say "goodbye" or hang up.

The conversation is turn by turn, like a walkie-talkie: the person finishes speaking, then waits
about 5 to 8 seconds for the answer, and cannot interrupt an answer. Calls from the Teams mobile app
are not supported by Microsoft ("User initiated calls to a bot aren't supported on the Teams mobile
client").

## How it works

It uses the Microsoft Graph calling API with service-hosted media, which works over plain HTTPS from
the existing Node.js control service. No Windows server or C# media bot is needed (that is only
required for real-time audio, which this plan does not use).

```
Teams user presses Call
  => Microsoft Graph sends an "incoming call" notification to the control service (/api/calling)
  => the control service answers the call (serviceHostedMediaConfig)
  => playPrompt: greeting audio (WAV made by Azure Speech, served from a one-time HTTPS link)
  => loop:
       recordResponse: Graph records the person's question (up to 2 minutes, stops on silence)
       control service downloads the recording at once (Graph discards it soon after)
       Azure Speech speech-to-text turns it into text
       Claude answers from the meetings the caller attended (same as summary calls today)
       Azure Speech turns the answer into a WAV; playPrompt plays it
  => "goodbye" or hang up: the control service ends the call
```

Facts checked on Microsoft Learn (pages updated 2025 to 2026):

| API | Permission | Limits |
| --- | --- | --- |
| `recordResponse` (v1.0) | Application `Calls.AccessMedia.All` | Max 2 minutes per recording. Initial and end-of-speech silence timeouts 1 to 120 s. Recording returned as `recordingLocation` + `recordingAccessToken`, "discarded shortly after the call ends", so download immediately |
| `playPrompt` (v1.0) | Application `Calls.Initiate.All` | Up to 20 prompts. Audio given as an HTTPS `uri`. Format requirements are not stated on the page: test with 16 kHz, 16-bit mono PCM WAV first |
| Incoming 1:1 call | "Graph permissions aren't necessary for a user to initiate a peer-to-peer call with your bot" | The bot must have calling enabled and a calling webhook |

Both APIs only work on calls answered with `serviceHostedMediaConfig`.

## Steps for the Microsoft admin

Do these first; the developer cannot test anything until they are done.

1. **Graph permissions.** Entra admin centre, App registrations, "Claude Meeting Assistant Bot", API
   permissions, Add a permission, Microsoft Graph, Application permissions:
   * `Calls.AccessMedia.All`
   * `Calls.Initiate.All`

   Then **Grant admin consent for Imperial Learning Ltd**. These are application permissions: the
   bot can only use them on calls it is part of, but they are tenant-wide, so record the approval.
2. **Enable calling on the bot.** Azure portal, resource group `rg-meeting-assistant`, the Azure Bot
   (`cma-bot-...`), Channels, Microsoft Teams, **Calling** tab: tick **Enable calling** and set the
   webhook to `https://cma-control.gentlemushroom-979c5f41.uksouth.azurecontainerapps.io/api/calling`.
   Save.
3. **Upload the updated Teams app.** The developer rebuilds the package with calling switched on
   (version 1.1.0). Upload it in the Teams admin centre as an update to Claude Meeting Assistant.
   Users may need to restart Teams to see the Call button.

## Steps for the developer

1. **Manifest.** In `teams-app/manifest.template.json`, on the bot add `"supportsCalling": true` and
   `"supportsVideo": false`. Raise `version` in `teams-app/app.config.json` to `1.1.0` and run
   `npm run teams:package`.
2. **Calling endpoint.** New file `src/control/calling.ts`, mounted at `POST /api/calling` in
   `src/control/main.ts`.
   * Validate every notification: Microsoft sends a bearer token. Check its signature, issuer and
     that the audience is the bot's client id before acting. Reject anything else with 401.
   * Keep one session per call id in memory (the control service runs one replica).
3. **Graph client.** App-only token through client credentials (`CLIENT_ID`, `CLIENT_SECRET`,
   scope `https://graph.microsoft.com/.default`), cached until shortly before expiry.
4. **Answer the call.** On an incoming call notification: check the caller is in an allowed tenant
   and is staff (same rules as chat), then `POST /communications/calls/{id}/answer` with
   `callbackUri` = the webhook, `acceptedModalities: ["audio"]`, and
   `mediaConfig: { "@odata.type": "#microsoft.graph.serviceHostedMediaConfig" }`. The control service
   scales to zero, so the first call after a quiet spell includes a few seconds of wake-up. Measure
   that Graph does not time out; if it does, keep one replica during working hours.
5. **Play audio.** Synthesize with the existing `AzureTts` using the output format
   `riff-16khz-16bit-mono-pcm`. Serve each WAV from `GET /api/calling/audio/<random token>.wav`,
   valid for 5 minutes and one call only, then `POST .../playPrompt` with that URL.
6. **Record the question.** After each prompt completes, `POST .../recordResponse` with
   `bargeInAllowed: true`, `initialSilenceTimeoutInSeconds: 10`, `maxSilenceTimeoutInSeconds: 2`,
   `maxRecordDurationInSeconds: 60`, `playBeep: false`. On the completed notification, download
   `recordingLocation` with `Authorization: Bearer <recordingAccessToken>` straight away.
7. **Speech to text.** Send the recording to Azure Speech (the existing `SPEECH_KEY`), language
   `en-GB`. Add a small `src/core/stt.ts` next to `tts.ts`. If nothing was said, ask "Are you still
   there?" once, then end the call.
8. **Answer.** Reuse what summary calls already use: `attendedSessions` in
   `src/control/service.ts`, `privateCallSystemPrompt` in `src/core/prompts.ts`, and
   `brain.answerLive` with `privateCall: true` and `channel: 'voice'`. A 1:1 call has only the caller,
   so the privacy lock is satisfied by construction; still check the caller id on every turn.
9. **End.** On "goodbye", "that's all" or "thank you, bye", play a short goodbye and
   `DELETE /communications/calls/{id}`. Also end after 30 minutes. Record usage (Claude, speech,
   speech-to-text) like other calls; post nothing to chat.
10. **Tests.** Unit tests with recorded Graph notification payloads for: answer, prompt completed,
    record completed, call ended, bad token rejected, non-staff caller rejected.

## Costs

* Speech-to-text: the free tier includes 5 audio hours a month, then about $1 per audio hour.
  Questions are short, so a typical catch-up call uses well under a minute of recognition.
* Text to speech and Claude: the same as summary calls today.
* Graph calling for a bot answering 1:1 calls: no charge found on the pages checked. Confirm on the
  Azure invoice after the first week.

## Risks

* Turn by turn feels slower than the live summary call, and answers cannot be interrupted.
* Desktop and web only.
* `playPrompt` audio format and the validity period of recordings are not documented on the pages
  checked. Plan half a day for trial and error.
* The two Graph application permissions need admin consent. Some organisations review these.
