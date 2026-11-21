import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlySummary, parseBudgets } from '../src/index.mjs';

const tx = (id, date, cents, category) => ({ id, date, description: id, cents, category });

test('refunds reduce spending but never below zero', () => {
  const s = monthlySummary([tx('a', '2026-01-05', -1000, 'Food'), tx('b', '2026-01-06', 400, 'Food'), tx('c', '2026-01-07', 900, 'Shop')], parseBudgets({}), '2026-01');
  assert.deepEqual(s.categories.map((r) => [r.category, r.spent]), [['Food', 600]]);
  assert.deepEqual([s.income, s.expenses, s.net], [1300, 1000, 300]);
});

test('rows sort by spend then name, and budget-only categories are listed', () => {
  const b = parseBudgets({ monthly: { Idle: 500 } });
  const s = monthlySummary([tx('a', '2026-01-05', -100, 'B'), tx('b', '2026-01-05', -100, 'A')], b, '2026-01');
  assert.deepEqual(s.categories.map((r) => r.category), ['A', 'B', 'Idle']);
  assert.equal(s.categories[2].remaining, 500);
});

test('carry-over skips overspent months without going negative', () => {
  const b = parseBudgets({ monthly: { Food: 1000 }, carryOver: ['Food'] });
  const txs = [tx('a', '2026-01-05', -3000, 'Food'), tx('b', '2026-03-05', -100, 'Other')];
  const row = (m) => monthlySummary(txs, b, m).categories.find((r) => r.category === 'Food');
  assert.equal(row('2026-02').carry, 0);
  assert.equal(row('2026-03').carry, 1000);
  assert.equal(row('2026-03').available, 2000);
});

test('percent rounds half up', () => {
  const b = parseBudgets({ monthly: { Food: 8 } });
  const row = monthlySummary([tx('a', '2026-01-05', -5, 'Food')], b, '2026-01').categories[0];
  assert.equal(row.percent, 63);
});

test('months before the first transaction have no carry', () => {
  const b = parseBudgets({ monthly: { Food: 1000 }, carryOver: ['Food'] });
  const row = monthlySummary([tx('a', '2026-05-05', -100, 'Food')], b, '2026-04').categories[0];
  assert.deepEqual([row.carry, row.available], [0, 1000]);
});
