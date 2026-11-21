import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthBudget, monthlySummary, parseBudgets } from '../src/index.mjs';

test('yearly budgets split exactly across the twelve months', () => {
  const b = parseBudgets({ yearly: { Travel: 100000 } });
  let total = 0;
  for (let m = 1; m <= 12; m += 1) total += monthBudget(b, 'Travel', `2026-${String(m).padStart(2, '0')}`);
  assert.equal(total, 100000);
});

test('carry-over rolls unspent budget into the next month', () => {
  const b = parseBudgets({ monthly: { Food: 10000 }, carryOver: ['Food'] });
  const txs = [{ id: 'a', date: '2026-01-05', description: 'x', cents: -4000, category: 'Food' }];
  const feb = monthlySummary(txs, b, '2026-02').categories[0];
  assert.deepEqual([feb.carry, feb.available], [6000, 16000]);
});

test('summary totals', () => {
  const txs = [
    { id: 'a', date: '2026-01-05', description: 'x', cents: -4000, category: 'Food' },
    { id: 'b', date: '2026-01-06', description: 'y', cents: 9000, category: 'Pay' },
  ];
  const s = monthlySummary(txs, parseBudgets({}), '2026-01');
  assert.deepEqual([s.income, s.expenses, s.net], [9000, 4000, 5000]);
});
