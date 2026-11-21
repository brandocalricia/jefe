// The synchronous probes for the project-root rule (hooks/root.mjs): Node only, used by the permit hook, the gate and the hooks.
import { lstatSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { ancestorsOf, caseBlind, ignoredAbove, isSticky, joinPath, skipDir, stepRoot } from './root.mjs';

// THE account's home folder, as the registry has always taken it (hooks/approvals-state.mjs registryInfo): the account database's, never the HOME
// variable (a repository's settings can set it); where there is no account entry (some containers) homedir() answers from HOME. Not resolved:
// the registry path must keep the string it always had. null when none is an absolute path.
export function accountHome() {
  for (const get of [() => userInfo().homedir, () => homedir()]) {
    try {
      const h = get();
      if (typeof h === 'string' && isAbsolute(h)) return h;
    } catch {
      // try the next one
    }
  }
  return null;
}

// The home folder for the root rule: the real path of accountHome() (the folders it walks are real paths), else the plain string; null when unknown.
let homeOnce; // computed once per process: the hot path of the permit hook must not resolve it on every call
export function rootHome() {
  if (homeOnce !== undefined) return homeOnce;
  const h = accountHome();
  if (h === null) return (homeOnce = null);
  try {
    return (homeOnce = realpathSync(h));
  } catch {
    return (homeOnce = h);
  }
}

const stat = (p) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

// A REAL directory (lstat: a symlink or a file named .jefe is not a project folder), the one test for ".jefe is there" everywhere.
export const realDir = (p) => {
  const st = stat(p);
  return st !== null && st.isDirectory();
};
export const hasEntry = (p) => stat(p) !== null;

// The entries of one folder: { git, jefe, sticky }. modeOf(dir) -> mode (tests inject it; the default reads the folder's mode).
export function entriesAt(dir, modeOf = null) {
  return { git: hasEntry(joinPath(dir, '.git')), jefe: realDir(joinPath(dir, '.jefe')), sticky: isSticky(modeOf ? modeOf(dir) : (stat(dir) || {}).mode) };
}

// `start`: an absolute, already-resolved folder. home: a resolved folder, or null; omitted: the account's. opts: { platform, modeOf } (tests).
// -> the root folder. The walk stops at the first hit (no probing of the folders above it).
export function resolveRootSync(start, home = rootHome(), { platform, modeOf = null } = {}) {
  const ci = caseBlind(platform);
  const dirs = ancestorsOf(start);
  for (let i = 0; i < dirs.length; i++) {
    if (skipDir(dirs[i], i, home, ci)) continue; // never probed
    const r = stepRoot({ dir: dirs[i], ...entriesAt(dirs[i], modeOf) }, i, home, ci);
    if (r !== null) return r;
  }
  return start;
}

// The note for `start`: a real .jefe in an ordinary folder above the repository (see ignoredAbove).
export const ignoredJefeSync = (root, home = rootHome(), { platform, modeOf = null } = {}) => ignoredAbove(root, home, (dir) => entriesAt(dir, modeOf), caseBlind(platform));
