import { formatCents } from '../money.mjs';

// Text for `ledgerly report`: a monthly summary with only the categories that were spent in.
export function reportLines(summary) {
  const rows = summary.categories.filter((r) => r.spent > 0).map((r) => `  ${r.category}: ${formatCents(r.spent)}`);
  return [
    `Month: ${summary.month}`,
    `Income: ${formatCents(summary.income)}`,
    `Expenses: ${formatCents(summary.expenses)}`,
    `Net: ${formatCents(summary.net)}`,
    'Categories:',
    ...(rows.length > 0 ? rows : ['  (none)']),
  ];
}

// Text for `ledgerly budget`: one line per budgeted category.
export function budgetLine(row) {
  const pct = row.percent === null ? 'n/a' : `${row.percent}%`;
  const tail = row.remaining >= 0 ? `remaining ${formatCents(row.remaining)}` : `over by ${formatCents(-row.remaining)}`;
  const carry = row.carry > 0 ? ` [carry ${formatCents(row.carry)}]` : '';
  return `${row.category}: spent ${formatCents(row.spent)} of ${formatCents(row.available)} (${pct}), ${tail}${carry}`;
}

export function budgetLines(summary) {
  return [`Budget for ${summary.month}`, ...summary.categories.filter((r) => r.budget !== null).map(budgetLine)];
}
