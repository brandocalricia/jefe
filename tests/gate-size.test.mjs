import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, repo, tmp, write, git } from './fixtures/gate/helpers.mjs';

const size = (dir, extra = []) => gate(['size', ...extra], dir);

test('size: 3 files is SMALL, 4 is MEDIUM, 9 is LARGE', () => {
  const d = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  assert.equal(size(d).out.trim(), 'size: SMALL files=3 lines=3 triggers=none');
  write(d, 'd.txt');
  assert.match(size(d).out, /^size: MEDIUM files=4 /);
  for (const n of ['e', 'f', 'g', 'h']) write(d, `${n}.txt`);
  assert.match(size(d).out, /^size: MEDIUM files=8 /);
  write(d, 'i.txt');
  assert.match(size(d).out, /^size: LARGE files=9 /);
});

test('size: more than 400 changed lines is LARGE', () => {
  const d = repo({ 'big.txt': 'line\n'.repeat(400) });
  assert.match(size(d).out, /^size: SMALL files=1 lines=400 /);
  write(d, 'big.txt', 'line\n'.repeat(401));
  assert.match(size(d).out, /^size: LARGE files=1 lines=401 triggers=none/);
});

test('size: tracked edits and staged files count, ignored files do not', () => {
  const d = repo({ '.gitignore': 'skip.txt\n', 'skip.txt': 'x\n'.repeat(500) });
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'ignore');
  write(d, 'base.txt', 'base\nmore\n'); // unstaged edit: +1
  write(d, 'new.txt', 'a\nb\n'); // staged
  git(d, 'add', 'new.txt');
  write(d, 'skip.txt', 'y\n'.repeat(500)); // ignored
  write(d, 'untracked.txt', 'u\n');
  assert.equal(size(d).out.trim(), 'size: SMALL files=3 lines=4 triggers=none');
});

test('size: a hooks file alone is LARGE with trigger hooks', () => {
  const d = repo({ 'hooks/x.js': 'x\n' });
  assert.equal(size(d).out.trim(), 'size: LARGE files=1 lines=1 triggers=hooks');
});

test('size: each HARD trigger class makes even one file LARGE', () => {
  const cases = {
    'src/auth/user.js': 'auth',
    'lib/Login.py': 'auth',
    'run.sh': 'scripts',
    'scripts/deploy.sh': 'scripts',
    'bin/tool.sh': 'scripts',
    '.github/workflows/ci.yml': 'scripts',
    '.gitlab-ci.yml': 'scripts',
    '.env.local': 'secrets',
    'my-credentials.json': 'secrets',
    'cert.pem': 'secrets',
    '.husky/pre-commit': 'hooks',
    'hooks.json': 'hooks',
    'hooks/x.js': 'hooks',
  };
  for (const [file, trig] of Object.entries(cases)) {
    const d = repo({ [file]: 'x\n' });
    const out = size(d).out;
    assert.match(out, /^size: LARGE /, file);
    assert.ok(out.trim().split('triggers=')[1].split(',').includes(trig), `${file} -> ${trig}: ${out}`);
  }
  // "author" is not auth
  assert.match(size(repo({ 'author.txt': 'x\n' })).out, /SMALL .*triggers=none/);
});

test('size: docs and README are not a trigger at all', () => {
  for (const f of ['README.md', 'readme.txt', 'docs/guide.md', 'LICENSE', 'pyproject.toml', 'Makefile']) {
    assert.equal(size(repo({ [f]: 'x\n' })).out.trim(), 'size: SMALL files=1 lines=1 triggers=none', f);
  }
  const d = repo({ 'README.md': 'x\n', 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  assert.equal(size(d).out.trim(), 'size: MEDIUM files=4 lines=4 triggers=none');
});

test('size: SOFT triggers (package.json, bin/, scripts/) raise MEDIUM to LARGE, never SMALL', () => {
  const soft = { 'package.json': 'package', 'bin/tool': 'bin', 'scripts/build.py': 'scripts-dir' };
  for (const [file, trig] of Object.entries(soft)) {
    const small = repo({ [file]: 'x\n', 'a.txt': 'a\n' });
    assert.equal(size(small).out.trim(), 'size: SMALL files=2 lines=2 triggers=none', file);
    const medium = repo({ [file]: 'x\n', 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    assert.equal(size(medium).out.trim(), `size: LARGE files=4 lines=4 triggers=${trig}`, file);
  }
  // a soft file plus a hard trigger: LARGE because of the hard one, which is the only one named
  const both = repo({ 'package.json': 'x\n', 'a.txt': 'a\n', 'b.txt': 'b\n', 'hooks/h.js': 'h\n' });
  assert.equal(size(both).out.trim(), 'size: LARGE files=4 lines=4 triggers=hooks');
  // already LARGE by size: the soft file is not named as the reason
  const big = repo({ 'package.json': 'x\n', 'big.txt': 'line\n'.repeat(401) });
  assert.equal(size(big).out.trim(), 'size: LARGE files=2 lines=402 triggers=none');
});

test('size: --base compares against a ref, bad ref is an error', () => {
  const d = repo();
  write(d, 'one.txt');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'one');
  write(d, 'two.txt');
  assert.match(size(d).out, /files=1 /);
  assert.match(size(d, ['--base', 'HEAD~1']).out, /files=2 /);
  const bad = size(d, ['--base', 'nope-ref']);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /UNKNOWN/);
});

test('size: repo with no commits works; file names with spaces and quotes', () => {
  const d = tmp();
  git(d, 'init', '-q');
  write(d, 'my file "q".txt', 'a\n');
  write(d, 'b.txt', 'b\n');
  assert.match(size(d).out, /^size: SMALL files=2 lines=2 /);
});

test('size: not a git repo is UNKNOWN, exit 0; --json is parseable', () => {
  const d = tmp();
  const r = size(d);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'size: UNKNOWN (not a git repo)');
  const j = JSON.parse(gate(['size', '--json'], repo({ 'a.txt': 'a\n' })).out);
  assert.equal(j.size, 'SMALL');
  assert.equal(j.files, 1);
  assert.deepEqual(j.triggers, []);
});
