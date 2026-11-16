// Runs a complete scripted meeting on your own machine: join, captions, a spoken question, a
// spoken answer and the recap. Needs Chrome and nothing else. If ANTHROPIC_API_KEY is set the
// answers and the recap come from Claude, otherwise from a scripted stand in.
//
//   npm run demo

import type { FakeScriptStep } from '../src/core/types.js';
import { startHarness } from './lib/harness.js';

const alex = { id: 'aad-demo-1', aadObjectId: 'aad-demo-1', displayName: 'Alex Morgan', kind: 'teams' as const };
const jordan = { id: 'aad-demo-2', aadObjectId: 'aad-demo-2', displayName: 'Jordan', kind: 'teams' as const };
const say = (atMs: number, who: typeof alex, text: string, final = true): FakeScriptStep => ({
  atMs,
  type: 'caption',
  caption: { speakerId: who.id, speakerAadId: who.aadObjectId, speakerName: who.displayName, text, final },
});

const script: FakeScriptStep[] = [
  { atMs: 500, type: 'state', state: 'lobby' },
  { atMs: 1500, type: 'state', state: 'connected' },
  { atMs: 1600, type: 'participants', participants: [alex, jordan] },
  say(9000, alex, 'Jordan, the first batch of course pages goes to Marketing on Friday.'),
  say(13000, alex, 'Each page needs the course fee checked before it is published.'),
  say(17000, jordan, 'Understood. I will publish batch one on Monday and send you the links.'),
  say(21000, alex, 'Hey Claude what did', false),
  say(22000, alex, 'Hey Claude, what did I explain to Jordan?'),
  say(36000, jordan, 'Hey Claude, what is the refund policy?'),
  { atMs: 50000, type: 'end' },
];

const harness = await startHarness({ transport: 'fake', fakeScript: script });
console.log(`Claude answers: ${harness.usingRealClaude ? 'real Claude API' : 'scripted stand in (set ANTHROPIC_API_KEY for real answers)'}`);
console.log(`Speech: ${harness.usingRealSpeech ? 'Azure Speech' : 'tones (set SPEECH_KEY and SPEECH_REGION for real speech)'}`);
console.log('The scripted meeting takes about a minute.\n');

const user = { aadObjectId: alex.aadObjectId, name: alex.displayName };
const replies = await harness.service.handleChat({
  text: 'join https://teams.microsoft.com/l/meetup-join/19%3ameeting_demo%40thread.v2/0?context=%7b%7d',
  user,
  tenantId: process.env.TENANT_ID || 'local',
  conversationId: 'a:demo-personal-chat',
  conversationType: 'personal',
});
console.log(`[bot reply] ${replies.join('\n')}`);

const result = await harness.worker();
console.log(`\nWorker finished: ${result?.outcome} (${result?.reason})`);
const meetingId = result?.meetingId ?? '';
for (let i = 0; i < 100 && !(await harness.store.getRecap(meetingId)); i++) await new Promise((r) => setTimeout(r, 200));

console.log('\n=== Stored transcript ===');
for (const s of await harness.store.getSegments(meetingId)) console.log(`${s.kind === 'assistant' ? '(assistant) ' : ''}${s.speakerName}: ${s.text}`);
console.log('\n=== Estimated cost of this run (US dollars, list prices) ===');
for (const u of harness.store.usage) console.log(`${u.entry.kind.padEnd(8)} ${u.entry.usd.toFixed(5)}  ${u.entry.detail ?? ''}`);
await harness.stop();
process.exit(0);
