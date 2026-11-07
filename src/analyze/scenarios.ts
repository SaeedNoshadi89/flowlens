import { stableId } from '../graph/builder.ts';
import type { EdgeKind, GraphEdge, GraphNode, Scenario, ScenarioStep } from '../graph/schema.ts';

const FLOW_KINDS: EdgeKind[] = ['calls', 'requests', 'routes_to', 'handles', 'reads', 'writes', 'enqueues', 'external_call', 'handoff', 'invokes_tool', 'implemented_by'];
const MAX_STEPS = 60;
const MAX_DEPTH = 8;

function stepTitle(e: GraphEdge, from: GraphNode, to: GraphNode): string {
  switch (e.kind) {
    case 'calls': return `${from.label} calls ${to.label}`;
    case 'requests': return `${from.label} sends ${to.label}`;
    case 'routes_to': return to.kind === 'endpoint' ? `Request reaches ${to.label}` : `Request goes to ${to.label}`;
    case 'handles': return `${from.label} is handled by ${to.label}`;
    case 'reads': return `${from.label} reads ${to.label}`;
    case 'writes': return `${from.label} writes ${to.label}`;
    case 'enqueues': return `${from.label} enqueues ${to.label}`;
    case 'external_call': return `${from.label} calls ${to.label}`;
    case 'handoff': return e.condition ? `${from.label} hands off to ${to.label} (${e.condition})` : `${from.label} hands off to ${to.label}`;
    case 'invokes_tool': return `${from.label} can use tool ${to.label}`;
    case 'implemented_by': return `${from.label} runs ${to.label}`;
    default: return `${from.label} → ${to.label}`;
  }
}

/**
 * Build simulated replays: ordered walks over observed, inferred and unresolved
 * edges from an entry node. Branch alternatives (edges sharing a branchGroup)
 * are kept as labeled alternatives; each alternative's continuation follows it.
 */
export function buildScenarios(nodes: GraphNode[], edges: GraphEdge[]): Scenario[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (!FLOW_KINDS.includes(e.kind)) continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (incoming.get(e.to) ?? incoming.set(e.to, []).get(e.to)!).push(e);
  }
  // Stable order: by evidence line, so steps follow source order.
  // Evidence is sorted by path, so pick the earliest location in the edge's first file.
  const at = (e: GraphEdge) => {
    const first = e.evidence.find((x) => x.path === e.evidence[0]?.path && x.line === Math.min(...e.evidence.filter((y) => y.path === e.evidence[0]?.path).map((y) => y.line)));
    return [first?.line ?? 0, first?.column ?? 0];
  };
  for (const list of out.values()) list.sort((a, b) => at(a)[0] - at(b)[0] || at(a)[1] - at(b)[1] || a.id.localeCompare(b.id));

  const walk = (entry: string, firstEdges: GraphEdge[] | null): ScenarioStep[] => {
    const steps: ScenarioStep[] = [];
    const expanded = new Set<string>([entry]);
    const visit = (nodeId: string, depth: number, only: GraphEdge[] | null) => {
      if (steps.length >= MAX_STEPS || depth > MAX_DEPTH) return;
      const list = only ?? out.get(nodeId) ?? [];
      const groups = new Map<string, GraphEdge[]>();
      for (const e of list) if (e.branchGroup) (groups.get(e.branchGroup) ?? groups.set(e.branchGroup, []).get(e.branchGroup)!).push(e);
      for (const e of list) {
        if (steps.length >= MAX_STEPS) return;
        const from = byId.get(e.from);
        const to = byId.get(e.to);
        if (!from || !to) continue;
        const step: ScenarioStep = { index: steps.length, edge: e.id, from: e.from, to: e.to, title: stepTitle(e, from, to), provenance: e.provenance, depth };
        if (e.branchGroup) {
          const g = groups.get(e.branchGroup)!;
          if (g.length > 1) step.branch = { group: e.branchGroup, option: g.indexOf(e) + 1, of: g.length, condition: e.condition };
        }
        steps.push(step);
        if (!expanded.has(e.to)) {
          expanded.add(e.to);
          visit(e.to, depth + 1, null);
        }
      }
    };
    visit(entry, 0, firstEdges);
    return steps;
  };

  const scenarios: Scenario[] = [];
  const used = new Set<string>();
  const push = (s: Omit<Scenario, 'replay' | 'basis'>) => {
    if (!s.steps.length || used.has(s.id)) return;
    used.add(s.id);
    scenarios.push({ ...s, replay: 'simulated', basis: 'static-analysis' });
  };

  // 1. Client request flows: caller -> request -> endpoint -> handler -> ...
  for (const n of nodes) {
    if (n.kind !== 'request') continue;
    const callers = (incoming.get(n.id) ?? []).filter((e) => e.kind === 'requests');
    for (const c of callers) {
      const caller = byId.get(c.from)!;
      const steps = walk(caller.id, [c]);
      const target = steps.find((s) => byId.get(s.to)?.kind === 'endpoint');
      push({
        id: stableId('scn', `api:${n.id}:${caller.id}`),
        title: `${n.label} from ${caller.label}`,
        kind: 'api-flow', feature: caller.feature, entry: caller.id, steps,
        summary: target ? `Client code sends a request that is matched to ${byId.get(target.to)!.label}.` : 'Client code sends a request whose server route was not found in the scan.',
      });
    }
  }
  // 2. Endpoints without a scanned client.
  for (const n of nodes) {
    if (n.kind !== 'endpoint') continue;
    const hasClient = (incoming.get(n.id) ?? []).some((e) => e.kind === 'routes_to');
    if (hasClient) continue;
    push({ id: stableId('scn', `ep:${n.id}`), title: n.label, kind: 'endpoint-flow', feature: n.feature, entry: n.id, steps: walk(n.id, null), summary: 'Server route traced from its handler; no client call for it was found in the scan.' });
  }
  // 3. Agent flows from graph starts and root agents.
  for (const n of nodes) {
    if (n.kind !== 'agent') continue;
    const isStart = n.attrs?.terminal === true && n.label === 'START';
    const inbound = (incoming.get(n.id) ?? []).filter((e) => e.kind === 'handoff');
    const isRootSdk = n.attrs?.sdk === true && inbound.length === 0 && (out.get(n.id) ?? []).some((e) => e.kind === 'handoff');
    if (!isStart && !isRootSdk) continue;
    const graph = typeof n.attrs?.graph === 'string' ? n.attrs.graph : n.label;
    push({
      id: stableId('scn', `agent:${n.id}`),
      title: isStart ? `Agent graph ${graph}` : `Agent ${n.label} handoffs`,
      kind: 'agent-flow', feature: n.feature, entry: n.id, steps: walk(n.id, null),
      summary: 'Agent handoffs reconstructed from orchestration code. Conditional branches are listed as alternatives; only one runs at a time.',
    });
  }
  // 4. Entry journeys: root functions (nothing in the scan calls them) whose walk reaches a request,
  //    endpoint, store, queue or agent, and that do more than one step.
  const interesting = new Set(['request', 'endpoint', 'store', 'queue', 'agent', 'external']);
  for (const n of nodes) {
    if (n.kind !== 'function') continue;
    const inbound = (incoming.get(n.id) ?? []).filter((e) => e.kind === 'calls' || e.kind === 'handles' || e.kind === 'implemented_by');
    if (inbound.length) continue;
    const firstHop = out.get(n.id) ?? [];
    if (!firstHop.some((e) => e.kind === 'calls')) continue;
    const steps = walk(n.id, null);
    if (steps.length < 2 || !steps.some((s) => interesting.has(byId.get(s.to)?.kind ?? ''))) continue;
    push({ id: stableId('scn', `entry:${n.id}`), title: `${n.label} journey`, kind: 'entry-flow', feature: n.feature, entry: n.id, steps, summary: `Everything reachable from ${n.label}, which nothing in the scanned code calls (an entry point such as a UI handler, job or script).` });
  }
  return scenarios.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
}
