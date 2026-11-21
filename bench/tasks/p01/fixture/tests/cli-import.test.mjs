import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = (args) => spawnSync(process.execPath, [join(ROOT, 'bin/ledgerly.mjs'), ...args], { encoding: 'utf8' });

test('importing the sample export adds every row once', () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'ledgerly-')), 'ledger.json');
  const first = run(['import', join(ROOT, 'data/sample-bank.csv'), '--ledger', ledger]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'imported 10 added, 0 skipped\n');
  const second = run(['import', join(ROOT, 'data/sample-bank.csv'), '--ledger', ledger]);
  assert.equal(second.stdout, 'imported 0 added, 10 skipped\n');
  assert.equal(JSON.parse(readFileSync(ledger, 'utf8')).version, 2);
});

test('an unknown command is a usage error', () => {
  const r = run(['frobnicate']);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'error: unknown command "frobnicate"\n');
});
