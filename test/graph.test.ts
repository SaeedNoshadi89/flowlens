import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GraphBuilder, stableId } from '../src/graph/builder.ts';
import { GRAPH_SCHEMA, GRAPH_VERSION, type FlowGraph } from '../src/graph/schema.ts';
import { validateGraph } from '../src/graph/validate.ts';

function base(): FlowGraph {
  return {
    schema: GRAPH_SCHEMA, version: GRAPH_VERSION, generator: { name: 'flowlens', version: 't' }, project: { name: 'p' },
    generatedAt: '2026-01-01T00:00:00Z', scope: { preset: 'whole', include: [], exclude: [], relations: ['api'], topLevel: [] },
    coverage: { filesConsidered: 0, filesAnalyzed: 0, skipped: {}, languages: {}, adapters: [], parseErrors: 0, unresolvedEdges: 0, inferredEdges: 0, unsupportedFrameworks: [] },
    nodes: [], edges: [], scenarios: [], diagnostics: [], traces: [],
  };
}

test('stable ids are deterministic and readable', () => {
  assert.equal(stableId('fn', 'a/b.py#run'), 'fn:a/b.py#run');
  assert.equal(stableId('fn', 'x'.repeat(200)), stableId('fn', 'x'.repeat(200)));
  assert.ok(stableId('fn', 'x'.repeat(200)).length < 90);
});

test('builder merges duplicate edges, keeps all evidence and upgrades provenance', () => {
  const b = new GraphBuilder();
  b.addNode({ id: 'a', kind: 'function', label: 'a', layer: 'backend' });
  b.addNode({ id: 'b', kind: 'function', label: 'b', layer: 'backend' });
  b.addEdge({ kind: 'calls', from: 'a', to: 'b', provenance: 'inferred', reason: 'r', evidence: [{ path: 'x.py', line: 3, note: 'n' }] });
  const e = b.addEdge({ kind: 'calls', from: 'a', to: 'b', provenance: 'observed', evidence: [{ path: 'x.py', line: 9, note: 'n' }] });
  assert.equal(b.edges.size, 1);
  assert.equal(e.provenance, 'observed');
  assert.equal(e.reason, undefined);
  assert.deepEqual(e.evidence.map((x) => x.line), [3, 9]);
  assert.equal(e.relation, 'calls');
});

test('validator accepts a minimal graph and rejects bad ones', () => {
  const g = base();
  assert.deepEqual(validateGraph(g), []);
  g.nodes.push({ id: 'n1', kind: 'function', label: 'f', layer: 'backend', path: '/abs/path.py' });
  g.nodes.push({ id: 'n2', kind: 'store', label: 's', layer: 'data' });
  g.edges.push({ id: 'e1', kind: 'writes', relation: 'data', from: 'n1', to: 'n2', provenance: 'observed', evidence: [] });
  g.edges.push({ id: 'e2', kind: 'writes', relation: 'api', from: 'n1', to: 'missing', provenance: 'inferred', evidence: [{ path: 'a.py', line: 1, note: '' }] });
  const problems = validateGraph(g).join('\n');
  assert.match(problems, /repository-relative/);
  assert.match(problems, /observed edge without evidence/);
  assert.match(problems, /relation does not match kind/);
  assert.match(problems, /unknown to missing/);
  assert.match(problems, /inferred edge without reason/);
});
