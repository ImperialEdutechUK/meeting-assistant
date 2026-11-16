// Writes one setting into .env without printing it.
// The value is read from the environment variable SET_ENV_VALUE, never from the command line,
// so it does not appear in the terminal, in shell history or in process listings.
// Usage: SET_ENV_VALUE=... node scripts/set-env.mjs NAME

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const name = process.argv[2];
const value = process.env.SET_ENV_VALUE;
if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
  console.error('Usage: node scripts/set-env.mjs NAME (value in SET_ENV_VALUE)');
  process.exit(2);
}
if (!value || /[\r\n]/.test(value)) {
  console.error(`${name}: no value received, or the value spans several lines. .env not changed.`);
  process.exit(1);
}

const file = '.env';
let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
const line = new RegExp(`^${name}=.*$`, 'm');
text = line.test(text) ? text.replace(line, () => `${name}=${value}`) : `${text.replace(/\n?$/, '\n')}${name}=${value}\n`;
writeFileSync(file, text);
console.log(`${name} written to .env (${value.length} characters).`);
