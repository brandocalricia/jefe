#!/usr/bin/env node
// SessionEnd / PreCompact command hook. Reads hook JSON on stdin. <root> is the project root of the hook's cwd, by the
// one project-root rule every hook uses (hooks/root.mjs, via resolveRootSync): a session in a subfolder stamps its project's
// .jefe, never one of its own. Only when <root>/.jefe/ exists, OVERWRITES <root>/.jefe/state.json with the time, the
// last known phase and running agents (null when unavailable) and the files
// `git status --porcelain -z` lists (at most 50). Never touches handoff.md. Never throws, makes
// no model call. On PreCompact it prints one line for the compactor.
//
// The phase and agents are "if available": the mod does not write them, so they
// are read from <root>/.jefe/phase.json (the mod overwrites it as it goes, along
// with the last context reading) and are null when there is none, or when its own
// `time` is older than PHASE_FRESH_MS (stale data is never restamped as current).
// The mod also overwrites phase.json with an empty phase when the band dismisses.

import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitArgs, gitEnv, setGitBudget } from './git-safe.mjs';
import { freshPhase } from './modlogic.mjs';
import { resolveRootSync } from './root-node.mjs';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Reads a small regular file without following a symlink or blocking on a pipe; null otherwise.
function readJson(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 65536) return null;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n <= 0) break;
      got += n;
    }
    return JSON.parse(buf.subarray(0, got).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

// phase.json is repo-controlled data: only these values, lengths and keys are copied into state.json.
export const KNOWN_PHASES = ['INTERVIEW', 'CONFIRM', 'DELEGATE', 'REVIEW', 'REPORT', 'WORKING', 'PARKED'];
const MAX_STR = 64;
const cleanNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cleanStr = (v) => (typeof v === 'string' ? v.slice(0, MAX_STR) : null);

export function cleanPhase(v) {
  return typeof v === 'string' && KNOWN_PHASES.includes(v) ? v : null;
}

export function cleanAgents(v) {
  const n = cleanNum(v);
  return n === null ? null : Math.max(0, Math.min(10000, Math.round(n)));
}

export function cleanContext(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const k of ['tokens', 'window', 'percent']) if (Object.hasOwn(v, k) && cleanNum(v[k]) !== null) out[k] = cleanNum(v[k]);
  if (Object.hasOwn(v, 'over') && typeof v.over === 'boolean') out.over = v.over;
  return out;
}

const isSymlink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

export const MAX_FILES = 50;
export const GIT_TIMEOUT_MS = 500; // whole hook stays well under 1 s (SessionEnd budget is 1.5 s)

// Parse `git status --porcelain -z`: entries are "XY path" separated by NUL; a rename or
// copy ("R " / "C ") is followed by one more entry holding the original path, which is skipped.
export function parsePorcelainZ(out) {
  const parts = String(out || '').split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (/[RC]/.test(xy)) i += 1; // skip the original path
  }
  return files;
}

// { files: string[] (at most MAX_FILES), total } or null when git is unavailable.
function gitFiles(cwd) {
  // the whole git part (reading the configuration and the status) shares ONE budget; when it is used up the stamp skips its git part, as it does when git is slow
  const deadline = Date.now() + GIT_TIMEOUT_MS;
  setGitBudget(() => deadline - Date.now());
  try {
    const env = gitEnv(cwd); // throws when the repository's configuration cannot be read: no git call then
    const left = deadline - Date.now();
    if (!(left > 0)) return null;
    const r = spawnSync(
      'git',
      gitArgs(cwd, ['--no-optional-locks', 'status', '--porcelain', '-z', '--ignore-submodules=all', '--']), // hooks, monitor, filters, external diff off, nested repositories not entered: a hostile .git/config runs nothing
      { encoding: 'utf8', timeout: left, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env },
    );
    if (r.error || r.status !== 0) return null;
    const all = parsePorcelainZ(r.stdout).filter((f) => !f.startsWith('.jefe/')); // the state file itself is not news
    return { files: all.slice(0, MAX_FILES).map((f) => f.slice(0, 300)), total: all.length };
  } catch {
    return null;
  }
}

export function stamp(input) {
  const raw = input && typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  try {
    let cwd;
    try {
      cwd = resolveRootSync(realpathSync(raw)); // the project root, as the other hooks find it (permit-core findRoot): not the raw folder
    } catch {
      return false;
    }
    const dir = join(cwd, '.jefe');
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) {
      process.stderr.write(`jefe: not writing state: ${dir} is a symlink\n`);
      return false;
    }
    if (!st.isDirectory()) return false;
    const target = join(dir, 'state.json');
    if (isSymlink(target)) {
      process.stderr.write(`jefe: not writing state: ${target} is a symlink\n`);
      return false;
    }
    const git = gitFiles(cwd);
    const known = freshPhase(readJson(join(dir, 'phase.json')));
    const evt = input && typeof input.hook_event_name === 'string' ? input.hook_event_name : null;
    const state = {
      time: new Date().toISOString(),
      event: cleanStr(evt),
      phase: cleanPhase(known.phase),
      agents: cleanAgents(known.agents),
      context: cleanContext(known.context),
      files: git ? git.files : null,
      filesTotal: git ? git.total : null,
    };
    const tmp = join(dir, `.state.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    input = {};
  }
  stamp(input);
  if (input && input.hook_event_name === 'PreCompact') {
    console.log('Jefe: keep the current Jefe phase and agents in the summary, and re-read .jefe/handoff.md after compaction.');
  }
}

try {
  main();
} catch {
  // never throw
}
