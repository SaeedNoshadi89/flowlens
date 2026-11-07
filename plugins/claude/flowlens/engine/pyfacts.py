"""FlowLens Python fact extractor.

Reads a JSON list of {"rel", "abs"} on stdin and prints one JSON object of
facts per line. Uses only the standard library `ast` module: the analyzed code
is parsed, never imported or executed. String values are reported only when
they are route paths, URL paths, SQL table names or graph node names, never
whole literals or configuration values.
"""

import ast
import json
import re
import sys

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}
ROUTE_DECORATOR_METHODS = HTTP_METHODS | {"api_route", "websocket", "route"}
HTTP_CLIENT_MODULES = {"requests", "httpx", "aiohttp"}
SQL_RE = re.compile(
    r"^\s*(select\b.*?\bfrom|insert\s+into|update|delete\s+from|replace\s+into|create\s+table(?:\s+if\s+not\s+exists)?)\s+[`\"\[]?([A-Za-z_][\w.]*)",
    re.I | re.S,
)
GRAPH_INVOKE = {"invoke", "ainvoke", "stream", "astream", "batch", "abatch", "run"}
KV_WRITE = {"set", "hset", "lpush", "rpush", "sadd", "zadd", "xadd", "publish", "setex", "mset", "incr", "expire"}
KV_READ = {"get", "hget", "hgetall", "lrange", "smembers", "zrange", "xread", "mget", "keys", "exists"}


def dotted(node):
    """Return a dotted name for Name/Attribute chains, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    if isinstance(node, ast.Call):
        inner = dotted(node.func)
        if inner:
            parts.append(inner + "()")
            return ".".join(reversed(parts))
    return None


def str_value(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def url_shape(node):
    """Describe a URL expression without copying non-path content."""
    s = str_value(node)
    if s is not None:
        return {"kind": "literal", "value": s}
    if isinstance(node, ast.JoinedStr):
        out = []
        leading_dynamic = False
        for i, v in enumerate(node.values):
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                out.append(v.value)
            else:
                if i == 0:
                    leading_dynamic = True
                out.append("{}")
        value = "".join(out)
        if leading_dynamic:
            return {"kind": "partial", "value": value[2:] if value.startswith("{}") else value}
        return {"kind": "template", "value": value}
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        right = str_value(node.right)
        left = str_value(node.left)
        if right is not None and left is None:
            return {"kind": "partial", "value": right}
        if left is not None:
            return {"kind": "template", "value": left + "{}"}
    return {"kind": "dynamic"}


def kw(call, name):
    for k in call.keywords:
        if k.arg == name:
            return k.value
    return None


def ident_list(node):
    """Names referenced in a list/tuple literal, or None if not a literal list."""
    if isinstance(node, (ast.List, ast.Tuple)):
        out = []
        for e in node.elts:
            d = dotted(e)
            if d:
                out.append({"ref": d, "line": e.lineno})
            else:
                out.append({"ref": None, "line": getattr(e, "lineno", 0)})
        return out
    return None


def describe_data(node):
    """Name what is passed, only when it is an identifier or attribute."""
    if node is None:
        return None
    d = dotted(node)
    if d and len(d) <= 60:
        return d
    if isinstance(node, ast.Dict):
        keys = [str_value(k) for k in node.keys if k is not None]
        keys = [k for k in keys if k and re.match(r"^[A-Za-z_][\w-]*$", k)]
        if keys:
            return "{" + ", ".join(keys[:6]) + "}"
    return None


class Extractor(ast.NodeVisitor):
    def __init__(self, rel):
        self.rel = rel
        self.facts = {
            "path": rel,
            "imports": [],
            "functions": [],
            "calls": [],
            "routes": [],
            "routers": [],
            "includes": [],
            "requests": [],
            "stores": [],
            "graphs": [],
            "compiled": [],
            "graphInvokes": [],
            "sdkAgents": [],
            "tools": [],
            "commands": [],
            "assignments": [],
            "frameworks": [],
        }
        self.scope = []  # stack of qualified names (functions/classes)
        self.class_stack = []
        self.fastapi_apps = set()
        self.routers = {}
        self.http_aliases = set()  # local names bound to requests/httpx modules
        self.http_clients = set()  # variables holding httpx.Client()/AsyncClient()/Session()
        self.graph_vars = {}  # var -> graph dict
        self.sqlite_conns = {}
        self.redis_vars = set()
        self.session_vars = set()
        self.tool_fns = set()
        self.local_returns = {}  # function qual -> list of returned string literals

    # ---- helpers
    def current_fn(self):
        return self.scope[-1] if self.scope else None

    def qual(self, name):
        return ".".join(self.scope + [name]) if self.scope else name

    # ---- imports
    def visit_Import(self, node):
        for a in node.names:
            self.facts["imports"].append(
                {"module": a.name, "level": 0, "names": [], "alias": a.asname or a.name.split(".")[0], "line": node.lineno, "kind": "import"}
            )
            top = a.name.split(".")[0]
            if top in HTTP_CLIENT_MODULES:
                self.http_aliases.add(a.asname or top)
            if top in ("fastapi", "flask", "django", "langgraph", "agents", "crewai", "autogen", "celery", "redis", "sqlalchemy", "sqlite3"):
                self.facts["frameworks"].append(top)

    def visit_ImportFrom(self, node):
        mod = node.module or ""
        names = [{"imported": a.name, "local": a.asname or a.name} for a in node.names]
        self.facts["imports"].append(
            {"module": mod, "level": node.level or 0, "names": names, "alias": None, "line": node.lineno, "kind": "from"}
        )
        top = mod.split(".")[0]
        if top in ("fastapi", "flask", "django", "langgraph", "agents", "crewai", "autogen", "celery", "redis", "sqlalchemy", "sqlite3", "langchain", "starlette"):
            self.facts["frameworks"].append(top)
        if top in HTTP_CLIENT_MODULES:
            for n in names:
                if n["imported"] in HTTP_METHODS:
                    self.http_aliases.add("__fn__" + n["local"])
                if n["imported"] in ("Client", "AsyncClient", "Session"):
                    self.http_aliases.add("__ctor__" + n["local"])

    # ---- definitions
    def _visit_function(self, node):
        q = self.qual(node.name)
        decorators = []
        for d in node.decorator_list:
            target = d.func if isinstance(d, ast.Call) else d
            name = dotted(target) or ""
            decorators.append(name)
            if isinstance(d, ast.Call) and isinstance(target, ast.Attribute):
                owner = dotted(target.value)
                meth = target.attr
                if meth in ROUTE_DECORATOR_METHODS and owner and d.args:
                    path = str_value(d.args[0])
                    if path is not None:
                        methods = [meth.upper()]
                        if meth in ("api_route", "route"):
                            mv = kw(d, "methods")
                            if isinstance(mv, (ast.List, ast.Tuple)):
                                methods = [str_value(e).upper() for e in mv.elts if str_value(e)] or ["GET"]
                            else:
                                methods = ["GET"]
                        if meth == "websocket":
                            methods = ["WS"]
                        framework = "fastapi" if owner in self.fastapi_apps or owner in self.routers else (
                            "flask" if meth == "route" else "fastapi?"
                        )
                        for m in methods:
                            self.facts["routes"].append(
                                {"method": m, "path": path, "handler": q, "owner": owner, "line": d.lineno, "framework": framework}
                            )
            if name.endswith("function_tool") or name in ("tool", "langchain.tools.tool") or name.endswith(".tool"):
                self.tool_fns.add(q)
                self.facts["tools"].append({"fn": q, "name": node.name, "line": node.lineno})
        params = []
        for a in node.args.args + node.args.kwonlyargs:
            if a.arg in ("self", "cls"):
                continue
            ann = dotted(a.annotation) if a.annotation is not None else None
            params.append({"name": a.arg, "type": ann})
        self.facts["functions"].append(
            {
                "name": node.name,
                "qual": q,
                "line": node.lineno,
                "endLine": getattr(node, "end_lineno", node.lineno),
                "decorators": decorators,
                "params": params,
                "cls": self.class_stack[-1] if self.class_stack else None,
                "async": isinstance(node, ast.AsyncFunctionDef),
            }
        )
        self.scope.append(node.name)
        returns = []
        for sub in ast.walk(node):
            if isinstance(sub, ast.Return) and sub.value is not None:
                s = str_value(sub.value)
                if s is not None and re.match(r"^[A-Za-z_][\w-]{0,60}$", s):
                    returns.append({"value": s, "line": sub.lineno})
        self.local_returns[q] = returns
        self.facts["functions"][-1]["returns"] = returns
        self.generic_visit(node)
        self.scope.pop()

    visit_FunctionDef = _visit_function
    visit_AsyncFunctionDef = _visit_function

    def visit_ClassDef(self, node):
        self.facts["functions"].append(
            {"name": node.name, "qual": self.qual(node.name), "line": node.lineno, "endLine": getattr(node, "end_lineno", node.lineno),
             "decorators": [], "params": [], "cls": None, "isClass": True, "returns": []}
        )
        self.scope.append(node.name)
        self.class_stack.append(node.name)
        self.generic_visit(node)
        self.class_stack.pop()
        self.scope.pop()

    # ---- assignments that create known objects
    def visit_Assign(self, node):
        if isinstance(node.value, ast.Call):
            ctor = dotted(node.value.func) or ""
            short = ctor.split(".")[-1]
            for t in node.targets:
                name = dotted(t)
                if not name:
                    continue
                if short == "FastAPI" or short == "Flask":
                    self.fastapi_apps.add(name)
                elif short == "APIRouter" or short == "Blueprint":
                    prefix = str_value(kw(node.value, "prefix")) or (str_value(kw(node.value, "url_prefix")) or "")
                    self.routers[name] = prefix
                    self.facts["routers"].append({"var": name, "prefix": prefix, "line": node.lineno})
                elif short == "StateGraph" or short == "Graph" and ctor.endswith("Graph"):
                    g = {"var": name, "line": node.lineno, "nodes": [], "edges": [], "entry": None, "finish": []}
                    self.graph_vars[name] = g
                    self.facts["graphs"].append(g)
                elif short == "compile" and isinstance(node.value.func, ast.Attribute):
                    owner = dotted(node.value.func.value)
                    if owner in self.graph_vars:
                        self.facts["compiled"].append({"var": name, "graph": owner, "line": node.lineno})
                elif short == "connect" and ctor.startswith("sqlite3"):
                    self.sqlite_conns[name] = "sqlite"
                elif short in ("Redis", "StrictRedis", "from_url") and "redis" in ctor.lower():
                    self.redis_vars.add(name)
                elif short in ("Session", "sessionmaker", "AsyncSession") and "requests" not in ctor:
                    self.session_vars.add(name)
                elif ctor and (ctor.split(".")[0] in self.http_aliases) and short in ("Client", "AsyncClient", "Session"):
                    self.http_clients.add(name)
                elif ("__ctor__" + ctor) in self.http_aliases:
                    self.http_clients.add(name)
                elif short == "Agent":
                    self._sdk_agent(name, node.value)
                elif short == "cursor" and isinstance(node.value.func, ast.Attribute):
                    owner = dotted(node.value.func.value)
                    if owner in self.sqlite_conns:
                        self.sqlite_conns[name] = "sqlite"
            if not self.scope:
                for t in node.targets:
                    name = dotted(t)
                    if name:
                        self.facts["assignments"].append({"var": name, "ctor": ctor, "line": node.lineno})
        self.generic_visit(node)

    def visit_With(self, node):
        for item in node.items:
            if isinstance(item.context_expr, ast.Call) and item.optional_vars is not None:
                ctor = dotted(item.context_expr.func) or ""
                name = dotted(item.optional_vars)
                short = ctor.split(".")[-1]
                if name and ctor.split(".")[0] in self.http_aliases and short in ("Client", "AsyncClient", "Session"):
                    self.http_clients.add(name)
                elif name and short == "connect" and ctor.startswith("sqlite3"):
                    self.sqlite_conns[name] = "sqlite"
                elif name and short in ("Session", "AsyncSession", "begin"):
                    self.session_vars.add(name)
        self.generic_visit(node)

    visit_AsyncWith = visit_With

    def _sdk_agent(self, var, call):
        name = str_value(kw(call, "name")) or (str_value(call.args[0]) if call.args else None) or var
        handoffs_node = kw(call, "handoffs")
        tools_node = kw(call, "tools")
        handoffs = ident_list(handoffs_node) if handoffs_node is not None else []
        tools = ident_list(tools_node) if tools_node is not None else []
        self.facts["sdkAgents"].append(
            {
                "var": var,
                "name": name,
                "line": call.lineno,
                "handoffs": handoffs,
                "handoffsDynamic": handoffs_node is not None and handoffs is None,
                "tools": tools,
                "toolsDynamic": tools_node is not None and tools is None,
                "fn": self.current_fn() and ".".join(self.scope),
            }
        )

    # ---- calls
    def visit_Call(self, node):
        fn = ".".join(self.scope) if self.scope else None
        callee = dotted(node.func)
        if callee:
            self.facts["calls"].append({"inFn": fn, "callee": callee, "line": node.lineno})
            self._classify_call(node, callee, fn)
        self.generic_visit(node)

    def _classify_call(self, node, callee, fn):
        parts = callee.split(".")
        meth = parts[-1]
        owner = ".".join(parts[:-1]) if len(parts) > 1 else None

        # include_router(router, prefix="/api")
        if meth in ("include_router", "register_blueprint") and node.args:
            ref = dotted(node.args[0])
            prefix = str_value(kw(node, "prefix")) or str_value(kw(node, "url_prefix")) or ""
            if ref:
                self.facts["includes"].append({"router": ref, "prefix": prefix, "owner": owner, "line": node.lineno})
            return

        # Outbound HTTP
        is_http = False
        if owner and (owner in self.http_aliases or owner in self.http_clients) and meth in HTTP_METHODS | {"request"}:
            is_http = True
        if not owner and ("__fn__" + meth) in self.http_aliases:
            is_http = True
        if owner and owner.endswith("()") and owner[:-2].split(".")[0] in self.http_aliases:
            is_http = meth in HTTP_METHODS
        if is_http:
            if meth == "request":
                method = (str_value(node.args[0]) or "?").upper() if node.args else "?"
                url_node = node.args[1] if len(node.args) > 1 else kw(node, "url")
            else:
                method = meth.upper()
                url_node = node.args[0] if node.args else kw(node, "url")
            data = describe_data(kw(node, "json")) or describe_data(kw(node, "data"))
            self.facts["requests"].append(
                {"inFn": fn, "method": method, "url": url_shape(url_node) if url_node is not None else {"kind": "dynamic"},
                 "line": node.lineno, "client": owner or meth, "data": data}
            )
            return

        # SQL through execute()
        if meth in ("execute", "executemany", "executescript") and node.args:
            sql = str_value(node.args[0])
            if sql is None and isinstance(node.args[0], ast.Call):
                sql = str_value(node.args[0].args[0]) if node.args[0].args else None  # text("...")
            if sql is not None:
                m = SQL_RE.match(sql)
                if m:
                    verb = m.group(1).split()[0].lower()
                    table = m.group(2)
                    op = "reads" if verb == "select" else "writes"
                    data = describe_data(node.args[1]) if len(node.args) > 1 else None
                    self.facts["stores"].append(
                        {"inFn": fn, "op": op, "kind": "sql", "name": table, "line": node.lineno, "data": data,
                         "note": f"SQL {verb.upper()} on table {table}"}
                    )
                    return
            elif owner and (owner in self.sqlite_conns or owner in self.session_vars):
                self.facts["stores"].append(
                    {"inFn": fn, "op": "unknown", "kind": "sql", "name": None, "line": node.lineno, "data": None,
                     "note": "SQL statement is not a literal"}
                )
                return

        # ORM session use
        if owner and (owner in self.session_vars or owner.split(".")[-1] in ("session", "db", "db_session")):
            if meth in ("add", "add_all", "merge", "delete") and node.args:
                arg = node.args[0]
                data = describe_data(arg)
                model = None
                if isinstance(arg, ast.Call):
                    model = dotted(arg.func)
                self.facts["stores"].append(
                    {"inFn": fn, "op": "writes", "kind": "orm", "name": model, "line": node.lineno, "data": data,
                     "note": f"ORM session.{meth}"}
                )
                return
            if meth in ("query", "get", "scalars", "scalar") and node.args:
                model = dotted(node.args[0])
                if model and model[0].isupper():
                    self.facts["stores"].append(
                        {"inFn": fn, "op": "reads", "kind": "orm", "name": model, "line": node.lineno, "data": None,
                         "note": f"ORM session.{meth}"}
                    )
                    return

        # Key-value store
        if owner and owner in self.redis_vars and (meth in KV_WRITE or meth in KV_READ):
            key = str_value(node.args[0]) if node.args else None
            prefix = key.split(":")[0] if key and ":" in key and re.match(r"^[A-Za-z_][\w-]*$", key.split(":")[0]) else None
            self.facts["stores"].append(
                {"inFn": fn, "op": "writes" if meth in KV_WRITE else "reads", "kind": "kv", "name": prefix or owner, "line": node.lineno,
                 "data": describe_data(node.args[1]) if len(node.args) > 1 else None, "note": f"key-value {meth}"}
            )
            return

        # Task queue (Celery style)
        if meth in ("delay", "apply_async", "send_task") and owner:
            self.facts["stores"].append(
                {"inFn": fn, "op": "enqueues", "kind": "queue", "name": owner.split(".")[-1], "line": node.lineno,
                 "data": describe_data(node.args[0]) if node.args else None, "note": f"task {meth}"}
            )
            return

        # LangGraph-style builder calls
        if owner in self.graph_vars:
            g = self.graph_vars[owner]
            if meth == "add_node":
                nname = str_value(node.args[0]) if node.args else None
                target = dotted(node.args[1]) if len(node.args) > 1 else None
                if nname is None and node.args:
                    target = dotted(node.args[0])
                    nname = target.split(".")[-1] if target else None
                if nname:
                    g["nodes"].append({"name": nname, "fn": target, "line": node.lineno})
            elif meth == "add_edge" and len(node.args) >= 2:
                src = self._node_ref(node.args[0])
                dst = self._node_ref(node.args[1])
                if isinstance(node.args[0], (ast.List, ast.Tuple)):
                    for e in node.args[0].elts:
                        g["edges"].append({"from": self._node_ref(e), "to": dst, "line": node.lineno, "kind": "static"})
                else:
                    g["edges"].append({"from": src, "to": dst, "line": node.lineno, "kind": "static"})
            elif meth == "add_conditional_edges" and node.args:
                src = self._node_ref(node.args[0])
                router = dotted(node.args[1]) if len(node.args) > 1 else dotted(kw(node, "path"))
                mapping = node.args[2] if len(node.args) > 2 else kw(node, "path_map")
                edge = {"from": src, "router": router, "line": node.lineno, "kind": "conditional", "options": None}
                if isinstance(mapping, ast.Dict):
                    opts = []
                    for k, v in zip(mapping.keys, mapping.values):
                        opts.append({"condition": str_value(k) if k is not None else None, "to": self._node_ref(v), "line": getattr(v, "lineno", node.lineno), "col": getattr(v, "col_offset", 0) + 1})
                    edge["options"] = opts
                elif isinstance(mapping, (ast.List, ast.Tuple)):
                    edge["options"] = [{"condition": None, "to": self._node_ref(v), "line": getattr(v, "lineno", node.lineno), "col": getattr(v, "col_offset", 0) + 1} for v in mapping.elts]
                elif mapping is not None:
                    edge["dynamicMap"] = True
                g["edges"].append(edge)
            elif meth in ("set_entry_point",) and node.args:
                g["entry"] = {"name": self._node_ref(node.args[0]), "line": node.lineno}
            elif meth in ("set_finish_point",) and node.args:
                g["finish"].append({"name": self._node_ref(node.args[0]), "line": node.lineno})
            return

        # Invoking a compiled graph or running an SDK agent
        if meth in GRAPH_INVOKE and owner:
            self.facts["graphInvokes"].append({"inFn": fn, "target": owner, "line": node.lineno, "via": meth})
        if callee.split(".")[-1] in ("run", "run_sync", "run_streamed") and parts[0] == "Runner" and node.args:
            ref = dotted(node.args[0])
            self.facts["graphInvokes"].append({"inFn": fn, "target": ref, "line": node.lineno, "via": "Runner." + meth, "agent": True})

        # LangGraph Command(goto=...)
        if meth == "Command":
            goto = kw(node, "goto")
            if goto is not None:
                s = str_value(goto)
                self.facts["commands"].append({"inFn": fn, "goto": s, "line": node.lineno, "dynamic": s is None})

        # Generic explicit handoff helpers: handoff(agent) / transfer_to(agent)
        if meth in ("handoff", "transfer_to", "hand_off") and node.args:
            ref = dotted(node.args[0])
            self.facts["commands"].append({"inFn": fn, "goto": None, "ref": ref, "line": node.lineno, "dynamic": ref is None, "sdk": True})

    def _node_ref(self, n):
        s = str_value(n)
        if s is not None:
            return s
        d = dotted(n)
        if d in ("START", "END") or (d and d.split(".")[-1] in ("START", "END")):
            return "__" + d.split(".")[-1].lower() + "__"
        return None


def extract(rel, abs_path):
    try:
        with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError as exc:
        return {"path": rel, "error": {"line": 1, "message": "unreadable: " + exc.__class__.__name__}}
    try:
        tree = ast.parse(text, filename=rel)
    except SyntaxError as exc:
        return {"path": rel, "error": {"line": exc.lineno or 1, "message": "syntax error"}}
    ex = Extractor(rel)
    ex.visit(tree)
    ex.facts["frameworks"] = sorted(set(ex.facts["frameworks"]))
    ex.facts["fastapiApps"] = sorted(ex.fastapi_apps)
    ex.facts["toolFns"] = sorted(ex.tool_fns)
    return ex.facts


def main():
    items = json.load(sys.stdin)
    out = sys.stdout
    for it in items:
        try:
            facts = extract(it["rel"], it["abs"])
        except RecursionError:
            facts = {"path": it["rel"], "error": {"line": 1, "message": "file too deeply nested"}}
        out.write(json.dumps(facts) + "\n")
    out.flush()


if __name__ == "__main__":
    main()
