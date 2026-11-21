import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, compileRules } from '../src/index.mjs';

const tx = (description, cents) => ({ id: 'x', date: '2026-01-01', description, cents, category: 'Uncategorized' });

test('first matching rule wins', () => {
  const rules = compileRules({ rules: [{ category: 'A', contains: 'shop' }, { category: 'B', contains: 'shop' }] });
  assert.equal(categorize(rules, tx('Corner Shop', -100)), 'A');
});

test('amount bounds are inclusive', () => {
  const rules = compileRules({ rules: [{ category: 'Small', min: -500, max: -100 }] });
  assert.equal(categorize(rules, tx('x', -500)), 'Small');
  assert.equal(categorize(rules, tx('x', -501)), 'Uncategorized');
});

test('invalid rules name their index', () => {
  assert.throws(() => compileRules({ rules: [{ category: 'A', contains: 'a' }, { category: 'B' }] }), /rules\[1\]: needs at least one/);
});
