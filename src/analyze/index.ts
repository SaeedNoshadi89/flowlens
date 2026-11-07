import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GRAPH_SCHEMA, GRAPH_VERSION, type AdapterReport, type Diagnostic, type FlowGraph, type SelectableRelation } from '../graph/schema.ts';
import { topLevelDirs, walk } from '../scan/walker.ts';
import type { FileFacts, LanguageAdapter } from './facts.ts';
import { jsAdapter } from './js/adapter.ts';
import { link } from './link.ts';
import { pythonAdapter } from './python/adapter.ts';
import { buildScenarios } from './scenarios.ts';

export const ENGINE_VERSION = '0.1.0';

export interface AnalyzeOptions {
  root: string;
  include: string[];
  exclude: string[];
  relations: SelectableRelation[];
  preset: string;
  features?: Record<string, string[]>;
  adapters?: LanguageAdapter[];
  /** Fixed timestamp for reproducible output (tests). */
  now?: string;
}

/** Frameworks we can recognize in manifests, and whether an adapter understands them. */
const FRAMEWORK_SUPPORT: Record<string, 'supported' | 'partial' | 'unsupported'> = {
  fastapi: 'supported', starlette: 'partial', flask: 'partial', express: 'partial', langgraph: 'supported',
  'openai-agents': 'supported', '@openai/agents': 'supported', axios: 'supported', react: 'supported',
  django: 'unsupported', 'django-rest-framework': 'unsupported', fastify: 'unsupported', koa: 'unsupported', hono: 'unsupported',
  '@nestjs/core': 'unsupported', next: 'unsupported', nuxt: 'unsupported', '@trpc/server': 'unsupported', graphql: 'unsupported',
  'apollo-server': 'unsupported', '@apollo/server': 'unsupported', crewai: 'unsupported', autogen: 'unsupported', pyautogen: 'unsupported',
  celery: 'partial', 'socket.io': 'unsupported', aiohttp: 'unsupported', sanic: 'unsupported', litestar: 'unsupported',
  '@langchain/langgraph': 'unsupported', 'llama-index': 'unsupported',
};

function detectFrameworks(root: string, manifests: string[]): string[] {
  const found = new Set<string>();
  for (const m of manifests) {
    let text = '';
    try {
      text = readFileSync(path.join(root, m), 'utf8');
    } catch {
      continue;
    }
    if (m.endsWith('package.json')) {
      try {
        const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
        for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) for (const dep of Object.keys(pkg[k] ?? {})) if (FRAMEWORK_SUPPORT[dep]) found.add(dep);
      } catch {
        /* not JSON */
      }
    } else {
      for (const fw of Object.keys(FRAMEWORK_SUPPORT)) {
        const re = new RegExp(`(^|[\\s"'\\[,])${fw.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\[[^\\]]*\\])?\\s*([<>=~!;,"'\\]]|$)`, 'im');
        if (re.test(text)) found.add(fw);
      }
    }
  }
  return [...found].sort();
}

export async function analyze(opts: AnalyzeOptions): Promise<FlowGraph> {
  const scan = walk({ root: opts.root, include: opts.include, exclude: opts.exclude });
  const adapters = opts.adapters ?? [pythonAdapter(), jsAdapter()];
  const diagnostics: Diagnostic[] = [];
  const reports: AdapterReport[] = [];
  const facts: FileFacts[] = [];
  const languages: Record<string, { files: number; supported: boolean }> = {};
  for (const f of scan.files) {
    languages[f.language] = languages[f.language] ?? { files: 0, supported: true };
    languages[f.language].files++;
  }
  for (const [lang, n] of Object.entries(scan.otherLanguages)) languages[lang] = { files: n, supported: false };

  let analyzedFiles = 0;
  for (const a of adapters) {
    const mine = scan.files.filter((f) => a.extensions.includes(f.rel.split('.').pop()!.toLowerCase()));
    if (!mine.length) {
      reports.push({ id: a.id, language: a.language, status: 'not-applicable', files: 0 });
      continue;
    }
    const av = a.available();
    if (!av.ok) {
      reports.push({ id: a.id, language: a.language, status: 'unavailable', files: mine.length, detail: av.reason });
      diagnostics.push({ level: 'warning', code: 'adapter-unavailable', message: `${a.id}: ${av.reason}. ${mine.length} file(s) were not analyzed.` });
      for (const f of mine) if (languages[f.language]) languages[f.language].supported = false;
      continue;
    }
    const got = await a.extract(mine.map((f) => ({ rel: f.rel, abs: f.abs })));
    facts.push(...got);
    analyzedFiles += got.length;
    reports.push({ id: a.id, language: a.language, status: 'active', files: got.length });
  }
  for (const [lang, info] of Object.entries(languages)) {
    if (!info.supported) diagnostics.push({ level: 'info', code: 'language-unsupported', message: `${info.files} ${lang} file(s) in scope have no analyzer yet and are not in the map.` });
  }

  const frameworks = detectFrameworks(opts.root, scan.manifests);
  const unsupportedFrameworks = frameworks.filter((f) => FRAMEWORK_SUPPORT[f] === 'unsupported');
  for (const fw of unsupportedFrameworks) diagnostics.push({ level: 'warning', code: 'framework-unsupported', message: `Framework "${fw}" is used but has no adapter; its routes or flows are not in the map.` });
  for (const fw of frameworks.filter((f) => FRAMEWORK_SUPPORT[f] === 'partial')) diagnostics.push({ level: 'info', code: 'framework-partial', message: `Framework "${fw}" is only partly understood (common route and call patterns).` });

  const linked = link(facts, { relations: opts.relations, features: opts.features });
  diagnostics.push(...linked.diagnostics);
  const nodes = linked.builder.sortedNodes();
  const edges = linked.builder.sortedEdges();
  const scenarios = buildScenarios(nodes, edges);
  const scopeSet = opts.include.map((p) => p.replace(/\/+$/, ''));
  const top = topLevelDirs(opts.root).map((d) => ({
    path: d,
    scanned: scopeSet.length === 0 || scopeSet.some((s) => s === d || s.startsWith(d + '/') || d.startsWith(s + '/')),
  }));

  return {
    schema: GRAPH_SCHEMA,
    version: GRAPH_VERSION,
    generator: { name: 'flowlens', version: ENGINE_VERSION },
    project: { name: path.basename(opts.root) },
    generatedAt: opts.now ?? new Date().toISOString(),
    scope: { preset: opts.preset, include: opts.include, exclude: opts.exclude, relations: opts.relations, topLevel: top },
    coverage: {
      filesConsidered: scan.considered,
      filesAnalyzed: analyzedFiles,
      skipped: scan.skipped,
      languages,
      adapters: reports,
      parseErrors: facts.filter((f) => f.error).length,
      unresolvedEdges: edges.filter((e) => e.provenance === 'unresolved').length,
      inferredEdges: edges.filter((e) => e.provenance === 'inferred').length,
      unsupportedFrameworks,
    },
    nodes,
    edges,
    scenarios,
    diagnostics: diagnostics.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '') || (a.line ?? 0) - (b.line ?? 0) || a.code.localeCompare(b.code)),
    traces: [],
  };
}
