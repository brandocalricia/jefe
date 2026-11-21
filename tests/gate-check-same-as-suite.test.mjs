// A check identical to a detected test command is that suite: when the suite ran no test, the check says `none found` and does not count as a
// check that was given and passed (the gate line still says nothing was tested, a finish --commit does not commit, a stage does not pass).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate, git, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const hasGo = spawnSync('go', ['version']).status === 0;
const env = (extra = {}) => ({ JEFE_HOME: tmp(), JEFE_HOST: 'r4host', JEFE_MODE: 'headless', GOTOOLCHAIN: 'local', GOPROXY: 'off', ...extra });
const gateLines = (out) => out.split('\n').filter((l) => /^(tests|check|gate|commit):/.test(l)).map((l) => l.replace(/, [\d.]+s\)$/, ')'));
const SKIPPED_NODE = "const { test } = require('node:test');\ntest('s', { skip: true }, () => { throw new Error('x'); });\n";
const OK_NODE = "const { test } = require('node:test');\ntest('ok', () => {});\n";

// a PATH with git and one fake program that prints `out` and exits 0
function fakePath(name, out) {
  const bin = tmp();
  symlinkSync(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(bin, 'git'));
  writeFileSync(join(bin, 'out.txt'), out);
  writeFileSync(join(bin, name), `#!/bin/sh\n/bin/cat '${join(bin, 'out.txt')}'\nexit 0\n`, { mode: 0o755 });
  return bin;
}
const NONE_GATE = 'gate: PASS (no tests found, no checks given)';

test('node --test: the identical check on a suite that ran no test is none found and the gate still says nothing was tested; a real check next to it is a plain PASS', () => {
  const d = tmp();
  write(d, 'a.test.js', SKIPPED_NODE);
  const e = env();
  assert.deepEqual(gateLines(gate(['verify', '--', 'node', '--test', 'a.test.js'], d, e).out), ['tests: none found (node --test (1 file), 0 tests ran)', "check: none found (node --test a.test.js, the project's test command: 0 tests ran)", NONE_GATE]);
  // another check that passes: the documented limit (a plain PASS), the identical one still says none found
  assert.deepEqual(gateLines(gate(['verify', '--', 'node', '--test', 'a.test.js', '--', 'node', '-e', '0'], d, e).out), ['tests: none found (node --test (1 file), 0 tests ran)', "check: none found (node --test a.test.js, the project's test command: 0 tests ran)", 'check: PASS (node -e 0, exit 0)', 'gate: PASS']);
  // a suite that passes is still served once, as before
  write(d, 'a.test.js', OK_NODE);
  assert.deepEqual(gateLines(gate(['verify', '--', 'node', '--test', 'a.test.js'], d, e).out), ['tests: PASS (node --test (1 file), 1 passed)', 'check: PASS (node --test a.test.js, same as the test suite above: ran once)', 'gate: PASS']);
});

test('npm test, python3 -m pytest -q and cargo test -q as the identical check on a suite that ran no test: none found, nothing tested', () => {
  const cases = [
    { name: 'npm', files: { 'package.json': JSON.stringify({ scripts: { test: 'x' } }) }, out: 'ℹ tests 2\nℹ pass 0\nℹ fail 0\nℹ skipped 2\n', check: ['npm', 'test'], label: 'npm test --silent' },
    { name: 'python3', files: { 'test_a.py': 'def test_a():\n    pass\n' }, out: 'ss  [100%]\n2 skipped in 0.01s\n', check: ['python3', '-m', 'pytest', '-q'], label: 'python3 -m pytest -q' },
    { name: 'cargo', files: { 'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n' }, out: 'test result: ok. 0 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s\n', check: ['cargo', 'test', '-q'], label: 'cargo test -q' },
  ];
  for (const k of cases) {
    const d = tmp();
    for (const [f, v] of Object.entries(k.files)) write(d, f, v);
    const r = gate(['verify', '--', ...k.check], d, env({ PATH: fakePath(k.name, k.out) }));
    assert.deepEqual(gateLines(r.out), [`tests: none found (${k.label}, 0 tests ran)`, `check: none found (${k.check.join(' ')}, the project's test command: 0 tests ran)`, NONE_GATE], `${k.name}: ${r.out}`);
  }
});

test('go test ./... as the identical check: none found on a skipped-only module; with a nested module it stands only for the root one', (t) => {
  if (!hasGo) return t.skip('go not installed');
  const d = tmp();
  write(d, 'go.mod', 'module m\ngo 1.21\n');
  write(d, 'm_test.go', 'package m\nimport "testing"\nfunc TestA(t *testing.T) { t.Skip("later") }\n');
  assert.deepEqual(gateLines(gate(['verify', '--', 'go', 'test', './...'], d, env()).out), ['tests: none found (go test ./..., 0 tests ran, 1 skipped)', "check: none found (go test ./..., the project's test command: 0 tests ran, 1 skipped)", NONE_GATE]);
  write(d, 'sub/go.mod', 'module sub\ngo 1.21\n');
  write(d, 'sub/s_test.go', 'package sub\nimport "testing"\nfunc TestOK(t *testing.T) {}\n');
  assert.deepEqual(gateLines(gate(['verify', '--', 'go', 'test', './...'], d, env()).out), ['tests: none found (go test ./..., 0 tests ran, 1 skipped)', 'tests: PASS (go test ./... (in sub), 1 passed)', "check: none found (go test ./..., the project's test command: 0 tests ran, 1 skipped)", 'gate: PASS']);
});

test('finish --commit with only the identical check on a suite that ran no test does not commit', () => {
  const d = repo({ 'a.test.js': SKIPPED_NODE }, { identity: true });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'tests');
  const e = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-kind', 'git-commit', '--allow-cmd', 'node --test a.test.js'], d, e).code, 0);
  write(d, 'README', 'change\n');
  const head = git(d, 'rev-parse', 'HEAD').trim();
  const fin = gate(['finish', '--plan', 'job', '--goal', 'g', '--commit', 'msg', '--', 'node', '--test', 'a.test.js'], d, e);
  assert.match(fin.out, /^check: none found \(node --test a\.test\.js, the project's test command: 0 tests ran\)$/m, fin.out);
  assert.match(fin.out, /^commit: skipped \(gate passed but nothing was tested\)$/m, fin.out);
  assert.match(fin.out, /^gate: PASS \(no tests found, no checks given\)$/m, fin.out);
  assert.equal(git(d, 'rev-parse', 'HEAD').trim(), head, 'no commit was made');
});

test('a stage whose only check is the identical command on a suite that ran no test does not pass; with the tests kind not approved the gate says tests not run', () => {
  const d = repo({ 'a.test.js': SKIPPED_NODE });
  const e = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests', '--allow-cmd', 'node --test a.test.js', '--stage', 'one :: a', '--stage', 'two :: b'], d, e).code, 0);
  const r = gate(['verify', '--stage', '1', '--', 'node', '--test', 'a.test.js'], d, e);
  assert.equal(r.code, 4, r.out);
  assert.deepEqual(gateLines(r.out), ['tests: full suite runs at the last stage (stage checks only)', "check: none found (node --test a.test.js, the project's test command: 0 tests ran)", 'gate: INCOMPLETE (no checks given for this stage)']);
  // the same stage with a passing suite passes, the suite run as the check
  write(d, 'a.test.js', OK_NODE);
  const ok = gate(['verify', '--stage', '1', '--', 'node', '--test', 'a.test.js'], d, e);
  assert.deepEqual(gateLines(ok.out), ['tests: full suite runs at the last stage (stage checks only)', "check: PASS (node --test a.test.js, the project's test command, 1 passed)", 'gate: PASS'], ok.out);
  // the tests kind not approved: the check is still read as the suite
  const n = repo({ 'a.test.js': SKIPPED_NODE });
  const ne = env();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd', '--allow-cmd', 'node --test a.test.js'], n, ne).code, 0);
  assert.deepEqual(gateLines(gate(['verify', '--', 'node', '--test', 'a.test.js'], n, ne).out), ["tests: not run (the project's test suite was not approved at Go)", "check: none found (node --test a.test.js, the project's test command: 0 tests ran)", 'gate: PASS (tests not run, no checks given)']);
});
