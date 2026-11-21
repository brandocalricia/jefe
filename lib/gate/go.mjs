// go: the one call that starts a job (goal, plan, prefs, approved command kinds, branch).
import { lstatSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { activate, buildKinds, deactivate, dropChecks } from '../../hooks/allow.mjs';
import { NAMED_KINDS, readState, shq } from '../../hooks/permit-core.mjs';
import { realOf, sameIdentity } from '../../hooks/approvals-state.mjs';
import { hostOf, loadProviders, record } from '../providers/config.mjs';
import { firstUnfinished, formatPlan, parseStageArg, PLAN_REL, planPath, readPlan } from '../../hooks/plan.mjs';
import { PREF_KEY_RE, foreignJefe, hereInfo, projectNameOk, readRegular, safe, setPref, slugify, writePrivate } from '../../hooks/projects.mjs';
import { ensureWrappers } from '../../hooks/wrappers.mjs';
import { endFailedLine, notEndedLines, refusedStateLine, withRunLinkFix } from './allow.mjs';
import { hasFlag, optValue, optValues } from './args.mjs';
import { briefFlags, buildBrief, checkValues } from './brief.mjs';
import { SESSION, shared } from './env.mjs';
import { keepOrSetBaseline, markBaselineEnded } from './secrets-baseline.mjs';
import { takeSnapshot } from './size.mjs';
import { clearCommitsFile, clearRecordedName, clearReportFile, clearSpawnsFile, readGate, recordBriefMark, recordWantedName, updateGate } from './gatefile.mjs';
import { BARE_REPO_LINE, currentBranchName, dirtyNames, git, gitDirOnly, repoTop, someNames, trackedJefe, trackedJefeLines, unreadableConfigLines } from './git.mjs';
import { pickName } from './handoff.mjs';
import { branchOk, pushToLine, resolveDestination } from './push.mjs';
import { briefModelsLine, modelsFromArgs, modelsLine, plannerModel, PREF_KEY, resolveModels } from './models.mjs';
import { modelsWith } from '../../hooks/levels.mjs';
import { allowed } from './secrets-scan.mjs';
import { detectTests } from './tests.mjs';

// ---------- go: the one call that starts a job ----------

const oneLineValue = (t) => String(t).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();

// key=value -> { key, value } | null
export function keyValue(text) {
  const i = String(text).indexOf('=');
  if (i < 1) return null;
  const key = text.slice(0, i);
  return PREF_KEY_RE.test(key) ? { key, value: oneLineValue(text.slice(i + 1)) } : null;
}

// Every --stage "<title> :: <done when>" -> [stage] | { error }
export function stagesFromArgs(args) {
  const out = [];
  for (const t of optValues(args, '--stage')) {
    const st = parseStageArg(t);
    if (!st) return { error: `bad --stage "${safe(String(t).slice(0, 40))}": use "<title> :: <done when>"` };
    out.push(st);
  }
  return out;
}

// Writes root's plan.md. -> null | an error message.
export function writePlan(root, stages) {
  try {
    writePrivate(planPath(root), formatPlan(stages), { guardDir: true });
    return null;
  } catch (err) {
    return err && err.code === 'ESYMLINK' ? err.message : `cannot write ${PLAN_REL}: ${(err && (err.code || err.message)) || err}`;
  }
}

// The argv prefix of the project's detected test command (for the `tests` kind), or null.
export function argvOfDetected(d) {
  if (!d) return null;
  if (d.cmd === process.execPath) return ['node', '--test'];
  if (d.cmd === 'python3') return ['python3', '-m', 'pytest'];
  return [d.cmd, d.args[0]];
}

export function detectedArgv(root) {
  try {
    return argvOfDetected(detectTests(root));
  } catch {
    return null;
  }
}

// The branch the work tree is on right now: its name; `detached HEAD at <short sha>` on a detached HEAD (symbolic-ref exits 1); null when
// the folder is not a git work tree or git failed any other way (the brief then has no BRANCH line: nothing is made up).
function currentBranch(top) {
  try {
    return currentBranchName(top) || null;
  } catch (err) {
    if (!err || err.status !== 1) return null;
    try {
      const sha = git(top, ['rev-parse', '--short', 'HEAD']).toString('utf8').trim();
      return /^[0-9a-f]{4,40}$/.test(sha) ? `detached HEAD at ${sha}` : null;
    } catch {
      return null;
    }
  }
}

// --branch <slug>: switch to (or create) jefe/<slug>. -> { branch } on success (null when not a git repository), { failed } otherwise
function switchBranch(slugArg) {
  const top = repoTop(process.cwd());
  if (!top) return { branch: null, line: 'none (not a git repository)' };
  const name = `jefe/${slugify(slugArg)}`;
  try {
    let exists = true;
    try {
      git(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${name}`]);
    } catch {
      exists = false;
    }
    git(top, exists ? ['switch', name] : ['switch', '-c', name]);
    return { branch: name, line: name };
  } catch {
    return { failed: `FAILED (could not switch to ${name}; commit or stash changes that conflict)` };
  }
}

// The files a repository can ship in a .jefe/ that Jefe later reads: the preferences, the check script, the task, the brief and the plan.
const SHIPPED = ['prefs.json', 'check.sh', 'task.md', 'goal.md', 'plan.md'];

// true when something (a file, a symlink, even a dangling one) is at p; lstat never follows a symlink
function present(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// .jefe/foreign must be a real folder (or absent) before anything is moved into it: a shipped symlink there would carry the files to wherever it
// points, outside the project. -> null | the one refusal line. It is never followed and never deleted.
export function foreignDestProblem(root) {
  const dir = join(root, '.jefe');
  try {
    if (lstatSync(dir).isSymbolicLink()) return null; // nothing is moved out of a symlinked .jefe/ (moveForeignFiles)
  } catch {
    return null;
  }
  let st;
  try {
    st = lstatSync(join(dir, 'foreign'));
  } catch {
    return null; // absent: go makes it
  }
  if (st.isSymbolicLink()) return 'go: refused: .jefe/foreign is a symlink that came with this folder (not followed, not deleted); remove it and run go again; nothing was changed';
  if (!st.isDirectory()) return 'go: refused: .jefe/foreign is not a folder (it came with this folder; not deleted); remove it and run go again; nothing was changed';
  return null;
}

// A .jefe/ this installation did not create: move what it shipped (SHIPPED) into .jefe/foreign/, which nothing reads, so that from the first job on the folder
// is this installation's and a later job never reads those files. -> the names moved ([] when none or the folder cannot be moved into), or { error } when
// .jefe/foreign is not a real folder (foreignDestProblem). A destination name already taken by anything, a planted symlink included, is never replaced.
export function moveForeignFiles(root) {
  const dir = join(root, '.jefe');
  try {
    if (lstatSync(dir).isSymbolicLink()) return [];
    const problem = foreignDestProblem(root);
    if (problem) return { error: problem };
    const dest = join(dir, 'foreign');
    const moved = [];
    for (const n of SHIPPED) {
      if (!present(join(dir, n))) continue;
      if (!moved.length) {
        if (!present(dest)) mkdirSync(dest, { mode: 0o700 });
        const st = lstatSync(dest);
        if (st.isSymbolicLink() || !st.isDirectory()) return { error: foreignDestProblem(root) || 'go: refused: .jefe/foreign is not a folder; nothing was changed' };
      }
      let to = join(dest, n);
      for (let k = 1; present(to) && k < 100; k++) to = join(dest, `${n}.${k}`);
      // every name taken: replace nothing, and do not leave a shipped file where a later job would read it
      if (present(to)) return { error: `go: refused: .jefe/foreign/ has no free name for ${n} (not replaced); clear .jefe/foreign/ and run go again; nothing was approved` };
      renameSync(join(dir, n), to);
      moved.push(n);
    }
    return moved;
  } catch {
    return [];
  }
}

// A go without --resume begins a new job, whatever an earlier `start` kept for a job it took as continuing: the start snapshot (what --since start,
// base and size measure from; no stage snapshot yet) and the secrets baseline (and with it the allowlist at the job's start) are taken now, through
// the functions a new job's `start` uses. Outside git there is no snapshot and no baseline, as at start. The brief mark is recorded by go itself.
function newJobStart(root) {
  let snap = null;
  try {
    snap = takeSnapshot();
  } catch {
    snap = null; // as at start: --since start then says there is no snapshot
  }
  updateGate({ snapshot: snap || undefined, stageSnapshot: undefined });
  markBaselineEnded(root); // the earlier job's baseline is over, so the next call records this one
  keepOrSetBaseline(root, snap, false);
}

// The `allowed:` line, then one `allowed-cmd:` line per exact command, shell-quoted as `allow --show` prints it; then, when the file just written
// is not private enough to be read (hooks/approvals-state.mjs fileProblem), the line that says the approvals are NOT in effect and why.
function allowedLines(built, root) {
  const refused = refusedStateLine(root);
  return [
    `allowed: ${built.names.length} command kinds for this job${built.names.length ? ` (${built.names.join(', ')})` : ''}`,
    ...built.kinds.filter((k) => k.exact).map((k) => `allowed-cmd: ${safe(k.argv.map(shq).join(' '))}`),
    ...(refused ? [refused] : []),
  ];
}

const providerLine = (p) => `providers: ${safe(p.name)} (${hostOf(p)}) models ${p.models.map(safe).join(', ')}, uses ${p.uses.join(', ')}, ${p.trusted ? 'TRUSTED for project files' : 'instruction text only'}`;

// ---------- go --resume: a parked or expired job gets its approvals again; goal, plan, ticks, start reference and baseline stay ----------

// Every option that shapes the brief, the plan, the branch or the project: refused with --resume (it keeps them all).
const RESUME_REFUSED = ['--goal', '--done', '--out', '--stage', '--branch', '--ref', '--why', '--free', '--answer', '--pref', '--name', '--helpers', '--helper-model'];

// Can this folder's job be resumed? -> { stages, next } | null. Only a job whose approvals were parked or ran out by time (an approvals record of
// this folder that `park` ended, or one still marked active, not a finished job's idle window), with the goal.md `go` wrote and, when it has a
// plan, an open stage. A job that finished or whose approvals the user ended (allow --clear) is never resumed, whatever plan.md says.
export function resumeState(root) {
  const s = readState(root);
  if (!s || !sameIdentity(s, realOf(root))) return null;
  if (!((s.active === false && s.ended === 'parked') || (s.active === true && s.ending !== true))) return null;
  const stages = readPlan(root);
  const next = stages.length ? firstUnfinished(stages) : null;
  if (stages.length && !next) return null;
  try {
    if (!lstatSync(join(root, '.jefe', 'goal.md')).isFile()) return null;
  } catch {
    return null;
  }
  return { stages, next };
}

// Why an open plan cannot be resumed, as start's one `allowed:` line.
export function notResumableLine(root, state = readState(root)) {
  const s = state && sameIdentity(state, realOf(root)) ? state : null;
  if (s && s.active === false && s.ended === 'cleared') return 'allowed: ended by you (allow --clear); a new go is needed to continue';
  if (s && ((s.active === true && s.ending === true) || ['finished', 'ended-at-start', 'session-ended'].includes(s.ended))) return 'allowed: ended (the job finished); a new go is needed to continue';
  return 'allowed: ended; a new go is needed to continue';
}

// The branch this folder's job works on: the push branch Go recorded (the live record, or the one an ended record kept), else the BRANCH: line
// the job's first go wrote into goal.md. -> a plain branch name, or null (not recorded, or a detached HEAD).
export function jobBranch(root, state = readState(root)) {
  const src = state && sameIdentity(state, realOf(root)) ? (state.active === true ? state : state.previous) : null;
  const b = src && typeof src === 'object' && src.pushTo && typeof src.pushTo.branch === 'string' ? src.pushTo.branch : null;
  if (b && branchOk(b)) return b;
  try {
    const t = readRegular(join(root, '.jefe', 'goal.md'), 256 * 1024) || '';
    const m = /^BRANCH: (.+)$/m.exec(t);
    return m && branchOk(m[1].trim()) ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// The `go --resume ...` command that approves again what this folder's job had approved (from the approvals record: the live or expired
// kinds, or the ones an ended record kept), each value shell-quoted. Just `go --resume` when nothing can be read. -> { command, branch }: the
// push branch (null without git-push) is not in the command (go --resume takes no --branch); start prints it on its own line.
export function resumeCommand(root, state = readState(root)) {
  const parts = ['go', '--resume'];
  const src = !state || !sameIdentity(state, realOf(root)) ? null : state.active === true ? state : state.previous;
  const kinds = src && typeof src === 'object' && Array.isArray(src.kinds) ? src.kinds.filter((k) => k && typeof k.name === 'string' && Array.isArray(k.argv) && k.argv.length && k.argv.every((t) => typeof t === 'string')) : [];
  for (const n of [...new Set(kinds.filter((k) => !k.exact && NAMED_KINDS.includes(k.name)).map((k) => k.name))]) {
    parts.push('--allow-kind', n);
    if (n === 'git-push' && src.pushTo && typeof src.pushTo.url === 'string') parts.push('--push-to', shq(src.pushTo.url));
  }
  for (const k of kinds.filter((x) => x.exact)) parts.push('--allow-cmd', shq(k.argv.map(shq).join(' ')));
  const prov = kinds.find((k) => k.name === 'providers' && Array.isArray(k.providers));
  for (const p of prov ? prov.providers : []) if (p && typeof p.name === 'string') parts.push('--allow-provider', shq(p.name));
  const branch = parts.includes('git-push') ? jobBranch(root, state) : null;
  return { command: safe(parts.join(' ')), branch: branch ? safe(branch) : null };
}

// The resume itself, after every check `go` makes on the approvals: wrappers, the approvals (for the usual time), the output. Nothing else is written.
function resumeJob(root, { built, recorded, pushTo, rs }) {
  const lines = pushTo ? [`${pushToLine(pushTo)} branch ${safe(pushTo.branch)}`] : [];
  const wr = ensureWrappers(root);
  if (wr.error) lines.push(`warning: wrappers not written: ${safe(wr.error.slice(0, 160))}`);
  // the paths that differed from HEAD at the job's first go stay that job's (the job's own work since then is not "changed before the job")
  const prior = readState(root);
  const src = prior && sameIdentity(prior, realOf(root)) ? (prior.active === true ? prior : prior.previous) : null;
  const dirtyAtGo = built.names.includes('git-commit') && src && Array.isArray(src.dirtyAtGo) ? src.dirtyAtGo : null;
  const aerr = activate(root, { kinds: built.kinds, session: SESSION || null, pushTo, dirtyAtGo });
  if (aerr) return { lines: [...lines, withRunLinkFix(root, `allowed: FAILED ${safe(aerr)}`), 'go: stopped; nothing was activated'], data: { status: 'ERROR' }, code: 1 };
  lines.push(...allowedLines(built, root));
  for (const p of recorded) lines.push(providerLine(p));
  // without a push, work on another branch is allowed (finish --commit commits on the branch checked out then); say so
  const own = pushTo ? null : jobBranch(root, prior);
  const top = own ? repoTop(root) : null;
  const now = top ? currentBranch(top) : null;
  if (own && now && now !== own) lines.push(`note: this job was on branch ${safe(own)}; the work tree is on ${safe(now)} now, and finish --commit commits there`);
  lines.push(rs.next ? `resume: plan kept (stage ${rs.next.n} of ${rs.stages.length} is next)` : 'resume: plan kept');
  return { lines, data: { resumed: true, allowed: built.names.length, kinds: built.names, stage: rs.next ? { next: rs.next.n, total: rs.stages.length } : null }, code: 0 };
}

export function cmdGo(args, { allowLocal = false } = {}) {
  const resume = hasFlag(args, '--resume');
  if (resume && RESUME_REFUSED.some((f) => optValue(args, f) !== null)) return { lines: ['go: --resume keeps the goal and plan; give only the approvals'], data: { status: 'ERROR', refused: 'resume' }, code: 2 };
  const goal = optValue(args, '--goal');
  const done = optValue(args, '--done');
  const missing = resume ? [] : [...(!goal || !goal.trim() ? ['--goal'] : []), ...(!done || !done.trim() ? ['--done'] : [])];
  if (missing.length) return { lines: [`go: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing; example: jefe-gate go --goal "build the login page" --done "the tests pass"`], data: { status: 'ERROR', missing }, code: 2 };
  const root = shared.root || process.cwd();
  // a bare repository (or the inside of a .git folder) has no work tree: refused exactly as `start` refuses it, before anything is written
  if (gitDirOnly(root)) return { lines: [BARE_REPO_LINE, 'go: nothing was changed'], data: { status: 'ERROR', refused: 'bare repository' }, code: 1 };
  // Is a .jefe/ that was here before this call foreign (shipped in a tarball or clone)? Decided BEFORE anything is written: once `start` or this call
  // has written a run file the folder looks like ours, so `start` also records its own answer in the gate file. A foreign folder's prefs choose nothing.
  const foreign = foreignJefe(root) || (readGate() || {}).foreignJefe === true;
  const nameArg = optValue(args, '--name'); // the name finish registers the project under (default: the folder name)
  if (nameArg !== null && !projectNameOk(nameArg)) return { lines: [`go: bad --name "${safe(String(nameArg).slice(0, 40))}": use letters, digits, dot, underscore or hyphen, starting with a letter or digit (at most 40 characters)`], data: { status: 'ERROR' }, code: 2 };
  // a repository must not ship its own .jefe (exactly as `start` refuses): nothing is written or approved for it
  const tracked = trackedJefe(root);
  if (tracked.unreadable) return { lines: [...unreadableConfigLines(tracked.unreadable, safe, tracked.what), 'go: nothing was changed'], data: { status: 'ERROR', refused: 'unreadable git configuration', reason: tracked.unreadable }, code: 1 };
  if (tracked.length) return { lines: [...trackedJefeLines(tracked, safe), 'go: nothing was changed'], data: { status: 'ERROR', refused: 'tracked .jefe', tracked }, code: 1 };
  // a resume needs this installation's own goal.md and an unfinished job; a foreign .jefe/ holds neither
  const rs = resume && !foreign ? resumeState(root) : null;
  if (resume && !rs) return { lines: ['go: nothing to resume (no unfinished plan here); use go with --goal'], data: { status: 'ERROR', refused: 'nothing to resume' }, code: 2 };
  // a foreign .jefe/ whose foreign/ is not a real folder: refused before anything is switched, moved, written or approved
  const destProblem = foreign ? foreignDestProblem(root) : null;
  if (destProblem) return { lines: [destProblem], data: { status: 'ERROR', refused: 'foreign' }, code: 1 };
  const answers = [];
  for (const t of optValues(args, '--answer')) {
    const kv = keyValue(t);
    if (!kv) return { lines: [`go: bad --answer "${safe(String(t).slice(0, 40))}": use key=value (key: letters, digits, dash, underscore)`], data: { status: 'ERROR' }, code: 2 };
    answers.push(kv);
  }
  const prefs = [];
  for (const t of optValues(args, '--pref')) {
    const kv = keyValue(t);
    if (!kv) return { lines: [`go: bad --pref "${safe(String(t).slice(0, 40))}": use key=value (key: letters, digits, dash, underscore)`], data: { status: 'ERROR' }, code: 2 };
    prefs.push(kv);
  }
  let detected = null;
  try {
    detected = detectTests(root);
  } catch {
    // none detected
  }
  const bad = checkValues(args, ['--goal', '--done', '--out', '--ref', '--answer', '--allow-cmd', '--push-to']);
  if (bad) return { lines: [`go: ${bad}`], data: { status: 'ERROR' }, code: 2 };
  const kindNames = optValues(args, '--allow-kind');
  const kindCmds = optValues(args, '--allow-cmd');
  // providers: only those NAMED here (--allow-provider <name>) and configured now are recorded, exactly as configured now (lib/providers/config.mjs record())
  const wantedProviders = optValues(args, '--allow-provider');
  // the SAME loader call `ask`, `start` and `provider list` make, so Go never records a provider that every later `ask` would drop
  const loaded = wantedProviders.length ? loadProviders({ root }) : { providers: [], problems: [] };
  const configured = loaded.providers;
  for (const n of wantedProviders) {
    if (configured.some((p) => p.name === n)) continue;
    const why = loaded.problems.find((m) => m.startsWith(`${safe(String(n).slice(0, 40))}: `));
    if (why) return { lines: [`go: --allow-provider "${safe(String(n).slice(0, 40))}" is refused, it would be ignored (${why}); nothing was changed`], data: { status: 'ERROR' }, code: 2 };
    return { lines: [`go: --allow-provider "${safe(String(n).slice(0, 40))}" is not in providers.json (jefe-project provider list); nothing was changed`], data: { status: 'ERROR' }, code: 2 };
  }
  const recorded = [...new Set(wantedProviders)].map((n) => record(configured.find((p) => p.name === n)));
  const built = buildKinds({ names: kindNames, cmds: kindCmds, detected: argvOfDetected(detected), providers: recorded });
  if (built.error) return { lines: [`go: ${built.error}; nothing was changed`], data: { status: 'ERROR' }, code: 2 };
  // the push kind binds the destination NOW: the remote this job's branch will push to and its URL are resolved, shown (`push-to:`) and recorded; a
  // repository that cannot be pushed safely is refused here, before anything is written
  let pushTo = null;
  const pushToArg = optValue(args, '--push-to');
  if (pushToArg !== null && !built.names.includes('git-push')) return { lines: ['go: --push-to goes with --allow-kind git-push (it names where the job may push); nothing was changed'], data: { status: 'ERROR' }, code: 2 };
  if (built.names.includes('git-push')) {
    const ptop = repoTop(process.cwd());
    if (!ptop) return { lines: ['go: --allow-kind git-push needs a git repository; nothing was changed'], data: { status: 'ERROR' }, code: 1 };
    let pbranch = optValue(args, '--branch') !== null ? `jefe/${slugify(optValue(args, '--branch'))}` : currentBranch(ptop);
    if (resume) {
      // a resume pushes only the job's own branch, never whatever is checked out now (the prompt the user approves names no branch)
      const own = jobBranch(root);
      if (!own) return { lines: ['go: --resume cannot approve git-push: the job\'s branch is not recorded; start a new job with go --branch <slug> --allow-kind git-push; nothing was changed'], data: { status: 'ERROR', refused: 'git-push' }, code: 1 };
      if (pbranch !== own) return { lines: [`go: --resume with git-push refused: the job's branch is ${safe(own)}, the work tree is on ${safe(String(pbranch || 'a detached HEAD'))}; switch back with git switch ${safe(own)}, or start a new job; nothing was changed`], data: { status: 'ERROR', refused: 'git-push', jobBranch: own, current: pbranch }, code: 1 };
      pbranch = own;
    }
    if (!pbranch || pbranch.startsWith('detached HEAD')) return { lines: ['go: --allow-kind git-push needs a branch (HEAD is detached or unreadable); nothing was changed'], data: { status: 'ERROR' }, code: 1 };
    // the branch is part of the approval: only a plain name is recorded (a leading dash, a space or a control character is refused)
    if (!branchOk(pbranch)) return { lines: [`go: --allow-kind git-push refused (the branch name ${JSON.stringify(safe(pbranch.slice(0, 80)))} is not a plain branch name: letters, digits, . _ / -, not starting with - or .); nothing was changed`], data: { status: 'ERROR', refused: 'git-push' }, code: 1 };
    const d = resolveDestination(ptop, pbranch, { allowLocal });
    if (d.refuse) return { lines: [`go: --allow-kind git-push refused (${d.refuse}); nothing was changed`], data: { status: 'ERROR', refused: 'git-push' }, code: 1 };
    // the destination is part of the command the user approves: --push-to must be the URL this job's branch would push to
    const resolved = `${safe(d.remote)} ${safe(d.url)}`;
    if (pushToArg === null || pushToArg === '') return { lines: [`go: --allow-kind git-push needs --push-to <url>, so the destination is in the command you approve; ${safe(pbranch)} pushes to ${resolved}; nothing was changed`], data: { status: 'ERROR', refused: 'push-to', resolved: d }, code: 2 };
    if (pushToArg !== d.url) return { lines: [`go: --push-to ${safe(String(pushToArg).slice(0, 200))} is not where ${safe(pbranch)} pushes; it pushes to ${resolved}; nothing was changed`], data: { status: 'ERROR', refused: 'push-to', resolved: d }, code: 2 };
    pushTo = { ...d, branch: pbranch };
  }
  const chosen = modelsFromArgs(args);
  if (chosen.error) return { lines: [`go: ${safe(chosen.error)}; nothing was changed`], data: { status: 'ERROR' }, code: 2 };
  const stages = stagesFromArgs(args);
  if (stages.error) return { lines: [`go: ${stages.error}`], data: { status: 'ERROR' }, code: 2 };
  const bf = briefFlags(args);
  if (bf.error) return { lines: [`go: ${bf.error}`], data: { status: 'ERROR' }, code: 2 };
  if (resume) return resumeJob(root, { built, recorded, pushTo, rs });
  const lines = pushTo ? [`${pushToLine(pushTo)} branch ${safe(pushTo.branch)}`] : [];
  let code = 0;
  // Order: (1) every validation above, nothing written; (2) the branch switch; (3) the wrappers; (4) the approvals; (5) goal.md; (6) plan, prefs, name,
  // commits, stage checks; (7) the output. A failure stops there and nothing after it was written.
  const slugArg = optValue(args, '--branch');
  let branch = null;
  let branchLine = null;
  const top = repoTop(process.cwd());
  if (slugArg !== null) {
    const sw = switchBranch(slugArg);
    if (sw.failed) return { lines: [`branch: ${sw.failed}`, 'go: stopped; nothing was written and nothing was activated'], data: { status: 'ERROR', branch: sw.failed }, code: 1 };
    branch = sw.branch;
    branchLine = sw.line;
  } else if (top) branch = currentBranch(top);
  // a .jefe/ that came with the repository: what it shipped is set aside before anything of this job is written, and the folder is ours from here on
  if (foreign) {
    const moved = moveForeignFiles(root);
    if (moved.error) return { lines: [...lines, ...(branchLine ? [`branch: ${branchLine}`] : []), moved.error], data: { status: 'ERROR', refused: 'foreign' }, code: 1 };
    if (moved.length) lines.push(`foreign: this folder came with a .jefe/ that this Jefe did not create; its ${moved.join(', ')} were moved to .jefe/foreign/ and are never read`);
    if ((readGate() || {}).foreignJefe === true) updateGate({ foreignJefe: false }); // the folder is ours now: a later go must not set aside our own files
  }
  const wr = ensureWrappers(root);
  if (wr.error) lines.push(`warning: wrappers not written: ${safe(wr.error.slice(0, 160))}`);
  // a new job starts from its own approved kinds: exactly what this call names (no mode adds any; only `go` grants approvals)
  // disclosure at the point of consent: what was already changed before this job goes into its commit (finish --commit stages the whole folder)
  const dirtyAtGo = built.names.includes('git-commit') && top ? dirtyNames(root) : null;
  if (dirtyAtGo && dirtyAtGo.length) lines.push(`note: ${dirtyAtGo.length} file${dirtyAtGo.length === 1 ? ' was' : 's were'} already changed before this job and will be in its commit: ${someNames(dirtyAtGo, safe)}`);
  const aerr = activate(root, { kinds: built.kinds, session: SESSION || null, pushTo, dirtyAtGo });
  if (aerr) return { lines: [...lines, ...(branchLine ? [`branch: ${branchLine}`] : []), withRunLinkFix(root, `allowed: FAILED ${safe(aerr)}`), 'go: stopped; nothing was activated'], data: { status: 'ERROR' }, code: 1 };
  // the brief is built from what steps 2 and 4 did; if it cannot be written, take the approvals back (a file at that path that Jefe did not write is never trusted or kept)
  // the helper models this job runs on: this Go's options (saved as the project preference), else the saved preference, else the defaults
  const asked = chosen.spec ? { models: modelsWith(chosen.set, plannerModel()), source: 'go' } : resolveModels(root, { ignoreBrief: true, foreign });
  const text = buildBrief({ modelsLine: briefModelsLine(asked.models, asked.source), detected, goal: goal.trim(), why: bf.why, done: done.trim(), ref: (optValue(args, '--ref') || '').trim(), out: (optValue(args, '--out') || '').trim(), free: bf.free, answers, built, branch, providers: recorded.map((p) => p.name) });
  const goalFile = join(root, '.jefe', 'goal.md');
  try {
    writePrivate(goalFile, text, { guardDir: true });
  } catch (err) {
    const back = deactivate(root, 'go-failed');
    const why = err && err.code === 'ESYMLINK' ? err.message : `cannot write .jefe/goal.md: ${(err && (err.code || err.message)) || err}`;
    if (back.refused) return { lines: [...lines, ...(branchLine ? [`branch: ${branchLine}`] : []), `goal: FAILED ${safe(why)}`, ...notEndedLines(back.refused), 'go: stopped; the file at .jefe/goal.md was not written by Jefe'], data: { status: 'ERROR', allowedRefused: back.refused.file }, code: 1 };
    if (back.failed) return { lines: [...lines, ...(branchLine ? [`branch: ${branchLine}`] : []), `goal: FAILED ${safe(why)}`, endFailedLine(back.failed), 'go: stopped; the file at .jefe/goal.md was not written by Jefe, and the approvals could not be taken back'], data: { status: 'ERROR', allowedFailed: back.failed.file }, code: 1 };
    return { lines: [...lines, ...(branchLine ? [`branch: ${branchLine}`] : []), `goal: FAILED ${safe(why)}`, 'go: stopped; the file at .jefe/goal.md was not written by Jefe, and the approvals were taken back'], data: { status: 'ERROR' }, code: 1 };
  }
  recordBriefMark(root, text);
  lines.push('goal: .jefe/goal.md');
  // the plan: each --stage is a line; a new job without stages sets an unfinished older plan aside (plan.prev.md)
  if (stages.length) {
    const perr = writePlan(root, stages);
    if (perr) {
      lines.push(`plan: FAILED ${safe(perr)}`);
      code = 1;
    } else lines.push(`plan: ${PLAN_REL} (${stages.length} stages)`);
  } else {
    const old = readPlan(root);
    if (old.length && firstUnfinished(old)) {
      try {
        renameSync(planPath(root), join(root, '.jefe', 'plan.prev.md'));
      } catch {
        // leave it
      }
    }
  }
  let saved = 0;
  for (const p of prefs) {
    const r = setPref(root, p.key, p.value);
    if (r.ok) saved++;
    else {
      lines.push(`warning: pref ${safe(p.key)} not saved: ${safe(r.error)}`);
      code = 1;
    }
  }
  if (chosen.spec) {
    const r = setPref(root, PREF_KEY, chosen.spec);
    if (r.ok) saved++;
    else {
      lines.push(`warning: pref ${PREF_KEY} not saved: ${safe(r.error)}`);
      code = 1;
    }
  }
  lines.push(`prefs: saved ${saved}`);
  // the wanted name is this job's alone: a go without --name drops one an earlier go recorded; a new job also starts with no stage commits
  clearRecordedName(root);
  clearCommitsFile(root);
  clearReportFile(root); // a new job has no final report yet
  clearSpawnsFile(root); // and no helper spawns yet
  newJobStart(root); // and starts at this Go: its own start snapshot and secrets baseline
  if (nameArg !== null) {
    const here = hereInfo(process.env, shared.root || process.cwd());
    if (here && here.path && typeof here.name === 'string') lines.push(`name: kept ${safe(here.name)} (this folder is already registered)`);
    else {
      // the name finish registers: if another project holds it (the rule `register` applies), the name `go` prints and records is the free one finish will use
      const picked = pickName(nameArg, root);
      const use = picked.failed || picked.error ? nameArg : picked.use;
      const nerr = recordWantedName(root, use);
      lines.push(nerr ? `name: FAILED ${safe(nerr)}` : picked.error ? `name: ${use} (could not check the registry: ${safe(picked.error)})` : use !== nameArg ? `name: ${use} (${nameArg} is taken by ${safe(picked.first.path || picked.first.other || 'another project')})` : `name: ${nameArg}`);
      if (nerr) code = 1;
    }
  }
  dropChecks(root); // a new job starts with no recorded stage checks
  lines.push(...allowedLines(built, root));
  for (const p of recorded) lines.push(providerLine(p));
  if (asked.warning) lines.push(asked.warning);
  lines.push(modelsLine(asked));
  if (branchLine) lines.push(`branch: ${branchLine}`);
  return { lines, data: { models: asked.models, modelsSource: asked.source, goal: '.jefe/goal.md', plan: stages.length ? PLAN_REL : null, stages: stages.length, prefsSaved: saved, allowed: built.names.length, kinds: built.names, branch: branchLine }, code };
}
