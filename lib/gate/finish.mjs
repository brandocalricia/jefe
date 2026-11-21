// finish: the whole end-of-job call.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deactivate, dropChecks, markEnding } from '../../hooks/allow.mjs';
import { activeKinds, readState } from '../../hooks/permit-core.mjs';
import { firstUnfinished, PLAN_REL, readPlan } from '../../hooks/plan.mjs';
import { readRegular, safe } from '../../hooks/projects.mjs';
import { endFailedLine, notEndedLines, shortenFailedLine } from './allow.mjs';
import { optValue, optValues } from './args.mjs';
import { SESSION, shared } from './env.mjs';
import { oneLine, stampOf } from './format.mjs';
import { ranLine, resolveModels } from './models.mjs';
import { isDir } from './fsutil.mjs';
import { clearReportFile, readGate, recordReport, updateGate } from './gatefile.mjs';
import { writePlan } from './go.mjs';
import { appendLog, buildHandoff, changedSince, commitStep, currentLevel, gitInfo, HANDOFF_MARK, handoffStep, projectStep, writeHandoff } from './handoff.mjs';
import { approvedBranchProblem } from './push.mjs';
import { projectCommitLine, recordStageCommit, withReport } from './report.mjs';
import { cmdContext, cmdCost, headless, readRun, taskGoal } from './runfile.mjs';
import { effectiveLevel, resolveNow, usageOfRun } from './levels.mjs';
import { usageLineOf } from './start.mjs';
import { takeSnapshot } from './size.mjs';
import { detectTests } from './tests.mjs';
import { markBaselineEnded } from './secrets-baseline.mjs';
import { testLabel } from './brief.mjs';
import { cmdVerify, NO_STAGES, plainPass, stageOnlyRun, writeStageChecks } from './verify.mjs';
import { currentBranchName, dirtyPaths, git, repoTop } from './git.mjs';

// The commit and branch this finish saw (what a later `push` may push, and nothing else); nulls outside a git work tree or on a detached HEAD.
function testedState(root) {
  const top = repoTop(root);
  if (!top) return { sha: null, branch: null };
  try {
    const sha = git(top, ['rev-parse', 'HEAD']).toString('utf8').trim();
    let branch = null;
    try {
      branch = currentBranchName(top) || null;
    } catch {
      // detached
    }
    // clean: the working tree held nothing HEAD does not hold at this finish (a finish without --commit over changed files is not a tested commit)
    return { sha: /^[0-9a-f]{40,64}$/.test(sha) ? sha : null, branch, clean: dirtyPaths(root) === 0 };
  } catch {
    return { sha: null, branch: null };
  }
}

// --plan job | project (the old words: small and medium mean job, large means project)
const PLAN_WORDS = { job: 'job', small: 'job', medium: 'job', project: 'project', large: 'project' };
export async function cmdFinish(args) {
  const dd = args.indexOf('--');
  const own = dd === -1 ? args : args.slice(0, dd);
  const root = shared.root || process.cwd();
  const stages = readPlan(root);
  const planArg = optValue(own, '--plan');
  if (planArg !== null && !Object.hasOwn(PLAN_WORDS, planArg.toLowerCase())) return { lines: ['gate: bad --plan value (use job or project; small and medium mean job, large means project)'], data: { gate: 'ERROR' }, code: 2 };
  const planWord = planArg !== null ? PLAN_WORDS[planArg.toLowerCase()] : stages.length ? 'project' : 'job';
  const stageArg = optValue(own, '--stage');
  let stageN = null;
  if (stageArg !== null) {
    stageN = /^\d+$/.test(stageArg) ? Number(stageArg) : 0;
    if (!stages[stageN - 1]) return { lines: [stages.length ? `gate: bad --stage value (${PLAN_REL} has ${stages.length} stages)` : NO_STAGES], data: { gate: 'ERROR' }, code: 2 };
  }
  const review = optValue(own, '--review');
  if (review !== null && review !== 'pending') return { lines: ['gate: bad --review value (use pending)'], data: { gate: 'ERROR' }, code: 2 };
  const goal = optValue(own, '--goal') || taskGoal() || null;
  const notes = optValues(own, '--note');
  const commitMsg = optValue(own, '--commit');
  const cmds = [];
  for (let i = dd; dd !== -1 && i < args.length; i++) {
    if (args[i] === '--') cmds.push([]);
    else cmds[cmds.length - 1].push(args[i]);
  }
  const sinceKind = optValue(own, '--since') === 'stage' ? 'stage' : 'start';
  const startedAt = (readGate() || {}).startedAt;
  const v = await cmdVerify(args, { allRecorded: true });
  const verifyLines = v.lines.slice(0, -1);
  const verdict = v.lines[v.lines.length - 1].replace(/^gate: /, '');

  // 1. a plain PASS ticks the stage; 2. --commit commits (one commit per stage); 3. the stage snapshot is taken after the commit;
  // 4. only then the handoff is written, so it carries the new commit and the new plan state
  const changed = changedSince(sinceKind); // before the commit and the new snapshot: this stage's files
  if (stageN !== null && plainPass(verdict)) {
    stages[stageN - 1] = { ...stages[stageN - 1], done: true, pass: new Date().toISOString().slice(0, 10) };
    writePlan(root, stages);
  } else if (stageN !== null && stages[stageN - 1].done) {
    // a done stage that does not pass now (a fix round's re-finish) is open again, before the handoff lists the stages
    stages[stageN - 1] = { ...stages[stageN - 1], done: false, pass: null };
    writePlan(root, stages);
  }
  let commit = null;
  const commitNotes = []; // lines for the body, before the report block (what the commit left out)
  // a job that may push commits only on the branch approved for the push at Go: a commit elsewhere could never be pushed, so it is not made
  const pushApproved = (activeKinds(root, readState(root)) || []).some((k) => k.name === 'git-push');
  const branchWhy = commitMsg !== null && pushApproved ? approvedBranchProblem(readState(root), testedState(root).branch) : null;
  if (branchWhy) commitNotes.push(`commit: NOT made (${branchWhy})`);
  else if (commitMsg !== null) commit = commitStep(commitMsg, plainPass(verdict) ? 'PASS' : verdict, commitNotes);
  // the staged scan before the commit refused it: that is the gate's own secrets result, so this finish does not pass
  const secretsAfter = commitNotes.secrets === 'FAIL' ? 'FAIL (secrets)' : commitNotes.secrets === 'INCOMPLETE' ? 'INCOMPLETE (secrets)' : branchWhy ? 'FAIL (branch)' : null;
  const after = secretsAfter || verdict;
  if (stageN !== null && commit !== null) recordStageCommit(root, stageN, stages[stageN - 1].title, commit);
  if (stageN !== null && plainPass(after)) {
    try {
      const snap = takeSnapshot();
      if (snap) updateGate({ stageSnapshot: snap });
    } catch {
      // --since stage then falls back to the start snapshot
    }
  }

  const lines = [...verifyLines];
  const project = projectStep(root);
  lines.push(project.line);
  // keep a valid handoff a builder wrote after start (not one an earlier finish wrote: that one has a stale verdict)
  const file = join(root, '.jefe', 'handoff.md');
  let handoff = { status: 'not required' };
  let written = false;
  let prev = null;
  let keep = false;
  try {
    prev = readRegular(file, 256 * 1024);
    const fresh = prev !== null && startedAt && statSync(file).mtimeMs >= Date.parse(startedAt);
    if (fresh && !prev.includes(HANDOFF_MARK)) keep = handoffStep(root).ok;
  } catch {
    keep = false;
  }
  if (keep) handoff = handoffStep(root);
  else {
    const lessonLine = prev === null ? null : (prev.split('\n').find((l) => /^Lesson:/.test(l)) || null);
    const gi = gitInfo(root);
    const text = buildHandoff({ root, goal, notes, verdict: after, effective: planWord, vlines: verifyLines, vdata: v.data, lesson: lessonLine ? oneLine(lessonLine, 300) : null, files: changed, cmds, level: currentLevel(), gitText: gi ? `git: branch ${gi.branch}, last commit ${gi.sha}` : null, goalFile: existsSync(join(root, '.jefe', 'goal.md')), stages, sinceLabel: sinceKind === 'stage' ? 'changed this stage' : 'changed since start' });
    const werr = writeHandoff(root, text);
    if (werr) handoff = { line: `handoff: FAIL ${safe(werr.slice(0, 300))}`, ok: false, status: 'FAIL', reason: werr };
    else {
      handoff = handoffStep(root, ' (written by finish)');
      written = handoff.ok;
    }
  }
  lines.push(handoff.line);
  let gate = after;
  let code = secretsAfter ? (commitNotes.secrets === 'INCOMPLETE' ? 4 : 1) : v.code;
  if (code === 0 && !handoff.ok) {
    gate = `INCOMPLETE (handoff ${handoff.status === 'MISSING' ? 'missing' : 'invalid'})`;
    code = 4;
  }
  if (stageN !== null && !plainPass(gate) && stages[stageN - 1].done) {
    // the stage does not pass now: it is open again, whether this finish ticked it on the verify result or an earlier finish did (a failing
    // re-finish in a fix round), so the job cannot end until it passes again
    stages[stageN - 1] = { ...stages[stageN - 1], done: false, pass: null };
    writePlan(root, stages);
  }
  if (stageN !== null && plainPass(gate)) {
    for (const c of writeStageChecks(root, stageN, cmds.filter((c) => c.length))) lines.push(`check: not kept for later stages (not approved at Go): ${safe(c.join(' '))}`);
  }
  // the job's approved command kinds end with the job: no plan, or the last stage passed (--review pending: the reviewers still run)
  // ONE definition of "the job ends": no stage is open after this finish, apart from the stage this very finish ran for (a failed last
  // stage still closes with its report). Out of order, `--stage 3` with stage 2 open is not the end; a plain job in a folder holding a
  // finished plan.md is. It is exactly the opposite of verify's stage-only run (stageOnlyRun), so an ending finish always ran the full suite.
  const jobEnds = stageN === null ? !stages.some((st) => !st.done) : !stageOnlyRun(stages, stageN);
  // with --review pending the approvals instead get a short ending window (once this ending finish has run, a crashed session cannot leave them on for the usual 12 h; before it, they stay until they expire)
  let ended = false;
  let endFailed = null; // the approvals could not be ended: they stay on until they expire (deactivate's `failed`)
  let notEnded = null; // the approvals file is ignored and was left as it is (deactivate's `refused`)
  let shortenFailed = null; // the idle window could not be set: the approvals keep their old expiry (markEnding's `failed`)
  let ending = null;
  // a job that may push keeps its approvals for the short ending window too: the push is its own call after this finish (jefe-gate push ends them)
  const mayPush = (activeKinds(root, readState(root)) || []).some((k) => k.name === 'git-push');
  // ONE definition of "this finish passed", for the approvals, the recorded report and the secrets baseline alike: every PASS gate line, the
  // untested ones too ("PASS (no tests found, no checks given)", "PASS (tests not run, no checks given)") and "PASS (tests not run)"; FAIL and INCOMPLETE are not
  const passed = /^PASS\b/.test(gate);
  if (passed && jobEnds) {
    if (review !== 'pending' && !mayPush) {
      const d = deactivate(root, 'finished');
      if (d.refused) notEnded = d.refused;
      else if (d.was && d.failed) endFailed = d.failed;
      else ended = d.was;
      dropChecks(root); // the job is finished: its recorded checks end with its approvals
    } else ending = markEnding(root, { session: SESSION }); // the checks stay: a fix round after a reviewer's gap re-finishes this stage; they end when the approvals do
    if (ending && ending.failed) {
      shortenFailed = ending.failed;
      ending = null;
    }
  }
  let logged = false;
  if (isDir(join(root, '.jefe'))) {
    const entry = `${new Date().toISOString()} | ${planWord} | ${oneLine(gate, 80).replace(/\|/g, '/')} | ${oneLine(goal || 'not given', 200).replace(/\|/g, '/')}`;
    const lerr = appendLog(root, entry);
    lines.push(lerr ? `log: FAIL ${safe(lerr)}` : 'log: .jefe/log.md');
    logged = !lerr;
  }
  let stageLine = null;
  if (stageN !== null) {
    const total = stages.length;
    if (plainPass(gate)) {
      const next = firstUnfinished(stages);
      stageLine = `stage: ${stageN}/${total} done; ${next ? `next: ${next.n} ${next.title}` : 'all stages done'}`;
    } else stageLine = `stage: ${stageN}/${total} NOT done`;
    lines.push(stageLine);
  }
  lines.push(...commitNotes);
  if (commit !== null) lines.push(commit);
  const cost = cmdCost();
  lines.push(...cost.lines);
  const ran = ranLine(resolveModels(root).models);
  if (jobEnds) lines.push(ran.line);
  const ctxNow = cmdContext();
  if (ctxNow.data.status === 'over') lines.push(...ctxNow.lines);
  // the plan-usage guard, the same line `start` prints under the same conditions (`-> park` tells the planner to park mid-job)
  const usageNow = usageOfRun();
  const guardNow = effectiveLevel(resolveNow({ honourRun: true }), usageNow).state;
  if (usageNow || guardNow === 'off' || guardNow === 'downshift' || guardNow === 'park') lines.push(usageLineOf(usageNow, guardNow, headless(readRun())));
  if (review === 'pending') lines.push('review: pending (reviewer result decides)');
  if (notEnded) lines.push(...notEndedLines(notEnded));
  else if (endFailed) lines.push(endFailedLine(endFailed));
  else if (ended) lines.push('allowed: ended (job finished)');
  if (shortenFailed) lines.push(shortenFailedLine(shortenFailed));
  if (ending) {
    lines.push(`allowed: ${safe(ending.names.join(', '))} stay on for ${review === 'pending' ? 'the reviewers' : 'the push'} until ${stampOf(ending.until)} (allow --clear ends them)`);
  }
  lines.push(`gate: ${gate}`);
  const { gate: _g, ...vdata } = v.data;
  // the ending finish (a job, or the last stage) closes with the fixed `report:` block (lib/gate/report.mjs)
  const projectCommit = jobEnds && stages.length ? projectCommitLine(root, stages, commit, (gitInfo(root) || {}).branch) : null;
  let report = null;
  if (jobEnds) {
    let detected = null;
    try {
      detected = detectTests(root);
    } catch {
      // no test command to name
    }
    // the command to run yourself: the project's own test command when it really has one, else the check approved at Go that passed
    const goCheck = (v.data.checks || []).find((c) => c.approved && c.status === 'PASS');
    report = withReport(lines, { commit: projectCommit, review, testCmd: testLabel(detected), checkCmd: goCheck ? goCheck.command : null, leftOut: commitNotes.leftOut || 0 });
    // only a PASS arms the Stop hook (and lets `push` run): after a FAIL the planner starts a fix and ends its turn, and that interim message must not use up the one check
    if (passed) {
      recordReport(root, { gate: report.gate, review, paste: report.paste, ...testedState(root) });
      markBaselineEnded(root); // the next start begins a new job (a fix round's re-finish still uses this baseline)
    } else clearReportFile(root);
  }
  return {
    lines: report ? report.lines : lines,
    data: { ...vdata, ...(endFailed || shortenFailed ? { allowedFailed: (endFailed || shortenFailed).file } : {}), ...(notEnded ? { allowedRefused: notEnded.file } : {}), plan: planWord, stage: stageN === null ? null : { n: stageN, total: stages.length, done: plainPass(gate) }, project: project.data, handoff: { required: true, writtenByFinish: written, ...Object.fromEntries(Object.entries(handoff).filter(([k]) => k !== 'line' && k !== 'ok')) }, log: logged, commit, review: review === 'pending' ? 'pending' : null, cost: cost.data, models: ran.data, gate: gate.split(' ')[0], gateLine: gate },
    // approvals that could not be ended make the command fail as allow --clear, park and start do; the gate line itself is unchanged
    code: (endFailed || shortenFailed || notEnded) && code === 0 ? 1 : code,
  };
}
