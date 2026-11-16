# Claude Meeting Assistant for Teams: Developer Handover

This is a copy of the handover document as it stood on 13 November 2026, kept with the code so the package is complete. The diagram is given as text.

13 November 2026

## At a glance

The assistant is built and tested as far as it can be without your tenant. A developer can start from the code package and reach a pilot in about one working week, provided the day one test against a real Teams meeting passes.

| Question | Answer |
| --- | --- |
| What it does | Joins a Teams meeting when invited, follows it through live captions, answers "Hey Claude" aloud, answers in the meeting chat, posts a recap, and later answers questions such as "What did I explain to each person yesterday?" |
| How it joins | As a visible participant named "Claude (AI assistant)", through Azure Communication Services, in a container that runs only while the meeting lasts |
| Thinking | Claude Haiku 5.5 for live answers, Claude Sonnet 5.5 for recaps and questions about past meetings, on your Claude API key |
| Voice | Azure Speech, a British English neural voice |
| Running cost | About $58 to $183 a month at 5,000 meeting minutes. Most of the range comes from one Microsoft billing question that a single test meeting settles |
| Proven here | 53 automated tests pass, including a complete run in headless Chrome against a scripted meeting |
| Not yet proven | Joining a real Teams meeting in your tenant, live Claude and Azure Speech calls, and the Azure deployment templates. I had no access to your tenant or keys |
| Lifespan | Microsoft retires Azure Communication Services as a standalone product on 30 September 2028. Microsoft's guide keeps calling into Teams meetings and Teams captions after that date, on a new major version of the calling library and subject to Teams licensing. See Risks and open decisions |

How I read the request. Tell me if any of these is wrong and I will adjust the build.

* "AI presenter" means an AI participant that listens and speaks, not a video avatar.
* Meetings are held in English. The assistant follows one spoken language per meeting.
* The "company information directory" is a folder of documents you choose. "Checking on updates" means past meetings, with web search available as a switch that is off by default.
* A pilot next week is realistic. A hardened company wide service next week is not.

## How the parts fit together

```
Teams chat    <=>  Control service (always on)  =>  Claude API, Azure Speech, Azure Storage
Meeting call  <=>  Meeting worker (one per meeting)  <=>  Control service
```

The worker joins through Azure Communication Services and appears in the meeting as Claude (AI assistant). Apart from Teams and the Claude API, every part runs in your own Azure subscription.

Staff reach the control service through Teams chat. It starts one worker for each meeting, the worker sits in the call, and every answer and every stored word passes back through the control service.

## What staff can do

Staff invite the assistant like a colleague, talk to it by name in the call, and ask it afterwards what was said.

| Situation | What the person does | What happens |
| --- | --- | --- |
| Invite it from the meeting chat | Mention the app and type join | It reaches the lobby in about a minute. Someone admits it. It introduces itself aloud and in the chat |
| Invite it without the meeting chat | Paste the meeting link in a personal chat with the app | The same, and its messages go to that personal chat |
| Ask aloud | Say "Hey Claude, what did I explain to each person?" | A short chime, then a spoken answer of about three sentences drawn from the transcript |
| Ask in writing | Mention the app in the meeting chat with a question | A written answer in the chat |
| Ask about the company | "Hey Claude, what is our refund policy?" | An answer from the documents you loaded, for recognised staff only |
| Stop it talking | "Claude, stop" or "Thanks Claude" | It stops at once |
| Get a recap | Mention it and type recap, or wait for the end | Summary, decisions, actions with owners, who explained what to whom, open questions |
| Send it away | Mention it and type leave | It leaves and posts the recap |
| Ask later | In a personal chat: "What did I explain to each person yesterday?" | It looks through the meetings that person attended and answers. Nobody can query a meeting they were not in |

Four limits to tell staff about before the pilot:

* Someone must admit it from the lobby each time, because it joins as an external participant.
* It needs Teams live captions. Where captions are switched off by policy, it cannot follow the meeting.
* It cannot be added to a direct one to one call. Start a meeting with Meet now and invite it with the link.
* Its answers come from captions, which mishear names and figures. The recap says so and people should check important details.

## Why this design

Joining through Azure Communication Services and listening through Teams captions keeps everything in your own Azure subscription, suits developers who work in TypeScript, and is the cheapest option provided Microsoft does not bill the captions (see Monthly cost). That is why I chose it over the Microsoft Graph real time media bot, which is Microsoft's official route to meeting audio.

| Option | What it needs | Estimated cost a month at 5,000 minutes | Verdict |
| --- | --- | --- | --- |
| Azure Communication Services with Teams captions (chosen) | TypeScript, and Linux containers that run only during meetings | $58 to $183 | Lowest running cost in the low case, matches the team's skills, nothing left running between meetings except one small service |
| Microsoft Graph real time media bot | C# on a Windows Server virtual machine in Azure that is always on, plus paid speech to text. [Microsoft's requirements](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots) | About $400: the machine $304 (D4s v3 Windows, $0.416 an hour for 730 hours), speech to text $83 (83.3 hours at $1), plus Claude and voice | The official route to raw audio, but dearer and a different skill set |
| ElevenLabs agent bridged into Teams | The same Windows media bot, by [ElevenLabs' own guide](https://elevenlabs.io/docs/eleven-agents/phone-numbers/microsoft-teams/graph-media-bot), plus their charge per minute | $400 to $500 for ElevenLabs alone at the reported 8 to 10 cents a minute, plus the machine | The most natural conversation and the highest cost. I did not confirm the price on ElevenLabs' own pricing page |
| Microsoft 365 Copilot | A licence for each user | Reported at $21 to $30 per user per month, so $630 to $900 for 30 users as an illustration | No build. Recaps and questions inside Teams, but it is not Claude and it is priced per head |
| A meeting bot service such as Recall.ai | An account and their API. [Pricing](https://www.recall.ai/pricing) | About $54 for the bot (83.3 hours at $0.65 with transcription), so about $80 to $100 with Claude, voice and the control service | The quickest fallback if the day one test fails, and cheaper than the chosen design if Microsoft does bill captions. Meeting content passes through a third party |

Three facts shaped the choice:

* Raw meeting audio is only open to bots written in C# on Windows Server in Azure. Microsoft's page says Node.js cannot be used for it.
* Azure Communication Services lets an outside participant join a Teams meeting, [receive Teams captions with speaker names](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/enable-closed-captions), and [send its own audio](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/voice-video-calling/get-started-raw-media-access) from a browser. Chrome on Linux is on its [supported list](https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/calling-sdk-features).
* Claude Haiku 5.5 costs $0.10 per million input tokens, so reading a whole meeting transcript for every question costs a fraction of a cent. That removes the need for a paid search service.

One caution on lifespan. Microsoft announced in September 2026 that Azure Communication Services retires as a standalone product on 30 September 2028. Its [retirement guide](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide) keeps the calling library and captions for use with Teams, which is what this design relies on, but on a new major version of the library and with an applicable Teams licence. It does not say how the licence condition applies to an unlicensed outside participant such as this assistant. On Microsoft's published timeline the design is supported until 30 September 2028. What happens after that depends on the licence question, so review the guide once a year. The code isolates the library in one file so a change of route stays contained.

## Monthly cost

At 5,000 meeting minutes a month the assistant should cost between $58 and $183 to run, which is about 1.2 to 3.7 US cents a minute. All figures are US dollar list prices checked on 13 November 2026, before tax.

| Meeting minutes a month | Low case | High case |
| --- | --- | --- |
| 3,000 | $40.55 | $123.26 |
| 5,000 | $58.29 | $183.00 |
| 10,000 | $102.63 | $332.34 |

The two cases differ in two things I could not confirm. The larger is whether Microsoft bills its closed captions meter ($0.021 a minute) when the captions are the ones Teams itself generates. Microsoft's [Teams interop pricing page](https://learn.microsoft.com/en-us/azure/communication-services/concepts/pricing/teams-interop-pricing) lists only calling minutes and chat messages, and its captions pages state no price, but neither says captions are free. The smaller is whether the always on control service is billed at the idle or the active rate.

Where the money goes at 5,000 minutes:

| Item | Working | A month |
| --- | --- | --- |
| Joining the call (Azure Communication Services) | 5,000 minutes at $0.004 | $20.00 |
| Worker containers, UK South | 5,000 minutes at $0.00252, which is 60 seconds of 1 vCPU at $0.000034 plus 2 GiB at $0.000004 | $12.60 |
| Claude API | 111 meetings at $0.0789 each | $8.76 |
| Voice (Azure Speech) | 198,333 characters at $15 per million | $2.98 |
| Control service, always on | 730 hours of 0.25 vCPU and 0.5 GiB | $7.88 idle rate, $27.59 active rate |
| Registry, storage and logs | $5.07 for the registry plus a $1.00 allowance | $6.07 |
| Captions, only if Microsoft bills them | 5,000 minutes at $0.021 | $0 or $105.00 |
| Total |  | $58.29 to $183.00 |

The Claude figure per meeting is built from these assumptions: meetings average 45 minutes, six spoken questions per meeting hour, two written questions and one later question about the meeting, and one recap. A spoken question sends about 7,900 tokens to Haiku 5.5 and costs $0.00085. A recap on Sonnet 5.5 costs about $0.031. No saving from prompt caching is counted, although the code uses it.

What to do about the open question:

1. After the first real test meeting, wait two days and open Cost analysis in Azure, grouped by meter.
2. If no closed captions charge appears, you are in the low case. Tell the software so with one setting, described in the operations guide.
3. If it does appear, the developer can switch listening to Azure Speech at $1 an audio hour, which brings 5,000 minutes to roughly $142 to $161, or you can weigh the meeting bot service in the options table.

The software protects you meanwhile. It keeps its own running estimate, assumes the high case, and refuses to join new meetings once the month passes the budget you set (default $200). Staff can send it the word status to see the figure.

The arithmetic is a script in the code package (the cost model script in the scripts folder), so it can be rerun with your own assumptions. Prices came from [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) and Microsoft's public [retail prices feed](https://prices.azure.com/api/retail/prices).

## The code package

The package is a complete TypeScript project that the developer can install, test and demo on a laptop in a few minutes, before touching Azure or Teams.

| Part | What it does |
| --- | --- |
| Control service | The Teams bot endpoint and the brain. Handles join, leave, recap and questions, keeps the meeting records, asks Claude, makes the speech, posts the recap, enforces the budget and the retention period |
| Meeting worker | One per meeting. Opens headless Chrome, joins through Azure Communication Services, turns captions into a transcript, hears the wake phrase, plays the answers into the call, leaves when asked or when everyone has gone |
| Shared logic | Wake phrase and question detection, prompts, the Claude client with prompt caching, knowledge search, price table, storage on Azure Tables and Blobs |
| Scripts | A scripted demo meeting, the day one test against a real meeting, knowledge base loading, a purge, the cost model |
| Deployment files | Two Azure templates (Bicep), two container build files, the Teams app manifest with icons and a package builder |
| Guides | Setup guide with every command as a numbered step, operations runbook, cost notes |

Tested here, by 53 automated tests that the developer can rerun with one command:

* Wake phrase handling, including mishearings such as "hey cloud", and refusal to wake on ordinary sentences about the cloud.
* Storage against Microsoft's own storage emulator, including two workers racing to claim one meeting.
* The Claude client against a local server that speaks the real API format: the request it sends, prompt caching markers, streamed replies, tool use.
* The whole flow in real headless Chrome with a scripted meeting: invite, lobby, captions, a spoken question, speech reaching the call audio only while the assistant is unmuted, recap, delivery, clean up.
* Access rules: a person cannot read a meeting they did not attend, a guest cannot have company documents read aloud, another tenant is refused.
* Separately from the automated tests, I checked the Teams manifest by hand against Microsoft's published schema, version 1.25, and it is valid.

Not tested, because it needs your tenant, keys and subscription:

* Joining a real Teams meeting and receiving real captions. This is the main risk and the day one test exists to settle it.
* Live calls to Claude and Azure Speech.
* The two Azure templates and the two container builds. They are written but have never been compiled or run. My workspace did not allow me to download and run the Bicep compiler, so the first setup step is to compile them.
* Messages arriving through a real Teams bot registration.

I have also not measured the delay between a spoken question and the spoken answer against live services. I expect a few seconds, mostly the caption delay, and the pilot should measure it.

## Your steps as Microsoft admin

Eight things need your admin rights or your decision. The developer cannot finish without the first five.

1. **Azure.** Create a resource group in UK South and make the developer Owner of that group only. Owner is needed because the templates assign roles.
2. **Claude Console.** Create a separate workspace and API key for this project and set a monthly spend limit on it. Give the key to the developer through a secure channel, never in chat.
3. **Microsoft Entra.** Create one single tenant app registration for the bot, or allow the developer to. The setup guide has the three commands.
4. **Teams meeting settings.** Confirm that anonymous users can join meetings, that clients built on Azure Communication Services are not blocked, and that live captions are not disabled. Microsoft lists these controls in its [Teams administration page for external users](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/guest/teams-administration). The setup guide gives the PowerShell checks.
5. **Teams app.** Allow custom apps, upload the package the developer builds (Teams admin centre, Teams apps, Manage apps, Upload new app), and allow it for the pilot group only.
6. **Decisions.** Choose the retention period (default 90 days), whether the assistant announces itself aloud when it joins (default yes), who is in the pilot, and which documents go into the knowledge base.
7. **Data protection.** Complete the steps under Consent, privacy and data handling before external meetings are included.
8. **Cost check.** Two days after the first real test meeting, look at Cost analysis for the closed captions meter and tell the developer what you see.

## One week plan

A pilot by Friday 20 November is achievable for one developer working on this full time, if Monday's test passes. This is my estimate, not a guarantee, because the parts that could not be tested here sit at the start of the week.

| Day | Work | The day is done when |
| --- | --- | --- |
| Monday 16 November | Install, run the tests and the demo. Deploy the first Azure template. Run the day one test against a real meeting | The assistant reaches the lobby, captions print with the right names, a human in the meeting hears the chime and a reply, and it leaves on request |
| Tuesday 17 November | Register the bot, build the two container images, deploy the second template, build and upload the Teams package | The assistant answers help in Teams and joins a meeting from a pasted link |
| Wednesday 18 November | Turn on live Claude answers and the real voice. Tune the wake name for how captions hear it. Load a first set of company documents | Ten prepared questions in a test meeting get correct answers, aloud and in chat, and the recap matches what was said |
| Thursday 19 November | Pilot in two or three real meetings of the Course Development team. Fix what comes up. Check the cost meters | Attendees judge the recaps accurate and the assistant hears its name at least nine times in ten |
| Friday 20 November | Set the budget and alerts, read through the runbook together, settle the privacy wording | You decide whether to widen the pilot |

If Monday's test fails, stop and choose a fallback the same day. The setup guide lists the usual causes, most of which are Teams policy settings. If the route itself proves unworkable in your tenant, the options table above gives the alternatives. The calling layer sits behind one small interface, so the rest of the system stays as it is.

## Consent, privacy and data handling

The assistant keeps a written transcript of what people say, so the people in the meeting must be told, and that duty is yours rather than Microsoft's. I am not a lawyer and this section is not legal advice.

What Microsoft requires. Its [captions page](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/enable-closed-captions) says that if you store caption data you are responsible for doing so lawfully, that you must obtain consent from the people involved, and that you must tell users when captions are on and being stored. Microsoft's documentation also says captions are shown only to the participant who turned them on. An answer on Microsoft's Q&A forum adds that nobody else in the meeting is notified, which I could not confirm in the official documentation. Either way, treat the assistant's own announcement as the only notice people get.

Controls already built in:

| Control | How it works |
| --- | --- |
| Visible and named | It appears in the roster as "Claude (AI assistant)" and cannot join silently |
| Admitted by a person | It waits in the lobby until someone lets it in |
| Announces itself | It says who invited it and that it is transcribing, aloud and in the chat. The spoken part can be switched off |
| No recordings | It stores caption text only, never audio or video |
| Leaves on request | Anyone from your organisation in the meeting chat can send it away, and it leaves when Teams reports the meeting has ended or when it is alone |
| Attendees only | A person can only ask about meetings they attended. Access is checked on every lookup |
| Staff only knowledge | Company documents are only quoted to recognised staff, so a guest cannot have them read aloud |
| Your tenant only | Chat messages from other organisations are refused |
| Retention | Transcripts and recaps are deleted after the period you set, 90 days by default |
| Where data sits | Transcripts and recaps stay in your Azure storage in the UK. Questions and transcript text are sent to Anthropic's API for answers, and answer text to Azure Speech for the voice |

What you still need to do:

1. Tell staff in writing what the assistant is, what it keeps and for how long, and how to ask for a meeting to be deleted.
2. For meetings with people outside the company, say at the start that an AI assistant is transcribing, and add a line to the invitation. Do not use it where someone objects.
3. Carry out a data protection impact assessment. Transcribing meetings with AI is the kind of processing that normally calls for one under UK data protection law. Confirm this with your adviser.
4. Read Anthropic's commercial terms and data processing terms for the API, including where data is processed. I did not review them for this work.
5. Take advice on any rules that apply to colleagues in Sri Lanka. I cannot confirm the current requirements there.
6. Keep sensitive meetings out. Disciplinary, health and salary discussions should not have the assistant in the room.

## Risks and open decisions

The largest risk is that nothing here has yet joined a real Teams meeting, and Monday's test settles that on the first day. Each of the others has a stated way to handle it.

| Risk | What is known | How it is handled |
| --- | --- | --- |
| Joining a real meeting is untested | The code follows Microsoft's published interfaces and passes against a scripted meeting, but it has never met your tenant or its policies | The day one test in the setup guide. Stop and choose a fallback if it fails |
| Microsoft's limits on new customers | Since 23 October 2026 Microsoft has limited onboarding to the retiring parts of Azure Communication Services. Its guide says the limits apply to retiring services only and that resources needed for Teams scenarios can still be created. This design needs only calling into Teams meetings and captions | The first deployment step creates the resource, so you will know on Monday morning. If it is refused, raise a support request with Microsoft or move to a fallback |
| Captions may be billed | See Monthly cost. It decides whether 5,000 minutes cost about $58 or about $183 | Check Cost analysis two days after the first real meeting. The budget guard assumes the higher figure until told otherwise |
| Caption accuracy | The assistant hears only what Teams captions give it. Names, figures, strong accents and people talking over each other will be misheard at times, and so will the wake name. The code already accepts common mishearings such as "hey cloud" | Tune the wake names during the pilot, which is one setting. Every recap ends with a line telling readers to check important details |
| One spoken language per meeting | When the assistant starts captions it sets the spoken language, British English by default. Microsoft describes spoken language as a setting of the meeting, which I read as shared by everyone in it. A meeting in another language, or one that mixes languages, will be captured badly | Keep the pilot to meetings held in English. The language is one setting |
| The lobby, every time | It joins as an outside participant, so someone admits it unless the meeting's lobby setting lets everyone in | Accept this for the pilot. Giving the assistant its own licensed Teams account might remove the step. I have not tested or costed that |
| Retirement in 2028 | Microsoft's guide keeps calling and captions for Teams scenarios after 30 September 2028, on a new major version of the library and with an applicable Teams licence. It does not say how that applies to an unlicensed outside participant such as this assistant. The library used here, version 2.0.0, was published on 24 September 2026, the week of the announcement. I could not read its release notes to confirm that it is the version the guide means | Supported until 30 September 2028 on Microsoft's timeline. Review the guide once a year. The calling layer is one file, so a change of route stays contained |
| Never deployed | The two Azure templates have not been compiled and the two container images have not been built, because my workspace could not run those tools. Expect small corrections | Compiling is the first setup step. Monday and Tuesday allow time for it |
| Delays not measured | A spoken answer waits for the caption, then Claude, then the voice. I expect a few seconds. The time to reach the lobby after an invitation, about a minute, is also an estimate | Measure both in Wednesday's test meeting |
| One control service instance | While it restarts, chat commands and answers pause. A worker already in a meeting stays there and leaves by itself if it cannot reach the service for three minutes | Acceptable for a pilot. A second instance needs shared state for spotting duplicate Teams messages, which is not built |
| Chrome runs without its sandbox | Headless Chrome in the worker container runs with its own sandbox switched off, which is common in containers, and as a user without admin rights. It loads only the page bundled in the image and connects to Microsoft's calling service | Acceptable for a pilot. Review before a company wide rollout |
| Staff recognition needs one message | A speaker counts as staff if they invited the assistant or have ever sent it a message in Teams. Anyone else is refused company answers until they do | Ask pilot users to send the app the word help once. One setting removes the check |
| The name Claude | The app, the roster name and the wake word all use "Claude". I did not check Anthropic's brand guidance on naming an internal app after its model | The name is a setting. Change it if you prefer or if the guidance requires it |

Decisions for you, each with the default the code ships with:

| Decision | Default | Note |
| --- | --- | --- |
| How long transcripts and recaps are kept | 90 days | Shorter is safer for privacy. Longer makes "what did I explain" questions more useful |
| Spoken announcement on joining | On | Keep it on wherever outside people attend |
| Who gets answers from company documents | Recognised staff only | The alternative is everyone in the meeting |
| Web search for current facts | Off | Anthropic charges $10 per 1,000 searches on top of tokens |
| Monthly budget | $200 | Sized for the high case at 5,000 minutes |
| Longest meeting and meetings at once | 180 minutes and 5 | Both are settings |
| Pilot group | Not set | The plan assumes the Course Development team |
| Name and wake word | Claude | See the last risk above |

Left for a later phase, none of it built:

* Keeping the knowledge base in step with a SharePoint folder. Today a script loads Word, Markdown, text, CSV and HTML files on request, and PDFs must be exported first.
* Listening through Azure Speech instead of Teams captions, as the fallback if captions are billed or prove unreliable.
* Sending transcripts and recaps straight into ActionBrief, which would remove the download and upload step staff do today.
* A licensed Teams account for the assistant, which may remove the lobby step and may matter for the 2028 licence condition.

## Sources

The prices and platform facts above came from these pages, read on 13 November 2026. Vendor pages come first. The last group is blogs, forums and other reporting, used only where the text says a figure is reported or that I could not confirm a point officially.

Anthropic

* [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing): model prices, the higher Haiku 5.5 rate for long prompts, prompt caching and web search charges.

Microsoft, Teams

* [Requirements for application hosted media bots](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots): why raw meeting audio needs C# on Windows Server.
* [Use live captions in Teams meetings](https://support.microsoft.com/en-au/office/use-live-captions-in-microsoft-teams-meetings-4be2d304-f675-4b57-8347-cbd000a21260): Teams does not save captions, spoken language is a setting of the meeting, and an admin can disable captions.
* [Bot Framework SDK overview](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-overview-introduction): support for the older bot library ended on 31 December 2025, which is why the code uses the Teams SDK.
* [Teams app manifest schema, version 1.25](https://developer.microsoft.com/json-schemas/teams/v1.25/MicrosoftTeams.schema.json): the schema the manifest was checked against.

Microsoft, Azure Communication Services

* [Closed captions with Teams interoperability](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/enable-closed-captions): an outside participant can turn on Teams captions, and the consent and notice duties when captions are stored.
* [Closed captions overview](https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/closed-captions): captions are shown only to the participant who enabled them.
* [Teams interoperability pricing](https://learn.microsoft.com/en-us/azure/communication-services/concepts/pricing/teams-interop-pricing): $0.004 a minute for a participant who joins through the service, lobby time included.
* [Retirement and breaking changes guide](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide): the 2028 retirement, what continues for Teams scenarios, and the limits on new customers.
* [Raw media access quickstart](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/voice-video-calling/get-started-raw-media-access): sending the assistant's own audio into a call.
* [Calling SDK features](https://learn.microsoft.com/en-us/azure/communication-services/concepts/voice-video-calling/calling-sdk-features): supported browsers and operating systems.
* [Teams administration for external users](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/guest/teams-administration): the Teams settings that let the assistant join.
* [The calling library on npm](https://npmjs.com/package/@azure/communication-calling): versions and publication dates.

Microsoft, prices

* [Azure retail prices feed](https://prices.azure.com/api/retail/prices): UK South rates for Container Apps, the registry, the Windows machine and Azure Speech, and the closed captions meter at $0.021 a minute.
* [Azure Speech pricing](https://azure.microsoft.com/en-gb/pricing/details/cognitive-services/speech-services/): the page for the voice and speech to text rates. The figures used here were read from the feed above.
* [Azure Communication Services pricing](https://azure.microsoft.com/en-gb/pricing/details/communication-services/): lists closed captions as a charge per minute.

Other vendors

* [ElevenLabs guide to its Teams media bot](https://elevenlabs.io/docs/eleven-agents/phone-numbers/microsoft-teams/graph-media-bot): its Teams route runs on the Windows media bot.
* [Recall.ai pricing](https://www.recall.ai/pricing): the meeting bot service used as the fallback comparison.

Blogs, forums and other reporting

* Microsoft 365 Copilot prices: [Microsoft's Copilot blog](https://techcommunity.microsoft.com/t5/microsoft-365-copilot-blog/act-now-lock-in-current-pricing-on-microsoft-365-copilot/ba-p/4502628) for Copilot Business at $21, and [Redress Compliance](https://redresscompliance.com/microsoft-365-copilot-pricing-2026) for the $30 list price. Some sources also report an $18 promotional price for Copilot Business.
* ElevenLabs agent price per minute: [HappyRobot](https://www.happyrobot.ai/hub/elevenlabs-pricing) and [CloudZero](https://www.cloudzero.com/blog/elevenlabs-pricing/).
* Whether other participants are notified when someone turns on captions: [an answer on Microsoft's Q&A forum](https://learn.microsoft.com/en-us/answers/questions/5792696/caption-query).
* Reporting on the retirement: [Microsoft 365 for IT Pros](https://office365itpros.com/2026/09/29/acs-retirement-sept-2028/).
