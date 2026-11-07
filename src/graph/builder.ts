import { createHash } from 'node:crypto';
import {
  EDGE_RELATION,
  type EdgeKind,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type Provenance,
} from './schema.ts';

/** Stable, readable id: a prefix plus the readable key, with a short hash when the key is long. */
export function stableId(prefix: string, key: string): string {
  const clean = key.replace(/[^A-Za-z0-9_./:{}#-]+/g, '_');
  // Keys that needed cleaning get a hash too, so two different keys never share an id.
  if (clean === key && clean.length <= 80) return `${prefix}:${clean}`;
  const h = createHash('sha1').update(key).digest('hex').slice(0, 10);
  return `${prefix}:${clean.slice(0, 60)}~${h}`;
}

export interface EdgeInput {
  kind: EdgeKind;
  from: string;
  to: string;
  provenance: Provenance;
  evidence: Evidence[];
  reason?: string;
  data?: string;
  condition?: string;
  branchGroup?: string;
  adapter?: string;
}

/** Collects nodes and edges, merging duplicates deterministically. */
export class GraphBuilder {
  nodes = new Map<string, GraphNode>();
  edges = new Map<string, GraphEdge>();

  addNode(node: GraphNode): GraphNode {
    const existing = this.nodes.get(node.id);
    if (existing) {
      // Fill gaps only; first writer wins for identity fields.
      for (const [k, v] of Object.entries(node)) {
        if ((existing as unknown as Record<string, unknown>)[k] === undefined) {
          (existing as unknown as Record<string, unknown>)[k] = v;
        }
      }
      return existing;
    }
    this.nodes.set(node.id, node);
    return node;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  addEdge(e: EdgeInput): GraphEdge {
    const key = `${e.kind}|${e.from}|${e.to}|${e.branchGroup ?? ''}|${e.condition ?? ''}`;
    const id = stableId('e', key);
    const existing = this.edges.get(id);
    if (existing) {
      for (const ev of e.evidence) {
        if (!existing.evidence.some((x) => x.path === ev.path && x.line === ev.line)) existing.evidence.push(ev);
      }
      // A directly observed occurrence upgrades a weaker one.
      const rank: Record<Provenance, number> = { observed: 2, inferred: 1, unresolved: 0 };
      if (rank[e.provenance] > rank[existing.provenance]) {
        existing.provenance = e.provenance;
        if (e.provenance === 'observed') delete existing.reason;
      }
      if (!existing.data && e.data) existing.data = e.data;
      return existing;
    }
    const edge: GraphEdge = {
      id,
      kind: e.kind,
      relation: EDGE_RELATION[e.kind],
      from: e.from,
      to: e.to,
      provenance: e.provenance,
      evidence: [...e.evidence],
    };
    if (e.reason) edge.reason = e.reason;
    if (e.data) edge.data = e.data;
    if (e.condition) edge.condition = e.condition;
    if (e.branchGroup) edge.branchGroup = e.branchGroup;
    if (e.adapter) edge.adapter = e.adapter;
    this.edges.set(id, edge);
    return edge;
  }

  sortedNodes(): GraphNode[] {
    return [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  sortedEdges(): GraphEdge[] {
    for (const e of this.edges.values()) e.evidence.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return [...this.edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
