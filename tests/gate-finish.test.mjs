import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gate, repo, write } from './fixtures/gate/helpers.mjs';

const ok = ['node', '-e', 'process.exit(0)'];
const lastLine = (out) => out.trim().split('\n').pop();
// the paste section after the report block repeats the report lines, so it is left out of the count
const gateLines = (out) => {
  const ls = out.split('\n');
  const i = ls.findIndex((l) => /^paste( .*)?:$/.test(l));
  return (i === -1 ? ls : ls.slice(0, i)).filter((l) => l.startsWith('gate:'));
};
const HANDOFF = '## Goal\nx\n\n## DONE WHEN (state)\n- [ ] a : PASS\n\n## Last done\nx\n\n## Next\nx\n\n## Open decisions\nnone\n\n## Key paths\n/x\n';

// An env that keeps the project registry inside a temp folder
function env(d) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jefe-finish-home-')));
  return { JEFE_HOME: home, JEFE_HOST: 'finishhost', JEFE_PROJECTS_DIR: join(home, 'projects') };
}

test('finish: small passing job prints verify lines, the handoff is always written, cost, one gate line last', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  const r = gate(['finish', '--', ...ok], d, env(d));
  assert.equal(r.code, 0, r.out);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^size: SMALL /);
  assert.match(r.out, /^secrets: none found/m);
  assert.match(r.out, /^tests: none found$/m);
  assert.match(r.out, /^check: PASS \(node -e process\.exit\(0\), exit 0\)$/m);
  assert.match(r.out, /^handoff: ok: .* \(written by finish\)$/m);
  assert.match(r.out, /^cost: n\/a/m);
  assert.equal(lastLine(r.out), 'gate: PASS');
  assert.deepEqual(gateLines(r.out), ['gate: PASS']);
  assert.ok(existsSync(join(d, '.jefe', 'handoff.md')), 'every finish writes the handoff');
  // the order: size, project, handoff, log, then the report block (tests, check, secrets, review, commit, cost, gate); see gate-report.test.mjs
  const at = (p) => r.out.indexOf(`\n${p}`);
  assert.ok(at('handoff:') < at('report:') && at('report:') < at('tests:') && at('tests:') < at('check:') && at('check:') < at('secrets:') && at('secrets:') < at('cost:') && at('cost:') < at('gate:'));
});

test('finish: with no -- it behaves like all, and says nothing was tested', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  const r = gate(['finish'], d, env(d));
  assert.equal(r.code, 0);
  assert.equal(lastLine(r.out), 'gate: PASS (no tests found, no checks given)');
});

test('finish: a failing check or a secret fails the gate with the verify exit code', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  const f = gate(['finish', '--', 'node', '-e', 'process.exit(2)'], d, env(d));
  assert.equal(f.code, 1);
  assert.equal(lastLine(f.out), 'gate: FAIL');
  const d2 = repo({ 'leak.txt': 'AKIAABCDEFGHIJKLMNOP\n' });
  const s = gate(['finish'], d2, env(d2));
  assert.equal(s.code, 1);
  assert.equal(lastLine(s.out), 'gate: FAIL');
  assert.equal(gateLines(s.out).length, 1);
});

test('finish: --plan medium registers the project and checks a valid handoff', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  const e = env(d);
  gate(['finish', '--plan', 'medium'], d, e); // first call: project registered, handoff written by finish
  write(d, '.jefe/handoff.md', HANDOFF);
  const r = gate(['finish', '--plan', 'medium', '--', ...ok], d, e);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^project: .+ already registered path=/m);
  assert.match(r.out, /^handoff: ok: \d+ words, all headings present \(written by finish\)$/m); // no start snapshot: a hand-written file is not trusted as fresh
  assert.equal(lastLine(r.out), 'gate: PASS');
  assert.ok(existsSync(join(d, '.jefe', '.gitignore')));
});

test('finish: first medium call registers, names the slug and the path', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  const r = gate(['finish', '--plan', 'large'], d, env(d));
  assert.match(r.out, new RegExp(`^project: [a-z0-9-]+ registered path=${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(r.out, /^handoff: ok: \d+ words, all headings present \(written by finish\)$/m);
  assert.ok(!/MISSING/.test(r.out));
  assert.equal(r.code, 0);
  assert.equal(lastLine(r.out), 'gate: PASS (no tests found, no checks given)');
  assert.deepEqual(gateLines(r.out).length, 1);
});

test('finish: an invalid handoff is replaced by a written one; a FAIL is never hidden', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  write(d, '.jefe/handoff.md', '## Goal\nonly this\n');
  const e = env(d);
  const r = gate(['finish', '--plan', 'medium'], d, e);
  assert.match(r.out, /^handoff: ok: .*\(written by finish\)$/m);
  assert.equal(lastLine(r.out), 'gate: PASS (no tests found, no checks given)');
  const f = gate(['finish', '--plan', 'medium', '--', 'node', '-e', 'process.exit(1)'], d, e);
  assert.equal(f.code, 1);
  assert.equal(lastLine(f.out), 'gate: FAIL');
});

test('finish: the measured size counts when larger than the plan', () => {
  const files = {};
  for (let i = 0; i < 5; i++) files[`f${i}.txt`] = 'x\n'; // MEDIUM by file count
  const d = repo(files);
  const r = gate(['finish'], d, env(d));
  assert.match(r.out, /^size: MEDIUM /m);
  assert.match(r.out, /^project: /m);
  assert.match(r.out, /^handoff: ok: .*\(written by finish\)$/m);
  assert.equal(lastLine(r.out), 'gate: PASS (no tests found, no checks given)');
});

test('finish: a small job in a folder that already has .jefe gets a written handoff and a log line', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  mkdirSync(join(d, '.jefe'));
  const r = gate(['finish'], d, env(d));
  assert.match(r.out, /^project: /m);
  assert.match(r.out, /^handoff: ok: .*\(written by finish\)$/m);
  assert.match(r.out, /^log: \.jefe\/log\.md$/m);
  assert.equal(r.code, 0);
  assert.equal(lastLine(r.out), 'gate: PASS (no tests found, no checks given)');
});

test('finish --no-tests: no tests, no checks, secrets and size still run, INCOMPLETE with exit 4', () => {
  const d = repo({ 'a.test.mjs': "import {test} from 'node:test'; test('x', () => { throw new Error('ran'); });\n" });
  write(d, 'mark.js', '');
  const r = gate(['finish', '--no-tests', '--', 'node', '-e', 'require("fs").writeFileSync("ran.txt","1")'], d, env(d));
  assert.match(r.out, /^size: /m);
  assert.match(r.out, /^secrets: none found/m);
  assert.match(r.out, /^tests: not run \(no consent\)$/m);
  assert.match(r.out, /^check: SKIPPED \(node -e require\("fs"\)\.writeFileSync\("ran\.txt","1"\)\)$/m);
  assert.ok(!/^check: (PASS|FAIL)/m.test(r.out) && !/^tests: (PASS|FAIL)/m.test(r.out), r.out);
  assert.ok(!existsSync(join(d, 'ran.txt')), 'the check must not run');
  assert.equal(r.code, 4);
  assert.equal(lastLine(r.out), 'gate: INCOMPLETE (tests not run: no consent)');
  assert.equal(gateLines(r.out).length, 1);
});

test('finish --no-tests: a secret still FAILs', () => {
  const d = repo({ 'leak.txt': 'AKIAABCDEFGHIJKLMNOP\n' });
  const r = gate(['finish', '--no-tests'], d, env(d));
  assert.equal(r.code, 1);
  assert.equal(lastLine(r.out), 'gate: FAIL');
});

test('finish: gate flags only before the first --; a check keeps its own flags', () => {
  const d = repo({ 'show.js': 'console.log(process.argv.slice(2).join())\n' });
  const r = gate(['finish', '--', 'node', 'show.js', '--plan', 'large', '--json'], d, env(d));
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.trim().startsWith('{'));
  assert.match(r.out, /^handoff: ok: /m);
});

test('finish: --json is one object with the same information', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  const j = JSON.parse(gate(['finish', '--json', '--', ...ok], d, env(d)).out);
  assert.equal(j.gate, 'PASS');
  assert.equal(j.exit, 0);
  assert.equal(j.plan, 'job');
  assert.equal(j.handoff.required, true);
  assert.equal(j.checks.length, 1);
  assert.ok('cost' in j && 'secrets' in j && 'tests' in j);
});

test('finish: bad --plan, bad option and bad --deadline exit 2', () => {
  const d = repo();
  assert.equal(gate(['finish', '--plan', 'huge'], d, env(d)).code, 2);
  assert.equal(gate(['finish', '--nope'], d, env(d)).code, 2);
  assert.equal(gate(['finish', '--deadline', '0'], d, env(d)).code, 2);
});

test('verify, all and cost are unchanged and do not accept --no-tests', () => {
  const d = repo();
  assert.equal(gate(['verify', '--no-tests'], d, env(d)).code, 2);
  assert.equal(gate(['all', '--no-tests'], d, env(d)).code, 2);
  assert.match(gate(['cost'], d, env(d)).out, /^cost: n\/a/);
});

test('start with no arguments never prompts, exits 0 outside git and in an empty folder', () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'jefe-start-empty-')));
  const t = Date.now();
  const r = gate(['start'], d, env(d));
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.now() - t < 5000);
  for (const k of ['mode:', 'level:', 'knobs:']) assert.match(r.out, new RegExp(`^${k}`, 'm'), k);
  for (const k of ['usage:', 'context:', 'project:', 'prefs:']) assert.doesNotMatch(r.out, new RegExp(`^${k}`, 'm'), k);
});

test('finish: --plan accepts the size in any letter case', () => {
  const d = repo({ 'a.txt': 'hi\n' });
  const e = env(d);
  for (const v of ['MEDIUM', 'medium', 'Medium']) {
    const r = gate(['finish', '--plan', v], d, e);
    assert.notEqual(r.code, 2, v + '\n' + r.out);
    assert.ok(!/bad --plan/.test(r.out), v);
    assert.match(r.out, /^handoff: /m, v); // a medium plan checks the handoff, so the value was read as medium
  }
  assert.equal(gate(['finish', '--plan', 'HUGE'], d, e).code, 2);
});
