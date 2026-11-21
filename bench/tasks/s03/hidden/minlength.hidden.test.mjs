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

const text = 'a\nbb\nccc\ndddd\n\neeeee\n';

test('--min-length drops shorter lines (separate value)', () => {
  const r = run(['f', '--min-length', '3'], { f: text });
  assert.equal(r.code, 0);
  assert.equal(r.out, '5\teeeee\n4\tdddd\n3\tccc\n');
});

test('--min-length=N form works too, flag can come first', () => {
  assert.equal(run(['--min-length=4', 'f'], { f: text }).out, '5\teeeee\n4\tdddd\n');
});

test('a line exactly as long as the minimum stays', () => {
  assert.equal(run(['f', '--min-length', '5'], { f: text }).out, '5\teeeee\n');
});

test('the filter runs before --top, so top N is taken from what is left', () => {
  const r = run(['f', '--min-length', '2', '--top', '2'], { f: 'xxxxx\ny\nzz\nwww\n' });
  assert.equal(r.out, '5\txxxxx\n3\twww\n');
  const r2 = run(['f', '--top', '2', '--min-length', '4'], { f: 'xxxx\nyy\nzzzzz\nabcd\n' });
  assert.equal(r2.out, '5\tzzzzz\n4\txxxx\n');
});

test('combines with --ignore-blank', () => {
  assert.equal(run(['f', '-b', '--min-length', '1'], { f: 'a\n\n \nbb\n' }).out, '2\tbb\n1\ta\n');
});

test('length is measured in characters like the output, not bytes or UTF-16 units', () => {
  const files = { f: '😀😀😀\nabc\nab\n' };
  assert.equal(run(['f', '--min-length', '3'], files).out, '3\t😀😀😀\n3\tabc\n');
  assert.equal(run(['f', '--min-length', '4'], files).out, '');
});

test('nothing printed when every line is filtered out, and the exit code is 0', () => {
  const r = run(['f', '--min-length', '99'], { f: text });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.equal(r.err, '');
});

test('default behaviour is unchanged without the option', () => {
  assert.equal(run(['f'], { f: text }).out, '5\teeeee\n4\tdddd\n3\tccc\n2\tbb\n1\ta\n');
});

test('bad values are usage errors (exit 2, message on err, nothing on out), like --top', () => {
  for (const bad of ['abc', '-1', '1.5', '', '1e3']) {
    const r = run(['f', '--min-length', bad], { f: text });
    assert.equal(r.code, 2, `value "${bad}"`);
    assert.match(r.err, /^linestat: /);
    assert.match(r.err, /--min-length/);
    assert.equal(r.out, '');
    const r2 = run(['f', `--min-length=${bad}`], { f: text });
    assert.equal(r2.code, 2, `value =${bad}`);
  }
});

test('a missing value is a usage error', () => {
  const r = run(['f', '--min-length'], { f: text });
  assert.equal(r.code, 2);
  assert.match(r.err, /^linestat: /);
  assert.match(r.err, /--min-length/);
});

test('--help documents the new option', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /--min-length/);
  assert.match(r.out, /--top/);
});

test('existing options still validate as before', () => {
  assert.equal(run(['f', '--top', '0'], { f: text }).code, 2);
  assert.equal(run(['f', '--bogus'], { f: text }).code, 2);
});
