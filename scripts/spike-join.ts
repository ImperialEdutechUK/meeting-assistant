// Day one spike: proves the risky part against your real tenant before anything else is built on
// it. It joins a real Teams meeting through Azure Communication Services, prints the live
// captions, and answers "Hey Claude ..." aloud.
//
// Needs:  ACS_CONNECTION_STRING   from the Communication Services resource
//         MEETING_URL             a Teams meeting link from your tenant
// Useful: SPEECH_KEY, SPEECH_REGION   for real speech instead of tones
//         ANTHROPIC_API_KEY           for real answers instead of an echo
//         HEADLESS=false              to watch the browser
//
//   MEETING_URL="https://teams.microsoft.com/l/meetup-join/..." npm run spike
//
// What to check while it runs is listed in docs/SETUP.md under "Day one spike".

import { requireEnv, startHarness } from './lib/harness.js';

const meetingUrl = requireEnv('MEETING_URL');
requireEnv('ACS_CONNECTION_STRING');

const harness = await startHarness({ transport: 'acs', headless: (process.env.HEADLESS ?? 'true') !== 'false' });
console.log(`Claude answers: ${harness.usingRealClaude ? 'real Claude API' : 'echo stand in'}`);
console.log(`Speech: ${harness.usingRealSpeech ? 'Azure Speech' : 'tones'}`);

const replies = await harness.service.handleChat({
  text: meetingUrl,
  user: { aadObjectId: 'spike-user', name: process.env.SPIKE_USER_NAME || 'the developer' },
  tenantId: process.env.TENANT_ID || 'local',
  conversationId: 'a:spike',
  conversationType: 'personal',
});
console.log(`[bot reply] ${replies.join('\n')}`);
console.log('Admit the assistant from the lobby, talk, then say "Hey Claude, what did I just say?".');
console.log('Press Ctrl+C or remove the assistant from the meeting to finish.\n');

let stopping = false;
process.on('SIGINT', async () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('\nAsking the assistant to leave ...');
  await harness.service.handleChat({ text: 'leave', user: { aadObjectId: 'spike-user', name: 'the developer' }, tenantId: process.env.TENANT_ID || 'local', conversationId: 'a:spike', conversationType: 'personal' });
});

const result = await harness.worker();
console.log(`\nWorker finished: ${result?.outcome} (${result?.reason})`);
const meetingId = result?.meetingId ?? '';
for (let i = 0; i < 100 && !(await harness.store.getRecap(meetingId)) && (await harness.store.getMeeting(meetingId))?.status !== 'failed'; i++) {
  await new Promise((r) => setTimeout(r, 200));
}
const segments = await harness.store.getSegments(meetingId);
console.log(`\nCaptured ${segments.length} transcript passages.`);
for (const s of segments) console.log(`${s.kind === 'assistant' ? '(assistant) ' : ''}${s.speakerName}: ${s.text}`);
await harness.stop();
process.exit(0);
