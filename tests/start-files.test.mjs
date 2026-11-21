// start writes .jefe/files.txt (the helpers read it instead of running a Bash listing) and prints one `files:` line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gate, git, repo, tmp, withIdentity, write } from './fixtures/gate/helpers.mjs';

const env = () => ({ JEFE_HOME: tmp(), JEFE_HOST: 'filehost', JEFE_MODE: 'headless' });
const list = (d) => readFileSync(join(d, '.jefe', 'files.txt'), 'utf8').split('\n').filter(Boolean);

test('a git project: tracked and untracked files, ignored ones and .jefe left out, a nested repository left out', () => {
  const d = withIdentity(repo({}));
  write(d, '.gitignore', 'secret.log\n');
  write(d, 'src/a.js', 'a\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'a');
  write(d, 'new.txt', 'untracked\n');
  write(d, 'secret.log', 'ignored\n');
  mkdirSync(join(d, 'emb'));
  git(join(d, 'emb'), 'init', '-q');
  write(d, 'emb/inner.txt', 'x\n');
  const r = gate(['start'], d, env());
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^files: \.jefe\/files\.txt \(4 files\)$/m, r.out);
  assert.deepEqual(list(d), ['.gitignore', 'base.txt', 'new.txt', 'src/a.js'], 'sorted, nothing ignored, no .jefe, no nested repository');
});

test('a folder without git: a plain walk that skips .git-like folders, node_modules and .jefe, and does not follow symlinks', () => {
  const d = tmp();
  write(d, 'b.txt', 'b\n');
  write(d, 'sub/c.txt', 'c\n');
  write(d, 'node_modules/x/index.js', 'x\n');
  write(d, '__pycache__/m.pyc', 'x\n');
  const outside = tmp();
  write(outside, 'far.txt', 'far\n');
  symlinkSync(outside, join(d, 'link'));
  const r = gate(['start'], d, env());
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^files: \.jefe\/files\.txt \(3 files\)$/m, r.out);
  assert.deepEqual(list(d), ['b.txt', 'link', 'sub/c.txt']);
});

test('more than 2000 files: the first 2000 are listed and the line says so', () => {
  const d = tmp();
  for (let i = 0; i < 2005; i++) write(d, `f${String(i).padStart(4, '0')}.txt`, '');
  const r = gate(['start'], d, env());
  assert.match(r.out, /^files: \.jefe\/files\.txt \(2005 files, first 2000 listed\)$/m, r.out);
  const l = list(d);
  assert.equal(l.length, 2000);
  assert.equal(l[0], 'f0000.txt');
});

test('a name with a newline is written escaped', () => {
  const d = tmp();
  write(d, 'odd\nname.txt', '');
  gate(['start'], d, env());
  assert.deepEqual(list(d), ['odd\\nname.txt']);
});

test('when the list cannot be written, start says "not listed" and still exits 0', () => {
  const d = tmp();
  write(d, 'a.txt', 'a\n');
  mkdirSync(join(d, '.jefe'));
  symlinkSync(join(tmp(), 'elsewhere.txt'), join(d, '.jefe', 'files.txt'));
  const r = gate(['start'], d, env());
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^files: not listed \(the file or \.jefe is a symlink\)$/m, r.out);
});
