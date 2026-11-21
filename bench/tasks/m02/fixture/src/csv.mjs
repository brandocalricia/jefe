import { clamp, roundTo } from './utils.mjs';
import { titleCase } from './utils.mjs';

// Lines: id,customer,amount,due(YYYY-MM-DD). Blank lines and # comments are skipped.
export function parseInvoices(text) {
  const out = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [id, customer, amount, due] = line.split(',').map((f) => f.trim());
    const cents = Number(amount);
    const when = new Date(`${due}T00:00:00Z`);
    if (!id || !customer || Number.isNaN(cents) || Number.isNaN(when.getTime())) {
      throw new Error(`line ${i + 1}: cannot parse "${line}"`);
    }
    out.push({ id, customer: titleCase(customer), amount: roundTo(clamp(cents, 0, Infinity), 2), due: when });
  }
  return out;
}
