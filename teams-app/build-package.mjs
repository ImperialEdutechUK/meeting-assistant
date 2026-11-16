// Builds the Teams app package (a zip of manifest.json and two icons) from the template and
// teams-app/app.config.json. Upload the result in the Teams admin centre.
//
//   npm run teams:package

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message) {
  console.error(`Cannot build the Teams package: ${message}`);
  process.exit(2);
}

let config;
try {
  config = JSON.parse(await readFile(join(here, 'app.config.json'), 'utf8'));
} catch {
  fail('teams-app/app.config.json is missing. Copy app.config.example.json to app.config.json and fill it in.');
}

for (const key of ['version', 'teamsAppId', 'botClientId', 'developerName', 'websiteUrl', 'privacyUrl', 'termsOfUseUrl', 'shortName', 'fullName']) {
  if (typeof config[key] !== 'string' || !config[key].trim()) fail(`"${key}" is missing in app.config.json.`);
}
if (!GUID.test(config.teamsAppId)) fail('"teamsAppId" must be a GUID. Generate one with: node -e "console.log(crypto.randomUUID())"');
if (!GUID.test(config.botClientId)) fail('"botClientId" must be the client id (a GUID) of the bot app registration.');
for (const key of ['websiteUrl', 'privacyUrl', 'termsOfUseUrl']) {
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(config[key]) || /YOUR-COMPANY/.test(config[key])) fail(`"${key}" must be a real https address.`);
}
if (!/^\d+\.\d+\.\d+$/.test(config.version)) fail('"version" must look like 1.0.0. Increase it every time you upload an update.');
if (config.shortName.length > 30) fail('"shortName" may be at most 30 characters.');
if (config.fullName.length > 100) fail('"fullName" may be at most 100 characters.');

let manifest = await readFile(join(here, 'manifest.template.json'), 'utf8');
manifest = manifest.replace(/\{\{(\w+)\}\}/g, (_, key) => {
  if (!(key in config)) fail(`The template uses "${key}", which is not in app.config.json.`);
  return JSON.stringify(String(config[key])).slice(1, -1);
});
JSON.parse(manifest); // Fails loudly if the substitution broke the JSON.

// A minimal zip writer, so the package needs no extra dependency and builds the same on every platform.
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF 8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(0x21, 12); // date: 1 January 1980
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBytes, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

const out = join(here, 'build');
await mkdir(out, { recursive: true });
const archive = zip([
  { name: 'manifest.json', data: Buffer.from(manifest, 'utf8') },
  { name: 'color.png', data: await readFile(join(here, 'color.png')) },
  { name: 'outline.png', data: await readFile(join(here, 'outline.png')) },
]);
const target = join(out, 'claude-meeting-assistant.zip');
await writeFile(target, archive);
await writeFile(join(out, 'manifest.json'), manifest);
console.log(`Teams app package written to ${target}`);
