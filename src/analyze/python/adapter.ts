import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyFacts, type FileFacts, type LanguageAdapter } from '../facts.ts';

function scriptSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Source layout (src/analyze/python) and bundle layout (dist/) both keep the script next to the code.
  for (const p of [path.join(here, 'pyfacts.py'), path.join(here, 'analyze', 'python', 'pyfacts.py')]) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error('pyfacts.py not found next to the FlowLens engine');
}

function pythonCommand(): string | null {
  const candidates = process.env.FLOWLENS_PYTHON ? [process.env.FLOWLENS_PYTHON] : ['python3', 'python'];
  for (const c of candidates) {
    const r = spawnSync(c, ['-I', '-c', 'import sys, ast; print(sys.version_info[0]*100+sys.version_info[1])'], { encoding: 'utf8' });
    if (r.status === 0 && Number(r.stdout.trim()) >= 308) return c;
  }
  return null;
}

/** Python adapter: runs the bundled stdlib-only `ast` extractor in isolated mode (-I). */
export function pythonAdapter(): LanguageAdapter {
  let cmd: string | null | undefined;
  return {
    id: 'python.ast',
    language: 'python',
    extensions: ['py', 'pyi'],
    available() {
      if (cmd === undefined) cmd = pythonCommand();
      return cmd ? { ok: true } : { ok: false, reason: 'Python 3.8+ interpreter not found (set FLOWLENS_PYTHON)' };
    },
    async extract(files) {
      if (cmd === undefined) cmd = pythonCommand();
      if (!cmd || files.length === 0) return [];
      const source = scriptSource();
      const out: FileFacts[] = [];
      const chunk = 400;
      for (let i = 0; i < files.length; i += chunk) {
        const batch = files.slice(i, i + chunk);
        const text = await run(cmd, source, JSON.stringify(batch));
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const raw = JSON.parse(line) as Partial<FileFacts> & { path: string };
          const base = emptyFacts(raw.path, 'python', 'python.ast');
          out.push({ ...base, ...raw, language: 'python', adapter: 'python.ast' } as FileFacts);
        }
      }
      return out;
    },
  };
}

function run(cmd: string, source: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // -I: isolated mode, so nothing from the analyzed project (cwd, PYTHONPATH, user site) is importable.
    const child = spawn(cmd, ['-I', '-c', source], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`python extractor failed (${code}): ${err.slice(0, 400)}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}
