import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { analyze, ENGINE_VERSION } from '../analyze/index.ts';
import { combinePresets, PRESET_NAMES, resolvePresets, type PresetName } from '../config/presets.ts';
import { cleanRel, defaultSettings, ensureOutputIgnore, loadSettings, saveSettings, settingsPath, type ProjectSettings } from '../config/settings.ts';
import { SELECTABLE_RELATIONS, type FlowGraph, type SelectableRelation } from '../graph/schema.ts';
import { validateGraph } from '../graph/validate.ts';
import { renderHtml } from '../render/html.ts';
import { resolveRoot } from '../scan/root.ts';

const HELP = `FlowLens ${ENGINE_VERSION} - interactive flow maps of a repository, from static analysis.

Usage: flowlens <command> [options]

Commands:
  scan         Analyze the project and write the HTML map and graph JSON (default)
  regenerate   Scan again with the saved project settings
  setup        Guided setup: choose scope and relationships, save them, optionally scan
  presets      Show which folders each preset resolves to
  open         Open the last generated map in the default browser
  render       Render HTML from an existing graph JSON file
  validate     Validate a graph JSON file against the schema
  root         Print the resolved repository root
  config       Print the saved project settings

Options:
  --root <dir>          Repository root (default: nearest folder with .git above the current directory)
  --preset <names>      whole, backend, frontend, agents, here (comma-separated to combine)
  --include <paths>     Folders or files to scan, relative to the root (comma-separated)
  --exclude <patterns>  Extra gitignore-style exclusions (comma-separated)
  --relations <list>    api, data, deps, agents (comma-separated; function calls are always analyzed)
  --out <dir>           Output folder (default: <root>/.flowlens)
  --save                Save the effective scope and relationships as the project settings
  --no-saved            Ignore saved settings for this run
  --editor-links        Add vscode:// links to evidence (puts absolute paths in the report)
  --open                Open the map after writing it
  --json                Print a machine-readable summary
  --quiet               Print only the output paths
  -h, --help            Show this help
  -v, --version         Show the version

Examples:
  flowlens scan
  flowlens scan --preset backend,frontend --relations api,data --save
  flowlens scan --include services/api,web/src --exclude "**/*.test.ts" --open
  flowlens presets --json
  flowlens regenerate --open
`;

interface Cli {
  command: string;
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
}

function parse(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' }, preset: { type: 'string' }, include: { type: 'string' }, exclude: { type: 'string' },
      relations: { type: 'string' }, out: { type: 'string' }, save: { type: 'boolean' }, 'no-saved': { type: 'boolean' },
      'editor-links': { type: 'boolean' }, open: { type: 'boolean' }, json: { type: 'boolean' }, quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, now: { type: 'string' },
    },
  });
  const [command = 'scan', ...rest] = positionals;
  return { command, positionals: rest, values };
}

const list = (v: unknown): string[] => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

function fail(msg: string): never {
  process.stderr.write(`flowlens: ${msg}\n`);
  process.exit(2);
}

function parsePresets(v: string[]): PresetName[] {
  for (const p of v) if (!(PRESET_NAMES as readonly string[]).includes(p)) fail(`unknown preset "${p}" (use ${PRESET_NAMES.join(', ')})`);
  return v as PresetName[];
}

function parseRelations(v: string[]): SelectableRelation[] {
  const out = v.filter((r) => r !== 'calls');
  for (const r of out) if (!(SELECTABLE_RELATIONS as readonly string[]).includes(r)) fail(`unknown relation "${r}" (use ${SELECTABLE_RELATIONS.join(', ')})`);
  return out as SelectableRelation[];
}

function log(cli: Cli, msg: string) {
  if (!cli.values.quiet && !cli.values.json) process.stdout.write(msg + '\n');
}

/** Merge saved settings with CLI options. CLI wins; presets resolve to paths. */
function effectiveSettings(cli: Cli, root: string, cwdRelative: string): { settings: ProjectSettings; saved: boolean; presetNote: string[] } {
  const loaded = cli.values['no-saved'] ? { settings: defaultSettings(), found: false } : loadSettings(root);
  const s: ProjectSettings = { ...loaded.settings };
  const notes: string[] = [];
  const presetArg = list(cli.values.preset);
  const includeArg = list(cli.values.include);
  if (presetArg.length) {
    const names = parsePresets(presetArg);
    const resolved = resolvePresets(root, cwdRelative);
    s.include = combinePresets(names, resolved);
    s.presets = names;
    for (const n of names) if (resolved[n].note) notes.push(resolved[n].note!);
    if (!names.includes('whole') && !(names.includes('here') && !cwdRelative) && s.include.length === 0) {
      fail(`preset ${names.join(',')} matched no folders. Use --include to choose folders, or run "flowlens presets".`);
    }
  }
  if (includeArg.length) {
    const cleaned = includeArg.map((p) => cleanRel(p));
    if (cleaned.some((p) => p === null)) fail('--include paths must stay inside the root');
    const extra = cleaned.filter((p): p is string => p !== null && p !== '');
    s.include = presetArg.length ? [...new Set([...s.include, ...extra])].sort() : extra;
    s.presets = presetArg.length ? [...s.presets, 'custom'] : ['custom'];
    for (const p of extra) if (!existsSync(path.join(root, p))) fail(`--include path not found: ${p}`);
  }
  if (cli.values.exclude !== undefined) s.exclude = list(cli.values.exclude);
  if (cli.values.relations !== undefined) {
    const r = parseRelations(list(cli.values.relations));
    if (!r.length) fail('--relations needs at least one of api, data, deps, agents');
    s.relations = r;
  }
  if (cli.values['editor-links']) s.editorLinks = true;
  return { settings: s, saved: loaded.found, presetNote: notes };
}

function outDirFor(cli: Cli, root: string, s: ProjectSettings): string {
  if (typeof cli.values.out === 'string') return path.resolve(process.cwd(), cli.values.out);
  return path.join(root, s.outDir);
}

export interface ScanResult {
  root: string;
  html: string;
  graph: string;
  settingsFile: string | null;
  summary: { nodes: number; edges: number; scenarios: number; files: number; inferred: number; unresolved: number; diagnostics: number };
}

async function scan(cli: Cli, mode: 'scan' | 'regenerate'): Promise<ScanResult> {
  const r = resolveRoot(process.cwd(), cli.values.root as string | undefined);
  if (mode === 'regenerate' && !existsSync(settingsPath(r.root))) log(cli, 'No saved settings yet: regenerating with defaults (whole repository, all relationships).');
  const { settings, saved, presetNote } = effectiveSettings(mode === 'regenerate' ? { ...cli, values: { ...cli.values, preset: undefined, include: undefined } } : cli, r.root, r.cwdRelative);
  log(cli, `Root: ${r.root} (${r.method === 'git' ? 'found via .git' : r.method === 'explicit' ? 'from --root' : 'current directory'})${r.cwdRelative ? `; you are in ${r.cwdRelative}/` : ''}`);
  log(cli, `Scope: ${settings.include.length ? settings.include.join(', ') : 'whole repository'}${settings.exclude.length ? `; excluding ${settings.exclude.join(', ')}` : ''}`);
  log(cli, `Relationships: ${settings.relations.join(', ')} (+ function calls)${saved && !cli.values.save ? '  [saved project settings]' : ''}`);
  for (const n of presetNote) log(cli, `Note: ${n}`);

  const graph = await analyze({
    root: r.root, include: settings.include, exclude: settings.exclude, relations: settings.relations,
    preset: settings.presets.join('+'), features: settings.features, now: cli.values.now as string | undefined,
  });
  mkdirSync(outDirFor(cli, r.root, settings), { recursive: true });
  const out = realpathSync(outDirFor(cli, r.root, settings));
  if (path.resolve(out) === path.join(r.root, '.flowlens')) ensureOutputIgnore(out);
  const graphFile = path.join(out, 'graph.json');
  const htmlFile = path.join(out, 'flowmap.html');
  writeFileSync(graphFile, JSON.stringify(graph, null, 2) + '\n');
  const rel = path.relative(out, r.root).split(path.sep).join('/');
  writeFileSync(htmlFile, renderHtml(graph, { sourceBase: rel ? rel + '/' : './', editorRoot: settings.editorLinks ? r.root : null, graphFile: 'graph.json' }));
  let settingsFile: string | null = null;
  if (cli.values.save) settingsFile = saveSettings(r.root, settings);

  const summary = {
    nodes: graph.nodes.length, edges: graph.edges.length, scenarios: graph.scenarios.length, files: graph.coverage.filesAnalyzed,
    inferred: graph.coverage.inferredEdges, unresolved: graph.coverage.unresolvedEdges, diagnostics: graph.diagnostics.length,
  };
  const result: ScanResult = { root: r.root, html: htmlFile, graph: graphFile, settingsFile, summary };
  if (cli.values.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else if (cli.values.quiet) process.stdout.write(`${htmlFile}\n${graphFile}\n`);
  else {
    log(cli, `Analyzed ${summary.files} files: ${summary.nodes} nodes, ${summary.edges} edges (${summary.inferred} inferred, ${summary.unresolved} unresolved), ${summary.scenarios} scenarios.`);
    const warn = graph.diagnostics.filter((d) => d.level === 'warning');
    if (warn.length) log(cli, `Warnings: ${warn.length} (see the Diagnostics panel). ${warn.slice(0, 3).map((w) => w.message).join(' ')}`);
    log(cli, `Map:   ${htmlFile}`);
    log(cli, `Graph: ${graphFile}`);
    if (settingsFile) log(cli, `Saved settings: ${settingsFile}`);
    log(cli, `Open it: flowlens open${cli.values.out ? ` --out ${cli.values.out}` : ''}   (or open the file in any browser; it works offline)`);
  }
  if (cli.values.open) await openFile(htmlFile);
  return result;
}

function openFile(file: string): Promise<void> {
  const cmd = process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : ['xdg-open', [file]];
  return new Promise((resolve) => {
    const child = spawn(cmd[0] as string, cmd[1] as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      process.stderr.write(`Could not open a browser. Open this file manually: ${file}\n`);
      resolve();
    });
    child.unref();
    setTimeout(resolve, 200);
  });
}

function presets(cli: Cli) {
  const r = resolveRoot(process.cwd(), cli.values.root as string | undefined);
  const resolved = resolvePresets(r.root, r.cwdRelative);
  if (cli.values.json) {
    process.stdout.write(JSON.stringify({ root: r.root, cwdRelative: r.cwdRelative, presets: resolved, relations: SELECTABLE_RELATIONS }, null, 2) + '\n');
    return;
  }
  log(cli, `Root: ${r.root}`);
  for (const n of PRESET_NAMES) {
    const p = resolved[n];
    log(cli, `\n${n}:`);
    if (n === 'whole') log(cli, '  (whole repository)');
    else if (!p.paths.length) log(cli, `  ${p.note ?? '(nothing matched)'}`);
    for (const x of p.paths) log(cli, `  ${x}/   ${p.reasons[x] ?? ''}`);
  }
}

async function setup(cli: Cli) {
  if (!process.stdin.isTTY) {
    fail('setup is interactive. In scripts use: flowlens scan --preset <names> | --include <paths> --relations <list> --save');
  }
  const r = resolveRoot(process.cwd(), cli.values.root as string | undefined);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\nFlowLens setup\nRoot: ${r.root}${r.cwdRelative ? `  (you are in ${r.cwdRelative}/)` : ''}\n`);
    const ok = (await rl.question('Is this the project root? [Y/n] ')).trim().toLowerCase();
    if (ok === 'n' || ok === 'no') {
      process.stdout.write('Re-run with --root <dir> to choose another root.\n');
      return;
    }
    const resolved = resolvePresets(r.root, r.cwdRelative);
    const { settings: current } = loadSettings(r.root);
    process.stdout.write('\nPresets and the folders they resolve to:\n');
    PRESET_NAMES.forEach((n, i) => {
      const p = resolved[n];
      const shown = n === 'whole' ? 'whole repository' : p.paths.length ? p.paths.join(', ') : '(nothing matched)';
      process.stdout.write(`  ${i + 1}. ${n.padEnd(9)} ${shown}\n`);
    });
    const pick = (await rl.question('\nChoose presets by number or name (comma-separated) [1]: ')).trim() || '1';
    const names = pick.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (/^\d+$/.test(x) ? PRESET_NAMES[Number(x) - 1] : x)).filter(Boolean);
    const valid = parsePresets(names as string[]);
    let include = combinePresets(valid, resolved);
    process.stdout.write(`\nFolders to scan: ${include.length ? include.join(', ') : '(whole repository)'}\n`);
    const edit = (await rl.question('Edit the folder list? Enter comma-separated paths, or press Enter to keep: ')).trim();
    if (edit) {
      include = edit.split(',').map((p) => cleanRel(p.trim())).filter((p): p is string => !!p);
      for (const p of include) if (!existsSync(path.join(r.root, p))) process.stdout.write(`  warning: ${p} does not exist\n`);
    }
    const ex = (await rl.question(`Extra exclusions (gitignore patterns, comma-separated) [${current.exclude.join(',') || 'none'}]: `)).trim();
    const exclude = ex ? ex.split(',').map((x) => x.trim()).filter(Boolean) : current.exclude;
    process.stdout.write('\nRelationships: api (requests and routes), data (stores and queues), deps (module imports), agents (handoffs and tools).\n');
    const rels = (await rl.question(`Which to analyze? [${current.relations.join(',')}]: `)).trim();
    const relations = rels ? parseRelations(rels.split(',').map((x) => x.trim()).filter(Boolean)) : current.relations;
    const settings: ProjectSettings = { ...current, presets: edit ? ['custom'] : valid, include, exclude, relations };
    const file = saveSettings(r.root, settings);
    process.stdout.write(`\nSaved ${file}\n`);
    const go = (await rl.question('Scan now? [Y/n] ')).trim().toLowerCase();
    rl.close();
    if (go !== 'n' && go !== 'no') await scan({ ...cli, command: 'scan', values: { ...cli.values, root: r.root } }, 'regenerate');
  } finally {
    rl.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  let cli: Cli;
  try {
    cli = parse(argv);
  } catch (e) {
    fail((e as Error).message);
  }
  if (cli.values.version) {
    process.stdout.write(`flowlens ${ENGINE_VERSION}\n`);
    return 0;
  }
  if (cli.values.help || cli.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  switch (cli.command) {
    case 'scan':
      await scan(cli, 'scan');
      return 0;
    case 'regenerate':
      await scan(cli, 'regenerate');
      return 0;
    case 'setup':
      await setup(cli);
      return 0;
    case 'presets':
      presets(cli);
      return 0;
    case 'root': {
      const r = resolveRoot(process.cwd(), cli.values.root as string | undefined);
      process.stdout.write(cli.values.json ? JSON.stringify(r) + '\n' : r.root + '\n');
      return 0;
    }
    case 'config': {
      const r = resolveRoot(process.cwd(), cli.values.root as string | undefined);
      const { settings, found } = loadSettings(r.root);
      process.stdout.write(JSON.stringify({ file: settingsPath(r.root), saved: found, settings }, null, 2) + '\n');
      return 0;
    }
    case 'open': {
      const r = resolveRoot(process.cwd(), cli.values.root as string | undefined);
      const { settings } = loadSettings(r.root);
      const file = path.join(outDirFor(cli, r.root, settings), 'flowmap.html');
      if (!existsSync(file)) fail(`no map at ${file}; run "flowlens scan" first`);
      process.stdout.write(file + '\n');
      await openFile(file);
      return 0;
    }
    case 'validate': {
      const file = cli.positionals[0] ?? fail('usage: flowlens validate <graph.json>');
      const problems = validateGraph(JSON.parse(readFileSync(file, 'utf8')));
      if (problems.length) {
        process.stdout.write(problems.map((p) => `invalid: ${p}`).join('\n') + '\n');
        return 1;
      }
      process.stdout.write(`valid: ${file}\n`);
      return 0;
    }
    case 'render': {
      const file = cli.positionals[0] ?? fail('usage: flowlens render <graph.json> [--out <file.html>]');
      const graph = JSON.parse(readFileSync(file, 'utf8')) as FlowGraph;
      const problems = validateGraph(graph);
      if (problems.length) fail(`graph is invalid: ${problems[0]}`);
      const out = typeof cli.values.out === 'string' ? path.resolve(cli.values.out) : file.replace(/\.json$/, '') + '.html';
      writeFileSync(out, renderHtml(graph, { sourceBase: null, graphFile: path.basename(file) }));
      process.stdout.write(out + '\n');
      return 0;
    }
    default:
      fail(`unknown command "${cli.command}". Run flowlens --help.`);
  }
}

const isEntry = (() => {
  const arg = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return /(^|[\\/])(main\.ts|flowlens\.mjs|flowlens)$/.test(arg);
})();
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`flowlens: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
