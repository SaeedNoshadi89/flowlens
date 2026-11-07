/**
 * Opens generated reports in headless Chrome over the DevTools protocol, drives the
 * replay controls and filters, and records every network request. Skipped when no
 * Chrome or Chromium is installed (set CHROME_PATH to point at one).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CLI, workspace } from './helpers.ts';

function findChrome(): string | null {
  const c = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return c.find((p) => p && existsSync(p)) ?? null;
}
const CHROME = findChrome();

class Page {
  private id = 0;
  private pending = new Map<number, (v: any) => void>();
  requests: string[] = [];
  consoleErrors: string[] = [];
  private ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)!(msg); this.pending.delete(msg.id); }
      if (msg.method === 'Network.requestWillBeSent') this.requests.push(msg.params.request.url);
      if (msg.method === 'Runtime.exceptionThrown') this.consoleErrors.push(JSON.stringify(msg.params.exceptionDetails.text));
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') this.consoleErrors.push(msg.params.entry.text);
    };
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.pending.set(id, r));
  }
  async eval<T = unknown>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' in ' + expr);
    return r.result?.result?.value as T;
  }
  async until(expr: string, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval<boolean>(expr)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${expr}`);
  }
  async key(key: string, code = key) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: key === 'ArrowRight' ? 39 : key === 'ArrowLeft' ? 37 : key === ' ' ? 32 : 0 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
  }
}

async function launch(): Promise<{ page: Page; close: () => Promise<void> }> {
  const profile = mkdtempSync(path.join(tmpdir(), 'flowlens-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const proc: ChildProcess = spawn(CHROME!, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  let targets: any[] = [];
  for (let i = 0; i < 100 && !targets.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t: any) => t.type === 'page'); } catch { /* not up yet */ }
  }
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const page = new Page(ws);
  await page.send('Network.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  const close = async () => {
    ws.close();
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { page, close };
}

async function open(page: Page, file: string, hash = '') {
  await page.send('Page.navigate', { url: pathToFileURL(file).href + hash });
  await page.until(`document.body && document.body.getAttribute('data-ready') === 'true'`);
}

test('report opens offline and its replay, filters and details work', { skip: !CHROME && 'Chrome not found' }, async (t) => {
  const ws = workspace('shop-app');
  t.after(ws.cleanup);
  const r = spawnSync(process.execPath, [CLI, 'scan', '--quiet'], { cwd: ws.root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const html = path.join(ws.root, '.flowlens', 'flowmap.html');
  const { page, close } = await launch();
  t.after(close);
  await open(page, html);

  // Offline: the only request is the file itself.
  assert.deepEqual(page.requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:') && u !== 'about:blank'), []);
  assert.deepEqual(page.consoleErrors, []);
  assert.ok((await page.eval<number>(`document.querySelectorAll('#svg .node').length`)) > 5);

  // Pick a scenario, step with buttons and the keyboard.
  await page.eval(`[...document.querySelectorAll('#scenarios button')].find(b => b.textContent.startsWith('CheckoutPage.submit journey')).click()`);
  assert.equal(await page.eval(`document.body.getAttribute('data-step')`), '0');
  await page.eval(`document.getElementById('btnNext').click(); document.getElementById('btnNext').click(); document.getElementById('btnNext').click()`);
  assert.equal(await page.eval(`document.body.getAttribute('data-step')`), '3');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await page.eval(`window.scrollY`), 0, 'stepping never scrolls the page');
  assert.equal(await page.eval(`document.querySelectorAll('#svg .node.active').length`), 1);
  assert.equal(await page.eval(`document.querySelectorAll('#log li.cur').length`), 1);
  assert.match(await page.eval<string>(`document.getElementById('now').textContent`), /getStock/);
  await page.eval(`document.getElementById('btnBack').click()`);
  assert.equal(await page.eval(`document.body.getAttribute('data-step')`), '2');
  await page.eval(`document.activeElement && document.activeElement.blur()`);
  await page.key('ArrowRight');
  assert.equal(await page.eval(`document.body.getAttribute('data-step')`), '3');
  await page.key('Home');
  assert.equal(await page.eval(`document.body.getAttribute('data-step')`), '0');

  // Play at 4x until the end, then it stops by itself.
  await page.eval(`document.querySelector('[data-speed="4"]').click(); document.getElementById('btnPlay').click()`);
  assert.equal(await page.eval(`document.body.getAttribute('data-playing')`), 'true');
  await page.until(`document.body.getAttribute('data-playing') === 'false'`, 15000);
  const total = await page.eval<number>(`window.__flowlens.state().scenario && document.querySelectorAll('#log li[data-step]').length`);
  assert.equal(await page.eval(`document.body.getAttribute('data-step')`), String(total));
  // Pause in the middle.
  await page.eval(`document.getElementById('btnRestart').click(); document.getElementById('btnPlay').click()`);
  await page.until(`Number(document.body.getAttribute('data-step')) >= 2`);
  await page.eval(`document.getElementById('btnPlay').click()`);
  const paused = await page.eval<string>(`document.body.getAttribute('data-step')`);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(await page.eval(`document.body.getAttribute('data-step')`), paused);

  // Inspect how a step was established: the inferred route match shows its reason and evidence.
  const inferredIdx = await page.eval<number>(`[...document.querySelectorAll('#log li[data-step]')].findIndex(li => li.textContent.includes('inferred'))`);
  await page.eval(`document.querySelectorAll('#log li[data-step]')[${inferredIdx}].click()`);
  const now = await page.eval<string>(`document.getElementById('now').textContent`);
  assert.match(now, /Inferred: /);
  assert.match(now, /web\/src\/api\/client\.ts:\d+/);
  assert.match(now, /api\/app\/routes\/\w+\.py:\d+/);
  const href = await page.eval<string>(`document.querySelector('#now .evid a').getAttribute('href')`);
  assert.match(href, /^\.\.\/(web|api)\/[\w/]+\.(ts|py)$/);

  // Clicking an edge shows its evidence in Details.
  await page.eval(`document.getElementById('btnExit').click()`);
  await page.eval(`document.querySelector('#svg .edge-hit').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  assert.match(await page.eval<string>(`document.getElementById('details').textContent`), /Evidence/);

  // Filters switch the view without re-analysis; unanalyzed relations are disabled.
  const before = await page.eval<number>(`document.querySelectorAll('#svg path.edge').length`);
  await page.eval(`[...document.querySelectorAll('#filters label')].find(l => l.textContent.includes('Module dependencies')).querySelector('input').click()`);
  const after = await page.eval<number>(`document.querySelectorAll('#svg path.edge').length`);
  assert.ok(after < before, `deps filter hides edges (${before} -> ${after})`);
  await page.eval(`[...document.querySelectorAll('#filters label')].find(l => l.textContent.includes('unresolved')).querySelector('input').click()`);
  assert.equal(await page.eval(`document.querySelectorAll('#svg path.edge.unresolved').length`), 0);

  // Search selects and focuses a node.
  await page.eval(`const q = document.getElementById('q'); q.value = 'save_order'; q.dispatchEvent(new Event('input')); q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
  assert.match(await page.eval<string>(`document.getElementById('details').textContent`), /orders_repo\.py/);
  assert.match(await page.eval<string>(`document.activeElement.getAttribute('data-node') || ''`), /save_order/);

  // Deep link: the URL hash restores a scenario step.
  const sc = await page.eval<string>(`window.__flowlens.state().scenario || ''`);
  const scenarioId = await page.eval<string>(`[...document.querySelectorAll('#scenarios button[data-scenario]')][0].getAttribute('data-scenario')`);
  await open(page, html, `#scenario=${encodeURIComponent(scenarioId)}&step=2`);
  // Same document, new hash: the hashchange handler applies it asynchronously.
  await page.until(`document.body.getAttribute('data-step') === '2'`);
  assert.equal(await page.eval(`window.scrollY`), 0, 'stepping never scrolls the page');
  assert.equal(sc, '');
  assert.deepEqual(page.requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:') && u !== 'about:blank'), []);
  assert.deepEqual(page.consoleErrors, []);
});

test('agent report replays branches and shows unresolved targets', { skip: !CHROME && 'Chrome not found' }, async (t) => {
  const ws = workspace('agent-desk');
  t.after(ws.cleanup);
  const r = spawnSync(process.execPath, [CLI, 'scan', '--quiet'], { cwd: ws.root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { page, close } = await launch();
  t.after(close);
  await open(page, path.join(ws.root, '.flowlens', 'flowmap.html'));
  await page.eval(`[...document.querySelectorAll('#scenarios button')].find(b => b.textContent.startsWith('Agent graph workflow')).click()`);
  const log = await page.eval<string>(`document.getElementById('log').textContent`);
  assert.match(log, /alternative 1\/2 · billing/, 'options follow source order');
  assert.match(log, /alternative 2\/2 · technical/);
  assert.match(log, /unresolved/);
  const idx = await page.eval<number>(`[...document.querySelectorAll('#log li[data-step]')].findIndex(li => li.textContent.includes('Runtime goto target'))`);
  await page.eval(`document.querySelectorAll('#log li[data-step]')[${idx}].click()`);
  assert.match(await page.eval<string>(`document.getElementById('now').textContent`), /Unresolved: The handoff target is a runtime value/);
  assert.match(await page.eval<string>(`document.getElementById('coverage').textContent`), /crewai/);
  assert.deepEqual(page.consoleErrors, []);
});
