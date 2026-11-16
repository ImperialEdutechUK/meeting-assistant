// Prints the monthly cost estimate from the price table in src/core/pricing.ts.
// Every assumption is a named constant below, so the estimate can be rerun with your own figures.
//
//   npx tsx scripts/cost-model.ts 3000 5000 10000

import { DEFAULT_PRICES, type LlmUsage, ZERO_USAGE, llmCost, ttsCost } from '../src/core/pricing.js';

// ---- Assumptions about how the assistant is used ---------------------------------------------
const AVERAGE_MEETING_MINUTES = 45;
const VOICE_QUESTIONS_PER_MEETING_HOUR = 6;
const CHAT_QUESTIONS_PER_MEETING = 2; // asked in the meeting chat, answered by the live model
const HISTORY_QUESTIONS_PER_MEETING = 1; // asked later in a personal chat, answered with tools
const SPOKEN_ANSWER_CHARACTERS = 350;
const ANNOUNCEMENT_CHARACTERS = 210;
// Captions of normal speech: about 140 words a minute, 1.33 tokens a word, plus a quarter for names and times.
const TRANSCRIPT_TOKENS_PER_MINUTE = 140 * 1.33 * 1.25;
const SYSTEM_PROMPT_TOKENS = 450;
const KNOWLEDGE_TOKENS_PER_QUESTION = 5 * 450;
const ANSWER_OUTPUT_TOKENS = 110;
const RECAP_OUTPUT_TOKENS = 900;
const RECAP_OVERHEAD_TOKENS = 700;
const HISTORY_ROUNDS = 3;
const HISTORY_INPUT_TOKENS_PER_ROUND = 6000;
const HISTORY_OUTPUT_TOKENS = 600;

// ---- Fixed monthly costs (UK South list prices, US dollars) ----------------------------------
const SECONDS_PER_MONTH = 730 * 3600;
const CONTROL_VCPU = 0.25;
const CONTROL_GIB = 0.5;
const VCPU_ACTIVE = 0.000034;
const VCPU_IDLE = 0.000004;
const GIB_SECOND = 0.000004;
const controlIdle = SECONDS_PER_MONTH * (CONTROL_VCPU * VCPU_IDLE + CONTROL_GIB * GIB_SECOND);
const controlActive = SECONDS_PER_MONTH * (CONTROL_VCPU * VCPU_ACTIVE + CONTROL_GIB * GIB_SECOND);
const REGISTRY = 0.1666 * 30.42; // Basic registry, per day
const STORAGE_AND_LOGS = 1; // allowance: a few hundred megabytes of tables, blobs and logs

const p = DEFAULT_PRICES;
const usage = (u: Partial<LlmUsage>): LlmUsage => ({ ...ZERO_USAGE, ...u });

function perMeeting() {
  const transcriptAtEnd = TRANSCRIPT_TOKENS_PER_MINUTE * AVERAGE_MEETING_MINUTES;
  const transcriptMidway = transcriptAtEnd / 2;
  const liveInput = transcriptMidway + SYSTEM_PROMPT_TOKENS + KNOWLEDGE_TOKENS_PER_QUESTION;
  const liveQuestion = llmCost('claude-haiku-5-5', usage({ inputTokens: liveInput, outputTokens: ANSWER_OUTPUT_TOKENS }), p);
  const voiceQuestions = (VOICE_QUESTIONS_PER_MEETING_HOUR * AVERAGE_MEETING_MINUTES) / 60;
  const history = llmCost('claude-sonnet-5-5', usage({ inputTokens: HISTORY_ROUNDS * HISTORY_INPUT_TOKENS_PER_ROUND, outputTokens: HISTORY_OUTPUT_TOKENS }), p);
  const recap = llmCost('claude-sonnet-5-5', usage({ inputTokens: transcriptAtEnd + RECAP_OVERHEAD_TOKENS, outputTokens: RECAP_OUTPUT_TOKENS }), p);
  const claude = voiceQuestions * liveQuestion + CHAT_QUESTIONS_PER_MEETING * liveQuestion + HISTORY_QUESTIONS_PER_MEETING * history + recap;
  const speech = ttsCost(ANNOUNCEMENT_CHARACTERS + voiceQuestions * SPOKEN_ANSWER_CHARACTERS, p);
  return { liveQuestion, voiceQuestions, history, recap, claude, speech, liveInput, transcriptAtEnd };
}

const m = perMeeting();
const perMinute = {
  calling: p.callingPerMinute,
  worker: p.workerPerMinute,
  speech: m.speech / AVERAGE_MEETING_MINUTES,
  claude: m.claude / AVERAGE_MEETING_MINUTES,
  captions: p.captionsPerMinute,
};
const usd = (n: number, digits = 2) => `$${n.toFixed(digits)}`;

console.log('Per meeting (45 minutes)');
console.log(`  transcript at the end: ${Math.round(m.transcriptAtEnd)} tokens, live question input: ${Math.round(m.liveInput)} tokens`);
console.log(`  one live question on Haiku 5.5: ${usd(m.liveQuestion, 6)}   voice questions per meeting: ${m.voiceQuestions}`);
console.log(`  one history question on Sonnet 5.5: ${usd(m.history, 4)}   recap on Sonnet 5.5: ${usd(m.recap, 4)}`);
console.log(`  Claude total: ${usd(m.claude, 4)}   speech: ${usd(m.speech, 4)}`);
console.log('\nPer meeting minute');
for (const [k, v] of Object.entries(perMinute)) console.log(`  ${k.padEnd(9)} ${usd(v, 6)}`);
const lowPerMinute = perMinute.calling + perMinute.worker + perMinute.speech + perMinute.claude;
const highPerMinute = lowPerMinute + perMinute.captions;
console.log(`  low case total  ${usd(lowPerMinute, 6)}   high case total ${usd(highPerMinute, 6)}`);
console.log('\nFixed per month');
console.log(`  control service: ${usd(controlIdle)} at the idle rate, ${usd(controlActive)} at the active rate`);
console.log(`  registry: ${usd(REGISTRY)}   storage and logs allowance: ${usd(STORAGE_AND_LOGS)}`);
const fixedLow = controlIdle + REGISTRY + STORAGE_AND_LOGS;
const fixedHigh = controlActive + REGISTRY + STORAGE_AND_LOGS;
console.log(`  low case fixed ${usd(fixedLow)}   high case fixed ${usd(fixedHigh)}`);

const volumes = process.argv.slice(2).map(Number).filter((n) => n > 0);
console.log('\nMinutes  | calling | worker | speech | Claude | captions (high only) | LOW total | HIGH total');
for (const minutes of volumes.length > 0 ? volumes : [3000, 5000, 10000]) {
  const row = [
    String(minutes).padEnd(8),
    usd(minutes * perMinute.calling),
    usd(minutes * perMinute.worker),
    usd(minutes * perMinute.speech),
    usd(minutes * perMinute.claude),
    usd(minutes * perMinute.captions),
    usd(minutes * lowPerMinute + fixedLow),
    usd(minutes * highPerMinute + fixedHigh),
  ];
  console.log(row.join(' | '));
}
