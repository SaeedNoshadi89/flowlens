import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlowGraph } from '../graph/schema.ts';

export interface RenderOptions {
  /** Relative path from the report folder to the repository root, used for source links ("../"). */
  sourceBase?: string | null;
  /** Absolute repository root for vscode:// links. Off unless the user opts in. */
  editorRoot?: string | null;
  graphFile?: string;
  maxNodes?: number;
}

/** Content-Security-Policy for the report: inline code only, no network of any kind. */
export const REPORT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function asset(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, 'assets', name), path.join(here, 'render', 'assets', name)]) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error(`report asset ${name} not found next to the FlowLens engine`);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** JSON safe to place inside <script type="application/json">: no "</script", no HTML comment openers. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');
}

/** Inline code must not contain a closing script/style tag. Our assets never do; assert it. */
function inlineSafe(code: string, tag: 'script' | 'style'): string {
  if (new RegExp(`</${tag}`, 'i').test(code)) throw new Error(`asset contains </${tag}>`);
  return code;
}

export function renderHtml(graph: FlowGraph, opts: RenderOptions = {}): string {
  const css = inlineSafe(asset('app.css'), 'style');
  const core = inlineSafe(asset('core.js'), 'script');
  const app = inlineSafe(asset('app.js'), 'script');
  const config = {
    sourceBase: opts.sourceBase ?? null,
    editorRoot: opts.editorRoot ?? null,
    graphFile: opts.graphFile ?? 'graph.json',
    maxNodes: opts.maxNodes ?? 700,
  };
  const title = `${escapeHtml(graph.project.name)} flow map · FlowLens`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="generator" content="FlowLens ${escapeHtml(graph.generator.version)}">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<a class="sr-only" href="#svg">Skip to map</a>
<div class="app">
  <header class="top">
    <div><h1 id="title"></h1><p id="lede"></p></div>
    <div class="badges" id="badges"></div>
  </header>
  <div class="bar">
    <div class="searchbox">
      <label class="sr-only" for="q">Search the map</label>
      <input id="q" type="search" placeholder="Search modules, functions, routes, stores (press /)" autocomplete="off" spellcheck="false">
      <ul class="results" id="results" hidden></ul>
    </div>
    <div class="seg" role="group" aria-label="Detail level">
      <button type="button" data-level="modules">Modules</button>
      <button type="button" data-level="functions">Functions</button>
    </div>
    <div class="legend" id="legend" aria-label="Legend"></div>
  </div>
  <div class="layout">
    <aside class="left">
      <section class="panel" aria-labelledby="h-scn">
        <h2 id="h-scn">Scenarios <small id="scnCount"></small></h2>
        <div class="pad"><input id="scnq" type="search" placeholder="Filter scenarios" aria-label="Filter scenarios"></div>
        <ul class="scen-list scroll" id="scenarios"></ul>
      </section>
      <section class="panel" aria-labelledby="h-flt">
        <h2 id="h-flt">Filters <small id="filterSummary"></small></h2>
        <div class="pad" id="filters"></div>
      </section>
      <section class="panel" aria-labelledby="h-scope">
        <h2 id="h-scope">Scope <small id="scopeSummary"></small></h2>
        <div class="pad" id="scope"></div>
      </section>
    </aside>
    <main class="center">
      <div class="mapwrap">
        <div class="mapbar" role="toolbar" aria-label="Replay controls">
          <button type="button" id="btnRestart" title="Restart (Home)">Restart</button>
          <button type="button" id="btnBack" title="Previous step (←)">◀ Back</button>
          <button type="button" id="btnPlay" class="primary" title="Play or pause (Space)">Play</button>
          <button type="button" id="btnNext" title="Next step (→)">Next ▶</button>
          <div class="seg" role="group" aria-label="Speed">
            <button type="button" data-speed="0.5">0.5×</button><button type="button" data-speed="1">1×</button><button type="button" data-speed="2">2×</button><button type="button" data-speed="4">4×</button>
          </div>
          <span class="counter" id="counter" aria-live="polite"></span>
          <span class="grow"></span>
          <button type="button" id="btnExit" hidden title="Leave the scenario and show the whole map">Overview</button>
          <button type="button" id="btnFollow" hidden aria-pressed="true" title="Keep the current step in view at a readable zoom">Follow</button>
          <button type="button" id="btnZoomOut" aria-label="Zoom out">−</button>
          <button type="button" id="btnZoomIn" aria-label="Zoom in">+</button>
          <button type="button" id="btnFit">Fit</button>
        </div>
        <div class="progress"><i id="prog"></i></div>
        <svg class="map" id="svg" role="group" aria-label="Flow map: lanes from frontend to external services"></svg>
        <p class="mapnote" id="mapnote"></p>
        <div class="empty" id="empty" hidden></div>
      </div>
    </main>
    <aside class="right">
      <section class="panel" aria-labelledby="h-now"><h2 id="h-now">Now <small id="nowMeta"></small></h2><div class="now" id="now"></div></section>
      <section class="panel" aria-labelledby="h-log"><h2 id="h-log">Event stream <small>simulated replay · no timing data</small></h2><ol class="log" id="log"></ol></section>
      <section class="panel" aria-labelledby="h-det"><h2 id="h-det">Details</h2><div class="pad" id="details"></div></section>
    </aside>
  </div>
  <div class="bottom">
    <section class="panel" aria-labelledby="h-cov"><h2 id="h-cov">Coverage</h2><div class="scroll" id="coverage"></div></section>
    <section class="panel" aria-labelledby="h-diag"><h2 id="h-diag">Diagnostics <small id="diagCount"></small></h2><div class="scroll" id="diags"></div></section>
    <section class="panel" aria-labelledby="h-re"><h2 id="h-re">Re-scan</h2><div class="pad" id="rescan"></div></section>
  </div>
  <footer id="footer"></footer>
</div>
<script type="application/json" id="flowlens-data">${scriptJson(graph)}</script>
<script type="application/json" id="flowlens-config">${scriptJson(config)}</script>
<script>${core}</script>
<script>${app}</script>
</body>
</html>
`;
}
