import { test } from 'node:test';
import assert from 'node:assert/strict';
import { string, number, boolean, array, object, optional, oneOf, validate, assertValid, ValidationError, formatIssues } from '../src/index.mjs';

const issues = (r) => {
  assert.equal(r.ok, false, 'expected a failure');
  return r.issues;
};

test('string', () => {
  assert.deepEqual(string().parse('hi'), { ok: true, value: 'hi' });
  assert.deepEqual(issues(string().parse(5)), [{ path: [], message: 'expected string' }]);
  assert.deepEqual(issues(string().parse(null)), [{ path: [], message: 'expected string' }]);
  assert.deepEqual(issues(string().parse(undefined)), [{ path: [], message: 'required' }]);
  assert.deepEqual(issues(string({ min: 3 }).parse('ab')), [{ path: [], message: 'too short' }]);
  assert.equal(string({ min: 3 }).parse('abc').ok, true);
  assert.deepEqual(issues(string({ max: 3 }).parse('abcd')), [{ path: [], message: 'too long' }]);
  assert.equal(string({ max: 3 }).parse('abc').ok, true);
  assert.equal(string({ min: 0 }).parse('').ok, true);
  assert.deepEqual(issues(string({ pattern: /^[a-z]+$/ }).parse('ab1')), [{ path: [], message: 'does not match pattern' }]);
  assert.equal(string({ pattern: /^[a-z]+$/ }).parse('abc').ok, true);
});

test('string reports one constraint issue, in order min, max, pattern', () => {
  assert.deepEqual(issues(string({ min: 5, pattern: /^x+$/ }).parse('ab')), [{ path: [], message: 'too short' }]);
  assert.deepEqual(issues(string({ max: 1, pattern: /^x+$/ }).parse('ab')), [{ path: [], message: 'too long' }]);
});

test('a global-flag pattern gives the same answer every time', () => {
  const s = string({ pattern: /a/g });
  for (let i = 0; i < 4; i++) assert.equal(s.parse('banana').ok, true);
});

test('number', () => {
  assert.deepEqual(number().parse(1.5), { ok: true, value: 1.5 });
  assert.deepEqual(number().parse(0), { ok: true, value: 0 });
  for (const bad of ['1', true, null, NaN, Infinity, -Infinity, {}, []]) {
    assert.deepEqual(issues(number().parse(bad)), [{ path: [], message: 'expected number' }], String(bad));
  }
  assert.deepEqual(issues(number().parse(undefined)), [{ path: [], message: 'required' }]);
  assert.deepEqual(issues(number({ int: true }).parse(1.5)), [{ path: [], message: 'not an integer' }]);
  assert.equal(number({ int: true }).parse(-3).ok, true);
  assert.deepEqual(issues(number({ min: 1 }).parse(0.5)), [{ path: [], message: 'too small' }]);
  assert.equal(number({ min: 1 }).parse(1).ok, true);
  assert.deepEqual(issues(number({ max: 10 }).parse(10.5)), [{ path: [], message: 'too large' }]);
  assert.equal(number({ max: 10 }).parse(10).ok, true);
  assert.equal(number({ min: 0 }).parse(0).ok, true);
  assert.deepEqual(issues(number({ int: true, min: 5 }).parse(1.5)), [{ path: [], message: 'not an integer' }]);
});

test('boolean', () => {
  assert.deepEqual(boolean().parse(false), { ok: true, value: false });
  assert.deepEqual(issues(boolean().parse(0)), [{ path: [], message: 'expected boolean' }]);
  assert.deepEqual(issues(boolean().parse(undefined)), [{ path: [], message: 'required' }]);
});

test('array', () => {
  const nums = array(number());
  const r = nums.parse([1, 2, 3]);
  assert.deepEqual(r, { ok: true, value: [1, 2, 3] });
  assert.deepEqual(nums.parse([]), { ok: true, value: [] });
  assert.deepEqual(issues(nums.parse('x')), [{ path: [], message: 'expected array' }]);
  assert.deepEqual(issues(nums.parse({ length: 0 })), [{ path: [], message: 'expected array' }]);
  assert.deepEqual(issues(nums.parse(undefined)), [{ path: [], message: 'required' }]);
  assert.deepEqual(issues(nums.parse([1, 'a', 3, null])), [
    { path: [1], message: 'expected number' },
    { path: [3], message: 'expected number' },
  ]);
  assert.deepEqual(issues(array(number(), { min: 2 }).parse([1])), [{ path: [], message: 'too short' }]);
  assert.deepEqual(issues(array(number(), { max: 1 }).parse([1, 2])), [{ path: [], message: 'too long' }]);
  assert.equal(array(number(), { min: 1, max: 2 }).parse([1, 2]).ok, true);
});

test('array: length issue first, then elements; returns a new array and leaves the input alone', () => {
  assert.deepEqual(issues(array(number(), { max: 1 }).parse([1, 'x'])), [
    { path: [], message: 'too long' },
    { path: [1], message: 'expected number' },
  ]);
  const input = [1, 2];
  const r = array(number()).parse(input);
  assert.notEqual(r.value, input);
  assert.deepEqual(input, [1, 2]);
});

test('object', () => {
  const user = object({ name: string(), age: number({ int: true }) });
  const r = user.parse({ name: 'Ann', age: 30, extra: true });
  assert.deepEqual(r, { ok: true, value: { name: 'Ann', age: 30 } });
  assert.deepEqual(issues(user.parse('x')), [{ path: [], message: 'expected object' }]);
  assert.deepEqual(issues(user.parse(null)), [{ path: [], message: 'expected object' }]);
  assert.deepEqual(issues(user.parse([])), [{ path: [], message: 'expected object' }]);
  assert.deepEqual(issues(user.parse(undefined)), [{ path: [], message: 'required' }]);
  assert.deepEqual(issues(user.parse({})), [
    { path: ['name'], message: 'required' },
    { path: ['age'], message: 'required' },
  ]);
  assert.deepEqual(issues(user.parse({ age: 1.5, name: 7 })), [
    { path: ['name'], message: 'expected string' },
    { path: ['age'], message: 'not an integer' },
  ]);
});

test('object: strict reports unknown keys after shape issues', () => {
  const s = object({ a: string() }, { strict: true });
  assert.deepEqual(s.parse({ a: 'x' }), { ok: true, value: { a: 'x' } });
  assert.deepEqual(issues(s.parse({ z: 1, a: 2, y: 3 })), [
    { path: ['a'], message: 'expected string' },
    { path: ['z'], message: 'unexpected key' },
    { path: ['y'], message: 'unexpected key' },
  ]);
  assert.equal(object({ a: string() }).parse({ a: 'x', z: 1 }).ok, true);
});

test('object: the input is not changed and the result is a new object', () => {
  const s = object({ a: optional(number(), { default: 1 }) });
  assert.deepEqual(s.parse({}), { ok: true, value: { a: 1 } });
  const input = { a: undefined, keep: 1 };
  const r = s.parse(input);
  assert.deepEqual(r.value, { a: 1 });
  assert.deepEqual(input, { a: undefined, keep: 1 });
  assert.notEqual(r.value, input);
});

test('optional', () => {
  assert.deepEqual(optional(string()).parse(undefined), { ok: true, value: undefined });
  assert.deepEqual(optional(string()).parse('x'), { ok: true, value: 'x' });
  assert.deepEqual(issues(optional(string()).parse(5)), [{ path: [], message: 'expected string' }]);
  assert.deepEqual(issues(optional(string()).parse(null)), [{ path: [], message: 'expected string' }]);
  assert.deepEqual(optional(number(), { default: 7 }).parse(undefined), { ok: true, value: 7 });
  assert.deepEqual(optional(number(), { default: 7 }).parse(3), { ok: true, value: 3 });
  assert.deepEqual(optional(boolean(), { default: false }).parse(undefined), { ok: true, value: false });
  assert.deepEqual(optional(number(), { default: 0 }).parse(undefined), { ok: true, value: 0 });
});

test('optional keys: omitted when undefined, defaults applied, falsy values kept', () => {
  const s = object({ a: optional(string()), b: optional(number(), { default: 5 }), c: optional(boolean()), d: optional(string()) });
  const r = s.parse({ c: false, d: '' });
  assert.deepEqual(r, { ok: true, value: { b: 5, c: false, d: '' } });
  assert.equal(Object.hasOwn(r.value, 'a'), false);
  assert.deepEqual(s.parse({ a: undefined }).value, { b: 5 });
  assert.deepEqual(Object.keys(s.parse({}).value), ['b']);
});

test('oneOf', () => {
  const u = oneOf(string(), number());
  assert.deepEqual(u.parse('x'), { ok: true, value: 'x' });
  assert.deepEqual(u.parse(2), { ok: true, value: 2 });
  assert.deepEqual(issues(u.parse(true)), [{ path: [], message: 'no alternative matched' }]);
  const first = oneOf(object({ kind: string(), n: optional(number(), { default: 1 }) }), string());
  assert.deepEqual(first.parse({ kind: 'k' }), { ok: true, value: { kind: 'k', n: 1 } });
  assert.deepEqual(oneOf(optional(string()), number()).parse(undefined), { ok: true, value: undefined });
});

test('oneOf reports at the path where it sits', () => {
  const s = object({ id: oneOf(string(), number()) });
  assert.deepEqual(issues(s.parse({ id: null })), [{ path: ['id'], message: 'no alternative matched' }]);
  assert.deepEqual(issues(s.parse({})), [{ path: ['id'], message: 'no alternative matched' }]);
});

const schema = object({
  title: string({ min: 1 }),
  users: array(
    object({
      name: string(),
      email: string({ pattern: /^[^@\s]+@[^@\s]+$/ }),
      tags: optional(array(string()), { default: [] }),
      role: oneOf(string({ pattern: /^(admin|user)$/ }), number()),
    }),
    { min: 1 },
  ),
  meta: optional(object({ draft: boolean() }, { strict: true })),
});

test('nested paths from the root', () => {
  const r = schema.parse({
    title: '',
    users: [
      { name: 'a', email: 'a@x.io', role: 'admin' },
      { name: 'b', email: 'nope', tags: ['ok', 3], role: 'guest' },
    ],
    meta: { draft: 'yes', extra: 1 },
  });
  assert.deepEqual(issues(r), [
    { path: ['title'], message: 'too short' },
    { path: ['users', 1, 'email'], message: 'does not match pattern' },
    { path: ['users', 1, 'tags', 1], message: 'expected string' },
    { path: ['users', 1, 'role'], message: 'no alternative matched' },
    { path: ['meta', 'draft'], message: 'expected boolean' },
    { path: ['meta', 'extra'], message: 'unexpected key' },
  ]);
});

test('nested success applies defaults at every level', () => {
  const r = schema.parse({ title: 'T', users: [{ name: 'a', email: 'a@x.io', role: 7 }], junk: 1 });
  assert.deepEqual(r, { ok: true, value: { title: 'T', users: [{ name: 'a', email: 'a@x.io', tags: [], role: 7 }] } });
});

test('validators honour the path they are given', () => {
  assert.deepEqual(issues(string().parse(1, ['a', 0])), [{ path: ['a', 0], message: 'expected string' }]);
  assert.deepEqual(issues(object({ k: number() }).parse({ k: 'x' }, ['root'])), [{ path: ['root', 'k'], message: 'expected number' }]);
  assert.deepEqual(issues(array(number()).parse([1, 'x'], ['list'])), [{ path: ['list', 1], message: 'expected number' }]);
  const given = ['p'];
  string().parse(1, given);
  assert.deepEqual(given, ['p']);
});

test('validate returns the top-level result', () => {
  assert.deepEqual(validate(number(), 3), { ok: true, value: 3 });
  assert.deepEqual(validate(number(), 'x'), { ok: false, issues: [{ path: [], message: 'expected number' }] });
});

test('assertValid returns the value or throws a ValidationError', () => {
  assert.deepEqual(assertValid(object({ a: optional(number(), { default: 2 }) }), {}), { a: 2 });
  try {
    assertValid(object({ a: number(), b: string() }), { a: 'x' });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ValidationError);
    assert.ok(e instanceof Error);
    assert.deepEqual(e.issues, [
      { path: ['a'], message: 'expected number' },
      { path: ['b'], message: 'required' },
    ]);
    assert.equal(e.message, 'a: expected number\nb: required');
  }
});

test('formatIssues', () => {
  assert.equal(formatIssues([]), '');
  assert.equal(formatIssues([{ path: [], message: 'expected object' }]), '(root): expected object');
  assert.equal(
    formatIssues([
      { path: ['users', 1, 'email'], message: 'does not match pattern' },
      { path: [0, 'name'], message: 'required' },
      { path: ['a', 'b', 2, 3], message: 'x' },
      { path: [2], message: 'y' },
    ]),
    'users[1].email: does not match pattern\n[0].name: required\na.b[2][3]: x\n[2]: y',
  );
});

test('root-level array of objects end to end', () => {
  const s = array(object({ name: string() }));
  const r = s.parse([{ name: 'a' }, {}]);
  assert.equal(formatIssues(issues(r)), '[1].name: required');
  assert.throws(() => assertValid(s, 'nope'), { message: '(root): expected array' });
});

test('large input stays quick', () => {
  const s = array(object({ id: number({ int: true }), tags: array(string()) }));
  const input = Array.from({ length: 20000 }, (_, i) => ({ id: i, tags: ['a', 'b'] }));
  const start = Date.now();
  const r = s.parse(input);
  assert.equal(r.ok, true);
  assert.equal(r.value.length, 20000);
  assert.ok(Date.now() - start < 3000);
});
