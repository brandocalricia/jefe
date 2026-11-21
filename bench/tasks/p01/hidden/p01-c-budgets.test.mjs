import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerError, formatCents, monthBudget, monthlySummary, parseBudgets } from '../src/index.mjs';
import { tx } from './p01-helpers.mjs';

const bfails = (json, message) => assert.throws(() => parseBudgets(json), (e) => e instanceof LedgerError && e.code === 'BAD_BUDGET' && e.message === message, message);
const none = parseBudgets({});
const row = (summary, category) => summary.categories.find((r) => r.category === category);

test('formatCents', () => {
  const cases = { 0: '0.00', 5: '0.05', 99: '0.99', 100: '1.00', 123456: '1,234.56', 100000: '1,000.00', [-100000005]: '-1,000,000.05', [-5]: '-0.05', 99999: '999.99' };
  for (const [cents, text] of Object.entries(cases)) assert.equal(formatCents(Number(cents)), text, cents);
});

test('parseBudgets fills defaults and copies the values', () => {
  assert.deepEqual(parseBudgets({}), { monthly: {}, yearly: {}, carryOver: [] });
  const input = { monthly: { Groceries: 45000 }, yearly: { Travel: 100000 }, carryOver: ['Groceries'] };
  assert.deepEqual(parseBudgets(input), input);
  assert.deepEqual(parseBudgets({ monthly: { A: 0 } }), { monthly: { A: 0 }, yearly: {}, carryOver: [] });
});

test('parseBudgets reports the first problem in the documented order', () => {
  bfails(null, 'budget must be an object');
  bfails([], 'budget must be an object');
  bfails({ monthly: {}, extra: 1, other: 2 }, 'unknown key "extra"');
  bfails({ monthly: [] }, 'monthly must be an object');
  bfails({ monthly: { A: 10, B: -1, C: 'x' } }, 'monthly.B must be a non-negative integer');
  bfails({ monthly: { A: 1.5 } }, 'monthly.A must be a non-negative integer');
  bfails({ yearly: { Y: 'x' } }, 'yearly.Y must be a non-negative integer');
  bfails({ yearly: 3 }, 'yearly must be an object');
  bfails({ monthly: { A: -1 }, yearly: { B: -1 } }, 'monthly.A must be a non-negative integer');
  bfails({ monthly: { A: 1 }, carryOver: 'A' }, 'carryOver must be an array of strings');
  bfails({ monthly: { A: 1 }, carryOver: ['A', 3] }, 'carryOver must be an array of strings');
  bfails({ monthly: { A: 1 }, carryOver: ['A', 'Nope', 'Also'] }, 'carryOver names unknown category "Nope"');
  assert.doesNotThrow(() => parseBudgets({ yearly: { Travel: 1 }, carryOver: ['Travel'] }));
});

test('monthBudget: null without a budget, monthly amount, and exact yearly shares', () => {
  const b = parseBudgets({ monthly: { Food: 45000 }, yearly: { Travel: 100000, Tiny: 5, Even: 1200, Both: 13 } });
  assert.equal(monthBudget(b, 'Nothing', '2026-01'), null);
  assert.equal(monthBudget(b, 'Food', '2026-07'), 45000);
  assert.equal(monthBudget(b, 'Travel', '2026-01'), 8334);
  assert.equal(monthBudget(b, 'Travel', '2026-04'), 8334);
  assert.equal(monthBudget(b, 'Travel', '2026-05'), 8333);
  assert.equal(monthBudget(b, 'Travel', '2026-12'), 8333);
  const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
  for (const [cat, total] of [['Travel', 100000], ['Tiny', 5], ['Even', 1200], ['Both', 13]]) {
    assert.equal(months.reduce((s, m) => s + monthBudget(b, cat, m), 0), total, cat);
  }
  assert.deepEqual(months.map((m) => monthBudget(b, 'Tiny', m)), [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(monthBudget(b, 'Even', '2026-09'), 100);
});

test('monthBudget adds the monthly amount and the yearly share when both are given', () => {
  const b = parseBudgets({ monthly: { G: 100 }, yearly: { G: 13 } });
  assert.equal(monthBudget(b, 'G', '2026-01'), 102);
  assert.equal(monthBudget(b, 'G', '2026-02'), 101);
});

const MARCH = [
  tx('1', '2026-03-02', -10000, 'a', 'Groceries'),
  tx('2', '2026-03-09', -5050, 'b', 'Groceries'),
  tx('3', '2026-03-10', 1000, 'refund', 'Groceries'),
  tx('4', '2026-03-11', -3000, 'c', 'Dining'),
  tx('5', '2026-03-31', 300000, 'pay', 'Income'),
  tx('6', '2026-03-12', -500, 'd', 'Uncategorized'),
  tx('7', '2026-03-13', 2000, 'gift', 'Gifts'),
  tx('8', '2026-02-28', -99999, 'old', 'Groceries'),
  tx('9', '2026-04-01', -77777, 'future', 'Dining'),
];

test('monthlySummary: totals count only the month, refunds reduce spending', () => {
  const budgets = parseBudgets({ monthly: { Groceries: 45000, Dining: 2000 }, yearly: { Travel: 100000 } });
  const s = monthlySummary(MARCH, budgets, '2026-03');
  assert.equal(s.month, '2026-03');
  assert.equal(s.income, 303000);
  assert.equal(s.expenses, 18550);
  assert.equal(s.net, 284450);
  assert.deepEqual(s.categories.map((r) => r.category), ['Groceries', 'Dining', 'Uncategorized', 'Travel']);
  assert.deepEqual(row(s, 'Groceries'), { category: 'Groceries', spent: 14050, budget: 45000, carry: 0, available: 45000, remaining: 30950, percent: 31 });
  assert.deepEqual(row(s, 'Dining'), { category: 'Dining', spent: 3000, budget: 2000, carry: 0, available: 2000, remaining: -1000, percent: 150 });
  assert.deepEqual(row(s, 'Travel'), { category: 'Travel', spent: 0, budget: 8334, carry: 0, available: 8334, remaining: 8334, percent: 0 });
});

test('monthlySummary: unbudgeted categories carry nulls, and income-only categories are not listed', () => {
  const s = monthlySummary(MARCH, none, '2026-03');
  assert.deepEqual(row(s, 'Uncategorized'), { category: 'Uncategorized', spent: 500, budget: null, carry: 0, available: null, remaining: null, percent: null });
  assert.equal(row(s, 'Gifts'), undefined);
  assert.equal(row(s, 'Income'), undefined);
  assert.deepEqual(s.categories.map((r) => r.category), ['Groceries', 'Dining', 'Uncategorized']);
});

test('monthlySummary: a missing or empty category counts as Uncategorized', () => {
  const s = monthlySummary([{ id: 'a', date: '2026-01-01', description: 'x', cents: -100 }, { id: 'b', date: '2026-01-02', description: 'y', cents: -50, category: '' }], none, '2026-01');
  assert.deepEqual(s.categories.map((r) => [r.category, r.spent]), [['Uncategorized', 150]]);
});

test('monthlySummary: empty month and empty ledger', () => {
  const empty = monthlySummary([], none, '2026-03');
  assert.deepEqual(empty, { month: '2026-03', income: 0, expenses: 0, net: 0, categories: [] });
  const other = monthlySummary(MARCH, none, '2027-01');
  assert.deepEqual([other.income, other.expenses, other.net, other.categories.length], [0, 0, 0, 0]);
});

test('monthlySummary: sorted by spent descending then name ascending by code unit', () => {
  const txs = ['Zed', 'apple', 'Mid', 'Big'].map((c, i) => tx(String(i), '2026-01-05', c === 'Big' ? -900 : c === 'Mid' ? -500 : -100, 'x', c));
  const s = monthlySummary(txs, none, '2026-01');
  assert.deepEqual(s.categories.map((r) => r.category), ['Big', 'Mid', 'Zed', 'apple']);
});

test('percent rounds half up in integer arithmetic and is null for zero availability', () => {
  const at = (spent, budget) => {
    const s = monthlySummary([tx('1', '2026-01-01', -spent, 'x', 'C')], parseBudgets({ monthly: { C: budget } }), '2026-01');
    return row(s, 'C').percent;
  };
  assert.equal(at(1, 200), 1);
  assert.equal(at(1, 201), 0);
  assert.equal(at(5, 8), 63);
  assert.equal(at(1, 3), 33);
  assert.equal(at(2, 3), 67);
  assert.equal(at(10000, 10000), 100);
  assert.equal(at(25000, 10000), 250);
  assert.equal(at(0, 0), null);
  assert.equal(at(500, 0), null);
});

const GROCERIES = [
  tx('1', '2026-01-10', -7000, 'a', 'Groceries'),
  tx('2', '2026-03-10', -12000, 'b', 'Groceries'),
  tx('3', '2026-04-10', -5000, 'c', 'Groceries'),
  tx('4', '2026-05-10', -40000, 'd', 'Groceries'),
  tx('5', '2026-06-10', -100, 'e', 'Other'),
];

test('carry-over: unspent budget rolls forward through months without transactions', () => {
  const b = parseBudgets({ monthly: { Groceries: 10000 }, carryOver: ['Groceries'] });
  const g = (m) => row(monthlySummary(GROCERIES, b, m), 'Groceries');
  assert.deepEqual(g('2026-01'), { category: 'Groceries', spent: 7000, budget: 10000, carry: 0, available: 10000, remaining: 3000, percent: 70 });
  assert.deepEqual([g('2026-02').carry, g('2026-02').available, g('2026-02').remaining], [3000, 13000, 13000]);
  assert.deepEqual([g('2026-03').carry, g('2026-03').available, g('2026-03').remaining], [13000, 23000, 11000]);
  assert.deepEqual([g('2026-04').carry, g('2026-04').available, g('2026-04').remaining], [11000, 21000, 16000]);
  assert.deepEqual([g('2026-05').carry, g('2026-05').remaining], [16000, -14000]);
});

test('carry-over: overspending is not carried as debt, and months before the first have no carry', () => {
  const b = parseBudgets({ monthly: { Groceries: 10000 }, carryOver: ['Groceries'] });
  const june = row(monthlySummary(GROCERIES, b, '2026-06'), 'Groceries');
  assert.deepEqual([june.carry, june.available, june.remaining], [0, 10000, 10000]);
  const early = row(monthlySummary(GROCERIES, b, '2025-12'), 'Groceries');
  assert.deepEqual([early.spent, early.carry, early.available], [0, 0, 10000]);
  const later = row(monthlySummary(GROCERIES, b, '2026-07'), 'Groceries');
  assert.deepEqual([later.carry, later.available], [10000, 20000]);
});

test('carry-over: only listed categories carry, and the chain starts at the earliest transaction month', () => {
  const b = parseBudgets({ monthly: { Groceries: 10000, Dining: 5000 }, carryOver: ['Groceries'] });
  const txs = [tx('1', '2026-01-10', -1000, 'a', 'Dining'), tx('2', '2026-01-11', -1000, 'b', 'Groceries')];
  const feb = monthlySummary(txs, b, '2026-02');
  assert.deepEqual([row(feb, 'Dining').carry, row(feb, 'Dining').available], [0, 5000]);
  assert.deepEqual([row(feb, 'Groceries').carry, row(feb, 'Groceries').available], [9000, 19000]);
  const lateStart = monthlySummary([tx('3', '2026-02-01', -1000, 'z', 'Groceries')], b, '2026-02');
  assert.equal(row(lateStart, 'Groceries').carry, 0);
});

test('carry-over combines with yearly shares and does not change the inputs', () => {
  const b = parseBudgets({ yearly: { Travel: 100000 }, carryOver: ['Travel'] });
  const txs = [tx('1', '2026-01-03', -8000, 'a', 'Travel')];
  const snapshot = JSON.parse(JSON.stringify([txs, b]));
  const feb = row(monthlySummary(txs, b, '2026-02'), 'Travel');
  assert.deepEqual([feb.budget, feb.carry, feb.available, feb.remaining], [8334, 334, 8668, 8668]);
  assert.deepEqual(JSON.parse(JSON.stringify([txs, b])), snapshot);
});
