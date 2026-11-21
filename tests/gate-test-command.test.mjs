// The test command the gate names (goal file, report) exists in the project; the check approved at Go is named when nothing else can be;
// the report lines say plainly that the project's suite was not run and the approved check was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { detectTests, goRanNothing, scriptRunsPytest } from '../lib/gate/tests.mjs';
import { cleanLines, parseRun } from '../hooks/summarize.mjs';
import { withReport } from '../lib/gate/report.mjs';
import { gate, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const env = () => ({ JEFE_HOME: tmp(), JEFE_HOST: 'r4host', JEFE_MODE: 'headless' });
const SCRIPT_TEST = 'import sys\n\ndef expect(c):\n    assert c\n\ndef run():\n    expect(1 + 1 == 2)\n    return 0\n\nif __name__ == "__main__":\n    sys.exit(run())\n';
const NOT_APPROVED = "tests: not run (the project's test suite was not approved at Go)";

test('a test_*.py script that pytest collects nothing from is not a pytest setup; a real one is', (t) => {
  if (!hasPython) return t.skip('python3 not installed');
  const d = tmp();
  write(d, 'scripts/test_redaction.py', SCRIPT_TEST);
  write(d, 'requirements.txt', 'fastapi\n');
  mkdir(d, 'tests');
  assert.equal(detectTests(d), null);
  write(d, 'tests/test_api.py', 'def test_ok():\n    assert True\n');
  assert.deepEqual(detectTests(d), { cmd: 'python3', args: ['-m', 'pytest', '-q'], pytest: true });
  const c = tmp();
  write(c, 'pytest.ini', '[pytest]\n');
  assert.equal(detectTests(c).cmd, 'python3');
});

test('go.mod with no _test.go file names no test command', () => {
  const d = tmp();
  write(d, 'go.mod', 'module x\n');
  write(d, 'main.go', 'package main\n');
  assert.equal(detectTests(d), null);
  write(d, 'main_test.go', 'package main\n');
  assert.equal(detectTests(d).cmd, 'go');
});

test('a Python project with only a script test: the report names the check approved at Go, and the lines say what ran', (t) => {
  if (!hasPython) return t.skip('python3 not installed');
  const d = repo({ 'scripts/test_redaction.py': SCRIPT_TEST, 'requirements.txt': 'fastapi\n' });
  const e = env();
  const g = gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'python3 scripts/test_redaction.py'], d, e);
  assert.equal(g.code, 0, g.out + g.err);
  write(d, 'scripts/extra.py', 'X = 1\n');
  const r = gate(['finish', '--plan', 'job', '--goal', 'g', '--', 'python3', 'scripts/test_redaction.py'], d, e);
  const paste = r.out.slice(r.out.lastIndexOf('paste:'));
  assert.match(paste, /^skipped: project test suite \(not approved at Go\); run the check yourself: python3 scripts\/test_redaction\.py$/m, r.out);
  assert.ok(paste.split('\n').includes(NOT_APPROVED), r.out);
  assert.match(paste, /^check: PASS \(python3 scripts\/test_redaction\.py, approved at Go, exit 0\)$/m, r.out);
  assert.doesNotMatch(r.out, /pytest/);
  assert.match(paste, /^gate: PASS$/m); // no test command detected: no suite was left out
});

test('go accepts --allow-cmd "sh lint.sh" (a project script run by sh), and the gate runs it as a check approved at Go, as it does a python3 script', () => {
  const d = repo({ 'lint.sh': 'exit 0\n', 'requirements.txt': 'fastapi\n' });
  const e = env();
  const g = gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'sh lint.sh'], d, e);
  assert.equal(g.code, 0, g.out + g.err);
  write(d, 'app.py', 'X = 1\n');
  const r = gate(['finish', '--plan', 'job', '--goal', 'g', '--', 'sh', 'lint.sh'], d, e);
  assert.match(r.out, /^check: PASS \(sh lint\.sh, approved at Go, exit 0\)$/m, r.out);
  const bad = gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'sh -c "exit 0"'], d, e);
  assert.equal(bad.code, 2, bad.out + bad.err);
  assert.match(bad.out + bad.err, /--allow-cmd "sh -c .{0,12}" refused: "sh" starts a shell/);
});

test('a project with a real pytest setup still names pytest', (t) => {
  if (!hasPython) return t.skip('python3 not installed');
  const d = repo({ 'tests/test_api.py': 'def test_ok():\n    assert True\n' });
  const e = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd'], d, e).code, 0);
  write(d, 'app.py', 'X = 1\n');
  const r = gate(['finish', '--plan', 'job', '--goal', 'g'], d, e);
  assert.match(r.out, /^skipped: project test suite \(not approved at Go\); run it yourself: python3 -m pytest -q$/m, r.out);
});

test('nothing to name: the skipped line says so instead of guessing', () => {
  const wr = withReport([NOT_APPROVED, 'secrets: none found (1 files scanned)', 'gate: PASS'], { testCmd: null });
  assert.equal(wr.paste[0], 'skipped: project test suite (not approved at Go); no test command found to name');
});

function mkdir(d, rel) {
  write(d, `${rel}/.keep`, '');
}

test('a known suite is named even when a check was approved at Go; the check is offered only without one, named as a check', () => {
  const lines = [NOT_APPROVED, 'check: PASS (python3 x.py, approved at Go, exit 0)', 'gate: PASS'];
  assert.equal(withReport(lines, { testCmd: 'python3 -m pytest -q', checkCmd: 'python3 x.py' }).paste[0], 'skipped: project test suite (not approved at Go); run it yourself: python3 -m pytest -q');
  assert.equal(withReport(lines, { checkCmd: 'python3 x.py' }).paste[0], 'skipped: project test suite (not approved at Go); run the check yourself: python3 x.py');
});

test('more than 200 test files: the short command still runs only test files, never the plain modules next to them', () => {
  const d = tmp();
  for (let i = 0; i < 201; i++) write(d, `src/m${i}.test.js`, '');
  write(d, 'tests/helper.js', ''); // under tests/ but no node:test import: not a test file
  write(d, 'tests/sub/deep.mjs', "import { test } from 'node:test';\ntest('deep', () => {});\n"); // imports node:test: a test file, named on its own
  write(d, 'tests/notes.mjs', 'process.exit(1);\n'); // under tests/, no node:test import: never run
  write(d, 'tests/data.cjs', 'process.exit(1);\n'); // not a test file by the detector (.cjs only counts with .test/.spec)
  write(d, 'src/plain.js', 'process.exit(1);\n');
  write(d, 'src/lib/util.mjs', 'process.exit(1);\n');
  write(d, 'src/lib/old.cjs', 'process.exit(1);\n');
  const t = detectTests(d);
  assert.ok(t.args.length < 20, t.args.join(' '));
  const { NODE_TEST_CONTEXT: _c, ...childEnv } = process.env; // a node --test run inside this test reports to the outer runner otherwise
  const r = spawnSync(t.cmd, t.args, { cwd: d, env: childEnv, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `${t.args.join(' ')}\n${r.stdout.slice(-2000)}`);
  // 201 test-named files and tests/sub/deep.mjs; tests/helper.js is not a test file any more (no node:test import)
  assert.match(r.stdout, /^(?:ℹ|#) tests 202$/m, r.stdout.slice(-500)); // the spec reporter prints `ℹ`, the TAP reporter (Node 22's default when not on a terminal) `#`
});

// ---- no detected suite is skipped, and a file that is not a test never counts as a passed test ----
const NODE_OK = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const PY_BAD = 'def test_bad():\n    assert False\n';
const gateLines = (out) => out.split('\n').filter((l) => /^(tests|gate):/.test(l));

test('a Python project with a data .js file under tests/ runs pytest, and its failing test fails the gate', (t) => {
  if (spawnSync('python3', ['-m', 'pytest', '--version']).status !== 0) return t.skip('pytest not installed');
  const d = tmp();
  write(d, 'pytest.ini', '[pytest]\n');
  write(d, 'tests/test_x.py', PY_BAD);
  write(d, 'tests/fixtures/payload.js', 'module.exports = { sample: 1 };\n');
  assert.deepEqual(detectTests(d), { cmd: 'python3', args: ['-m', 'pytest', '-q'], pytest: true });
  const r = gate(['verify'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^tests: FAIL \(python3 -m pytest -q, 1 failed/m, r.out);
  assert.doesNotMatch(r.out, /node --test/);
  assert.match(r.out, /^gate: FAIL$/m);
});

test('a Node test file and a failing pytest file: both suites run, each with its own tests: line, and the gate fails', (t) => {
  if (spawnSync('python3', ['-m', 'pytest', '--version']).status !== 0) return t.skip('pytest not installed');
  const d = tmp();
  write(d, 'a.test.mjs', NODE_OK);
  write(d, 'test_bad.py', PY_BAD);
  const r = gate(['verify'], d);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(gateLines(r.out).map((l) => l.replace(/, [\d.]+s\)$/, ')')), ['tests: PASS (node --test (1 file), 1 passed)', 'tests: FAIL (python3 -m pytest -q, 1 failed, 0 passed)', 'gate: FAIL']);
  write(d, 'test_bad.py', 'def test_ok():\n    assert True\n');
  const ok = gate(['verify'], d);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(gateLines(ok.out).length, 3, ok.out);
  assert.match(ok.out, /^gate: PASS$/m);
  assert.equal(detectTests(d).more.length, 1);
});

test('a lone helper under tests/ is not a test file; a test-named file with no test in it does not read as passed', () => {
  const d = tmp();
  write(d, 'tests/helper.mjs', 'export const x = 1;\n');
  assert.equal(detectTests(d), null);
  const r = gate(['verify'], d);
  assert.match(r.out, /^tests: none found$/m, r.out);
  assert.doesNotMatch(r.out, /passed/);
  write(d, 'tests/runs.mjs', "import { test } from 'node:test';\ntest('ok', () => {});\n");
  assert.deepEqual(detectTests(d).args.slice(1), ['tests/runs.mjs']);
  const e = tmp();
  write(e, 'empty.test.mjs', 'export const x = 1;\n');
  const none = gate(['verify'], e);
  assert.match(none.out, /^tests: none found \(node --test \(1 file\), 1 file with no test\)$/m, none.out);
  assert.match(none.out, /^gate: PASS \(no tests found, no checks given\)$/m);
  write(e, 'real.test.mjs', NODE_OK);
  const mixed = gate(['verify'], e);
  assert.match(mixed.out, /^tests: PASS \(node --test \(2 files\), 1 passed, 1 file with no test, [\d.]+s\)$/m, mixed.out);
});

test('a Node-only project is unchanged: one node --test line', () => {
  const d = tmp();
  write(d, 'a.test.mjs', NODE_OK);
  write(d, 'test/b.js', "const { test } = require('node:test');\ntest('b', () => {});\n");
  const r = gate(['verify'], d);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(gateLines(r.out).map((l) => l.replace(/, [\d.]+s\)$/, ')')), ['tests: PASS (node --test (2 files), 2 passed)', 'gate: PASS']);
});

test('an npm script that only mentions pytest does not stop pytest; one that runs it does', (t) => {
  for (const s of ['pytest', 'pytest -q tests', 'CI=1 pytest', 'npx pytest', 'uv run pytest -x', 'poetry run py.test', 'pipenv run pytest', 'python -m pytest', 'python3 -m pytest', 'node build.js && pytest', 'eslint . || pytest', 'tsc; pytest', 'cat x | pytest']) assert.equal(scriptRunsPytest(s), true, s);
  for (const s of ['echo run pytest yourself', 'node -e 0', 'pytest-watch', 'echo pytest', 'make pytest', 'python3 -m unittest', 'run-pytest']) assert.equal(scriptRunsPytest(s), false, s);
  const d = tmp();
  write(d, 'pytest.ini', '[pytest]\n');
  write(d, 'test_x.py', PY_BAD);
  write(d, 'package.json', JSON.stringify({ scripts: { test: 'echo run pytest yourself' } }));
  assert.deepEqual(detectTests(d).more, [{ cmd: 'python3', args: ['-m', 'pytest', '-q'], pytest: true }]);
  write(d, 'package.json', JSON.stringify({ scripts: { test: 'python3 -m pytest' } }));
  assert.equal(detectTests(d).more, undefined);
  if (spawnSync('python3', ['-m', 'pytest', '--version']).status !== 0) return t.skip('pytest not installed');
  write(d, 'package.json', JSON.stringify({ scripts: { test: 'echo run pytest yourself' } }));
  const r = gate(['verify'], d);
  assert.match(r.out, /^tests: FAIL \(python3 -m pytest -q/m, r.out);
  assert.match(r.out, /^gate: FAIL$/m);
});

test('a node:test import after the first 64 KB is found; files the gate could not check are named in a note', () => {
  const d = tmp();
  write(d, 'tests/big.js', `// ${'x'.repeat(70000)}\nconst { test } = require('node:test');\ntest('bad', () => { throw new Error('boom'); });\n`);
  write(d, 'a.test.js', NODE_OK);
  const r = gate(['verify'], d);
  assert.match(r.out, /^tests: FAIL \(node --test \(2 files\), 1 failed, 1 passed/m, r.out);
  assert.match(r.out, /^gate: FAIL$/m);
  // more than 1 MB with no import in the first 1 MB, and more candidates than the read cap
  const e = tmp();
  write(e, 'tests/huge.js', `// ${'x'.repeat(1100000)}\nconst { test } = require('node:test');\ntest('late', () => {});\n`);
  for (let i = 0; i < 2001; i++) write(e, `tests/z${String(i).padStart(4, '0')}.js`, `module.exports = ${i};\n`); // huge.js is read first, 2 of these are past the cap
  write(e, 'a.test.js', NODE_OK);
  const n = gate(['verify'], e);
  assert.match(n.out, /^note: 3 files under tests\/ were not checked for tests \(only the first 2000 are read; 1 longer than 1 MB with no node:test import in the first 1 MB\); name them \*\.test\.js to have them run$/m, n.out);
  assert.match(n.out, /^tests: PASS \(node --test \(1 file\)/m);
});

// ---- go test and cargo test run next to a Node suite ----
const hasGo = spawnSync('go', ['version']).status === 0;
const hasCargo = spawnSync('cargo', ['--version']).status === 0;
const GO_BAD = 'package m\nimport "testing"\nfunc TestBad(t *testing.T) { t.Fatal("boom") }\n';
const goProject = () => {
  const d = tmp();
  write(d, 'go.mod', 'module m\ngo 1.21\n');
  write(d, 'm_test.go', GO_BAD);
  return d;
};

test('a Go module with a failing test and a package.json test script: go test runs too and the gate fails', (t) => {
  const d = goProject();
  write(d, 'package.json', JSON.stringify({ scripts: { test: 'node -e 0' } }));
  assert.deepEqual([detectTests(d).cmd, detectTests(d).more.map((s) => s.cmd)], ['npm', ['go']]);
  if (!hasGo) return t.skip('go not installed');
  const r = gate(['verify'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^tests: PASS \(npm test --silent/m, r.out);
  assert.match(r.out, /^tests: FAIL \(go test \.\/\.\.\./m, r.out);
  assert.match(r.out, /^gate: FAIL$/m);
});

test('a Go module with a failing test and a web/app.test.js: both run and the gate fails; a Go-only module is unchanged', (t) => {
  const d = goProject();
  write(d, 'web/app.test.js', NODE_OK);
  assert.equal(detectTests(d).more[0].cmd, 'go');
  const only = goProject();
  assert.deepEqual(detectTests(only), { cmd: 'go', args: ['test', './...'] });
  if (!hasGo) return t.skip('go not installed');
  const r = gate(['verify'], d);
  assert.match(r.out, /^tests: PASS \(node --test \(1 file\)/m, r.out);
  assert.match(r.out, /^tests: FAIL \(go test/m, r.out);
  assert.match(r.out, /^gate: FAIL$/m);
  const o = gate(['verify'], only);
  assert.deepEqual(gateLines(o.out).map((l) => l.replace(/\(go test \.\/\.\.\., .*$/, '(go test ./...')), ['tests: FAIL (go test ./...', 'gate: FAIL'], o.out);
});

test('a Go module whose only _test.go files are in vendor/, testdata/, _x/ or .x/ has no Go suite; one with tests in a subpackage runs them', (t) => {
  const d = tmp();
  write(d, 'go.mod', 'module m\ngo 1.21\n');
  write(d, 'm.go', 'package m\n');
  for (const dir of ['vendor/x', 'testdata', '_old', '.hidden']) write(d, `${dir}/x_test.go`, GO_BAD.replace('package m', 'package x'));
  assert.equal(detectTests(d), null);
  const r = gate(['verify'], d);
  assert.match(r.out, /^tests: none found$/m, r.out);
  write(d, 'sub/s_test.go', 'package sub\nimport "testing"\nfunc TestA(t *testing.T) {}\n');
  assert.deepEqual(detectTests(d), { cmd: 'go', args: ['test', './...'] });
  if (!hasGo) return t.skip('go not installed');
  // one package with tests, the root package with none: PASS with the count of tests that passed (from the go test -json events)
  assert.match(gate(['verify'], d).out, /^tests: PASS \(go test \.\/\.\.\., 1 passed, [\d.]+s\)$/m);
});

test('go test where every package says [no test files], and cargo test with 0 passed and 0 failed, ran nothing', (t) => {
  assert.equal(goRanNothing('?   \tm\t[no test files]\n?   \tm/sub\t[no test files]\n'), true);
  assert.equal(goRanNothing(''), true);
  assert.equal(goRanNothing('ok  \tm/sub\t0.1s [no tests to run]\n'), true);
  assert.equal(goRanNothing('?   \tm\t[no test files]\nok  \tm/sub\t0.139s\n'), false);
  assert.equal(goRanNothing('--- FAIL: TestBad (0.00s)\nFAIL\tm\t0.1s\n'), false);
  // captured cargo test output for a crate with no tests (cargo is not installed here): the counts are 0 passed, 0 failed, which reads as none found
  const cargo = '   Compiling x v0.1.0 (/tmp/x)\n    Finished test [unoptimized + debuginfo] target(s) in 0.5s\n     Running unittests src/main.rs (target/debug/deps/x-1)\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n';
  assert.deepEqual(parseRun(cleanLines(cargo)).counts, { passed: 0, failed: 0 });
  // a go module where nothing runs (its only _test.go file holds no test): the run itself reads as none found
  if (!hasGo) return t.skip('go not installed');
  const d = tmp();
  write(d, 'go.mod', 'module m\ngo 1.21\n');
  write(d, 'm.go', 'package m\n');
  write(d, 'm_test.go', 'package m\n');
  const r = gate(['verify'], d);
  assert.match(r.out, /^tests: none found \(go test \.\/\.\.\., 0 tests ran\)$/m, r.out);
});

test('a Cargo project with a JS test file: cargo test is tried too (not found here: INCOMPLETE); a Cargo-only project still names cargo test', () => {
  const d = tmp();
  write(d, 'Cargo.toml', '[package]\nname = "x"\nversion = "0.1.0"\n');
  write(d, 'b.test.js', NODE_OK);
  assert.equal(detectTests(d).more[0].cmd, 'cargo');
  const only = tmp();
  write(only, 'Cargo.toml', '[package]\nname = "x"\nversion = "0.1.0"\n');
  assert.deepEqual(detectTests(only), { cmd: 'cargo', args: ['test', '-q'] });
  const r = gate(['verify'], d, hasCargo ? { PATH: onlyGitPath() } : {});
  assert.match(r.out, /^tests: PASS \(node --test \(1 file\)/m, r.out);
  assert.match(r.out, /^tests: not run \(cargo test -q: cargo not found\)$/m, r.out);
  assert.match(r.out, /^gate: INCOMPLETE \(tests not run: cargo not found\)$/m);
});

// a PATH that holds git and nothing else (the gate itself runs on process.execPath)
function onlyGitPath() {
  const bin = tmp();
  symlinkSync(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(bin, 'git'));
  return bin;
}

test('a detected suite whose program is missing says so and the gate is INCOMPLETE, not a plain PASS', () => {
  const d = tmp();
  write(d, 'a.test.mjs', NODE_OK);
  write(d, 'test_bad.py', PY_BAD);
  const r = gate(['verify'], d, { PATH: onlyGitPath() });
  assert.equal(r.code, 4, r.out + r.err);
  assert.deepEqual(gateLines(r.out).map((l) => l.replace(/, [\d.]+s\)$/, ')')), ['tests: PASS (node --test (1 file), 1 passed)', 'tests: not run (python3 -m pytest -q: python3 not found)', 'gate: INCOMPLETE (tests not run: python3 not found)']);
  const py = tmp();
  write(py, 'test_bad.py', PY_BAD);
  const alone = gate(['verify'], py, { PATH: onlyGitPath() });
  assert.match(alone.out, /^tests: not run \(python3 -m pytest -q: python3 not found\)$/m, alone.out);
  assert.match(alone.out, /^gate: INCOMPLETE \(tests not run: python3 not found\)$/m);
});

test('a suite that ran no test (its only test is skipped) is none found, not PASS with 0 passed; next to a passing suite the gate is PASS', (t) => {
  const d = tmp();
  write(d, 'a.test.js', "const { test } = require('node:test');\ntest('s', { skip: true }, () => { throw new Error('x'); });\n");
  const r = gate(['verify'], d);
  assert.deepEqual(gateLines(r.out), ['tests: none found (node --test (1 file), 0 tests ran)', 'gate: PASS (no tests found, no checks given)'], r.out);
  if (spawnSync('python3', ['-m', 'pytest', '--version']).status !== 0) return t.skip('pytest not installed');
  write(d, 'test_ok.py', 'def test_ok():\n    assert True\n');
  const both = gate(['verify'], d);
  assert.deepEqual(gateLines(both.out).map((l) => l.replace(/, [\d.]+s\)$/, ')')), ['tests: none found (node --test (1 file), 0 tests ran)', 'tests: PASS (python3 -m pytest -q, 1 passed)', 'gate: PASS'], both.out);
});
