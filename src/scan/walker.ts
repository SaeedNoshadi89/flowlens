import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

/** Folders never scanned: dependencies, build output, caches, tool state. */
export const DEFAULT_EXCLUDED_DIRS = [
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '.output', 'coverage', '.nyc_output', '__pycache__', '.venv', 'venv', 'env', '.env', '.tox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'target', 'vendor', 'bower_components', '.turbo',
  '.cache', '.parcel-cache', '.gradle', '.idea', '.vscode', 'site-packages', '.flowlens',
  '.terraform', '.serverless', '.yarn', '.pnpm-store', 'Pods', 'DerivedData',
];

/** File names and patterns that look like secrets or credentials. Never read. */
const SECRET_PATTERNS: RegExp[] = [
  /^\.env($|\.)/i, /\.env$/i, /\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|asc|gpg|crt|cer|der)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i, /^\.?(npmrc|pypirc|netrc|pgpass|htpasswd|git-credentials|dockercfg)$/i,
  /^credentials?(\..*)?$/i, /^secrets?(\..*)?$/i, /\.secrets?(\..*)?$/i, /secret.*\.(json|ya?ml|toml|txt)$/i,
  /^service[-_]?account.*\.json$/i, /\.tfvars$/i, /\.tfstate(\.backup)?$/i, /^\.?aws_credentials$/i,
  /token.*\.(json|txt)$/i,
];

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'svgz', 'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz',
  '7z', 'rar', 'jar', 'war', 'class', 'exe', 'dll', 'so', 'dylib', 'a', 'o', 'obj', 'wasm', 'bin', 'dat',
  'db', 'sqlite', 'sqlite3', 'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'flac', 'ogg', 'woff', 'woff2',
  'ttf', 'otf', 'eot', 'psd', 'ai', 'sketch', 'fig', 'pyc', 'pyo', 'whl', 'egg', 'node', 'lock',
  'parquet', 'avro', 'pkl', 'pickle', 'npy', 'npz', 'h5', 'onnx', 'pt', 'ckpt', 'safetensors',
]);

const MINIFIED = /\.min\.(js|css)$|\.bundle\.js$|\.map$/i;

export const LANGUAGE_BY_EXT: Record<string, string> = {
  py: 'python', pyi: 'python',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp',
  swift: 'swift', scala: 'scala', vue: 'vue', svelte: 'svelte', dart: 'dart', ex: 'elixir', exs: 'elixir',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
};
export const SUPPORTED_LANGUAGES = new Set(['python', 'javascript', 'typescript']);

export const MAX_FILE_BYTES = 1_000_000;

export interface SourceFile {
  /** Repository-relative POSIX path. */
  rel: string;
  abs: string;
  language: string;
  size: number;
}

export interface WalkOptions {
  root: string;
  /** Repository-relative folders or files to scan. Empty means the whole root. */
  include: string[];
  /** Extra gitignore-style patterns, relative to the root. */
  exclude: string[];
}

export interface WalkResult {
  files: SourceFile[];
  /** Other files seen, by language, that no adapter reads (for coverage). */
  otherLanguages: Record<string, number>;
  skipped: Record<string, number>;
  considered: number;
  /** Manifest files found (package.json, pyproject.toml, requirements*.txt) for framework detection. */
  manifests: string[];
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function isSecretName(name: string): boolean {
  if (/^\.env\.(example|sample|template|dist)$/i.test(name)) return true; // still config values: skip as well
  return SECRET_PATTERNS.some((re) => re.test(name));
}

function looksBinary(abs: string): boolean {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } finally {
    closeSync(fd);
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Walk the selected scope read-only. Honors .gitignore files (root and nested),
 * .flowlensignore, explicit exclusions and the default exclusions. Never follows
 * a symlink whose target is outside the root, and never descends symlinked folders.
 */
export function walk(opts: WalkOptions): WalkResult {
  const root = realpathSync(opts.root);
  const result: WalkResult = { files: [], otherLanguages: {}, skipped: {}, considered: 0, manifests: [] };
  const userIgnore = ignore().add(opts.exclude);
  const ignoreStack: { base: string; ig: Ignore }[] = [];

  const loadIgnores = (dirAbs: string, dirRel: string) => {
    const ig = ignore();
    let found = false;
    for (const name of ['.gitignore', '.flowlensignore']) {
      try {
        ig.add(readFileSync(path.join(dirAbs, name), 'utf8'));
        found = true;
      } catch {
        /* none */
      }
    }
    return found ? { base: dirRel, ig } : null;
  };

  const ignoredByStack = (rel: string, isDir: boolean): boolean => {
    for (const { base, ig } of ignoreStack) {
      const sub = base ? (rel.startsWith(base + '/') ? rel.slice(base.length + 1) : null) : rel;
      if (sub === null || sub === '') continue;
      if (ig.ignores(isDir ? sub + '/' : sub)) return true;
    }
    return false;
  };

  const includes = opts.include.map((p) => p.replace(/^(\.\/)+/, '').replace(/\/+$/, '')).filter((p) => p && p !== '.');
  const inScope = (rel: string, isDir: boolean): boolean => {
    if (includes.length === 0) return true;
    return includes.some((inc) => rel === inc || rel.startsWith(inc + '/') || (isDir && inc.startsWith(rel + '/')));
  };

  const visit = (dirAbs: string, dirRel: string) => {
    const pushed = loadIgnores(dirAbs, dirRel);
    if (pushed) ignoreStack.push(pushed);
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      bump(result.skipped, 'unreadable');
      if (pushed) ignoreStack.pop();
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
      const abs = path.join(dirAbs, ent.name);
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(abs);
        } catch {
          bump(result.skipped, 'broken-symlink');
          continue;
        }
        const relReal = path.relative(root, real);
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
          bump(result.skipped, 'symlink-outside-root');
          continue;
        }
        const st = statSync(real);
        if (st.isDirectory()) {
          bump(result.skipped, 'symlinked-directory');
          continue;
        }
        isFile = st.isFile();
        isDir = false;
      }
      if (isDir) {
        if (DEFAULT_EXCLUDED_DIRS.includes(ent.name) || ent.name.endsWith('.egg-info')) {
          bump(result.skipped, 'default-excluded-directory');
          continue;
        }
        if (!inScope(rel, true)) continue;
        if (userIgnore.ignores(rel + '/')) {
          bump(result.skipped, 'excluded-by-option');
          continue;
        }
        if (ignoredByStack(rel, true)) {
          bump(result.skipped, 'ignored-by-ignore-file');
          continue;
        }
        visit(abs, rel);
        continue;
      }
      if (!isFile) continue;
      if (!inScope(rel, false)) continue;
      result.considered++;
      if (userIgnore.ignores(rel)) {
        bump(result.skipped, 'excluded-by-option');
        continue;
      }
      if (ignoredByStack(rel, false)) {
        bump(result.skipped, 'ignored-by-ignore-file');
        continue;
      }
      if (isSecretName(ent.name)) {
        bump(result.skipped, 'secret-like-file');
        continue;
      }
      const ext = ent.name.includes('.') ? ent.name.split('.').pop()!.toLowerCase() : '';
      if (BINARY_EXT.has(ext)) {
        bump(result.skipped, 'binary');
        continue;
      }
      if (ent.name === 'package.json' || ent.name === 'pyproject.toml' || /^requirements.*\.txt$/.test(ent.name) || ent.name === 'Pipfile') {
        result.manifests.push(rel);
      }
      const language = LANGUAGE_BY_EXT[ext];
      if (!language) continue;
      if (MINIFIED.test(ent.name)) {
        bump(result.skipped, 'minified-or-generated');
        continue;
      }
      let size: number;
      try {
        size = statSync(abs).size;
      } catch {
        bump(result.skipped, 'unreadable');
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        bump(result.skipped, 'too-large');
        continue;
      }
      if (looksBinary(abs)) {
        bump(result.skipped, 'binary');
        continue;
      }
      if (!SUPPORTED_LANGUAGES.has(language)) {
        bump(result.otherLanguages, language);
        continue;
      }
      result.files.push({ rel: toPosix(rel), abs, language, size });
    }
    if (pushed) ignoreStack.pop();
  };

  visit(root, '');
  return result;
}

/** List top-level folders (non-excluded) for the scope panel. */
export function topLevelDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !DEFAULT_EXCLUDED_DIRS.includes(d.name) && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
