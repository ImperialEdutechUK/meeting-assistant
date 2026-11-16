// Deletes meetings older than the retention period. The control service does this by itself
// every six hours, so this script is only for running a purge by hand.
//
//   RETENTION_DAYS=90 npm run purge

import { AzureStore } from '../src/core/store-azure.js';

const days = Number(process.env.RETENTION_DAYS ?? 90);
const connectionString = process.env.STORAGE_CONNECTION_STRING;
const accountName = process.env.STORAGE_ACCOUNT_NAME;
if (!connectionString && !accountName) {
  console.error('Set STORAGE_CONNECTION_STRING or STORAGE_ACCOUNT_NAME.');
  process.exit(2);
}
const store = new AzureStore(connectionString ? { connectionString } : { accountName });
await store.init();
const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
const old = (await store.listMeetingsCreatedBefore(cutoff)).filter((m) => m.status === 'ended' || m.status === 'failed');
for (const meeting of old) {
  await store.deleteMeeting(meeting.id);
  console.log(`Deleted ${meeting.id}  ${meeting.createdAt}  ${meeting.title}`);
}
console.log(`${old.length} meetings older than ${days} days were deleted.`);
