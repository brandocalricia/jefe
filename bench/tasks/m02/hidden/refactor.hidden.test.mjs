import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { titleCase, truncate, padLeft } from '../src/strings.mjs';
import { clamp, roundTo, percent } from '../src/numbers.mjs';
import { formatDate, daysBetween, addDays } from '../src/dates.mjs';
import * as strings from '../src/strings.mjs';
import * as numbers from '../src/numbers.mjs';
import * as dates from '../src/dates.mjs';
import * as utils from '../src/utils.mjs';
import { main } from '../src/cli.mjs';
import { parseInvoices } from '../src/csv.mjs';
import { buildReport } from '../src/report.mjs';

const d = (s) => new Date(s);

test('each module exports exactly the agreed names', () => {
  assert.deepEqual(Object.keys(strings).sort(), ['padLeft', 'titleCase', 'truncate']);
  assert.deepEqual(Object.keys(numbers).sort(), ['clamp', 'percent', 'roundTo']);
  assert.deepEqual(Object.keys(dates).sort(), ['addDays', 'daysBetween', 'formatDate']);
});

test('utils re-exports the same functions under the new names and the old names are gone', () => {
  assert.deepEqual(Object.keys(utils).sort(), ['addDays', 'clamp', 'daysBetween', 'formatDate', 'padLeft', 'percent', 'roundTo', 'titleCase', 'truncate']);
  for (const name of ['titleCase', 'truncate', 'padLeft']) assert.equal(utils[name], strings[name]);
  for (const name of ['clamp', 'roundTo', 'percent']) assert.equal(utils[name], numbers[name]);
  for (const name of ['formatDate', 'daysBetween', 'addDays']) assert.equal(utils[name], dates[name]);
  assert.equal(utils.pad, undefined);
  assert.equal(utils.fmtDate, undefined);
});

test('csv.mjs, report.mjs and cli.mjs no longer import utils.mjs', () => {
  for (const f of ['csv', 'report', 'cli']) {
    const src = readFileSync(new URL(`../src/${f}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /utils\.mjs/, f);
  }
});

test('strings behave as before', () => {
  assert.equal(titleCase("  hELLO   wORLD o'neil\tmc-donald"), "  Hello   World O'neil\tMc-donald");
  assert.equal(titleCase(''), '');
  assert.equal(truncate('hello', 5), 'hello');
  assert.equal(truncate('hello', 4), 'hel…');
  assert.equal(truncate('hello', 1), '…');
  assert.equal(truncate('hello', 0), '');
  assert.equal(truncate('hello', -3), '');
  assert.equal(truncate('', 0), '');
  assert.equal(padLeft(7, 3, '0'), '007');
  assert.equal(padLeft('abcd', 2), 'abcd');
  assert.equal(padLeft('x', 3, 'ab'), 'abx');
});

test('numbers behave as before, including the corners', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 3, 0), 0); // lo > hi: hi wins
  assert.equal(roundTo(1.005, 2), 1); // binary floating point, not 1.01
  assert.equal(roundTo(-1.5), -1);
  assert.equal(roundTo(2.5), 3);
  assert.equal(roundTo(1234.5678, -2), 1200);
  assert.equal(percent(1, 3), 33.3);
  assert.equal(percent(2, 3), 66.7);
  assert.equal(percent(0, 0), 0);
});

test('dates behave as before', () => {
  assert.equal(formatDate(d('2026-03-04T23:59:59Z')), '2026-03-04');
  assert.throws(() => formatDate(new Date('x')), { name: 'TypeError', message: 'invalid date' });
  assert.throws(() => formatDate('2026-01-01'), { name: 'TypeError', message: 'invalid date' });
  assert.equal(daysBetween(d('2026-01-01T00:00:00Z'), d('2026-01-03T13:00:00Z')), 3);
  assert.equal(daysBetween(d('2026-01-03T00:00:00Z'), d('2026-01-01T00:00:00Z')), -2);
  const start = d('2026-02-27T00:00:00Z');
  assert.equal(addDays(start, 2).toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(start.toISOString(), '2026-02-27T00:00:00.000Z'); // input not mutated
});

test('csv parsing is unchanged', () => {
  const rows = parseInvoices('# c\n\n7, mARy ,12.345, 2026-01-02\n8,x,-5,2026-01-03\n');
  assert.deepEqual(rows, [
    { id: '7', customer: 'Mary', amount: 12.35, due: d('2026-01-02T00:00:00Z') },
    { id: '8', customer: 'X', amount: 0, due: d('2026-01-03T00:00:00Z') },
  ]);
  assert.throws(() => parseInvoices('1,a,xx,2026-01-01'), /^Error: line 1: cannot parse "1,a,xx,2026-01-01"$/);
  assert.throws(() => parseInvoices('\n1,a,5,2026-13-01'), /^Error: line 2: cannot parse/);
});

test('report output is unchanged', () => {
  const inv = parseInvoices('1,ann,10,2026-01-01\n22,bartholomew the third,5.5,2026-01-20\n333,cy,1,2026-03-01\n');
  assert.equal(
    buildReport(inv, d('2026-02-01T00:00:00Z')),
    '    1  Ann               10.00  due 2026-01-01  31d late\n' +
      '   22  Bartholomew…       5.50  due 2026-01-20  12d late\n' +
      '2 of 3 overdue (66.7%)\n',
  );
  assert.equal(buildReport([], d('2026-02-01T00:00:00Z')), '0 of 0 overdue (0%)\n');
});

function run(argv, files) {
  const out = [];
  const code = main(argv, { readFile: (p) => { if (!(p in files)) throw new Error('ENOENT: ' + p); return files[p]; }, out: (s) => out.push(s) });
  return { code, out: out.join('') };
}

test('cli output is unchanged', () => {
  const files = { f: '1,ann,10,2026-01-01\n2,bob,20,2026-01-28\n' };
  assert.equal(run(['f', '--today', '2026-02-01'], files).out, '    1  Ann               10.00  due 2026-01-01  31d late\n    2  Bob               20.00  due 2026-01-28  4d late\n2 of 2 overdue (100%)\n');
  assert.equal(run(['f', '--today', '2026-02-01', '--grace', '10'], files).out, '    1  Ann               10.00  due 2026-01-01  21d late\n1 of 2 overdue (50%)\n');
  // grace is capped at 30 days
  assert.equal(run(['f', '--today', '2026-02-01', '--grace', '99'], files).out, '    1  Ann               10.00  due 2026-01-01  1d late\n1 of 2 overdue (50%)\n');
  assert.equal(run([], files).code, 2);
  assert.equal(run(['f', '--zzz'], files).out, 'error: unknown option --zzz\n');
  assert.equal(run(['nope'], files).code, 1);
});
