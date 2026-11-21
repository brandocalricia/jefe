import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ledgerly.mjs', import.meta.url));
const run = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerly-flow-'));
  writeFileSync(join(dir, 'bank.csv'), 'date,description,amount\n2026-03-01,Payroll,1000.00\n2026-03-02,Kroger,-250.25\n');
  writeFileSync(join(dir, 'rules.json'), JSON.stringify({ rules: [{ category: 'Income', min: 1 }, { category: 'Groceries', contains: 'kroger' }] }));
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ monthly: { Groceries: 30000 } }));
  return dir;
}

test('import, categorize, report and budget', () => {
  const dir = setup();
  assert.equal(run(['import', 'bank.csv'], dir).stdout, 'imported 2 added, 0 skipped\n');
  assert.equal(run(['categorize', '--rules', 'rules.json'], dir).stdout, 'categorized 2 transactions, 0 uncategorized\n');
  assert.equal(run(['report', '2026-03'], dir).stdout, 'Month: 2026-03\nIncome: 1,000.00\nExpenses: 250.25\nNet: 749.75\nCategories:\n  Groceries: 250.25\n');
  assert.equal(run(['budget', 'budget.json', '2026-03'], dir).stdout, 'Budget for 2026-03\nGroceries: spent 250.25 of 300.00 (83%), remaining 49.75\n');
});

test('bad rows stop the import without writing a ledger', () => {
  const dir = setup();
  writeFileSync(join(dir, 'bad.csv'), 'date,description,amount\n2026-03-01,x,1.00\n2026-03-01,,2.00\n');
  const r = run(['import', 'bad.csv'], dir);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'error: bad.csv:3: empty description\n');
  assert.equal(run(['report', '2026-03'], dir).stdout.includes('Income: 0.00'), true);
});

test('re-importing leaves the ledger file byte for byte the same', () => {
  const dir = setup();
  run(['import', 'bank.csv'], dir);
  const before = readFileSync(join(dir, 'ledger.json'), 'utf8');
  run(['import', 'bank.csv'], dir);
  assert.equal(readFileSync(join(dir, 'ledger.json'), 'utf8'), before);
});

test('a version 1 ledger is upgraded by import', () => {
  const dir = setup();
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ version: 1, entries: [{ date: '2026-02-01', desc: 'Old', amount: -1.5 }] }));
  run(['import', 'bank.csv'], dir);
  const saved = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.transactions.length, 3);
});
