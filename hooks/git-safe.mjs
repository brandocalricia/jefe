// The ONE way to build a safe git command line: shared by the gate (lib/gate/git.mjs) and the status stamp (hooks/stamp.mjs). Node built-ins only.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// A repository's own .git/config (it can ship in a tarball) names programs git runs by itself: the file-system monitor, hooks, clean/smudge filters,
// an external diff, a signing program, a pager, an ssh command, a credential helper. The gate runs none of them: every git call it makes carries
// these switches (tests/gate-tests-kind-and-commit.test.mjs), which also means the project's own commit hooks do not run for the gate's commit.
// Settings whose NAME comes from the repository (a filter driver, a credential URL, a pager command, a submodule) are switched off through the
// ENVIRONMENT instead (gitEnv(dir): GIT_CONFIG_COUNT / _KEY_n / _VALUE_n): `-c name=value` splits at the first `=`, so a driver named `a=b` would stay active.
// Diff drivers (textconv, external diff) are switched off by `--no-ext-diff --no-textconv` on every call that can make a patch (lib/gate/git.mjs patchSafe);
// the gate never merges, so a merge driver never runs.
export const GIT_OFF = [
  'core.fsmonitor=false', 'core.hooksPath=/dev/null', 'commit.gpgsign=false', 'tag.gpgsign=false', 'diff.external=', 'core.sshCommand=false', 'core.pager=cat', 'credential.helper=',
  'core.alternateRefsCommand=', 'core.gitProxy=',
  // never look inside a nested repository (its own .git/config is not ours to run); every status and diff the gate makes also carries --ignore-submodules=all
  'diff.ignoreSubmodules=all', 'submodule.recurse=false', 'status.submoduleSummary=false',
];
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
// What the gate passes to git: no variable that points git at other configuration, another program folder or another repository (the session's environment
// is not the user's own git setup). Kept: GIT_SSH_COMMAND, GIT_ASKPASS and SSH_AUTH_SOCK (how the user authenticates) and the user's global config file in its usual place.
for (const k of Object.keys(GIT_ENV)) {
  if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k) || ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_EXEC_PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'].includes(k)) delete GIT_ENV[k];
}

// The time the caller has left (ms): every read of the configuration uses it as its timeout, so a hook with a small budget never waits longer than it has.
let budget = () => Infinity;
export const setGitBudget = (fn) => {
  budget = typeof fn === 'function' ? fn : () => Infinity;
};
const CONFIG_MAX = 5000;
const BUFFER = 256 * 1024 * 1024;

// ---- the configuration git would read for this folder, read by git itself (reading runs nothing) ----
// ONE reader (the gate's push check uses it too). `git config --list -z --show-scope --includes`: records `scope NUL key NEWLINE value NUL`. The key ends at the first
// newline (git refuses a newline inside a key), never at an `=`. Any failure (a timeout, a buffer overflow, an old git without --show-scope, no time left) is a
// FAILURE, never an empty configuration: the callers turn their git calls off for the folder.
function run(dir, extra, { allowExit = false } = {}) {
  const b = budget();
  const left = Number.isNaN(b) ? CONFIG_MAX : Math.min(CONFIG_MAX, b); // no deadline set: the usual limit
  if (!(left > 0)) return { ok: false, reason: 'out of time' };
  // the fixed switches too: reading the index (`--blob :.gitmodules`) would run the file-system monitor otherwise
  const r = spawnSync('git', [...GIT_OFF.flatMap((x) => ['-c', x]), '-C', dir, ...extra], { encoding: 'utf8', timeout: left, maxBuffer: BUFFER, stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV });
  if (r.error) return { ok: false, reason: r.error.code === 'ETIMEDOUT' ? 'git timed out' : r.error.code === 'ENOBUFS' ? 'the configuration is too large' : String(r.error.code || r.error.message).slice(0, 60) };
  if (r.status !== 0) return allowExit ? { ok: true, out: '', status: r.status, err: String(r.stderr) } : { ok: false, reason: `git exited ${r.status}`, err: String(r.stderr) };
  return { ok: true, out: r.stdout, status: 0 };
}
const splitRec = (rec) => {
  const nl = rec.indexOf('\n');
  return { key: nl === -1 ? rec : rec.slice(0, nl), value: nl === -1 ? '' : rec.slice(nl + 1) };
};

const topCache = new Map(); // folder string -> resolved repository top (or the folder itself when it has none)
const cfgCache = new Map(); // resolved top -> result
function topOf(dir) {
  if (topCache.has(dir)) return { ok: true, top: topCache.get(dir) };
  const r = run(dir, ['rev-parse', '--show-toplevel'], { allowExit: true });
  if (!r.ok) return r;
  const top = r.status === 0 ? r.out.trim() : '';
  topCache.set(dir, top || dir); // not a work tree (a bare repository, no repository): the folder is the key
  return { ok: true, top: top || dir };
}

// -> { ok: true, entries: [{ scope, key, value }] (every scope git reads, includes resolved), modules: [submodule names] } | { ok: false, reason }. Cached per repository top.
export function readConfig(dir) {
  const t = topOf(dir);
  if (!t.ok) return t;
  if (cfgCache.has(t.top)) return cfgCache.get(t.top);
  const res = readUncached(dir, t.top);
  cfgCache.set(t.top, res);
  return res;
}
function readUncached(dir, top) {
  const r = run(dir, ['config', '--list', '-z', '--show-scope', '--includes']);
  if (!r.ok) return r;
  const parts = r.out.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) entries.push({ scope: parts[i], ...splitRec(parts[i + 1]) });
  // .gitmodules can set `submodule.<name>.ignore`, which beats the diff.ignoreSubmodules default: those names are switched too. Git reads the working tree file;
  // when it is absent, the index copy and then HEAD's.
  const mods = new Set();
  const addMods = (list) => {
    for (const { key } of list) {
      const m = /^submodule\.(.+)\.[^.]+$/i.exec(key);
      if (m) mods.add(m[1]);
    }
  };
  addMods(entries);
  const list = (extra) => {
    const x = run(dir, ['config', ...extra, '--list', '-z'], { allowExit: true }); // exit 128: no such file or blob (normal)
    return x.ok ? x.out.split('\0').filter(Boolean).map(splitRec) : null;
  };
  const file = join(top, '.gitmodules');
  const sources = existsSync(file) ? [['--file', file]] : [['--blob', ':.gitmodules'], ['--blob', 'HEAD:.gitmodules']];
  for (const s of sources) {
    const got = list(s);
    if (got === null) return { ok: false, reason: 'could not read .gitmodules' };
    addMods(got);
  }
  return { ok: true, entries, modules: [...mods] };
}

// Trust follows the scope: only what the REPOSITORY can set (scopes local and worktree, and the files those include) is switched off. Your own global and system
// configuration is as trusted as your git itself and stays active (a global git-lfs filter keeps working). A repository key of the same name as one of yours is the repository's.
export const repoScope = (e) => e.scope === 'local' || e.scope === 'worktree';

// The name of a `<section>.<name>.<variable>` key: what lies between the section and the LAST dot (a variable name never holds a dot, a name may hold anything else).
const nameIn = (key, section) => {
  const m = new RegExp(`^${section}\\.(.+)\\.[^.]+$`, 'i').exec(key);
  return m ? m[1] : null;
};

// The filter drivers the repository's own configuration names: ANY `filter.<name>.*` key in its scopes (a clean, smudge or process program, or only `required`).
// The same set is switched off (nameOverrides) and drives the commit refusal, so a repository that sets only `filter.lfs.required` cannot switch off your global
// lfs filter without the commit noticing. null when unreadable.
const filterNamesOf = (c) => [...new Set(c.entries.filter(repoScope).map((e) => nameIn(e.key, 'filter')).filter((n) => n !== null))];
export function repoFilterNames(dir) {
  const c = readConfig(dir);
  return c.ok ? filterNamesOf(c) : null;
}

// The name-keyed overrides: [[key, value]], for every name the repository's own configuration holds: filter clean/smudge/process (empty) and required (false), a
// credential helper per URL, a pager per command, `enabled=false` for every config-based hook (git 2.54+: `hook.<name>.command` / `.event`, which
// core.hooksPath does not stop), and `ignore` for every submodule. (No empty value for a diff or merge driver: git dies on `diff.<n>.command=`.)
// null when the configuration could not be read.
export function nameOverrides(dir) {
  const c = readConfig(dir);
  if (!c.ok) return null;
  const out = new Map();
  for (const n of filterNamesOf(c)) {
    for (const v of ['clean', 'smudge', 'process']) out.set(`filter.${n}.${v}`, '');
    out.set(`filter.${n}.required`, 'false');
  }
  for (const { key } of c.entries.filter(repoScope)) {
    const h = nameIn(key, 'hook');
    if (h !== null) out.set(`hook.${h}.enabled`, 'false');
    let n = /^credential\.(.+)\.helper$/i.exec(key);
    if (n) out.set(`credential.${n[1]}.helper`, '');
    n = /^pager\.(.+)$/i.exec(key);
    if (n) out.set(`pager.${n[1]}`, 'false');
  }
  for (const m of c.modules) out.set(`submodule.${m}.ignore`, 'all');
  return [...out];
}

// Why the configuration of this folder cannot be read (null when it can): `start` says so, and every gate git call for the folder is off.
export const configProblem = (dir) => {
  const c = readConfig(dir);
  return c.ok ? null : c.reason;
};

// The environment the gate passes to git for a call in `dir`: the base environment plus the name-keyed overrides (a key may hold `=` here). Without a folder: the base.
// THROWS when the configuration of the folder cannot be read: no gate git call runs there (the caller sees git failing, as where git is unavailable).
const envCache = new Map();
export function gitEnv(dir) {
  if (typeof dir !== 'string') return GIT_ENV;
  const t = topOf(dir);
  if (t.ok && envCache.has(t.top)) return envCache.get(t.top);
  const ov = t.ok ? nameOverrides(dir) : null;
  if (ov === null) throw Object.assign(new Error(`the git configuration could not be read (${t.ok ? configProblem(dir) : t.reason})`), { code: 'JEFE_CONFIG_UNREADABLE' });
  const env = { ...GIT_ENV, GIT_CONFIG_COUNT: String(ov.length) };
  ov.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  envCache.set(t.top, env);
  return env;
}

// Forget every cached top, configuration and environment, so the next call reads the configuration fresh (a step that runs after the user's own
// commands, which could have changed it: finish's commit, push).
export function clearGitCaches() {
  topCache.clear();
  cfgCache.clear();
  envCache.clear();
}

// The full argument list: the fixed switches, then -C <dir> and the call's own arguments. Always pair it with env: gitEnv(dir).
export function gitArgs(dir, args) {
  return [...GIT_OFF.flatMap((x) => ['-c', x]), '-C', dir, ...args];
}

// The keys of the repository's OWN configuration (local and worktree scope) that name a program git could run: names only, for the note `start` prints.
const PROGRAM_KEY = /^(filter\..+\.(clean|smudge|process)|diff\..+\.(textconv|command)|diff\.external|merge\..+\.driver|core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)|credential\.(.+\.)?helper|pager\..+|gpg\.(.+\.)?program|uploadpack\.packobjectshook|remote\..+\.(uploadpack|receivepack|vcs|proxy)|sequence\.editor|hook\..+\.(command|event))$/i;
export function programKeys(dir) {
  const c = readConfig(dir);
  if (!c.ok) return [];
  const seen = new Set();
  for (const { scope, key, value } of c.entries) {
    if (scope !== 'local' && scope !== 'worktree') continue;
    if (/^core\.fsmonitor$/i.test(key) && /^(false|0|no|off|)$/i.test(value)) continue;
    if (/^submodule\..+\.update$/i.test(key) ? /^\s*!/.test(value) : PROGRAM_KEY.test(key)) seen.add(key);
  }
  return [...seen];
}
