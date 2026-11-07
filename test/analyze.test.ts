import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../src/analyze/index.ts';
import { extractJs } from '../src/analyze/js/adapter.ts';
import { normalizeRoutePath } from '../src/analyze/link.ts';
import type { FlowGraph, GraphEdge } from '../src/graph/schema.ts';
import { validateGraph } from '../src/graph/validate.ts';
import { renderHtml } from '../src/render/html.ts';
import { SECRETS, workspace } from './helpers.ts';

const ALL = ['api', 'data', 'deps', 'agents'] as const;

async function run(fixture: string, include: string[] = [], relations: (typeof ALL)[number][] = [...ALL]) {
  const ws = workspace(fixture);
  const g = await analyze({ root: ws.root, include, exclude: [], relations, preset: 'test', now: '2026-01-01T00:00:00.000Z' });
  return { g, ws };
}

function edge(g: FlowGraph, kind: string, fromLabel: string, toLabel: string): GraphEdge | undefined {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return g.edges.find((e) => e.kind === kind && byId.get(e.from)?.label === fromLabel && byId.get(e.to)?.label === toLabel);
}

test('shop-app: frontend request -> FastAPI route -> handler -> store, with evidence', async (t) => {
  const { g, ws } = await run('shop-app');
  t.after(ws.cleanup);
  assert.deepEqual(validateGraph(g), []);
  const labels = g.nodes.map((n) => n.label);
  for (const ep of ['POST /api/orders', 'GET /api/orders', 'GET /api/orders/{order_id}', 'GET /api/inventory/{sku}', 'GET /health']) assert.ok(labels.includes(ep), ep);

  const req = edge(g, 'requests', 'createOrder', 'POST /api/orders');
  assert.ok(req);
  assert.equal(req.provenance, 'observed');
  assert.equal(req.data, 'order');
  assert.deepEqual(req.evidence.map((e) => [e.path, e.line]), [['web/src/api/client.ts', 12]]);

  const route = edge(g, 'routes_to', 'POST /api/orders', 'POST /api/orders');
  assert.ok(route, 'request is linked to the route');
  assert.equal(route.provenance, 'inferred');
  assert.match(route.reason!, /match route POST \/api\/orders/);
  assert.ok(route.evidence.some((e) => e.path === 'api/app/routes/orders.py' && e.line === 10));

  const handles = edge(g, 'handles', 'POST /api/orders', 'create_order');
  assert.equal(handles?.provenance, 'observed');
  assert.equal(handles?.data, 'payload: OrderIn');
  assert.ok(handles?.evidence.some((e) => e.path === 'api/app/main.py' && /mounts router/.test(e.note)), 'include_router prefix is evidence');

  const write = edge(g, 'writes', 'save_order', 'orders');
  assert.equal(write?.provenance, 'observed');
  assert.deepEqual(write?.evidence.map((e) => e.line), [8]);
  assert.equal(edge(g, 'reads', 'find_orders', 'orders')?.provenance, 'observed');
  assert.equal(edge(g, 'reads', 'stock_level', 'cache')?.provenance, 'observed');
  assert.equal(edge(g, 'writes', 'saveDraft', 'localStorage')?.data, 'draft');
  assert.equal(edge(g, 'calls', 'CheckoutPage.submit', 'createOrder')?.provenance, 'observed');
  assert.equal(edge(g, 'calls', 'create_order', 'place_order')?.provenance, 'observed');

  // Partial URL with a runtime base: inferred with an explanation.
  const partial = edge(g, 'routes_to', 'GET {base}/inventory/{}', 'GET /api/inventory/{sku}');
  assert.equal(partial?.provenance, 'inferred');
  assert.match(partial!.reason!, /runtime prefix/);
  // Dynamic URL and unmatched route are unresolved, never invented.
  assert.equal(edge(g, 'routes_to', 'POST (dynamic URL)', 'Dynamic URL')?.provenance, 'unresolved');
  assert.equal(edge(g, 'routes_to', 'POST /api/feedback', 'No scanned route: POST /api/feedback')?.provenance, 'unresolved');
  assert.equal(edge(g, 'routes_to', 'POST //hooks.example.com/warehouse', 'hooks.example.com')?.provenance, 'observed');

  for (const e of g.edges) {
    if (e.provenance === 'observed') assert.ok(e.evidence.length > 0 && e.evidence.every((x) => x.line >= 1 && !x.path.startsWith('/')));
    else assert.ok(e.reason && e.reason.length > 20, `${e.id} explains itself`);
  }
  const journey = g.scenarios.find((s) => s.title === 'CheckoutPage.submit journey');
  assert.ok(journey);
  assert.equal(journey.replay, 'simulated');
  const titles = journey.steps.map((s) => s.title);
  assert.ok(titles.indexOf('createOrder sends POST /api/orders') < titles.indexOf('Request reaches POST /api/orders'));
  assert.ok(titles.includes('save_order writes orders'));
  assert.ok(g.scenarios.some((s) => s.kind === 'endpoint-flow' && s.title === 'GET /health'));
  assert.ok(!g.nodes.some((n) => n.path?.startsWith('node_modules') || n.path?.startsWith('generated') || n.path === 'linked-outside.ts'));
});

test('agent-desk: conditional, inferred and unresolved handoffs', async (t) => {
  const { g, ws } = await run('agent-desk');
  t.after(ws.cleanup);
  assert.deepEqual(validateGraph(g), []);
  const billing = edge(g, 'handoff', 'intake', 'billing');
  const tech = edge(g, 'handoff', 'intake', 'tech');
  assert.equal(billing?.provenance, 'observed');
  assert.equal(tech?.condition, 'technical');
  assert.equal(billing?.branchGroup, tech?.branchGroup, 'mapping options are alternatives of one branch');
  const esc = edge(g, 'handoff', 'tech', 'escalate');
  assert.equal(esc?.provenance, 'inferred');
  assert.match(esc!.reason!, /returns the literal "escalate"/);
  assert.ok(esc!.evidence.some((e) => e.path === 'desk/nodes/tech.py' && e.line === 11));
  assert.equal(edge(g, 'handoff', 'tech', 'END')?.provenance, 'inferred');
  assert.equal(edge(g, 'handoff', 'escalate', 'Runtime goto target')?.provenance, 'unresolved');
  assert.equal(edge(g, 'implemented_by', 'intake', 'classify')?.provenance, 'observed');
  assert.equal(edge(g, 'handoff', 'Triage', 'Billing')?.provenance, 'observed');
  assert.equal(edge(g, 'handoff', 'Triage', 'Support')?.provenance, 'observed');
  assert.equal(edge(g, 'handoff', 'Triage', 'Unresolved agent make_specialist()')?.provenance, 'unresolved');
  assert.equal(edge(g, 'invokes_tool', 'Triage', 'lookup_account')?.provenance, 'observed');
  assert.equal(edge(g, 'calls', 'run_ticket', 'START')?.provenance, 'observed');
  assert.equal(edge(g, 'writes', 'handle', 'Refund')?.provenance, 'observed');
  assert.ok(g.coverage.unsupportedFrameworks.includes('crewai'));
  assert.ok(g.diagnostics.some((d) => d.code === 'framework-unsupported'));
  const flow = g.scenarios.find((s) => s.title === 'Agent graph workflow');
  assert.ok(flow);
  const branchSteps = flow.steps.filter((s) => s.branch);
  assert.ok(branchSteps.some((s) => s.branch!.of === 2 && s.branch!.condition === 'technical'));
  assert.ok(flow.steps.some((s) => s.provenance === 'unresolved'));
});

test('same engine and renderer on both fixtures, no secrets in any output', async (t) => {
  for (const fx of ['shop-app', 'agent-desk']) {
    const { g, ws } = await run(fx);
    t.after(ws.cleanup);
    assert.deepEqual(validateGraph(g), [], fx);
    assert.ok(g.scenarios.length >= 3, fx);
    const html = renderHtml(g, { sourceBase: '../' });
    const json = JSON.stringify(g);
    for (const s of SECRETS) {
      assert.ok(!json.includes(s), `${fx} graph leaks ${s}`);
      assert.ok(!html.includes(s), `${fx} html leaks ${s}`);
    }
    assert.ok(!json.includes(ws.root), 'no absolute paths in the graph');
    assert.ok(!html.includes(ws.root), 'no absolute paths in the report');
  }
});

test('relation selection limits what is analyzed; scope limits files', async (t) => {
  const { g, ws } = await run('shop-app', ['api'], ['data']);
  t.after(ws.cleanup);
  assert.ok(g.edges.every((e) => e.relation === 'data' || e.relation === 'calls'));
  assert.ok(g.nodes.every((n) => !n.path || n.path.startsWith('api/')));
  assert.deepEqual(g.scope.topLevel.find((x) => x.path === 'web'), { path: 'web', scanned: false });
  assert.deepEqual(g.scope.topLevel.find((x) => x.path === 'api'), { path: 'api', scanned: true });
});

test('JS adapter: fetch, axios, express routes and agents without executing code', () => {
  const f = extractJs('srv/app.ts', `
    import express from 'express';
    import axios from 'axios';
    import { Agent } from '@openai/agents';
    const app = express();
    const router = express.Router();
    router.post('/items/:id', saveItem);
    app.use('/v1', router);
    function saveItem(req, res) { return axios.post('/hooks/' + req.params.id, req.body); }
    const writer = new Agent({ name: 'Writer', handoffs: [editor], tools: [search] });
    export default function main() { return fetch(\`/v1/items/\${1}\`, { method: 'POST', body: JSON.stringify({ a: 1 }) }); }
  `);
  assert.deepEqual(f.routes.map((r) => [r.method, r.path, r.handler]), [['POST', '/items/:id', 'saveItem']]);
  assert.deepEqual(f.includes.map((i) => [i.router, i.prefix]), [['router', '/v1']]);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].client, 'axios');
  assert.deepEqual(f.requests[1].url, { kind: 'template', value: '/v1/items/{}' });
  assert.equal(f.requests[1].data, '{a}');
  assert.equal(f.sdkAgents[0].name, 'Writer');
  assert.equal(f.defaultExport, 'main');
});

test('route path normalization', () => {
  assert.equal(normalizeRoutePath('/api/orders/{order_id}'), '/api/orders/{}');
  assert.equal(normalizeRoutePath('/api/orders/:id/'), '/api/orders/{}');
  assert.equal(normalizeRoutePath('/api/<int:id>?x=1'), '/api/{}');
  assert.equal(normalizeRoutePath('api//x'), '/api/x');
});

test('a Python adapter that cannot run is reported, not hidden', async (t) => {
  const ws = workspace('shop-app');
  t.after(ws.cleanup);
  const prev = process.env.FLOWLENS_PYTHON;
  process.env.FLOWLENS_PYTHON = 'definitely-not-python-xyz';
  try {
    const { pythonAdapter } = await import('../src/analyze/python/adapter.ts');
    const { jsAdapter } = await import('../src/analyze/js/adapter.ts');
    const g = await analyze({ root: ws.root, include: [], exclude: [], relations: [...ALL], preset: 't', adapters: [pythonAdapter(), jsAdapter()] });
    assert.equal(g.coverage.adapters.find((a) => a.id === 'python.ast')?.status, 'unavailable');
    assert.equal(g.coverage.languages.python.supported, false);
    assert.ok(g.diagnostics.some((d) => d.code === 'adapter-unavailable'));
    assert.ok(g.edges.some((e) => e.kind === 'routes_to' && e.provenance === 'unresolved'), 'frontend requests now have no scanned route');
  } finally {
    if (prev === undefined) delete process.env.FLOWLENS_PYTHON;
    else process.env.FLOWLENS_PYTHON = prev;
  }
});
