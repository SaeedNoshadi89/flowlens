import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ResolvedRoot {
  root: string;
  /** Where the search started, relative to the root ("" when it is the root). */
  cwdRelative: string;
  /** How the root was found. */
  method: 'explicit' | 'git' | 'cwd';
}

/**
 * Resolve the repository root. An explicit root wins; otherwise walk up from
 * `cwd` to the nearest folder holding `.git` (a folder, or a file for worktrees
 * and submodules); otherwise use `cwd` itself.
 */
export function resolveRoot(cwd: string, explicit?: string): ResolvedRoot {
  // Real paths, so the root, output folder and source links agree even through symlinked temp folders.
  const start = realpathSync(path.resolve(cwd));
  if (explicit) {
    const given = path.resolve(cwd, explicit);
    if (!existsSync(given) || !statSync(given).isDirectory()) throw new Error(`Root is not a directory: ${given}`);
    const root = realpathSync(given);
    return { root, cwdRelative: relIfInside(root, start), method: 'explicit' };
  }
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return { root: dir, cwdRelative: relIfInside(dir, start), method: 'git' };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: start, cwdRelative: '', method: 'cwd' };
}

function relIfInside(root: string, p: string): string {
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.split(path.sep).join('/');
}
