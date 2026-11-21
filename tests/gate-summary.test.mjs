// The gate's compact output: a passing run is one line, a failing run keeps every failing test's name and message
// inside a cap, and the full raw text is always saved to .jefe/logs/.
// Fixtures in tests/fixtures/output/: node --test (spec and TAP), pytest, unittest and go test are real output of
// those runners; jest, mocha, cargo and the lint list are hand-written replicas of their documented formats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanLines, countsText, excerpt, goTestText, MAX_CHARS, MAX_LINES, parseRun } from '../hooks/summarize.mjs';
import { gate, tmp, write } from './fixtures/gate/helpers.mjs';

const fx = (n) => readFileSync(fileURLToPath(new URL(`./fixtures/output/${n}.txt`, import.meta.url)), 'utf8');
const text = (r) => r.lines.join('\n');

// name and message each failing test must keep
const FAILING = {
  node_fail_spec: { names: ['subtracts wrongly', 'deep objects', 'throws ok'], msgs: ['2 !== 3', '+ actual - expected', 'boom here'], runner: 'node', counts: '3 failed, 2 passed' },
  node_fail_tap: { names: ['subtracts wrongly', 'deep objects', 'throws ok'], msgs: ['2 !== 3', '+ actual - expected', 'boom here'], runner: 'node', counts: '3 failed, 2 passed' },
  pytest_fail: { names: ['test_bad', 'test_msg', 'T.test_u'], msgs: ['math is broken', "{'b': [1, 2]} != {'b': [1, 3]}", '2 != 3'], runner: 'pytest', counts: '3 failed, 2 passed' },
  unittest_fail: { names: ['test_u (test_x.T.test_u)'], msgs: ['AssertionError: 2 != 3', 'self.assertEqual(add(1,1), 3)'], runner: 'unittest', counts: '1 failed, 1 passed' },
  jest_fail: { names: ['Cart › adds an item', 'Cart › applies a discount'], msgs: ['Expected: 2', 'Received: 1', 'cart.discount is not a function', 'src/cart.test.js:7:24'], runner: 'jest', counts: '2 failed, 1 passed' },
  go_fail: { names: ['TestBad', 'TestSub/inner'], msgs: ['got 2, want 3', 'inner failed: x'], runner: 'go', counts: '2 failed' },
  mocha_fail: { names: ['Math'], msgs: ['expected 1 to equal 2'], runner: 'mocha', counts: '1 failed, 1 passed' },
  cargo_fail: { names: ['tests::subtracts'], msgs: ['panicked at src/lib.rs:12:9', 'left: 1', 'right: 2'], runner: 'cargo', counts: '1 failed, 1 passed' },
};

for (const [name, want] of Object.entries(FAILING)) {
  test(`excerpt of ${name}: every failing test, its message, no ANSI, under the cap`, () => {
    const r = excerpt(fx(name), { cwd: '/work/proj' });
    const t = text(r);
    assert.equal(r.runner, want.runner);
    assert.equal(countsText(r.counts), want.counts);
    for (const n of want.names) assert.ok(t.includes(n), `name ${n} in:\n${t}`);
    for (const m of want.msgs) assert.ok(t.includes(m), `message ${m} in:\n${t}`);
    assert.ok(r.lines.length < MAX_LINES && t.length <= MAX_CHARS);
    assert.ok(!/\x1b/.test(t));
    assert.ok(!/node_modules|node:internal|site-packages|_pytest/.test(t), `no runner internals in:\n${t}`);
  });
}

test('excerpt: ANSI colour codes and carriage-return progress are stripped', () => {
  const colored = fx('pytest_fail').replace(/^E /gm, '\x1b[31mE \x1b[0m').replace('test_x.py .FF.F', 'test_x.py .\r.F\x1b[32mF\x1b[0m.F');
  const t = text(excerpt(colored));
  assert.ok(!/\x1b|\r/.test(t));
  assert.match(t, /math is broken/);
});

test('excerpt: the first stack frame inside the project is kept, internals are not', () => {
  const t = text(excerpt(fx('node_fail_spec'), { cwd: '/work/proj' }));
  assert.match(t, /at TestContext\.<anonymous> \(a\.test\.mjs:4:40\)/);
  assert.ok(!/runInAsyncScope/.test(t));
});

test('excerpt: many failures stay under the cap, every name is kept, the rest is counted', () => {
  const lines = ['✖ failing tests:', ''];
  for (let i = 1; i <= 40; i++) {
    lines.push(`test at big.test.mjs:${i}:1`, `✖ case number ${i} (0.5ms)`, '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', '  ', `  ${i} !== ${i + 1}`, '  ', `      at TestContext.<anonymous> (file:///work/proj/big.test.mjs:${i}:9)`, '      at Test.run (node:internal/test_runner/test:1:1)', '');
  }
  const raw = ['ℹ tests 40', 'ℹ pass 0', 'ℹ fail 40', '', ...lines].join('\n');
  const r = excerpt(raw, { cwd: '/work/proj' });
  const t = text(r);
  assert.ok(r.lines.length <= MAX_LINES && t.length <= MAX_CHARS, `${r.lines.length} lines, ${t.length} chars`);
  for (let i = 1; i <= 40; i++) assert.ok(t.includes(`case number ${i}`) || /also failing:.*case number/.test(t), `name ${i}`);
  assert.ok(r.omitted > 0);
});

test('excerpt: identical failure bodies are said once', () => {
  const lines = ['ℹ tests 3', 'ℹ pass 0', 'ℹ fail 3', '', '✖ failing tests:', ''];
  for (const n of ['a', 'b', 'c']) lines.push(`test at t.mjs:1:1`, `✖ ${n} (1ms)`, '  Error: same message everywhere', '');
  const t = text(excerpt(lines.join('\n')));
  assert.equal(t.split('Error: same message everywhere').length - 1, 1);
  assert.match(t, /same as a/);
  for (const n of ['✖ a', '✖ b', '✖ c']) assert.ok(t.includes(n));
});

test('excerpt: thousands of failure blocks with repeated heads: each head once, the first block kept, no search per block', () => {
  const N = 20000;
  const lines = ['✖ failing tests:', ''];
  for (let i = 1; i <= N; i++) lines.push(`test at big.test.mjs:${i}:1`, `✖ case number ${i} (0.5ms)`, `  Error: boom ${i}`, '');
  // the first heads again, with other bodies: these later blocks are dropped
  for (let i = 1; i <= 3; i++) lines.push(`test at big.test.mjs:${i}:1`, `✖ case number ${i} (0.5ms)`, `  Error: later ${i}`, '');
  const raw = [`ℹ tests ${N}`, 'ℹ pass 0', `ℹ fail ${N}`, '', ...lines].join('\n');
  // the old filter searched the whole block list once per block (N searches of N blocks): count the searches over a list that long
  const orig = Array.prototype.findIndex;
  let longSearches = 0;
  Array.prototype.findIndex = function (...a) {
    if (this.length >= N) longSearches++;
    return orig.apply(this, a);
  };
  let r;
  try {
    r = excerpt(raw);
  } finally {
    Array.prototype.findIndex = orig;
  }
  assert.ok(longSearches < 10, `${longSearches} searches over the ${N} blocks`);
  const t = text(r);
  assert.ok(r.lines.length <= MAX_LINES && t.length <= MAX_CHARS);
  // every name is said once: in a head line or in the also-failing list
  const names = [...r.lines.filter((l) => l.startsWith('✖ ')).map((l) => l.slice(2)), ...(r.lines.find((l) => l.startsWith('also failing: ')) || '').slice(14).split(', ')].filter((n) => /^case number \d+$/.test(n));
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.slice(0, 3), ['case number 1', 'case number 2', 'case number 3']);
  // a small run shows the bodies: the first block of a head is the one kept
  const small = ['ℹ tests 3', 'ℹ pass 0', 'ℹ fail 3', '', '✖ failing tests:', '', 'test at t.mjs:1:1', '✖ a (1ms)', '  Error: first', '', 'test at t.mjs:2:1', '✖ b (1ms)', '  Error: other', '', 'test at t.mjs:1:1', '✖ a (1ms)', '  Error: later', ''];
  const s = text(excerpt(small.join('\n')));
  assert.match(s, /Error: first/);
  assert.doesNotMatch(s, /Error: later/);
  assert.equal(s.split('✖ a').length - 1, 1);
});

test('excerpt: an unknown format keeps head 20 and tail 40', () => {
  const raw = Array.from({ length: 200 }, (_, i) => `row ${i + 1}`).join('\n');
  const r = excerpt(raw);
  assert.equal(r.runner, null);
  assert.equal(r.lines.length, 60);
  assert.equal(r.lines[0], 'row 1');
  assert.equal(r.lines[19], 'row 20');
  assert.equal(r.lines[20], 'row 161');
  assert.equal(r.lines[59], 'row 200');
  assert.equal(r.omitted, 140);
});

test('excerpt: a short unknown output is kept whole; a lint list is not cut', () => {
  const r = excerpt(fx('lint_fail'));
  assert.equal(r.omitted, 0);
  assert.match(text(r), /no-console/);
});

// ---- through the gate ----

const run = (d, args, env) => gate(args, d, env);
const logs = (d) => (existsSync(join(d, '.jefe', 'logs')) ? readdirSync(join(d, '.jefe', 'logs')).filter((n) => n.endsWith('.log')).sort() : []);
// a test command that prints a fixture and exits with the given code
function project(fixture, code) {
  const d = tmp();
  write(d, 'out.txt', fx(fixture));
  write(d, 'run.js', `process.stdout.write(require('fs').readFileSync(__dirname + '/out.txt', 'utf8')); process.exitCode = ${code};\n`);
  write(d, 'package.json', JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node run.js' } }));
  return d;
}

test('gate tests: a pass is one line, no child lines, and the full output is logged', () => {
  const d = project('pytest_pass', 0);
  const r = run(d, ['tests']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out.trim(), /^tests: PASS \(npm test --silent, 2 passed, [\d.]+s\)$/);
  assert.equal(r.out.trim().split('\n').length, 1);
  const [log] = logs(d);
  assert.ok(log, 'a log file exists');
  assert.match(readFileSync(join(d, '.jefe', 'logs', log), 'utf8'), /2 passed in 0\.00s/);
});

test('gate tests: a failure names every failing test and its message, and prints the log path', () => {
  for (const name of ['node_fail_spec', 'pytest_fail', 'unittest_fail', 'jest_fail', 'go_fail']) {
    const d = project(name, 1);
    const r = run(d, ['tests']);
    assert.equal(r.code, 1, r.out);
    for (const n of FAILING[name].names) assert.ok(r.out.includes(n), `${name}: ${n} in\n${r.out}`);
    for (const m of FAILING[name].msgs) assert.ok(r.out.includes(m), `${name}: ${m} in\n${r.out}`);
    assert.match(r.out, /^tests: FAIL \(npm test --silent, .*\d+ failed/m);
    assert.match(r.out, /^\| /m);
    assert.match(r.out, /\.jefe\/logs\/\S+\.log/);
    const [log] = logs(d);
    assert.equal(readFileSync(join(d, '.jefe', 'logs', log), 'utf8').endsWith(fx(name)), true, 'the log holds the full text');
    assert.ok(r.out.split('\n').length <= MAX_LINES + 8);
  }
});

test('gate verify: a failing plain check is capped to head and tail and logged in full', () => {
  const d = tmp();
  write(d, 'noisy.js', `for (let i = 1; i <= 300; i++) console.log('warn ' + i); process.exitCode = 2;\n`);
  const r2 = run(d, ['verify', '--', 'node', 'noisy.js']);
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /^check: FAIL \(node noisy\.js, exit 2\)$/m);
  assert.match(r2.out, /^\| warn 1$/m);
  assert.match(r2.out, /^\| warn 300$/m);
  assert.ok(!/^\| warn 150$/m.test(r2.out));
  assert.match(r2.out, /^\| \.\.\. 240 more lines omitted \(full log: \.jefe\/logs\/\S+-check\.log\)$/m);
  const log = logs(d).find((n) => n.endsWith('-check.log'));
  assert.ok(readFileSync(join(d, '.jefe', 'logs', log), 'utf8').includes('warn 150'));
});

test('gate: --full and JEFE_FULL_OUTPUT=1 restore the old relay (the last 15 lines)', () => {
  const d = project('pytest_fail', 1);
  for (const r of [run(d, ['tests', '--full']), run(d, ['tests'], { JEFE_FULL_OUTPUT: '1' })]) {
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^tests: FAIL \(npm test --silent, [\d.]+s\)$/m);
    assert.match(r.out, /^\| =+ 3 failed, 2 passed in 0\.01s =+$/m);
    assert.ok(!/full log/.test(r.out));
  }
});

test('gate: only the newest 10 logs are kept', () => {
  const d = project('pytest_pass', 0);
  for (let i = 0; i < 13; i++) run(d, ['tests']);
  assert.equal(logs(d).length, 10);
});

test('gate: .jefe/logs is ignored by git through .jefe/.gitignore', () => {
  const d = project('pytest_pass', 0);
  run(d, ['tests']);
  assert.equal(readFileSync(join(d, '.jefe', '.gitignore'), 'utf8').trim(), '*');
  writeFileSync(join(d, 'unused.txt'), '');
});

test('gate: a timeout and a crash keep their messages', () => {
  const d = tmp();
  write(d, 'package.json', JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node -e "setTimeout(()=>{},60000)"' } }));
  const r = run(d, ['tests', '--timeout', '1']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^tests: TIMEOUT \(/m);
  const r3 = run(d, ['verify', '--', 'no-such-cmd-xyz']);
  assert.match(r3.out, /^check: FAIL \(no-such-cmd-xyz, could not start\)$/m);
  assert.match(r3.out, /ENOENT/);
});

test('unittest: expected failures are not failed tests; a FAILED line counts failures, errors and unexpected successes', () => {
  const counts = (last) => parseRun(['----------------------------------------------------------------------', 'Ran 4 tests in 0.000s', '', last]).counts;
  assert.deepEqual(counts('OK (skipped=1, expected failures=1)'), { passed: 3, failed: 0 });
  assert.deepEqual(counts('OK (expected failures=2)'), { passed: 4, failed: 0 });
  assert.deepEqual(counts('FAILED (failures=1, expected failures=1, unexpected successes=1)'), { passed: 2, failed: 2 });
  assert.deepEqual(counts('FAILED (expected failures=1, unexpected successes=1)'), { passed: 3, failed: 1 });
  assert.deepEqual(counts('FAILED (failures=1, errors=1)'), { passed: 2, failed: 2 });
});

test('python3 -m unittest with an expected failure is a passing check', (t) => {
  if (spawnSync('python3', ['--version']).status !== 0) return t.skip('python3 not installed');
  const d = tmp();
  write(d, 't_x.py', 'import unittest\nclass T(unittest.TestCase):\n    def test_a(self): pass\n    @unittest.expectedFailure\n    def test_b(self): self.assertEqual(1, 2)\n');
  const r = gate(['verify', '--', 'python3', '-m', 'unittest', 't_x'], d, { JEFE_HOME: tmp() });
  assert.match(r.out, /^check: PASS \(python3 -m unittest t_x, 2 passed, exit 0\)$/m, r.out);
});

// what go 1.26 printed for each project shape and flag set (the file says how it was captured)
const CORPUS = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/go-test-text/corpus.json', import.meta.url)), 'utf8')).entries;
// the shapes in which go reports a failure, unless the flags keep it from happening: -run=NONE and -run=^$ run no test, -vet=off skips vet
const goFails = (e) => {
  if (['build-error-test', 'build-error-package', 'setup-failure'].includes(e.project) || e.name === 'workspace ./... at the workspace root') return true;
  if (e.project === 'vet-failure') return !e.flags.includes('-vet=off');
  if (['failing', 'panic'].includes(e.project)) return !e.flags.some((f) => f === '-run=NONE' || f === '-run=^$');
  return false;
};
// the text as a pipe, docker compose or turbo shows it, with colour around each line, or with CRLF endings
const variants = (t) => ['', '  ', 'app-1  | ', 'm:test: '].flatMap((p) => [
  t.split('\n').map((l) => (l ? p + l : l)).join('\n'),
  t.split('\n').map((l) => (l ? `${p}\x1b[31m${l}\x1b[0m` : l)).join('\n'),
  t.split('\n').map((l) => (l ? p + l : l)).join('\r\n'),
]);

test("goTestText: every corpus entry is go test's text; failed exactly when go reported a failure, also behind a prefix, in colour, with CRLF", () => {
  assert.ok(CORPUS.length > 250, String(CORPUS.length));
  for (const e of CORPUS) {
    assert.ok(e.text.trim(), `${e.name}: empty text`);
    assert.equal(goFails(e), e.exit !== 0, `${e.name}: exit ${e.exit}`);
    for (const v of variants(e.text)) assert.deepEqual(goTestText(cleanLines(v)), { seen: true, failed: goFails(e) }, `${e.name}: ${JSON.stringify(v.slice(0, 120))}`);
  }
});

test("goTestText: go test's own lines one at a time, also behind a line prefix", () => {
  const yes = [
    'ok  \tm\t0.123s', 'ok  m 0.1s', 'ok  \tm\t(cached)', 'ok  \tm\t0.010s\tcoverage: 50.0% of statements', 'ok  \tm\t0.010s [no tests to run]',
    '?   \tm\t[no test files]', '  ok  \tm\t0.1s', 'app-1  | --- SKIP: TestP/a (0.00s)', 'm:test: ok  \tm\t0.2s', 'm:test: ?   \tm\t[no test files]',
    '--- PASS: TestA (0.00s)', '    --- SKIP: TestP/a (0.00s)', '\tm\t\tcoverage: 0.0% of statements', 'coverage: [no statements]', '=== RUN   TestA',
    '=== NAME  TestA', 'testing: warning: no tests to run', 'fuzz: elapsed: 0s, gathering baseline coverage: 0/1 completed',
  ];
  for (const l of yes) assert.deepEqual(goTestText(cleanLines(`make: entering\n${l}`)), { seen: true, failed: false }, JSON.stringify(l));
  const fail = ['FAIL\tm\t0.205s', 'FAIL\tm [build failed]', 'FAIL\t./... [setup failed]', '--- FAIL: TestB (0.01s)', 'm:test: FAIL\tm [build failed]', '    --- FAIL: TestP/a (0.00s)'];
  for (const l of fail) assert.deepEqual(goTestText([l]), { seen: true, failed: true }, JSON.stringify(l));
  // a benchmark result with its header; a bare FAIL line next to other go text
  assert.deepEqual(goTestText(['goos: darwin', 'pkg: m', 'BenchmarkF-8    \t1000\t         1.2 ns/op']), { seen: true, failed: false });
  assert.deepEqual(goTestText(['BenchmarkF-8    \t1000\t         1.2 ns/op']), { seen: false, failed: false });
  // a panic's own lines are not go test's verdict: a program that recovers and logs one did not fail, and a test that panics gets a FAIL package line
  assert.deepEqual(goTestText(['panic: boom', '', 'goroutine 7 [running]:']), { seen: false, failed: false });
  assert.deepEqual(goTestText(['=== RUN   TestA', '2026/01/01 00:00:00 panic: recovered', 'goroutine 7 [running]:', '--- PASS: TestA (0.00s)', 'PASS', 'ok  \tm\t0.123s']), { seen: true, failed: false });
  assert.deepEqual(goTestText(['panic: boom', '', 'goroutine 7 [running]:', 'FAIL\tm\t0.201s', 'FAIL']), { seen: true, failed: true });
  // deno's summary line is not go's
  assert.deepEqual(goTestText(['running 1 test from ./a_test.ts', 'adds ... ok (0ms)', '', 'ok | 1 passed | 0 failed (1ms)']), { seen: false, failed: false });
  assert.deepEqual(goTestText(['=== RUN   TestA', 'app-1  | FAIL']), { seen: true, failed: true });
  assert.deepEqual(goTestText(['Result: FAIL']), { seen: false, failed: false });
});

test('goTestText: other runners, tools and prose are not go test text', () => {
  // bats prints `ok 1 2 plus 2`: no duration with a decimal point, so false (parseRun's go entry does read it as package lines)
  const no = ['ok', 'ok 1 - adds', 'ok 1 2 plus 2', 'ok 1 - adds # time=1.234ms', 'ok 1 adds in 12ms', 'ok 1 - foo 1.5s', 'ok 1 adds 0.5s', 'ok 12 ok 0.25s', 'not ok 2 - subtracts',
    'TAP version 13', '1..3', 't/foo.t .. ok', '[12:00:00] t/foo.t ..... ok       12 ms ( 0.00 usr )', 'Result: PASS', 'Result: FAIL', 'All tests successful.',
    'test tests::a ... ok', 'test tests::b ... FAILED', 'test result: ok. 3 passed; 0 failed; 0 ignored', 'test result: FAILED. 1 passed; 1 failed; 0 ignored; finished in 0.01s',
    'test_x.py::test_a PASSED                                  [ 33%]', 'test_x.py::test_b FAILED                                  [ 66%]', '3 passed in 0.01s',
    '    PASS [   0.004s] crate tests::a', '        FAIL [   0.004s] crate tests::b', '     Summary [   0.010s] 3 tests run: 2 passed, 1 failed, 0 skipped',
    'Status: Downloaded newer image for golang:1.22', '#8 [3/4] RUN go test ./...', '#8 DONE 0.1s', 'ok: [web1]', 'web1 : ok=3 changed=0 unreachable=0 failed=0',
    'PASS src/a.test.js (1.234 s)', 'FAIL src/b.test.js (0.5 s)', ' ✓ test/a.test.ts (3 tests) 4ms', 'ℹ pass 3', 'Tests:       3 passed, 3 total',
    'everything is ok after 2s', 'the build FAILED after 2.5s', "make: Nothing to be done for 'test'.", 'make: [Makefile:2: test] Error 1 (ignored)', ''];
  for (const l of no) assert.deepEqual(goTestText([l]), { seen: false, failed: false }, JSON.stringify(l));
  assert.deepEqual(goTestText([]), { seen: false, failed: false });
});

test('goTestText: a 1 MB line is read in well under a second', () => {
  for (const big of ['ok\t' + ' '.repeat(1e6) + 'x', '? ' + 'a'.repeat(1e6), '--- PASS: ' + 'a'.repeat(1e6), '--- FAIL: ' + 'a '.repeat(5e5), 'ok a '.repeat(2e5), 'FAIL a '.repeat(2e5),
    'FAIL ' + ' '.repeat(1e6) + 'x', '=== RUN ' + ' '.repeat(1e6), 'Benchmark ' + '1 '.repeat(5e5), 'coverage: ' + '1'.repeat(1e6), 'panic: ' + ' '.repeat(1e6), ' '.repeat(1e6) + 'FAIL x', 'x'.repeat(1e6)]) {
    const t0 = performance.now();
    assert.equal(goTestText([big]).failed, false);
    assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0}ms`);
  }
});

test('cleanLines trims the end of each line as before', () => {
  const before = (raw) => String(raw).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n').map((l) => {
    const cr = l.lastIndexOf('\r');
    return (cr >= 0 && cr < l.length - 1 ? l.slice(cr + 1) : l.replace(/\r/g, '')).replace(/\s+$/, '');
  });
  const raw = 'ok  \tm\t0.1s  \n  --- FAIL: TestA (0.00s)\t\r\n\x1b[32mPASS\x1b[0m \u{a0}\nprogress 10%\rprogress 100%\n\u{3000}x\u{3000}\n\f\v \n\n  indented\u{2028}\u{feff}\n';
  assert.deepEqual(cleanLines(raw), before(raw));
});

test('cleanLines and parseRun read a line of 80,000 spaces or of 40,000 and 100,000 digits in a loose budget', () => {
  for (const big of [' '.repeat(8e4) + 'x', 'ok ' + ' '.repeat(8e4) + 'x\n' + ' '.repeat(8e4), '1'.repeat(4e4), '1'.repeat(1e5), '1'.repeat(1e5) + ' passed']) {
    const t0 = performance.now();
    const lines = cleanLines(big);
    parseRun(lines);
    goTestText(lines);
    excerpt(big);
    assert.ok(performance.now() - t0 < 5000, `took ${performance.now() - t0}ms`);
  }
  assert.equal(parseRun(['3 passed in 0.01s']).runner, 'pytest');
  assert.equal(parseRun(['1 failed, 2 passed in 0.01s']).runner, 'pytest');
});
