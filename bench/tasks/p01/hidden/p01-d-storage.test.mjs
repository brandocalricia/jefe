import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerError, importInto, loadLedger, migrateLedger, parseTransactions, saveLedger, transactionId } from '../src/index.mjs';
import { listDir, tmp, tx } from './p01-helpers.mjs';

const bad = (fn, message) => assert.throws(fn, (e) => e instanceof LedgerError && e.code === 'BAD_LEDGER' && e.message === message, message);
const sortedCopy = (list) => [...list].sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
const EMPTY = { version: 2, transactions: [], imports: [] };

const V1 = {
  version: 1,
  entries: [
    { date: '2026-01-05', desc: '  Coffee   Shop ', amount: -4.5, cat: 'Dining' },
    { date: '1/6/2026', desc: 'Old', amount: 10, deleted: true },
    { date: '1/6/2026', desc: 'Lunch', amount: 0.1 + 0.2, cat: '   ' },
    { date: '2026-01-05', desc: 'coffee shop', amount: -4.5 },
    { date: '2026-01-07', desc: 'Salary', amount: 1234.56, cat: ' Income ', id: 'legacy-id' },
    { date: '2026-01-08', desc: 'tiny', amount: -0.001 },
    { date: '2026-01-09', desc: 'Gas', amount: 5 },
  ],
};

test('migrateLedger v1 to v2: fields, categories, cents from dollars, dropped tombstones', () => {
  const out = migrateLedger(V1);
  assert.equal(out.version, 2);
  assert.deepEqual(out.imports, []);
  const by = (d) => out.transactions.find((t) => t.description === d);
  assert.equal(out.transactions.length, 6);
  assert.equal(by('Old'), undefined);
  assert.deepEqual(by('Coffee Shop'), { id: transactionId({ date: '2026-01-05', cents: -450, description: 'Coffee Shop' }, 1), date: '2026-01-05', description: 'Coffee Shop', cents: -450, category: 'Dining' });
  assert.deepEqual([by('Lunch').date, by('Lunch').cents, by('Lunch').category], ['2026-01-06', 30, 'Uncategorized']);
  assert.deepEqual([by('Salary').cents, by('Salary').category], [123456, 'Income']);
  assert.equal(by('Salary').id, transactionId({ date: '2026-01-07', cents: 123456, description: 'Salary' }, 1));
  assert.ok(Object.is(by('tiny').cents, 0));
  assert.equal(by('Gas').cents, 500);
});

test('migrateLedger v1: repeated purchases count occurrences, output is sorted, input untouched', () => {
  const snapshot = JSON.parse(JSON.stringify(V1));
  const out = migrateLedger(V1);
  const second = out.transactions.find((t) => t.description === 'coffee shop');
  assert.equal(second.id, transactionId({ date: '2026-01-05', cents: -450, description: 'coffee shop' }, 2));
  assert.deepEqual(out.transactions, sortedCopy(out.transactions));
  assert.deepEqual(V1, snapshot);
});

test('migrateLedger is idempotent and v2 input passes through sorted with imports defaulted', () => {
  const once = migrateLedger(V1);
  assert.deepEqual(migrateLedger(once), once);
  const v2 = { version: 2, transactions: [tx('b', '2026-02-01', -1, 'x'), tx('a', '2026-02-01', -1, 'y'), tx('c', '2026-01-01', -1, 'z')] };
  const out = migrateLedger(v2);
  assert.deepEqual(out.transactions.map((t) => t.id), ['c', 'a', 'b']);
  assert.deepEqual(out.imports, []);
  assert.equal(out.version, 2);
  assert.deepEqual(migrateLedger({ version: 2, transactions: [], imports: [{ source: 's', added: 1, skipped: 0 }] }).imports, [{ source: 's', added: 1, skipped: 0 }]);
});

test('migrateLedger: version errors', () => {
  bad(() => migrateLedger({}), 'missing ledger version');
  bad(() => migrateLedger(null), 'missing ledger version');
  bad(() => migrateLedger({ transactions: [] }), 'missing ledger version');
  bad(() => migrateLedger({ version: 3, transactions: [] }), 'unsupported ledger version 3');
  bad(() => migrateLedger({ version: 0 }), 'unsupported ledger version 0');
  bad(() => migrateLedger({ version: 2, transactions: {} }), 'transactions must be an array');
  bad(() => migrateLedger({ version: 1, entries: {} }), 'entries must be an array');
});

test('migrateLedger v1: entry errors use the original index and a fixed check order', () => {
  const e = (entry) => ({ version: 1, entries: [{ date: '2026-01-01', desc: 'ok', amount: 1, deleted: true }, entry] });
  bad(() => migrateLedger(e({ date: '13/45/2026', desc: 'x', amount: 1 })), 'entries[1]: invalid date "13/45/2026"');
  bad(() => migrateLedger(e({ date: '2026-01-02', desc: 'x', amount: '5' })), 'entries[1]: invalid amount');
  bad(() => migrateLedger(e({ date: '2026-01-02', desc: 'x', amount: null })), 'entries[1]: invalid amount');
  bad(() => migrateLedger(e({ date: '2026-01-02', desc: '  ', amount: 1 })), 'entries[1]: empty description');
  bad(() => migrateLedger(e({ date: 'nope', desc: '', amount: 'x' })), 'entries[1]: invalid date "nope"');
  bad(() => migrateLedger(e({ date: '2026-01-02', desc: '', amount: 'x' })), 'entries[1]: invalid amount');
  assert.doesNotThrow(() => migrateLedger({ version: 1, entries: [{ date: 'garbage', desc: '', amount: 'x', deleted: true }] }));
});

const SAMPLE = parseTransactions('date,description,amount\n2026-03-01,Coffee,-4.50\n2026-03-01,Coffee,-4.50\n2026-03-02,Payroll,3000.00\n').transactions;

test('importInto adds fresh transactions, logs the import and sorts', () => {
  const r = importInto(EMPTY, SAMPLE, 'march.csv');
  assert.deepEqual([r.added, r.skipped], [3, 0]);
  assert.equal(r.ledger.version, 2);
  assert.deepEqual(r.ledger.imports, [{ source: 'march.csv', added: 3, skipped: 0 }]);
  assert.deepEqual(r.ledger.transactions, sortedCopy(SAMPLE));
  assert.deepEqual(EMPTY, { version: 2, transactions: [], imports: [] });
});

test('importInto is idempotent: a second import adds nothing and changes nothing', () => {
  const first = importInto(EMPTY, SAMPLE, 'march.csv').ledger;
  const second = importInto(first, SAMPLE, 'march-again.csv');
  assert.deepEqual([second.added, second.skipped], [0, 3]);
  assert.deepEqual(second.ledger, first);
  assert.equal(second.ledger.imports.length, 1);
});

test('importInto on overlapping files keeps both purchases of a repeated row exactly once', () => {
  const first = importInto(EMPTY, SAMPLE, 'a.csv').ledger;
  const overlap = parseTransactions('date,description,amount\n2026-03-01,Coffee,-4.50\n2026-03-01,Coffee,-4.50\n2026-03-01,Coffee,-4.50\n2026-03-05,Rent,-900.00\n').transactions;
  const r = importInto(first, overlap, 'b.csv');
  assert.deepEqual([r.added, r.skipped], [2, 2]);
  assert.equal(r.ledger.transactions.length, 5);
  assert.equal(r.ledger.transactions.filter((t) => t.description === 'Coffee').length, 3);
  assert.deepEqual(r.ledger.imports, [{ source: 'a.csv', added: 3, skipped: 0 }, { source: 'b.csv', added: 2, skipped: 2 }]);
  assert.deepEqual(r.ledger.transactions, sortedCopy(r.ledger.transactions));
  assert.equal(first.transactions.length, 3);
});

test('importInto with nothing to import leaves the log alone', () => {
  const r = importInto(EMPTY, [], 'empty.csv');
  assert.deepEqual(r, { ledger: EMPTY, added: 0, skipped: 0 });
});

test('loadLedger: a missing file is a fresh version 2 ledger and is not created', () => {
  const dir = tmp();
  assert.deepEqual(loadLedger(join(dir, 'none.json')), EMPTY);
  assert.deepEqual(listDir(dir), []);
});

test('loadLedger: invalid JSON names the path, version 1 files are migrated in memory only', () => {
  const dir = tmp();
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{ "version": 2, ');
  bad(() => loadLedger(broken), `${broken} is not valid JSON`);
  const old = join(dir, 'old.json');
  const text = JSON.stringify(V1);
  writeFileSync(old, text);
  assert.deepEqual(loadLedger(old), migrateLedger(V1));
  assert.equal(readFileSync(old, 'utf8'), text);
  const wrong = join(dir, 'future.json');
  writeFileSync(wrong, '{"version":9}');
  bad(() => loadLedger(wrong), 'unsupported ledger version 9');
});

test('saveLedger writes the documented JSON text, sorted, and leaves no extra files', () => {
  const dir = tmp();
  const path = join(dir, 'ledger.json');
  const ledger = { version: 2, transactions: [tx('b', '2026-02-01', -250, 'Two'), tx('a', '2026-01-01', 100, 'One', 'Income')], imports: [{ source: 's.csv', added: 2, skipped: 0 }] };
  saveLedger(path, ledger);
  const expected = JSON.stringify({ version: 2, transactions: [ledger.transactions[1], ledger.transactions[0]], imports: ledger.imports }, null, 2) + '\n';
  assert.equal(readFileSync(path, 'utf8'), expected);
  assert.deepEqual(listDir(dir), ['ledger.json']);
  assert.deepEqual(loadLedger(path), { version: 2, transactions: sortedCopy(ledger.transactions), imports: ledger.imports });
  saveLedger(path, EMPTY);
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify(EMPTY, null, 2) + '\n');
  assert.deepEqual(listDir(dir), ['ledger.json']);
});

test('saveLedger only writes version 2 ledgers', () => {
  const dir = tmp();
  bad(() => saveLedger(join(dir, 'l.json'), V1), 'can only save version 2 ledgers');
  assert.deepEqual(listDir(dir), []);
});

test('saveLedger is atomic: a failed save keeps the old file and leaves nothing behind', () => {
  const dir = tmp();
  const path = join(dir, 'ledger.json');
  saveLedger(path, importInto(EMPTY, SAMPLE, 'a.csv').ledger);
  const before = readFileSync(path, 'utf8');
  const poisoned = { version: 2, transactions: [{ id: 'x', date: '2026-01-01', description: 'x', cents: 10n, category: 'c' }], imports: [] };
  assert.throws(() => saveLedger(path, poisoned));
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(listDir(dir), ['ledger.json']);
});

test('saveLedger into a missing folder throws and creates nothing', () => {
  const dir = tmp();
  const missing = join(dir, 'nope', 'ledger.json');
  assert.throws(() => saveLedger(missing, EMPTY));
  assert.equal(existsSync(join(dir, 'nope')), false);
  mkdirSync(join(dir, 'later'));
  saveLedger(join(dir, 'later', 'ledger.json'), EMPTY);
  assert.deepEqual(listDir(join(dir, 'later')), ['ledger.json']);
});
