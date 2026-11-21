import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importInto, loadLedger, migrateLedger, parseTransactions, saveLedger } from '../src/index.mjs';

test('version 1 entries migrate to integer cents and drop deleted ones', () => {
  const out = migrateLedger({ version: 1, entries: [
    { date: '2026-01-02', desc: 'a', amount: 0.1 + 0.2 },
    { date: '2026-01-03', desc: 'b', amount: 5, deleted: true },
  ] });
  assert.equal(out.version, 2);
  assert.deepEqual(out.transactions.map((t) => t.cents), [30]);
});

test('import twice changes nothing; save leaves only the ledger file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerly-sol-'));
  const path = join(dir, 'ledger.json');
  const { transactions } = parseTransactions('date,description,amount\n2026-01-01,a,1.00\n');
  const first = importInto(loadLedger(path), transactions, 'a.csv');
  saveLedger(path, first.ledger);
  const second = importInto(loadLedger(path), transactions, 'a.csv');
  assert.equal(second.added, 0);
  assert.deepEqual(second.ledger, first.ledger);
  assert.deepEqual(readdirSync(dir), ['ledger.json']);
});
