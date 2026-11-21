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
    saved: () => JSON.parse(data),
    raw: () => data,
    reset: () => { output.length = 0; },
  };
}

test('add pulls #tags out of the title and stores them', () => {
  const s = session();
  assert.equal(s.run('add', 'Buy milk #home #errands'), 0);
  assert.equal(s.out(), 'added [ ] 1 Buy milk #home #errands\n');
  const t = s.saved().todos[0];
  assert.equal(t.title, 'Buy milk');
  assert.deepEqual(t.tags, ['home', 'errands']);
  assert.equal(s.saved().version, 1);
});

test('works whether the title arrives as one argument or several', () => {
  const s = session();
  s.run('add', 'Buy', 'milk', '#home');
  assert.deepEqual(s.saved().todos[0].tags, ['home']);
  assert.equal(s.saved().todos[0].title, 'Buy milk');
});

test('tags are lowercased, deduplicated and keep first-seen order', () => {
  const s = session();
  s.run('add', '#Work Fix the bug #urgent #WORK #Urgent #later');
  const t = s.saved().todos[0];
  assert.equal(t.title, 'Fix the bug');
  assert.deepEqual(t.tags, ['work', 'urgent', 'later']);
});

test('words that merely contain a # are not tags', () => {
  const s = session();
  s.run('add', 'Learn C# and fix issue#5');
  const t = s.saved().todos[0];
  assert.equal(t.title, 'Learn C# and fix issue#5');
  assert.deepEqual(t.tags, []);
});

test('a todo with only tags still has an empty title, which is an error and saves nothing', () => {
  const s = session();
  assert.equal(s.run('add', '#home #errands'), 1);
  assert.equal(s.out(), 'error: title is empty\n');
  assert.equal(s.raw(), null);
});

test('list shows tags after the title; untagged todos have no trailing space', () => {
  const s = session();
  s.run('add', 'Buy milk #home');
  s.run('add', 'Call mom');
  s.reset();
  s.run('list');
  assert.equal(s.out(), '[ ] 1 Buy milk #home\n[ ] 2 Call mom\n');
});

test('done shows tags too', () => {
  const s = session();
  s.run('add', 'Buy milk #home');
  s.reset();
  assert.equal(s.run('done', '1'), 0);
  assert.equal(s.out(), 'completed [x] 1 Buy milk #home\n');
  assert.deepEqual(s.saved().todos[0].tags, ['home']);
});

function seeded() {
  const s = session();
  s.run('add', 'Buy milk #home #errands');
  s.run('add', 'Write report #work');
  s.run('add', 'Clean garage #home');
  s.run('add', 'Untagged thing');
  s.reset();
  return s;
}

test('list --tag filters, in both argument forms', () => {
  const s = seeded();
  s.run('list', '--tag', 'home');
  assert.equal(s.out(), '[ ] 1 Buy milk #home #errands\n[ ] 3 Clean garage #home\n');
  s.reset();
  s.run('list', '--tag=work');
  assert.equal(s.out(), '[ ] 2 Write report #work\n');
});

test('--tag is case-insensitive', () => {
  const s = seeded();
  s.run('list', '--tag', 'HOME');
  assert.equal(s.out(), '[ ] 1 Buy milk #home #errands\n[ ] 3 Clean garage #home\n');
});

test('several --tag options must all match', () => {
  const s = seeded();
  s.run('list', '--tag', 'home', '--tag', 'errands');
  assert.equal(s.out(), '[ ] 1 Buy milk #home #errands\n');
  s.reset();
  s.run('list', '--tag', 'home', '--tag', 'work');
  assert.equal(s.out(), 'no todos\n');
});

test('a filter that matches nothing prints the same message as an empty list', () => {
  const s = seeded();
  const code = s.run('list', '--tag', 'nope');
  assert.equal(code, 0);
  assert.equal(s.out(), 'no todos\n');
});

test('list without --tag still shows everything', () => {
  const s = seeded();
  s.run('list');
  assert.equal(s.out().split('\n').filter(Boolean).length, 4);
});

test('a data file written before tags existed still loads and gets upgraded on save', () => {
  const old = JSON.stringify({ version: 1, nextId: 3, todos: [{ id: 1, title: 'old one', done: false }, { id: 2, title: 'older', done: true }] });
  const s = session(old);
  assert.equal(s.run('list'), 0);
  assert.equal(s.out(), '[ ] 1 old one\n[x] 2 older\n');
  s.reset();
  assert.equal(s.run('list', '--tag', 'home'), 0);
  assert.equal(s.out(), 'no todos\n');
  s.reset();
  assert.equal(s.run('add', 'new #fresh'), 0);
  const saved = s.saved();
  assert.equal(saved.todos.length, 3);
  assert.equal(saved.todos[2].id, 3);
  for (const t of saved.todos) assert.ok(Array.isArray(t.tags), `todo ${t.id} has tags array`);
  assert.deepEqual(saved.todos[0].tags, []);
  assert.deepEqual(saved.todos[2].tags, ['fresh']);
});

test('existing behaviour is unchanged', () => {
  const s = session();
  assert.equal(s.run('add', '  spaced    out  '), 0);
  assert.equal(s.out(), 'added [ ] 1 spaced out\n');
  assert.equal(s.run('done', 'x'), 1);
  assert.equal(s.run('frob'), 2);
});
