// Reports which settings are present, for each stage, without ever printing a value.
// Run with: npm run check:env

const STAGES = {
  'Local demo with real answers and voice': ['ANTHROPIC_API_KEY', 'SPEECH_KEY', 'SPEECH_REGION'],
  'Day one spike against a real meeting': ['ACS_CONNECTION_STRING', 'MEETING_URL'],
  'Teams chat (bot)': ['TENANT_ID', 'CLIENT_ID', 'CLIENT_SECRET'],
  'Control service': ['WORKER_SHARED_SECRET'],
};

for (const [stage, names] of Object.entries(STAGES)) {
  console.log(stage);
  for (const name of names) {
    const value = process.env[name];
    console.log(`  ${name.padEnd(24)} ${value ? 'set' : 'missing'}`);
  }
}
const shared = process.env.WORKER_SHARED_SECRET;
if (shared && shared.length < 24) console.log('\nWORKER_SHARED_SECRET is too short: it must be at least 24 characters.');
const claude = process.env.ANTHROPIC_API_KEY;
if (claude && !claude.startsWith('sk-ant-')) console.log('\nANTHROPIC_API_KEY does not start with sk-ant-: check it was copied whole.');
