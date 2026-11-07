/**
 * Checks both host packages: manifests and skills are well-formed, each package's
 * engine is byte-identical to dist/ (one engine), and each wrapper runs a scan.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems: string[] = [];
const check = (ok: unknown, msg: string) => { if (!ok) problems.push(msg); };

function files(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p, base) : [path.relative(base, p)];
  });
}
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const dist = path.join(root, 'dist');
const distFiles = files(dist).sort();

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const hosts = {
  claude: { manifest: '.claude-plugin/plugin.json', wrapper: 'bin/flowlens', skills: ['map', 'setup'] },
  codex: { manifest: 'plugin.json', wrapper: 'scripts/flowlens', skills: ['flowlens'] },
};
for (const [host, spec] of Object.entries(hosts)) {
  const dir = path.join(root, 'plugins', host, 'flowlens');
  const m = JSON.parse(readFileSync(path.join(dir, spec.manifest), 'utf8')) as { name: string; version: string; description: string };
  check(m.name === 'flowlens', `${host}: manifest name`);
  check(m.version === pkg.version, `${host}: manifest version ${m.version} != package ${pkg.version}`);
  check(m.description?.length > 40, `${host}: manifest description`);
  for (const s of spec.skills) {
    const text = readFileSync(path.join(dir, 'skills', s, 'SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    check(fm && new RegExp(`^name: ${s}$`, 'm').test(fm[1]) && /^description: .{40,}$/m.test(fm[1]), `${host}: skill ${s} frontmatter`);
  }
  const engine = path.join(dir, 'engine');
  const engineFiles = files(engine).sort();
  check(JSON.stringify(engineFiles) === JSON.stringify(distFiles), `${host}: engine file list differs from dist`);
  for (const f of distFiles) check(engineFiles.includes(f) && hash(path.join(engine, f)) === hash(path.join(dist, f)), `${host}: engine/${f} differs from dist (run npm run build)`);
  const wrapper = path.join(dir, spec.wrapper);
  try { accessSync(wrapper, constants.X_OK); } catch { problems.push(`${host}: ${spec.wrapper} is not executable`); }
  const v = spawnSync(wrapper, ['--version'], { encoding: 'utf8' });
  check(v.stdout.trim() === `flowlens ${pkg.version}`, `${host}: wrapper --version printed ${v.stdout.trim() || v.stderr.trim()}`);
  for (const fx of ['shop-app', 'agent-desk']) {
    const out = mkdtempSync(path.join(tmpdir(), `flowlens-${host}-`));
    const r = spawnSync(wrapper, ['scan', '--root', path.join(root, 'fixtures', fx), '--out', out, '--no-saved', '--json'], { encoding: 'utf8' });
    check(r.status === 0, `${host}: wrapper scan of ${fx} failed: ${r.stderr}`);
    if (r.status === 0) {
      const s = JSON.parse(r.stdout) as { summary: { scenarios: number; edges: number } };
      check(s.summary.scenarios >= 3 && s.summary.edges >= 20, `${host}: ${fx} summary too small`);
    }
    rmSync(out, { recursive: true, force: true });
  }
}
for (const [file, key] of [['.claude-plugin/marketplace.json', 'source'], ['.agents/plugins/marketplace.json', 'source']] as const) {
  const mk = JSON.parse(readFileSync(path.join(root, file), 'utf8')) as { plugins: Record<string, unknown>[] };
  const src = mk.plugins[0][key] as string | { path: string };
  const p = typeof src === 'string' ? src : src.path;
  check(statSync(path.join(root, p)).isDirectory(), `${file}: plugin source ${p} missing`);
}
if (problems.length) {
  process.stderr.write(problems.map((p) => `✗ ${p}`).join('\n') + '\n');
  process.exit(1);
}
process.stdout.write(`✓ claude and codex packages: manifests, skills, identical engine (${distFiles.length} files), wrappers scan both fixtures\n`);
