import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';

function session(initial = null) {
  let data = initial;
  const output = [];
  const io = { load: () => data, save: (t) => { data = t; }, out: (s) => output.push(s) };
  return {
    run: (...argv) => main(argv, io),
    out: () => output.join(''),
    data: () => data,
    reset: () => { output.length = 0; },
  };
}

test('add and list', () => {
  const s = session();
  assert.equal(s.run('add', 'Buy', 'milk'), 0);
  assert.equal(s.out(), 'added [ ] 1 Buy milk\n');
  s.reset();
  s.run('list');
  assert.equal(s.out(), '[ ] 1 Buy milk\n');
});

test('empty list', () => {
  const s = session();
  s.run('list');
  assert.equal(s.out(), 'no todos\n');
});

test('empty title is an error', () => {
  const s = session();
  assert.equal(s.run('add', '   '), 1);
  assert.equal(s.out(), 'error: title is empty\n');
  assert.equal(s.data(), null);
});

test('done', () => {
  const s = session();
  s.run('add', 'a');
  s.reset();
  assert.equal(s.run('done', '1'), 0);
  assert.equal(s.out(), 'completed [x] 1 a\n');
  assert.equal(s.run('done', '9'), 1);
});

test('unknown command prints usage', () => {
  const s = session();
  assert.equal(s.run('frob'), 2);
});
