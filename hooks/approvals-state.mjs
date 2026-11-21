// The approval state of a job, in the user-level registry (outside any project). Node built-ins only: the PreToolUse permit hook loads this
// on every tool call. State file: <registry>/run/<key>.allow.json, key = first 16 hex of sha256 of the project root's REAL path
// (the same key scheme as hooks/runfile.mjs; tests pin that). Every caller goes through stateFile(), so every caller keys by the real path.

import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pickJefeHome } from './jefe-home.mjs';
import { accountHome } from './root-node.mjs';

// THE list of the files this plugin keeps in <jefe home>/run for one project folder: <key><suffix>. Everything that names, reads or removes one goes
// through it (siblingRunFile, RUN_SUFFIXES: unregister removes every kind), so a new run file is added here once and cannot be forgotten.
// (hooks/runfile.mjs is a pure module the mod imports and cannot import this one; a test pins its two suffixes to this list.)
export const RUN_SUFFIX = { run: '.json', gate: '.gate.json', level: '.level.json', name: '.name', commits: '.commits.json', checks: '.checks.json', allow: '.allow.json', brief: '.brief', report: '.report.json', baseline: '.baseline.json', taskfail: '.task-failed.json', spawns: '.spawns' };
export const RUN_SUFFIXES = Object.values(RUN_SUFFIX);
// The file of kind (a key of RUN_SUFFIX) that sits beside a run file path (<key>.json).
export const siblingRunFile = (runFile, kind) => runFile.replace(/\.json$/, RUN_SUFFIX[kind]);

export const ENDING_MINUTES = 30;
// The ending window: JEFE_ENDING_MINUTES (integer 1-120) overrides the default.
export function endingMinutes(raw = process.env.JEFE_ENDING_MINUTES) {
  const t = String(raw === undefined ? '' : raw).trim();
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  return n >= 1 && n <= 120 ? n : ENDING_MINUTES;
}

// The one definition of the path helpers every module uses.
// realOr: the real path, or null when it does not exist. realOf: the real path, else the path as given.
export const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
export const realOf = (p) => realOr(p) ?? p;

// The real path of p, where p may not exist yet: the nearest existing ancestor is resolved, the rest is appended.
// null for a dangling symlink (writing through it would create its target).
export function realish(p) {
  let cur = resolve(p);
  const rest = [];
  for (let k = 0; k < 64; k++) {
    const r = realOr(cur);
    if (r !== null) return rest.length ? join(r, ...rest.reverse()) : r;
    try {
      lstatSync(cur);
      return null;
    } catch {
      // nothing there: keep walking up
    }
    const up = dirname(cur);
    if (up === cur) return null;
    rest.push(basename(cur));
    cur = up;
  }
  return null;
}

// THE registry home (one definition; every reader goes through it). -> { home, problem }
//   JEFE_HOME counts only when it is an absolute path without a `..` segment that resolves and is not inside the project folder (real paths: a
//   symlink into it is inside it; on darwin and win32, where volumes are case-insensitive, names are compared folded (foldName), like inRegistry). Otherwise the fallback
//   <account home>/.claude/jefe applies whenever it resolves (no inside-the-project test: a repository cannot point the account's own default
//   location anywhere, and the hook already refuses writes into the registry). `problem` says why JEFE_HOME was not used (or why nothing
//   is usable); `home` is null only when the default cannot be resolved: fail closed (no approvals, no state). root null: no inside-the-project test.
//   Besides the text rules the folders themselves are compared (sameFolderAsRoot: device and inode), which also catches spellings the text rules
//   do not know (macOS's /.vol/<dev>/<ino>, letter case on a case-insensitive Linux volume).
export function registryInfo(root = null, { env = process.env, platform = process.platform, home: acct = undefined } = {}) {
  // the rule itself is pickJefeHome (hooks/jefe-home.mjs), the one copy the mod uses too; this side only resolves the paths with node:fs
  const h = env.JEFE_HOME;
  const absolute = !!h && isAbsolute(h);
  const real = absolute ? realish(h) : null;
  const rootReal = root ? (realish(root) ?? resolve(root)) : null;
  const ci = platform === 'darwin' || platform === 'win32';
  const sameFolder = absolute && rootReal !== null ? sameFolderAsRoot([resolve(h), real], rootReal) : false;
  const first = pickJefeHome({ given: h, absolute, real, rootReal, fallback: null, fallbackReal: null, ci, sep, sameFolder });
  if (first.home !== null) return first; // JEFE_HOME is usable: the account's home is not looked up
  const base = acct !== undefined ? acct : accountHome(); // `home` option: the account's home folder instead of the system's (tests)
  const fallback = base === null ? null : join(base, '.claude', 'jefe');
  return pickJefeHome({ given: h, absolute, real, rootReal, fallback, fallbackReal: fallback === null ? null : realish(fallback), ci, sep, sameFolder });
}
// Is any of the paths, or any folder above it, the project folder itself (same device and inode, links followed)? A path's own spelling cannot
// hide the folder from this: realpath keeps some aliases as they are and fails on others. Both the text and the real path are walked, because
// above a symbolic link the two lead to different parents. false when the root cannot be read or reports no inode (some Windows volumes).
export function sameFolderAsRoot(paths, rootReal) {
  let r;
  try {
    r = statSync(rootReal, { bigint: true });
  } catch {
    return false;
  }
  if (r.ino === 0n) return false;
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    let cur = resolve(p);
    for (let k = 0; k < 4096; k++) {
      try {
        const st = statSync(cur, { bigint: true });
        if (st.dev === r.dev && st.ino === r.ino) return true;
      } catch {
        // not there (or not readable): keep walking up
      }
      const up = dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  return false;
}
// Why JEFE_HOME is not used for a project, or null (see registryInfo).
export const registryProblem = (root, opts) => registryInfo(root, opts).problem;
// The registry folder for this project root, or null when none is usable.
export const registryHome = (root = null, opts) => registryInfo(root, opts).home;

export const stateKey = (realRoot) => createHash('sha256').update(String(realRoot), 'utf8').digest('hex').slice(0, 16);
export function stateDir(root = null, opts) {
  const h = registryHome(root, opts);
  if (h === null) throw Object.assign(new Error('no usable registry folder'), { code: 'ENOREGISTRY' });
  return join(h, 'run');
}
// The state file of a project folder (any spelling of its path: it is resolved first, so every caller keys by the real path).
export function stateFile(root) {
  const real = realOf(root);
  return join(stateDir(real), `${stateKey(real)}${RUN_SUFFIX.allow}`);
}
// The file of the recorded stage checks for the same project (same folder, same key).
export const checksFile = (root) => stateFile(root).slice(0, -RUN_SUFFIX.allow.length) + RUN_SUFFIX.checks;
// The file holding the ending finish's final-message lines (the Stop hook reads it), same folder, same key.
export const reportFile = (root) => stateFile(root).slice(0, -RUN_SUFFIX.allow.length) + RUN_SUFFIX.report;
// Set by hooks/task.mjs when it could not write .jefe/task.md ({ at }); `start` then says the task file is missing. Same folder, same key.
export const taskFailFile = (root) => stateFile(root).slice(0, -RUN_SUFFIX.allow.length) + RUN_SUFFIX.taskfail;
// Does the registry hold any run file (of any kind) for this project folder? (a folder this Jefe has never worked in has none)
export function hasRunFiles(root) {
  try {
    const real = realOf(root);
    const base = join(stateDir(real), stateKey(real));
    return RUN_SUFFIXES.some((s) => {
      try {
        return lstatSync(base + s).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function readJson(file) {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}
// Is the approvals file private? A regular file (lstat: a symlink is not one) owned by this user and writable by no one else, in a folder that is
// not world-writable without the sticky bit. Anyone else who could write it could grant approvals. Not checked on win32 (no POSIX modes).
export function privateFile(file, platform = process.platform) {
  return fileProblem(file, platform) === null;
}
// Why privateFile refuses a file: null when it is private (always on win32), 'missing' when there is none (or it cannot be read), else a phrase
// that follows "the approvals file <path>".
export function fileProblem(file, platform = process.platform) {
  if (platform === 'win32') return null;
  let st;
  let dir;
  try {
    st = lstatSync(file);
    dir = lstatSync(dirname(file));
  } catch {
    return 'missing';
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (st.isSymbolicLink()) return 'is a symbolic link';
  if (!st.isFile()) return 'is not a regular file';
  if ((st.mode & 0o022) !== 0) return 'is writable by others';
  if (uid !== null && st.uid !== uid) return 'belongs to another user';
  // a run folder that is a symbolic link: its own mode says nothing (0777 on Linux, 0755 on macOS), so it is named as what it is, on every platform
  if (dir.isSymbolicLink()) return 'is in a folder that is a symbolic link';
  if ((dir.mode & 0o002) !== 0 && (dir.mode & 0o1000) === 0) return 'is in a folder everyone can write to';
  return null;
}
// The approvals file of this folder exists but readState ignores it: -> { file, why } (why: a fileProblem phrase), or null.
export function refusedState(root) {
  try {
    const file = stateFile(root);
    const why = fileProblem(file);
    return why === null || why === 'missing' ? null : { file, why };
  } catch {
    return null;
  }
}
export function readState(root) {
  try {
    const file = stateFile(root);
    return privateFile(file) ? readJson(file) : null; // group- or world-writable, another owner's, or in an open folder: no approvals
  } catch {
    return null; // no usable registry folder: nothing is approved
  }
}

// The folder's identity: device and inode as strings, plus the birth time on macOS only (a deleted and re-created folder differs there). Elsewhere
// Node can report the change time as the birth time (Linux without statx), which moves whenever the folder's entries change.
export function identityOf(root, platform = process.platform) {
  try {
    const st = statSync(root, { bigint: true });
    const id = { dev: String(st.dev), ino: String(st.ino) };
    if (platform === 'darwin') id.birth = st.birthtimeMs > 0n ? String(st.birthtimeMs) : '0';
    return id;
  } catch {
    return null;
  }
}
// Do two identities name the same folder? (birth counts only on darwin, and only when both have one)
export function identityMatches(a, b, platform = process.platform) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a.dev !== b.dev || a.ino !== b.ino) return false;
  if (platform !== 'darwin') return true;
  return !a.birth || !b.birth || a.birth === '0' || b.birth === '0' || a.birth === b.birth;
}
// true when the state was recorded for this very folder (a state without an identity never matches)
export const sameIdentity = (state, root, platform = process.platform) => identityMatches(state && state.identity, identityOf(root, platform), platform);

// Atomic 0600 write that refuses to go through a symlinked folder or file (the guard the other writers use). Throws on refusal.
export function writeStateFile(file, body, beforeRename = null) {
  for (const p of [dirname(file), file]) {
    try {
      if (lstatSync(p).isSymbolicLink()) throw new Error(`refusing to write: ${p} is a symlink`);
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.r.tmp`; // not the name writePrivate uses: a writer in the same process and millisecond must not collide
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best effort
  }
  if (beforeRename) beforeRename();
  renameSync(tmp, file);
}

// Idle window: an approved call by the session that owns an `ending` state, when at least min(60 s, a quarter of the window) has passed since the last renewal (or
// since the ending began), pushes the expiry to now + window (never past `limit`), so the allowance is 29 to 30 minutes of idle time and writes
// stay rare. Nothing else extends it. Safe against parallel tool calls and a racing `deactivate`: it re-reads right before writing and writes
// only if the file is still the same active, ending state of this session; just before the rename it reads once more, and if the file turned
// inactive (or changed) in between, it puts back what it found there (the inactive state wins) instead of leaving its renewal. Simple, no lock:
// the one window left is the microseconds between that last read and the rename. Never throws. `hooks` = { afterReread, beforeRename } for tests.
export function touchEnding(root, session, now = Date.now(), hooks = {}) {
  try {
    const ok = (s) => s && s.active === true && s.ending === true && typeof s.session === 'string' && s.session !== '' && s.session === session;
    const stamp = (s) => `${s.expires}|${s.endingAt}|${s.renewedAt}`;
    const s = readState(root);
    if (!ok(s)) return false;
    const exp = Date.parse(s.expires);
    const limit = Date.parse(s.limit);
    const last = Date.parse(s.renewedAt || s.endingAt);
    const win = endingMinutes() * 60 * 1000;
    if (!Number.isFinite(exp) || !Number.isFinite(limit) || exp <= now || now >= limit) return false;
    if (Number.isFinite(last) && now - last < Math.min(60 * 1000, win / 4)) return false; // at most once a minute, and at least four times per window
    const next = Math.min(limit, now + win);
    if (next <= exp) return false;
    const again = readState(root);
    if (!ok(again) || stamp(again) !== stamp(s)) return false;
    if (hooks.afterReread) hooks.afterReread();
    const file = stateFile(root);
    let pre = null;
    writeStateFile(file, { ...again, expires: new Date(next).toISOString(), renewedAt: new Date(now).toISOString() }, () => {
      if (hooks.beforeRename) hooks.beforeRename();
      pre = readState(root);
    });
    if (ok(pre) && stamp(pre) === stamp(s)) return true;
    // the file changed (a deactivate, or a newer renewal) before our rename replaced it: put back what was there
    try {
      if (pre) writeStateFile(file, pre);
      else unlinkSync(file);
    } catch {
      // the approvals expire on their own
    }
    return false;
  } catch {
    return false;
  }
}
