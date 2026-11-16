// Builds the company knowledge base from a folder of documents and uploads it to storage.
// Supported files: .md, .txt, .csv, .html and .docx. Export PDFs to text or Word first.
//
//   npm run kb:ingest -- ./knowledge
//   npm run kb:ingest -- ./knowledge --dry-run --test "what is the refund policy"

import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { KnowledgeBase, chunkDocument } from '../src/core/kb.js';
import { AzureStore } from '../src/core/store-azure.js';
import { estimateTokens } from '../src/core/transcript.js';
import type { KbChunk } from '../src/core/types.js';

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const testAt = args.indexOf('--test');
const testQuery = testAt >= 0 ? args[testAt + 1] : undefined;
if (!folder) {
  console.error('Usage: npm run kb:ingest -- <folder> [--dry-run] [--test "question"]');
  process.exit(2);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const name of (await readdir(dir)).sort()) {
    if (name.startsWith('.') || name.startsWith('~$')) continue;
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) yield* walk(path);
    else yield path;
  }
}

async function readText(path: string): Promise<string | null> {
  const ext = extname(path).toLowerCase();
  if (['.md', '.txt', '.csv'].includes(ext)) return readFile(path, 'utf8');
  if (ext === '.html' || ext === '.htm') {
    const html = await readFile(path, 'utf8');
    return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ path })).value;
  }
  return null;
}

const chunks: KbChunk[] = [];
let files = 0;
const skipped: string[] = [];
for await (const path of walk(folder)) {
  const text = await readText(path);
  const source = relative(folder, path);
  if (text === null) {
    skipped.push(source);
    continue;
  }
  const title = basename(path, extname(path)).replace(/[_]+/g, ' ').trim();
  const parts = chunkDocument(title, source, text);
  chunks.push(...parts);
  files++;
  console.log(`${String(parts.length).padStart(4)} passages  ${source}`);
}

const tokens = chunks.reduce((n, c) => n + estimateTokens(c.text), 0);
console.log(`\n${files} files, ${chunks.length} passages, about ${tokens.toLocaleString('en-GB')} tokens.`);
if (skipped.length > 0) console.log(`Skipped (unsupported type): ${skipped.join(', ')}`);

if (testQuery) {
  console.log(`\nTop passages for: ${testQuery}`);
  for (const hit of new KnowledgeBase(chunks).search(testQuery, 3)) console.log(`* [${hit.docTitle}] ${hit.text.slice(0, 200).replace(/\s+/g, ' ')} ...`);
}

if (dryRun) {
  console.log('\nDry run: nothing was uploaded.');
} else {
  const connectionString = process.env.STORAGE_CONNECTION_STRING;
  const accountName = process.env.STORAGE_ACCOUNT_NAME;
  if (!connectionString && !accountName) {
    console.error('\nSet STORAGE_CONNECTION_STRING or STORAGE_ACCOUNT_NAME to upload, or pass --dry-run.');
    process.exit(2);
  }
  const store = new AzureStore(connectionString ? { connectionString } : { accountName });
  await store.ensureContainer();
  await store.saveKb(chunks);
  console.log('\nUploaded. The control service picks up the new knowledge base within five minutes.');
}
