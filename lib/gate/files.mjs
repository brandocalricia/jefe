// files: `start` writes the project's file list to .jefe/files.txt, so a helper reads a list instead of running `find` (a Bash listing the auto-mode
// classifier can deny). In a git work tree: tracked plus untracked-not-ignored files, through the gate's own git (safety switches on, nested repositories
// left out). Otherwise (no repository, no git, an unreadable configuration): a plain walk that never follows a symlink. Bounded in lines, bytes, entries and time.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { safe } from '../../hooks/projects.mjs';
import { remainingMs } from './env.mjs';
import { writeAtomic } from './fsutil.mjs';
import { git, nestedExcludes, repoTop, splitZ } from './git.mjs';

export const FILES_REL = '.jefe/files.txt';
const MAX_LINES = 2000;
const MAX_BYTES = 200 * 1024;
const MAX_ENTRIES = 20000;
const SKIP = new Set(['.git', '.jefe', 'node_modules', '.venv', 'venv', '__pycache__']);

// -> { names: [relative paths], partial: bool } | { error }. Paths use `/`.
function walk(root, deadline) {
  const names = [];
  const queue = [''];
  let entries = 0;
  while (queue.length) {
    if (Date.now() > deadline) return { error: 'out of time' };
    const rel = queue.shift();
    let list;
    try {
      list = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch (e) {
      if (!rel) return { error: `cannot read the folder (${(e && e.code) || 'error'})` };
      continue; // an unreadable subfolder is skipped
    }
    for (const d of list) {
      if (++entries > MAX_ENTRIES) return { names, partial: true };
      if (SKIP.has(d.name)) continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) queue.push(p); // a symlink is never a directory here: it is listed, not followed
      else names.push(p);
    }
  }
  return { names, partial: false };
}

function gitList(root, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) return { error: 'out of time' };
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.', ':(exclude).jefe', ...nestedExcludes(root)], { timeout: Math.max(1, deadline - Date.now()) });
  return { names: [...new Set(splitZ(out))], partial: false };
}

// Writes .jefe/files.txt and returns the one line `start` prints. Never throws.
export function writeFileList(root) {
  try {
    const deadline = Date.now() + Math.max(0, Math.min(1000, remainingMs()));
    let r;
    let top = null;
    try {
      top = repoTop(root); // null: no repository, no git, or a configuration the gate cannot read (then no gate git call runs)
    } catch {
      top = null;
    }
    if (top) {
      try {
        r = gitList(root, deadline);
      } catch (e) {
        r = { error: e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL') ? 'git timed out' : 'git ls-files failed' };
      }
    } else r = walk(root, deadline);
    if (r.error) return `files: not listed (${safe(r.error)})`;
    if (Date.now() > deadline) return 'files: not listed (out of time)';
    const all = r.names.filter((n) => n !== '.jefe' && !n.startsWith('.jefe/')).map((n) => safe(n)).sort();
    const kept = [];
    let bytes = 0;
    for (const n of all) {
      const b = Buffer.byteLength(n) + 1;
      if (kept.length >= MAX_LINES || bytes + b > MAX_BYTES) break;
      kept.push(n);
      bytes += b;
    }
    writeAtomic(join(root, '.jefe', 'files.txt'), kept.length ? `${kept.join('\n')}\n` : '', true);
    const count = r.partial ? `at least ${all.length} files` : `${all.length} file${all.length === 1 ? '' : 's'}`;
    return `files: ${FILES_REL} (${count}${kept.length < all.length || r.partial ? `, first ${kept.length} listed` : ''})`;
  } catch (e) {
    return `files: not listed (${safe(String((e && (e.code === 'ESYMLINK' ? 'the file or .jefe is a symlink' : e.code || e.message)) || 'error').slice(0, 80))})`;
  }
}
