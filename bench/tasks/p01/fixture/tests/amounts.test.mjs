import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseDate, formatCents } from '../src/index.mjs';

test('parseAmount reads plain, grouped, signed and bracketed amounts', () => {
  assert.equal(parseAmount('12.5'), 1250);
  assert.equal(parseAmount('$1,234.56'), 123456);
  assert.equal(parseAmount('(12.34)'), -1234);
  assert.equal(parseAmount('abc'), null);
});

test('parseDate normalises the three accepted formats', () => {
  assert.equal(parseDate('3/7/2026'), '2026-03-07');
  assert.equal(parseDate('07.03.2026'), '2026-03-07');
  assert.equal(parseDate('2026-02-30'), null);
});

test('formatCents groups thousands', () => {
  assert.equal(formatCents(123456), '1,234.56');
  assert.equal(formatCents(-5), '-0.05');
});
