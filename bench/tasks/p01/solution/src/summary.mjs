import { monthBudget } from './budgets.mjs';
import { nextMonth } from './dates.mjs';
import { percentOf } from './money.mjs';
import { UNCATEGORIZED } from './transactions.mjs';
import { compareText } from './util.mjs';

// month -> category -> net cents
function netByMonth(transactions) {
  const nets = new Map();
  for (const tx of transactions) {
    const month = tx.date.slice(0, 7);
    const category = tx.category || UNCATEGORIZED;
    if (!nets.has(month)) nets.set(month, new Map());
    const row = nets.get(month);
    row.set(category, (row.get(category) ?? 0) + tx.cents);
  }
  return nets;
}

const spentIn = (nets, month, category) => Math.max(0, -(nets.get(month)?.get(category) ?? 0));

function carryInto(budgets, category, month, first, nets) {
  if (!budgets.carryOver.includes(category) || first === null || month <= first) return 0;
  let carry = 0;
  for (let m = first; m < month; m = nextMonth(m)) {
    const available = monthBudget(budgets, category, m) + carry;
    carry = Math.max(0, available - spentIn(nets, m, category));
  }
  return carry;
}

export function monthlySummary(transactions, budgets, month) {
  const nets = netByMonth(transactions);
  const first = nets.size === 0 ? null : [...nets.keys()].sort()[0];
  let income = 0;
  let expenses = 0;
  for (const tx of transactions) {
    if (tx.date.slice(0, 7) !== month) continue;
    if (tx.cents > 0) income += tx.cents;
    else expenses -= tx.cents;
  }
  const names = new Set([...Object.keys(budgets.monthly), ...Object.keys(budgets.yearly)]);
  for (const category of nets.get(month)?.keys() ?? []) if (spentIn(nets, month, category) > 0) names.add(category);
  const categories = [...names].map((category) => {
    const spent = spentIn(nets, month, category);
    const budget = monthBudget(budgets, category, month);
    if (budget === null) return { category, spent, budget, carry: 0, available: null, remaining: null, percent: null };
    const carry = carryInto(budgets, category, month, first, nets);
    const available = budget + carry;
    return { category, spent, budget, carry, available, remaining: available - spent, percent: percentOf(spent, available) };
  });
  categories.sort((a, b) => b.spent - a.spent || compareText(a.category, b.category));
  return { month, income, expenses, net: income - expenses, categories };
}
