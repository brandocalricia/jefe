import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runKey, runFilePath, serialise, costOf, dueToWrite, writeRunFile, sha256Hex } from '../hooks/runfile.mjs';
import { contextReading } from '../hooks/guard.mjs';

// Test writer: creates the directory, temp file + rename.
const nodeWrite = (file, text) => {
  mkdirSync(join(file, '..'), { recursive: true });
  const t = file + '.tmp';
  writeFileSync(t, text);
  renameSync(t, file);
};
const tmp = () => mkdtempSync(join(tmpdir(), 'jefe-run-'));
const u = (tokens, window, percent) => ({ context: { tokens, window, percent }, cost: { usd: 1.25 } });
const body = (usage, extra = {}) => JSON.parse(serialise({ now: 0, reading: contextReading(usage, {}), usage, model: 'm', phase: 'BUILD', ...extra }));

test('key equals node sha256 first 16 hex for sample paths', () => {
  const samples = ['/', '/a', '/Users/x/projects/jefe', '/tmp/with space/dir', '/tmp/café/日本語/😀', '/' + 'x'.repeat(55), '/' + 'y'.repeat(56), '/' + 'z'.repeat(200), ''];
  for (const p of samples) {
    assert.equal(runKey(p), createHash('sha256').update(p).digest('hex').slice(0, 16), p);
    assert.equal(sha256Hex(p), createHash('sha256').update(p).digest('hex'));
  }
  assert.match(runKey('/a'), /^[0-9a-f]{16}$/);
  assert.equal(runKey('/a'), runKey('/a'));
  assert.notEqual(runKey('/a'), runKey('/b'));
});

test('path uses JEFE_HOME, else ~/.claude/jefe', () => {
  const d = tmp();
  assert.equal(runFilePath(d, { JEFE_HOME: '/x/y' }), join('/x/y', 'run', runKey(d) + '.json'));
  assert.match(runFilePath(d, {}), /\.claude\/jefe\/run\/[0-9a-f]{16}\.json$/);
});

test('null or unknown usage -> context null, never a guessed number', () => {
  assert.equal(body(null).context, null);
  assert.equal(body({}).context, null);
  assert.equal(body({ context: { tokens: null, window: 200000, percent: null } }).context, null);
  assert.equal(body(null).cost, null);
  assert.equal(body(null, { model: '' }).model, null);
  assert.equal(body(null, { phase: null }).phase, null);
});

test('over flag by tokens and by percent, and not over otherwise', () => {
  assert.equal(body(u(260000, 1000000, 26)).context.over, true);
  assert.equal(body(u(160000, 1000000, 16)).context.over, false);
  assert.equal(body(u(100000, 200000, 80)).context.over, true);
  assert.equal(body(u(50000, 200000, 25)).context.over, false);
  assert.deepEqual(body(u(160000, 200000, 80)).context, { tokens: 160000, window: 200000, percent: 80, over: true });
  assert.deepEqual(body(u(1, 2, 3)).cost, { usd: 1.25 });
  assert.deepEqual(costOf({ cost: 2 }), { usd: 2 });
  assert.equal(costOf({ cost: { x: 1 } }), null);
});

test('file size does not grow across writes, and no temp files remain', async () => {
  const dir = tmp();
  const file = join(dir, 'run', 'k.json');
  const sizes = [];
  for (let i = 0; i < 20; i++) {
    assert.equal(await writeRunFile(file, serialise({ now: i * 1000, reading: contextReading(u(1000 + i, 200000, 1), {}), usage: u(0, 0, 0), model: 'm', phase: 'BUILD' }), nodeWrite), true);
    sizes.push(statSync(file).size);
  }
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 4);
  assert.deepEqual(readdirSync(join(dir, 'run')), ['k.json']);
  JSON.parse(readFileSync(file, 'utf8'));
});

test('write failure never throws', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'blocker'), 'x'); // a file where a directory is needed
  assert.equal(await writeRunFile(join(dir, 'blocker', 'run', 'k.json'), 'x', nodeWrite), false);
  assert.equal(await writeRunFile('/x', 'x', () => { throw new Error('no'); }), false);
  assert.equal(await writeRunFile('/x', 'x', async () => { throw new Error('no'); }), false);
  const ro = join(dir, 'ro');
  mkdirSync(ro);
  chmodSync(ro, 0o500);
  await writeRunFile(join(ro, 'run', 'k.json'), 'x', nodeWrite);
  chmodSync(ro, 0o700);
});

test('throttle: at most once every 2 seconds', () => {
  assert.equal(dueToWrite(null, 5), true);
  assert.equal(dueToWrite(1000, 2999), false);
  assert.equal(dueToWrite(1000, 3000), true);
});
