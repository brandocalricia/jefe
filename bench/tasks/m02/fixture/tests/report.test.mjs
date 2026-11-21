import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';

const csv = `# id,customer,amount,due
101,ann o'neil,1250.5,2026-01-05
102,bob,80,2026-02-20

103,caroline fitzgerald-smythe,19.999,2025-12-01
`;

function run(argv, files = { f: csv }) {
  const out = [];
  const code = main(argv, { readFile: (p) => files[p] ?? (() => { throw new Error('ENOENT'); })(), out: (s) => out.push(s) });
  return { code, out: out.join('') };
}

test('report of overdue invoices', () => {
  const r = run(['f', '--today', '2026-02-01']);
  assert.equal(r.code, 0);
  assert.equal(
    r.out,
    '  101  Ann O\'neil      1250.50  due 2026-01-05  27d late\n' +
      '  103  Caroline Fi…      20.00  due 2025-12-01  62d late\n' +
      '2 of 3 overdue (66.7%)\n',
  );
});

test('grace period shifts the cutoff', () => {
  const r = run(['f', '--today', '2026-02-01', '--grace', '30']);
  assert.match(r.out, /^ {2}103 /);
  assert.match(r.out, /1 of 3 overdue \(33.3%\)\n$/);
});

test('errors', () => {
  assert.equal(run([]).code, 2);
  assert.equal(run(['f', '--bogus']).code, 1);
  assert.equal(run(['missing']).code, 1);
});
