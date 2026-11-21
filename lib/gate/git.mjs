// git helpers: ONE way to run git (every spawn of git in lib/gate and bin goes through it), the repo top, bounded file reads.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { clearGitCaches, configProblem, gitArgs, gitEnv, readConfig, repoFilterNames, repoScope, setGitBudget } from '../../hooks/git-safe.mjs';
import { remainingMs } from './env.mjs';

export { clearGitCaches, gitArgs, gitEnv };
setGitBudget(remainingMs); // every read of a repository's configuration takes the gate's remaining time as its timeout
const GIT_ENV = gitEnv();

// ---------- git ----------

// The files git tracks under <dir>/.jefe (a repository that ships its own .jefe), at most 20 names; [] when none.
// Fails CLOSED: when the repository's configuration cannot be read, the gate cannot ask git, so -> { unreadable: reason } and `start` and `go` refuse.
export function trackedJefe(dir) {
  let env;
  try {
    env = gitEnv(dir);
  } catch (e) {
    const why = e && e.code === 'JEFE_CONFIG_UNREADABLE' ? configProblem(dir) || 'unknown' : null;
    // no git at all: nothing can be tracked, and no gate git call can run either (start says there is no repository)
    return why === null || why === 'ENOENT' ? [] : { unreadable: why };
  }
  try {
    const r = spawnSync('git', gitArgs(dir, ['ls-files', '--', '.jefe']), { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], env });
    if (r.error && r.error.code === 'ENOENT') return []; // no git at all
    if (r.status === 0 && !r.error) return r.stdout.split('\n').filter(Boolean).slice(0, 20);
    if (r.status === 128 && /not a git repository/i.test(String(r.stderr))) return []; // no repository: nothing can be tracked
    // any other failure (a damaged index, a timeout) cannot tell whether .jefe is tracked: closed
    return { unreadable: r.error ? (r.error.code === 'ETIMEDOUT' ? 'git timed out' : String(r.error.code || r.error.message).slice(0, 60)) : `git ls-files exited ${r.status}`, what: 'index' };
  } catch (e) {
    return { unreadable: String((e && (e.code || e.message)) || 'git failed').slice(0, 60), what: 'index' };
  }
}
// The lines `start` and `go` print when the configuration cannot be read: the same note `start` prints otherwise, then why it stops.
export const unreadableConfigLines = (reason, safe, what = 'config') => [what === 'index' ? `note: git could not list this repository's tracked files (${safe(reason)})` : `note: this repository's git configuration could not be read (${safe(reason)}): Jefe's own git calls are off here`, 'jefe: so it cannot tell whether the repository ships a .jefe folder; fix the repository (git status and git config --list --show-scope show what is wrong), then run /jefe again.'];
// The two lines `start` and `go` print when a repository ships a .jefe folder. `safe` is the caller's line sanitizer.
export const trackedJefeLines = (tracked, safe) => [`jefe: this repository ships a .jefe folder; it is not trusted. Tracked files: ${tracked.map((f) => safe(f)).join(', ')}`, 'jefe: remove it from the repository with `git rm -r --cached .jefe` (and commit that), then run /jefe again.'];

// Every call that can make a patch goes through here and gets `--no-ext-diff --no-textconv` right after the subcommand: a repository-defined external diff or textconv
// program never runs (and no empty `diff.<name>.command=` override is needed, which git cannot run). The gate never merges, so a merge driver never runs either.
const PATCH_COMMANDS = new Set(['diff', 'show', 'log', 'diff-index', 'diff-files', 'diff-tree', 'format-patch']);
export const patchSafe = (args) => (PATCH_COMMANDS.has(args[0]) ? [args[0], '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args);

// The ONE way the gate runs git. Throws like git when it fails, and when the repository's configuration cannot be read (hooks/git-safe.mjs gitEnv): then no git call runs there.
export function git(dir, args, opts = {}) {
  return execFileSync('git', gitArgs(dir, patchSafe(args)), {
    env: gitEnv(dir),
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: Math.max(1000, Math.min(60000, remainingMs())),
    killSignal: 'SIGKILL',
    ...opts,
  });
}

// Is dir a bare repository, or inside a repository's git folder? (false when git cannot say). `start` and `go` refuse such a folder with
// BARE_REPO_LINE before anything is written.
export function gitDirOnly(dir) {
  try {
    return git(dir, ['rev-parse', '--is-bare-repository', '--is-inside-git-dir']).toString('utf8').split('\n').some((l) => l.trim() === 'true');
  } catch {
    return false;
  }
}
export const BARE_REPO_LINE = 'jefe: this folder is a bare git repository (or inside a git folder) with no work tree; Jefe does not start here: run /jefe in a checkout of the repository';

// The branch HEAD is on: its name without `refs/heads/`. The full ref is read (`symbolic-ref` without --short), because --short prints
// `heads/<name>` when a tag has the same name as the branch. Throws like git on a detached HEAD (exit 1); '' when HEAD is not a local branch.
export function currentBranchName(dir) {
  const ref = git(dir, ['symbolic-ref', '-q', 'HEAD']).toString('utf8').trim();
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '';
}

export function repoTop(dir) {
  try {
    const top = git(dir, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    return top || null;
  } catch {
    return null;
  }
}

// Is dir inside a git work tree? -> { state: 'yes' } | { state: 'no' } (git says it is not a repository) | { state: 'unknown', reason } (git did not answer).
// Its own short timeout, never the caller's deadline, so a slow git is not mistaken for "no repository".
export function workTreeState(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV, killSignal: 'SIGKILL' });
  if (r.error) return { state: 'unknown', reason: r.error.code === 'ETIMEDOUT' ? 'git timed out' : String(r.error.code || r.error.message).slice(0, 80) };
  if (r.status === 0) return { state: r.stdout.trim() === 'true' ? 'yes' : 'no' };
  if (r.status === 128 && /not a git repository/i.test(r.stderr)) return { state: 'no' };
  return { state: 'unknown', reason: `git exited ${r.status}` };
}

// How many paths of the project folder differ from HEAD (tracked changes and untracked files; `.jefe/` and Claude's local settings are not counted), or null when git
// could not say. 0 means the working tree is what HEAD holds.
export function dirtyPaths(dir) {
  try {
    // nested repositories are not part of a job: a gitlink or an embedded repository never makes the tree dirty
    return splitZ(git(dir, ['status', '--porcelain', '-z', '--ignore-submodules=all', '--untracked-files=all', '--', '.', ':(exclude).jefe', ':(exclude).claude/settings.local.json', ...nestedExcludes(dir)])).length;
  } catch {
    return null;
  }
}

// The paths (relative to the repository top, as git prints them) that already differ from HEAD under dir, counted like dirtyPaths; null when git could not say.
// `go` records them when it approves git-commit, so `finish --commit` can say which of them its commit holds.
export function dirtyNames(dir) {
  try {
    const recs = splitZ(git(dir, ['status', '--porcelain', '-z', '--ignore-submodules=all', '--untracked-files=all', '--', '.', ':(exclude).jefe', ':(exclude).claude/settings.local.json', ...nestedExcludes(dir)]));
    const out = [];
    for (let i = 0; i < recs.length; i++) {
      out.push(recs[i].slice(3));
      if (/^[RC]/.test(recs[i])) i += 1; // the original path of a rename or copy
    }
    return out;
  } catch {
    return null;
  }
}
// One line naming at most five paths, then "+N more".
const cap80 = (n) => (n.length > 80 ? `${n.slice(0, 79)}…` : n);
export const someNames = (names, safe) => `${names.slice(0, 5).map((n) => safe(cap80(n))).join(', ')}${names.length > 5 ? ` +${names.length - 5} more` : ''}`;

// The nested repositories under dir (relative paths): every gitlink in the index and every untracked folder that is a repository of its own. The gate's own
// git calls never look inside one: `git add -A` has no --ignore-submodules switch and checks a gitlink by running status in it, which would run ITS clean filter,
// so the staging step leaves these paths out with `:(exclude,literal)` pathspecs. Throws like git when it cannot list them.
export const nestedExcludes = (dir) => nestedPaths(dir).map((p) => `:(exclude,literal)${p}`);
export function nestedPaths(dir) {
  const out = new Set();
  for (const rec of git(dir, ['ls-files', '-s', '-z']).toString('utf8').split('\0')) {
    const m = /^160000 [0-9a-f]+ \d\t([\s\S]+)$/.exec(rec);
    if (m) out.add(m[1]);
  }
  for (const f of splitZ(git(dir, ['ls-files', '-z', '-o', '--exclude-standard']))) if (f.endsWith('/')) out.add(f.slice(0, -1));
  return [...out];
}

// The paths `finish --commit` would stage (modified, untracked, already staged, under dir; a deletion stages nothing through a filter, so it is left out) whose `filter`
// attribute names a driver the repository's own configuration defines. The gate switches such a driver off, and staging through it would store the raw content where
// the driver (git-lfs: a pointer) belongs, so the commit is refused instead. A path that is ALREADY staged and still differs counts too: with the driver switched off,
// `git add -A` would put its raw content in again. `check-attr` prints `unspecified`, `set` and `unset` for "no driver", so a driver the repository names like that
// cannot be told apart: -> { hits: [{ file, filter }], ambiguous: [names] }. Throws like git when it cannot tell.
export function neutralisedFilterHits(dir) {
  const names = repoFilterNames(dir);
  if (names === null) throw new Error('the git configuration could not be read');
  if (!names.length) return { hits: [], ambiguous: [] };
  const ambiguous = names.filter((n) => ['unspecified', 'set', 'unset'].includes(n));
  const real = new Set(names.filter((n) => !ambiguous.includes(n)));
  const here = [...splitZ(git(dir, ['ls-files', '-z', '-m', '-o', '--exclude-standard', '--', '.'])), ...splitZ(git(dir, ['diff', '--cached', '--relative', '--name-only', '-z', '--ignore-submodules=all', '--', '.']))];
  // a nested repository is not part of the job (left out of the commit), so it is not a candidate either
  const nested = nestedPaths(dir);
  const inNested = (f) => nested.some((p) => f === p || f === `${p}/` || f.startsWith(`${p}/`));
  const files = new Set(here.filter((f) => existsSync(join(dir, f)) && !inNested(f)));
  if (!files.size) return { hits: [], ambiguous };
  const out = git(dir, ['check-attr', '-z', '--stdin', 'filter'], { input: `${[...files].join('\0')}\0`, stdio: ['pipe', 'pipe', 'ignore'] }).toString('utf8').split('\0');
  const hits = [];
  for (let i = 0; i + 2 < out.length; i += 3) if (real.has(out[i + 2])) hits.push({ file: out[i], filter: out[i + 2] });
  return { hits, ambiguous };
}

export const splitZ = (buf) => buf.toString('utf8').split('\0').filter(Boolean);

// ---------- the gate's push ----------

// The repository's own configuration (the scopes `local` and `worktree`, includes resolved), read by git itself through the ONE reader in hooks/git-safe.mjs (it runs
// nothing and works in a linked worktree whether or not the worktree-config extension is on): [{ key, value }] with the key as git prints it (section and variable
// lower-case, the subsection, such as a remote's name, in its real case). null when git could not read it.
export function localConfig(dir) {
  const c = readConfig(dir);
  return c.ok ? c.entries.filter(repoScope).map(({ key, value }) => ({ key, value })) : null;
}

// The URL git would push remote to (url.*.insteadOf and pushInsteadOf of the user's own configuration applied), or null when the remote has none.
export function pushUrl(dir, remote) {
  const r = spawnSync('git', ['-C', dir, 'remote', 'get-url', '--push', '--all', remote], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: GIT_ENV });
  if (r.status !== 0 || r.error) return null;
  const urls = r.stdout.split('\n').filter(Boolean);
  return urls.length === 1 ? urls[0] : null;
}

// One push of <sha>:refs/heads/<branch> to <remote>, no force (no `+`, no --force), the repository's and the user's hooks off (core.hooksPath=/dev/null and
// --no-verify), the file-system monitor off. The user's own global configuration stays in force: a credential helper, ssh settings. A local path and the
// file and ext transports are off unless allowLocal (a parameter the tests pass; nothing a repository or the environment sets turns it on). -> { status, stderr }
export function gitPush(dir, remote, sha, branch, { allowLocal = false } = {}) {
  const off = allowLocal ? [] : ['-c', 'protocol.file.allow=never'];
  const args = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', ...off, '-C', dir, 'push', '--no-verify', '--no-recurse-submodules', remote, `${sha}:refs/heads/${branch}`];
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'ignore', 'pipe'], env: GIT_ENV, killSignal: 'SIGKILL' });
  return { status: r.error ? null : r.status, stderr: String(r.stderr || '') };
}
