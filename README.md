# Claude Meeting Assistant for Microsoft Teams

An AI assistant that joins your Teams meetings, follows them through live captions, answers when someone says "Hey Claude", answers questions in chat, and posts a recap when the meeting ends. Afterwards, attendees can ask it in a personal chat what was said, for example "What did I explain to each person yesterday?".

It runs in your own Azure subscription and uses your Claude API key. Nothing is recorded: the assistant keeps the caption text, not audio or video.

New to the project? Read `docs/HANDOVER.md` first. It gives the design, the costs, the risks and the one week plan.

## How it works

```
Teams chat (bot app)
   => Control service (Azure Container App)
        => Claude API: live answers (Haiku 5.5), recap and history answers (Sonnet 5.5)
        => Azure Speech: text to speech
        => Azure Storage: transcripts, recaps, knowledge base, usage
        => starts one worker per meeting (Azure Container Apps job)
             => headless Chrome joins the meeting through Azure Communication Services
             => Teams live captions come in and become the transcript
             => speech audio goes out into the call
```

1. Someone mentions the bot in a meeting chat and types `join`, or pastes a meeting link in a personal chat with the bot.
2. The control service records the request and starts a worker. The worker asks the control service which meeting to join.
3. The worker opens headless Chrome, joins the meeting as a visible participant named "Claude (AI assistant)", and turns on Teams live captions for itself.
4. Captions flow to the control service as a transcript. When someone says the wake phrase, the question goes to Claude with the transcript, and the answer is spoken sentence by sentence.
5. When the meeting ends, Claude writes the recap, which is posted to the meeting chat or sent to the person who invited the assistant.

## What is in this repository

| Path | What it is |
| --- | --- |
| `src/core` | Shared logic: wake phrase detection, transcript handling, prompts, the Claude client, knowledge search, pricing, storage |
| `src/control` | The control service: Teams bot endpoint, worker API, meeting lifecycle, recap delivery |
| `src/worker` | The meeting worker: Node host plus the browser page that runs the calling SDK |
| `scripts` | Local demo, day one spike, knowledge base ingestion, purge, cost model |
| `infra` | Azure infrastructure as Bicep, in two passes |
| `docker` | Container images for the control service and the worker |
| `teams-app` | Teams app manifest template, icons and package builder |
| `test` | Automated tests, including an end to end run in headless Chrome |
| `docs` | Handover document, setup guide, operations runbook, cost notes |

## Quick start on your own machine

You need Node 22 or newer and Google Chrome. No accounts are needed for these three steps.

Step 1. Install the dependencies.

```
npm ci
```

Step 2. Run the tests. The end to end test needs Chrome. Set `CHROME_PATH` if Chrome is not in a standard location.

```
npm test
```

Step 3. Run the scripted demo meeting. It takes about a minute and prints the transcript, the answers and the recap.

```
npm run demo
```

To hear real answers and a real voice in the demo, set `ANTHROPIC_API_KEY`, `SPEECH_KEY` and `SPEECH_REGION` first. Without them the demo uses a scripted stand in and tones.

## What has been tested and what has not

Tested here, automatically, with `npm test`:

* Wake phrase detection, question assembly, sentence splitting, transcript building, knowledge search, cost arithmetic.
* The storage layer against the Azurite emulator, which implements the real Azure Table and Blob Storage interfaces.
* The Claude client against a local server that speaks the Messages API wire format: request shape, prompt caching markers, streaming, tool use.
* The whole flow end to end in real headless Chrome: claim, join, captions, wake phrase, spoken answer reaching the call audio only while unmuted, recap, notifications, clean up. Teams itself is replaced by a scripted meeting.
* The Teams SDK wiring starts, serves the worker API on the same server, and rejects unsigned calls.

Not tested, because it needs your tenant and subscriptions:

* Joining a real Teams meeting through Azure Communication Services and receiving real captions. `npm run spike` exists to prove this on day one.
* Real Claude API calls and real Azure Speech output.
* The Bicep templates and the Docker images. They have been written with care but have not been compiled, built or deployed.
* Teams chat messages arriving through a real bot registration.

Treat the first day as a proof of the untested parts. `docs/SETUP.md` lists exactly what to check.

## Deploying

Follow `docs/SETUP.md`. In short: prove the join with the spike, deploy `infra/base.bicep`, build the two images in the registry, deploy `infra/apps.bicep`, build the Teams app package and upload it in the Teams admin centre.

## Settings

Every setting is an environment variable, documented in `.env.example`. The ones you are most likely to change:

| Setting | Default | Purpose |
| --- | --- | --- |
| `ASSISTANT_NAME`, `WAKE_NAMES` | Claude, claude | The name the assistant answers to |
| `BOT_DISPLAY_NAME` | Claude (AI assistant) | Name in the meeting roster |
| `LIVE_MODEL` | `claude-haiku-5-5` | Model for spoken and meeting chat answers |
| `CHAT_MODEL`, `RECAP_MODEL` | `claude-sonnet-5-5` | Models for history questions and recaps |
| `MONTHLY_BUDGET_USD` | 200 | The assistant refuses new meetings beyond this estimated spend |
| `RETENTION_DAYS` | 90 | How long transcripts and recaps are kept |
| `KB_AUDIENCE` | staff | Who may get answers from the company knowledge base |
| `ENABLE_WEB_SEARCH` | false | Lets Claude search the web for current facts |

## Limits to know about

* The assistant joins as an external participant. Someone must admit it from the lobby unless your lobby settings let everyone in.
* It needs Teams live captions. If captions are blocked by policy in a meeting, it cannot follow that meeting.
* It follows one spoken language per meeting, the one set in `SPOKEN_LANGUAGE`.
* It cannot be added to a direct one to one call. Start a meeting instead (Meet now) and invite it with the link.
* Meetings hosted on Teams for personal accounts cannot be joined.
* Microsoft retires Azure Communication Services as a standalone product on 30 September 2028. Calling and captions stay supported for Teams scenarios after that, on a new major SDK version and with an applicable Teams licence. Microsoft's guide does not say how that applies to an unlicensed external participant such as this assistant. See `docs/OPERATIONS.md`.
