// push: the gate's own push of the job's branch. The permit hook approves no raw `git push`; this is the one way a job pushes (hooks/permit-core.mjs
// gateCallOk: main session only, the `git-push` kind, the call `push --review pass`). What it pushes is bound, by construction, to what was tested and shown:
//   - the commit and branch the passing ending finish recorded (the report run file), pushed as `<sha>:refs/heads/<branch>`;
//   - that branch must be the one fixed at Go (`go --branch`, else the branch current at Go), recorded with the destination (approvedBranchProblem);
//   - the destination `go --allow-kind git-push` resolved and printed (`push-to: <remote> <url>`, recorded in the approval state), https or ssh only;
//   - a repository whose LOCAL configuration holds any key a plain push does not need is refused (resolveDestination).
// It never forces and runs git with hooks and the file-system monitor off. The test parameter `allowLocal` (never an environment variable or a setting)
// lets a local bare repository be the remote.
import { deactivate } from '../../hooks/allow.mjs';
import { endFailedLine, notEndedLines } from './allow.mjs';
import { activeKinds, readState } from '../../hooks/permit-core.mjs';
import { firstUnfinished, readPlan } from '../../hooks/plan.mjs';
import { safe } from '../../hooks/projects.mjs';
import { SESSION, shared } from './env.mjs';
import { readReportFile } from './gatefile.mjs';
import { clearGitCaches, currentBranchName, dirtyPaths, git, gitPush, localConfig, pushUrl, repoTop } from './git.mjs';

const FRESH_MS = 6 * 3600 * 1000;

// core.* keys a plain push can live with (what `git init` and `git clone` write, plus a few that change nothing about where or how a push goes).
const CORE_OK = new Set(['repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'ignorecase', 'precomposeunicode', 'worktree', 'symlinks']);

// Is this key (as git prints it: section and variable lower-case, subsection as written) one a plain push needs? Everything else is refused, including every
// key that cannot be classified. `submodule.*` is fine unless it is an update command (`update = !cmd`).
function keyOk(key, value) {
  const parts = key.split('.');
  if (parts.length < 2) return false;
  const section = parts[0];
  const variable = parts[parts.length - 1];
  const sub = parts.length > 2 ? parts.slice(1, -1).join('.') : null;
  switch (section) {
    case 'core':
      return sub === null && CORE_OK.has(variable);
    case 'user':
    case 'init':
    case 'extensions':
      return true;
    case 'branch':
      return sub !== null;
    case 'remote':
      return sub !== null && (variable === 'url' || variable === 'fetch');
    case 'push':
      return sub === null && variable === 'default';
    case 'submodule':
      return !(variable === 'update' && /^\s*!/.test(value));
    default:
      return false;
  }
}

// The keys of the repository's local configuration outside what a plain push needs (unique, real case).
export const unwantedKeys = (conf) => [...new Set(conf.filter((c) => !keyOk(c.key, c.value)).map((c) => c.key))];

// A URL the gate will push to: https, or ssh (ssh:// or user@host:path). Never a local path, file:, ext::, git:, http: or anything else. A user part is allowed in both
// forms only when it is a short plain name (a letter or digit, then letters, digits, `.`, `_`, `-`, at most 32 in all) that does not start like an access token
// (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_, glpat-), and never a password: a token in the URL would be printed on the push-to line. Refusals never echo the user part.
// The host git will connect to is printed on its own (`host <hostname>`, urlHost) in `push-to:`, so `https://github.com@evil.example/o/r.git` cannot read as github.com.
const TOKEN_PREFIX = /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-)/i;
const USER_OK = (u) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(u) && !/\.\.|\.$/.test(u) && !TOKEN_PREFIX.test(u);
const HOST_OK = (h) => /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/.test(h) || /^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(h);
export function urlOk(url) {
  if (typeof url !== 'string' || url.length > 500 || /[\s\u0000-\u001f\u007f\\]/.test(url)) return false;
  const h = /^(https|ssh):\/\/([^/?#]*)\//i.exec(url);
  if (h) {
    const auth = h[2];
    const at = auth.lastIndexOf('@');
    return (at === -1 || USER_OK(auth.slice(0, at))) && HOST_OK(auth.slice(at + 1));
  }
  const m = /^([^@]+)@[A-Za-z0-9][A-Za-z0-9.-]*:[^:]/.exec(url);
  return m !== null && USER_OK(m[1]);
}

// The host name git connects to for an accepted URL (lower case, no user, no port), or null for anything else (a local path in the tests).
export function urlHost(url) {
  if (typeof url !== 'string') return null;
  const h = /^(?:https|ssh):\/\/([^/?#]*)\//i.exec(url);
  if (h) {
    const host = h[1].slice(h[1].lastIndexOf('@') + 1);
    const m = /^(\[[0-9A-Fa-f:.]+\]|[^:]+)(?::\d{1,5})?$/.exec(host);
    return m ? m[1].toLowerCase() : null;
  }
  const m = /^[^@]+@([^:]+):/.exec(url);
  return m ? m[1].toLowerCase() : null;
}

const plain = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(s);
export const branchOk = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(s);

// Where a push of `branch` would go. -> { remote, url } | { refuse: why }. The remote is the branch's pushRemote, else its remote, else the only remote.
// The repository's local configuration is read by git itself and must hold nothing outside what a plain push needs.
export function resolveDestination(top, branch, { allowLocal = false } = {}) {
  const conf = localConfig(top);
  if (conf === null) return { refuse: "git could not read the repository's configuration" };
  const bad = unwantedKeys(conf);
  if (bad.length) return { refuse: `the repository's own git configuration holds settings a plain push does not need: ${safe(bad.slice(0, 8).join(', '))}${bad.length > 8 ? ', ...' : ''}; push by hand: git push <remote> <branch>` };
  const get = (k) => {
    const hit = conf.filter((c) => c.key === k).pop();
    return hit === undefined ? undefined : hit.value;
  };
  const names = [...new Set(conf.map((c) => /^remote\.(.+)\.url$/.exec(c.key)).filter(Boolean).map((m) => m[1]))];
  let remote = get(`branch.${branch}.pushremote`) || get(`branch.${branch}.remote`);
  if (remote === undefined) {
    if (names.length === 1) remote = names[0];
    else if (names.length === 0) return { refuse: 'no remote to push to: the repository has none' };
    else return { refuse: `no remote chosen: the repository has ${names.length} remotes (${safe(names.slice(0, 6).join(', '))}) and branch ${safe(branch)} names none; choose one with: git config branch.${safe(branch)}.pushRemote <name>` };
  }
  if (!plain(remote)) return { refuse: 'the remote this branch pushes to is not a plain remote name' };
  if (conf.filter((c) => c.key === `remote.${remote}.url`).length !== 1) return { refuse: `remote ${safe(remote)} has no single URL in this repository's configuration` };
  const url = pushUrl(top, remote);
  if (url === null) return { refuse: `remote ${safe(remote)} has no single URL` };
  if (!allowLocal && !urlOk(url)) return { refuse: `the URL of remote ${safe(remote)} is not https or ssh with at most a short plain user name (a password, an access token, a local path, file:, ext:: and other forms are not pushed to by the gate)` };
  return { remote, url };
}

export const pushToLine = (d) => `push-to: ${safe(d.remote)} ${safe(d.url)}${urlHost(d.url) ? ` host ${safe(urlHost(d.url))}` : ''}`;

// The branch a push may go to is fixed at Go (state.pushTo.branch). -> null when `branch` is that branch, else why not. A record without a branch
// (written before the branch was recorded) approves no push at all, never "any branch".
export function approvedBranchProblem(state, branch) {
  const bound = state && state.pushTo;
  if (!bound || typeof bound.branch !== 'string' || !branchOk(bound.branch)) return 'the push approved at Go names no branch (an older approval); run go again with --allow-kind git-push';
  if (branch !== bound.branch) return `the current branch is ${safe(String(branch || 'a detached HEAD'))}, not the branch approved for the push at Go (${safe(bound.branch)}); switch back with git switch ${safe(bound.branch)}, or run go again`;
  return null;
}

const refuse = (why, lines = []) => ({ lines: [...lines, `push: refused (${why})`], data: { status: 'REFUSED', reason: why }, code: 1 });

const USE = "push needs the planner's statement of the review result: jefe-gate push --review pass";

export function cmdPush(args, { allowLocal = false } = {}) {
  clearGitCaches(); // read the configuration fresh for the push
  if (!(args.length === 2 && args[0] === '--review')) return { lines: [`push: ${USE}`], data: { status: 'ERROR' }, code: 2 };
  if (args[1] !== 'pass') return refuse(`--review must be pass: a push needs a passing review; ${USE}`);
  const root = shared.root || process.cwd();
  const state = readState(root);
  const kinds = activeKinds(root, state);
  if (kinds === null || !kinds.some((k) => k.name === 'git-push')) return refuse('the git-push kind is not approved for a running job; approve it at Go');
  const rec = readReportFile(root);
  const at = rec ? Date.parse(rec.at) : NaN;
  const fresh = Number.isFinite(at) && Date.now() - at <= FRESH_MS && at - Date.now() <= 60000;
  if (!rec || (rec.gate !== 'gate: PASS' && rec.gate !== 'gate: PASS (tests not run)') || rec.session !== (SESSION || null) || !fresh) return refuse("this job's ending finish has not printed the plain gate: PASS in this session; run finish first");
  if (firstUnfinished(readPlan(root))) return refuse('a stage of the plan is still open; finish it and run the ending finish again');
  const top = repoTop(root);
  if (!top) return refuse('not a git repository');
  if (!/^[0-9a-f]{40,64}$/.test(String(rec.sha)) || !branchOk(rec.branch)) return refuse('the passing finish recorded no commit and branch; run finish again');
  let head;
  let branch;
  try {
    head = git(top, ['rev-parse', 'HEAD']).toString('utf8').trim();
    branch = currentBranchName(top);
  } catch {
    return refuse(`HEAD is detached or unreadable: the tested commit is ${rec.sha}; run finish again`);
  }
  if (head !== rec.sha || branch !== rec.branch) return refuse(`the tested commit is ${rec.sha} on ${safe(rec.branch)}; HEAD is now ${head} on ${safe(branch)}; run finish again`);
  const branchWhy = approvedBranchProblem(state, branch);
  if (branchWhy) return refuse(branchWhy);
  // the tested state must be what HEAD holds: the passing finish saw a clean tree (it committed everything, or there was nothing to commit), and it is clean now
  if (rec.clean !== true) return refuse('the passing finish ran with uncommitted changes (it made no commit that holds them); run finish with --commit so the tested state is what HEAD holds, then push');
  const dirty = dirtyPaths(root);
  if (dirty === null) return refuse('git could not say whether the working tree is clean');
  if (dirty > 0) return refuse(`there are uncommitted changes (${dirty} path${dirty === 1 ? '' : 's'}); the tested state must be what HEAD holds: run finish with --commit, then push`);
  const d = resolveDestination(top, branch, { allowLocal });
  if (d.refuse) return refuse(d.refuse);
  const lines = [`${pushToLine(d)} branch ${safe(branch)}`];
  const bound = state && state.pushTo;
  if (!bound || bound.remote !== d.remote || bound.url !== d.url) {
    return refuse(bound ? `the destination is not the one approved at Go (${safe(String(bound.remote))} ${safe(String(bound.url))}); run go again to approve this one` : 'no destination was recorded at Go; run go again with --allow-kind git-push', lines);
  }
  lines.push('push: review PASS (as the planner reports)', `push: ${safe(branch)} at ${head.slice(0, 12)} to ${safe(d.remote)}`);
  const r = gitPush(top, d.remote, head, branch, { allowLocal });
  if (r.status !== 0) {
    const last = r.stderr.trim().split('\n').filter(Boolean).pop() || '';
    lines.push(`push: FAILED (git exit ${r.status === null ? 'none' : r.status})${last ? `: ${safe(last).slice(0, 200)}` : ''}`);
    return { lines, data: { status: 'FAIL', remote: d.remote, branch }, code: 1 };
  }
  const ended = deactivate(root, 'finished'); // the job is over: its approvals end with its push
  const endFailed = ended.was && ended.failed ? ended.failed : null;
  lines.push(`push: DONE ${safe(d.remote)} ${safe(branch)} ${head.slice(0, 12)}`, ...(ended.refused ? notEndedLines(ended.refused) : [endFailed ? endFailedLine(endFailed) : 'allowed: ended (job pushed)']));
  // approvals that could not be ended make the command fail as allow --clear, park and start do; the push itself is done
  return { lines, data: { status: 'PASS', remote: d.remote, branch, sha: head, url: d.url, ...(ended.refused ? { allowedRefused: ended.refused.file } : endFailed ? { allowedFailed: endFailed.file } : {}) }, code: endFailed || ended.refused ? 1 : 0 };
}
