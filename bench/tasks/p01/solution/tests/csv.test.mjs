import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseTransactions, splitDuplicates } from '../src/index.mjs';

test('quoted fields and line numbers', () => {
  const rows = parseCsv('a,"b,c"\n\n"x\ny",z\n');
  assert.deepEqual(rows, [{ line: 1, fields: ['a', 'b,c'] }, { line: 3, fields: ['x\ny', 'z'] }]);
});

test('unterminated quote is a CSV_SYNTAX error', () => {
  assert.throws(() => parseCsv('a,"b\n'), (e) => e.code === 'CSV_SYNTAX' && e.message === 'line 1: unterminated quoted field');
});

test('bad rows are reported and good rows kept', () => {
  const { transactions, errors } = parseTransactions('date,description,amount\n2026-01-01,a,1.00\nnope,b,2.00\n');
  assert.equal(transactions.length, 1);
  assert.deepEqual(errors, [{ line: 3, message: 'invalid date "nope"' }]);
});

test('identical rows in one file get different ids and re-import is all duplicates', () => {
  const { transactions } = parseTransactions('date,description,amount\n2026-01-01,a,1.00\n2026-01-01,a,1.00\n');
  assert.notEqual(transactions[0].id, transactions[1].id);
  assert.equal(splitDuplicates(transactions, transactions.map((t) => t.id)).fresh.length, 0);
});
