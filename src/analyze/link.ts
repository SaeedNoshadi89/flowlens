import path from 'node:path';
import { GraphBuilder, stableId } from '../graph/builder.ts';
import type { Diagnostic, Evidence, GraphNode, Layer, SelectableRelation } from '../graph/schema.ts';
import type { FileFacts, FunctionFact, UrlShape } from './facts.ts';

type Binding =
  | { kind: 'module'; file: string }
  | { kind: 'symbol'; file: string; name: string }
  | { kind: 'external'; module: string };

export interface LinkOptions {
  relations: SelectableRelation[];
  features?: Record<string, string[]>;
}

export interface LinkResult {
  builder: GraphBuilder;
  diagnostics: Diagnostic[];
  externalPackages: number;
}

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const FRONTEND_DIR = /^(web|frontend|front-end|client|ui|webapp|www|site|pages|components|views|app-ui|spa)$/i;
const AGENT_FRAMEWORKS = new Set(['langgraph', 'agents', 'openai-agents', 'crewai', 'autogen', 'langchain']);
const UI_FRAMEWORKS = new Set(['react', 'vue', 'svelte', 'angular', 'next']);
const BUILTIN_TYPES = new Set(['str', 'int', 'float', 'bool', 'dict', 'list', 'bytes', 'Any', 'Optional', 'None', 'Request', 'Response', 'Depends', 'BackgroundTasks', 'Session', 'AsyncSession']);

export function featureOf(rel: string, features?: Record<string, string[]>): string {
  if (features) {
    let best: { name: string; len: number } | null = null;
    for (const [name, prefixes] of Object.entries(features)) {
      for (const p of prefixes) {
        const clean = p.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
        if ((rel === clean || rel.startsWith(clean + '/')) && (!best || clean.length > best.len)) best = { name, len: clean.length };
      }
    }
    if (best) return best.name;
  }
  const dirs = rel.split('/').slice(0, -1);
  if (dirs.length === 0) return '(root)';
  return dirs.slice(0, 2).join('/');
}

/** Module label: the file name, or "pkg/__init__.py" style for package and index files. */
export function moduleLabel(rel: string): string {
  const base = path.posix.basename(rel);
  const dir = path.posix.basename(path.posix.dirname(rel));
  if (/^(__init__\.pyi?|index\.(t|j)sx?|index\.m?(t|j)s|mod\.rs)$/.test(base) && dir && dir !== '.') return `${dir}/${base}`;
  return base;
}

export function normalizeRoutePath(p: string): string {
  let s = p.replace(/[?#].*$/, '');
  s = s.replace(/\{[^}]*\}/g, '{}').replace(/<[^>]*>/g, '{}').replace(/(^|\/):[A-Za-z_]\w*/g, '$1{}');
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

function splitUrl(value: string): { host: string | null; path: string } {
  const m = /^([a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)(.*)$/i.exec(value);
  if (m) return { host: m[2].replace(/^[^@]*@/, ''), path: m[3] || '/' };
  return { host: null, path: value };
}

function joinPaths(...parts: string[]): string {
  const joined = parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
  return joined.startsWith('/') ? joined : '/' + joined;
}

export function link(all: FileFacts[], opts: LinkOptions): LinkResult {
  const b = new GraphBuilder();
  const diagnostics: Diagnostic[] = [];
  const rel = new Set(opts.relations);
  const facts = all.filter((f) => !f.error || f.functions.length || f.imports.length);
  const byPath = new Map(all.map((f) => [f.path, f]));
  const filesSet = new Set(all.map((f) => f.path));
  let externalPackages = 0;

  // ---------- layers and features
  const layerOf = new Map<string, Layer>();
  for (const f of all) {
    const segs = f.path.split('/');
    let layer: Layer = 'backend';
    const agentish = f.graphs.length || f.sdkAgents.length || f.tools.length || f.commands.length || f.frameworks.some((x) => AGENT_FRAMEWORKS.has(x));
    if (agentish) layer = 'agents';
    else if (f.language !== 'python' && (f.jsx || f.frameworks.some((x) => UI_FRAMEWORKS.has(x)) || segs.slice(0, -1).some((s) => FRONTEND_DIR.test(s)))) layer = 'frontend';
    else if (f.language !== 'python' && f.requests.length && !f.routes.length && !f.frameworks.includes('express')) layer = 'frontend';
    layerOf.set(f.path, layer);
  }

  // ---------- module and function nodes
  const fnIndex = new Map<string, Map<string, FunctionFact>>();
  const modId = (p: string) => stableId('mod', p);
  const fnId = (p: string, qual: string) => stableId('fn', `${p}#${qual}`);
  for (const f of all) {
    const feature = featureOf(f.path, opts.features);
    b.addNode({
      id: modId(f.path), kind: 'module', label: moduleLabel(f.path), sub: path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path),
      layer: layerOf.get(f.path)!, path: f.path, line: 1, feature, language: f.language, adapter: f.adapter,
    });
    const m = new Map<string, FunctionFact>();
    for (const fn of f.functions) {
      m.set(fn.qual, fn);
      if (fn.isClass) continue;
      b.addNode({
        id: fnId(f.path, fn.qual), kind: 'function', label: fn.qual, sub: path.posix.basename(f.path), layer: layerOf.get(f.path)!,
        path: f.path, line: fn.line, feature, module: modId(f.path), language: f.language, adapter: f.adapter,
      });
    }
    fnIndex.set(f.path, m);
    if (f.error) diagnostics.push({ level: 'warning', code: 'parse-error', message: `Could not fully parse (${f.error.message}); facts may be incomplete.`, path: f.path, line: f.error.line });
  }

  // ---------- module resolution
  const pyIndex = new Map<string, string[]>();
  const pkgDirs = new Set(all.filter((f) => /(^|\/)__init__\.pyi?$/.test(f.path)).map((f) => path.posix.dirname(f.path)));
  for (const f of all) {
    if (f.language !== 'python') continue;
    let parts = f.path.replace(/\.pyi?$/, '').split('/');
    if (parts[parts.length - 1] === '__init__') parts = parts.slice(0, -1);
    for (let i = 0; i < parts.length; i++) {
      // Absolute imports start at an import root: a folder that is not itself a package.
      if (i > 0 && pkgDirs.has(parts.slice(0, i).join('/'))) continue;
      const key = parts.slice(i).join('.');
      const list = pyIndex.get(key) ?? [];
      list.push(f.path);
      pyIndex.set(key, list);
    }
  }
  const commonPrefix = (a: string, b2: string) => {
    const x = a.split('/');
    const y = b2.split('/');
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    return i;
  };
  const resolvePyModule = (from: string, module: string, level: number): string | null => {
    if (level > 0) {
      let dir = path.posix.dirname(from);
      for (let i = 1; i < level; i++) dir = path.posix.dirname(dir);
      const base = [dir === '.' ? '' : dir, ...module.split('.').filter(Boolean)].filter(Boolean).join('/');
      for (const cand of [`${base}.py`, `${base}/__init__.py`, `${base}.pyi`]) if (filesSet.has(cand)) return cand;
      return null;
    }
    const list = pyIndex.get(module);
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const exact = list.filter((p) => p.replace(/(\/__init__)?\.pyi?$/, '').replace(/\//g, '.').endsWith(module));
    const pool = exact.length ? exact : list;
    return [...pool].sort((p, q) => commonPrefix(q, from) - commonPrefix(p, from) || p.length - q.length)[0];
  };
  const resolveJsModule = (from: string, spec: string): string | null => {
    let base: string | null = null;
    if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    else if (spec.startsWith('@/') || spec.startsWith('~/')) {
      const segs = from.split('/');
      const srcIdx = segs.lastIndexOf('src');
      base = [...(srcIdx >= 0 ? segs.slice(0, srcIdx + 1) : segs.slice(0, 1)), spec.slice(2)].join('/');
    } else if (spec.startsWith('/')) base = spec.slice(1);
    if (base === null) return null;
    const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
    const cands = [base, ...JS_EXTS.map((e) => stripped + e), ...JS_EXTS.map((e) => `${stripped}/index${e}`)];
    for (const c of cands) if (filesSet.has(c)) return c;
    return null;
  };

  // ---------- bindings and import edges
  const bindings = new Map<string, Map<string, Binding>>();
  for (const f of all) {
    const bmap = new Map<string, Binding>();
    for (const imp of f.imports) {
      if (f.language === 'python') {
        if (imp.kind === 'import') {
          const target = resolvePyModule(f.path, imp.module, 0);
          if (target) {
            // `import a.b` binds `a`; `import a.b as c` binds c to a.b.
            const alias = imp.alias ?? imp.module.split('.')[0];
            const isAliasOfFull = alias !== imp.module.split('.')[0] || !imp.module.includes('.');
            bmap.set(alias, isAliasOfFull ? { kind: 'module', file: target } : { kind: 'external', module: imp.module });
            addImport(f, target, imp.line, imp.module);
          } else externalPackages++;
        } else {
          const base = resolvePyModule(f.path, imp.module, imp.level);
          let any = false;
          let symbolFromBase = false;
          for (const n of imp.names) {
            const sub = resolvePyModule(f.path, imp.module ? `${imp.module}.${n.imported}` : n.imported, imp.level);
            if (sub && sub !== base) {
              bmap.set(n.local, { kind: 'module', file: sub });
              addImport(f, sub, imp.line, `${imp.module}.${n.imported}`);
              any = true;
            } else if (base) {
              bmap.set(n.local, { kind: 'symbol', file: base, name: n.imported });
              any = true;
              symbolFromBase = true;
            }
          }
          if (base && (symbolFromBase || imp.names.length === 0)) addImport(f, base, imp.line, imp.module || '.');
          if (!base && !any) externalPackages++;
        }
      } else {
        const target = resolveJsModule(f.path, imp.module);
        if (!target) {
          externalPackages++;
          continue;
        }
        if (imp.alias) bmap.set(imp.alias, { kind: 'module', file: target });
        for (const n of imp.names) bmap.set(n.local, { kind: 'symbol', file: target, name: n.imported });
        addImport(f, target, imp.line, imp.module);
      }
    }
    bindings.set(f.path, bmap);
  }

  function addImport(f: FileFacts, target: string, line: number, spec: string) {
    if (!rel.has('deps') || target === f.path) return;
    b.addEdge({
      kind: 'imports', from: modId(f.path), to: modId(target), provenance: 'observed', adapter: f.adapter,
      evidence: [{ path: f.path, line, note: `imports ${spec}` }],
    });
  }

  // ---------- symbol resolution
  const defaultExport = (file: string): string | null => {
    const ff = byPath.get(file) as (FileFacts & { defaultExport?: string }) | undefined;
    return ff?.defaultExport ?? null;
  };
  const lookupFn = (file: string, name: string): string | null => {
    const m = fnIndex.get(file);
    if (!m) return null;
    const fn = m.get(name);
    if (fn && !fn.isClass) return fnId(file, fn.qual);
    return null;
  };
  /** Resolve a dotted callee used inside `inFn` of file `file` to a function node id. */
  const resolveCallee = (file: string, inFn: string | null, callee: string, depth = 0): string | null => {
    if (depth > 4) return null;
    const parts = callee.split('.');
    const m = fnIndex.get(file);
    if (parts[0] === 'self' || parts[0] === 'this' || parts[0] === 'cls') {
      if (!inFn || parts.length !== 2) return null;
      const fn = m?.get(inFn);
      const cls = fn?.cls ?? inFn.split('.').slice(0, -1).join('.');
      return cls ? lookupFn(file, `${cls}.${parts[1]}`) : null;
    }
    if (parts.length === 1) {
      // Nested scopes first, then the module level.
      if (inFn) {
        const scope = inFn.split('.');
        for (let i = scope.length; i > 0; i--) {
          const id = lookupFn(file, `${scope.slice(0, i).join('.')}.${parts[0]}`);
          if (id) return id;
        }
      }
      const local = lookupFn(file, parts[0]);
      if (local) return local;
    }
    const bind = bindings.get(file)?.get(parts[0]);
    if (bind?.kind === 'symbol') {
      const name = bind.name === 'default' ? defaultExport(bind.file) ?? 'default' : bind.name;
      return resolveCallee(bind.file, null, [name, ...parts.slice(1)].join('.'), depth + 1);
    }
    if (bind?.kind === 'module' && parts.length >= 2) {
      // a.b.c(): try submodules a.b, then the function in the module.
      if (parts.length >= 3) {
        const ff = byPath.get(bind.file);
        if (ff?.language === 'python') {
          const sub = resolvePyModule(bind.file, parts.slice(0, 2).join('.'), 0);
          if (sub && sub !== bind.file) {
            const id = resolveCallee(sub, null, parts.slice(2).join('.'), depth + 1);
            if (id) return id;
          }
        }
      }
      return resolveCallee(bind.file, null, parts.slice(1).join('.'), depth + 1);
    }
    if (parts.length >= 2 && !bind) {
      // Class.method in the same file.
      return lookupFn(file, parts.join('.'));
    }
    return null;
  };
  /** Resolve a variable name (agent, router, compiled graph) to (file, var) through imports. */
  const resolveVar = (file: string, ref: string, depth = 0): { file: string; name: string } | null => {
    if (depth > 4) return null;
    const parts = ref.split('.');
    const bind = bindings.get(file)?.get(parts[0]);
    if (bind?.kind === 'symbol' && parts.length === 1) return resolveVar(bind.file, bind.name, depth + 1);
    if (bind?.kind === 'module' && parts.length === 2) return resolveVar(bind.file, parts[1], depth + 1);
    if (parts.length === 1) return { file, name: parts[0] };
    return null;
  };

  const callerId = (f: FileFacts, inFn: string | null): string => {
    if (inFn) {
      const id = lookupFn(f.path, inFn);
      if (id) return id;
      // Calls inside a class body or an unindexed nested scope: attribute them to the closest indexed parent.
      const scope = inFn.split('.');
      for (let i = scope.length - 1; i > 0; i--) {
        const pid = lookupFn(f.path, scope.slice(0, i).join('.'));
        if (pid) return pid;
      }
    }
    return modId(f.path);
  };

  // ---------- calls
  for (const f of facts) {
    for (const c of f.calls) {
      const target = resolveCallee(f.path, c.inFn, c.callee);
      if (!target) continue;
      const from = callerId(f, c.inFn);
      if (from === target) continue;
      b.addEdge({ kind: 'calls', from, to: target, provenance: 'observed', adapter: f.adapter, evidence: [{ path: f.path, line: c.line, note: `calls ${c.callee}()` }] });
    }
  }

  // ---------- routes
  const endpoints: { id: string; method: string; norm: string; full: string; path: string; line: number }[] = [];
  if (rel.has('api')) {
    // Router mounts: (file, var) -> list of prefixes with evidence.
    const mounts = new Map<string, { prefix: string; ev: Evidence }[]>();
    for (const f of facts) {
      for (const inc of f.includes) {
        const target = resolveVar(f.path, inc.router);
        if (!target) continue;
        const key = `${target.file}#${target.name}`;
        const list = mounts.get(key) ?? [];
        list.push({ prefix: inc.prefix, ev: { path: f.path, line: inc.line, note: `mounts router ${inc.router}${inc.prefix ? ` at ${inc.prefix}` : ''}` } });
        mounts.set(key, list);
      }
    }
    for (const f of facts) {
      const routerPrefix = new Map(f.routers.map((r) => [r.var, r]));
      for (const r of f.routes) {
        const handler = resolveCallee(f.path, null, r.handler) ?? lookupFn(f.path, r.handler);
        if (!handler) continue;
        const rp = routerPrefix.get(r.owner);
        const mountList = mounts.get(`${f.path}#${r.owner}`) ?? [];
        const variants = mountList.length ? mountList : [{ prefix: '', ev: null as Evidence | null }];
        if (rp && !mountList.length) {
          diagnostics.push({ level: 'info', code: 'router-not-mounted', message: `Router "${r.owner}" is not mounted in the scanned files; its routes are shown without an outer prefix.`, path: f.path, line: rp.line });
        }
        for (const v of variants) {
          const full = joinPaths(v.prefix, rp?.prefix ?? '', r.path);
          const id = stableId('ep', `${r.method} ${full}`);
          const ev: Evidence[] = [{ path: f.path, line: r.line, note: `${r.framework} route ${r.method} ${r.path} on ${r.owner}` }];
          if (rp?.prefix) ev.push({ path: f.path, line: rp.line, note: `router prefix ${rp.prefix}` });
          if (v.ev) ev.push(v.ev);
          b.addNode({ id, kind: 'endpoint', label: `${r.method} ${full}`, sub: r.framework.replace('?', ''), layer: 'backend', path: f.path, line: r.line, feature: featureOf(f.path, opts.features), module: modId(f.path), adapter: f.adapter, attrs: { method: r.method, route: full } });
          const handlerFn = fnIndex.get(f.path)?.get(r.handler);
          const body = handlerFn?.params?.find((p) => p.type && /^[A-Z]/.test(p.type.split('.').pop()!) && !BUILTIN_TYPES.has(p.type.split('.').pop()!));
          b.addEdge({ kind: 'handles', from: id, to: handler, provenance: 'observed', adapter: f.adapter, evidence: ev, data: body ? `${body.name}: ${body.type}` : undefined });
          endpoints.push({ id, method: r.method, norm: normalizeRoutePath(full), full, path: f.path, line: r.line });
        }
      }
    }
  }

  // ---------- requests
  const unknownNode = (key: string, label: string, sub: string): string => {
    const id = stableId('unknown', key);
    b.addNode({ id, kind: 'unknown', label, sub, layer: 'external' });
    return id;
  };
  if (rel.has('api')) {
    for (const f of facts) {
      for (const r of f.requests) {
        const from = callerId(f, r.inFn);
        const display = displayUrl(r.url);
        const reqId = stableId('req', `${f.path}#L${r.line}`);
        b.addNode({ id: reqId, kind: 'request', label: `${r.method} ${display}`, sub: r.client, layer: layerOf.get(f.path)!, path: f.path, line: r.line, feature: featureOf(f.path, opts.features), module: modId(f.path), adapter: f.adapter, attrs: { method: r.method, url: display, urlKind: r.url.kind } });
        b.addEdge({ kind: 'requests', from, to: reqId, provenance: 'observed', adapter: f.adapter, data: r.data ?? undefined, evidence: [{ path: f.path, line: r.line, note: `${r.client} ${r.method} request${r.data ? ` with ${r.data}` : ''}` }] });
        linkRequest(f, r.method, r.url, reqId, r.line);
      }
    }
  }

  function linkRequest(f: FileFacts, method: string, url: UrlShape, reqId: string, line: number) {
    const ev: Evidence = { path: f.path, line, note: 'request URL' };
    if (url.kind === 'dynamic' || !url.value) {
      const to = unknownNode('dynamic-url', 'Dynamic URL', 'target decided at runtime');
      b.addEdge({ kind: 'routes_to', from: reqId, to, provenance: 'unresolved', evidence: [ev], reason: 'The URL is computed at runtime (a variable or a call), so the target cannot be determined from source.' });
      return;
    }
    const { host, path: p } = splitUrl(url.value);
    const local = !host || /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(host);
    const norm = normalizeRoutePath(p);
    const methodOk = (m: string) => method === '?' || m === 'ANY' || m === method;
    let matches: typeof endpoints = [];
    if (local) {
      if (url.kind === 'partial') matches = endpoints.filter((e) => methodOk(e.method) && (e.norm === norm || e.norm.endsWith(norm)));
      else matches = endpoints.filter((e) => methodOk(e.method) && e.norm === norm);
    }
    if (matches.length) {
      for (const m of matches) {
        const why =
          url.kind === 'partial'
            ? `The URL has a runtime prefix; its known part "${norm}" and method ${method} match the end of route ${m.method} ${m.full} (${m.path}:${m.line}).`
            : `Method ${method} and path "${norm}" match route ${m.method} ${m.full} (${m.path}:${m.line}). The base URL and proxying are decided at runtime.`;
        b.addEdge({
          kind: 'routes_to', from: reqId, to: m.id, provenance: 'inferred', evidence: [ev, { path: m.path, line: m.line, note: `route ${m.method} ${m.full}` }],
          reason: matches.length > 1 ? `${why} ${matches.length} routes match; each is shown.` : why,
        });
      }
      return;
    }
    if (host && !local) {
      const id = stableId('ext', host);
      b.addNode({ id, kind: 'external', label: host, sub: 'external host', layer: 'external' });
      b.addEdge({ kind: 'routes_to', from: reqId, to: id, provenance: 'observed', evidence: [{ ...ev, note: `request to host ${host}` }] });
      return;
    }
    const to = unknownNode(`unmatched:${method} ${norm}`, `No scanned route: ${method} ${norm}`, 'outside scope or unsupported');
    b.addEdge({ kind: 'routes_to', from: reqId, to, provenance: 'unresolved', evidence: [ev], reason: 'No route with this method and path was found in the scanned scope. The server may be outside the scan, behind a proxy, or use a framework without an adapter.' });
  }

  // ---------- stores
  if (rel.has('data')) {
    for (const f of facts) {
      for (const s of f.stores) {
        const from = callerId(f, s.inFn);
        if (s.op === 'unknown' || !s.name) {
          const to = unknownNode(`store:${s.kind}`, s.kind === 'sql' ? 'SQL (dynamic statement)' : `${s.kind} (dynamic)`, 'target decided at runtime');
          b.addEdge({ kind: 'writes', from, to, provenance: 'unresolved', evidence: [{ path: f.path, line: s.line, note: s.note }], reason: 'The statement or key is built at runtime, so the table and whether it reads or writes are unknown.' });
          continue;
        }
        const kind = s.kind === 'queue' ? 'queue' : 'store';
        const sub = { sql: 'SQL table', orm: 'ORM model', kv: 'key-value', queue: 'task queue', 'browser-storage': 'browser storage' }[s.kind];
        const id = stableId(kind, `${s.kind}:${s.name}`);
        b.addNode({ id, kind, label: s.name, sub, layer: 'data', attrs: { storeKind: s.kind } });
        const edgeKind = s.op === 'enqueues' ? 'enqueues' : s.op;
        b.addEdge({ kind: edgeKind, from, to: id, provenance: 'observed', adapter: f.adapter, data: s.data ?? undefined, evidence: [{ path: f.path, line: s.line, note: `${s.note}${s.data ? ` with ${s.data}` : ''}` }] });
      }
    }
  }

  // ---------- agents
  if (rel.has('agents')) linkAgents();

  function linkAgents() {
    const graphNodeIds = new Map<string, Map<string, string>>(); // file#graphVar -> node name -> id
    const implementedBy = new Map<string, string[]>(); // fnId -> agent ids
    const compiledToGraph = new Map<string, string>(); // file#var -> file#graphVar
    const agentVarIds = new Map<string, string>(); // file#var -> agent id (SDK)

    for (const f of facts) {
      for (const g of f.graphs) {
        const gkey = `${f.path}#${g.var}`;
        const names = new Map<string, string>();
        const feature = featureOf(f.path, opts.features);
        const agentNode = (name: string, line: number): string => {
          const id = stableId('agent', `${gkey}:${name}`);
          const terminal = name === '__start__' || name === '__end__';
          b.addNode({ id, kind: 'agent', label: terminal ? name.replace(/_/g, '').toUpperCase() : name, sub: `${g.var} graph`, layer: 'agents', path: f.path, line, feature, module: modId(f.path), adapter: f.adapter, attrs: { graph: g.var, ...(terminal ? { terminal: true } : {}) } });
          names.set(name, id);
          return id;
        };
        agentNode('__start__', g.line);
        for (const n of g.nodes) {
          const id = agentNode(n.name, n.line);
          if (n.fn) {
            const impl = resolveCallee(f.path, null, n.fn);
            if (impl) {
              b.addEdge({ kind: 'implemented_by', from: id, to: impl, provenance: 'observed', adapter: f.adapter, evidence: [{ path: f.path, line: n.line, note: `node "${n.name}" runs ${n.fn}` }] });
              implementedBy.set(impl, [...(implementedBy.get(impl) ?? []), id]);
            }
          }
        }
        const nodeFor = (name: string | null | undefined, line: number): string | null => {
          if (!name) return null;
          return names.get(name) ?? (name === '__end__' || name === '__start__' ? agentNode(name, line) : null);
        };
        if (g.entry?.name) {
          const to = nodeFor(g.entry.name, g.entry.line);
          if (to) b.addEdge({ kind: 'handoff', from: names.get('__start__')!, to, provenance: 'observed', adapter: f.adapter, evidence: [{ path: f.path, line: g.entry.line, note: 'entry point' }] });
        }
        for (const fin of g.finish) {
          const from = nodeFor(fin.name, fin.line);
          if (from) b.addEdge({ kind: 'handoff', from, to: nodeFor('__end__', fin.line)!, provenance: 'observed', adapter: f.adapter, evidence: [{ path: f.path, line: fin.line, note: 'finish point' }] });
        }
        for (const e of g.edges) {
          const from = nodeFor(e.from, e.line);
          if (!from) {
            diagnostics.push({ level: 'warning', code: 'graph-edge-unknown-node', message: 'A graph edge starts at a node name that is not registered or not a literal.', path: f.path, line: e.line });
            continue;
          }
          if (e.kind === 'static') {
            const to = nodeFor(e.to, e.line);
            if (to) b.addEdge({ kind: 'handoff', from, to, provenance: 'observed', adapter: f.adapter, evidence: [{ path: f.path, line: e.line, note: `edge ${e.from} → ${e.to}` }] });
            else {
              const u = unknownNode(`graph:${gkey}:${e.line}`, 'Unknown graph node', 'name not a literal');
              b.addEdge({ kind: 'handoff', from, to: u, provenance: 'unresolved', evidence: [{ path: f.path, line: e.line, note: 'edge target' }], reason: 'The edge target is not a string literal or registered node name.' });
            }
            continue;
          }
          const group = `${f.path}:${e.line}`;
          const routerNote = e.router ? `router ${e.router}` : 'a router';
          const pretty = (v: string | null | undefined) => (v === '__end__' ? 'END' : v === '__start__' ? 'START' : v ?? undefined);
          if (e.options && e.options.length) {
            for (const o of e.options) {
              const to = nodeFor(o.to, o.line);
              if (!to) continue;
              b.addEdge({ kind: 'handoff', from, to, provenance: 'observed', adapter: f.adapter, branchGroup: group, condition: pretty(o.condition ?? o.to), evidence: [{ path: f.path, line: o.line, column: o.col, note: `conditional edge: ${routerNote} result "${o.condition ?? o.to}" → ${o.to}` }] });
            }
            continue;
          }
          // No literal mapping: use string literals the router function returns, if they name registered nodes.
          const routerFnId = e.router ? resolveCallee(f.path, null, e.router) : null;
          const routerFact = routerFnId ? findFn(routerFnId) : null;
          const hits = (routerFact?.fn.returns ?? []).filter((r) => names.has(r.value) || r.value === '__end__');
          for (const h of hits) {
            const to = nodeFor(h.value, h.line)!;
            b.addEdge({
              kind: 'handoff', from, to, provenance: 'inferred', branchGroup: group, condition: pretty(h.value),
              evidence: [{ path: f.path, line: e.line, note: `conditional edge via ${routerNote}` }, { path: routerFact!.file, line: h.line, note: `router returns "${h.value}"` }],
              reason: `${routerNote} returns the literal "${h.value}" (${routerFact!.file}:${h.line}), which is a registered node name. Which branch runs depends on runtime state.`,
            });
          }
          if (!hits.length || e.dynamicMap) {
            const u = unknownNode(`branch:${group}`, 'Runtime-selected branch', 'target computed at runtime');
            b.addEdge({ kind: 'handoff', from, to: u, provenance: 'unresolved', branchGroup: group, condition: 'computed', evidence: [{ path: f.path, line: e.line, note: `conditional edge via ${routerNote}` }], reason: `The branch target is computed by ${routerNote} at runtime and no literal node name could be read from it.` });
          }
        }
        graphNodeIds.set(gkey, names);
      }
      for (const c of f.compiled) compiledToGraph.set(`${f.path}#${c.var}`, `${f.path}#${c.graph}`);
      for (const g of f.graphs) compiledToGraph.set(`${f.path}#${g.var}`, `${f.path}#${g.var}`);
      for (const a of f.sdkAgents) {
        const id = stableId('agent', `${f.path}#${a.var}`);
        b.addNode({ id, kind: 'agent', label: a.name, sub: 'agent', layer: 'agents', path: f.path, line: a.line, feature: featureOf(f.path, opts.features), module: modId(f.path), adapter: f.adapter, attrs: { sdk: true } });
        agentVarIds.set(`${f.path}#${a.var}`, id);
      }
      for (const t of f.tools) {
        const impl = lookupFn(f.path, t.fn);
        const id = stableId('tool', `${f.path}#${t.fn}`);
        b.addNode({ id, kind: 'tool', label: t.name, sub: 'tool', layer: 'agents', path: f.path, line: t.line, feature: featureOf(f.path, opts.features), module: modId(f.path), adapter: f.adapter });
        if (impl) b.addEdge({ kind: 'implemented_by', from: id, to: impl, provenance: 'observed', adapter: f.adapter, evidence: [{ path: f.path, line: t.line, note: `tool ${t.name} is ${t.fn}` }] });
      }
    }

    // SDK handoffs and tools.
    for (const f of facts) {
      for (const a of f.sdkAgents) {
        const from = agentVarIds.get(`${f.path}#${a.var}`)!;
        const group = a.handoffs && a.handoffs.length > 1 ? `${f.path}:${a.line}:handoffs` : undefined;
        for (const h of a.handoffs ?? []) {
          const target = h.ref ? resolveVar(f.path, h.ref) : null;
          const to = target ? agentVarIds.get(`${target.file}#${target.name}`) : undefined;
          if (to) b.addEdge({ kind: 'handoff', from, to, provenance: 'observed', adapter: f.adapter, branchGroup: group, condition: group ? 'agent decides' : undefined, evidence: [{ path: f.path, line: h.line, note: `${a.name} lists ${h.ref} in handoffs` }] });
          else {
            const u = unknownNode(`handoff:${f.path}:${h.line}`, h.ref ? `Unresolved agent ${h.ref}` : 'Unresolved handoff', 'not found in scanned files');
            b.addEdge({ kind: 'handoff', from, to: u, provenance: 'unresolved', branchGroup: group, evidence: [{ path: f.path, line: h.line, note: 'handoff entry' }], reason: h.ref ? `"${h.ref}" is not an agent defined in the scanned files (it may be built by a factory or live outside the scope).` : 'The handoff entry is an expression, not an agent reference.' });
          }
        }
        if (a.handoffsDynamic) {
          const u = unknownNode(`handoff:${f.path}:${a.line}:dyn`, 'Runtime handoff list', 'built at runtime');
          b.addEdge({ kind: 'handoff', from, to: u, provenance: 'unresolved', evidence: [{ path: f.path, line: a.line, note: 'handoffs argument' }], reason: 'The handoffs list is computed at runtime, so its agents cannot be listed statically.' });
        }
        for (const t of a.tools ?? []) {
          if (!t.ref) continue;
          const target = resolveVar(f.path, t.ref);
          if (!target) continue;
          const toolId = stableId('tool', `${target.file}#${target.name}`);
          if (!b.hasNode(toolId)) {
            const impl = lookupFn(target.file, target.name);
            if (!impl) continue;
            b.addNode({ id: toolId, kind: 'tool', label: target.name, sub: 'tool', layer: 'agents', path: target.file, line: findFn(impl)?.fn.line ?? 1, feature: featureOf(target.file, opts.features), module: modId(target.file) });
            b.addEdge({ kind: 'implemented_by', from: toolId, to: impl, provenance: 'observed', evidence: [{ path: f.path, line: t.line, note: `tool ${t.ref}` }] });
          }
          b.addEdge({ kind: 'invokes_tool', from, to: toolId, provenance: 'observed', adapter: f.adapter, evidence: [{ path: f.path, line: t.line, note: `${a.name} lists tool ${t.ref}` }] });
        }
      }
    }

    // Command(goto=...) and handoff(...) calls inside node functions.
    for (const f of facts) {
      for (const c of f.commands) {
        const fnNode = c.inFn ? lookupFn(f.path, c.inFn) : null;
        const owners = fnNode ? implementedBy.get(fnNode) ?? [] : [];
        for (const owner of owners) {
          const graphKey = [...graphNodeIds.entries()].find(([, m]) => [...m.values()].includes(owner));
          if (!c.dynamic && c.goto && graphKey) {
            const to = graphKey[1].get(c.goto);
            if (to) {
              b.addEdge({ kind: 'handoff', from: owner, to, provenance: 'observed', branchGroup: `${f.path}:${c.inFn}:goto`, condition: `goto ${c.goto}`, evidence: [{ path: f.path, line: c.line, note: `Command(goto="${c.goto}")` }] });
              continue;
            }
          }
          const u = unknownNode(`goto:${f.path}:${c.line}`, 'Runtime goto target', 'computed at runtime');
          b.addEdge({ kind: 'handoff', from: owner, to: u, provenance: 'unresolved', branchGroup: `${f.path}:${c.inFn}:goto`, evidence: [{ path: f.path, line: c.line, note: 'goto/handoff call' }], reason: 'The handoff target is a runtime value, so it cannot be resolved statically.' });
        }
        if (c.sdk && c.ref) {
          const target = resolveVar(f.path, c.ref);
          const to = target ? agentVarIds.get(`${target.file}#${target.name}`) : undefined;
          const from = callerId(f, c.inFn);
          if (to) b.addEdge({ kind: 'handoff', from, to, provenance: 'observed', evidence: [{ path: f.path, line: c.line, note: `handoff(${c.ref})` }] });
        }
      }
      // Invoking compiled graphs or SDK agents from ordinary code.
      for (const inv of f.graphInvokes) {
        if (!inv.target) continue;
        const target = resolveVar(f.path, inv.target.replace(/\(\)$/, ''));
        if (!target) continue;
        const from = callerId(f, inv.inFn);
        const gk = compiledToGraph.get(`${target.file}#${target.name}`);
        const start = gk ? graphNodeIds.get(gk)?.get('__start__') : undefined;
        const agent = agentVarIds.get(`${target.file}#${target.name}`);
        const to = start ?? agent;
        if (to) b.addEdge({ kind: 'calls', from, to, provenance: 'observed', evidence: [{ path: f.path, line: inv.line, note: `${inv.via} on ${inv.target}` }] });
      }
    }
  }

  function findFn(id: string): { file: string; fn: FunctionFact } | null {
    const node = b.nodes.get(id);
    if (!node?.path) return null;
    const m = fnIndex.get(node.path);
    const fn = m?.get(node.label);
    return fn ? { file: node.path, fn } : null;
  }

  return { builder: b, diagnostics, externalPackages };
}

export function displayUrl(u: UrlShape): string {
  if (u.kind === 'dynamic' || !u.value) return '(dynamic URL)';
  const { host, path: p } = splitUrl(u.value);
  const clean = p.replace(/[?#].*$/, '') || '/';
  const shown = u.kind === 'partial' ? `{base}${clean.startsWith('/') ? '' : '/'}${clean}` : clean;
  return host ? `//${host}${shown}` : shown;
}

export type { GraphNode };
