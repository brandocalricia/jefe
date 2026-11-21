import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gate, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const pkg = (dir, test) => write(dir, 'package.json', JSON.stringify({ name: 'x', version: '1.0.0', scripts: test === undefined ? {} : { test } }));

test('tests: passing package prints PASS and exits 0', () => {
  const d = tmp();
  pkg(d, 'node -e "process.exit(0)"');
  const r = gate(['tests'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out.trim(), /^tests: PASS \(npm test --silent, [\d.]+s\)$/);
});

test('tests: failing package of unknown format prints FAIL, head 20 and tail 40, the log path, exits 1', () => {
  const d = tmp();
  const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
  write(d, 'fail.js', `${JSON.stringify(lines)}.forEach((l) => console.log(l)); process.exitCode = 3;\n`);
  pkg(d, 'node fail.js');
  const r = gate(['tests'], d);
  assert.equal(r.code, 1);
  assert.match(r.out, /^tests: FAIL \(npm test --silent, /);
  assert.match(r.out, /^\| line100$/m);
  assert.match(r.out, /^\| line1$/m);
  assert.ok(!/^\| line50$/m.test(r.out), 'the middle is left out');
  assert.match(r.out, /^\| \.\.\. \d+ more lines omitted \(full log: \.jefe\/logs\/\S+\.log\)$/m);
});

test('tests: none found, and the npm default "no test specified" does not count', () => {
  const d = tmp();
  let r = gate(['tests'], d);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'tests: none found');
  pkg(d, 'echo "Error: no test specified" && exit 1');
  r = gate(['tests'], d);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'tests: none found');
});

test('tests: timeout kills a sleeping script, TIMEOUT exits 1', () => {
  const d = tmp();
  pkg(d, 'node -e "setTimeout(() => {}, 60000)"');
  const t0 = Date.now();
  const r = gate(['tests', '--timeout', '1'], d);
  assert.equal(r.code, 1);
  assert.match(r.out, /^tests: TIMEOUT \(npm test --silent, 1(\.\d)?s\)/);
  assert.ok(Date.now() - t0 < 15000);
});

test('tests: bad --timeout is a usage error', () => {
  const r = gate(['tests', '--timeout', 'abc'], tmp());
  assert.equal(r.code, 2);
});

// ---- discovery without a package.json ----

test('tests: lone util.test.js with no package.json runs node --test and passes', () => {
  const d = repo({ 'util.js': 'export const x = 1;\n', 'util.test.js': "const { test } = require('node:test');\ntest('ok', () => {});\n" });
  const r = gate(['tests'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out.trim(), /^tests: PASS \(node --test \(1 file\), 1 passed, [\d.]+s\)$/);
});

test('tests: failing node test file is FAIL with the tail of the output', () => {
  const d = tmp();
  write(d, 'bad.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('boom', () => assert.equal(1, 2));\n");
  const r = gate(['tests'], d);
  assert.equal(r.code, 1);
  assert.match(r.out, /^tests: FAIL \(node --test/);
  assert.match(r.out, /1 !== 2/);
});

test('tests: placeholder npm script falls through to file discovery', () => {
  const d = tmp();
  pkg(d, 'echo "Error: no test specified" && exit 1');
  write(d, 'a.spec.cjs', "require('node:test').test('ok', () => {});\n");
  const r = gate(['tests'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^tests: PASS \(node --test/);
});

test('tests: a real npm test script wins over test files', () => {
  const d = tmp();
  pkg(d, 'node -e "process.exit(0)"');
  write(d, 'a.test.js', 'process.exit(1);\n');
  assert.match(gate(['tests'], d).out, /^tests: PASS \(npm test --silent/);
});

test('tests: files in test/ and node_modules/git-ignored paths are handled', () => {
  const d = repo({ '.gitignore': 'ignored/\n', 'ignored/x.test.js': 'process.exit(1);\n', 'node_modules/p/y.test.js': 'process.exit(1);\n' });
  assert.equal(gate(['tests'], d).out.trim(), 'tests: none found');
  write(d, 'test/one.js', "require('node:test').test('ok', () => {});\n");
  const r = gate(['tests'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^tests: PASS \(node --test \(1 file\)/);
});

test('tests: more than 200 test files passes the directories', () => {
  const d = tmp();
  for (let i = 0; i < 201; i++) write(d, `t/f${i}.test.js`, "require('node:test').test('ok', () => {});\n");
  const r = gate(['tests'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^tests: PASS \(node --test \(1 paths\)/);
});

test('tests: pytest when a test_*.py file exists and python3 is available', (t) => {
  if (spawnSync('python3', ['-m', 'pytest', '--version']).status !== 0) return t.skip('pytest not installed');
  const d = tmp();
  write(d, 'test_a.py', 'def test_a():\n    assert True\n');
  const r = gate(['tests'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^tests: PASS \(python3 -m pytest -q/);
});
