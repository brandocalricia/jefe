import { createHash } from 'node:crypto';
import { parseCsv } from './csv.mjs';
import { parseDate } from './dates.mjs';
import { LedgerError } from './errors.mjs';
import { parseAmount } from './money.mjs';

export const UNCATEGORIZED = 'Uncategorized';
const REQUIRED = ['date', 'description', 'amount'];

export function normalizeDescription(text) {
  return String(text).trim().replace(/\s+/g, ' ');
}

export function transactionId(tx, occurrence) {
  const key = `${tx.date}|${tx.cents}|${tx.description.toLowerCase()}#${occurrence}`;
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}

// Builds transactions from already-valid parts, numbering repeats of the same purchase.
export function buildTransactions(parts) {
  const seen = new Map();
  return parts.map(({ date, description, cents, category = UNCATEGORIZED }) => {
    const key = `${date}|${cents}|${description.toLowerCase()}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { id: transactionId({ date, cents, description }, n), date, description, cents, category };
  });
}

export function parseTransactions(text) {
  const records = parseCsv(text);
  if (records.length === 0) return { transactions: [], errors: [] };
  const header = records[0].fields.map((h) => h.trim().toLowerCase());
  const col = {};
  for (const name of REQUIRED) {
    col[name] = header.indexOf(name);
    if (col[name] < 0) throw new LedgerError('BAD_HEADER', `missing column: ${name}`);
  }
  const parts = [];
  const errors = [];
  for (const { line, fields } of records.slice(1)) {
    const fail = (message) => errors.push({ line, message });
    if (fields.length !== header.length) { fail(`expected ${header.length} fields, found ${fields.length}`); continue; }
    const date = parseDate(fields[col.date]);
    if (date === null) { fail(`invalid date "${fields[col.date]}"`); continue; }
    const cents = parseAmount(fields[col.amount]);
    if (cents === null) { fail(`invalid amount "${fields[col.amount]}"`); continue; }
    const description = normalizeDescription(fields[col.description]);
    if (description === '') { fail('empty description'); continue; }
    parts.push({ date, description, cents });
  }
  return { transactions: buildTransactions(parts), errors };
}

export function splitDuplicates(transactions, existingIds) {
  const known = new Set(existingIds);
  const fresh = [];
  const duplicates = [];
  for (const tx of transactions) (known.has(tx.id) ? duplicates : fresh).push(tx);
  return { fresh, duplicates };
}
