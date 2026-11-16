// Bundles the browser side of the worker (including the calling SDK) into dist/page.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'dist', 'page');
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(here, 'page', 'page.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outfile: join(out, 'page.js'),
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
await copyFile(join(here, 'page', 'index.html'), join(out, 'index.html'));
console.log(`Page bundle written to ${out}`);
