import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';

function run(argv, files = {}) {
  const out = [];
  const err = [];
  const code = main(argv, {
    readFile: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out: out.join(''), err: err.join('') };
}

const text = 'aaa\nb\n\ncc\n';

test('prints longest first, ties by file order', () => {
  const r = run(['f.txt', '--top', '3'], { 'f.txt': 'ab\ncd\nxyz\n' });
  assert.equal(r.out, '3\txyz\n2\tab\n2\tcd\n');
});

test('--top accepts = and short form', () => {
  assert.equal(run(['f', '--top=1'], { f: text }).out, '3\taaa\n');
  assert.equal(run(['-t', '1', 'f'], { f: text }).out, '3\taaa\n');
});

test('--ignore-blank skips blank lines before taking the top N', () => {
  assert.equal(run(['f', '-b', '-t', '4'], { f: text }).out, '3\taaa\n2\tcc\n1\tb\n');
  assert.equal(run(['f', '-t', '4'], { f: text }).out, '3\taaa\n2\tcc\n1\tb\n0\t\n');
});

test('lengths count characters, not bytes', () => {
  assert.equal(run(['f'], { f: 'héllo😀\n' }).out, '6\théllo😀\n');
});

test('errors', () => {
  assert.equal(run(['f', '--top', '0'], { f: text }).code, 2);
  assert.equal(run(['f', '--nope'], { f: text }).code, 2);
  assert.equal(run([], {}).code, 2);
  assert.equal(run(['missing.txt'], {}).code, 1);
});

test('help lists the options', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /--top/);
});
