// The stage gate: finish/verify --stage <n> on a non-last stage runs only stage checks (given + earlier ticked stages'), not the full suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync } from 'node:fs';

const checksPath = (d) => allowFile(d).replace(/\.allow\.json$/, '.checks.json');
import { join } from 'node:path';
import { allowFile, gate, readAllow, repo, write } from './fixtures/gate/helpers.mjs';

const lines = (r) => r.out.trim().split('\n');
const last = (r) => lines(r)[lines(r).length - 1];
const env = () => ({ JEFE_MODE: 'headless' });
// `node -e` is refused as an --allow-cmd (the permit rules), so the always-passing check is a plain script (staged() writes it)
const PASS = ['node', 'pass.js'];

// a project whose full suite fails (starter tests for later parts), with a 3-stage plan
function staged() {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }), 'pass.js': '\n' });
  const e = env();
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'node pass.js', '--allow-cmd', 'node chk.cjs', '--allow-kind', 'tests', '--stage', 'one :: a', '--stage', 'two :: b', '--stage', 'three :: c'], d, e);
  gate(['start'], d, e);
  return { d, e };
}

test('non-last stage: the failing full suite is NOT run; stage checks only; the stage passes and is ticked', () => {
  const { d, e } = staged();
  const r = gate(['finish', '--stage', '1', '--', ...PASS], d, e);
  assert.match(r.out, /^tests: full suite runs at the last stage \(stage checks only\)$/m, r.out);
  assert.ok(!/^tests: FAIL/m.test(r.out));
  assert.match(r.out, /^check: PASS \(node pass.js, approved at Go, exit 0\)$/m);
  assert.match(r.out, /^stage: 1\/3 done; next: 2 two$/m);
  assert.equal(last(r), 'gate: PASS');
  assert.match(readFileSync(join(d, '.jefe/plan.md'), 'utf8'), /1\. \[x\] one/);
  assert.deepEqual(JSON.parse(readFileSync(checksPath(d), 'utf8')).checks, { 1: [PASS] });
});

test('a non-last stage with no checks given cannot pass', () => {
  const { d, e } = staged();
  const r = gate(['finish', '--stage', '1'], d, e);
  assert.equal(last(r), 'gate: INCOMPLETE (no checks given for this stage)');
  assert.equal(r.code, 4);
  assert.match(r.out, /^stage: 1\/3 NOT done$/m);
  assert.match(readFileSync(join(d, '.jefe/plan.md'), 'utf8'), /1\. \[ \] one/);
});

test('a failing stage check fails the stage', () => {
  const { d, e } = staged();
  const r = gate(['finish', '--stage', '1', '--', 'node', '-e', 'process.exit(3)'], d, e);
  assert.equal(last(r), 'gate: FAIL');
  assert.match(r.out, /^stage: 1\/3 NOT done$/m);
});

test('a later stage re-runs the recorded checks of the earlier ticked stages (regression)', () => {
  const { d, e } = staged();
  write(d, 'chk.cjs', 'process.exit(0);\n');
  assert.equal(last(gate(['finish', '--stage', '1', '--', 'node', 'chk.cjs'], d, e)), 'gate: PASS');
  const ok = gate(['finish', '--stage', '2', '--', ...PASS], d, e);
  assert.match(ok.out, /^check: PASS \(node pass.js, approved at Go, exit 0\)$/m);
  assert.match(ok.out, /^check: PASS \(node chk\.cjs, approved at Go, exit 0\)$/m, ok.out);
  assert.equal(last(ok), 'gate: PASS');
  // stage 1's check breaks: stage 3's checks pass, but the regression fails it (and the full suite also runs: last stage)
  renameSync(join(d, 'chk.cjs'), join(d, 'chk.gone.cjs'));
  write(d, 'chk.cjs', 'process.exit(1);\n');
  const bad = gate(['finish', '--stage', '3', '--', ...PASS], d, e);
  assert.match(bad.out, /^check: FAIL \(node chk\.cjs, exit 1\)$/m, bad.out);
  assert.equal(last(bad), 'gate: FAIL');
});

test('the last stage (and finish without --stage) runs the full discovered suite plus recorded and own checks', () => {
  const { d, e } = staged();
  gate(['finish', '--stage', '1', '--', ...PASS], d, e);
  gate(['finish', '--stage', '2', '--', ...PASS], d, e);
  const r = gate(['finish', '--stage', '3', '--', 'node', '-e', '1'], d, e);
  assert.match(r.out, /^tests: FAIL \(npm test/m, r.out);
  assert.ok(!/full suite runs at the last stage/.test(r.out));
  assert.equal(last(r), 'gate: FAIL');
  assert.match(gate(['finish', '--', ...PASS], d, e).out, /^tests: FAIL/m);
});

test('verify --stage: the same semantics, and it never ticks a stage, commits or writes the handoff', () => {
  const { d, e } = staged();
  const v = gate(['verify', '--stage', '1', '--since', 'stage', '--', ...PASS], d, e);
  assert.match(v.out, /^tests: full suite runs at the last stage \(stage checks only\)$/m, v.out);
  assert.equal(last(v), 'gate: PASS');
  assert.match(readFileSync(join(d, '.jefe/plan.md'), 'utf8'), /1\. \[ \] one/);
  assert.ok(!existsSync(checksPath(d)));
  assert.ok(!existsSync(join(d, '.jefe/handoff.md')));
  assert.equal(last(gate(['verify', '--stage', '1'], d, e)), 'gate: INCOMPLETE (no checks given for this stage)');
  // stage 3 is the last number but stages 1 and 2 are open: it would not end the job, so it is stage checks only too
  assert.match(gate(['verify', '--stage', '3', '--', ...PASS], d, e).out, /^tests: full suite runs at the last stage \(stage checks only\)$/m);
  assert.match(gate(['verify', '--', ...PASS], d, e).out, /^tests: FAIL/m);
  assert.equal(gate(['verify', '--stage', '9', '--', ...PASS], d, e).code, 2);
});

test('a check identical to the discovered test command runs once', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').appendFileSync(\'runs.txt\',\'x\')"' } }) });
  const e = env();
  const r = gate(['verify', '--', 'npm', 'test'], d, e);
  assert.equal(readFileSync(join(d, 'runs.txt'), 'utf8'), 'x', r.out);
  assert.match(r.out, /^tests: PASS/m);
  assert.match(r.out, /^check: PASS \(npm test, same as the test suite above: ran once\)$/m);
  assert.equal(last(r), 'gate: PASS');
  // a different check still runs
  assert.equal(readFileSync(join(d, 'runs.txt'), 'utf8').length, 1);
});

test('without a plan, finish and verify behave as before (full suite, given checks)', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }) });
  const r = gate(['verify', '--', ...PASS], d, env());
  assert.match(r.out, /^tests: FAIL/m);
  assert.equal(last(r), 'gate: FAIL');
});

// ---- a finish that ends the job runs the full suite whatever stage number it names; a stage-only finish never ends the job ----
const reportPath = (d) => allowFile(d).replace(/\.allow\.json$/, '.report.json');
const OK_TEST = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const BAD_TEST = "import { test } from 'node:test';\ntest('bad', () => { throw new Error('boom'); });\n";
// a project whose full suite passes, with a 2-stage plan
function stagedOk() {
  const d = repo({ 'a.test.mjs': OK_TEST, 'pass.js': '\n' });
  const e = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'node pass.js', '--allow-kind', 'tests', '--stage', 'one :: a', '--stage', 'two :: b'], d, e).code, 0);
  return { d, e };
}

test('stages finished out of order: the second-numbered stage first is stage checks only; the finish that closes the last open stage runs the full suite', () => {
  const { d, e } = stagedOk();
  const two = gate(['finish', '--stage', '2', '--', ...PASS], d, e);
  assert.match(two.out, /^tests: full suite runs at the last stage \(stage checks only\)$/m, two.out);
  assert.match(two.out, /^stage: 2\/2 done; next: 1 one$/m);
  assert.doesNotMatch(two.out, /^allowed: ended/m);
  assert.equal(readAllow(d).active, true);
  assert.ok(!existsSync(reportPath(d)), 'a stage-only finish writes no report record');
  const one = gate(['finish', '--stage', '1', '--', ...PASS], d, e);
  assert.match(one.out, /^tests: PASS \(node --test \(1 file\), 1 passed/m, one.out);
  assert.match(one.out, /^stage: 1\/2 done; all stages done$/m);
  assert.match(one.out, /^allowed: ended \(job finished\)$/m);
  assert.equal(last(one), 'gate: PASS');
});

test('the reviewed case: stage 2 passes first, the suite then breaks, and finish --stage 1 (now the ending finish) runs it and fails; nothing ends', () => {
  const { d, e } = stagedOk();
  assert.equal(last(gate(['finish', '--stage', '2', '--', ...PASS], d, e)), 'gate: PASS');
  write(d, 'b.test.mjs', BAD_TEST);
  const r = gate(['finish', '--stage', '1', '--', ...PASS], d, e);
  assert.match(r.out, /^tests: FAIL \(node --test \(2 files\), 1 failed, 1 passed/m, r.out);
  assert.doesNotMatch(r.out, /full suite runs at the last stage/);
  assert.doesNotMatch(r.out, /^allowed: ended/m);
  assert.match(r.out, /^stage: 1\/2 NOT done$/m);
  assert.equal(last(r), 'gate: FAIL');
  assert.equal(readAllow(d).active, true, 'the approvals did not end');
  assert.ok(!existsSync(reportPath(d)), 'no report record a push could use');
  assert.equal(last(gate(['verify'], d, e)), 'gate: FAIL');
});

test('a done stage finished again in a fix round, with the suite now failing: the full suite runs, the finish fails, and the approvals stay', () => {
  const { d, e } = stagedOk();
  assert.equal(last(gate(['finish', '--stage', '1', '--', ...PASS], d, e)), 'gate: PASS');
  const end = gate(['finish', '--stage', '2', '--review', 'pending', '--', ...PASS], d, e);
  assert.equal(last(end), 'gate: PASS', end.out);
  assert.ok(existsSync(reportPath(d)));
  write(d, 'b.test.mjs', BAD_TEST);
  const again = gate(['finish', '--stage', '1', '--review', 'pending', '--', ...PASS], d, e);
  assert.match(again.out, /^tests: FAIL/m, again.out);
  assert.match(again.out, /^check: PASS \(node pass\.js, approved at Go, exit 0\)$/m);
  assert.doesNotMatch(again.out, /^allowed: /m);
  assert.equal(last(again), 'gate: FAIL');
  assert.equal(readAllow(d).active, true, 'the approvals did not end');
  assert.ok(!existsSync(reportPath(d)), 'the failing finish took the report record away');
});

test('a failing re-finish of a done stage opens it again: the plan shows it open, the job cannot end without it, and passing it again ends the job', () => {
  const d = repo({ 'a.test.mjs': OK_TEST, 'pass.js': '\n', 'chk.cjs': 'process.exit(0);\n' });
  const e = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'node pass.js', '--allow-cmd', 'node chk.cjs', '--allow-kind', 'tests', '--stage', 'one :: a', '--stage', 'two :: b', '--stage', 'three :: c'], d, e).code, 0);
  assert.equal(last(gate(['finish', '--stage', '1', '--', ...PASS], d, e)), 'gate: PASS');
  assert.equal(last(gate(['finish', '--stage', '2', '--', 'node', 'chk.cjs'], d, e)), 'gate: PASS');
  assert.equal(last(gate(['finish', '--stage', '3', '--review', 'pending', '--', ...PASS], d, e)), 'gate: PASS');
  const bad = gate(['finish', '--stage', '2', '--review', 'pending', '--', 'node', '-e', 'process.exit(1)'], d, e);
  assert.match(bad.out, /^stage: 2\/3 NOT done$/m, bad.out);
  assert.equal(last(bad), 'gate: FAIL');
  assert.match(readFileSync(join(d, '.jefe/plan.md'), 'utf8'), /^2\. \[ \] two \| done when: b$/m, 'the plan shows stage 2 open, with no old PASS date');
  // stage 3 finished again: stage 2 is open, so this is stage checks only and the job does not end
  const three = gate(['finish', '--stage', '3', '--review', 'pending', '--', ...PASS], d, e);
  assert.match(three.out, /^tests: full suite runs at the last stage \(stage checks only\)$/m, three.out);
  assert.match(three.out, /^stage: 3\/3 done; next: 2 two$/m);
  assert.doesNotMatch(three.out, /^report:/m);
  // stage 2 passes again: the ending finish runs the full suite and the kept checks of every stage, stage 2's own included
  const two = gate(['finish', '--stage', '2', '--review', 'pending', '--', ...PASS], d, e);
  assert.match(two.out, /^tests: PASS/m, two.out);
  assert.match(two.out, /^check: PASS \(node chk\.cjs, approved at Go, exit 0\)$/m, 'stage 2\'s kept check re-runs');
  assert.match(two.out, /^stage: 2\/3 done; all stages done$/m);
  assert.equal(last(two), 'gate: PASS');
});

test('amend --drop-stage moves the recorded checks of a later done stage with its new number; they still run as regression checks', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }), 'pass.js': '\n', 'chk.cjs': 'process.exit(0);\n' });
  const e = env();
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'node pass.js', '--allow-cmd', 'node chk.cjs', '--allow-kind', 'tests', '--stage', 'one :: a', '--stage', 'two :: b', '--stage', 'three :: c', '--stage', 'four :: e'], d, e);
  gate(['start'], d, e);
  assert.equal(last(gate(['finish', '--stage', '1', '--', ...PASS], d, e)), 'gate: PASS');
  assert.equal(last(gate(['finish', '--stage', '3', '--', 'node', 'chk.cjs'], d, e)), 'gate: PASS');
  assert.deepEqual(JSON.parse(readFileSync(checksPath(d), 'utf8')).checks, { 1: [PASS], 3: [['node', 'chk.cjs']] });
  assert.equal(gate(['amend', '--drop-stage', '2'], d, e).code, 0);
  assert.match(readFileSync(join(d, '.jefe/plan.md'), 'utf8'), /2\. \[x\] three/);
  assert.deepEqual(JSON.parse(readFileSync(checksPath(d), 'utf8')).checks, { 1: [PASS], 2: [['node', 'chk.cjs']] });
  // the moved check breaks: the next finish runs it as a regression check of stage 2 and fails
  renameSync(join(d, 'chk.cjs'), join(d, 'chk.gone.cjs'));
  write(d, 'chk.cjs', 'process.exit(1);\n');
  const bad = gate(['finish', '--stage', '3', '--', ...PASS], d, e);
  assert.match(bad.out, /^check: FAIL \(node chk\.cjs, exit 1\)$/m, bad.out);
  assert.equal(last(bad), 'gate: FAIL');
});
