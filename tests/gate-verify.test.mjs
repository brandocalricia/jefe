import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const ok = ['node', '-e', 'process.exit(0)'];

test('verify: two passing commands', () => {
  const d = repo();
  const r = gate(['verify', '--', ...ok, '--', 'node', '-e', 'console.log(1)'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^check: PASS \(node -e process\.exit\(0\), exit 0\)$/m);
  assert.match(r.out, /^check: PASS \(node -e console\.log\(1\), exit 0\)$/m);
  assert.equal(r.out.trim().split('\n').pop(), 'gate: PASS');
});

test('verify: a failing command fails the gate, exit non-zero, tail shown', () => {
  const d = repo();
  const r = gate(['verify', '--', ...ok, '--', 'node', '-e', 'console.log("hello-tail");process.exitCode=2'], d);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /^check: FAIL \(node -e .*, exit 2\)$/m);
  assert.match(r.out, /^\| hello-tail$/m);
  assert.equal(r.out.trim().split('\n').pop(), 'gate: FAIL');
});

test('verify: a missing command is a clear FAIL without a stack trace', () => {
  const d = repo();
  const r = gate(['verify', '--', 'no-such-cmd-xyz', 'arg'], d);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /^check: FAIL \(no-such-cmd-xyz arg, could not start\)$/m);
  assert.match(r.out, /ENOENT/);
  assert.ok(!/\n\s+at /.test(r.out + r.err));
  assert.match(r.out.trim().split('\n').pop(), /^gate: FAIL$/);
});

test('verify: no extra commands behaves like all, and an untested PASS says so', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  const a = gate(['all'], d);
  const v = gate(['verify'], d);
  const untested = 'gate: PASS (no tests found, no checks given)\n';
  assert.ok(a.out.endsWith('tests: none found\n' + untested), a.out);
  assert.equal(v.out, a.out);
  assert.equal(v.code, a.code);
  assert.equal(v.code, 0);
  assert.equal(gate(['verify', '--'], d).out, v.out);
});

test('verify: tests that ran, or a check that ran, keep a plain gate: PASS', () => {
  const d = repo({ 'a.test.mjs': "import {test} from 'node:test'; test('x', () => {});\n" });
  const t = gate(['verify'], d);
  assert.match(t.out, /^tests: PASS /m);
  assert.equal(t.out.trim().split('\n').pop(), 'gate: PASS');
  const c = gate(['verify', '--', ...ok], repo());
  assert.equal(c.out.trim().split('\n').pop(), 'gate: PASS');
});

test('verify: --json says nothing was tested', () => {
  const j = JSON.parse(gate(['verify', '--json'], repo()).out);
  assert.equal(j.gate, 'PASS');
  assert.equal(j.tested, false);
  assert.equal(j.exit, 0);
});

test('verify: a check that cannot start and looks like shell syntax gets the no-shell hint', () => {
  const hint = 'hint: checks are run without a shell: use a program and arguments';
  const bad = [
    ['cd sub && npm test'],
    ['npm test | tail'],
    ['echo a; echo b'],
    ['node build.js > out.txt'],
    ['FOO=1', 'node', 'x.js'],
    ['cd', 'sub'],
  ];
  for (const argv of bad) {
    const r = gate(['verify', '--', ...argv], repo());
    // "cd" may exist as a program on some systems and then does not fail to start; the others never start
    if (argv[0] === 'cd' && !/could not start/.test(r.out)) continue;
    assert.match(r.out, /could not start/, argv.join(' '));
    assert.ok(r.out.split('\n').includes(hint), `${argv.join(' ')}\n${r.out}`);
    assert.equal(r.out.trim().split('\n').pop(), 'gate: FAIL');
    assert.notEqual(r.code, 0);
  }
});

test('verify: the hint is not printed for a plain missing program, or a check that ran and failed', () => {
  const hint = 'hint: checks are run without a shell';
  assert.ok(!gate(['verify', '--', 'no-such-cmd-xyz', 'arg'], repo()).out.includes(hint));
  assert.ok(!gate(['verify', '--', 'node', '-e', 'process.exit(3) // a && b | c; d > e'], repo()).out.includes(hint));
});

test('verify: a failing all still fails even when commands pass; --help documents verify', () => {
  const d = repo({ 'k.txt': 'id = AK' + 'IA' + 'Q7ZX3KLM9PQR4STU\n' });
  const r = gate(['verify', '--', ...ok], d);
  assert.equal(r.code, 1);
  assert.match(r.out, /^check: PASS/m);
  assert.match(r.out.trim().split('\n').pop(), /^gate: FAIL$/);
  const help = gate(['--help'], d).out;
  assert.match(help, /verify \[--deadline <s>\] \[--since <start\|stage\|ref>\] \[--stage <n>\] -- <cmd\.\.\.>/);
  assert.match(help, /--stage <n>: while another stage is still open/);
});

// Everything after the first literal -- belongs to the checks, verbatim. Gate flags are read only before it.
// The probe is a script file so node itself does not read the flag-looking arguments.
const probe = (code) => write(tmp(), 'probe.js', code);
const wantArgs = (list) => probe(`process.exit(JSON.stringify(process.argv.slice(2)) === ${JSON.stringify(JSON.stringify(list))} ? 0 : 9)`);

test('verify: --json after -- reaches the check intact and the gate output stays text', () => {
  const d = repo();
  const r = gate(['verify', '--', 'node', wantArgs(['x', '--json']), 'x', '--json'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^check: PASS \(node .*probe\.js x --json, exit 0\)$/m);
  assert.equal(r.out.trim().split('\n').pop(), 'gate: PASS');
  assert.ok(!r.out.trim().startsWith('{'), r.out);
});

test('verify: gate-flag lookalikes after -- reach the check intact and are not parsed by the gate', () => {
  const d = repo();
  const list = ['--since', 'start', '--deadline', '1', '--words', 'x', '--level', 'high', '--timeout', '0', '--json'];
  const r = gate(['verify', '--', 'node', wantArgs(list), ...list], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^check: PASS /m);
  assert.equal(r.out.trim().split('\n').pop(), 'gate: PASS');
  assert.ok(!r.out.trim().startsWith('{'), r.out);
});

test('verify: --json before -- still means gate JSON, and a check keeps its own --json', () => {
  const d = repo();
  const r = gate(['verify', '--json', '--', 'node', wantArgs(['--json']), '--json'], d);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.equal(j.gate, 'PASS');
  assert.equal(j.checks.length, 1);
  assert.equal(j.checks[0].exit, 0);
});

test('verify: gate flags before -- still work next to a check with lookalikes', () => {
  const d = repo();
  const r = gate(['verify', '--since', 'start', '--deadline', '60', '--', 'node', wantArgs(['--since', 'nope', '--deadline', '5']), '--since', 'nope', '--deadline', '5'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^since: no start snapshot/m);
  assert.match(r.out, /^check: PASS /m);
});

test('all: a literal -- is not a command separator there (unknown option, exit 2)', () => {
  const r = gate(['all', '--', 'node', '--json'], repo());
  assert.equal(r.code, 2);
  assert.ok(!r.out.trim().startsWith('{'), r.out);
});
