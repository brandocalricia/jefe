// THE rule for which Jefe home (registry folder) a project uses. Pure (no imports), so the status-line mod (hooks/jefe.jsx: mods cannot import
// Node built-ins) and the Node side (hooks/approvals-state.mjs registryInfo) decide with the same function; each resolves the paths its own way
// and hands the results in.
//
//   JEFE_HOME counts only when it is an absolute path without a `..` segment that resolves and is not inside the project folder (real paths: a symlink into it is inside
//   it; where volumes are case-insensitive, names are compared the way such a volume folds them, segment by segment with foldName: letter case, Unicode
//   normalisation (on macOS the NFC and NFD spellings of `café` name one folder), sharp s (`straße` is `strasse`), ligatures (`ﬃ` is `ffi`)).
//   Otherwise the fallback <account home>/.claude/jefe applies whenever it resolves.
//   A repository's own settings can set environment variables, so a JEFE_HOME inside the project must never be written to.
//
// given: the JEFE_HOME value (string or undefined); absolute: is it an absolute path; real: its real path (nearest existing ancestor resolved), or
// null when it cannot be resolved; rootReal: the project's real path, or null for no inside-the-project test; fallback: <account home>/.claude/jefe
// or null; fallbackReal: its real path or null; ci: compare folded names (foldName: case, Unicode normalisation, sharp s, ligatures; darwin, win32).
// -> { home, problem }: home is null only when nothing usable resolves (fail closed); problem says why JEFE_HOME was not used.
// sep: the path separator ('/' by default; path.sep on the Node side).
// sameFolder: the caller found that JEFE_HOME or a folder above it IS the project folder (the gate compares device and inode); counts as inside.
// fallbackMustBeOutside: the fallback too must not be inside the project, else no home at all (home null). The mod sets it: its fallback comes from
// the HOME variable, which a repository's settings can set. The gate's fallback comes from the account database and is never refused (default false).
// A JEFE_HOME with a `..` segment is refused on both sides, before anything is resolved: after a symbolic link `..` leads somewhere else on disk
// than in the text (the gate's path.resolve normalises it as text; the mod's walk cannot), so a path that reads as outside the project can land
// inside it. A `..` inside a longer name (`b..c`), a `.` segment and doubled slashes are harmless.
// macOS reaches one folder by more than one path, and realpath keeps those spellings: /System/Volumes/Data<path> is <path> (the data volume's
// firmlink), /.nofollow<path> and /.resolve/<n><path> are <path> read with lookup flags, /.vol/<dev>/<ino> is a folder by its numbers. With the
// POSIX separator the text rules see through them: a leading /System/Volumes/Data, /.nofollow or /.resolve/<n> is dropped from both sides before
// the inside test (so /System/Volumes/Data/<elsewhere> is still an honest outside path), and a JEFE_HOME that starts with /.vol, /.nofollow or
// /.resolve is refused outright (ALIAS_PROBLEM). The gate also compares the folders themselves (registryInfo: device and inode of every existing
// folder on the way up from JEFE_HOME against the project's), handed in as sameFolder; the status line has no device numbers and uses the text rules.
// The FOLDED form of one name: what a case-insensitive file system may treat as the same name. NFKC (long s, Kelvin sign, fullwidth letters,
// ligatures), then upper then lower case (sharp s), then the decomposed form with combining marks removed, then characters a volume ignores
// (soft hyphen, zero-width and bidi marks, BOM). The permit hook applies it on every platform (hooks/permit-core.mjs re-exports it), pickJefeHome
// where volumes are case-insensitive: over-blocking a look-alike is harmless. Linear in the length.
const IGNORED = /[­͏؜᠋-᠏​-‏‪-‮⁠-⁯︀-️﻿]/g;
const MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;
export function foldName(seg) {
  let t = String(seg).normalize('NFKC').toUpperCase().toLowerCase();
  t = t.normalize('NFD').replace(MARKS, '').replace(IGNORED, '');
  return t.normalize('NFKC').toUpperCase().toLowerCase();
}
export const DOTDOT_PROBLEM = 'JEFE_HOME has a ".." segment (write the path without it)';
export const ALIAS_PROBLEM = 'JEFE_HOME uses a macOS alias path (/.vol, /.nofollow, /.resolve); write the plain path';
const ALIAS_FIRST = new Set(['.vol', '.nofollow', '.resolve']);
const hasDotDot = (p, sep) => String(p).split(sep === '/' ? '/' : /[\\/]/).includes('..');
export function pickJefeHome({ given, absolute, real, rootReal = null, fallback, fallbackReal, ci = false, sep = '/', fallbackMustBeOutside = false, sameFolder = false }) {
  // ci: every segment folded (foldName) the way a case-insensitive volume may fold it; may refuse two different folders whose names fold alike (fails safe)
  const posix = sep === '/';
  const fold = (s) => (ci ? foldName(s) : s);
  const norm = (p) => (ci ? String(p).split(posix ? '/' : /[\\/]/).map(foldName).join(sep) : String(p));
  // POSIX only: the path's segments without empty and `.` ones, then without the macOS prefixes that name the same folder (see the top)
  const segsOf = (p) => String(p).split('/').filter((s) => s !== '' && s !== '.');
  const plain = (p) => {
    if (!posix) return String(p);
    let s = segsOf(p);
    for (let k = 0; k < 8; k++) {
      if (s.length >= 3 && fold(s[0]) === fold('System') && fold(s[1]) === fold('Volumes') && fold(s[2]) === fold('Data')) s = s.slice(3);
      else if (s.length >= 1 && fold(s[0]) === fold('.nofollow')) s = s.slice(1);
      else if (s.length >= 2 && fold(s[0]) === fold('.resolve') && /^\d+$/.test(s[1])) s = s.slice(2);
      else break;
    }
    return '/' + s.join('/');
  };
  const isAlias = (p) => posix && typeof p === 'string' && ALIAS_FIRST.has(fold(segsOf(p)[0] || ''));
  const inside = (p) => {
    if (rootReal === null || rootReal === undefined) return false;
    const dir = norm(plain(rootReal));
    const q = norm(plain(p));
    return q === dir || q.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  };
  let problem = null;
  if (given) {
    if (!absolute) problem = 'JEFE_HOME is not an absolute path';
    else if (hasDotDot(given, sep)) problem = DOTDOT_PROBLEM;
    else if (isAlias(given) || isAlias(real)) problem = ALIAS_PROBLEM; // before "cannot be resolved": realpath fails on some of them, on one side only
    else if (real === null || real === undefined) problem = 'JEFE_HOME cannot be resolved';
    else if (sameFolder || inside(real) || (posix && inside(given))) problem = 'JEFE_HOME is inside the project folder';
    else return { home: given, problem: null };
  }
  if (fallback === null || fallback === undefined || fallbackReal === null || fallbackReal === undefined) return { home: null, problem: problem || 'the default registry location cannot be resolved' };
  if (fallbackMustBeOutside && inside(fallbackReal)) return { home: null, problem: (problem ? problem + '; ' : '') + 'the default registry location is inside the project folder' };
  return { home: fallback, problem };
}

// The real path of p, where p may not exist yet: the nearest existing ancestor is resolved, the rest is appended (POSIX paths, as the mod sees them).
// io: { realpath(p) -> string (throws when p does not exist), isLink?(p) -> bool (p itself is a symbolic link), exists?(p) -> bool (p exists,
// links followed) }, each sync or async. A path that exists but does not resolve gives null, as on the Node side (realish): walking up from it
// would hand back an ancestor (`/.vol` for /.vol/<dev>/<ino>) and the inside test would compare the wrong folder.
// null for a dangling symlink (writing through it would create its target), a relative path, or a path with a `..` segment (after a missing folder
// a realpath that does not normalise would keep it, and `<x>/missing/../proj/.jh` would pass as outside the project). `.` segments and doubled
// slashes are dropped before the walk.
export async function realishWith(p, io) {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.includes('..')) return null;
  let cur = '/' + segs.join('/');
  const rest = [];
  for (let k = 0; k < 64; k++) {
    try {
      const r = await io.realpath(cur);
      if (typeof r === 'string' && r) return rest.length ? (r.replace(/\/+$/, '') + '/' + rest.reverse().join('/')).replace(/^\/\//, '/') : r;
    } catch {
      // not there (or not readable): see below
    }
    try {
      if (io.exists && (await io.exists(cur))) return null; // there, but it does not resolve
    } catch {
      // cannot tell: the checks below decide
    }
    try {
      if (io.isLink && (await io.isLink(cur))) return null; // there, but a link that does not resolve
    } catch {
      // nothing there
    }
    if (cur === '/') return null;
    const i = cur.lastIndexOf('/');
    rest.push(cur.slice(i + 1));
    cur = i === 0 ? '/' : cur.slice(0, i);
  }
  return null;
}
