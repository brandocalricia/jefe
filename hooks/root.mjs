// THE project-root rule, in one place (pure: no imports, so the mod may load it). It is a function of the folder alone: no session, no approval record.
// Every caller (the gate, the permit hook, the prompt hook, the wrapper writer, the status band, jefe-project) gets its root from here, through
// resolveRootSync (hooks/root-node.mjs, sync probes) or projectRoot (hooks/runfile.mjs, injected async probes). Both loops call stepRoot.
//
//   1. Walk up from the current folder. The first folder with a `.git` entry (folder or file) or a real `.jefe` directory (a symlink is not one) is
//      the project root. None found: the current folder.
//   2. Never a root, skipped on the way up: the account's home folder, every folder above it, `/`, and a folder that everyone can write to and that
//      has the sticky bit (`/tmp`, `/var/tmp`, `/dev/shm`: mode & 0o1002 === 0o1002). The current folder itself is never skipped. The home folder is
//      compared without regard to letter case on darwin and win32.
//   3. Nothing else: no ownership test, no session, no approval record.
//   The home folder is the account database's (the caller passes it), never the HOME variable (the mod has only that).

// Paths of either kind: POSIX (`/a/b`) or Windows (`C:\a\b`, `C:/a/b`); a path that holds a backslash and no slash is a Windows one.
const sepOf = (dir) => (dir.includes('\\') && !dir.includes('/') ? '\\' : '/');
const isDriveRoot = (d) => /^[A-Za-z]:[\\/]*$/.test(d);
const trim = (dir) => {
  if (isDriveRoot(dir)) return dir.slice(0, 2) + sepOf(dir);
  return dir.length > 1 ? dir.replace(/[\\/]+$/, '') || '/' : dir;
};
const parentOf = (dir) => {
  const d = trim(dir);
  if (d === '/' || isDriveRoot(d)) return d;
  const cut = Math.max(d.lastIndexOf('/'), d.lastIndexOf('\\'));
  if (cut < 0) return d;
  const up = d.slice(0, cut);
  return /^[A-Za-z]:$/.test(up) ? up + sepOf(d) : up || '/';
};
export const joinPath = (dir, name) => {
  const sep = sepOf(dir);
  return (/[\\/]$/.test(dir) ? dir : dir + sep) + name;
};

// The folders from `start` up to `/` or the drive root (at most 64).
export function ancestorsOf(start) {
  const out = [];
  let dir = start;
  for (let i = 0; i < 64; i++) {
    out.push(dir);
    const up = parentOf(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

// Is the platform one whose volumes are case-insensitive? (the mod may have no `process`: then no)
export const caseBlind = (platform = typeof process !== 'undefined' ? process.platform : '') => platform === 'darwin' || platform === 'win32';

// Is a mode world-writable with the sticky bit? (a 0777 folder without it, such as an exFAT volume, is not shared in that sense)
export const isSticky = (mode) => typeof mode === 'number' && (mode & 0o1002) === 0o1002;

// Is `dir` the home folder, a folder above it, or `/`? home: a folder or null (unknown). ci: compare without regard to letter case or Unicode
// normalisation (NFC and NFD spellings name one folder on macOS).
export function neverRoot(dir, home, ci = caseBlind()) {
  const d = trim(dir);
  if (d === '/' || isDriveRoot(d)) return true;
  if (typeof home !== 'string' || !home || home === '/') return false;
  const f = (x) => (ci ? x.normalize('NFC').toLowerCase() : x).replace(/\\/g, '/').replace(/\/+$/, '');
  const h = f(home);
  const e = f(d);
  return e === h || h.startsWith(e + '/');
}

// A folder the walk does not even probe: never a root (the home folder and above), unless it is the current folder (i 0). Tested BEFORE any lstat.
export const skipDir = (dir, i, home, ci = caseBlind()) => i > 0 && neverRoot(dir, home, ci);

// THE step of the walk (every walk calls it). entry: { dir, git, jefe, sticky } (git, jefe: the entry is there; sticky: world-writable with the sticky
// bit); i: 0 for the current folder. -> the root, or null (keep walking)
export function stepRoot(entry, i, home, ci = caseBlind()) {
  if (i > 0 && (entry.sticky || neverRoot(entry.dir, home, ci))) return null;
  return entry.git || entry.jefe ? entry.dir : null;
}

// The note `start` prints when the walk passed over a real `.jefe` directory in an ordinary folder above the root's repository ("it is above this
// project's repository"). Not for the home folder, a folder above it or a shared folder: those are never projects from below, and the line would
// repeat in every project of a user who has a `~/.jefe`. Looks further up than the walk does, so only `start` calls it.
// probe(dir) -> { git, jefe, sticky } (a .git entry, a real .jefe directory, the sticky bit). -> { dir } | null. Never names the root's own `.jefe`.
export function ignoredAbove(root, home, probe, ci = caseBlind()) {
  const dirs = ancestorsOf(root);
  let repoBelow = Boolean(probe(root).git);
  for (let i = 1; i < dirs.length; i++) {
    const p = probe(dirs[i]);
    if (p.jefe && repoBelow && !p.sticky && !neverRoot(dirs[i], home, ci)) return { dir: dirs[i] };
    if (p.git) repoBelow = true;
  }
  return null;
}

export const ignoredNote = (ig) => (ig ? `note: ignored ${joinPath(ig.dir, '.jefe')} (it is above this project's repository; to use it, start Jefe in ${ig.dir})` : null);

// `start` prints this when the home folder is the project root (the session started in it).
export const HOME_NOTE = "note: the project is your home folder: the tests and the secrets scan cover everything in it, and Jefe approves no file writes here (Claude Code asks for each of yours; helpers' writes are refused): for a job that needs helpers to write files, start Jefe in a project folder";
export function homeNote(root, home, ci = caseBlind()) {
  if (typeof home !== 'string' || !home) return null;
  const f = (x) => (ci ? x.normalize('NFC').toLowerCase() : x).replace(/\\/g, '/').replace(/\/+$/, '');
  return f(root) === f(home) ? HOME_NOTE : null;
}
