# Cost notes

All figures are list prices in US dollars, checked on 13 November 2026. Prices change, so recheck them before budgeting. The arithmetic is in `scripts/cost-model.ts` and can be rerun with your own assumptions:

```
npx tsx scripts/cost-model.ts 3000 5000 10000
```

## Prices used

| Item | Price | Source |
| --- | --- | --- |
| Claude Haiku 5.5 | $0.10 per million input tokens, $0.50 per million output tokens, for prompts up to 100,000 tokens. Five times that above 100,000 | https://platform.claude.com/docs/en/about-claude/pricing |
| Claude Sonnet 5.5 | $2 per million input tokens, $10 per million output tokens, cache reads $0.10 | https://platform.claude.com/docs/en/about-claude/pricing |
| Claude web search tool | $10 per 1,000 searches | https://platform.claude.com/docs/en/about-claude/pricing |
| Azure Communication Services calling, Teams interop | $0.004 per participant minute, lobby time included | https://learn.microsoft.com/en-us/azure/communication-services/concepts/pricing/teams-interop-pricing |
| Azure Communication Services closed captions meter | $0.021 per minute | Azure Retail Prices API, product "Closed Captions" |
| Azure Speech neural text to speech | $15 per million characters | Azure Retail Prices API, UK South |
| Azure Container Apps, UK South | $0.000034 per vCPU second active, $0.000004 idle, $0.000004 per GiB second | Azure Retail Prices API, UK South |
| Azure Container Registry, Basic | $0.1666 per day | Azure Retail Prices API, UK South |
| Azure Bot Service, Teams channel | Free | Azure Retail Prices API, "Standard Channel Messages" |

The Azure Retail Prices API is public: https://prices.azure.com/api/retail/prices

## Cost controls in this deployment

The templates were changed on 16 November 2026 so that nothing runs, or bills, around the clock except storage and the registry.

| Resource | Setting | Effect |
| --- | --- | --- |
| Control service | Scales to zero when idle (`minReplicas: 0`, at most 1) | Billed only while a chat or meeting is in progress. The first message after a quiet spell waits a few seconds for it to wake |
| Meeting worker | Container Apps job, started per meeting | Runs only during a meeting. Leaves when the meeting ends, when alone for 2 minutes, after 5 minutes in the lobby, or at the length limit |
| Meeting length | 120 minutes (`maxMeetingMinutes`) | Caps the longest a worker container can run |
| Meetings at once | 2 (`maxConcurrentMeetings`) | At most two worker containers at a time |
| Container Apps environment | Consumption only, no workload profiles | No fixed fee. The monthly free grant (180,000 vCPU seconds) covers about 3,000 meeting minutes of workers |
| Speech | F0 free tier (`speechSku`) | 0.5 million neural voice characters a month free. Past that, voice requests are refused rather than billed. Switch to S0 if the pilot needs more |
| Log Analytics | 30 day retention, 0.15 GB daily cap | Stays inside the free 5 GB a month. Logs beyond the cap are dropped until the next day |
| Container registry | Basic | About $5 a month, the one fixed charge. Delete old image tags to stay inside its 10 GB |
| App budget guard | $50 a month (`monthlyBudgetUsd`) | The assistant refuses new meetings once its own estimate passes this |
| Azure budget alert | `infra/budget.bicep`, 25 a month | Emails the resource group's Owners and Contributors at 50% and 80% of actual spend and at 100% of forecast. Alerts only, it stops nothing |
| Claude API | Spend limit on the Claude Console workspace | The hard stop for Claude spend. Set it in the Console |

With these settings the fixed monthly cost is about $5 to $6 (registry, storage), down from $14 to $34. Usage costs are unchanged per minute.

### Optional warm standby (off by default)

Without it, a join takes about 30 seconds before the assistant reaches the lobby, because Azure starts a fresh container for each meeting. With `standbyEnabled=true` in `infra/apps.bicep`, a worker starts at 07:00 UTC on weekdays with Chrome already open and takes meetings until 18:00 UK time, so joins in that window reach the lobby in a few seconds. Outside the window, or when the standby is already in a meeting, joins fall back to the normal on demand worker.

Cost: the standby runs at 1 vCPU and 2 GiB for the whole window, about $0.15 an hour, and its polling keeps the control service awake, about $0.04 an hour. For 11 hours a day on 22 working days that is roughly $35 to $45 a month, less whatever the Container Apps free grant still covers. Shorten the window with `standbyStartCron` and `standbyUntil` to pay less.

## The open question: are Teams captions billed?

The assistant listens through Teams live captions, which it receives through the Azure Communication Services calling SDK. Azure has a "Closed Captions" meter at $0.021 per minute. Microsoft's Teams interop pricing page lists only calling minutes and chat messages, and its captions pages state no price for captions that Teams generates. I could not confirm either way whether the meter applies here.

The estimate therefore gives a low case (not billed) and a high case (billed), and the budget guard in the software assumes the high case until you tell it otherwise. One test meeting and a look at Cost analysis two days later settles it.

## Estimate

Assumptions: meetings average 45 minutes, six spoken questions per meeting hour, two chat questions and one later history question per meeting, one recap per meeting, no prompt caching benefit counted.

| Meeting minutes a month | Low case | High case |
| --- | --- | --- |
| 3,000 | $40.55 | $123.26 |
| 5,000 | $58.29 | $183.00 |
| 10,000 | $102.63 | $332.34 |

Low case per minute: $0.0089. High case per minute: $0.0299. Fixed monthly cost: $13.95 (low) to $33.66 (high), mostly the always on control service and the registry.

## Lifecycle reference

Retirement and breaking changes guide for Azure Communication Services: https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide
