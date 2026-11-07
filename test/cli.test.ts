import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CLI, REPO, SECRETS, workspace } from './helpers.ts';

/** Run the CLI from source; FLOWLENS_CLI=dist runs the bundled engine instead. */
function cli(cwd: string, ...args: string[]) {
  const entry = process.env.FLOWLENS_CLI === 'dist' ? path.join(REPO, 'dist', 'flowlens.mjs') : CLI;
  const r = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BROWSER: 'none' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('end to end: scoped scan from a nested folder, saved settings, regenerate', (t) => {
  const ws = workspace('shop-app');
  t.after(ws.cleanup);
  const nested = path.join(ws.root, 'web', 'src');

  const roots = JSON.parse(cli(nested, 'root', '--json').out);
  assert.equal(roots.root, ws.root);
  assert.equal(roots.cwdRelative, 'web/src');

  const presets = JSON.parse(cli(nested, 'presets', '--json').out);
  assert.deepEqual(presets.presets.backend.paths, ['api']);
  assert.deepEqual(presets.presets.here.paths, ['web/src']);

  const first = cli(nested, 'scan', '--preset', 'backend', '--relations', 'api,data', '--save');
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, new RegExp(`Root: ${ws.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(found via \\.git\\); you are in web/src/`));
  assert.match(first.out, /Scope: api/);
  const html = path.join(ws.root, '.flowlens', 'flowmap.html');
  const graphFile = path.join(ws.root, '.flowlens', 'graph.json');
  assert.ok(first.out.includes(`Map:   ${html}`));
  const cfg = JSON.parse(readFileSync(path.join(ws.root, '.flowlens', 'config.json'), 'utf8'));
  assert.deepEqual(cfg.include, ['api']);
  assert.deepEqual(cfg.relations, ['api', 'data']);
  assert.deepEqual(cfg.presets, ['backend']);
  assert.match(readFileSync(path.join(ws.root, '.flowlens', '.gitignore'), 'utf8'), /!config.json/);
  const g1 = JSON.parse(readFileSync(graphFile, 'utf8'));
  assert.deepEqual(g1.scope.include, ['api']);
  assert.ok(g1.nodes.every((n: { path?: string }) => !n.path || n.path.startsWith('api/')));
  assert.equal(g1.scope.topLevel.find((x: { path: string }) => x.path === 'web').scanned, false);

  // regenerate repeats the saved scope even from another folder.
  const again = cli(path.join(ws.root, 'api'), 'regenerate', '--json');
  assert.equal(again.code, 0, again.err);
  const summary = JSON.parse(again.out);
  assert.equal(summary.html, html);
  const g2 = JSON.parse(readFileSync(graphFile, 'utf8'));
  assert.deepEqual(g2.scope.include, ['api']);
  assert.deepEqual(g2.scope.relations, ['api', 'data']);

  // Explicit options override saved settings for one run without saving.
  const whole = cli(ws.root, 'scan', '--preset', 'whole', '--json');
  assert.equal(JSON.parse(whole.out).settingsFile, null);
  const g3 = JSON.parse(readFileSync(graphFile, 'utf8'));
  assert.deepEqual(g3.scope.include, []);
  assert.deepEqual(g3.scope.relations, ['api', 'data'], 'relations still come from saved settings');
  assert.deepEqual(JSON.parse(readFileSync(path.join(ws.root, '.flowlens', 'config.json'), 'utf8')).include, ['api']);

  const text = readFileSync(html, 'utf8') + readFileSync(graphFile, 'utf8');
  for (const s of SECRETS) assert.ok(!text.includes(s), `leaked ${s}`);
});

test('end to end: include, exclude, out folder, validate and render', (t) => {
  const ws = workspace('agent-desk');
  t.after(ws.cleanup);
  const out = path.join(ws.root, '..', 'report');
  const r = cli(ws.root, 'scan', '--include', 'desk', '--exclude', 'desk/sdk_agents.py', '--relations', 'agents', '--out', out, '--quiet');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split('\n'), [path.join(out, 'flowmap.html'), path.join(out, 'graph.json')]);
  const g = JSON.parse(readFileSync(path.join(out, 'graph.json'), 'utf8'));
  assert.ok(!g.nodes.some((n: { path?: string }) => n.path === 'desk/sdk_agents.py'));
  assert.ok(g.edges.some((e: { kind: string }) => e.kind === 'handoff'));
  assert.ok(!g.edges.some((e: { relation: string }) => e.relation === 'data' || e.relation === 'deps'));
  // Evidence links point back into the repository relative to the report.
  assert.match(readFileSync(path.join(out, 'flowmap.html'), 'utf8'), /"sourceBase":"..\/agent-desk\/"/);
  assert.equal(cli(ws.root, 'validate', path.join(out, 'graph.json')).code, 0);
  const rendered = cli(ws.root, 'render', path.join(out, 'graph.json'), '--out', path.join(out, 'again.html'));
  assert.equal(rendered.code, 0, rendered.err);
  assert.ok(existsSync(path.join(out, 'again.html')));
  assert.ok(!existsSync(path.join(ws.root, '.flowlens', 'config.json')), 'nothing saved without --save');
});

test('CLI rejects bad input with a clear message', (t) => {
  const ws = workspace('agent-desk');
  t.after(ws.cleanup);
  assert.match(cli(ws.root, 'scan', '--preset', 'nope').err, /unknown preset "nope"/);
  assert.match(cli(ws.root, 'scan', '--relations', 'telepathy').err, /unknown relation/);
  assert.match(cli(ws.root, 'scan', '--include', '../outside').err, /inside the root/);
  assert.match(cli(ws.root, 'scan', '--preset', 'backend').err, /matched no folders/);
  assert.match(cli(ws.root, 'frobnicate').err, /unknown command/);
  assert.match(cli(ws.root, 'open').err, /run "flowlens scan" first/);
  assert.match(cli(ws.root, '--help').out, /Usage: flowlens/);
  assert.match(cli(ws.root, 'setup').err, /interactive/);
});
