// start's refusals say what is really wrong: a .jefe that is a symbolic link, and a bare repository (nothing is written into its git folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gate, repo, tmp } from './fixtures/gate/helpers.mjs';

const env = { JEFE_MODE: 'headless' };

test('start: a .jefe that is a symbolic link is named as such, nothing is written through it', { skip: process.platform === 'win32' }, () => {
  const d = repo();
  const target = tmp();
  symlinkSync(target, join(d, '.jefe'));
  const r = gate(['start'], d, env);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^gate: unavailable \(\.jefe is a symbolic link, and Jefe does not write through one\)$/m, r.out);
  assert.match(r.out, /^next: stop; tell the user: \.jefe here is a symbolic link; replace it with a real folder and run \/jefe again$/m);
  assert.doesNotMatch(r.out, /read-only|remove \.jefe\/bin/);
  assert.deepEqual(readdirSync(target), []);
});

test('start: a bare repository is refused with one line and nothing is written into it', () => {
  const parent = tmp();
  const bare = join(parent, 'r.git');
  mkdirSync(bare);
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  const before = readdirSync(bare).sort();
  const r = gate(['start'], bare, env);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^jefe: this folder is a bare git repository \(or inside a git folder\) with no work tree; Jefe does not start here: run \/jefe in a checkout of the repository$/m, r.out);
  assert.doesNotMatch(r.out, /run git init first|^gate: /m);
  assert.ok(!existsSync(join(bare, '.jefe')));
  assert.deepEqual(readdirSync(bare).sort(), before);
});

test('go and go --resume: a bare repository is refused with the same line as start, and nothing is written into it', () => {
  const parent = tmp();
  const bare = join(parent, 'r.git');
  mkdirSync(bare);
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  const before = readdirSync(bare).sort();
  for (const args of [['go', '--goal', 'g', '--done', 'd', '--allow-kind', 'tests'], ['go', '--resume', '--allow-kind', 'tests']]) {
    const r = gate(args, bare, env);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^jefe: this folder is a bare git repository \(or inside a git folder\) with no work tree; Jefe does not start here: run \/jefe in a checkout of the repository$/m, r.out);
    assert.doesNotMatch(r.out, /^allowed:|^goal:/m);
    assert.ok(!existsSync(join(bare, '.jefe')));
    assert.deepEqual(readdirSync(bare).sort(), before);
  }
});

test('start: an ordinary repository and a plain folder still start', () => {
  assert.equal(gate(['start'], repo(), env).code, 0);
  const plain = gate(['start'], tmp(), env);
  assert.equal(plain.code, 0);
  assert.match(plain.out, /run git init first/);
});
