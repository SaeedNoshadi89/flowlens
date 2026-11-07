import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(REPO, 'fixtures');
export const CLI = path.join(REPO, 'src', 'cli', 'main.ts');

/** Fake values planted in fixtures and temp copies; none may ever reach a graph or report. */
export const SECRETS = [
  'fixture-secret-must-not-leak',
  'fixture-password',
  'fixture-credential-must-not-leak',
  'fixture-private-key-must-not-leak',
  'outside-root-secret',
];

/**
 * Copy a fixture into a temp folder that looks like a real checkout: a .git folder,
 * plus files every scan must skip (dependencies, gitignored output, a symlink that
 * leaves the root, a binary file). These are created here because git would not keep them.
 */
export function workspace(fixture: string): { root: string; outside: string; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowlens-test-')));
  const root = path.join(base, fixture);
  cpSync(path.join(FIXTURES, fixture), root, { recursive: true });
  rmSync(path.join(root, '.flowlens'), { recursive: true, force: true });
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'node_modules', 'leaky'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'leaky', 'index.js'), "export function leaky() { return fetch('/api/from-node-modules'); }\n");
  mkdirSync(path.join(root, 'generated'), { recursive: true });
  writeFileSync(path.join(root, 'generated', 'ignored.ts'), "export const g = () => fetch('/api/generated-should-be-ignored');\n");
  writeFileSync(path.join(root, '.gitignore'), 'generated/\n', { flag: 'a' });
  const outside = path.join(base, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.ts'), "export const k = 'outside-root-secret'; export function o() { return fetch('/api/outside'); }\n");
  symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'linked-outside.ts'));
  symlinkSync(outside, path.join(root, 'linked-dir'));
  writeFileSync(path.join(root, 'blob.ts'), Buffer.from([0x65, 0x78, 0x00, 0x01, 0x02, 0x03]));
  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
