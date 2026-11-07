/**
 * Records the README walkthrough GIF (docs/images/flowlens-demo.gif).
 *
 *   npm run build && npm run demo:gif
 *
 * Copies both fixtures into a temp folder that looks like real checkouts, scans
 * them with the built CLI, drives the generated reports in headless Chrome over
 * the DevTools protocol (a caption bar and a fake cursor are injected for the
 * recording only), saves PNG frames, then assembles the GIF with Pillow
 * (make-gif.py, run through uv when available).
 *
 * Needs: Chrome or Chromium (CHROME_PATH to override), Python 3 with Pillow or uv.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'dist', 'flowlens.mjs');
const GIF = path.join(REPO, 'docs', 'images', 'flowlens-demo.gif');
if (!existsSync(CLI)) throw new Error('dist/flowlens.mjs not found: run npm run build first');
const CH = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
if (!CH) throw new Error('Chrome or Chromium not found; set CHROME_PATH');

const S = realpathSync(mkdtempSync(path.join(tmpdir(), 'flowlens-demo-gif-')));
const OUT = path.join(S, 'frames');
mkdirSync(OUT, { recursive: true });
const NOW = '2026-11-07T12:00:00.000Z';
for (const fx of ['shop-app', 'agent-desk']) {
  const dir = path.join(S, 'projects', fx);
  cpSync(path.join(REPO, 'fixtures', fx), dir, { recursive: true });
  rmSync(path.join(dir, '.flowlens'), { recursive: true, force: true });
  mkdirSync(path.join(dir, '.git'));
}
const rawScan = execFileSync(process.execPath, [CLI, 'scan', '--now', NOW], { cwd: path.join(S, 'projects', 'shop-app'), encoding: 'utf8' });
writeFileSync(path.join(S, 'scan-out.txt'), rawScan);
execFileSync(process.execPath, [CLI, 'scan', '--quiet', '--now', NOW], { cwd: path.join(S, 'projects', 'agent-desk') });

const W = 1440, H = 900;
const profile = path.join(S, 'chrome-profile');
const port = 9400 + Math.floor(Math.random() * 500);
const proc = spawn(CH, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let targets = [];
for (let i = 0; i < 100 && !targets.length; i++) {
  await new Promise((r) => setTimeout(r, 100));
  try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails) + expr); return r.result?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const manifest = [];
let n = 0;
async function snap(ms) {
  await sleep(120);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(OUT, String(n++).padStart(3, '0') + '.png');
  writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  manifest.push({ file: f, ms });
}
async function nav(url) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 100; i++) { await sleep(60); if (await ev(`document.readyState === 'complete'`)) break; }
  await sleep(300);
}

// Overlay: caption bar + fake cursor, injected for the recording only.
const OVERLAY = `
(function(){
  if (document.getElementById('demo-cap')) return;
  const cap = document.createElement('div'); cap.id = 'demo-cap';
  cap.style.cssText = 'position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:99999;background:rgba(7,10,26,.94);color:#fff;border:1px solid #3ee0ff;box-shadow:0 0 24px rgba(62,224,255,.45);border-radius:12px;padding:10px 18px;font:600 17px ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:1100px;text-align:center;display:flex;gap:12px;align-items:center';
  document.body.appendChild(cap);
  const cur = document.createElement('div'); cur.id = 'demo-cur';
  cur.style.cssText = 'position:fixed;z-index:100000;width:28px;height:28px;pointer-events:none;left:-100px;top:-100px';
  cur.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M3 2l7 19 2.5-7.5L20 11z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cur);
  const ring = document.createElement('div'); ring.id = 'demo-ring';
  ring.style.cssText = 'position:fixed;z-index:99998;width:38px;height:38px;border-radius:50%;border:3px solid #ffe14d;box-shadow:0 0 18px #ffe14d;pointer-events:none;display:none';
  document.body.appendChild(ring);
})()`;
async function caption(step, text) {
  await ev(OVERLAY);
  await ev(`(function(){const c=document.getElementById('demo-cap');c.textContent='';const b=document.createElement('span');b.textContent=${JSON.stringify(step)};b.style.cssText='background:#3ee0ff;color:#070a1a;border-radius:999px;min-width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;padding:0 8px';c.appendChild(b);c.appendChild(document.createTextNode(${JSON.stringify(text)}));})()`);
}
async function pointAt(selectorExpr, click = false) {
  const rect = await ev(`(function(){const el=${selectorExpr};el.scrollIntoView&&el.closest('.scroll,.log,#scenarios')&&el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.left+Math.min(r.width/2,60),y:r.top+r.height/2};})()`);
  await ev(`(function(){const c=document.getElementById('demo-cur');c.style.left=${rect.x - 4}+'px';c.style.top=${rect.y - 3}+'px';const g=document.getElementById('demo-ring');g.style.display=${click ? "'block'" : "'none'"};g.style.left=${rect.x - 19}+'px';g.style.top=${rect.y - 19}+'px';})()`);
  return rect;
}
async function hideRing() { await ev(`document.getElementById('demo-ring').style.display='none'`); }

// ---------- 1. Terminal
const scanOut = readFileSync(path.join(S, 'scan-out.txt'), 'utf8').split(S + '/projects').join('~/projects');
const termHtml = path.join(S, 'terminal.html');
writeFileSync(termHtml, `<!doctype html><meta charset="utf-8"><style>
body{margin:0;height:100vh;background:radial-gradient(900px 500px at 10% -10%,rgba(141,107,255,.25),transparent 60%),linear-gradient(#070a1a,#0c1030);display:flex;align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,sans-serif}
.win{width:1080px;background:#0b0e1f;border:1px solid rgba(150,160,255,.25);border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.6);overflow:hidden;margin-top:-60px}
.bar{height:36px;background:#151a33;display:flex;align-items:center;gap:8px;padding:0 14px;color:#a3abd8;font:13px ui-monospace,Menlo,monospace}
.bar i{width:12px;height:12px;border-radius:50%;display:inline-block}
pre{margin:0;padding:22px 26px 30px;min-height:330px;color:#edf0ff;font:16px/1.65 ui-monospace,"SF Mono",Menlo,monospace;white-space:pre-wrap}
.p{color:#4dff88}.c{color:#3ee0ff}.m{color:#a3abd8}.k{color:#ffe14d}
h1{position:absolute;top:84px;left:0;right:0;text-align:center;margin:0;font-size:40px;background:linear-gradient(90deg,#3ee0ff,#9d8cff 40%,#ff5cdc 70%,#ffe14d);-webkit-background-clip:text;background-clip:text;color:transparent}
h2{position:absolute;top:138px;left:0;right:0;text-align:center;margin:0;color:#a3abd8;font-weight:500;font-size:19px}
</style><h1>FlowLens</h1><h2>How does this repository actually flow? Ask it.</h2>
<div class="win"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span style="margin-left:10px">~/projects/shop-app</span></div><pre id="t"></pre></div>`);
await nav(pathToFileURL(termHtml).href);
await caption('1', 'Run FlowLens in your project: the CLI, /flowlens:map in Claude Code, or the flowlens skill in Codex');
const prompt = '<span class="p">~/projects/shop-app</span> <span class="c">$</span> ';
const cmd = 'flowlens scan --open';
const setT = (html) => ev(`document.getElementById('t').innerHTML=${JSON.stringify(html)}`);
await setT(prompt + '<span class="k">▍</span>');
await snap(900);
for (const k of [8, 13, cmd.length]) { await setT(prompt + cmd.slice(0, k) + '<span class="k">▍</span>'); await snap(k === cmd.length ? 700 : 260); }
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const lines = scanOut.trim().split('\n').map((l) => esc(l)
  .replace(/^(Root:|Scope:|Relationships:|Map:|Graph:|Open it:)/, '<span class="m">$1</span>')
  .replace(/(\d+ inferred)/, '<span class="k">$1</span>').replace(/(\d+ unresolved)/, '<span style="color:#ff6b8b">$1</span>'));
await setT(prompt + cmd + '\n' + lines.slice(0, 3).join('\n'));
await snap(1000);
await setT(prompt + cmd + '\n' + lines.join('\n') + '\n' + prompt + '<span class="k">▍</span>');
await snap(3200);

// ---------- 2. Overview
const shop = pathToFileURL(path.join(S, 'projects/shop-app/.flowlens/flowmap.html')).href;
await nav(shop);
await caption('2', 'A single offline HTML file: lanes from frontend → requests → routes → code → stores → external');
await snap(3200);
await caption('2', 'Scenarios are reconstructed from source: entry journeys, API calls, server routes, agent handoffs');
await pointAt(`[...document.querySelectorAll('#scenarios button')].find(b=>b.textContent.startsWith('CheckoutPage.submit journey'))`);
await snap(1400);
await pointAt(`[...document.querySelectorAll('#scenarios button')].find(b=>b.textContent.startsWith('CheckoutPage.submit journey'))`, true);
await ev(`[...document.querySelectorAll('#scenarios button')].find(b=>b.textContent.startsWith('CheckoutPage.submit journey')).click()`);
await snap(1700);
await hideRing();

// ---------- 3. Replay
await caption('3', 'Press Play: the replay walks the journey step by step, synced with the event stream');
await pointAt(`document.getElementById('btnPlay')`, true);
await snap(900);
await hideRing();
await ev(`window.__demoMove=1`);
const total = await ev(`document.querySelectorAll('#log li[data-step]').length`);
for (let i = 1; i <= Math.min(total, 16); i++) {
  await ev(`document.getElementById('btnNext').click()`);
  await ev(`document.body.setAttribute('data-playing','true');document.getElementById('btnPlay').textContent='Pause'`);
  await snap(i === 1 ? 1300 : 950);
}

// ---------- 4. Evidence
await caption('4', 'Click any step: see whether it was observed, inferred or unresolved, why, and the file:line evidence');
const inf = await ev(`[...document.querySelectorAll('#log li[data-step]')].findIndex(li=>li.textContent.includes('inferred') && li.textContent.includes('POST /api/orders'))`);
await pointAt(`document.querySelectorAll('#log li[data-step]')[${inf}]`);
await snap(1000);
await pointAt(`document.querySelectorAll('#log li[data-step]')[${inf}]`, true);
await ev(`document.querySelectorAll('#log li[data-step]')[${inf}].click()`);
await snap(1200);
await hideRing();
await pointAt(`document.querySelector('#now .why')`);
await snap(4200);

// ---------- 5. Filters
await ev(`document.getElementById('btnExit').click()`);
await caption('5', 'Filter by relationship, provenance or feature: views switch instantly, no re-scan');
await pointAt(`document.querySelector('[data-level="functions"]')`, true);
await ev(`document.querySelector('[data-level="functions"]').click()`);
await snap(1700);
await hideRing();
const clickLabel = async (text) => {
  const sel = `[...document.querySelectorAll('#filters label')].find(l=>l.textContent.includes(${JSON.stringify(text)}))`;
  await pointAt(sel, true);
  await ev(`${sel}.querySelector('input').click()`);
  await snap(1600);
  await hideRing();
};
await clickLabel('Module dependencies');
await clickLabel('Function calls');
await clickLabel('observed');
await caption('5', 'Only what needs a human look remains: inferred matches and runtime-decided targets');
await snap(3000);

// ---------- 6. Agents
const agents = pathToFileURL(path.join(S, 'projects/agent-desk/.flowlens/flowmap.html')).href;
await nav(agents);
await caption('6', 'Agent graphs too: conditional branches are alternatives, runtime-only targets stay unresolved');
const sid = await ev(`[...document.querySelectorAll('#scenarios button[data-scenario]')].find(b=>b.textContent.startsWith('Agent graph')).getAttribute('data-scenario')`);
await pointAt(`[...document.querySelectorAll('#scenarios button')].find(b=>b.textContent.startsWith('Agent graph'))`, true);
await ev(`[...document.querySelectorAll('#scenarios button')].find(b=>b.textContent.startsWith('Agent graph')).click()`);
await snap(1400);
await hideRing();
for (let i = 1; i <= 12; i++) { await ev(`document.getElementById('btnNext').click()`); await snap(i === 12 ? 4200 : 850); }

writeFileSync(path.join(S, 'manifest.json'), JSON.stringify(manifest));
ws.close();
const exited = new Promise((r) => proc.once('exit', r));
proc.kill();
await exited;

const py = path.join(path.dirname(fileURLToPath(import.meta.url)), 'make-gif.py');
const hasUv = spawnSync('uv', ['--version']).status === 0;
const r = hasUv
  ? spawnSync('uv', ['run', '-q', '--no-project', '--with', 'pillow', 'python', py, S, GIF], { stdio: 'inherit' })
  : spawnSync('python3', [py, S, GIF], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('GIF assembly failed (needs Pillow, or uv to fetch it)');
rmSync(S, { recursive: true, force: true, maxRetries: 5 });
console.log(`wrote ${path.relative(REPO, GIF)}`);
