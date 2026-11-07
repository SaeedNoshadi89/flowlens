/**
 * FlowLens intermediate graph, schema version 1.
 *
 * Analyzers produce this graph; the renderer consumes it. Nothing in here may
 * hold raw source text or configuration values: labels are identifiers, route
 * templates, and short descriptions written by the analyzer.
 */

export const GRAPH_SCHEMA = 'flowlens.graph';
export const GRAPH_VERSION = '1.0.0';

/** Relationship families a user can select for analysis and filter in the report. */
export const RELATIONS = ['api', 'data', 'deps', 'agents', 'calls'] as const;
export type Relation = (typeof RELATIONS)[number];

/** Relations a user selects in setup. `calls` is always analyzed: it links the others. */
export const SELECTABLE_RELATIONS = ['api', 'data', 'deps', 'agents'] as const;
export type SelectableRelation = (typeof SELECTABLE_RELATIONS)[number];

export const NODE_KINDS = [
  'feature',
  'module',
  'function',
  'endpoint',
  'request',
  'store',
  'queue',
  'external',
  'agent',
  'tool',
  'unknown',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const LAYERS = ['frontend', 'backend', 'agents', 'data', 'external', 'shared'] as const;
export type Layer = (typeof LAYERS)[number];

export const EDGE_KINDS = [
  'imports', // module -> module (deps)
  'calls', // function -> function (calls)
  'requests', // function -> request (api)
  'routes_to', // request -> endpoint (api)
  'handles', // endpoint -> function (api)
  'reads', // function -> store (data)
  'writes', // function -> store/queue (data)
  'enqueues', // function -> queue (data)
  'external_call', // function -> external (api)
  'handoff', // agent -> agent (agents)
  'invokes_tool', // agent -> tool (agents)
  'implemented_by', // agent/tool -> function (agents)
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const EDGE_RELATION: Record<EdgeKind, Relation> = {
  imports: 'deps',
  calls: 'calls',
  requests: 'api',
  routes_to: 'api',
  handles: 'api',
  reads: 'data',
  writes: 'data',
  enqueues: 'data',
  external_call: 'api',
  handoff: 'agents',
  invokes_tool: 'agents',
  implemented_by: 'agents',
};

/**
 * observed:   the relationship is written directly in source at the evidence location.
 * inferred:   two observed facts are joined by a rule; `reason` says which rule.
 * unresolved: source shows a relationship exists, but its target is dynamic.
 */
export const PROVENANCES = ['observed', 'inferred', 'unresolved'] as const;
export type Provenance = (typeof PROVENANCES)[number];

export interface Evidence {
  /** Repository-relative POSIX path. */
  path: string;
  line: number;
  column?: number;
  /** What the analyzer saw, described in words (never copied source). */
  note: string;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  layer: Layer;
  /** Short secondary label, e.g. "POST" or a file name. */
  sub?: string;
  path?: string;
  line?: number;
  /** Feature (folder group) this node belongs to. */
  feature?: string;
  /** Module (file) node id that contains this node. */
  module?: string;
  language?: string;
  /** Adapter that produced the node, e.g. "python.fastapi". */
  adapter?: string;
  attrs?: Record<string, string | number | boolean | string[]>;
}

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  relation: Relation;
  from: string;
  to: string;
  provenance: Provenance;
  evidence: Evidence[];
  /** Required for inferred and unresolved edges: why it is plausible or what is dynamic. */
  reason?: string;
  /** What is passed or stored, only when source names it. */
  data?: string;
  /** Branch condition label, when the edge is one of several alternatives. */
  condition?: string;
  /** Edges sharing a branch group are alternatives at one decision point. */
  branchGroup?: string;
  adapter?: string;
}

export interface ScenarioStep {
  index: number;
  edge: string;
  from: string;
  to: string;
  title: string;
  provenance: Provenance;
  /** Nesting depth from the scenario entry (for indentation in the event panel). */
  depth: number;
  /** Set when this step is one alternative of a branch. */
  branch?: { group: string; option: number; of: number; condition?: string };
}

export interface Scenario {
  id: string;
  title: string;
  kind: 'api-flow' | 'endpoint-flow' | 'agent-flow' | 'entry-flow';
  feature?: string;
  entry: string;
  /** Every scenario is reconstructed from static source; never a recorded run. */
  replay: 'simulated';
  basis: 'static-analysis';
  steps: ScenarioStep[];
  summary: string;
}

export interface Diagnostic {
  level: 'info' | 'warning';
  code: string;
  message: string;
  path?: string;
  line?: number;
}

export interface AdapterReport {
  id: string;
  language: string;
  status: 'active' | 'unavailable' | 'not-applicable';
  files: number;
  detail?: string;
}

export interface Coverage {
  filesConsidered: number;
  filesAnalyzed: number;
  skipped: Record<string, number>;
  languages: Record<string, { files: number; supported: boolean }>;
  adapters: AdapterReport[];
  parseErrors: number;
  unresolvedEdges: number;
  inferredEdges: number;
  /** Frameworks detected in manifests that no adapter understands yet. */
  unsupportedFrameworks: string[];
}

export interface ScopeInfo {
  preset: string;
  include: string[];
  exclude: string[];
  relations: SelectableRelation[];
  /** Top-level folders of the repository, with whether they were scanned. */
  topLevel: { path: string; scanned: boolean }[];
}

export interface FlowGraph {
  schema: typeof GRAPH_SCHEMA;
  version: typeof GRAPH_VERSION;
  generator: { name: string; version: string };
  project: { name: string };
  generatedAt: string;
  scope: ScopeInfo;
  coverage: Coverage;
  nodes: GraphNode[];
  edges: GraphEdge[];
  scenarios: Scenario[];
  diagnostics: Diagnostic[];
  /** Runtime traces are a future input; the first release never fills this. */
  traces: [];
}
