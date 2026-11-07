import { readFileSync } from 'node:fs';
import { parse, type ParserPlugin } from '@babel/parser';
import { emptyFacts, type FileFacts, type LanguageAdapter, type UrlShape } from '../facts.ts';

/* Minimal AST typing: we walk Babel's ESTree-like output generically. */
type N = { type: string; loc?: { start: { line: number; column: number } }; [k: string]: any };

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const ROUTE_METHODS = new Set([...HTTP_METHODS, 'all']);
const FRAMEWORK_HINTS: Record<string, string> = {
  react: 'react', 'react-dom': 'react', vue: 'vue', svelte: 'svelte', next: 'next', '@angular/core': 'angular',
  express: 'express', fastify: 'fastify', koa: 'koa', hono: 'hono', '@nestjs/core': 'nestjs', axios: 'axios',
  '@openai/agents': 'openai-agents', '@langchain/langgraph': 'langgraph', 'socket.io': 'socket.io', 'graphql': 'graphql',
  '@trpc/server': 'trpc', '@trpc/client': 'trpc',
};

function line(n: N | undefined): number {
  return n?.loc?.start.line ?? 1;
}

function dotted(n: N | undefined | null): string | null {
  if (!n) return null;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
    if (n.computed) return null;
    const obj = dotted(n.object);
    const prop = n.property?.type === 'Identifier' ? n.property.name : null;
    return obj && prop ? `${obj}.${prop}` : null;
  }
  if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
    const inner = dotted(n.callee);
    return inner ? `${inner}()` : null;
  }
  if (n.type === 'TSNonNullExpression' || n.type === 'TSAsExpression' || n.type === 'ParenthesizedExpression') return dotted(n.expression);
  return null;
}

function strValue(n: N | undefined | null): string | null {
  if (!n) return null;
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis.map((q: N) => q.value.cooked ?? '').join('');
  return null;
}

function urlShape(n: N | undefined | null): UrlShape {
  if (!n) return { kind: 'dynamic' };
  const s = strValue(n);
  if (s !== null) return { kind: 'literal', value: s };
  if (n.type === 'TemplateLiteral') {
    let out = '';
    n.quasis.forEach((q: N, i: number) => {
      out += q.value.cooked ?? '';
      if (i < n.expressions.length) out += '{}';
    });
    const firstEmpty = (n.quasis[0]?.value.cooked ?? '') === '' && n.expressions.length > 0;
    return firstEmpty ? { kind: 'partial', value: out.slice(2) } : { kind: 'template', value: out };
  }
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const right = strValue(n.right);
    const left = strValue(n.left);
    if (right !== null && left === null) {
      const inner = urlShape(n.left);
      if (inner.kind === 'literal' || inner.kind === 'template') return { kind: 'template', value: (inner.value ?? '') + right };
      return { kind: 'partial', value: right };
    }
    if (left !== null) return { kind: 'template', value: left + '{}' };
  }
  if (n.type === 'TSAsExpression' || n.type === 'ParenthesizedExpression') return urlShape(n.expression);
  return { kind: 'dynamic' };
}

function describeData(n: N | undefined | null): string | null {
  if (!n) return null;
  if ((n.type === 'CallExpression') && dotted(n.callee) === 'JSON.stringify') return describeData(n.arguments[0]);
  const d = dotted(n);
  if (d && d.length <= 60) return d;
  if (n.type === 'ObjectExpression') {
    const keys = n.properties
      .map((p: N) => (p.type === 'ObjectProperty' && !p.computed ? (p.key.type === 'Identifier' ? p.key.name : strValue(p.key)) : p.type === 'SpreadElement' ? `...${dotted(p.argument) ?? ''}` : null))
      .filter((k: string | null): k is string => !!k && /^[.A-Za-z_$][\w$.-]*$/.test(k));
    if (keys.length) return `{${keys.slice(0, 6).join(', ')}}`;
  }
  return null;
}

function prop(obj: N | undefined, name: string): N | undefined {
  if (!obj || obj.type !== 'ObjectExpression') return undefined;
  for (const p of obj.properties) {
    if (p.type === 'ObjectProperty' && !p.computed && ((p.key.type === 'Identifier' && p.key.name === name) || strValue(p.key) === name)) return p.value;
  }
  return undefined;
}

function identList(n: N | undefined): { ref: string | null; line: number }[] | null {
  if (!n || n.type !== 'ArrayExpression') return null;
  return n.elements.filter(Boolean).map((e: N) => ({ ref: dotted(e), line: line(e) }));
}

function pluginsFor(rel: string): ParserPlugin[] {
  const isTs = /\.(ts|tsx|mts|cts)$/.test(rel);
  const plugins: ParserPlugin[] = ['decorators-legacy', 'classProperties', 'dynamicImport', 'topLevelAwait', 'importAttributes' as ParserPlugin];
  if (isTs) plugins.push('typescript');
  if (!isTs || rel.endsWith('.tsx')) plugins.push('jsx');
  if (!isTs) plugins.push('flow' as ParserPlugin);
  return plugins;
}

export function extractJs(rel: string, text: string): FileFacts {
  const language = /\.(ts|tsx|mts|cts)$/.test(rel) ? 'typescript' : 'javascript';
  const facts = emptyFacts(rel, language, 'js.babel');
  let ast: N;
  try {
    ast = parse(text, { sourceType: 'unambiguous', errorRecovery: true, plugins: pluginsFor(rel) }) as unknown as N;
  } catch (e) {
    const err = e as { loc?: { line: number } };
    facts.error = { line: err.loc?.line ?? 1, message: 'syntax error' };
    return facts;
  }

  const fetchLike = new Set(['fetch', 'window.fetch', 'globalThis.fetch', 'self.fetch']);
  const axiosNames = new Set<string>();
  const httpInstances = new Set<string>();
  const expressApps = new Set<string>();
  const routers = new Set<string>();
  const agentNames = new Map<string, string>();
  const frameworks = new Set<string>();
  const scope: string[] = [];
  let anon = 0;

  const fnName = () => (scope.length ? scope.join('.') : null);

  const addFunction = (name: string, n: N, opts: { exported?: boolean; cls?: string | null; isClass?: boolean } = {}) => {
    const qual = scope.length ? `${scope.join('.')}.${name}` : name;
    facts.functions.push({
      name, qual, line: line(n), endLine: n.loc ? (n as any).loc.end.line : line(n),
      params: (n.params ?? []).map((p: N) => ({ name: p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left.name : '…', type: null })),
      cls: opts.cls ?? null, isClass: opts.isClass, exported: opts.exported,
    });
    return name;
  };

  const handleCall = (n: N) => {
    const callee = dotted(n.callee);
    const fn = fnName();
    if (callee) facts.calls.push({ inFn: fn, callee, line: line(n) });

    // require('x') / import('x')
    if (n.callee.type === 'Identifier' && n.callee.name === 'require' && strValue(n.arguments[0])) {
      facts.imports.push({ module: strValue(n.arguments[0])!, level: 0, names: [], alias: null, line: line(n), kind: 'require' });
      return;
    }
    if (n.callee.type === 'Import' && strValue(n.arguments[0])) {
      facts.imports.push({ module: strValue(n.arguments[0])!, level: 0, names: [], alias: null, line: line(n), kind: 'dynamic' });
      return;
    }
    if (!callee) return;
    const parts = callee.split('.');
    const meth = parts[parts.length - 1];
    const owner = parts.length > 1 ? parts.slice(0, -1).join('.') : null;

    // fetch(url, { method, body })
    if (fetchLike.has(callee)) {
      const opts = n.arguments[1];
      const m = strValue(prop(opts, 'method'));
      facts.requests.push({
        inFn: fn, method: (m ?? (prop(opts, 'method') ? '?' : 'GET')).toUpperCase(), url: urlShape(n.arguments[0]), line: line(n),
        client: 'fetch', data: describeData(prop(opts, 'body')),
      });
      return;
    }
    // axios(url|config), axios.get(url, ...), instance.post(url, data)
    if (axiosNames.has(callee)) {
      const a0 = n.arguments[0];
      if (a0?.type === 'ObjectExpression') {
        facts.requests.push({ inFn: fn, method: (strValue(prop(a0, 'method')) ?? 'GET').toUpperCase(), url: urlShape(prop(a0, 'url')), line: line(n), client: 'axios', data: describeData(prop(a0, 'data')) });
      } else {
        facts.requests.push({ inFn: fn, method: 'GET', url: urlShape(a0), line: line(n), client: 'axios', data: null });
      }
      return;
    }
    if (owner && (axiosNames.has(owner) || httpInstances.has(owner)) && (HTTP_METHODS.has(meth) || meth === 'request')) {
      const withBody = meth === 'post' || meth === 'put' || meth === 'patch';
      facts.requests.push({
        inFn: fn, method: meth === 'request' ? (strValue(prop(n.arguments[0], 'method')) ?? 'GET').toUpperCase() : meth.toUpperCase(),
        url: meth === 'request' ? urlShape(prop(n.arguments[0], 'url')) : urlShape(n.arguments[0]), line: line(n), client: owner,
        data: withBody ? describeData(n.arguments[1]) : null,
      });
      return;
    }
    // Express-style routes: app.get('/x', handler)
    if (owner && (expressApps.has(owner) || routers.has(owner)) && ROUTE_METHODS.has(meth) && strValue(n.arguments[0]) !== null) {
      const handlerNode = n.arguments[n.arguments.length - 1];
      let handler = dotted(handlerNode);
      if (!handler && handlerNode && /Function|Arrow/.test(handlerNode.type)) {
        handler = `route_${meth}_${++anon}`;
        addFunction(handler, handlerNode);
        walkFn(handlerNode, handler);
      }
      if (handler) {
        facts.routes.push({ method: meth === 'all' ? 'ANY' : meth.toUpperCase(), path: strValue(n.arguments[0])!, handler, owner, line: line(n), framework: 'express' });
      }
      return;
    }
    if (owner && (expressApps.has(owner) || routers.has(owner)) && meth === 'use' && n.arguments.length >= 2 && strValue(n.arguments[0]) !== null) {
      const ref = dotted(n.arguments[n.arguments.length - 1]);
      if (ref) facts.includes.push({ router: ref, prefix: strValue(n.arguments[0])!, owner, line: line(n) });
      return;
    }
    // Browser storage
    if ((owner === 'localStorage' || owner === 'sessionStorage' || owner === 'window.localStorage' || owner === 'window.sessionStorage') && (meth === 'setItem' || meth === 'getItem' || meth === 'removeItem')) {
      facts.stores.push({ inFn: fn, op: meth === 'getItem' ? 'reads' : 'writes', kind: 'browser-storage', name: owner.replace('window.', ''), line: line(n), data: meth === 'setItem' ? describeData(n.arguments[1]) : null, note: `${owner}.${meth}` });
      return;
    }
    // Agents SDK: run(agent, input)
    if ((callee === 'run' || callee === 'Runner.run' || meth === 'run' && owner === 'runner') && n.arguments[0]) {
      const ref = dotted(n.arguments[0]);
      if (ref && agentNames.has(ref)) facts.graphInvokes.push({ inFn: fn, target: ref, line: line(n), via: callee, agent: true });
    }
    if ((meth === 'handoff' || meth === 'transferTo') && n.arguments[0]) {
      const ref = dotted(n.arguments[0]);
      facts.commands.push({ inFn: fn, goto: null, ref, line: line(n), dynamic: ref === null, sdk: true });
    }
  };

  const handleNew = (n: N, target: string | null) => {
    const ctor = dotted(n.callee);
    if (ctor === 'Agent' && target) {
      const cfg = n.arguments[0];
      const handoffsNode = prop(cfg, 'handoffs');
      const toolsNode = prop(cfg, 'tools');
      const name = strValue(prop(cfg, 'name')) ?? target;
      agentNames.set(target, name);
      facts.sdkAgents.push({
        var: target, name, line: line(n),
        handoffs: handoffsNode ? identList(handoffsNode) : [], handoffsDynamic: !!handoffsNode && !identList(handoffsNode),
        tools: toolsNode ? identList(toolsNode) : [], toolsDynamic: !!toolsNode && !identList(toolsNode),
      });
    }
  };

  const handleInit = (target: string, init: N) => {
    if (!init) return;
    if (init.type === 'CallExpression') {
      const c = dotted(init.callee);
      if (c && (axiosNames.has(c.replace(/\.create$/, '')) && c.endsWith('.create'))) httpInstances.add(target);
      if (c === 'express') expressApps.add(target);
      if (c === 'express.Router' || c === 'Router') routers.add(target);
      if (c === 'Agent.create') handleNew({ ...init, callee: { type: 'Identifier', name: 'Agent' } }, target);
      if (c === 'tool' || c === 'createTool') facts.tools.push({ fn: target, name: strValue(prop(init.arguments[0], 'name')) ?? target, line: line(init) });
    }
    if (init.type === 'NewExpression') handleNew(init, target);
  };

  function walkFn(fnNode: N, name: string) {
    scope.push(name);
    visit(fnNode.body);
    scope.pop();
  }

  function visit(n: any): void {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    if (typeof n.type !== 'string') return;
    switch (n.type) {
      case 'ImportDeclaration': {
        const mod = n.source.value as string;
        const names: { imported: string; local: string }[] = [];
        let alias: string | null = null;
        for (const s of n.specifiers) {
          if (s.type === 'ImportDefaultSpecifier') { names.push({ imported: 'default', local: s.local.name }); alias = alias ?? null; }
          else if (s.type === 'ImportNamespaceSpecifier') alias = s.local.name;
          else names.push({ imported: s.imported.type === 'Identifier' ? s.imported.name : s.imported.value, local: s.local.name });
        }
        if (mod === 'axios') {
          for (const nm of names) if (nm.imported === 'default') axiosNames.add(nm.local);
          if (alias) axiosNames.add(alias);
        }
        if (mod === 'express') for (const nm of names) if (nm.imported === 'Router') routers.add('__ctor__');
        const fw = FRAMEWORK_HINTS[mod] ?? FRAMEWORK_HINTS[mod.split('/')[0]];
        if (fw) frameworks.add(fw);
        facts.imports.push({ module: mod, level: 0, names, alias, line: line(n), kind: 'es' });
        return;
      }
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration': {
        const d = n.declaration;
        if (n.type === 'ExportDefaultDeclaration') facts.defaultExport = d?.id?.name ?? (d?.type === 'Identifier' ? d.name : 'default');
        if (d && (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') ) {
          const name = d.id?.name ?? 'default';
          if (d.type === 'FunctionDeclaration') { addFunction(name, d, { exported: true }); walkFn(d, name); }
          else visitClass(d, name, true);
          return;
        }
        if (d && d.type === 'VariableDeclaration') { visitVarDecl(d, true); return; }
        if (n.source && strValue(n.source)) facts.imports.push({ module: n.source.value, level: 0, names: [], alias: null, line: line(n), kind: 'es' });
        if (d && /Function|Arrow/.test(d.type)) { addFunction('default', d, { exported: true }); walkFn(d, 'default'); return; }
        visit(d);
        return;
      }
      case 'ExportAllDeclaration':
        facts.imports.push({ module: n.source.value, level: 0, names: [], alias: null, line: line(n), kind: 'es' });
        return;
      case 'FunctionDeclaration': {
        const name = n.id?.name ?? `anonymous_${++anon}`;
        addFunction(name, n);
        walkFn(n, name);
        return;
      }
      case 'ClassDeclaration':
        visitClass(n, n.id?.name ?? `Class_${++anon}`, false);
        return;
      case 'VariableDeclaration':
        visitVarDecl(n, false);
        return;
      case 'CallExpression':
      case 'OptionalCallExpression':
        handleCall(n);
        break;
      case 'NewExpression':
        break;
      case 'JSXElement':
      case 'JSXFragment':
        facts.jsx = true;
        break;
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const v = n[key];
      if (v && typeof v === 'object') visit(v);
    }
  }

  function visitVarDecl(d: N, exported: boolean) {
    for (const decl of d.declarations) {
      const target = decl.id?.type === 'Identifier' ? decl.id.name : null;
      const init = decl.init;
      if (target && init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
        addFunction(target, init, { exported });
        walkFn(init, target);
        continue;
      }
      // React.memo(() => ...), forwardRef(...), useCallback(() => ...)
      if (target && init?.type === 'CallExpression' && init.arguments.some((a: N) => a && /ArrowFunction|FunctionExpression/.test(a.type)) && !scope.length) {
        const fnArg = init.arguments.find((a: N) => a && /ArrowFunction|FunctionExpression/.test(a.type));
        handleCall(init);
        addFunction(target, fnArg, { exported });
        walkFn(fnArg, target);
        continue;
      }
      if (target) handleInit(target, init);
      if (target && init?.type === 'NewExpression') {
        visit(init.arguments);
        continue;
      }
      visit(init);
    }
  }

  function visitClass(c: N, name: string, exported: boolean) {
    addFunction(name, c, { exported, isClass: true });
    scope.push(name);
    for (const m of c.body.body) {
      if ((m.type === 'ClassMethod' || m.type === 'ClassPrivateMethod') && m.key) {
        const mname = m.key.type === 'Identifier' ? m.key.name : m.key.type === 'PrivateName' ? `#${m.key.id.name}` : strValue(m.key) ?? 'method';
        addFunction(mname, m, { cls: name });
        walkFn(m, mname);
      } else if (m.type === 'ClassProperty' && m.value && /Arrow|FunctionExpression/.test(m.value.type) && m.key?.type === 'Identifier') {
        addFunction(m.key.name, m.value, { cls: name });
        walkFn(m.value, m.key.name);
      } else visit(m);
    }
    scope.pop();
  }

  // First pass: collect axios/express/agent bindings declared anywhere at top level, so order does not matter.
  for (const stmt of ast.program.body as N[]) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (stmt.type === 'ImportDeclaration' && stmt.source.value === 'axios') {
      for (const s of stmt.specifiers) axiosNames.add(s.local.name);
    }
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id?.type !== 'Identifier' || !d.init) continue;
        if (d.init.type === 'CallExpression' && dotted(d.init.callee) === 'require' && strValue(d.init.arguments[0]) === 'axios') axiosNames.add(d.id.name);
      }
    }
  }
  for (const stmt of ast.program.body as N[]) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) if (d.id?.type === 'Identifier' && d.init) handleInit(d.id.name, d.init);
    }
  }
  // handleInit ran once already for agents; reset to avoid duplicate SDK agents in the full walk.
  facts.sdkAgents = [];
  facts.tools = [];
  agentNames.clear();
  if (ast.errors?.length) facts.error = { line: ast.errors[0].loc?.line ?? 1, message: `recovered from ${ast.errors.length} syntax error(s)` };
  visit(ast.program.body);
  facts.frameworks = [...frameworks].sort();
  return facts;
}

export function jsAdapter(): LanguageAdapter {
  return {
    id: 'js.babel',
    language: 'javascript',
    extensions: ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'],
    available: () => ({ ok: true }),
    async extract(files) {
      return files.map((f) => {
        let text: string;
        try {
          text = readFileSync(f.abs, 'utf8');
        } catch {
          const facts = emptyFacts(f.rel, 'javascript', 'js.babel');
          facts.error = { line: 1, message: 'unreadable' };
          return facts;
        }
        return extractJs(f.rel, text);
      });
    },
  };
}
