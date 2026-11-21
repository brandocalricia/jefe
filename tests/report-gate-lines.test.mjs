// The Stop hook's message check (hooks/report-core.mjs decide): one correct gate line does not excuse a different one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide, gateLineOf, verdictOf } from '../hooks/report-core.mjs';
import { runKey } from '../hooks/runfile.mjs';
import { gate, repo, tmp } from './fixtures/gate/helpers.mjs';

const now = Date.now();
const rec = (g, paste = [g]) => ({ session: 's1', at: new Date(now).toISOString(), gate: g, review: null, paste, fired: false });
const run = (g, msg, paste) => decide(rec(g, paste), msg, { session: 's1', now });

test('a second, different gate line sends the planner back, naming both lines', () => {
  const back = run('gate: FAIL (tests)', 'gate: PASS\ngate: FAIL (tests)');
  assert.ok(back && back.includes('`gate: FAIL (tests)`') && back.includes('`gate: PASS`'), back);
  const back2 = run('gate: PASS (tests not run)', 'gate: PASS (tests not run)\n**gate: PASS**');
  assert.ok(back2 && back2.includes('`gate: PASS (tests not run)`') && back2.includes('`gate: PASS`'), back2);
  // a quoted earlier report counts too
  assert.notEqual(run('gate: PASS', 'gate: PASS\n> gate: FAIL (secrets)'), null);
  assert.notEqual(run('gate: PASS', '1. gate: PASS\n2. gate: FAIL'), null);
});

test('the same gate line twice, or with different marks, passes', () => {
  assert.equal(run('gate: PASS', 'gate: PASS\n\n**gate: PASS**.'), null);
  assert.equal(run('gate: PASS (tests not run)', '> gate: PASS (tests not run)\n- `gate: PASS (tests not run)`'), null);
});

test('gateLineOf: a line that starts with `gate: ` once marks are taken away', () => {
  assert.equal(gateLineOf('It said gate: PASS earlier'), null);
  assert.equal(gateLineOf('**gate: PASS**.'), 'gate: PASS');
  assert.equal(gateLineOf('3) gate: FAIL'), 'gate: FAIL');
});

// A verdict anywhere in a line counts (verdictOf): a false alarm only costs a resend, an accepted false verdict is the failure this hook exists for.
const T = 'gate: PASS (tests not run)';
test('a false verdict with words in front, in another case, without a space or with odd spaces is sent back, naming both', () => {
  for (const extra of ['**Result:** gate: PASS', '_gate: PASS_', 'Gate: PASS', 'GATE: PASS', 'gate : PASS', 'gate: PASS', 'gate: PASS', 'gate:PASS', '1) gate: PASS', 'Overall gate: fail', 'gate: INCOMPLETE (deadline)', 'gate​: PASS']) {
    const back = run(T, `${T}\n${extra}`);
    assert.ok(back && back.includes('`' + T + '`'), `${JSON.stringify(extra)} -> ${back}`);
  }
  const back = run(T, `${T}\n**Result:** gate: PASS`);
  assert.ok(back.includes('`Result: gate: PASS`'), back);
});

// Changed from the previous rule (the verdict text had to be equal): words after the same verdict are accepted unless they drop the record's qualifier.
test("a sentence that states the same verdict is accepted, words after it too; one that drops the record's qualifier is sent back", () => {
  assert.equal(run(T, 'It did not say gate: PASS (tests not run)'), null);
  assert.equal(run(T, `As printed, GATE: pass (tests not run).\n${T}`), null);
  assert.notEqual(run(T, `An older run printed gate: PASS here, not this one.\n${T}`), null);
  assert.equal(run('gate: PASS', 'gate: PASS\nthe gate: PASS was after a retry'), null);
});

test('words that only look alike are not verdicts', () => {
  assert.equal(run('gate: PASS', 'gate: PASS\nthe gateway: FAIL is unrelated\nnavigate: FAILED here\ngates: FAIL\ngate1: FAIL'), null);
  // changed: `passing` is a pass word of Part B, so with the record `gate: PASS` this states the same verdict (it was a false alarm)
  assert.equal(run('gate: PASS', 'gate: PASS\nthe gate: passing is fine'), null);
});

// A false "passed" claim beside the true qualified line (Part A anywhere, Part B at the start): every one is sent back, naming both lines.
// (Replaces the previous widening's PLAIN list, which also ran against the record `gate: FAIL`: no record exists for a FAIL.)
const SOFT = 'ga' + String.fromCharCode(0xad) + 'te: PASS';
const CLAIMS = [
  '**Gate:** ✅ PASS', '**Gate: PASSED**', 'Gate: ✅ PASS', 'Final gate: ✅ PASS', 'Gate result: PASS', 'Gate status: PASS', 'Gate: OK', 'Gate: green',
  'Gate — PASS', 'Gate—PASS', 'Gate→PASS', 'gate = PASS', 'gate： PASS', '- Gate: [PASS]', '## Gate: PASS', '> Gate result → passed', SOFT,
  'Summary: all good, gate: PASS', 'Result gate: ~~FAIL~~ PASS',
  // and the previous list's other spellings
  'gate - PASS', 'Gate: 🎉🎉 PASS!', 'gate check result: passed', 'gate ∶ PASS', 'gate=PASS', 'gate -> PASS', 'gate => PASS', 'Gate: ✓ PASS', 'Gate line: PASSES',
  // a list number is a list mark
  '1. Gate result: PASSED', '2) **Gate:** ✅ PASS', '- 3. Final gate → ok',
];
test('a claim of another verdict is sent back (record `gate: PASS (tests not run)`)', () => {
  for (const claim of CLAIMS) {
    for (const msg of [`All done.\n\n${claim}\n\n${T}`, `${T}\n${claim}`]) {
      const back = run(T, msg);
      assert.ok(back && back.includes('`' + T + '`') && back.includes('also `'), `${JSON.stringify(msg)} -> ${back}`);
    }
  }
});

test('a claim of another base is sent back (record `gate: PASS`)', () => {
  for (const claim of ['Gate: FAILED', 'Gate: ❌ FAIL', 'Sadly the gate: FAIL came back on the first run.', 'Gate status: incomplete']) {
    for (const msg of [`All done.\n\n${claim}\n\ngate: PASS`, `gate: PASS\n${claim}`]) {
      const back = run('gate: PASS', msg);
      assert.ok(back && back.includes('also `'), `${JSON.stringify(msg)} -> ${back}`);
    }
  }
});

test('the verdict shape: Part A anywhere, Part B at the start, the first match counts', () => {
  const v = (s) => verdictOf(s);
  assert.deepEqual(v('Gate: 🎉🎉 PASS!'), { base: 'pass', rest: '!' });
  assert.deepEqual(v('gate result → passed'), { base: 'pass', rest: '' });
  assert.deepEqual(v('Result gate: ~~FAIL~~ PASS'), { base: 'fail', rest: ' pass' });
  assert.deepEqual(v('Summary: all good, gate: PASS (tests not run)'), { base: 'pass', rest: ' (tests not run)' });
  assert.deepEqual(v('Gate: OK'), { base: 'pass', rest: '' });
  assert.deepEqual(v('gate check result: failure'), { base: 'fail', rest: '' });
  assert.deepEqual(v('- [ ] Gate status: incomplete'), { base: 'incomplete', rest: '' });
  for (const s of [
    'The gate passed.', '| gate | PASS |', 'gate-PASS', 'gate a b c: PASS', 'gate: 1 PASS', 'gate: ' + '.'.repeat(12) + 'PASS', 'gate: compass',
    'Stage gate checks ran: 3', "The gate line above is the gate's own.", 'I ran the gate; the result is below.', 'gate ' + 'a'.repeat(31) + ': PASS',
    'noticed: sonarqube quality gate: failed', 'the deploy gate: passes', 'one two gate: OK', 'mid text gate - PASS', 'gate: passthrough',
  ]) {
    assert.equal(verdictOf(s), null, s);
  }
  // the space after the separator is part of the run: a space and 11 more characters is the most; a pair of surrogates counts once, a lone one too
  assert.equal(verdictOf('gate: ' + '.'.repeat(11) + 'PASS').base, 'pass');
  assert.equal(verdictOf('gate: ' + '🎉'.repeat(11) + 'PASS').base, 'pass');
  assert.equal(verdictOf('gate: ' + '🎉'.repeat(12) + 'PASS'), null);
  const lone = String.fromCharCode(0xdc00);
  assert.equal(verdictOf('gate: ' + lone.repeat(11) + 'PASS').base, 'pass');
  assert.equal(verdictOf('gate: ' + lone.repeat(12) + 'PASS'), null);
});

// Honest lines the previous widening sent back (attacker's finding): each is accepted beside the true line.
const HONEST = [
  'noticed: SonarQube quality gate: failed on the old branch (not touched here)',
  'skipped: review finding not fixed: the CI gate - failing on Windows runners, pre-existing',
  'The deploy gate: passes again after the fix.',
  'Fixed the login gate: failing sessions are now retried.',
  'Added a feature-flag gate = passthrough mode.',
  'feature-flag gate = passthrough mode',
  'The gate passed.',
  'the gateway: FAIL is unrelated',
  'navigate: FAILED here',
  'gates: FAIL',
  'gate1: FAIL',
  '3 gate checks: passed 2 of 3 before the fix',
  '2024. gateway result: failed',
];
test('honest lines are accepted beside the true line', () => {
  for (const want of ['gate: PASS', T]) {
    for (const h of HONEST) {
      for (const msg of [`Done.\n${h}\n\n${want}`, `${want}\n${h}`]) assert.equal(run(want, msg), null, `${want}: ${JSON.stringify(msg)}`);
    }
  }
  assert.equal(run('gate: PASS', 'Gate: ✅ PASSED, 12 tests\n\ngate: PASS'), null);
  assert.equal(run('gate: PASS', 'all good, gate: PASS and merged\ngate: PASS'), null);
  assert.equal(run('gate: PASS', 'gate: PASS\nthe gate: passing is fine'), null);
  assert.equal(run(T, `Gate: PASS (tests not run)\n${T}`), null);
  assert.equal(run(T, `Gate: passed, tests not run\n${T}`), null);
});

test("the gate's own pasted lines are not read as claims", () => {
  const check = 'check: PASS (echo gate: FAIL, exit 0)';
  for (const want of ['gate: PASS', T]) {
    for (const line of [check, `- ${check}`, `> **${check}**`, `\`${check}\`.`]) {
      assert.equal(run(want, `Done.\n${line}\n${want}`, [check, want]), null, line);
    }
    // the same line is a claim when the gate did not print it
    assert.notEqual(run(want, `Done.\n${check}\n${want}`), null);
  }
});

// Real paste blocks of a passing ending `finish`, with one ordinary sentence above them.
const SID = 'gate-lines-sess';
const E = (home) => ({ JEFE_HOME: home, JEFE_SESSION_ID: SID, JEFE_MODE: 'headless' });
const pasteBlock = (out) => {
  const L = out.trim().split('\n');
  return L.slice(L.findIndex((l) => l === 'paste:' || l.startsWith('paste (')) + 1);
};
test('the full real paste block of a passing finish is accepted (plain, tests not run, staged, review pending)', () => {
  const cases = [];
  let d = repo({ 'a.txt': 'x\n' });
  let h = tmp();
  cases.push(['plain', d, h, gate(['finish', '--goal', 'g', '--', 'node', '-e', '0'], d, E(h))]);
  d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }), 'lint.sh': 'exit 0\n' });
  h = tmp();
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'sh lint.sh'], d, E(h));
  cases.push(['tests not run', d, h, gate(['finish', '--goal', 'g', '--', 'sh', 'lint.sh'], d, E(h))]);
  d = repo({ 'package.json': JSON.stringify({ scripts: { test: 'node pass.js' } }), 'pass.js': '\n' });
  h = tmp();
  gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'node pass.js', '--allow-kind', 'tests', '--stage', 'one :: a', '--stage', 'two :: b'], d, E(h));
  gate(['start'], d, E(h));
  gate(['finish', '--stage', '1', '--', 'node', 'pass.js'], d, E(h));
  cases.push(['staged', d, h, gate(['finish', '--stage', '2', '--', 'node', 'pass.js'], d, E(h))]);
  d = repo({ 'a.txt': 'x\n' });
  h = tmp();
  cases.push(['review pending', d, h, gate(['finish', '--goal', 'g', '--review', 'pending', '--', 'node', '-e', '0'], d, E(h))]);
  const gates = new Set();
  for (const [name, dir, home, r] of cases) {
    assert.equal(r.code, 0, `${name}: ${r.out}`);
    const rc = JSON.parse(readFileSync(join(home, 'run', `${runKey(dir)}.report.json`), 'utf8'));
    gates.add(rc.gate);
    const block = pasteBlock(r.out).map((l) => l.replace("review: <the reviewer's answer: PASS or GAP>", 'review: PASS')).join('\n');
    for (const msg of [`Done: the feature works and the gate passed.\n\n${block}`, `Done.\n\n${block.split('\n').map((l) => '- ' + l).join('\n')}`]) {
      assert.equal(decide(rc, msg, { session: SID }), null, `${name}: ${msg}`);
    }
  }
  assert.ok(gates.has('gate: PASS') && gates.has(T), [...gates].join(', '));
});

// NOT caught: pinned as accepted so docs/LIMITS.md stays true. These are outside both parts of the rule; the line to read is the gate's own.
test('not caught (docs/LIMITS.md): other wording beside the true line is accepted', () => {
  for (const claim of ['Gate (final): PASS', "Gate's verdict: PASS", 'Gate: all tests passed', '## Gate\n✅ PASS', '| gate | PASS |']) {
    for (const want of ['gate: PASS', T]) assert.equal(run(want, `All done.\n\n${claim}\n\n${want}`), null, `${want}: ${claim}`);
  }
  assert.equal(run(T, `The gate passed.\n${T}`), null);
});

test('honest messages are accepted', () => {
  const ok = (want, msg) => assert.equal(run(want, msg), null, JSON.stringify(msg));
  for (const want of ['gate: PASS', 'gate: PASS (tests not run)', 'gate: FAIL']) {
    ok(want, want);
    ok(want, `All done.\n\n${want}\ntests: PASS (npm test --silent, 3 passed, 0.3s)\ncheck: PASS (node -e 0, exit 0)\nreview: PASS\nstage: 2/2 done; all stages done`);
    ok(want, `The gate line above is the gate's own.\nStage gate checks ran: 3\nI ran the gate; the result is below.\n${want}`);
    ok(want, `${want}\n${want}`);
  }
  ok('gate: PASS', 'gate: PASS\ngate: PASS');
  ok('gate: FAIL (branch)', 'Stopped.\n- gate: FAIL (branch)');
  ok('gate: FAIL (branch)', 'gate: FAIL (branch)\n- gate: FAIL (branch)');
});

// The tight budgets hold on a quiet machine only (JEFE_PERF_TESTS=1, like tests/perf-budget.test.mjs). In a whole-suite run, where test files
// share the processors, the ceiling is loose and still far below what a quadratic scan of these inputs takes (minutes).
const LOOSE = 30000;
const budgetOf = (tight) => (process.env.JEFE_PERF_TESTS === '1' ? tight : LOOSE);

test('verdict scan stays linear: a 1 MB line and 200,000 short `gate:` lines', () => {
  const T2 = 'gate: FAIL';
  const median = (msg) => {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      run(T2, msg);
      times.push(performance.now() - t);
    }
    return times.sort((a, b) => a - b)[1];
  };
  // generous for a slow machine: each takes well under 100 ms here
  for (const [name, msg] of [
    ['1 MB line of `gate result `', `${T2}\n` + 'gate result '.repeat(90000)],
    ['1 MB line of `gate: ` and emoji', `${T2}\n` + 'gate: 🎉🎉🎉 '.repeat(80000)],
    ['200,000 `gate:` lines', `${T2}\n` + Array(200000).fill('gate:').join('\n')],
  ]) {
    const ms = median(msg);
    const budget = budgetOf(1000);
    assert.ok(ms < budget, `${name}: took ${ms.toFixed(0)} ms, budget ${budget} ms`);
  }
});

test('verdict scan stays linear: 1 MB of `gate` and spaces on one line beside the true line', () => {
  const msg = 'gate '.repeat(200000) + 'gate:' + ' '.repeat(1 << 20) + 'x\n' + T;
  const t = performance.now();
  run(T, msg);
  const ms = performance.now() - t;
  const budget = budgetOf(1000);
  assert.ok(ms < budget, `took ${ms.toFixed(0)} ms, budget ${budget} ms`);
});

test('verdict scan stays linear: 5 MB of newlines, and 5 MB of `gate: ` repeats, each well under the hook timeout', () => {
  for (const [name, msg] of [
    ['5 MB of newlines', `${T}\n` + '\n'.repeat(5 << 20)],
    ['5 MB line of `gate: ` repeats', `${T}\n` + 'gate: '.repeat((5 << 20) / 6)],
    ['5 MB line of `gate: ` repeats after a word', `${T}\nx ` + 'gate: '.repeat((5 << 20) / 6)],
    ['5 MB of `gate: ` lines', `${T}\n` + 'gate: \n'.repeat((5 << 20) / 7)],
  ]) {
    // the best of up to three runs; on a quiet machine the budget is under the Stop hook's 3 second timeout
    const budget = budgetOf(2500);
    let ms = Infinity;
    for (let i = 0; i < 3 && ms >= budget; i++) {
      const t = performance.now();
      run(T, msg);
      ms = Math.min(ms, performance.now() - t);
    }
    assert.ok(ms < budget, `${name}: took ${ms.toFixed(0)} ms, budget ${budget} ms`);
  }
});
