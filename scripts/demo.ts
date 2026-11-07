/** Regenerate the committed demo reports in examples/ from the two fixtures (fixed timestamp). */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const fx of ['shop-app', 'agent-desk']) {
  const r = spawnSync(process.execPath, [path.join(root, 'src/cli/main.ts'), 'scan', '--root', path.join(root, 'fixtures', fx), '--out', path.join(root, 'examples', fx), '--no-saved', '--now', '2026-11-07T12:00:00.000Z', '--quiet'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  process.stdout.write(r.stdout);
}
