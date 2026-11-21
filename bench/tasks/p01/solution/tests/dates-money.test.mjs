import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents, parseAmount, parseDate } from '../src/index.mjs';
import { percentOf } from '../src/money.mjs';
import { nextMonth } from '../src/dates.mjs';

test('dates in the three formats', () => {
  assert.equal(parseDate('2026-03-07'), '2026-03-07');
  assert.equal(parseDate('3/7/2026'), '2026-03-07');
  assert.equal(parseDate('07.03.2026'), '2026-03-07');
});

test('impossible dates and leap years', () => {
  assert.equal(parseDate('2026-02-29'), null);
  assert.equal(parseDate('2024-02-29'), '2024-02-29');
  assert.equal(parseDate('1900-02-29'), null);
  assert.equal(parseDate('2026-04-31'), null);
});

test('amounts: grouping, sign, brackets and bad input', () => {
  assert.equal(parseAmount('$1,234.56'), 123456);
  assert.equal(parseAmount('-$5.00'), -500);
  assert.equal(parseAmount('(2.5)'), -250);
  assert.equal(parseAmount('1,23.00'), null);
  assert.equal(parseAmount('$-5'), null);
  assert.ok(Object.is(parseAmount('-0'), 0));
});

test('formatting and percentages', () => {
  assert.equal(formatCents(-100000005), '-1,000,000.05');
  assert.equal(formatCents(7), '0.07');
  assert.equal(percentOf(5, 8), 63);
  assert.equal(percentOf(1, 0), null);
});

test('nextMonth wraps the year', () => {
  assert.equal(nextMonth('2026-12'), '2027-01');
  assert.equal(nextMonth('2026-01'), '2026-02');
});
