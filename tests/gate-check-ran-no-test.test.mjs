// A check that exits 0 but whose output is a test runner's report of 0 passed and 0 failed ran no test: `check: none found (<cmd>, ran no test)`,
// read like a same-as-suite check that ran no test. A `go test` check is run with -json and read by its events, as the Go suite is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { goTestCheck } from '../lib/gate/tests.mjs';
import { gate, git, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const has = (cmd, ...args) => spawnSync(cmd, args).status === 0;
const hasGo = has('go', 'version');
const hasNpm = has('npm', '--version');
const hasPytest = has('pytest', '--version') && has('python3', '-m', 'pytest', '--version'); // the check runs `pytest`, the suite `python3 -m pytest`: both must be there
const env = (extra = {}) => ({ JEFE_HOME: tmp(), JEFE_HOST: 'r4host', JEFE_MODE: 'headless', GOTOOLCHAIN: 'local', GOPROXY: 'off', ...extra });
const gateLines = (out) => out.split('\n').filter((l) => /^(tests|check|gate|commit):/.test(l)).map((l) => l.replace(/, [\d.]+s\)$/, ')'));
const NONE_GATE = 'gate: PASS (no tests found, no checks given)';
const SKIPPED_NODE = "const { test } = require('node:test');\ntest('s', { skip: true }, () => { throw new Error('x'); });\n";
const OK_NODE = "const { test } = require('node:test');\ntest('ok', () => {});\n";
const goProject = (body, imports = '"testing"') => {
  const d = tmp();
  write(d, 'go.mod', 'module m\ngo 1.21\n');
  write(d, 'm_test.go', `package m\nimport (${imports})\n${body}\n`);
  return d;
};
const GO_SPELLINGS = [['go', 'test', '-count=1', './...'], ['go', 'test', './...', '-v'], ['env', 'CI=1', 'go', 'test', './...'], ['go', 'test', '.']];

test('goTestCheck: -json is added to a go test call; -list, -c, -exec and other programs run as given; a -json already there is kept', () => {
  assert.deepEqual(goTestCheck(['go', 'test', './...', '-v']), ['go', 'test', '-json', './...', '-v']);
  assert.deepEqual(goTestCheck(['env', 'CI=1', 'go', 'test', '.']), ['env', 'CI=1', 'go', 'test', '-json', '.']);
  assert.deepEqual(goTestCheck(['/usr/local/go/bin/go', 'test', '-count=1', '.']), ['/usr/local/go/bin/go', 'test', '-json', '-count=1', '.']);
  assert.deepEqual(goTestCheck(['go', 'test', '-json', './...']), ['go', 'test', '-json', './...']);
  // what follows -args goes to the test binary, so it is not read as a go test flag
  assert.deepEqual(goTestCheck(['go', 'test', '.', '-args', '-c']), ['go', 'test', '-json', '.', '-args', '-c']);
  for (const c of [['go', 'test', '-list', '.', '.'], ['go', 'test', '-c'], ['go', 'test', '-exec=x', '.'], ['go', 'test', '--exec', 'x', '.'], ['go', 'vet', './...'], ['env', '-i', 'go', 'test', '.'], ['node', '--test']]) {
    assert.equal(goTestCheck(c), null, c.join(' '));
  }
});

test('Go: other spellings of go test on a skipped-only module are none found and the gate says nothing was tested; with a real test they PASS', (t) => {
  if (!hasGo) return t.skip('go not installed');
  const skip = goProject('func TestA(t *testing.T) { t.Skip("later") }');
  const ok = goProject('func TestA(t *testing.T) {}');
  for (const c of GO_SPELLINGS) {
    const label = c.join(' ');
    assert.deepEqual(gateLines(gate(['verify', '--', ...c], skip, env()).out), ['tests: none found (go test ./..., 0 tests ran, 1 skipped)', `check: none found (${label}, ran no test)`, NONE_GATE], label);
    assert.deepEqual(gateLines(gate(['verify', '--', ...c], ok, env()).out), ['tests: PASS (go test ./..., 1 passed)', `check: PASS (${label}, 1 passed, exit 0)`, 'gate: PASS'], label);
  }
  // go vet is not read by events: a plain check, as before
  assert.deepEqual(gateLines(gate(['verify', '--', 'go', 'vet', './...'], skip, env()).out), ['tests: none found (go test ./..., 0 tests ran, 1 skipped)', 'check: PASS (go vet ./..., exit 0)', 'gate: PASS']);
});

test('Go: a go test check whose test fails under a TestMain that exits 0 is FAIL', (t) => {
  if (!hasGo) return t.skip('go not installed');
  const d = goProject('func TestOK(t *testing.T) {}\nfunc TestBad(t *testing.T) { t.Fatal("boom") }\nfunc TestMain(m *testing.M) { m.Run(); os.Exit(0) }', '"os"; "testing"');
  const r = gate(['verify', '--', 'go', 'test', '-count=1', './...'], d, env());
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(gateLines(r.out), ['tests: FAIL (go test ./..., 1 failed, 1 passed, exit 0)', 'check: FAIL (go test -count=1 ./..., 1 failed, 1 passed, exit 0)', 'gate: FAIL']);
  assert.ok(r.out.split('\n').filter((l) => l === '| ✖ TestBad').length === 2, r.out);
});

test('node --test, npm run test and pytest as checks on a skipped-only project are none found; with a real test they PASS', (t) => {
  const cases = [
    { check: ['node', '--test'], files: (s) => ({ 'a.test.js': s }), suite: 'node --test (1 file)' },
    ...(hasNpm ? [{ check: ['npm', 'run', 'test'], files: (s) => ({ 'a.test.js': s, 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }), suite: 'npm test --silent' }] : []),
    ...(hasPytest ? [{ check: ['pytest'], files: (s) => ({ 'test_a.py': s === OK_NODE ? 'def test_a():\n    pass\n' : 'import pytest\n@pytest.mark.skip\ndef test_a():\n    pass\n' }), suite: 'python3 -m pytest -q' }] : []),
  ];
  if (!hasNpm || !hasPytest) t.diagnostic('npm or pytest missing: those cases are left out');
  for (const k of cases) {
    const label = k.check.join(' ');
    const skip = tmp();
    for (const [f, v] of Object.entries(k.files(SKIPPED_NODE))) write(skip, f, v);
    assert.deepEqual(gateLines(gate(['verify', '--', ...k.check], skip, env()).out), [`tests: none found (${k.suite}, 0 tests ran)`, `check: none found (${label}, ran no test)`, NONE_GATE], label);
    const ok = tmp();
    for (const [f, v] of Object.entries(k.files(OK_NODE))) write(ok, f, v);
    assert.deepEqual(gateLines(gate(['verify', '--', ...k.check], ok, env()).out), [`tests: PASS (${k.suite}, 1 passed)`, `check: PASS (${label}, 1 passed, exit 0)`, 'gate: PASS'], label);
  }
});

test('a check with no test report is unchanged; text that reads as a runner report of 0 passed and 0 failed is none found, never a pass', () => {
  const d = tmp();
  write(d, 'lint.js', 'process.exit(0);\n');
  const e = env();
  assert.deepEqual(gateLines(gate(['verify', '--', 'node', '-e', '', '--', 'node', 'lint.js', '--', 'node', '-e', 'console.log("0 passed")'], d, e).out), ['tests: none found', 'check: PASS (node -e , exit 0)', 'check: PASS (node lint.js, exit 0)', 'check: PASS (node -e console.log("0 passed"), exit 0)', 'gate: PASS']);
  // cargo's summary line printed by something that is not cargo: read as cargo's report, so it errs toward none found
  const cargoish = 'console.log("test result: ok. 0 passed; 0 failed; 0 ignored")';
  assert.deepEqual(gateLines(gate(['verify', '--', 'node', '-e', cargoish], d, e).out), ['tests: none found', `check: none found (node -e ${cargoish}, ran no test)`, NONE_GATE]);
});

test('a check that ran no test next to a passing check or a passing suite: the gate is the plain PASS those give; alone in a stage it does not pass', () => {
  const d = tmp();
  write(d, 'a.test.js', SKIPPED_NODE);
  const e = env();
  assert.deepEqual(gateLines(gate(['verify', '--', 'node', '--test', '--', 'node', '-e', '0'], d, e).out), ['tests: none found (node --test (1 file), 0 tests ran)', 'check: none found (node --test, ran no test)', 'check: PASS (node -e 0, exit 0)', 'gate: PASS']);
  write(d, 'b.test.js', OK_NODE);
  assert.deepEqual(gateLines(gate(['verify', '--', 'node', '--test', 'a.test.js'], d, e).out), ['tests: PASS (node --test (2 files), 1 passed)', 'check: none found (node --test a.test.js, ran no test)', 'gate: PASS']);
  const s = repo({ 'a.test.js': SKIPPED_NODE });
  const se = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-cmd', 'node --test', '--stage', 'one :: a', '--stage', 'two :: b'], s, se).code, 0);
  const r = gate(['verify', '--stage', '1', '--', 'node', '--test'], s, se);
  assert.equal(r.code, 4, r.out);
  assert.deepEqual(gateLines(r.out), ['tests: full suite runs at the last stage (stage checks only)', 'check: none found (node --test, ran no test)', 'gate: INCOMPLETE (no checks given for this stage)']);
});

test('finish --commit whose only check ran no test does not commit', () => {
  const d = repo({ 'a.test.js': SKIPPED_NODE }, { identity: true });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'tests');
  const e = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--allow-cmd', 'node --test'], d, e).code, 0);
  write(d, 'README', 'change\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const fin = gate(['finish', '--plan', 'job', '--goal', 'g', '--commit', 'msg', '--', 'node', '--test'], d, e);
  assert.match(fin.out, /^check: none found \(node --test, ran no test\)$/m, fin.out);
  assert.match(fin.out, /^commit: skipped \(gate passed but nothing was tested\)$/m, fin.out);
  assert.match(fin.out, /^gate: PASS \(no tests found, no checks given\)$/m, fin.out);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'no commit was made');
});
