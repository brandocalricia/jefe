import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gate, git, repo, tmp, write } from './fixtures/gate/helpers.mjs';

// Each test gets its own JEFE_HOME so a `start` in one never leaks into another.
const env = () => ({ JEFE_HOME: tmp() });
const start = (d, e) => gate(['start'], d, e);
const AWS = 'AK' + 'IA' + 'Q7ZX3KLM9PQR4STU';

test('--since start measures only what changed after start; the whole tree still counts without it', () => {
  const e = env();
  const d = repo({ 'old1.txt': 'a\n', 'old2.txt': 'b\n', 'old3.txt': 'c\n' }); // dirty before the job
  assert.match(start(d, e).out, /^size: SMALL files=3 /m);
  assert.equal(gate(['size', '--since', 'start'], d, e).out.trim(), 'size: NONE (no changes yet)');
  write(d, 'new.txt', 'n\n');
  assert.equal(gate(['size', '--since', 'start'], d, e).out.trim(), 'size: SMALL files=1 lines=1 triggers=none');
  assert.match(gate(['size'], d, e).out, /^size: MEDIUM files=4 /);
  // touching a file that was already dirty counts it
  write(d, 'old2.txt', 'changed\nmore\n');
  assert.equal(gate(['size', '--since', 'start'], d, e).out.trim(), 'size: SMALL files=2 lines=3 triggers=none');
});

test('--since start survives commits made after start, and ignores dirty files committed unchanged', () => {
  const e = env();
  const d = repo({ 'wip.txt': 'wip\n' });
  start(d, e);
  write(d, 'job1.txt', '1\n');
  write(d, 'job2.txt', '2\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'job so far');
  write(d, 'job3.txt', '3\n');
  const out = gate(['size', '--since', 'start'], d, e).out.trim();
  assert.equal(out, 'size: SMALL files=3 lines=3 triggers=none'); // job1, job2 (committed) and job3; wip.txt is unchanged since start
  assert.match(gate(['size', '--base', 'HEAD'], d, e).out, /files=1 /); // for contrast: only the dirty one
});

test('--since start in a repo with no commits at start', () => {
  const e = env();
  const d = tmp();
  git(d, 'init', '-q');
  write(d, 'pre.txt', 'p\n');
  start(d, e);
  write(d, 'post.txt', 'q\n');
  assert.equal(gate(['size', '--since', 'start'], d, e).out.trim(), 'size: SMALL files=1 lines=1 triggers=none');
});

test('--since start with no snapshot prints the exact line and measures the whole tree', () => {
  const d = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const r = gate(['size', '--since', 'start'], d, env());
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.trim().split('\n'), ['since: no start snapshot, measuring the whole tree', 'size: SMALL files=2 lines=2 triggers=none']);
  const a = gate(['all', '--since', 'start'], d, env());
  assert.equal(a.out.split('\n')[0], 'since: no start snapshot, measuring the whole tree');
  assert.match(a.out, /^size: SMALL files=2 /m);
});

test('a snapshot from another repo is not used', () => {
  const e = env();
  const one = repo({ 'x.txt': 'x\n' });
  const two = repo({ 'y.txt': 'y\n' });
  start(one, e);
  const r = gate(['size', '--since', 'start'], two, e);
  assert.match(r.out, /^since: no start snapshot/);
});

test('--since <git-ref> behaves like --base <ref>, and --base still works', () => {
  const d = repo();
  write(d, 'one.txt');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'one');
  write(d, 'two.txt');
  const e = env();
  assert.equal(gate(['size', '--since', 'HEAD~1'], d, e).out, gate(['size', '--base', 'HEAD~1'], d, e).out);
  assert.match(gate(['size', '--since', 'HEAD~1'], d, e).out, /files=2 /);
  const bad = gate(['size', '--since', 'nope-ref'], d, e);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /UNKNOWN \(bad --since ref\)/);
  assert.match(gate(['size', '--base', 'nope-ref'], d, e).out, /UNKNOWN \(bad --base ref\)/);
  assert.equal(gate(['size', '--since', '--evil'], d, e).code, 2);
});

test('all and verify take --since; a verify command after -- is never read as an option', () => {
  const e = env();
  const d = repo({ 'old.txt': 'o\n' });
  start(d, e);
  write(d, 'new.txt', 'n\n');
  const a = gate(['all', '--since', 'start'], d, e);
  assert.match(a.out, /^size: SMALL files=1 lines=1 /m);
  const v = gate(['verify', '--since', 'start', '--', 'node', '-e', 'process.exit(0)'], d, e);
  assert.match(v.out, /^size: SMALL files=1 /m);
  assert.match(v.out, /^check: PASS/m);
  assert.equal(v.out.trim().split('\n').pop(), 'gate: PASS');
  // a command that merely contains the word --since stays a command
  write(d, 'ok.cjs', "process.exit(process.argv.includes('--since') ? 0 : 1);\n");
  const w = gate(['verify', '--', 'node', 'ok.cjs', '--since', 'start'], d, e);
  assert.doesNotMatch(w.out, /^since:/m);
  assert.match(w.out, /^check: PASS/m);
});

test('--since narrows size only: a secret already in the dirty tree at start still fails the gate', () => {
  const e = env();
  const d = repo({ 'leak.txt': `key = ${AWS}\n` });
  start(d, e);
  const r = gate(['all', '--since', 'start'], d, e);
  assert.match(r.out, /^size: NONE/m);
  assert.match(r.out, /^SECRET leak\.txt:1 aws-access-key$/m);
  assert.equal(r.out.trim().split('\n').pop(), 'gate: FAIL');
  assert.equal(r.code, 1);
});

test('start writes the gate file 0600 in a 0700 run folder; no secrets or file content in it', () => {
  const e = env();
  const d = repo({ 'leak.txt': `key = ${AWS}\n` });
  start(d, e);
  const dir = join(e.JEFE_HOME, 'run');
  const f = readdirSync(dir).find((n) => n.endsWith('.gate.json'));
  assert.ok(f, readdirSync(dir).join());
  assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const text = readFileSync(join(dir, f), 'utf8');
  assert.ok(!text.includes(AWS));
  const j = JSON.parse(text);
  assert.ok(j.snapshot.files['leak.txt'].match(/^[0-9a-f]{64}$/));
  assert.ok(Number.isFinite(Date.parse(j.startedAt)));
});

test('--help says what --since narrows', () => {
  const h = gate(['--help'], tmp()).out;
  assert.match(h, /--since start measures only what\s+changed after jefe-gate start/);
  assert.match(h, /narrows the size measurement only: secrets and tests always cover the whole tree/);
});

test('--since start before the first commit: work the job has committed since still counts (against the empty tree, not the new HEAD)', () => {
  const e = env();
  const d = tmp();
  git(d, 'init', '-q');
  git(d, 'config', 'user.name', 't');
  git(d, 'config', 'user.email', 't@t');
  write(d, 'pre.txt', 'p\n'); // there before the job: committed unchanged below, so not the job's
  start(d, e);
  write(d, 'job1.txt', '1\n');
  write(d, 'job2.txt', '2\n2\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'stage 1');
  write(d, 'job3.txt', '3\n');
  assert.equal(gate(['size', '--since', 'start'], d, e).out.trim(), 'size: SMALL files=3 lines=4 triggers=none');
  assert.equal(gate(['size', '--since', 'stage'], d, e).out.trim(), 'size: SMALL files=3 lines=4 triggers=none'); // no stage passed: the start snapshot
});
