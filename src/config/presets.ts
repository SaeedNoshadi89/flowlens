import { readFileSync } from 'node:fs';
import path from 'node:path';
import { walk, type SourceFile } from '../scan/walker.ts';

export const PRESET_NAMES = ['whole', 'backend', 'frontend', 'agents', 'here'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface PresetResolution {
  name: PresetName;
  paths: string[];
  /** Why each path was chosen. */
  reasons: Record<string, string>;
  note?: string;
}

const NAME_HINTS: Record<'backend' | 'frontend' | 'agents', RegExp> = {
  frontend: /^(web|frontend|front-end|client|ui|webapp|web-app|www|site|dashboard|portal|spa)$/i,
  backend: /^(backend|back-end|server|api|services?|svc)$/i,
  agents: /^(agents?|orchestrat(or|ion)|workflows?|crew|graphs?|assistants?)$/i,
};

const MANIFEST_HINTS: Record<'backend' | 'frontend' | 'agents', RegExp> = {
  frontend: /"(react|react-dom|vue|svelte|@angular\/core|next|nuxt|solid-js|preact|vite|@remix-run\/react)"\s*:/,
  backend: /"(express|fastify|koa|@nestjs\/core|hono)"\s*:|^\s*(fastapi|flask|django|starlette|aiohttp|sanic|litestar)\b|["'](fastapi|flask|django|starlette)[^"']*["']/im,
  agents: /"(@openai\/agents|langchain|@langchain\/langgraph|llamaindex)"\s*:|^\s*(langgraph|langchain|openai-agents|crewai|autogen|pyautogen|llama-index)\b|["'](langgraph|openai-agents|crewai)[^"']*["']/im,
};

const IMPORT_HINTS: Record<'backend' | 'frontend' | 'agents', RegExp> = {
  frontend: /from\s+['"](react|react-dom|vue|svelte|next\/[\w/-]+|@angular\/core|solid-js|preact)['"]/,
  backend: /^\s*from\s+(fastapi|flask|django|starlette)\b|^\s*import\s+(fastapi|flask)\b|from\s+['"](express|fastify|koa|hono)['"]/m,
  agents: /^\s*from\s+(langgraph|langchain|agents|crewai|autogen)\b|^\s*import\s+(langgraph|crewai)\b|from\s+['"](@openai\/agents|@langchain\/langgraph)['"]|\bStateGraph\s*\(|\bhandoffs\s*=/m,
};

function dirsOf(rel: string, maxDepth: number): string[] {
  const parts = rel.split('/').slice(0, -1);
  const out: string[] = [];
  for (let i = 1; i <= Math.min(parts.length, maxDepth); i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/** Resolve each preset to folders, using folder names, manifests and import lines. Read-only. */
export function resolvePresets(root: string, cwdRelative = ''): Record<PresetName, PresetResolution> {
  const scan = walk({ root, include: [], exclude: [] });
  const byDir = new Map<string, SourceFile[]>();
  for (const f of scan.files) {
    for (const d of dirsOf(f.rel, 3)) {
      const list = byDir.get(d) ?? [];
      list.push(f);
      byDir.set(d, list);
    }
  }
  const manifestByDir = new Map<string, string>();
  for (const m of scan.manifests) {
    const d = path.posix.dirname(m);
    try {
      manifestByDir.set(d, (manifestByDir.get(d) ?? '') + '\n' + readFileSync(path.join(root, m), 'utf8').slice(0, 200_000));
    } catch {
      /* unreadable */
    }
  }
  const importCache = new Map<string, string>();
  const head = (f: SourceFile): string => {
    let t = importCache.get(f.rel);
    if (t === undefined) {
      try {
        t = readFileSync(f.abs, 'utf8').slice(0, 6000);
      } catch {
        t = '';
      }
      importCache.set(f.rel, t);
    }
    return t;
  };

  // Folders whose own manifest names a framework of another kind; name hints do not reach inside them
  // (e.g. web/src/api/ in a React app is client code, not a backend).
  const manifestKind = (d: string): ('backend' | 'frontend' | 'agents')[] => {
    const m = manifestByDir.get(d);
    if (!m) return [];
    return (['frontend', 'backend', 'agents'] as const).filter((k) => MANIFEST_HINTS[k].test(m));
  };
  const insideOther = (d: string, kind: string): boolean => {
    const parts = d.split('/');
    for (let i = 1; i < parts.length; i++) {
      const kinds = manifestKind(parts.slice(0, i).join('/'));
      if (kinds.length && !kinds.includes(kind as 'backend')) return true;
    }
    return false;
  };

  const resolveKind = (kind: 'backend' | 'frontend' | 'agents'): PresetResolution => {
    const chosen: string[] = [];
    const reasons: Record<string, string> = {};
    const dirs = [...byDir.keys()].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    for (const d of dirs) {
      if (chosen.some((c) => d === c || d.startsWith(c + '/'))) continue;
      const files = byDir.get(d)!;
      const base = path.posix.basename(d);
      const manifest = manifestByDir.get(d);
      let reason = '';
      if (manifest && MANIFEST_HINTS[kind].test(manifest)) reason = 'manifest lists a matching framework';
      else if (NAME_HINTS[kind].test(base) && files.length > 0 && !insideOther(d, kind)) reason = `folder name "${base}"`;
      else {
        const sample = files.slice(0, 300);
        const hits = sample.filter((f) => IMPORT_HINTS[kind].test(head(f)) || (kind === 'frontend' && /\.(tsx|jsx)$/.test(f.rel))).length;
        // Only a folder where matching imports dominate, so that one stray file does not pull in its parent.
        if (hits >= 1 && hits / sample.length >= 0.3 && d.split('/').length >= 1) reason = `${hits} file(s) import matching libraries`;
      }
      if (reason) {
        chosen.push(d);
        reasons[d] = reason;
      }
    }
    // Drop a broad top-level match when narrower ones exist below other roots? Keep simple and explicit.
    return {
      name: kind,
      paths: chosen,
      reasons,
      note: chosen.length ? undefined : `No folder matched the ${kind} preset. Choose folders explicitly with --include.`,
    };
  };

  return {
    whole: { name: 'whole', paths: [], reasons: { '.': 'whole repository' } },
    backend: resolveKind('backend'),
    frontend: resolveKind('frontend'),
    agents: resolveKind('agents'),
    here: cwdRelative
      ? { name: 'here', paths: [cwdRelative], reasons: { [cwdRelative]: 'current directory' } }
      : { name: 'here', paths: [], reasons: { '.': 'current directory is the root' } },
  };
}

/** Union the paths of several presets; "whole" anywhere means the whole repository. */
export function combinePresets(names: PresetName[], resolved: Record<PresetName, PresetResolution>): string[] {
  if (names.includes('whole')) return [];
  const all = new Set<string>();
  for (const n of names) for (const p of resolved[n].paths) all.add(p);
  if (names.includes('here') && resolved.here.paths.length === 0) return [];
  const sorted = [...all].sort();
  return sorted.filter((p) => !sorted.some((q) => q !== p && p.startsWith(q + '/')));
}
