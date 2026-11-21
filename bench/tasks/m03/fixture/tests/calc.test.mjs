import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calc } from '../src/calc.mjs';
import { CalcError } from '../src/errors.mjs';

test('arithmetic and precedence', () => {
  assert.equal(calc('1 + 2 * 3'), 7);
  assert.equal(calc('(1 + 2) * 3'), 9);
  assert.equal(calc('10 - 4 - 3'), 3);
});

test('variables', () => {
  assert.equal(calc('x * 2', { x: 21 }), 42);
});

test('errors are CalcErrors', () => {
  assert.throws(() => calc('1 +'), CalcError);
});
