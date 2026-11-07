import {
  EDGE_KINDS,
  EDGE_RELATION,
  GRAPH_SCHEMA,
  GRAPH_VERSION,
  LAYERS,
  NODE_KINDS,
  PROVENANCES,
  type FlowGraph,
} from './schema.ts';

/** Structural validation of a graph. Returns a list of problems (empty when valid). */
export function validateGraph(input: unknown): string[] {
  const problems: string[] = [];
  const g = input as FlowGraph;
  if (!g || typeof g !== 'object') return ['graph is not an object'];
  if (g.schema !== GRAPH_SCHEMA) problems.push(`schema must be "${GRAPH_SCHEMA}"`);
  if (g.version !== GRAPH_VERSION) problems.push(`unsupported version ${String(g.version)}`);
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges) || !Array.isArray(g.scenarios)) {
    problems.push('nodes, edges and scenarios must be arrays');
    return problems;
  }
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (ids.has(n.id)) problems.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
    if (!(NODE_KINDS as readonly string[]).includes(n.kind)) problems.push(`node ${n.id}: bad kind ${n.kind}`);
    if (!(LAYERS as readonly string[]).includes(n.layer)) problems.push(`node ${n.id}: bad layer ${n.layer}`);
    if (n.path && (n.path.startsWith('/') || n.path.includes('\\') || n.path.split('/').includes('..'))) {
      problems.push(`node ${n.id}: path must be repository-relative POSIX`);
    }
  }
  const edgeIds = new Set<string>();
  for (const e of g.edges) {
    if (edgeIds.has(e.id)) problems.push(`duplicate edge id ${e.id}`);
    edgeIds.add(e.id);
    if (!(EDGE_KINDS as readonly string[]).includes(e.kind)) problems.push(`edge ${e.id}: bad kind ${e.kind}`);
    else if (EDGE_RELATION[e.kind] !== e.relation) problems.push(`edge ${e.id}: relation does not match kind`);
    if (!ids.has(e.from)) problems.push(`edge ${e.id}: unknown from ${e.from}`);
    if (!ids.has(e.to)) problems.push(`edge ${e.id}: unknown to ${e.to}`);
    if (!(PROVENANCES as readonly string[]).includes(e.provenance)) problems.push(`edge ${e.id}: bad provenance`);
    if (e.provenance === 'observed' && e.evidence.length === 0) problems.push(`edge ${e.id}: observed edge without evidence`);
    if (e.provenance !== 'observed' && !e.reason) problems.push(`edge ${e.id}: ${e.provenance} edge without reason`);
    for (const ev of e.evidence) {
      if (!ev.path || ev.path.startsWith('/') || !(ev.line >= 1)) problems.push(`edge ${e.id}: bad evidence location`);
    }
  }
  for (const s of g.scenarios) {
    if (s.replay !== 'simulated') problems.push(`scenario ${s.id}: replay must be "simulated"`);
    if (!ids.has(s.entry)) problems.push(`scenario ${s.id}: unknown entry`);
    for (const st of s.steps) if (!edgeIds.has(st.edge)) problems.push(`scenario ${s.id}: unknown step edge ${st.edge}`);
  }
  return problems;
}
