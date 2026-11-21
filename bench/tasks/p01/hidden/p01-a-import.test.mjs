import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  LedgerError, UNCATEGORIZED, normalizeDescription, parseAmount, parseCsv, parseDate,
  parseTransactions, splitDuplicates, transactionId,
} from '../src/index.mjs';

const fails = (fn, code, message) => assert.throws(fn, (e) => e instanceof LedgerError && e.code === code && e.message === message);

test('parseCsv: plain records, CRLF, missing final newline, blank lines skipped with true line numbers', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [{ line: 1, fields: ['a', 'b'] }, { line: 2, fields: ['1', '2'] }]);
  assert.deepEqual(parseCsv('a\r\n\r\nb'), [{ line: 1, fields: ['a'] }, { line: 3, fields: ['b'] }]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('\n\n'), []);
});

test('parseCsv: quoted fields hold commas, doubled quotes and line breaks', () => {
  assert.deepEqual(parseCsv('"a,b","he said ""hi"""\n'), [{ line: 1, fields: ['a,b', 'he said "hi"'] }]);
  const rows = parseCsv('x,"two\nlines"\ny,z\n');
  assert.deepEqual(rows, [{ line: 1, fields: ['x', 'two\nlines'] }, { line: 3, fields: ['y', 'z'] }]);
  assert.deepEqual(parseCsv('"",a\n'), [{ line: 1, fields: ['', 'a'] }]);
});

test('parseCsv: byte-order mark, trailing comma, spaces and stray quotes', () => {
  assert.deepEqual(parseCsv('﻿a,b\n'), [{ line: 1, fields: ['a', 'b'] }]);
  assert.deepEqual(parseCsv('a,\n'), [{ line: 1, fields: ['a', ''] }]);
  assert.deepEqual(parseCsv('  \n'), [{ line: 1, fields: ['  '] }]);
  assert.deepEqual(parseCsv(' a , b\n'), [{ line: 1, fields: [' a ', ' b'] }]);
  assert.deepEqual(parseCsv('ab"c,d\n'), [{ line: 1, fields: ['ab"c', 'd'] }]);
});

test('parseCsv: syntax errors name the record line', () => {
  fails(() => parseCsv('a,b\n1,"oops\n'), 'CSV_SYNTAX', 'line 2: unterminated quoted field');
  fails(() => parseCsv('a,"b"x\n'), 'CSV_SYNTAX', 'line 1: unexpected character after closing quote');
  fails(() => parseCsv('a\n\nq,"w"\n"e"r\n'), 'CSV_SYNTAX', 'line 4: unexpected character after closing quote');
});

test('parseDate: the three formats normalise to YYYY-MM-DD', () => {
  assert.equal(parseDate('2026-03-07'), '2026-03-07');
  assert.equal(parseDate('3/7/2026'), '2026-03-07');
  assert.equal(parseDate('12/31/2025'), '2025-12-31');
  assert.equal(parseDate('07.03.2026'), '2026-03-07');
  assert.equal(parseDate('  2026-03-07  '), '2026-03-07');
});

test('parseDate: rejects other shapes and impossible dates, honours leap years', () => {
  for (const bad of ['2026-3-7', '7.3.2026', '26-03-07', '03/07/26', '2026/03/07', '', 'March 7', '13/01/2026', '2026-04-31', '31.04.2026', '00.01.2026', '2026-00-10']) {
    assert.equal(parseDate(bad), null, bad);
  }
  assert.equal(parseDate('2024-02-29'), '2024-02-29');
  assert.equal(parseDate('2000-02-29'), '2000-02-29');
  assert.equal(parseDate('2026-02-29'), null);
  assert.equal(parseDate('2100-02-29'), null);
});

test('parseAmount: valid forms give integer cents', () => {
  const good = { '12.5': 1250, '12': 1200, '0.05': 5, '$1,234.56': 123456, '-$5.00': -500, '(12.34)': -1234, '($12.34)': -1234,
    '+7': 700, '1,234,567.89': 123456789, ' 3.10 ': 310, '-0.5': -50, '999': 99900 };
  for (const [text, cents] of Object.entries(good)) assert.equal(parseAmount(text), cents, text);
});

test('parseAmount: invalid forms give null and zero is never negative', () => {
  for (const bad of ['$-5.00', '(-5)', '.5', '5.', '1.234', '1,23.00', '1234,567', '1,2345', '--5', '', 'abc', '(5', '5)', '12 .00', '5-', '(+5)']) {
    assert.equal(parseAmount(bad), null, JSON.stringify(bad));
  }
  assert.ok(Object.is(parseAmount('-0.00'), 0));
  assert.ok(Object.is(parseAmount('(0)'), 0));
});

test('normalizeDescription trims and collapses whitespace', () => {
  assert.equal(normalizeDescription('  SHELL \t  OIL\n 5521 '), 'SHELL OIL 5521');
  assert.equal(normalizeDescription('plain'), 'plain');
});

test('transactionId is the first 12 hex digits of the documented SHA-256', () => {
  const tx = { date: '2026-03-01', cents: -450, description: 'Coffee Shop' };
  const expected = createHash('sha256').update('2026-03-01|-450|coffee shop#1', 'utf8').digest('hex').slice(0, 12);
  assert.equal(transactionId(tx, 1), expected);
  assert.match(transactionId(tx, 2), /^[0-9a-f]{12}$/);
  assert.notEqual(transactionId(tx, 2), transactionId(tx, 1));
  assert.equal(transactionId({ ...tx, description: 'COFFEE SHOP' }, 1), expected);
});

test('parseTransactions: valid file, mixed formats, normalised fields, file order', () => {
  const text = 'Date,Description,Amount\n2026-03-01,"  Coffee,   Blue Door ",-4.50\n3/2/2026,Payroll,"$3,000.00"\n03.03.2026,Refund,(12.00)\n';
  const { transactions, errors } = parseTransactions(text);
  assert.deepEqual(errors, []);
  assert.equal(transactions.length, 3);
  const [a, b, c] = transactions;
  assert.deepEqual(a, { id: transactionId({ date: '2026-03-01', cents: -450, description: 'Coffee, Blue Door' }, 1), date: '2026-03-01', description: 'Coffee, Blue Door', cents: -450, category: UNCATEGORIZED });
  assert.deepEqual([b.date, b.description, b.cents], ['2026-03-02', 'Payroll', 300000]);
  assert.deepEqual([c.date, c.cents], ['2026-03-03', -1200]);
  assert.equal(UNCATEGORIZED, 'Uncategorized');
});

test('parseTransactions: header may be reordered, mixed case, padded and carry extra columns', () => {
  const { transactions, errors } = parseTransactions('Balance, AMOUNT ,Memo,Date,DESCRIPTION\n10.00,-5.00,x,2026-01-02,Lunch\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(transactions.map((t) => [t.date, t.description, t.cents]), [['2026-01-02', 'Lunch', -500]]);
});

test('parseTransactions: empty input and header-only input are not errors', () => {
  assert.deepEqual(parseTransactions(''), { transactions: [], errors: [] });
  assert.deepEqual(parseTransactions('date,description,amount\n'), { transactions: [], errors: [] });
});

test('parseTransactions: a missing column names the first missing one in spec order', () => {
  fails(() => parseTransactions('date,description\n'), 'BAD_HEADER', 'missing column: amount');
  fails(() => parseTransactions('description,balance\n'), 'BAD_HEADER', 'missing column: date');
  fails(() => parseTransactions('date,memo,x\n'), 'BAD_HEADER', 'missing column: description');
});

test('parseTransactions: bad rows are reported with line numbers and the good rows survive', () => {
  const text = [
    'date,description,amount', //                1
    '2026-03-01,fine,5.00', //                   2
    '2026-13-01,bad date,1.00', //               3
    '2026-03-02,,1.00', //                       4
    '2026-03-03,bad amount,x1', //               5
    '2026-03-04,too,many,1.00', //               6
    '2026-03-05,short', //                       7
    '2026-03-06,also fine,1.00', //              8
  ].join('\n');
  const { transactions, errors } = parseTransactions(text);
  assert.deepEqual(errors, [
    { line: 3, message: 'invalid date "2026-13-01"' },
    { line: 4, message: 'empty description' },
    { line: 5, message: 'invalid amount "x1"' },
    { line: 6, message: 'expected 3 fields, found 4' },
    { line: 7, message: 'expected 3 fields, found 2' },
  ]);
  assert.deepEqual(transactions.map((t) => t.description), ['fine', 'also fine']);
});

test('parseTransactions: only the first problem of a row is reported, in the documented order', () => {
  const { errors } = parseTransactions('date,description,amount\nnope,,zzz\n2026-01-01,   ,zzz\n2026-01-01,   ,1\n');
  assert.deepEqual(errors, [
    { line: 2, message: 'invalid date "nope"' },
    { line: 3, message: 'invalid amount "zzz"' },
    { line: 4, message: 'empty description' },
  ]);
});

test('parseTransactions: line numbers count lines inside quoted fields', () => {
  const text = 'date,description,amount\n2026-01-01,"two\nline memo",1.00\n2026-01-02,x,bad\n';
  const { transactions, errors } = parseTransactions(text);
  assert.equal(transactions[0].description, 'two line memo');
  assert.deepEqual(errors, [{ line: 4, message: 'invalid amount "bad"' }]);
});

test('parseTransactions: repeated purchases get distinct, repeatable ids', () => {
  const text = 'date,description,amount\n2026-03-03,Coffee,-4.50\n3/3/2026,COFFEE,-4.50\n2026-03-03,Coffee,-4.51\n2026-03-04,Coffee,-4.50\n2026-03-03,coffee,-4.50\n';
  const { transactions } = parseTransactions(text);
  const ids = transactions.map((t) => t.id);
  assert.equal(new Set(ids).size, 5);
  const base = { date: '2026-03-03', cents: -450, description: 'Coffee' };
  assert.equal(ids[0], transactionId(base, 1));
  assert.equal(ids[1], transactionId({ ...base, description: 'COFFEE' }, 2));
  assert.equal(ids[4], transactionId(base, 3));
  assert.deepEqual(parseTransactions(text).transactions.map((t) => t.id), ids);
});

test('parseTransactions: rows that fail do not use up an occurrence number', () => {
  const text = 'date,description,amount\n2026-03-03,Coffee,-4.50\n2026-03-03,Coffee,-4.50,extra\n2026-03-03,Coffee,-4.50\n';
  const { transactions, errors } = parseTransactions(text);
  assert.equal(errors.length, 1);
  assert.equal(transactions[1].id, transactionId({ date: '2026-03-03', cents: -450, description: 'Coffee' }, 2));
});

test('splitDuplicates separates known ids, accepting an array or a Set, keeping order', () => {
  const t = (id) => ({ id, date: '2026-01-01', description: id, cents: 1, category: UNCATEGORIZED });
  const list = [t('a'), t('b'), t('c'), t('d')];
  const viaArray = splitDuplicates(list, ['b', 'd', 'zzz']);
  assert.deepEqual(viaArray.fresh.map((x) => x.id), ['a', 'c']);
  assert.deepEqual(viaArray.duplicates.map((x) => x.id), ['b', 'd']);
  const viaSet = splitDuplicates(list, new Set(['a']));
  assert.deepEqual(viaSet.fresh.map((x) => x.id), ['b', 'c', 'd']);
  assert.deepEqual(splitDuplicates([], ['a']), { fresh: [], duplicates: [] });
  assert.deepEqual(splitDuplicates(list, []).fresh, list);
});
