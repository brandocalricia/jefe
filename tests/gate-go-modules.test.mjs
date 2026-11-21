// The gate's Go runs: `go test -json` events decide the counts (a suite whose tests were all skipped tested nothing), and the text shown and
// logged is rebuilt from them. Also: the other runners when every test was skipped or ignored (fake programs, so no real tool is needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectTests, goJsonFilter, goResult } from '../lib/gate/tests.mjs';
import { gate, git, readAllow, repo, tmp, write } from './fixtures/gate/helpers.mjs';
import { testLabel } from '../lib/gate/brief.mjs';

const hasGo = spawnSync('go', ['version']).status === 0;
const env = (extra = {}) => ({ JEFE_HOME: tmp(), JEFE_HOST: 'r4host', JEFE_MODE: 'headless', GOTOOLCHAIN: 'local', GOPROXY: 'off', ...extra });
const gateLines = (out) => out.split('\n').filter((l) => /^(tests|check|gate|commit):/.test(l)).map((l) => l.replace(/, [\d.]+s\)$/, ')'));
const MOD = 'module m\ngo 1.21\n';
const goTest = (body, imports = '"testing"') => `package m\nimport (${imports})\n${body}\n`;
const goDir = (files) => {
  const d = tmp();
  write(d, 'go.mod', MOD);
  write(d, 'm.go', 'package m\n');
  for (const [k, v] of Object.entries(files)) write(d, k, v);
  return d;
};

// ---- the event stream, without the go tool ----

const ev = (o) => JSON.stringify({ Time: 't', Package: 'm', ...o }) + '\n';
test('goJsonFilter: counts come from events (leaf tests), the text is plain go test output, a line split across chunks is read whole', () => {
  const stream = [
    ev({ Action: 'start' }),
    ev({ Action: 'run', Test: 'TestA' }), ev({ Action: 'output', Test: 'TestA', Output: '=== RUN   TestA\n' }), ev({ Action: 'output', Test: 'TestA', Output: '--- PASS: Fake (0.00s)\n' }),
    ev({ Action: 'output', Test: 'TestA', Output: '--- SKIP: TestA (0.00s)\n' }), ev({ Action: 'skip', Test: 'TestA' }),
    ev({ Action: 'run', Test: 'TestP' }), ev({ Action: 'run', Test: 'TestP/one' }), ev({ Action: 'output', Test: 'TestP/one', Output: '    p_test.go:9: bad\n' }),
    ev({ Action: 'output', Test: 'TestP/one', Output: '    --- FAIL: TestP/one (0.00s)\n' }), ev({ Action: 'fail', Test: 'TestP/one' }),
    ev({ Action: 'run', Test: 'TestP/two' }), ev({ Action: 'pass', Test: 'TestP/two' }),
    ev({ Action: 'output', Test: 'TestP', Output: '--- FAIL: TestP (0.00s)\n' }), ev({ Action: 'fail', Test: 'TestP' }),
    ev({ Action: 'run', Test: 'TestQ' }), ev({ Action: 'run', Test: 'TestQ/s' }), ev({ Action: 'skip', Test: 'TestQ/s' }), ev({ Action: 'pass', Test: 'TestQ' }),
    'not json at all\n',
    ev({ Action: 'output', Output: 'FAIL\n' }), ev({ Action: 'output', Output: 'FAIL\tm\t0.1s\n' }), ev({ Action: 'fail' }),
    ev({ Action: 'pass', Package: 'm/other', Test: 'TestA' }),
  ].join('');
  const f = goJsonFilter();
  let text = '';
  for (let i = 0; i < stream.length; i += 37) text += f.push(stream.slice(i, i + 37));
  text += f.end();
  // TestA skipped, TestP/one failed (its parent is not counted again), TestP/two passed, TestQ/s skipped (TestQ has subtests: not counted), m/other TestA passed
  assert.deepEqual(f.counts(), { passed: 2, failed: 1, skipped: 2 });
  assert.equal(text, '--- FAIL: TestP (0.00s)\n    --- FAIL: TestP/one (0.00s)\n    p_test.go:9: bad\nnot json at all\nFAIL\nFAIL\tm\t0.1s\n');
});

test('goResult: a failed test event, or a package that failed as a whole, is FAIL whatever the exit code', () => {
  const run = (events) => {
    const f = goJsonFilter();
    f.push(events.map(ev).join(''));
    f.end();
    return goResult(f, { status: 'PASS', code: 0 });
  };
  const failed = run([{ Action: 'pass', Test: 'TestOK' }, { Action: 'fail', Test: 'TestBad' }, { Action: 'pass' }]);
  assert.equal(failed.r.status, 'FAIL');
  assert.deepEqual(failed.counts, { passed: 1, failed: 1 });
  const pkg = run([{ Action: 'output', Output: 'panic in init\n' }, { Action: 'fail' }]);
  assert.equal(pkg.r.status, 'FAIL');
  assert.equal(pkg.counts, null);
  const none = run([{ Action: 'skip', Test: 'TestA' }, { Action: 'pass' }]);
  assert.equal(none.r.status, 'PASS');
  assert.deepEqual([none.counts, none.skipped], [{ passed: 0, failed: 0 }, 1]);
  // a failed test stays failed, whichever result comes second; a test run twice (-count=2) that passed twice is one passed test
  const forged = run([{ Action: 'fail', Test: 'TestBad' }, { Action: 'pass', Test: 'TestBad' }, { Action: 'skip', Test: 'TestBad' }, { Action: 'pass' }]);
  assert.equal(forged.r.status, 'FAIL');
  assert.deepEqual(forged.counts, { passed: null, failed: 1 });
  const before = run([{ Action: 'pass', Test: 'TestBad' }, { Action: 'fail', Test: 'TestBad' }, { Action: 'pass' }]);
  assert.equal(before.r.status, 'FAIL');
  const twice = run([{ Action: 'pass', Test: 'TestA' }, { Action: 'pass', Test: 'TestA' }, { Action: 'pass' }]);
  assert.equal(twice.r.status, 'PASS');
  assert.deepEqual(twice.counts, { passed: 1, failed: 0 });
});

test('Go: a failed test is not taken back by a result line another test prints for it, under a TestMain that exits 0', (t) => {
  if (!hasGo) return t.skip('go not installed');
  // \x16 is the mark the go tool puts before a result line; a test that prints it makes go test -json report a second result for TestBad
  const body = 'func TestBad(t *testing.T) { t.Fatal("boom") }\nfunc TestZ(t *testing.T) { fmt.Print("\\x16--- PASS: TestBad (0.00s)\\n") }\nfunc TestMain(m *testing.M) { m.Run(); os.Exit(0) }';
  const d = goDir({ 'm_test.go': goTest(body, '"fmt"; "os"; "testing"') });
  const r = gate(['verify', '--', 'go', 'test', '-count=1', './...'], d, env());
  assert.equal(r.code, 1, r.out);
  const lines = gateLines(r.out);
  assert.match(lines[0], /^tests: FAIL \(go test \.\/\.\.\., 1 failed, /, r.out);
  assert.match(lines[1], /^check: FAIL \(go test -count=1 \.\/\.\.\., 1 failed, /, r.out);
  assert.equal(lines[lines.length - 1], 'gate: FAIL');
});

// ---- Item 1: what the gate says for a Go suite ----

test('a Go suite whose only test is skipped is none found, not PASS; with a check given the check decides; a finish --commit does not commit', (t) => {
  if (!hasGo) return t.skip('go not installed');
  const d = repo({ 'go.mod': MOD, 'm.go': 'package m\nfunc Add(a, b int) int { return a - b }\n', 'm_test.go': goTest('func TestAdd(t *testing.T) { if os.Getenv("CI_DB") == "" { t.Skip("no db") }; if Add(1, 2) != 3 { t.Fatal("wrong") } }', '"os"; "testing"') }, { identity: true });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'go');
  const e = env();
  assert.deepEqual(gateLines(gate(['verify'], d, e).out), ['tests: none found (go test ./..., 0 tests ran, 1 skipped)', 'gate: PASS (no tests found, no checks given)']);
  // a check given and passing: the gate is a plain PASS, as for any project with no tests found (the check is what passed)
  assert.deepEqual(gateLines(gate(['verify', '--', 'go', 'vet', './...'], d, e).out), ['tests: none found (go test ./..., 0 tests ran, 1 skipped)', 'check: PASS (go vet ./..., exit 0)', 'gate: PASS']);
  // with the database the test runs and fails
  assert.deepEqual(gateLines(gate(['verify'], d, { ...e, CI_DB: '1' }).out), ['tests: FAIL (go test ./..., 1 failed)', 'gate: FAIL']);
  // the attacker's commit: tests and git-commit approved, finish --commit on the skipped-only suite
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit'], d, e).code, 0);
  write(d, 'README', 'change\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const fin = gate(['finish', '--plan', 'job', '--goal', 'g', '--commit', 'msg'], d, e);
  assert.match(fin.out, /^tests: none found \(go test \.\/\.\.\., 0 tests ran, 1 skipped\)$/m, fin.out);
  assert.match(fin.out, /^commit: skipped \(gate passed but nothing was tested\)$/m, fin.out);
  assert.match(fin.out, /^gate: PASS \(no tests found, no checks given\)$/m, fin.out);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'no commit was made');
});

test('Go: a TestMain that exits 0 without m.Run, and a test whose subtests are all skipped, ran nothing', (t) => {
  if (!hasGo) return t.skip('go not installed');
  const main = goDir({ 'm_test.go': goTest('func TestA(t *testing.T) { t.Fatal(1) }\nfunc TestMain(m *testing.M) { os.Exit(0) }', '"os"; "testing"') });
  assert.deepEqual(gateLines(gate(['verify'], main, env()).out), ['tests: none found (go test ./..., 0 tests ran)', 'gate: PASS (no tests found, no checks given)']);
  const subs = goDir({ 'm_test.go': goTest('func TestDB(t *testing.T) { t.Run("a", func(t *testing.T) { t.Skip() }); t.Run("b", func(t *testing.T) { t.Skip() }) }') });
  assert.deepEqual(gateLines(gate(['verify'], subs, env()).out), ['tests: none found (go test ./..., 0 tests ran, 2 skipped)', 'gate: PASS (no tests found, no checks given)']);
});

test('Go: what a skipped test prints (--- PASS lines, JSON event text) does not count: go test -json wraps it in Output', (t) => {
  if (!hasGo) return t.skip('go not installed');
  const body = 'func TestA(t *testing.T) { fmt.Println("--- PASS: Fake (0.00s)"); fmt.Println(`{"Action":"pass","Package":"m","Test":"Fake"}`); fmt.Println("ok  \\tm\\t0.1s"); t.Skip("later") }';
  const d = goDir({ 'm_test.go': goTest(body, '"fmt"; "testing"') });
  assert.deepEqual(gateLines(gate(['verify'], d, env()).out), ['tests: none found (go test ./..., 0 tests ran, 1 skipped)', 'gate: PASS (no tests found, no checks given)']);
});

test('Go: a failing test under a TestMain that runs the tests and exits 0 is FAIL; finish --commit does not commit', (t) => {
  if (!hasGo) return t.skip('go not installed');
  const body = 'func TestOK(t *testing.T) {}\nfunc TestBad(t *testing.T) { t.Fatal("boom") }\nfunc TestMain(m *testing.M) { m.Run(); os.Exit(0) }';
  const d = repo({ 'go.mod': MOD, 'm.go': 'package m\n', 'm_test.go': goTest(body, '"os"; "testing"') }, { identity: true });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'go');
  const e = env();
  const r = gate(['verify'], d, e);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(gateLines(r.out), ['tests: FAIL (go test ./..., 1 failed, 1 passed, exit 0)', 'gate: FAIL']);
  assert.match(r.out, /^\| ✖ TestBad$/m, r.out);
  assert.match(r.out, /^\| m_test\.go:4: boom$/m, r.out);
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit'], d, e).code, 0);
  write(d, 'README', 'change\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const fin = gate(['finish', '--plan', 'job', '--goal', 'g', '--commit', 'msg'], d, e);
  assert.match(fin.out, /^gate: FAIL$/m, fin.out);
  assert.doesNotMatch(fin.out, /^commit: (?!skipped)/m, fin.out);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'no commit was made');
});

test('Go: skipped and passing tests together PASS with the passed count (subtests count on their own)', (t) => {
  if (!hasGo) return t.skip('go not installed');
  const d = goDir({ 'm_test.go': goTest('func TestSkip(t *testing.T) { t.Skip() }\nfunc TestOK(t *testing.T) {}\nfunc TestSub(t *testing.T) { t.Run("x", func(t *testing.T) {}); t.Run("y", func(t *testing.T) {}) }') });
  assert.deepEqual(gateLines(gate(['verify'], d, env()).out), ['tests: PASS (go test ./..., 3 passed)', 'gate: PASS']);
});

test('Go: a failing test is FAIL with a readable block, and neither the printed lines nor the saved log are JSON', (t) => {
  if (!hasGo) return t.skip('go not installed');
  const d = goDir({ 'm_test.go': goTest('func TestOK(t *testing.T) {}\nfunc TestBad(t *testing.T) { t.Log("context"); t.Fatal("boom") }\nfunc TestP(t *testing.T) { t.Run("sub", func(t *testing.T) { t.Error("inner") }) }') });
  const r = gate(['verify'], d, env());
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(gateLines(r.out), ['tests: FAIL (go test ./..., 2 failed, 1 passed)', 'gate: FAIL']);
  const shown = r.out.split('\n').filter((l) => l.startsWith('| '));
  assert.ok(shown.includes('| ✖ TestBad'), r.out);
  assert.ok(shown.includes('| m_test.go:4: boom'), r.out);
  assert.ok(shown.includes('| ✖ TestP/sub'), r.out);
  assert.ok(shown.some((l) => /^\|\s+m_test\.go:5: inner$/.test(l)), r.out);
  assert.ok(!shown.some((l) => /"Action"|=== RUN/.test(l)), r.out);
  const logs = join(d, '.jefe', 'logs');
  const log = readFileSync(join(logs, readdirSync(logs).find((n) => n.endsWith('-tests.log'))), 'utf8');
  assert.match(log, /^--- FAIL: TestBad \(/m, log);
  assert.match(log, /^FAIL\tm\t/m, log);
  assert.doesNotMatch(log, /"Action"|=== RUN|TestOK/, log);
});

test('Go: a compile error is FAIL with the compiler message shown', (t) => {
  if (!hasGo) return t.skip('go not installed');
  const d = goDir({ 'm_test.go': goTest('func TestA(t *testing.T) { x }') });
  const r = gate(['verify'], d, env());
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(gateLines(r.out), ['tests: FAIL (go test ./...)', 'gate: FAIL']);
  assert.match(r.out, /^\| \.\/m_test\.go:3:\d+: undefined: x$/m, r.out);
});

// ---- the other runners when every test was skipped or ignored ----

// a PATH with git and one fake program that prints `out` and exits 0
function fakePath(name, out) {
  const bin = tmp();
  symlinkSync(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(bin, 'git'));
  writeFileSync(join(bin, 'out.txt'), out);
  writeFileSync(join(bin, name), `#!/bin/sh\n/bin/cat '${join(bin, 'out.txt')}'\nexit 0\n`, { mode: 0o755 });
  return bin;
}

test('pytest with only skipped tests and cargo with only ignored tests are none found', () => {
  const py = tmp();
  write(py, 'test_a.py', 'def test_a():\n    pass\n');
  const pr = gate(['verify'], py, env({ PATH: fakePath('python3', 'ss                                                                       [100%]\n2 skipped in 0.01s\n') }));
  assert.deepEqual(gateLines(pr.out), ['tests: none found (python3 -m pytest -q, 0 tests ran)', 'gate: PASS (no tests found, no checks given)'], pr.out);
  const rs = tmp();
  write(rs, 'Cargo.toml', '[package]\nname = "x"\nversion = "0.1.0"\n');
  const cargo = '\nrunning 2 tests\ntest a ... ignored\ntest b ... ignored\n\ntest result: ok. 0 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n';
  const cr = gate(['verify'], rs, env({ PATH: fakePath('cargo', cargo) }));
  assert.deepEqual(gateLines(cr.out), ['tests: none found (cargo test -q, 0 tests ran)', 'gate: PASS (no tests found, no checks given)'], cr.out);
});

test('npm test whose runner reports only skipped tests (node, mocha, jest) is none found', () => {
  const outs = {
    node: '﹣ a (0.1ms) # SKIP\nℹ tests 2\nℹ suites 0\nℹ pass 0\nℹ fail 0\nℹ cancelled 0\nℹ skipped 2\nℹ todo 0\nℹ duration_ms 5.1\n',
    mocha: '\n\n  a\n    - one\n    - two\n\n\n  0 passing (3ms)\n  2 pending\n\n',
    jest: 'Test Suites: 1 skipped, 0 of 1 total\nTests:       2 skipped, 2 total\nSnapshots:   0 total\nTime:        0.4 s\nRan all test suites.\n',
  };
  for (const [name, out] of Object.entries(outs)) {
    const d = tmp();
    write(d, 'package.json', JSON.stringify({ scripts: { test: name } }));
    const r = gate(['verify'], d, env({ PATH: fakePath('npm', out) }));
    assert.deepEqual(gateLines(r.out), ['tests: none found (npm test --silent, 0 tests ran)', 'gate: PASS (no tests found, no checks given)'], `${name}: ${r.out}`);
  }
});

// ---- Item 2: one Go suite per module ----

const subMod = (name, body) => ({ [`${name}/go.mod`]: `module ${name.split('/').pop()}\ngo 1.21\n`, [`${name}/s_test.go`]: `package ${name.split('/').pop()}\nimport "testing"\n${body}\n` });
const BOOM = 'func TestF(t *testing.T) { t.Fatal("boom") }';
const FINE = 'func TestOK(t *testing.T) {}';

test('a nested Go module is its own suite: root passing and nested failing is FAIL naming the nested module; a check go test ./... is the root suite', (t) => {
  const d = goDir({ 'm_test.go': goTest(FINE), ...subMod('sub', BOOM) });
  assert.deepEqual(detectTests(d), { cmd: 'go', args: ['test', './...'], more: [{ cmd: 'go', args: ['test', './...'], dir: 'sub', label: 'go test ./... (in sub)' }] });
  if (!hasGo) return t.skip('go not installed');
  const r = gate(['verify'], d, env());
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(gateLines(r.out), ['tests: PASS (go test ./..., 1 passed)', 'tests: FAIL (go test ./... (in sub), 1 failed)', 'gate: FAIL']);
  assert.match(r.out, /^\| s_test\.go:3: boom$/m, r.out);
  // a check identical to the test command is the root module's suite (ran once), not the nested one
  const c = gate(['verify', '--', 'go', 'test', './...'], d, env());
  assert.match(c.out, /^check: PASS \(go test \.\/\.\.\., same as the test suite above: ran once\)$/m, c.out);
  assert.match(c.out, /^gate: FAIL$/m, c.out);
});

test('Go: only a nested module (no go.mod at the root) runs it; one under vendor/, testdata/ or _x/ is ignored', (t) => {
  const only = tmp();
  for (const [k, v] of Object.entries(subMod('svc/api', FINE))) write(only, k, v);
  assert.deepEqual(detectTests(only), { cmd: 'go', args: ['test', './...'], dir: 'svc/api', label: 'go test ./... (in svc/api)' });
  const ignored = goDir({ 'm_test.go': goTest(FINE), ...subMod('vendor/x', BOOM), ...subMod('testdata/y', BOOM), ...subMod('_old/z', BOOM), ...subMod('.hidden/w', BOOM) });
  assert.deepEqual(detectTests(ignored), { cmd: 'go', args: ['test', './...'] });
  const none = tmp();
  for (const [k, v] of Object.entries(subMod('testdata/y', BOOM))) write(none, k, v);
  assert.equal(detectTests(none), null);
  if (!hasGo) return t.skip('go not installed');
  assert.deepEqual(gateLines(gate(['verify'], only, env()).out), ['tests: PASS (go test ./... (in svc/api), 1 passed)', 'gate: PASS']);
  assert.deepEqual(gateLines(gate(['verify'], ignored, env()).out), ['tests: PASS (go test ./..., 1 passed)', 'gate: PASS']);
});

test('Go: a go.work workspace with two modules runs both', (t) => {
  const d = tmp();
  write(d, 'go.work', 'go 1.21\n\nuse (\n\t./a\n\t./b\n)\n');
  for (const [k, v] of Object.entries({ ...subMod('a', FINE), ...subMod('b', BOOM) })) write(d, k, v);
  assert.deepEqual(detectTests(d).more.map((s) => s.label), ['go test ./... (in b)']);
  if (!hasGo) return t.skip('go not installed');
  const r = gate(['verify'], d, env());
  assert.deepEqual(gateLines(r.out), ['tests: PASS (go test ./... (in a), 1 passed)', 'tests: FAIL (go test ./... (in b), 1 failed)', 'gate: FAIL'], r.out);
});

test('Go: a nested module folder name is printed cleaned, as other names are', () => {
  const d = goDir({ 'm_test.go': goTest(FINE), ...subMod('a\u001b[31mb', FINE) });
  const r = gate(['verify'], d, env({ PATH: fakePath('nothing', '') }));
  assert.match(r.out, /^tests: not run \(go test \.\/\.\.\. \(in a\\x1b\[31mb\): go not found\)$/m, r.out);
  assert.doesNotMatch(r.out, /\u001b/);
});

// ---- the test command as start and goal.md name it ----

test('start and goal.md name a nested Go module by its label, the folder name cleaned; the approved command stays go test', () => {
  const d = repo({ 'go.mod': MOD, 'm_test.go': goTest(FINE), ...subMod('sub', FINE) });
  assert.equal(testLabel(detectTests(d)), 'go test ./... and go test ./... (in sub)');
  const odd = 'a\nb`c';
  const w = repo({ 'go.mod': MOD, 'm_test.go': goTest(FINE), ...subMod(odd, FINE) });
  assert.equal(testLabel(detectTests(w)), 'go test ./... and go test ./... (in a\\nb`c)');
  const e = env();
  assert.match(gate(['start'], w, e).out, /^test command: go test \.\/\.\.\. and go test \.\/\.\.\. \(in a\\nb`c\)$/m);
  const g = gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], w, e);
  assert.equal(g.code, 0, g.out);
  assert.deepEqual(readAllow(w, e.JEFE_HOME).kinds.find((k) => k.name === 'tests').argv, ['go', 'test']);
  const brief = readFileSync(join(w, '.jefe', 'goal.md'), 'utf8');
  assert.match(brief, /^TESTS: go test \.\/\.\.\. and go test \.\/\.\.\. \(in a\\nb`c\)$/m, brief);
  assert.doesNotMatch(brief, /^b`c/m, brief);
});
