import { daysBetween, formatDate } from './dates.mjs';
import { percent } from './numbers.mjs';
import { padLeft, truncate } from './strings.mjs';

export function buildReport(invoices, today) {
  const late = invoices.filter((inv) => inv.due.getTime() < today.getTime());
  const rows = late.map((inv) => {
    const name = truncate(inv.customer, 12).padEnd(12);
    return `${padLeft(inv.id, 5)}  ${name}  ${padLeft(inv.amount.toFixed(2), 9)}  due ${formatDate(inv.due)}  ${daysBetween(inv.due, today)}d late`;
  });
  rows.push(`${late.length} of ${invoices.length} overdue (${percent(late.length, invoices.length)}%)`);
  return rows.join('\n') + '\n';
}
