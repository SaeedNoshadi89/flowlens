/**
 * Build the single-file engine (dist/) and copy it into both host packages.
 * The engine bundle is the same bytes in every package: one analyzer and renderer.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/cli/main.ts')],
  outfile: path.join(dist, 'flowlens.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'eof',
  logLevel: 'warning',
});
cpSync(path.join(root, 'src/analyze/python/pyfacts.py'), path.join(dist, 'pyfacts.py'));
cpSync(path.join(root, 'src/render/assets'), path.join(dist, 'assets'), { recursive: true });
writeFileSync(path.join(dist, 'VERSION'), pkg.version + '\n');

for (const host of ['claude', 'codex']) {
  const engine = path.join(root, 'plugins', host, 'flowlens', 'engine');
  rmSync(engine, { recursive: true, force: true });
  cpSync(dist, engine, { recursive: true });
}
process.stdout.write(`built dist/flowlens.mjs ${pkg.version} and copied it into plugins/claude and plugins/codex\n`);
