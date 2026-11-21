// all and verify: size, secrets, tests, then each extra check, then one gate: line.
import { unlinkSync } from 'node:fs';
import { checksFile, identityOf, readJson, realOf, sameIdentity } from '../../hooks/approvals-state.mjs';
import { activeKinds, DEFAULT_KINDS, matchKind, readState } from '../../hooks/permit-core.mjs';
import { PLAN_REL, readPlan } from '../../hooks/plan.mjs';
import { safe, writePrivate } from '../../hooks/projects.mjs';
import { optValue } from './args.mjs';
import { ORIG_CWD, pastDeadline, remainingMs, shared } from './env.mjs';
import { clearGitCaches } from './git.mjs';
import { cmdSecrets } from './secrets.mjs';
import { cmdSize } from './size.mjs';
import { cleanLines, goTestText, parseRun } from '../../hooks/summarize.mjs';
import { cmdTests, detectSuites, detectTests, goJsonFilter, goResult, goTestCheck, runReport, runSuite, runWithTimeout, UNTESTED } from './tests.mjs';

export const NO_STAGES = 'gate: bad --stage value: no stages planned (start a staged job with go --stage)';

// The reason a check whose recognised report is go test's plain text is not a check that passed.
const GO_TEXT = "go test's text does not say that a test ran: give the go test command itself as the check";
// The gate line when nothing was tested at all: tests that do not exist and tests that exist but were not approved at Go are different facts.
const untestedGate = (status) => (status === 'NOT_APPROVED' ? 'PASS (tests not run, no checks given)' : 'PASS (no tests found, no checks given)');
// The gate line when the checks approved at Go passed but the project's test suite was not approved at Go: a pass in every way but its words.
export const TESTS_NOT_RUN = 'PASS (tests not run)';
// Does a gate verdict (the line without `gate: `) count as a plain PASS (ticks a stage, may commit and push)? The untested `PASS (` lines do not.
export const plainPass = (v) => v === 'PASS' || v === TESTS_NOT_RUN;

// ---------- all ----------

// The --since option (own options only, never a verify command's arguments) as the argument list cmdSize reads.
const sinceArgs = (own) => {
  const v = optValue(own, '--since');
  return v === null ? [] : ['--since', v];
};

export async function cmdAll(args, opts = {}) {
  const size = cmdSize(sinceArgs(args));
  const secrets = cmdSecrets([], { job: true });
  let tests;
  if (args.includes('--no-tests')) {
    tests = { lines: ['tests: not run (no consent)'], data: { status: 'NOT_RUN' }, code: 0 };
  } else if (opts.stageOnly) {
    tests = { lines: ['tests: full suite runs at the last stage (stage checks only)'], data: { status: 'STAGE_ONLY' }, code: 0 };
  } else if (pastDeadline()) {
    tests = { lines: ['tests: SKIPPED (deadline)'], data: { status: 'SKIPPED', deadline: true }, code: 0 };
  } else {
    tests = await cmdTests(args);
    clearGitCaches(); // the project's own code just ran and may have changed the git configuration: every later gate git call reads it fresh
  }
  const deadline = Boolean(secrets.data.deadline || tests.data.deadline || pastDeadline());
  const failed = secrets.code === 1 || (tests.code !== 0 && !tests.data.deadline);
  const noConsent = args.includes('--no-tests');
  // a detected suite whose program is missing did not run: never a plain PASS
  const toolMissing = tests.data.missing ? `tests not run: ${tests.data.missing} not found` : null;
  const missing = !failed ? (deadline ? 'deadline' : secrets.code === 4 ? 'secrets' : noConsent ? 'tests not run: no consent' : toolMissing) : null;
  const gate = failed ? 'FAIL' : missing ? `INCOMPLETE (${missing})` : 'PASS';
  // nothing was tested at all: say so on the gate line itself
  const untested = gate === 'PASS' && UNTESTED.has(tests.data.status);
  return {
    lines: [...size.lines, ...secrets.lines, ...tests.lines, `gate: ${untested ? untestedGate(tests.data.status) : gate}`],
    data: { size: size.data, secrets: secrets.data, tests: tests.data, gate: gate.split(' ')[0], ...(missing ? { incomplete: missing } : {}), ...(untested ? { tested: false } : {}) },
    code: failed ? 1 : missing ? 4 : 0,
  };
}

// ---------- verify ----------

const SHELL_HINT = 'hint: checks are run without a shell: use a program and arguments';

// A command that could not start and reads like shell syntax: && | ; > , a leading VAR=value, or cd.
function looksLikeShell(c) {
  return c.some((a) => /&&|\||;|>/.test(a)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(c[0] || '') || c[0] === 'cd';
}

// ---- stage checks: the checks each passed stage ran, kept in the registry (<registry>/run/<key>.checks.json, outside the project: a command
// read from a file a repository can ship would be code the repository chose) so a later stage re-runs them (regression). The file holds the
// folder identity it was recorded for ({ identity, checks: { "<stage>": [argv] } }); on read, a file of another folder is ignored and removed. ----
const stageChecksPath = checksFile;

function readStageChecks(root) {
  try {
    const j = readJson(stageChecksPath(root));
    if (!j) return {};
    if (!sameIdentity(j, realOf(root))) {
      try {
        unlinkSync(stageChecksPath(root));
      } catch {
        // already gone
      }
      return {};
    }
    const out = {};
    for (const [k, v] of Object.entries(j.checks && typeof j.checks === 'object' && !Array.isArray(j.checks) ? j.checks : {})) {
      if (Array.isArray(v)) out[k] = v.filter((c) => Array.isArray(c) && c.length && c.every((t) => typeof t === 'string'));
    }
    return out;
  } catch {
    return {};
  }
}

// THE rule for stage checks, at record time and at re-run time: a check counts only if it matches the job's ACTIVE kinds right now; with no active
// job (nothing approved at Go, a headless run) the default test kinds. A check that passed only because the user approved a one-off prompt is not
// kept, and a recorded check whose approval has ended is not re-run. The hook uses the same rule (hooks/permit-core.mjs gateCallOk).
const checkKinds = (root) => activeKinds(root, readState(root)) || DEFAULT_KINDS;
const approvedNow = (kinds, root, c) => matchKind(kinds, c, root, process.cwd()) !== null;

// -> the checks that were NOT kept
export function writeStageChecks(root, n, cmds) {
  const kindsNow = checkKinds(root);
  const kept = cmds.filter((c) => approvedNow(kindsNow, root, c));
  try {
    const cur = readStageChecks(root);
    cur[String(n)] = kept;
    writePrivate(stageChecksPath(root), JSON.stringify({ identity: identityOf(realOf(root)), checks: cur }, null, 2) + '\n', { guardDir: true });
  } catch {
    // the next stage then has no regression list for this one
  }
  return cmds.filter((c) => !kept.includes(c));
}

// amend renumbered the plan: newOf(old stage number) -> its new number, or null for a dropped stage. The recorded checks move with their stage.
export function renumberStageChecks(root, newOf) {
  try {
    const cur = readStageChecks(root);
    if (!Object.keys(cur).length) return;
    const out = {};
    for (const [k, v] of Object.entries(cur)) {
      const n = newOf(Number(k));
      if (n) out[String(n)] = v;
    }
    writePrivate(stageChecksPath(root), JSON.stringify({ identity: identityOf(realOf(root)), checks: out }, null, 2) + '\n', { guardDir: true });
  } catch {
    // the later stages then have no regression list for the moved stages
  }
}

// A given check identical to a discovered test suite is that suite: it runs once, and is read by the suite's rules (a suite that ran no test
// stays `none found`, never a plain check that exited 0). -> { suite, data } (data: the suite's result in this run, or null when the suite did not
// run here: a stage-only run, or the tests kind not approved at Go), or null when no suite matches
const suiteKey = (cmd, args) => [cmd === process.execPath ? 'node' : cmd, ...args.filter((a) => a !== '--silent' && a !== '-q')].join('\u0000');
function sameAsSuite(c, cwd, tests) {
  try {
    // a suite run in a nested folder (a nested Go module) is not the same as a check run from the project root
    const suites = detectSuites(cwd);
    const i = suites.findIndex((d) => !d.dir && suiteKey(c[0], c.slice(1)) === suiteKey(d.cmd, d.args));
    if (i === -1) return null;
    const data = tests.status === 'STAGE_ONLY' || tests.status === 'NOT_APPROVED' ? null : tests.suites ? tests.suites[i] || null : tests;
    return { suite: suites[i], data };
  } catch {
    return null;
  }
}

// Does the project have a test suite? (NOT_APPROVED is reported before detection, so it alone does not say one exists.)
function hasSuite(cwd) {
  try {
    return !!detectTests(cwd);
  } catch {
    return false;
  }
}

// ONE definition of a stage-only run (stage checks, no full suite): a --stage run while some OTHER stage of the plan is still open. Whatever stage
// number it was called with, a run after which every stage would be done ends the job, so it runs the full suite; finish uses the same rule for
// "the job ends" (the approvals, the report record a push needs).
export const stageOnlyRun = (plan, stageN) => stageN !== null && plan.some((st) => !st.done && st.n !== stageN);

// opts.allRecorded: also run the recorded checks of every ticked stage when no --stage is given (finish does; verify without --stage does not).
export async function cmdVerify(args, opts = {}) {
  const cmds = [];
  let cur = null;
  const own = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
  for (const a of args) {
    if (a === '--') {
      cur = [];
      cmds.push(cur);
    } else if (cur) cur.push(a);
  }
  const root = shared.root || process.cwd();
  const stagePlan = readPlan(root);
  const stageArg = optValue(own, '--stage');
  let stageN = null;
  if (stageArg !== null) {
    stageN = /^\d+$/.test(stageArg) ? Number(stageArg) : 0;
    if (!stagePlan[stageN - 1]) return { lines: [stagePlan.length ? `gate: bad --stage value (${PLAN_REL} has ${stagePlan.length} stages)` : NO_STAGES], data: { gate: 'ERROR' }, code: 2 };
  }
  const stageOnly = stageOnlyRun(stagePlan, stageN);
  const given = cmds.filter((c) => c.length);
  const recorded = readStageChecks(root);
  const regression = [];
  const notRun = [];
  const kindsNow = checkKinds(root);
  const goKinds = activeKinds(root, readState(root)); // null: no active job, so no check was approved at Go
  if (stageN !== null || opts.allRecorded) {
    const have = new Set(given.map((c) => JSON.stringify(c)));
    for (const st of stagePlan) {
      // a stage-only run re-runs the kept checks of the OTHER done stages; any other run (one that ends the job, a finish without --stage)
      // re-runs the kept checks of EVERY stage that has any, its own and one a failing re-finish opened again included
      if (stageOnly && (!st.done || st.n === stageN)) continue;
      for (const c of recorded[String(st.n)] || []) {
        const k = JSON.stringify(c);
        if (!have.has(k)) {
          have.add(k);
          if (approvedNow(kindsNow, root, c)) regression.push(c);
          else notRun.push(c);
        }
      }
    }
  }
  cmds.push(...regression);
  const all = await cmdAll(own, { stageOnly });
  const lines = all.lines.slice(0, -1);
  const { tested: _t, ...allData } = all.data;
  let pass = all.code === 0 || all.code === 4;
  let incomplete = all.code === 4 ? all.data.incomplete : null;
  const checks = [];
  const noneGiven = new Set(); // checks that ran no test: identical to a test suite that ran none, or a test runner that reported 0 passed and 0 failed
  for (const c of cmds) {
    if (!c.length) continue;
    const label = safe(c.join(' '));
    if (own.includes('--no-tests')) {
      lines.push(`check: SKIPPED (${label})`);
      checks.push({ command: label, status: 'SKIPPED', exit: null });
      continue;
    }
    if (pastDeadline()) {
      lines.push(`check: SKIPPED (${label}, deadline)`);
      checks.push({ command: label, status: 'SKIPPED', exit: null });
      incomplete = 'deadline';
      continue;
    }
    const same = all.data.tests ? sameAsSuite(c, process.cwd(), all.data.tests) : null;
    let suite = same && same.data;
    let more = [];
    if (same && !suite) {
      // the suite did not run in this run: it runs now, as the suite
      const s = await runSuite(same.suite, process.cwd(), Math.min(120, remainingMs() / 1000), true);
      clearGitCaches();
      suite = s.data.status === 'MISSING' ? null : s.data; // a missing program: the plain run below says it could not start, as before
      more = s.lines.slice(1);
    }
    if (suite && (['PASS', 'FAIL', 'NONE'].includes(suite.status) || !same.data)) {
      const st = suite.deadline ? 'INCOMPLETE' : ['PASS', 'NONE'].includes(suite.status) ? suite.status : 'FAIL';
      const how = same.data ? 'same as the test suite above: ran once' : `the project's test command${suite.counts ? `, ${suite.counts}` : ''}`;
      lines.push(st === 'NONE' ? `check: none found (${label}, the project's test command${suite.why ? `: ${suite.why}` : ''})` : `check: ${st} (${label}, ${how})`, ...(st === 'FAIL' ? more : []));
      // a check served by a suite that ran no test is not a check that passed: it does not stand for "checks given"
      checks.push({ command: label, status: st, exit: st === 'PASS' ? 0 : st === 'FAIL' ? 1 : null, sameAsSuite: true });
      if (st === 'NONE') noneGiven.add(c);
      if (st === 'FAIL') pass = false;
      if (st === 'INCOMPLETE') incomplete = 'deadline';
      continue;
    }
    const left = remainingMs() / 1000;
    // a go test check runs as the Go suite does: its -json events decide, read by the same code
    const goArgv = goTestCheck(c);
    const go = goArgv ? goJsonFilter() : null;
    const ran = await runWithTimeout(goArgv ? goArgv[0] : c[0], (goArgv || c).slice(1), process.cwd(), Math.min(120, left), go ? { stdout: go } : {});
    clearGitCaches(); // as after the tests: the check ran the project's own code
    const gr = go ? goResult(go, ran) : null;
    // what the output of a check that exited 0 says, when it is a test runner's report (the first runner recognised in it decides) or holds go
    // test's own text (also behind a line prefix)
    const out = !gr && ran.status === 'PASS' ? cleanLines(ran.full) : null;
    const text = out ? parseRun(out) : null;
    const goText = out ? goTestText(out) : null;
    // a failed test in a recognised report, or a failure in go test's text (a failed test, a panic, a build or vet error), with exit 0 (a wrapper
    // that ignores the runner's exit code: `-go test` in a Makefile, `|| true`) is a FAIL, as a go test check with a failed test event is
    const r = gr ? gr.r : out && ((text.counts && text.counts.failed) || goText.failed) ? { ...ran, status: 'FAIL' } : ran;
    const ok = r.status === 'PASS';
    let head;
    if (r.status === 'TIMEOUT' && left < 120) {
      lines.push(`check: INCOMPLETE (${label}, stopped at the deadline after ${r.seconds}s)`);
      checks.push({ command: label, status: 'INCOMPLETE', exit: null });
      incomplete = 'deadline';
      continue;
    }
    const rep = runReport('check', label, r, gr ? { counts: gr.counts } : {});
    const atGo = goKinds !== null && approvedNow(goKinds, root, c);
    // exit 0 with a test runner's report of 0 passed and 0 failed (only skipped tests, no test at all) tested nothing: not a check that passed,
    // read as a same-as-suite check that ran no test (it does not stand for "checks given"). Output that merely looks like such a report errs the
    // same way, never toward a pass. go test's own text (a go test reached through make, sh -c, a script), also behind a line prefix, is never a pass
    // either: it says ok, and with -v --- PASS for a parent test, also when every test or subtest was skipped, and with no test file it prints a
    // [no test files] line or only a coverage line. Only another runner's report of a passed test makes such output a pass. Given as the check
    // itself, go test is read by its events (goTestCheck above).
    const otherRan = text && text.runner && text.runner !== 'go' && text.counts && text.counts.passed > 0;
    // goText.seen, not parseRun's go entry: that one is loose enough to take another tool's `ok ...` line (deno's summary, bats) for a package line
    const goSeen = out && !otherRan && goText.seen;
    const none = !ok ? null : goSeen ? GO_TEXT : rep.passed === 0 && !rep.failed ? 'ran no test' : null;
    if (none) {
      lines.push(`check: none found (${label}, ${none})`);
      checks.push({ command: label, status: 'NONE', exit: 0, ...(atGo ? { approved: true } : {}), ...(regression.includes(c) ? { regression: true } : {}) });
      noneGiven.add(c);
      continue;
    }
    if (ok) head = `check: PASS (${label}, ${atGo ? 'approved at Go, ' : ''}${rep.counts ? rep.counts + ', ' : ''}exit 0)`;
    else if (r.status === 'TIMEOUT') head = `check: FAIL (${label}, timed out after 120s)`;
    else if (r.code === null) head = `check: FAIL (${label}, could not start)`;
    else head = `check: FAIL (${label}, ${r.code === 0 && rep.counts ? rep.counts + ', ' : ''}exit ${r.code})`; // exit 0: a go test check with a failed test event
    lines.push(head);
    if (!ok) lines.push(...rep.lines);
    if (r.code === null && r.status === 'FAIL' && looksLikeShell(c)) lines.push(SHELL_HINT);
    checks.push({ command: label, status: ok ? 'PASS' : 'FAIL', exit: r.code, ...(atGo ? { approved: true } : {}), ...(regression.includes(c) ? { regression: true } : {}) });
    if (!ok) pass = false;
  }
  // the checks ran from the project root: when the call came from another folder, say so next to a failure (a relative path in a check means the root's)
  if (checks.some((c) => c.status === 'FAIL') && ORIG_CWD !== realOf(root)) lines.push(`hint: checks run from the project root ${safe(realOf(root))}, not from ${safe(ORIG_CWD)}`);
  for (const c of notRun) lines.push(`check: not run (approval ended): ${safe(c.join(' '))}`);
  if (stageOnly && given.every((c) => noneGiven.has(c)) && pass && !incomplete) incomplete = 'no checks given for this stage';
  let gate = !pass ? 'FAIL' : incomplete ? `INCOMPLETE (${incomplete})` : 'PASS';
  // nothing was tested at all: say so on the gate line itself
  const untested = gate === 'PASS' && all.data.tests && UNTESTED.has(all.data.tests.status) && checks.every((c) => c.status === 'NONE');
  // something passed, but the project's test suite was not approved at Go: say so on the gate line, so the last line alone does not read as tested
  const suiteSkipped = gate === 'PASS' && !untested && all.data.tests && all.data.tests.status === 'NOT_APPROVED' && checks.some((c) => c.status === 'PASS') && hasSuite(process.cwd());
  lines.push(`gate: ${untested ? untestedGate(all.data.tests.status) : suiteSkipped ? TESTS_NOT_RUN : gate}`);
  return { lines, data: { ...allData, checks, gate: gate.split(' ')[0], ...(untested ? { tested: false } : {}) }, code: !pass ? 1 : incomplete ? 4 : 0 };
}
