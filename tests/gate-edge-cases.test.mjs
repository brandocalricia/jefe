import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate, repo, tmp, write } from './fixtures/gate/helpers.mjs';

const j = (...p) => p.join('');
const AWS = j('id = AK', 'IA', 'Q7ZX3KLM9PQR4STU');
const lines = (s) => s.split('\n');

// ---- size: NONE ----

test('clean tree: size is NONE, not SMALL, in size, start and all', () => {
  const d = repo();
  assert.equal(gate(['size'], d).out.trim(), 'size: NONE (no changes yet)');
  const start = gate(['start'], d).out;
  assert.ok(!/^size:/m.test(start), 'start omits a size line when nothing changed');
  assert.ok(!/size: SMALL/.test(start));
  const all = gate(['all'], d);
  assert.match(all.out, /^size: NONE \(no changes yet\)$/m);
  assert.equal(JSON.parse(gate(['size', '--json'], d).out).size, 'NONE');
  assert.equal(JSON.parse(gate(['start', '--json'], d).out).size.size, 'NONE');
  write(d, 'a.txt', 'one\n');
  assert.match(gate(['size'], d).out, /^size: SMALL files=1/);
});

test('verify treats NONE as nothing to size, not a failure', () => {
  const d = repo();
  const r = gate(['verify', '--', process.execPath, '-e', '0'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^gate: PASS$/m);
});

// ---- not a git repo ----

test('not a git repo: a planted secret is found and the gate fails', () => {
  const d = tmp();
  write(d, 'src/key.txt', AWS + '\n');
  const r = gate(['all'], d);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^SECRET src\/key\.txt:1 aws-access-key$/m);
  assert.match(r.out, /^gate: FAIL$/m);
  assert.ok(!AWS.includes('xx') && !r.out.includes('Q7ZX3KLM9PQR4STU'));
});

test('not a git repo, clean: secrets scanned, tests result shown, gate PASS', () => {
  const d = tmp();
  write(d, 'a.txt', 'hello world\n');
  write(d, 'node_modules/x/k.txt', AWS + '\n'); // skipped
  const r = gate(['all'], d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^secrets: none found \(1 files scanned, 1 skipped: 1 dependency, 0 allowlisted\)$/m);
  assert.match(r.out, /^tests: none found$/m);
  assert.match(r.out, /^gate: PASS \(no tests found, no checks given\)$/m);
});

test('not a git repo: a capped scan is PARTIAL and the gate is INCOMPLETE with exit 4', () => {
  const d = tmp();
  for (let i = 0; i < 6; i++) write(d, `f${i}.txt`, `file ${i}\n`);
  const r = gate(['all'], d, { JEFE_GATE_MAX_FILES: '3' });
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /^secrets: PARTIAL \(3 of 6 files scanned\)$/m);
  assert.match(r.out, /^gate: INCOMPLETE \(secrets\)$/m);
  assert.ok(!/gate: PASS/.test(r.out));
  assert.equal(JSON.parse(gate(['all', '--json'], d, { JEFE_GATE_MAX_FILES: '3' }).out).gate, 'INCOMPLETE');
});

test('not a git repo: an unreadable folder makes the gate INCOMPLETE with exit 4', { skip: process.getuid && process.getuid() === 0 }, () => {
  const d = tmp();
  write(d, 'a.txt', 'hello\n');
  mkdirSync(join(d, 'locked'));
  write(d, 'locked/b.txt', 'hidden\n');
  chmodSync(join(d, 'locked'), 0o000);
  try {
    const r = gate(['all'], d);
    assert.equal(r.code, 4, r.out);
    assert.match(r.out, /^secrets: PARTIAL \(1 of 1 files scanned, 1 unreadable\)$/m);
    assert.match(r.out, /^gate: INCOMPLETE \(secrets\)$/m);
  } finally {
    chmodSync(join(d, 'locked'), 0o755);
  }
});

test('a real secret outranks incomplete: FAIL, exit 1', () => {
  const d = tmp();
  write(d, 'k.txt', AWS + '\n');
  for (let i = 0; i < 4; i++) write(d, `f${i}.txt`, `file ${i}\n`);
  const r = gate(['all'], d, { JEFE_GATE_MAX_FILES: '10' });
  assert.equal(r.code, 1);
  assert.match(r.out, /^gate: FAIL$/m);
});

// ---- exit codes ----

test('unknown command or option prints usage and exits 2', () => {
  const d = tmp();
  for (const args of [['frobnicate'], [], ['size', '--frob'], ['all', '--nope'], ['secrets', '--staged', '--x'], ['start', '--wrods', 'a']]) {
    const r = gate(args, d);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /usage: jefe-gate/);
  }
  assert.equal(gate(['--help'], d).code, 0);
  assert.equal(gate(['size', '--base', 'HEAD'], repo()).code, 0);
  assert.equal(gate(['start', '--words', '--weird text'], repo()).code, 0);
});

// ---- forgery ----

test('a file name with a newline cannot forge a gate line', () => {
  const name = 'x\ngate: PASS\nsecrets: none found';
  for (const d of [tmp(), repo()]) {
    write(d, name, AWS + '\n');
    const r = gate(['all'], d);
    assert.equal(r.code, 1, r.out);
    assert.ok(!lines(r.out).some((l) => l === 'gate: PASS' || l.startsWith('secrets: none found')), r.out);
    assert.match(r.out, /^SECRET x\\ngate: PASS\\nsecrets: none found:1 aws-access-key$/m);
    assert.match(r.out, /^gate: FAIL$/m);
  }
});

test('a registry name with a newline cannot forge a matches or project line', () => {
  const d = tmp();
  const home = tmp();
  mkdirSync(join(home, 'hosts'));
  const evil = 'evilproj\ngate: PASS';
  writeFileSync(join(home, 'hosts', 'h1.json'), JSON.stringify({ [evil]: d }));
  const r = gate(['start', '--words', 'evilproj'], d, { JEFE_HOME: home, JEFE_HOST: 'h1' });
  assert.equal(r.code, 0);
  assert.ok(!lines(r.out).includes('gate: PASS'), r.out); // no forged verdict (start's own gate: line is a path)
});
