import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDate } from './dates.mjs';
import { LedgerError } from './errors.mjs';
import { compareText } from './util.mjs';
import { buildTransactions, normalizeDescription, splitDuplicates, UNCATEGORIZED } from './transactions.mjs';

let tempCounter = 0;
const bad = (message) => new LedgerError('BAD_LEDGER', message);
const byDateThenId = (a, b) => compareText(a.date, b.date) || compareText(a.id, b.id);
const sorted = (transactions) => [...transactions].sort(byDateThenId);

export function emptyLedger() {
  return { version: 2, transactions: [], imports: [] };
}

// Dollars as a float to whole cents, via two-decimal text so 0.1 + 0.2 becomes 30.
function dollarsToCents(amount) {
  return Number(amount.toFixed(2).replace('.', '')) || 0;
}

function migrateV1(ledger) {
  if (!Array.isArray(ledger.entries)) throw bad('entries must be an array');
  const parts = [];
  ledger.entries.forEach((entry, i) => {
    if (entry && entry.deleted === true) return;
    const fail = (problem) => bad(`entries[${i}]: ${problem}`);
    const date = parseDate(entry?.date ?? '');
    if (date === null) throw fail(`invalid date "${entry?.date}"`);
    if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount)) throw fail('invalid amount');
    const description = normalizeDescription(entry.desc ?? '');
    if (description === '') throw fail('empty description');
    const cat = typeof entry.cat === 'string' ? entry.cat.trim() : '';
    parts.push({ date, description, cents: dollarsToCents(entry.amount), category: cat === '' ? UNCATEGORIZED : cat });
  });
  return { version: 2, transactions: sorted(buildTransactions(parts)), imports: [] };
}

export function migrateLedger(ledger) {
  if (ledger === null || typeof ledger !== 'object' || ledger.version === undefined) throw bad('missing ledger version');
  if (ledger.version === 1) return migrateV1(ledger);
  if (ledger.version !== 2) throw bad(`unsupported ledger version ${ledger.version}`);
  if (!Array.isArray(ledger.transactions)) throw bad('transactions must be an array');
  return { version: 2, transactions: sorted(ledger.transactions), imports: [...(ledger.imports ?? [])] };
}

export function importInto(ledger, transactions, source) {
  const { fresh, duplicates } = splitDuplicates(transactions, ledger.transactions.map((t) => t.id));
  const imports = [...ledger.imports];
  if (fresh.length > 0) imports.push({ source, added: fresh.length, skipped: duplicates.length });
  return {
    ledger: { version: 2, transactions: sorted([...ledger.transactions, ...fresh]), imports },
    added: fresh.length,
    skipped: duplicates.length,
  };
}

export function loadLedger(path) {
  if (!existsSync(path)) return emptyLedger();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) throw bad(`${path} is not valid JSON`);
    throw err;
  }
  return migrateLedger(parsed);
}

export function saveLedger(path, ledger) {
  if (ledger.version !== 2) throw bad('can only save version 2 ledgers');
  const text = JSON.stringify({ version: 2, transactions: sorted(ledger.transactions), imports: ledger.imports }, null, 2) + '\n';
  const temp = join(dirname(path), `.ledgerly-${process.pid}-${(tempCounter += 1)}.tmp`);
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* nothing to clean up */ }
    throw err;
  }
}
