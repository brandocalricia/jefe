// The helper spawns are append-only: three builders spawned in one message leave three entries (the old list was read, changed and written back
// across awaits and kept one), a new go starts the list again, and the report's models: line is built from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUN_SUFFIX, siblingRunFile } from '../hooks/approvals-state.mjs';
import { appendSpawn, runFilePath, spawnLine, spawnsFilePath } from '../hooks/runfile.mjs';
import { gate, repo, tmp } from './fixtures/gate/helpers.mjs';

// $.process.run in the mod: argv and standard input, no shell sees the data
const run = (argv, { stdin }) => new Promise((res, rej) => {
  const c = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] });
  c.on('error', rej);
  c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`exit ${code}`))));
  c.stdin.end(stdin);
});
const E = (home) => ({ JEFE_HOME: home, JEFE_MODE: 'headless', JEFE_SESSION_ID: 'spawn-sess' });

test('the spawns file is a registered run-file suffix, beside the run file', () => {
  const root = '/some/project';
  const env = { JEFE_HOME: '/h' };
  assert.equal(RUN_SUFFIX.spawns, '.spawns');
  assert.equal(spawnsFilePath(root, env), siblingRunFile(runFilePath(root, env), 'spawns'));
});

test('three spawns in one message, appended at the same moment, leave three entries; the report line says x3', async () => {
  const dir = repo({ 'a.txt': 'x\n' });
  const home = tmp();
  assert.equal(gate(['go', '--goal', 'g', '--done', 'd'], dir, E(home)).code, 0);
  const file = spawnsFilePath(dir, { JEFE_HOME: home });
  const oks = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => appendSpawn(file, spawnLine('spawn-sess', i % 2 ? 'builder' : 'scout', i % 2 ? 'sonnet' : 'haiku'), run)));
  assert.deepEqual(oks, [true, true, true, true, true, true]);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 6);
  const out = gate(['finish', '--', 'node', '-e', '0'], dir, E(home)).out;
  assert.match(out, /^models: builder=sonnet x3 scout=haiku x3$/m, out);
});

test("another session's lines and bad lines are skipped, an unknown role or empty model makes no line, and a new go starts the list again", () => {
  const dir = repo({ 'a.txt': 'x\n' });
  const home = tmp();
  gate(['go', '--goal', 'g', '--done', 'd'], dir, E(home));
  const file = spawnsFilePath(dir, { JEFE_HOME: home });
  assert.equal(spawnLine('s', 'boss', 'opus'), null);
  assert.equal(spawnLine('s', 'builder', ''), null);
  assert.match(spawnLine('s', 'builder', 'a b\n').trim(), /"model":"ab"/);
  writeFileSync(file, [spawnLine('spawn-sess', 'builder', 'opus'), spawnLine('other-sess', 'builder', 'haiku'), 'not json\n', '{"role":1}\n'].join(''));
  assert.match(gate(['finish', '--', 'node', '-e', '0'], dir, E(home)).out, /^models: builder=opus \(asked sonnet\)$/m);
  assert.equal(gate(['go', '--goal', 'g2', '--done', 'd'], dir, E(home)).code, 0);
  assert.equal(existsSync(file), false, 'the new job starts with no spawns');
  assert.match(gate(['finish', '--', 'node', '-e', '0'], dir, E(home)).out, /^models: n\/a/m);
});

test('the mod no longer reads and rewrites a helpers list: its spawn hook only appends', () => {
  const src = readFileSync(fileURLToPath(new URL('../hooks/jefe.jsx', import.meta.url)), 'utf8');
  assert.ok(!/old\.helpers|addSpawn\(/.test(src), 'no read-modify-write of the list');
  assert.match(src, /appendSpawn\(/);
});
