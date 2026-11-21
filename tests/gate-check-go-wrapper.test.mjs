// A check that reaches go test through another program (make, sh -c, env with an option, nice) prints go test's plain text, which says `ok <pkg>`
// (and with -v `--- PASS` for a parent test) also when every test or subtest was skipped, and only a `? <pkg> [no test files]` or coverage line
// when there is no test. Such a check is never a pass on that text, also when a line prefix (a pipe through sed, docker compose, turbo) comes
// before it: it is `none found` and does not stand for a check given. In a full run the project's own Go suite, read by its events, decides; a go
// test command given itself as the check is read by its events. A failure in the text (a failed test, a build or vet error) is a FAIL even when
// the wrapper exits 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gate, git, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const has = (cmd, ...args) => spawnSync(cmd, args).status === 0;
const hasGo = has('go', 'version');
const hasMake = has('make', '--version');
const env = (extra = {}) => ({ JEFE_HOME: tmp(), JEFE_HOST: 'r4host', JEFE_MODE: 'headless', GOTOOLCHAIN: 'local', GOPROXY: 'off', ...extra });
const gateLines = (out) => out.split('\n').filter((l) => /^(tests|check|gate|commit):/.test(l)).map((l) => l.replace(/, [\d.]+s\)$/, ')'));
const NONE_GATE = 'gate: PASS (no tests found, no checks given)';
const STAGE_ONLY = 'tests: full suite runs at the last stage (stage checks only)';
const STAGE_NONE = 'gate: INCOMPLETE (no checks given for this stage)';
const NOT_APPROVED = "tests: not run (the project's test suite was not approved at Go)";
const WHY = "go test's text does not say that a test ran: give the go test command itself as the check";
const none = (c) => `check: none found (${c.join(' ')}, ${WHY})`;
const SKIP = 'func TestA(t *testing.T) { t.Skip("later") }';
const OK = 'func TestA(t *testing.T) {}';
const BAD = 'func TestA(t *testing.T) { t.Fatal("boom") }';
const SUBSKIP = 'func TestP(t *testing.T) { t.Run("a", func(t *testing.T) { t.Skip("later") }) }';
const MAKEFILE = 'test:\n\tgo test ./...\n';
const VERBOSE = 'test:\n\tgo test -v ./...\n';
const COVER = 'test:\n\tgo test -cover ./...\n';
const MOD = 'module m\ngo 1.21\n';
// a committed git repo with these files
const commit = (files) => {
  const d = repo(files, { identity: true });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'go');
  return d;
};
// a Go module with one test file and a Makefile whose `test` target runs go test
const goRepo = (body, makefile = MAKEFILE) => commit({ 'go.mod': MOD, 'm_test.go': `package m\nimport "testing"\n${body}\n`, Makefile: makefile });
// a Go module with packages ./a and ./b (a from-scratch project whose ./b test is for a later stage)
const twoPkg = (a, b) =>
  commit({ 'go.mod': MOD, 'a/a_test.go': `package a\nimport "testing"\n${a}\n`, 'b/b_test.go': `package b\nimport "testing"\n${b.replace('TestA', 'TestB')}\n`, Makefile: 'test-a:\n\tgo test ./a/...\n' });
const WRAPPERS = [['make', 'test'], ['sh', '-c', 'go test ./...'], ['env', '-u', 'CI', 'go', 'test', './...'], ['nice', 'go', 'test', './...']];
const skipWhy = () => (!hasGo ? 'go not installed' : !hasMake ? 'make not installed' : null);
const stageGo = (cmd) => ['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-cmd', cmd, '--stage', 'one :: a', '--stage', 'two :: b'];

test("full run: a wrapped go test is none found; the project's Go suite decides the gate", (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  const skip = goRepo(SKIP);
  const ok = goRepo(OK);
  for (const c of WRAPPERS) {
    const label = c.join(' ');
    assert.deepEqual(gateLines(gate(['verify', '--', ...c], skip, env()).out), ['tests: none found (go test ./..., 0 tests ran, 1 skipped)', none(c), NONE_GATE], label);
    assert.deepEqual(gateLines(gate(['verify', '--', ...c], ok, env()).out), ['tests: PASS (go test ./..., 1 passed)', none(c), 'gate: PASS'], label);
  }
});

test('go test -v in a Makefile on a parent test whose subtests were all skipped: none found, no commit, no stage tick', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  const c = ['make', 'test'];
  const v = goRepo(SUBSKIP, VERBOSE);
  assert.deepEqual(gateLines(gate(['verify', '--', ...c], v, env()).out), ['tests: none found (go test ./..., 0 tests ran, 1 skipped)', none(c), NONE_GATE]);
  const e = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--allow-cmd', 'make test'], v, e).code, 0);
  write(v, 'README', 'change\n');
  const head = git(v, 'rev-parse', 'HEAD').trim();
  const fin = gate(['finish', '--plan', 'job', '--goal', 'g', '--commit', 'msg', '--', ...c], v, e);
  assert.match(fin.out, /^commit: skipped \(gate passed but nothing was tested\)$/m, fin.out);
  assert.equal(git(v, 'rev-parse', 'HEAD').trim(), head, 'no commit was made');
  const s = goRepo(SUBSKIP, VERBOSE);
  const se = env();
  assert.equal(gate(stageGo('make test'), s, se).code, 0);
  const st = gate(['finish', '--stage', '1', '--', ...c], s, se);
  assert.deepEqual(gateLines(st.out), [STAGE_ONLY, none(c), STAGE_NONE], st.out);
  assert.match(st.out, /^stage: 1\/2 NOT done/m, st.out);
});

test('finish --commit with only make test: commits when the Go suite passed a test, not when it was all skipped', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  for (const [body, commits] of [[SKIP, false], [OK, true]]) {
    const d = goRepo(body);
    const e = env();
    assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--allow-cmd', 'make test'], d, e).code, 0);
    write(d, 'README', 'change\n');
    const head = git(d, 'rev-parse', 'HEAD').trim();
    const fin = gate(['finish', '--plan', 'job', '--goal', 'g', '--commit', 'msg', '--', 'make', 'test'], d, e);
    assert.ok(fin.out.split('\n').includes(none(['make', 'test'])), fin.out);
    if (commits) {
      assert.match(fin.out, /^tests: PASS \(go test \.\/\.\.\., 1 passed, [\d.]+s\)$/m, fin.out);
      assert.match(fin.out, /^gate: PASS$/m, fin.out);
      assert.notEqual(git(d, 'rev-parse', 'HEAD').trim(), head, fin.out);
    } else {
      assert.match(fin.out, /^commit: skipped \(gate passed but nothing was tested\)$/m, fin.out);
      assert.doesNotMatch(fin.out, /^gate: PASS$/m, fin.out);
      assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'no commit was made');
    }
  }
});

test('stage-only run: a wrapped go test alone gives no check for the stage, whether the tests passed or were skipped', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  for (const body of [SKIP, OK]) {
    const d = goRepo(body);
    const e = env();
    assert.equal(gate(stageGo('make test'), d, e).code, 0);
    for (const c of WRAPPERS) {
      const r = gate(['verify', '--stage', '1', '--', ...c], d, e);
      assert.equal(r.code, 4, r.out);
      assert.deepEqual(gateLines(r.out), [STAGE_ONLY, none(c), STAGE_NONE], c.join(' '));
    }
    assert.match(gate(['finish', '--stage', '1', '--', 'make', 'test'], d, e).out, /^stage: 1\/2 NOT done/m);
  }
});

test("stage-only run: go test ./a/... given itself is judged by ./a's events alone, whatever ./b does", (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  const c = ['go', 'test', './a/...'];
  const pass = twoPkg(OK, BAD);
  const pe = env();
  assert.equal(gate(stageGo('go test ./a/...'), pass, pe).code, 0);
  assert.deepEqual(gateLines(gate(['verify', '--stage', '1', '--', 'make', 'test-a'], pass, pe).out), [STAGE_ONLY, none(['make', 'test-a']), STAGE_NONE]);
  const fin = gate(['finish', '--stage', '1', '--', ...c], pass, pe);
  assert.deepEqual(gateLines(fin.out), [STAGE_ONLY, 'check: PASS (go test ./a/..., approved at Go, 1 passed, exit 0)', 'gate: PASS'], fin.out);
  assert.match(fin.out, /^stage: 1\/2 done; next: 2 two$/m, fin.out);
  const skip = twoPkg(SKIP, OK);
  const se = env();
  assert.equal(gate(stageGo('go test ./a/...'), skip, se).code, 0);
  const r = gate(['finish', '--stage', '1', '--', ...c], skip, se);
  assert.deepEqual(gateLines(r.out), [STAGE_ONLY, 'check: none found (go test ./a/..., ran no test)', STAGE_NONE], r.out);
  assert.match(r.out, /^stage: 1\/2 NOT done/m, r.out);
});

test('the tests kind not approved at Go: an approved wrapped check is none found and the gate line says nothing was tested', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  for (const body of [SKIP, OK]) {
    const d = goRepo(body);
    const e = env();
    assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'make test'], d, e).code, 0);
    assert.deepEqual(gateLines(gate(['verify', '--', 'make', 'test'], d, e).out), [NOT_APPROVED, none(['make', 'test']), 'gate: PASS (tests not run, no checks given)']);
  }
});

test('a failing test behind a wrapper that ignores the exit code is FAIL, in a full and in a stage-only run', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  for (const [makefile, c] of [['test:\n\t-go test ./...\n', ['make', 'test']], [MAKEFILE, ['sh', '-c', 'go test ./... || true']]]) {
    const label = c.join(' ');
    const d = goRepo(BAD, makefile);
    const full = gate(['verify', '--', ...c], d, env());
    assert.equal(full.code, 1, full.out);
    assert.deepEqual(gateLines(full.out), ['tests: FAIL (go test ./..., 1 failed)', `check: FAIL (${label}, 1 failed, exit 0)`, 'gate: FAIL'], full.out);
    assert.match(full.out, /^\| .*boom/m, full.out);
    const e = env();
    assert.equal(gate(stageGo('make test'), d, e).code, 0);
    const st = gate(['verify', '--stage', '1', '--', ...c], d, e);
    assert.equal(st.code, 1, st.out);
    assert.deepEqual(gateLines(st.out), [STAGE_ONLY, `check: FAIL (${label}, 1 failed, exit 0)`, 'gate: FAIL'], st.out);
  }
});

test('go test package lines from a project with no Go suite are none found', () => {
  const d = tmp();
  write(d, 'notes.txt', 'x\n');
  const r = gate(['verify', '--', 'echo', 'ok  m 0.1s'], d, env());
  assert.deepEqual(gateLines(r.out), ['tests: none found', none(['echo', 'ok  m 0.1s']), NONE_GATE], r.out);
});

test("output that also carries another runner's report: a passed test there is a PASS, none is none found", (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  const d = goRepo(SKIP);
  const ran = ['sh', '-c', 'go test ./...; echo "1 passed in 0.01s"'];
  assert.deepEqual(gateLines(gate(['verify', '--', ...ran], d, env()).out).slice(1), [`check: PASS (${ran.join(' ')}, 1 passed, exit 0)`, 'gate: PASS']);
  // 0 passed there: go test's text is in the output, so it is not a pass on it
  const skipped = ['sh', '-c', 'go test ./...; echo "1 skipped in 0.01s"'];
  assert.deepEqual(gateLines(gate(['verify', '--', ...skipped], d, env()).out).slice(1), [none(skipped), NONE_GATE]);
});

test('a recognised report with a failed test is a FAIL although the wrapper exits 0, for another runner too', () => {
  const d = tmp();
  write(d, 'a.test.js', "require('node:test')('bad', () => { throw new Error('boom'); });\n");
  const c = ['sh', '-c', 'node --test; true'];
  const r = gate(['verify', '--', ...c], d, env());
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^check: FAIL \(sh -c node --test; true, 1 failed, .*exit 0\)$/m, r.out);
  assert.match(r.out, /^gate: FAIL$/m, r.out);
});

// a Go module with code and no test file: go test prints only `?   \tm\t[no test files]`
const noTests = (makefile = MAKEFILE) => commit({ 'go.mod': MOD, 'm.go': 'package m\n', Makefile: makefile });
// go test's lines behind a per-line prefix, as a pipe, docker compose and turbo print them
const PREFIXED = [
  "test:\n\tgo test ./... 2>&1 | sed 's/^/  /'\n",
  "test:\n\tgo test -v ./... 2>&1 | sed 's/^/app-1  | /'\n",
  "test:\n\tgo test ./... 2>&1 | sed 's/^/m:test: /'\n",
  "test:\n\tgo test -v ./... 2>&1 | sed 's/^/m:test: /'\n",
];

test('a module with no test files through make test, also with -cover: none found, no commit, no stage tick', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  const c = ['make', 'test'];
  for (const makefile of [MAKEFILE, VERBOSE, COVER]) {
    const d = noTests(makefile);
    const e = env();
    assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--allow-cmd', 'make test'], d, e).code, 0);
    write(d, 'README', 'change\n');
    const head = git(d, 'rev-parse', 'HEAD').trim();
    const fin = gate(['finish', '--plan', 'job', '--goal', 'g', '--commit', 'msg', '--', ...c], d, e);
    assert.deepEqual(gateLines(fin.out).slice(0, 4), ['tests: none found', none(c), 'commit: skipped (gate passed but nothing was tested)', NONE_GATE], fin.out);
    assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'no commit was made');
    const s = noTests(makefile);
    const se = env();
    assert.equal(gate(stageGo('make test'), s, se).code, 0);
    const st = gate(['finish', '--stage', '1', '--', ...c], s, se);
    assert.equal(st.code, 4, st.out);
    assert.deepEqual(gateLines(st.out), [STAGE_ONLY, none(c), STAGE_NONE], st.out);
    assert.match(st.out, /^stage: 1\/2 NOT done/m, st.out);
  }
});

test("go test's lines behind a line prefix are none found, on skipped tests and on passing ones; a build is a pass by its exit code", (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  const c = ['make', 'test'];
  for (const makefile of PREFIXED) {
    const skip = goRepo(makefile.includes('-v') ? SUBSKIP : SKIP, makefile);
    assert.deepEqual(gateLines(gate(['verify', '--', ...c], skip, env()).out), ['tests: none found (go test ./..., 0 tests ran, 1 skipped)', none(c), NONE_GATE], makefile);
    const ok = goRepo(OK, makefile);
    assert.deepEqual(gateLines(gate(['verify', '--', ...c], ok, env()).out), ['tests: PASS (go test ./..., 1 passed)', none(c), 'gate: PASS'], makefile);
  }
  const b = goRepo(SKIP, 'build:\n\tgo build ./...\n');
  assert.deepEqual(gateLines(gate(['verify', '--', 'make', 'build'], b, env()).out).slice(1), ['check: PASS (make build, exit 0)', 'gate: PASS']);
});

test('a Makefile that runs go test and pytest: 3 passed is a PASS, unless go test reported a failure', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  if (!has('python3', '-m', 'pytest', '--version')) return t.skip('pytest not installed');
  const tests = 'def test_a(): pass\ndef test_b(): pass\ndef test_c(): pass\n';
  const d = commit({ 'go.mod': MOD, 'm_test.go': `package m\nimport "testing"\n${SKIP}\n`, 'test_x.py': tests, Makefile: 'test:\n\tgo test ./...\n\tpython3 -m pytest -q -p no:cacheprovider test_x.py\n' });
  const r = gate(['verify', '--', 'make', 'test'], d, env());
  assert.match(r.out, /^check: PASS \(make test, 3 passed, exit 0\)$/m, r.out);
  assert.match(r.out, /^gate: PASS$/m, r.out);  // go test's failure, ignored by make, is a FAIL although the pytest after it passed
  const f = commit({ 'go.mod': MOD, 'm_test.go': `package m\nimport "testing"\n${BAD}\n`, 'test_x.py': tests, Makefile: 'test:\n\t-go test ./...\n\tpython3 -m pytest -q -p no:cacheprovider test_x.py\n' });
  const fr = gate(['verify', '--', 'make', 'test'], f, env());
  assert.equal(fr.code, 1, fr.out);
  assert.match(fr.out, /^check: FAIL \(make test, 3 passed, exit 0\)$/m, fr.out);
});

test('a wrapper that retries go test and prints the failed first run is FAIL', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  // the test fails once when FLAG names a file that does not exist yet; the project's own suite runs without FLAG and passes
  const body = 'func TestA(t *testing.T) {\n\tf := os.Getenv("FLAG")\n\tif f == "" { return }\n\tif _, err := os.Stat(f); err != nil { os.WriteFile(f, nil, 0o644); t.Fatal("flaky") }\n}';
  const d = commit({ 'go.mod': MOD, 'm_test.go': `package m\nimport (\n\t"os"\n\t"testing"\n)\n${body}\n`, Makefile: 'test:\n\tFLAG=$(CURDIR)/.flag go test -count=1 ./... || FLAG=$(CURDIR)/.flag go test -count=1 ./...\n' });
  const r = gate(['verify', '--', 'make', 'test'], d, env());
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(gateLines(r.out).slice(1), ['check: FAIL (make test, 1 failed, exit 0)', 'gate: FAIL'], r.out);
});

test('go test -cover through make on a passing project: none found; the Go suite decides the gate', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  const c = ['make', 'test'];
  const d = goRepo(OK, COVER);
  assert.deepEqual(gateLines(gate(['verify', '--', ...c], d, env()).out), ['tests: PASS (go test ./..., 1 passed)', none(c), 'gate: PASS']);
});

test('a build failure behind a wrapper that ignores the exit code is FAIL, in a full and in a stage-only run', (t) => {
  if (skipWhy()) return t.skip(skipWhy());
  for (const [makefile, c] of [['test:\n\t-go test ./...\n', ['make', 'test']], [MAKEFILE, ['sh', '-c', 'go test ./... || true']]]) {
    const label = c.join(' ');
    const d = goRepo('func TestA(t *testing.T) { _ = undefinedThing }', makefile);
    const full = gate(['verify', '--', ...c], d, env());
    assert.equal(full.code, 1, full.out);
    assert.deepEqual(gateLines(full.out).slice(1), [`check: FAIL (${label}, exit 0)`, 'gate: FAIL'], full.out);
    assert.match(full.out, /^\| .*undefinedThing/m, full.out);
    const e = env();
    assert.equal(gate(stageGo('make test'), d, e).code, 0);
    const st = gate(['finish', '--stage', '1', '--', ...c], d, e);
    assert.equal(st.code, 1, st.out);
    assert.deepEqual(gateLines(st.out), [STAGE_ONLY, `check: FAIL (${label}, exit 0)`, 'gate: FAIL'], st.out);
    assert.match(st.out, /^stage: 1\/2 NOT done/m, st.out);
  }
});

test("another tool's ok line (deno's summary) is not go test's text: the check passes as it did", () => {
  const d = tmp();
  write(d, 'notes.txt', 'x\n');
  const c = ['sh', '-c', 'echo "running 1 test from ./a_test.ts"; echo "adds ... ok (0ms)"; echo; echo "ok | 1 passed | 0 failed (1ms)"'];
  const r = gate(['verify', '--', ...c], d, env());
  assert.match(r.out, /^check: PASS \(/m, r.out);
  assert.doesNotMatch(r.out, /go test's text/, r.out);
  assert.match(r.out, /^gate: PASS$/m, r.out);
});
