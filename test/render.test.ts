import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { analyze } from '../src/analyze/index.ts';
import { GRAPH_SCHEMA, GRAPH_VERSION, type FlowGraph } from '../src/graph/schema.ts';
import { REPORT_CSP, renderHtml, scriptJson } from '../src/render/html.ts';
import { REPO, workspace } from './helpers.ts';

// The report's pure core, evaluated the way the browser does (a plain script).
const coreSrc = readFileSync(path.join(REPO, 'src/render/assets/core.js'), 'utf8');
function core() {
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(coreSrc, ctx);
  return ctx.FlowLensCore as any;
}

async function shop(): Promise<{ g: FlowGraph; cleanup: () => void }> {
  const ws = workspace('shop-app');
  const g = await analyze({ root: ws.root, include: [], exclude: [], relations: ['api', 'data', 'deps', 'agents'], preset: 'whole', now: '2026-01-01T00:00:00.000Z' });
  return { g, cleanup: ws.cleanup };
}

test('report is self-contained: CSP blocks network, no external URLs in markup', async (t) => {
  const { g, cleanup } = await shop();
  t.after(cleanup);
  const html = renderHtml(g, { sourceBase: '../' });
  assert.ok(html.includes(`content="${REPORT_CSP}"`));
  assert.match(REPORT_CSP, /default-src 'none'/);
  assert.match(REPORT_CSP, /connect-src 'none'/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /@import|url\(\s*['"]?https?:/i);
  // The only http(s) strings allowed are the SVG namespace and data in the embedded graph.
  const markup = html.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, '');
  const urls = markup.match(/https?:\/\/[^\s"'<)]+/g) ?? [];
  assert.deepEqual([...new Set(urls)], ['http://www.w3.org/2000/svg']);
});

test('untrusted labels cannot break out of the embedded JSON', () => {
  const evil = '</script><script>alert(1)</script><!--';
  const g: FlowGraph = {
    schema: GRAPH_SCHEMA, version: GRAPH_VERSION, generator: { name: 'flowlens', version: 't' }, project: { name: `<img src=x onerror=alert(1)>` },
    generatedAt: '2026-01-01T00:00:00Z', scope: { preset: 'whole', include: [], exclude: [], relations: ['api'], topLevel: [] },
    coverage: { filesConsidered: 0, filesAnalyzed: 0, skipped: {}, languages: {}, adapters: [], parseErrors: 0, unresolvedEdges: 0, inferredEdges: 0, unsupportedFrameworks: [] },
    nodes: [{ id: 'n', kind: 'endpoint', label: `GET /x/${evil}`, layer: 'backend' }], edges: [], scenarios: [], diagnostics: [], traces: [],
  };
  const html = renderHtml(g);
  assert.equal(html.split('</script>').length - 1, 4, 'exactly the four real closing script tags');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; flow map'));
  const embedded = html.match(/<script type="application\/json" id="flowlens-data">([\s\S]*?)<\/script>/)![1];
  assert.equal(JSON.parse(embedded).nodes[0].label, `GET /x/${evil}`, 'round-trips exactly');
  assert.equal(scriptJson('a\u2028b<'), '"a\\u2028b\\u003c"');
  // The client inserts text with textContent only.
  const app = readFileSync(path.join(REPO, 'src/render/assets/app.js'), 'utf8');
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});

test('core: overview aggregates to modules, filters switch views without re-analysis', async (t) => {
  const { g, cleanup } = await shop();
  t.after(cleanup);
  const C = core();
  const st = C.defaultState(g);
  const mod = C.computeView(g, st);
  assert.ok(mod.nodes.every((n: any) => n.kind !== 'function' && n.kind !== 'request'));
  assert.ok(mod.edges.some((e: any) => e.count > 1), 'parallel edges are aggregated with counts');
  st.level = 'functions';
  const fn = C.computeView(g, st);
  assert.ok(fn.nodes.some((n: any) => n.kind === 'function'));
  st.relations = ['data'];
  const data = C.computeView(g, st);
  assert.ok(data.edges.length > 0 && data.edges.every((e: any) => e.relation === 'data'));
  st.relations = C.RELATIONS.slice();
  st.provenance = ['unresolved'];
  const unres = C.computeView(g, st);
  assert.ok(unres.edges.length >= 2 && unres.edges.every((e: any) => e.provenance === 'unresolved'));
  st.provenance = C.PROVENANCES.slice();
  st.features = ['api/app'];
  const feat = C.computeView(g, st);
  assert.ok(feat.nodes.every((n: any) => !n.feature || n.feature === 'api/app'));
  assert.ok(feat.nodes.some((n: any) => n.kind === 'store'), 'feature-less stores reached by the feature stay visible');
  const lay = C.layout(fn);
  assert.ok(lay.lanes.map((l: any) => l.id).join(',').startsWith('ui,request,endpoint,service'));
  for (const n of fn.nodes) assert.ok(lay.pos[n.id], 'every node is placed');
});

test('core: scenario view and replay stepping', async (t) => {
  const { g, cleanup } = await shop();
  t.after(cleanup);
  const C = core();
  const sc = g.scenarios.find((s) => s.title === 'CheckoutPage.submit journey')!;
  const st = C.defaultState(g);
  st.scenario = sc.id;
  const v = C.computeView(g, st);
  assert.equal(v.mode, 'scenario');
  assert.equal(v.order[0], sc.entry);
  assert.equal(C.moveStep({ step: -1 }, sc, -1), -1);
  assert.equal(C.moveStep({ step: -1 }, sc, 1), 0);
  assert.equal(C.moveStep({ step: sc.steps.length - 1 }, sc, 1), sc.steps.length - 1);
  const m = C.replayMarks(g, sc, 2);
  assert.equal(m.active.edge, sc.steps[2].edge);
  assert.equal(Object.keys(m.seenEdges).length, 3);
  assert.equal(C.stepDelay(2), 750);
  assert.ok(C.stepDelay(0.5) > C.stepDelay(4));
});

test('core: URL hash round-trip and re-scan command', async (t) => {
  const { g, cleanup } = await shop();
  t.after(cleanup);
  const C = core();
  const sc = g.scenarios[0];
  const st = C.defaultState(g);
  st.scenario = sc.id; st.step = 1; st.speed = 2; st.relations = ['api', 'calls'];
  const hash = C.toHash(g, st);
  const back = C.applyHash(g, C.defaultState(g), C.parseHash(hash));
  assert.equal(back.scenario, sc.id);
  assert.equal(back.step, 1);
  assert.equal(back.speed, 2);
  assert.deepEqual([...back.relations], ['api', 'calls']);
  assert.equal(C.applyHash(g, C.defaultState(g), C.parseHash('#scenario=nope&step=99')).scenario, null);
  assert.equal(C.rescanCommand(['web', 'api'], ['api', 'data'], []), 'flowlens scan --include web,api --relations api,data --save');
  assert.equal(C.rescanCommand([], ['agents'], ["it's/**"]), "flowlens scan --preset whole --relations agents --exclude 'it'\\''s/**' --save");
});
