/**
 * Language-neutral facts an adapter reports for one file. The linker turns
 * facts from all adapters into the graph, so a new language or framework only
 * needs to fill these records.
 */

export interface UrlShape {
  /** literal: whole URL known. template: known with {} holes. partial: dynamic prefix + known suffix. dynamic: unknown. */
  kind: 'literal' | 'template' | 'partial' | 'dynamic';
  value?: string;
}

export interface ImportFact {
  module: string;
  /** Python relative import level; 0 for absolute. JS uses module strings directly. */
  level: number;
  names: { imported: string; local: string }[];
  /** Local binding for `import x` / `import * as x` / default import. */
  alias: string | null;
  line: number;
  kind: 'import' | 'from' | 'es' | 'require' | 'dynamic';
}

export interface FunctionFact {
  name: string;
  qual: string;
  line: number;
  endLine: number;
  decorators?: string[];
  params?: { name: string; type: string | null }[];
  cls?: string | null;
  isClass?: boolean;
  exported?: boolean;
  returns?: { value: string; line: number }[];
}

export interface CallFact {
  inFn: string | null;
  callee: string;
  line: number;
}

export interface RouteFact {
  method: string;
  path: string;
  handler: string;
  owner: string;
  line: number;
  framework: string;
}

export interface RequestFact {
  inFn: string | null;
  method: string;
  url: UrlShape;
  line: number;
  client: string;
  data: string | null;
}

export interface StoreFact {
  inFn: string | null;
  op: 'reads' | 'writes' | 'enqueues' | 'unknown';
  kind: 'sql' | 'orm' | 'kv' | 'queue' | 'browser-storage';
  name: string | null;
  line: number;
  data: string | null;
  note: string;
}

export interface GraphFact {
  var: string;
  line: number;
  nodes: { name: string; fn: string | null; line: number }[];
  edges: {
    from: string | null;
    to?: string | null;
    line: number;
    kind: 'static' | 'conditional';
    router?: string | null;
    options?: { condition: string | null; to: string | null; line: number; col?: number }[] | null;
    dynamicMap?: boolean;
  }[];
  entry: { name: string | null; line: number } | null;
  finish: { name: string | null; line: number }[];
}

export interface SdkAgentFact {
  var: string;
  name: string;
  line: number;
  handoffs: { ref: string | null; line: number }[] | null;
  handoffsDynamic: boolean;
  tools: { ref: string | null; line: number }[] | null;
  toolsDynamic: boolean;
}

export interface FileFacts {
  path: string;
  language: string;
  adapter: string;
  error?: { line: number; message: string };
  imports: ImportFact[];
  functions: FunctionFact[];
  calls: CallFact[];
  routes: RouteFact[];
  routers: { var: string; prefix: string; line: number }[];
  includes: { router: string; prefix: string; owner: string | null; line: number }[];
  requests: RequestFact[];
  stores: StoreFact[];
  graphs: GraphFact[];
  compiled: { var: string; graph: string; line: number }[];
  graphInvokes: { inFn: string | null; target: string | null; line: number; via: string; agent?: boolean }[];
  sdkAgents: SdkAgentFact[];
  tools: { fn: string; name: string; line: number }[];
  commands: { inFn: string | null; goto: string | null; ref?: string | null; line: number; dynamic: boolean; sdk?: boolean }[];
  frameworks: string[];
  /** JSX seen (JS) — a strong frontend signal. */
  jsx?: boolean;
  /** Name bound to `export default` (JS). */
  defaultExport?: string;
}

export function emptyFacts(path: string, language: string, adapter: string): FileFacts {
  return {
    path, language, adapter, imports: [], functions: [], calls: [], routes: [], routers: [], includes: [],
    requests: [], stores: [], graphs: [], compiled: [], graphInvokes: [], sdkAgents: [], tools: [], commands: [], frameworks: [],
  };
}

export interface LanguageAdapter {
  id: string;
  language: string;
  extensions: string[];
  /** Returns null when the adapter cannot run here (e.g. interpreter missing), with a reason. */
  available(): { ok: true } | { ok: false; reason: string };
  extract(files: { rel: string; abs: string }[]): Promise<FileFacts[]>;
}
