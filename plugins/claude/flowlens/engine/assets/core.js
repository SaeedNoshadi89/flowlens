/* FlowLens report core: pure functions (no DOM) for views, layout, replay and URL state.
   Loaded inline in the report and evaluated in tests with node:vm. */
(function (root) {
  'use strict';

  var LANES = [
    { id: 'ui', title: 'Frontend', color: 'var(--c-ui)' },
    { id: 'request', title: 'Requests', color: 'var(--c-request)' },
    { id: 'endpoint', title: 'API routes', color: 'var(--c-endpoint)' },
    { id: 'service', title: 'Application code', color: 'var(--c-service)' },
    { id: 'agent', title: 'Agents & tools', color: 'var(--c-agent)' },
    { id: 'data', title: 'Stores & queues', color: 'var(--c-data)' },
    { id: 'external', title: 'External & unresolved', color: 'var(--c-external)' }
  ];
  var RELATIONS = ['api', 'data', 'deps', 'agents', 'calls'];
  var PROVENANCES = ['observed', 'inferred', 'unresolved'];
  var RANK = { unresolved: 0, inferred: 1, observed: 2 };
  var NODE_W = 196, NODE_H = 46, ROW = 60, LANE_GAP = 62, TOP = 64, LEFT = 26;

  function laneOf(n) {
    switch (n.kind) {
      case 'request': return 'request';
      case 'endpoint': return 'endpoint';
      case 'store': case 'queue': return 'data';
      case 'external': case 'unknown': return 'external';
      case 'agent': case 'tool': return 'agent';
    }
    if (n.layer === 'frontend') return 'ui';
    return 'service';
  }

  function colorOf(n) {
    if (n.kind === 'unknown') return 'var(--c-unknown)';
    var l = laneOf(n);
    for (var i = 0; i < LANES.length; i++) if (LANES[i].id === l) return LANES[i].color;
    return 'var(--muted)';
  }

  function defaultState(graph) {
    return {
      scenario: null, step: -1, playing: false, speed: 1, level: 'modules',
      relations: RELATIONS.filter(function (r) { return r === 'calls' || graph.scope.relations.indexOf(r) >= 0; }),
      provenance: PROVENANCES.slice(), features: null, selected: null, selectedEdge: null, query: '', isolated: false
    };
  }

  function index(graph) {
    if (graph.__index) return graph.__index;
    var nodes = {}, edges = {}, scen = {};
    graph.nodes.forEach(function (n) { nodes[n.id] = n; });
    graph.edges.forEach(function (e) { edges[e.id] = e; });
    graph.scenarios.forEach(function (s) { scen[s.id] = s; });
    var features = {};
    graph.nodes.forEach(function (n) { if (n.feature) features[n.feature] = (features[n.feature] || 0) + (n.kind === 'module' ? 1 : 0); });
    Object.defineProperty(graph, '__index', { value: { nodes: nodes, edges: edges, scenarios: scen, features: features }, enumerable: false });
    return graph.__index;
  }

  /** Visible nodes and edges for a state. Aggregates to modules at the modules level. */
  function computeView(graph, st) {
    var ix = index(graph);
    var relOk = {}; st.relations.forEach(function (r) { relOk[r] = true; });
    var provOk = {}; st.provenance.forEach(function (p) { provOk[p] = true; });
    var featOk = st.features ? {} : null;
    if (st.features) st.features.forEach(function (f) { featOk[f] = true; });
    var scenario = st.scenario ? ix.scenarios[st.scenario] : null;

    if (scenario) {
      var nset = {}, order = [], eset = {}, elist = [];
      scenario.steps.forEach(function (s) {
        [s.from, s.to].forEach(function (id) { if (!nset[id] && ix.nodes[id]) { nset[id] = true; order.push(id); } });
        if (!eset[s.edge] && ix.edges[s.edge]) { eset[s.edge] = true; var e = ix.edges[s.edge]; elist.push({ id: e.id, from: e.from, to: e.to, relation: e.relation, provenance: e.provenance, members: [e.id], count: 1 }); }
      });
      return { nodes: order.map(function (id) { return ix.nodes[id]; }), edges: elist, mode: 'scenario', order: order };
    }

    var mapNode = function (n) {
      if (st.level === 'modules' && (n.kind === 'function' || n.kind === 'request') && n.module && ix.nodes[n.module]) return n.module;
      return n.id;
    };
    var visible = {};
    graph.nodes.forEach(function (n) {
      if (st.level === 'modules' && (n.kind === 'function' || n.kind === 'request')) return;
      if (st.level === 'functions' && n.kind === 'module') return;
      if (featOk && n.feature && !featOk[n.feature]) return;
      visible[n.id] = n;
    });
    var agg = {}, aggList = [];
    graph.edges.forEach(function (e) {
      if (!relOk[e.relation] || !provOk[e.provenance]) return;
      if (st.level === 'modules' && e.kind === 'imports') { /* keep */ }
      var a = ix.nodes[e.from], b = ix.nodes[e.to];
      if (!a || !b) return;
      var f = mapNode(a), t = mapNode(b);
      if (f === t) return;
      var fa = ix.nodes[f], tb = ix.nodes[t];
      if (featOk && ((fa.feature && !featOk[fa.feature]) || (tb.feature && !featOk[tb.feature]))) {
        // Keep edges to feature-less nodes (stores, externals) only when the other end is visible.
        var fOk = !fa.feature || featOk[fa.feature], tOk = !tb.feature || featOk[tb.feature];
        if (!(fOk && tOk)) return;
      }
      var key = f + '|' + t + '|' + e.relation;
      var g = agg[key];
      if (!g) { g = agg[key] = { id: 'agg:' + key, from: f, to: t, relation: e.relation, provenance: e.provenance, members: [], count: 0 }; aggList.push(g); }
      g.members.push(e.id); g.count++;
      if (RANK[e.provenance] < RANK[g.provenance]) g.provenance = e.provenance; // show the weakest provenance
    });
    var used = {};
    aggList.forEach(function (g) { used[g.from] = true; used[g.to] = true; });
    var nodes = [];
    Object.keys(visible).forEach(function (id) {
      var n = visible[id];
      var structural = n.kind === 'module' || n.kind === 'endpoint' || n.kind === 'agent' || n.kind === 'tool';
      if (used[id] || (structural && (st.isolated || st.level === 'modules'))) nodes.push(n);
      else if (st.isolated && n.kind === 'function') nodes.push(n);
    });
    // Feature-less targets (stores, externals) reached by visible edges.
    aggList.forEach(function (g) { [g.from, g.to].forEach(function (id) { if (!visible[id] && ix.nodes[id] && !ix.nodes[id].feature && nodes.indexOf(ix.nodes[id]) < 0) { visible[id] = ix.nodes[id]; nodes.push(ix.nodes[id]); } }); });
    var present = {}; nodes.forEach(function (n) { present[n.id] = true; });
    var edges = aggList.filter(function (g) { return present[g.from] && present[g.to]; });
    return { nodes: nodes, edges: edges, mode: 'overview', order: null };
  }

  /** Lane layout with barycentric ordering; in scenario mode rows follow first appearance. */
  function layout(view, limit) {
    var max = limit || 700;
    var nodes = view.nodes;
    var truncated = false;
    if (nodes.length > max) {
      var deg = {};
      view.edges.forEach(function (e) { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
      nodes = nodes.slice().sort(function (a, b) { return (deg[b.id] || 0) - (deg[a.id] || 0) || (a.id < b.id ? -1 : 1); }).slice(0, max);
      truncated = true;
    }
    var lanes = {}; LANES.forEach(function (l) { lanes[l.id] = []; });
    nodes.forEach(function (n) { lanes[laneOf(n)].push(n); });
    var present = LANES.filter(function (l) { return lanes[l.id].length; });
    var pos = {};
    var orderIdx = {};
    if (view.order) view.order.forEach(function (id, i) { orderIdx[id] = i; });
    present.forEach(function (l) {
      lanes[l.id].sort(function (a, b) {
        if (view.order) return orderIdx[a.id] - orderIdx[b.id];
        return (a.feature || '').localeCompare(b.feature || '') || a.label.localeCompare(b.label);
      });
      lanes[l.id].forEach(function (n, i) { pos[n.id] = { lane: l.id, row: i }; });
    });
    if (!view.order) {
      var nbr = {};
      view.edges.forEach(function (e) {
        if (!pos[e.from] || !pos[e.to]) return;
        (nbr[e.from] = nbr[e.from] || []).push(e.to);
        (nbr[e.to] = nbr[e.to] || []).push(e.from);
      });
      for (var it = 0; it < 6; it++) {
        present.forEach(function (l) {
          var list = lanes[l.id];
          var bc = {};
          list.forEach(function (n) {
            var ns = (nbr[n.id] || []).filter(function (m) { return pos[m] && pos[m].lane !== l.id; });
            bc[n.id] = ns.length ? ns.reduce(function (s, m) { return s + pos[m].row; }, 0) / ns.length : pos[n.id].row;
          });
          list.sort(function (a, b) { return bc[a.id] - bc[b.id] || pos[a.id].row - pos[b.id].row; });
          list.forEach(function (n, i) { pos[n.id].row = i; });
        });
      }
    }
    var laneX = {};
    present.forEach(function (l, i) { laneX[l.id] = LEFT + i * (NODE_W + LANE_GAP); });
    var maxRows = 0;
    present.forEach(function (l) { maxRows = Math.max(maxRows, lanes[l.id].length); });
    var placed = {};
    nodes.forEach(function (n) { var p = pos[n.id]; placed[n.id] = { x: laneX[p.lane], y: TOP + p.row * ROW, w: NODE_W, h: NODE_H, lane: p.lane }; });
    var width = LEFT * 2 + present.length * NODE_W + Math.max(0, present.length - 1) * LANE_GAP;
    var height = TOP + Math.max(1, maxRows) * ROW + 30;
    return { lanes: present.map(function (l) { return { id: l.id, title: l.title, color: l.color, x: laneX[l.id], count: lanes[l.id].length }; }), pos: placed, width: width, height: height, truncated: truncated, shown: nodes.length, total: view.nodes.length };
  }

  function edgePath(a, b) {
    var y1 = a.y + a.h / 2, y2 = b.y + b.h / 2;
    if (b.x > a.x) {
      var x1 = a.x + a.w, x2 = b.x, dx = Math.max(40, (x2 - x1) / 2);
      return 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2;
    }
    if (b.x === a.x) {
      var xr = a.x + a.w, bend = 46 + Math.min(80, Math.abs(y2 - y1) / 4);
      return 'M' + xr + ',' + y1 + ' C' + (xr + bend) + ',' + y1 + ' ' + (xr + bend) + ',' + y2 + ' ' + xr + ',' + y2;
    }
    var sx = a.x, tx = b.x + b.w, d2 = Math.max(50, (sx - tx) / 2);
    return 'M' + sx + ',' + y1 + ' C' + (sx - d2) + ',' + (y1 - 30) + ' ' + (tx + d2) + ',' + (y2 - 30) + ' ' + tx + ',' + y2;
  }

  /** Replay step arithmetic. step -1 means "before the first step". */
  function moveStep(st, scenario, delta) {
    if (!scenario) return -1;
    var n = scenario.steps.length;
    var next = st.step + delta;
    if (next < -1) next = -1;
    if (next > n - 1) next = n - 1;
    return next;
  }

  /** What has happened up to a step: seen nodes and edges, the active ones. */
  function replayMarks(graph, scenario, step) {
    var seenN = {}, seenE = {}, active = null;
    if (!scenario || step < 0) return { seenNodes: seenN, seenEdges: seenE, active: null };
    for (var i = 0; i <= step && i < scenario.steps.length; i++) {
      var s = scenario.steps[i];
      seenN[s.from] = true; seenN[s.to] = true; seenE[s.edge] = true;
      if (i === step) active = s;
    }
    return { seenNodes: seenN, seenEdges: seenE, active: active };
  }

  function stepDelay(speed) {
    return Math.round(1500 / (speed || 1));
  }

  function parseHash(hash) {
    var out = {};
    (hash || '').replace(/^#/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      var v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
      out[k] = v;
    });
    return out;
  }

  function applyHash(graph, st, h) {
    var ix = index(graph);
    if (h.scenario && ix.scenarios[h.scenario]) { st.scenario = h.scenario; st.step = -1; }
    if (h.step && st.scenario) { var n = parseInt(h.step, 10); if (!isNaN(n)) st.step = Math.max(-1, Math.min(ix.scenarios[st.scenario].steps.length - 1, n - 1)); }
    if (h.level === 'functions' || h.level === 'modules') st.level = h.level;
    if (h.rel !== undefined) st.relations = h.rel.split(',').filter(function (r) { return RELATIONS.indexOf(r) >= 0; });
    if (h.prov !== undefined) st.provenance = h.prov.split(',').filter(function (p) { return PROVENANCES.indexOf(p) >= 0; });
    if (h.features) st.features = h.features.split(',');
    if (h.node && ix.nodes[h.node]) st.selected = h.node;
    if (h.edge && ix.edges[h.edge]) st.selectedEdge = h.edge;
    if (h.speed) { var sp = parseFloat(h.speed); if (sp > 0 && sp <= 8) st.speed = sp; }
    if (h.play === '1' && st.scenario) st.playing = true;
    return st;
  }

  function toHash(graph, st) {
    var parts = [];
    var def = defaultState(graph);
    if (st.scenario) parts.push('scenario=' + encodeURIComponent(st.scenario));
    if (st.scenario && st.step >= 0) parts.push('step=' + (st.step + 1));
    if (st.level !== def.level) parts.push('level=' + st.level);
    if (st.relations.join(',') !== def.relations.join(',')) parts.push('rel=' + st.relations.join(','));
    if (st.provenance.join(',') !== def.provenance.join(',')) parts.push('prov=' + st.provenance.join(','));
    if (st.features) parts.push('features=' + encodeURIComponent(st.features.join(',')));
    if (st.selected) parts.push('node=' + encodeURIComponent(st.selected));
    if (st.selectedEdge) parts.push('edge=' + encodeURIComponent(st.selectedEdge));
    if (st.speed !== 1) parts.push('speed=' + st.speed);
    return parts.length ? '#' + parts.join('&') : '';
  }

  function shellQuote(s) {
    return /^[A-Za-z0-9_./,:=@%+-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
  }

  /** CLI command that re-scans with a new scope and relation selection. */
  function rescanCommand(include, relations, exclude) {
    var cmd = ['flowlens', 'scan'];
    if (include && include.length) cmd.push('--include', shellQuote(include.join(',')));
    else cmd.push('--preset', 'whole');
    if (relations && relations.length) cmd.push('--relations', relations.join(','));
    if (exclude && exclude.length) cmd.push('--exclude', shellQuote(exclude.join(',')));
    cmd.push('--save');
    return cmd.join(' ');
  }

  function search(graph, q, limit) {
    q = (q || '').trim().toLowerCase();
    if (!q) return [];
    var out = [];
    for (var i = 0; i < graph.nodes.length && out.length < (limit || 30); i++) {
      var n = graph.nodes[i];
      var hay = (n.label + ' ' + (n.path || '') + ' ' + n.kind + ' ' + (n.feature || '')).toLowerCase();
      if (hay.indexOf(q) >= 0) out.push(n);
    }
    return out;
  }

  root.FlowLensCore = {
    LANES: LANES, RELATIONS: RELATIONS, PROVENANCES: PROVENANCES, NODE_W: NODE_W, NODE_H: NODE_H,
    laneOf: laneOf, colorOf: colorOf, defaultState: defaultState, index: index, computeView: computeView, layout: layout,
    edgePath: edgePath, moveStep: moveStep, replayMarks: replayMarks, stepDelay: stepDelay, parseHash: parseHash,
    applyHash: applyHash, toHash: toHash, rescanCommand: rescanCommand, search: search, shellQuote: shellQuote
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
