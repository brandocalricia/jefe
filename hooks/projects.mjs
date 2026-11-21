// Shared by bin/jefe-project and bin/jefe-gate: which Jefe project the current folder is in.
// Uses Node built-ins, so the mod never imports it (mods cannot). No other dependency.
//
// Registry: ${JEFE_HOME:-~/.claude/jefe}/hosts/<host>.json maps project name -> path for one host.
// Host: JEFE_HOST when it is a valid host name (hostName below), else `hostname -s` cleaned.

import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, readdirSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { hasRunFiles, realOf, registryHome } from './approvals-state.mjs';
import { shq, wrapperOk } from './wrapper-text.mjs';
import { realDir, resolveRootSync, rootHome } from './root-node.mjs';
import { CONTROL_RE } from '../lib/providers/rules.mjs';
const CONTROL_ALL = new RegExp(CONTROL_RE.source, 'g');
// Escapes control characters and newlines so a value echoed into a line a model reads
// cannot start a new line or forge one such as "gate: PASS".
export function safe(value) {
  // the bidirectional controls (U+202A-U+202E, U+2066-U+2069) are shown as \u202e, like U+2028: they can make a printed path read as another folder
  return String(value).replace(CONTROL_ALL, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
}

// obj[key] only when key is an own property; registry and config objects are indexed by names a user
// or a repo supplies, and "constructor" or "toString" must not find the Object prototype.
export const own = (obj, key) => (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined);

export function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Creates a folder (and parents) readable by this user only; an existing one is tightened when we own it.
// A folder named .jefe also gets .jefe/.gitignore ("*") so it ignores itself and the user's .gitignore stays untouched.
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not ours: leave it
  }
  if (basename(dir) === '.jefe') {
    const ignore = join(dir, '.gitignore');
    try {
      if (!existsSync(ignore) && !isSymlink(ignore) && !isSymlink(dir)) writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 });
    } catch {
      // best effort: a failed ignore file never stops the caller
    }
  }
}

// Atomic write with mode 0600. Refuses (throws an error with code ESYMLINK) when the target, or with
// guardDir its folder, is a symlink, so a planted link cannot redirect the write. The parent folder is
// created 0700.
export function writePrivate(file, text, { guardDir = false } = {}) {
  const dir = dirname(file);
  for (const p of guardDir ? [dir, file] : [file]) {
    if (isSymlink(p)) {
      const e = new Error(`refusing to write: ${p} is a symlink`);
      e.code = 'ESYMLINK';
      throw e;
    }
  }
  ensurePrivateDir(dir);
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best effort
  }
  renameSync(tmp, file);
}

// A valid project name from free text: lowercase, every run of characters that are not letters or digits
// becomes one "-", trimmed of "-". "My Project" -> "my-project". Nothing usable gives "project".
export function slugify(text) {
  const t = String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
  return t || 'project';
}

const heldLocks = new Set();
let lockHook = false;

// Runs fn() holding an exclusive lock file (<file>.lock, created with O_EXCL) so that parallel read-modify-write
// cycles on the same files cannot lose each other's updates. Waits up to timeoutMs, takes over a lock older
// than staleMs (a crashed holder), always releases, also when the process exits inside fn.
// Throws an error with code ELOCK when the lock could not be taken.
export function withLock(file, fn, { timeoutMs = 20000, staleMs = 30000 } = {}) {
  const lock = `${file}.lock`;
  ensurePrivateDir(dirname(lock));
  const started = Date.now();
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // it vanished: try again at once
      }
      if (Date.now() - started > timeoutMs) {
        const e = new Error(`could not lock ${file}: another jefe command is still running (remove ${lock} if none is)`);
        e.code = 'ELOCK';
        throw e;
      }
      Atomics.wait(nap, 0, 0, 3 + Math.floor(Math.random() * 12));
    }
  }
  heldLocks.add(lock);
  if (!lockHook) {
    lockHook = true;
    process.on('exit', () => {
      for (const l of heldLocks) {
        try {
          unlinkSync(l);
        } catch {
          // already gone
        }
      }
    });
  }
  try {
    return fn();
  } finally {
    heldLocks.delete(lock);
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

// Reads at most max bytes of a regular file as text without following a symlink or blocking on a pipe; null otherwise.
export function readRegular(file, max = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(fd, 'utf8');
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

// The registry home for a lookup made on behalf of the project at `root` (THE rule, hooks/approvals-state.mjs registryInfo): a JEFE_HOME inside that
// project is not used, so a folder cannot vouch for itself with a registry it ships (foreignJefe). root null: no inside-the-project test.
export const jefeHome = (env = process.env, root = null) => registryHome(root, { env });

// A host name is a file name in <jefe home>/hosts: letters, digits, dot, dash and underscore only, no leading dot (so never `.` or `..`),
// at most 64 characters. JEFE_HOST that breaks the rule is ignored (it could otherwise point the host file anywhere, e.g. ../../proj/.claude/settings).
const HOST_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const validHost = (v) => typeof v === 'string' && HOST_RE.test(v) && !v.startsWith('.');
// The machine's own name, cleaned to the same rule: other characters dropped, leading dots dropped, cut to 64; empty -> 'host'.
export const cleanHost = (v) => String(v == null ? '' : v).replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 64) || 'host';

// THE host name (bin/jefe-project and the registry readers here all use it): a valid JEFE_HOST, else `hostname -s` cleaned.
export function hostName(env = process.env, machine = null) {
  if (validHost(env.JEFE_HOST)) return env.JEFE_HOST;
  if (machine !== null) return cleanHost(machine);
  try {
    return cleanHost(execFileSync('hostname', ['-s'], { encoding: 'utf8' }).trim());
  } catch {
    return cleanHost(hostname().split('.')[0]);
  }
}

export const hostFilePath = (env = process.env, root = null) => join(jefeHome(env, root), 'hosts', `${hostName(env)}.json`);

// The project root of cwd by the one root rule (hooks/root.mjs), whether or not it holds a .jefe/ (the folder itself when nothing is found).
export function rootOfCwd(cwd = process.cwd(), home = rootHome()) {
  let dir;
  try {
    dir = realpathSync(cwd);
  } catch {
    dir = cwd;
  }
  return resolveRootSync(dir, home);
}

// The project folder for cwd by the one root rule (hooks/root.mjs), when it holds a
// .jefe/, with the registered name when this host's map has one for that folder: { name|null, path }, or null outside any project.
export function cwdProject(map, cwd = process.cwd(), home = rootHome()) {
  const dir = rootOfCwd(cwd, home);
  if (!realDir(join(dir, '.jefe'))) return null; // the same test as the hooks: a real directory
  let name = null;
  for (const [n, p] of Object.entries(map)) {
    if (typeof p !== 'string') continue;
    let rp = p;
    try {
      rp = realpathSync(p);
    } catch {
      // keep as registered
    }
    if (rp === dir || p === dir) name = n;
  }
  return { name, path: dir };
}

// What `jefe-project here` prints. Never throws: a missing or unreadable registry just leaves name null.
// The registry read is the one for the project root of cwd (the same root rule cwdProject applies), so a JEFE_HOME inside it is not used.
export function hereInfo(env = process.env, cwd = process.cwd()) {
  let map = {};
  try {
    const m = JSON.parse(readFileSync(hostFilePath(env, rootOfCwd(cwd)), 'utf8'));
    if (m && typeof m === 'object' && !Array.isArray(m)) map = m;
  } catch {
    // no registry
  }
  const p = cwdProject(map, cwd);
  return { path: p ? p.path : null, name: p ? p.name : null, handoff: p ? join(p.path, '.jefe', 'handoff.md') : null };
}

// Is this folder in the registry of ANY host (a hosts/<host>.json that maps a name to this real path)? The registry is the one for this
// project (a JEFE_HOME inside it is not used: a tarball could ship .jh/hosts/<x>.json naming itself and set JEFE_HOME there).
export function registeredAnywhere(root) {
  const real = realOf(root);
  try {
    const dir = join(jefeHome(process.env, real), 'hosts');
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const t = readRegular(join(dir, f), 1024 * 1024);
      if (t === null) continue;
      let m;
      try {
        m = JSON.parse(t);
      } catch {
        continue;
      }
      if (m && typeof m === 'object' && !Array.isArray(m) && Object.values(m).some((p) => typeof p === 'string' && realOf(p) === real)) return true;
    }
  } catch {
    // no registry folder
  }
  return false;
}

// What the plugin itself writes into a fresh folder before any `go`: the prompt hook (task.md, the wrappers in bin/, .gitignore), the status band
// (state.json, phase.json) and the permit hook (logs/). A .jefe/ holding only these (the wrappers being only jefe-gate and jefe-project) is ours.
const OWN_FRESH = new Set(['task.md', '.gitignore', 'state.json', 'phase.json', 'logs', 'bin']);
const OWN_WRAPPERS = new Set(['jefe-gate', 'jefe-project']);

// A `.jefe/` this installation did not create (it came with a tarball or a clone): it holds anything but what the plugin writes into a
// fresh folder (OWN_FRESH), and the folder has no record at all: not registered on any host, no run file for its key. Its prefs, task and
// check script are then ignored until a job is started here (lib/gate/start.mjs prints the note).
export function foreignJefe(root) {
  let names;
  try {
    names = readdirSync(join(root, '.jefe'));
  } catch {
    return false;
  }
  if (names.every((n) => OWN_FRESH.has(n))) {
    let binOk = true;
    if (names.includes('bin')) {
      try {
        binOk = readdirSync(join(root, '.jefe', 'bin')).every((n) => OWN_WRAPPERS.has(n) && wrapperOk(root, n)); // the names AND the exact wrapper text this install writes
      } catch {
        binOk = false;
      }
    }
    if (binOk) return false;
  }
  return !registeredAnywhere(root) && !hasRunFiles(root);
}

// ---- loose matching ---------------------------------------------------------

export const FILLER = new Set(['the', 'my', 'project', 'game', 'app', 'repo', 'on', 'work', 'continue', 'resume', 'keep', 'going', 'with', 'back', 'up', 'lets', "let's", 'pick', 'open', 'thing']);

export const squash = (s) => String(s).toLowerCase().replace(/[\s\-_.]+/g, '');

export function queryTokens(text) {
  const all = String(text).toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  return all.filter((t) => !FILLER.has(t)).map((t) => t.replace(/'/g, '')).filter(Boolean);
}

export function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Score of one candidate (name or alias) against ONE window of query tokens. isAlias lowers ties a little.
// Partial matches (prefix, substring, fuzzy) need real overlap and a candidate of 5+ characters, so a
// project called "test" or "game" only matches as a whole token.
export function scoreCandidate(cand, tokens, isAlias) {
  const c = squash(cand);
  const q = tokens.join('');
  if (!c || !q) return null;
  const via = (v, score) => ({ via: isAlias && v === 'name' ? 'alias' : v, score: isAlias ? score - 0.05 : score });
  if (c === q) return via('name', 1);
  if (c.length < 5) return null;
  if (q.length >= 4 && c.startsWith(q)) return via('prefix', 0.8);
  if (q.length >= 5 && c.includes(q)) return via('substring', 0.65);
  if (tokens.length > 1 && tokens.every((t) => t.length >= 3 && c.includes(t))) return via('tokens', 0.6);
  if (q.length < 5 || q.length > 40) return null;
  const allowed = Math.floor(q.length / 5);
  if (!allowed || Math.abs(q.length - c.length) > allowed) return null;
  const d = editDistance(q, c);
  if (d <= allowed) return { via: 'fuzzy', score: Math.max(0.1, 0.5 - 0.1 * d) - (isAlias ? 0.05 : 0) };
  return null;
}

const MAX_WINDOW = 6;

// Best score over every contiguous window of the query (so extra words never lower it) and
// over whole tokens. Whole-token and window exact hits also look at filler words ("game" can be a name).
// An exact window hit also carries `span` ([from, to) in the raw query words), so findMatches can drop an exact hit that
// lies inside a longer exact hit ("s3" inside "s3-2").
export function bestScore(cand, rawTokens, tokens, isAlias) {
  let best = null;
  const take = (r) => {
    if (r && (!best || r.score > best.score)) best = r;
  };
  const c = squash(cand);
  if (!c) return null;
  for (let i = 0; i < rawTokens.length && !(best && best.score >= 1 - (isAlias ? 0.05 : 0)); i++) {
    let q = '';
    for (let j = i; j < Math.min(rawTokens.length, i + MAX_WINDOW); j++) {
      q += rawTokens[j];
      if (q.length > c.length) break;
      if (q === c) {
        take({ via: isAlias ? 'alias' : 'name', score: isAlias ? 0.95 : 1, span: [i, j + 1] });
        break;
      }
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j <= Math.min(tokens.length, i + MAX_WINDOW); j++) take(scoreCandidate(cand, tokens.slice(i, j), isAlias));
  }
  return best;
}

export function rawQueryTokens(text) {
  return String(text).toLowerCase().split(/[^a-z0-9']+/).filter(Boolean).map((t) => t.replace(/'/g, '')).filter(Boolean);
}

// Exact beats partial. When the whole query (all its words, or all but the filler words) reads as one project's name or alias
// (case, spaces, dots, dashes and underscores ignored) that project is the only result: via "name" (score 1) or "alias" (0.95).
// Otherwise every project with a hit is listed, best first (prefix 0.8, substring 0.65, tokens 0.6, fuzzy lower). An exact hit
// on a few words of a longer query is dropped when a longer exact hit covers it, so "continue s3-2 now" does not also offer "s3".
export function findMatches(text, projects, aliasesOf) {
  const tokens = queryTokens(text);
  const rawTokens = rawQueryTokens(text);
  const wholes = new Set([rawTokens.join(''), tokens.join('')].filter(Boolean));
  const out = [];
  const whole = [];
  for (const [name, path] of Object.entries(projects)) {
    const aliases = aliasesOf(name);
    const exists = existsSync(path);
    let best = bestScore(name, rawTokens, tokens, false);
    for (const al of aliases) {
      const r = bestScore(al, rawTokens, tokens, true);
      if (r && (!best || r.score > best.score)) best = r;
    }
    if (best) out.push({ match: { name, path, exists, via: best.via, score: Math.round(best.score * 100) / 100 }, span: best.span || null });
    const byName = wholes.has(squash(name));
    if (byName || aliases.some((a) => wholes.has(squash(a)))) whole.push({ name, path, exists, via: byName ? 'name' : 'alias', score: byName ? 1 : 0.95 });
  }
  const byOrder = (x, y) => y.score - x.score || x.name.localeCompare(y.name);
  if (whole.length) {
    const named = whole.filter((m) => m.via === 'name');
    return (named.length ? named : whole).sort(byOrder).slice(0, 5);
  }
  const inside = (a, b) => a[0] >= b[0] && a[1] <= b[1] && (a[0] !== b[0] || a[1] !== b[1]);
  const kept = out.filter((o) => !(o.span && out.some((p) => p !== o && p.span && inside(o.span, p.span)))).map((o) => o.match);
  return kept.sort(byOrder).slice(0, 5);
}

// The one clear winner of a findMatches list: the only match, or a top score at least twice the second. null otherwise.
export function clearWinner(matches) {
  if (!Array.isArray(matches) || !matches.length) return null;
  const [top, second] = matches;
  return second && !(top.score >= 2 * second.score) ? null : top;
}

// The line that continues a project in a fresh session: park and find print it, so the text has this one source.
// Path and name sit inside double quotes, so \ " $ and ` are escaped; control characters are escaped too (one line only).
const inQuotes = (t) => safe(shq(String(t)));
export const resumeLine = (root, name) => `resume: cd "${inQuotes(root)}" && claude "/jefe:jefe continue ${inQuotes(name)}"`;

// The ONE project a text names that lives in ANOTHER folder (for `start` in a folder with no project of its own, and for `find`): after an optional
// leading `continue` or `resume` the words are EXACTLY one project's name or alias, or they START with continue/resume and findMatches has exactly one
// clear winner. Any other text (a long task that merely mentions a name, a fuzzy hit) names nothing here. Never a project that IS this folder or
// contains it (real paths; hereDirs = this folder, or several spellings of it). aliasesOf(name) -> the aliases of a project.
// -> the match { name, path, ... } or null
export function elsewhereTarget(text, matches, aliasesOf, hereDirs) {
  if (!Array.isArray(matches) || !matches.length) return null;
  const t = String(text);
  const lead = /^\s*(continue|resume)\b/i.test(t);
  const rest = t.replace(/^\s*(continue|resume)\b/i, '').trim();
  let top = null;
  if (rest) {
    const want = squash(rest);
    const byName = matches.filter((m) => squash(m.name) === want);
    const hit = byName.length ? byName : matches.filter((m) => (aliasesOf(m.name) || []).some((a) => squash(a) === want));
    if (hit.length === 1) top = hit[0];
  }
  if (!top && lead) top = clearWinner(matches);
  if (!top || typeof top.path !== 'string') return null;
  const target = realOf(top.path);
  const inside = (d) => {
    const h = realOf(d);
    return h === target || h.startsWith(target.endsWith(sep) ? target : target + sep);
  };
  return (Array.isArray(hereDirs) ? hereDirs : [hereDirs]).filter((d) => typeof d === 'string' && d).some(inside) ? null : top;
}

// Is a project name taken? ONE rule for `register` and for the gate's project step (finish): the name must not equal (squashed) another project's name
// or one of its aliases anywhere in the shared names file, and must not be registered on this host to a different existing folder.
// map = this host's name -> path, projects = the shared names (name -> { aliases }), abs = the folder the name is for.
// -> null | { kind: 'alias' | 'name' | 'folder', other, path? }
export function nameConflict(name, abs, map, projects) {
  const key = squash(name);
  const reg = projects && typeof projects === 'object' && !Array.isArray(projects) ? projects : {};
  for (const n of Object.keys(reg)) {
    if (n === name) continue;
    const al = own(own(reg, n), 'aliases');
    if (Array.isArray(al) && al.some((a) => squash(a) === key)) return { kind: 'alias', other: n };
    if (squash(n) === key) return { kind: 'name', other: n };
  }
  const old = own(map, name);
  if (typeof old === 'string' && existsSync(old) && realOf(old) !== realOf(abs)) return { kind: 'folder', other: name, path: old };
  return null;
}

// What `find` and `start` print when the user names ONE project that lives in another folder: Jefe does not work on a project from a session
// opened elsewhere, so the whole answer is the command that continues it in its own folder. Exactly these three lines, from this one function.
export const elsewhereLines = (root, name) => [`root: ${safe(root)}`, resumeLine(root, name), 'next: tell the user to run the resume line; stop'];

// ---- the name a project is registered under: `go --name`, recorded by the gate outside the project (lib/gate/gatefile.mjs) ----

// A usable project name: letters, digits, dot, underscore, hyphen, starting with a letter or digit, no "..", at most 40 characters.
export const projectNameOk = (n) => typeof n === 'string' && n.length <= 40 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n) && !n.includes('..');

// ---- standing answers per project: <root>/.jefe/prefs.json (0600) --------------------------------------------

export const PREF_KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const PREF_MAX_VALUE = 200;
const PREF_MAX_KEYS = 50;

// The saved prefs as a plain object of string values. Missing, unreadable or malformed -> {}.
export function readPrefs(root) {
  const text = readRegular(join(root, '.jefe', 'prefs.json'), 64 * 1024);
  const out = {};
  if (text === null) return out;
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return out;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return out;
  for (const k of Object.keys(j)) {
    if (PREF_KEY_RE.test(k) && typeof j[k] === 'string' && j[k].length <= PREF_MAX_VALUE) Object.defineProperty(out, k, { value: j[k], enumerable: true, writable: true, configurable: true });
  }
  return out;
}

// Saves one pref. -> { ok: true, prefs } | { ok: false, error }.
export function setPref(root, key, value) {
  if (typeof key !== 'string' || !PREF_KEY_RE.test(key)) return { ok: false, error: 'key must be 1-40 letters, digits, dash or underscore' };
  if (typeof value !== 'string' || value.length > PREF_MAX_VALUE) return { ok: false, error: `value must be at most ${PREF_MAX_VALUE} characters` };
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return { ok: false, error: 'value must be one line of plain text' };
  const prefs = readPrefs(root);
  if (!Object.hasOwn(prefs, key) && Object.keys(prefs).length >= PREF_MAX_KEYS) return { ok: false, error: `at most ${PREF_MAX_KEYS} prefs` };
  Object.defineProperty(prefs, key, { value, enumerable: true, writable: true, configurable: true });
  const dir = join(root, '.jefe');
  try {
    if (isSymlink(dir)) return { ok: false, error: `refusing to write: ${dir} is a symlink` };
    ensurePrivateDir(dir);
    const ignore = join(dir, '.gitignore');
    if (!existsSync(ignore) && !isSymlink(ignore)) writePrivate(ignore, '*\n');
    writePrivate(join(dir, 'prefs.json'), JSON.stringify(prefs, null, 2) + '\n', { guardDir: true });
  } catch (err) {
    return { ok: false, error: err && err.code === 'ESYMLINK' ? err.message : `cannot write prefs: ${(err && (err.code || err.message)) || err}` };
  }
  return { ok: true, prefs };
}
