import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, listDir, tmp, tx, write } from './p01-helpers.mjs';

const BANK = [
  'Date,Description,Amount',
  '2026-03-01,PAYROLL ACME,3000.00',
  '2026-03-02,Kroger #12,"-1,200.50"',
  '3/3/2026,"Coffee, Blue Door",-4.50',
  '03.03.2026,"Coffee, Blue Door",-4.50',
  '',
].join('\n');
const usage = (args, message) => {
  const dir = tmp();
  const r = cli(args, { cwd: dir });
  assert.deepEqual([r.status, r.stdout, r.stderr], [1, '', `error: ${message}\n`], args.join(' '));
  assert.deepEqual(listDir(dir), [], `${args.join(' ')} wrote files`);
};
const ledgerOf = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('usage errors: exit 1, one stderr line, nothing written', () => {
  usage([], 'missing command');
  usage(['nope'], 'unknown command "nope"');
  usage(['bogus', '--x'], 'unknown command "bogus"');
  usage(['import'], 'import requires a CSV file');
  usage(['import', '--bogus', 'a.csv'], 'unknown option "--bogus"');
  usage(['import', '--rules', 'r.json', 'a.csv'], 'unknown option "--rules"');
  usage(['import', 'a.csv', '--ledger'], 'option "--ledger" requires a value');
  usage(['import', 'a.csv', 'b.csv'], 'unexpected argument "b.csv"');
  usage(['import', '--ledger', 'l.json'], 'import requires a CSV file');
});

test('usage errors for categorize, report and budget', () => {
  usage(['categorize'], 'categorize requires --rules <file>');
  usage(['categorize', '--ledger', 'x.json'], 'categorize requires --rules <file>');
  usage(['categorize', '--bogus'], 'unknown option "--bogus"');
  usage(['categorize', '--rules'], 'option "--rules" requires a value');
  usage(['categorize', '--rules', 'r.json', 'extra', 'more'], 'unexpected argument "extra"');
  usage(['report'], 'report requires a month (YYYY-MM)');
  usage(['report', '--bogus'], 'unknown option "--bogus"');
  usage(['report', '--ledger'], 'option "--ledger" requires a value');
  usage(['report', '2026-13'], 'invalid month "2026-13"');
  usage(['report', '2026-00'], 'invalid month "2026-00"');
  usage(['report', '2026-3'], 'invalid month "2026-3"');
  usage(['report', 'March'], 'invalid month "March"');
  usage(['report', '2026-03', '2026-04'], 'unexpected argument "2026-04"');
  usage(['report', '2026-03', '--rules', 'r.json'], 'unknown option "--rules"');
  usage(['budget'], 'budget requires a budget file and a month');
  usage(['budget', 'b.json'], 'budget requires a budget file and a month');
  usage(['budget', 'b.json', '202603'], 'invalid month "202603"');
  usage(['budget', 'b.json', '2026-03', 'x'], 'unexpected argument "x"');
});

test('usage checks run in the documented order', () => {
  usage(['report', '2026-13', 'extra'], 'unexpected argument "extra"');
  usage(['budget', 'b.json', '2026-13', 'extra'], 'unexpected argument "extra"');
  usage(['import', '--bogus'], 'unknown option "--bogus"');
  usage(['categorize', '--rules', 'r.json', '--bogus', '--ledger'], 'unknown option "--bogus"');
  usage(['import', 'a.csv', '--ledger', 'l.json', '--rules'], 'unknown option "--rules"');
  usage(['nope', 'a', 'b'], 'unknown command "nope"');
});

test('import: adds rows, prints the summary, writes a version 2 ledger', () => {
  const dir = tmp();
  const csv = write(dir, 'bank.csv', BANK);
  const ledger = join(dir, 'l.json');
  const r = cli(['import', csv, '--ledger', ledger]);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'imported 4 added, 0 skipped\n', '']);
  const saved = ledgerOf(ledger);
  assert.equal(saved.version, 2);
  assert.equal(saved.transactions.length, 4);
  assert.ok(saved.transactions.every((t) => t.category === 'Uncategorized'));
  assert.deepEqual(saved.imports, [{ source: 'bank.csv', added: 4, skipped: 0 }]);
  assert.deepEqual(saved.transactions.map((t) => t.cents).sort((a, b) => a - b), [-120050, -450, -450, 300000]);
  assert.deepEqual(listDir(dir), ['bank.csv', 'l.json']);
});

test('import is idempotent and a larger export only adds the new rows', () => {
  const dir = tmp();
  const csv = write(dir, 'bank.csv', BANK);
  const ledger = join(dir, 'l.json');
  cli(['import', csv, '--ledger', ledger]);
  const before = readFileSync(ledger, 'utf8');
  const again = cli(['import', csv, '--ledger', ledger]);
  assert.equal(again.stdout, 'imported 0 added, 4 skipped\n');
  assert.equal(readFileSync(ledger, 'utf8'), before);
  const bigger = write(dir, 'bank2.csv', BANK + '2026-03-04,Bakery,-3.20\n');
  const r = cli(['import', bigger, '--ledger', ledger]);
  assert.equal(r.stdout, 'imported 1 added, 4 skipped\n');
  assert.equal(ledgerOf(ledger).transactions.length, 5);
  assert.deepEqual(ledgerOf(ledger).imports.map((i) => i.source), ['bank.csv', 'bank2.csv']);
});

test('import: an empty export still writes a ledger', () => {
  const dir = tmp();
  const r = cli(['import', write(dir, 'e.csv', ''), '--ledger', join(dir, 'l.json')]);
  assert.deepEqual([r.status, r.stdout], [0, 'imported 0 added, 0 skipped\n']);
  assert.deepEqual(ledgerOf(join(dir, 'l.json')), { version: 2, transactions: [], imports: [] });
});

test('import: row errors go to stderr with file and line, exit 2, nothing written', () => {
  const dir = tmp();
  const csv = write(dir, 'bad.csv', ['date,description,amount', '2026-03-01,ok,5.00', '2026-13-01,bad date,1.00', '2026-03-02,,1.00', '2026-03-03,bad amount,x1', '2026-03-04,too,many,1.00', ''].join('\n'));
  const ledger = join(dir, 'l.json');
  const r = cli(['import', csv, '--ledger', ledger]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, [`error: ${csv}:3: invalid date "2026-13-01"`, `error: ${csv}:4: empty description`, `error: ${csv}:5: invalid amount "x1"`, `error: ${csv}:6: expected 3 fields, found 4`, ''].join('\n'));
  assert.equal(existsSync(ledger), false);
});

test('import: a bad ledger is left untouched when the CSV has errors', () => {
  const dir = tmp();
  const csv = write(dir, 'bad.csv', 'date,description,amount\nx,y,z\n');
  const ledger = write(dir, 'l.json', 'not json');
  const r = cli(['import', csv, '--ledger', ledger]);
  assert.deepEqual([r.status, r.stderr], [2, `error: ${csv}:2: invalid date "x"\n`]);
  assert.equal(readFileSync(ledger, 'utf8'), 'not json');
});

test('import: data errors, unreadable files and broken ledgers', () => {
  const dir = tmp();
  const ledger = join(dir, 'l.json');
  let r = cli(['import', write(dir, 'h.csv', 'date,description\n1,2\n'), '--ledger', ledger]);
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', 'error: missing column: amount\n']);
  r = cli(['import', write(dir, 'q.csv', 'date,description,amount\n2026-01-01,"oops,1\n'), '--ledger', ledger]);
  assert.deepEqual([r.status, r.stderr], [2, 'error: line 2: unterminated quoted field\n']);
  r = cli(['import', 'nope.csv', '--ledger', ledger], { cwd: dir });
  assert.deepEqual([r.status, r.stdout, r.stderr], [3, '', 'error: cannot read nope.csv\n']);
  const broken = write(dir, 'broken.json', '{"version": 2,');
  r = cli(['import', write(dir, 'ok.csv', BANK), '--ledger', broken]);
  assert.deepEqual([r.status, r.stderr], [2, `error: ${broken} is not valid JSON\n`]);
  assert.equal(readFileSync(broken, 'utf8'), '{"version": 2,');
  assert.equal(existsSync(ledger), false);
});

test('the ledger path comes from --ledger, then LEDGERLY_LEDGER, then ledger.json in the working folder', () => {
  const dir = tmp();
  const csv = write(dir, 'bank.csv', BANK);
  cli(['import', csv], { cwd: dir });
  assert.equal(existsSync(join(dir, 'ledger.json')), true);
  const viaEnv = join(dir, 'env.json');
  cli(['import', csv], { cwd: dir, env: { LEDGERLY_LEDGER: viaEnv } });
  assert.equal(existsSync(viaEnv), true);
  const viaFlag = join(dir, 'flag.json');
  cli(['import', csv, '--ledger', viaFlag], { cwd: dir, env: { LEDGERLY_LEDGER: join(dir, 'ignored.json') } });
  assert.equal(existsSync(viaFlag), true);
  assert.equal(existsSync(join(dir, 'ignored.json')), false);
  cli(['import', csv], { cwd: dir, env: { LEDGERLY_LEDGER: '' } });
  assert.deepEqual(listDir(dir), ['bank.csv', 'env.json', 'flag.json', 'ledger.json']);
});

const RULES = { rules: [{ category: 'Income', regex: '^PAYROLL' }, { category: 'Groceries', contains: 'kroger' }, { category: 'Dining', contains: 'coffee' }] };

test('categorize: applies the rules, counts, and replaces earlier categories', () => {
  const dir = tmp();
  const ledger = join(dir, 'l.json');
  cli(['import', write(dir, 'bank.csv', BANK), '--ledger', ledger]);
  const rules = write(dir, 'rules.json', RULES);
  let r = cli(['categorize', '--rules', rules, '--ledger', ledger]);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'categorized 4 transactions, 0 uncategorized\n', '']);
  const cats = () => Object.fromEntries(ledgerOf(ledger).transactions.map((t) => [t.cents, t.category]));
  assert.deepEqual(cats(), { 300000: 'Income', '-120050': 'Groceries', '-450': 'Dining' });
  const narrower = write(dir, 'narrow.json', { rules: [{ category: 'Dining', contains: 'coffee' }] });
  r = cli(['categorize', '--ledger', ledger, '--rules', narrower]);
  assert.equal(r.stdout, 'categorized 4 transactions, 2 uncategorized\n');
  assert.deepEqual(cats(), { 300000: 'Uncategorized', '-120050': 'Uncategorized', '-450': 'Dining' });
});

test('categorize: empty and single-transaction ledgers, and a version 1 ledger is upgraded', () => {
  const dir = tmp();
  const rules = write(dir, 'rules.json', RULES);
  const fresh = join(dir, 'fresh.json');
  let r = cli(['categorize', '--rules', rules, '--ledger', fresh]);
  assert.equal(r.stdout, 'categorized 0 transactions, 0 uncategorized\n');
  assert.deepEqual(ledgerOf(fresh), { version: 2, transactions: [], imports: [] });
  const old = write(dir, 'old.json', { version: 1, entries: [{ date: '2026-02-03', desc: 'KROGER #1', amount: -64.1 }] });
  r = cli(['categorize', '--rules', rules, '--ledger', old]);
  assert.equal(r.stdout, 'categorized 1 transactions, 0 uncategorized\n');
  const upgraded = ledgerOf(old);
  assert.equal(upgraded.version, 2);
  assert.deepEqual([upgraded.transactions[0].cents, upgraded.transactions[0].category], [-6410, 'Groceries']);
});

test('categorize: unreadable, malformed and invalid rule files change nothing', () => {
  const dir = tmp();
  const ledger = join(dir, 'l.json');
  cli(['import', write(dir, 'bank.csv', BANK), '--ledger', ledger]);
  const before = readFileSync(ledger, 'utf8');
  let r = cli(['categorize', '--rules', 'missing.json', '--ledger', ledger], { cwd: dir });
  assert.deepEqual([r.status, r.stdout, r.stderr], [3, '', 'error: cannot read missing.json\n']);
  const notJson = write(dir, 'r1.json', '{ rules: ');
  r = cli(['categorize', '--rules', notJson, '--ledger', ledger]);
  assert.deepEqual([r.status, r.stderr], [2, `error: ${notJson} is not valid JSON\n`]);
  const invalid = write(dir, 'r2.json', { rules: [{ category: 'A', contains: 'a' }, { contains: 'b' }] });
  r = cli(['categorize', '--rules', invalid, '--ledger', ledger]);
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', 'error: rules[1]: category must be a non-empty string\n']);
  assert.equal(readFileSync(ledger, 'utf8'), before);
});

const LEDGER = {
  version: 2,
  imports: [],
  transactions: [
    tx('a', '2026-02-10', -35000, 'feb food', 'Groceries'),
    tx('b', '2026-03-02', -30000, 'food 1', 'Groceries'),
    tx('c', '2026-03-09', -10050, 'food 2', 'Groceries'),
    tx('d', '2026-03-10', -12050, 'eat', 'Dining'),
    tx('e', '2026-03-11', -2000, 'bus', 'Transport'),
    tx('f', '2026-03-12', -999, 'misc'),
    tx('g', '2026-03-31', 300000, 'pay', 'Income'),
    tx('h', '2026-03-20', 1000, 'refund', 'Gifts'),
  ],
};

test('report: exact output for a month', () => {
  const dir = tmp();
  const ledger = write(dir, 'l.json', LEDGER);
  const before = readFileSync(ledger, 'utf8');
  const r = cli(['report', '2026-03', '--ledger', ledger]);
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.equal(r.stdout, [
    'Month: 2026-03', 'Income: 3,010.00', 'Expenses: 550.99', 'Net: 2,459.01', 'Categories:',
    '  Groceries: 400.50', '  Dining: 120.50', '  Transport: 20.00', '  Uncategorized: 9.99', '',
  ].join('\n'));
  assert.equal(readFileSync(ledger, 'utf8'), before);
});

test('report: empty month, negative net, and a missing or version 1 ledger', () => {
  const dir = tmp();
  const ledger = write(dir, 'l.json', LEDGER);
  assert.equal(cli(['report', '2026-05', '--ledger', ledger]).stdout, 'Month: 2026-05\nIncome: 0.00\nExpenses: 0.00\nNet: 0.00\nCategories:\n  (none)\n');
  assert.equal(cli(['report', '2026-02', '--ledger', ledger]).stdout, 'Month: 2026-02\nIncome: 0.00\nExpenses: 350.00\nNet: -350.00\nCategories:\n  Groceries: 350.00\n');
  const missing = join(dir, 'missing.json');
  const r = cli(['report', '2026-03', '--ledger', missing]);
  assert.deepEqual([r.status, r.stdout], [0, 'Month: 2026-03\nIncome: 0.00\nExpenses: 0.00\nNet: 0.00\nCategories:\n  (none)\n']);
  assert.equal(existsSync(missing), false);
  const old = write(dir, 'old.json', { version: 1, entries: [{ date: '2026-03-03', desc: 'Dinner', amount: -52.35, cat: 'Dining' }] });
  const before = readFileSync(old, 'utf8');
  assert.equal(cli(['report', '2026-03', '--ledger', old]).stdout, 'Month: 2026-03\nIncome: 0.00\nExpenses: 52.35\nNet: -52.35\nCategories:\n  Dining: 52.35\n');
  assert.equal(readFileSync(old, 'utf8'), before);
});

test('report: a broken ledger is a data error', () => {
  const dir = tmp();
  const ledger = write(dir, 'l.json', '[1');
  const r = cli(['report', '2026-03', '--ledger', ledger]);
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', `error: ${ledger} is not valid JSON\n`]);
  const future = write(dir, 'f.json', { version: 7 });
  assert.equal(cli(['report', '2026-03', '--ledger', future]).stderr, 'error: unsupported ledger version 7\n');
});

const BUDGET = { monthly: { Groceries: 45000, Dining: 10000, Fuel: 0 }, yearly: { Travel: 100000 }, carryOver: ['Groceries'] };

test('budget: exact table with carry-over, overspend, yearly share and unbudgeted categories left out', () => {
  const dir = tmp();
  const ledger = write(dir, 'l.json', LEDGER);
  const budget = write(dir, 'b.json', BUDGET);
  const before = readFileSync(ledger, 'utf8');
  const r = cli(['budget', budget, '2026-03', '--ledger', ledger]);
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.equal(r.stdout, [
    'Budget for 2026-03',
    'Groceries: spent 400.50 of 550.00 (73%), remaining 149.50 [carry 100.00]',
    'Dining: spent 120.50 of 100.00 (121%), over by 20.50',
    'Fuel: spent 0.00 of 0.00 (n/a), remaining 0.00',
    'Travel: spent 0.00 of 83.34 (0%), remaining 83.34',
    '',
  ].join('\n'));
  assert.equal(readFileSync(ledger, 'utf8'), before);
});

test('budget: the first month has no carry, zero budgets, exact spend and n/a percent', () => {
  const dir = tmp();
  const ledger = write(dir, 'l.json', { version: 2, imports: [], transactions: [tx('a', '2026-02-10', -35000, 'x', 'Groceries'), tx('b', '2026-02-11', -500, 'y', 'Fuel'), tx('c', '2026-02-12', -5000, 'z', 'Dining')] });
  const budget = write(dir, 'b.json', { monthly: { Groceries: 35000, Dining: 10000, Fuel: 0 } });
  const r = cli(['budget', budget, '2026-02', '--ledger', ledger]);
  assert.equal(r.stdout, [
    'Budget for 2026-02',
    'Groceries: spent 350.00 of 350.00 (100%), remaining 0.00',
    'Dining: spent 50.00 of 100.00 (50%), remaining 50.00',
    'Fuel: spent 5.00 of 0.00 (n/a), over by 5.00',
    '',
  ].join('\n'));
});

test('budget: no budgeted categories prints only the header', () => {
  const dir = tmp();
  const ledger = write(dir, 'l.json', LEDGER);
  const budget = write(dir, 'b.json', {});
  assert.equal(cli(['budget', budget, '2026-03', '--ledger', ledger]).stdout, 'Budget for 2026-03\n');
});

test('budget: unreadable, malformed and invalid budget files', () => {
  const dir = tmp();
  const ledger = write(dir, 'l.json', LEDGER);
  let r = cli(['budget', 'gone.json', '2026-03', '--ledger', ledger], { cwd: dir });
  assert.deepEqual([r.status, r.stdout, r.stderr], [3, '', 'error: cannot read gone.json\n']);
  const notJson = write(dir, 'b1.json', 'nope');
  r = cli(['budget', notJson, '2026-03', '--ledger', ledger]);
  assert.deepEqual([r.status, r.stderr], [2, `error: ${notJson} is not valid JSON\n`]);
  const invalid = write(dir, 'b2.json', { monthly: { Food: -5 } });
  r = cli(['budget', invalid, '2026-03', '--ledger', ledger]);
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', 'error: monthly.Food must be a non-negative integer\n']);
  const unknown = write(dir, 'b3.json', { monthly: { Food: 5 }, carryOver: ['Rent'] });
  assert.equal(cli(['budget', unknown, '2026-03', '--ledger', ledger]).stderr, 'error: carryOver names unknown category "Rent"\n');
});

test('the whole flow: import, categorize, report and budget agree', () => {
  const dir = tmp();
  const ledger = join(dir, 'l.json');
  cli(['import', write(dir, 'bank.csv', BANK), '--ledger', ledger]);
  cli(['categorize', '--rules', write(dir, 'rules.json', RULES), '--ledger', ledger]);
  const report = cli(['report', '2026-03', '--ledger', ledger]).stdout;
  assert.equal(report, 'Month: 2026-03\nIncome: 3,000.00\nExpenses: 1,209.50\nNet: 1,790.50\nCategories:\n  Groceries: 1,200.50\n  Dining: 9.00\n');
  const budget = write(dir, 'b.json', { monthly: { Groceries: 100000, Dining: 1000 } });
  assert.equal(cli(['budget', budget, '2026-03', '--ledger', ledger]).stdout,
    'Budget for 2026-03\nGroceries: spent 1,200.50 of 1,000.00 (120%), over by 200.50\nDining: spent 9.00 of 10.00 (90%), remaining 1.00\n');
});

test('an option value may look like an option', () => {
  const dir = tmp();
  const r = cli(['report', '2026-03', '--ledger', '--odd.json'], { cwd: dir });
  assert.deepEqual([r.status, r.stdout.split('\n')[0], r.stderr], [0, 'Month: 2026-03', '']);
  assert.deepEqual(listDir(dir), []);
});
