import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isSecretName, walk } from '../src/scan/walker.ts';
import { resolveRoot } from '../src/scan/root.ts';
import { combinePresets, resolvePresets } from '../src/config/presets.ts';
import { workspace } from './helpers.ts';

test('walker skips dependencies, ignored, secret, binary and outside-root files', (t) => {
  const ws = workspace('shop-app');
  t.after(ws.cleanup);
  const r = walk({ root: ws.root, include: [], exclude: [] });
  const files = r.files.map((f) => f.rel);
  assert.ok(files.includes('web/src/api/client.ts'));
  assert.ok(files.includes('api/app/main.py'));
  for (const bad of ['node_modules/leaky/index.js', 'generated/ignored.ts', 'linked-outside.ts', 'blob.ts', '.env', 'config/credentials.json']) {
    assert.ok(!files.includes(bad), `${bad} must be skipped`);
  }
  assert.ok(!files.some((f) => f.startsWith('linked-dir/')));
  assert.ok(r.skipped['secret-like-file'] >= 2);
  assert.ok(r.skipped['symlink-outside-root'] >= 2);
  assert.ok(r.skipped['default-excluded-directory'] >= 1);
  assert.ok(r.skipped['ignored-by-ignore-file'] >= 1);
  assert.ok(r.skipped['binary'] >= 1);
});

test('walker honors include scope and explicit excludes', (t) => {
  const ws = workspace('shop-app');
  t.after(ws.cleanup);
  const r = walk({ root: ws.root, include: ['api'], exclude: ['**/inventory.py'] });
  const files = r.files.map((f) => f.rel);
  assert.ok(files.length > 0 && files.every((f) => f.startsWith('api/')));
  assert.ok(!files.includes('api/app/routes/inventory.py'));
  assert.equal(r.skipped['excluded-by-option'], 1);
});

test('.flowlensignore is honored', (t) => {
  const ws = workspace('agent-desk');
  t.after(ws.cleanup);
  const files = walk({ root: ws.root, include: [], exclude: [] }).files.map((f) => f.rel);
  assert.ok(!files.some((f) => f.startsWith('experiments/')));
  assert.ok(!files.includes('secrets/service-account.json'));
});

test('secret-like names are recognized', () => {
  for (const n of ['.env', '.env.local', '.env.example', 'id_rsa', 'server.pem', 'credentials.json', 'secrets.yaml', 'service-account-prod.json', 'prod.tfvars', '.npmrc']) {
    assert.ok(isSecretName(n), n);
  }
  for (const n of ['client.ts', 'environment.ts', 'secretary.py', 'tokenizer.py']) assert.ok(!isSecretName(n), n);
});

test('root resolution walks up from a nested monorepo folder and accepts an override', (t) => {
  const ws = workspace('shop-app');
  t.after(ws.cleanup);
  const nested = path.join(ws.root, 'web', 'src', 'pages');
  const r = resolveRoot(nested);
  assert.equal(r.root, ws.root);
  assert.equal(r.method, 'git');
  assert.equal(r.cwdRelative, 'web/src/pages');
  const o = resolveRoot(nested, '../..');
  assert.equal(o.root, path.join(ws.root, 'web'));
  assert.equal(o.method, 'explicit');
  mkdirSync(path.join(ws.root, 'empty'));
  assert.throws(() => resolveRoot(ws.root, 'does-not-exist'));
});

test('presets resolve to folders with reasons and combine', (t) => {
  const ws = workspace('shop-app');
  t.after(ws.cleanup);
  const p = resolvePresets(ws.root, 'web/src');
  assert.deepEqual(p.backend.paths, ['api']);
  assert.deepEqual(p.frontend.paths, ['web']);
  assert.deepEqual(p.agents.paths, []);
  assert.ok(p.agents.note);
  assert.deepEqual(p.here.paths, ['web/src']);
  assert.deepEqual(combinePresets(['backend', 'frontend'], p), ['api', 'web']);
  assert.deepEqual(combinePresets(['frontend', 'here'], p), ['web']);
  assert.deepEqual(combinePresets(['whole', 'backend'], p), []);
  const ws2 = workspace('agent-desk');
  t.after(ws2.cleanup);
  const a = resolvePresets(ws2.root);
  assert.deepEqual(a.agents.paths, ['desk']);
  assert.deepEqual(a.frontend.paths, []);
});
