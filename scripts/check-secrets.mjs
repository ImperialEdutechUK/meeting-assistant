// Fails if any file git would commit looks like it contains a secret, or if a .env file is tracked.
// Runs as the pre-commit hook (install with: npm run check:secrets -- --install-hook) and by hand.

import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

if (process.argv.includes('--install-hook')) {
  const hook = '#!/bin/sh\nnode scripts/check-secrets.mjs || exit 1\n';
  writeFileSync('.git/hooks/pre-commit', hook);
  try { chmodSync('.git/hooks/pre-commit', 0o755); } catch { /* Windows */ }
  console.log('Installed the pre-commit secret check.');
  process.exit(0);
}

const PATTERNS = [
  ['Claude API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['Azure storage account key', /AccountKey=(?!Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq\/K1SZFPTOtr\/KBHBeksoGMGw==)[A-Za-z0-9+/=]{40,}/],
  ['Communication Services access key', /accesskey=[A-Za-z0-9+/=]{40,}/i],
  ['Shared access signature', /[?&]sig=[A-Za-z0-9%+/=]{20,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Entra client secret', /\b[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{31,34}\b/],
];

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const problems = [];
for (const file of files) {
  const base = file.split('/').pop() ?? file;
  if (/^\.env(\..+)?$/.test(base) && base !== '.env.example') problems.push(`${file}: environment file must not be committed`);
  if (/\.(png|zip|ico|jpg|jpeg|gif|woff2?)$/i.test(file) || file === 'package-lock.json') continue;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  for (const [label, pattern] of PATTERNS) {
    if (pattern.test(text)) problems.push(`${file}: looks like it contains a ${label}`);
  }
}

if (problems.length) {
  console.error('Secret check failed. Nothing was committed.\n' + problems.map((p) => `  ${p}`).join('\n'));
  console.error('Move the value into .env (local) or a Container Apps secret (Azure).');
  process.exit(1);
}
console.log(`Secret check passed (${files.length} files).`);
