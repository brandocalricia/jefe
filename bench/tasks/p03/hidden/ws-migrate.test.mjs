import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/store/database.mjs';
import { migrateFile } from '../src/store/migrate.mjs';
import { NOW, legacyV1, readData, tmpFile, writeLegacy } from './kit.mjs';

const BODY = [
  'workspace: w1 (Default)',
  'owner: alice',
  'editors: bob, carol, dave, erin, frank',
  'projects: 2',
  'tasks: 5',
  'comments: 2',
  'audit: 4',
].map((line) => `${line}\n`).join('');

test('a dry run reports and changes nothing', () => {
  const file = writeLegacy();
  const before = readFileSync(file, 'utf8');
  const result = migrateFile(file, { owner: 'alice', now: NOW, dryRun: true });
  assert.deepEqual(result, { changed: false, report: `dry run: version 1 to 2 (no changes written)\n${BODY}` });
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('migration moves everything into workspace w1 and reports it', () => {
  const file = writeLegacy();
  const result = migrateFile(file, { owner: 'alice', now: NOW });
  assert.deepEqual(result, { changed: true, report: `migrated version 1 to 2\n${BODY}` });
  const data = readData(file);
  const old = legacyV1();
  assert.equal(data.version, 2);
  assert.deepEqual(data.counters, { workspace: 1, project: 2, task: 5, comment: 2, audit: 4 });
  assert.deepEqual(data.workspaces, [{ id: 'w1', name: 'Default', createdAt: NOW, createdBy: 'alice' }]);
  assert.deepEqual(
    data.memberships.map((m) => [m.id, m.role, m.addedBy, m.addedAt]),
    ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'].map((u) => [`w1:${u}`, u === 'alice' ? 'owner' : 'editor', 'alice', NOW]),
  );
  assert.deepEqual(data.memberships[1], { id: 'w1:bob', workspaceId: 'w1', user: 'bob', role: 'editor', addedAt: NOW, addedBy: 'alice' });
  for (const kind of ['projects', 'tasks', 'comments', 'audit']) {
    assert.deepEqual(data[kind], old[kind].map((r) => ({ ...r, workspaceId: 'w1' })), kind);
  }
  assert.ok(readFileSync(file, 'utf8').endsWith('}\n'));
});

test('an owner who is not in the data is still the first member; no editors reads none', () => {
  const file = writeLegacy(tmpFile(), { version: 1, counters: { project: 0, task: 0, comment: 0, audit: 0 }, projects: [], tasks: [], comments: [], audit: [] });
  const result = migrateFile(file, { owner: 'zed', now: NOW });
  assert.equal(result.report, 'migrated version 1 to 2\nworkspace: w1 (Default)\nowner: zed\neditors: none\nprojects: 0\ntasks: 0\ncomments: 0\naudit: 0\n');
  assert.deepEqual(readData(file).memberships.map((m) => [m.user, m.role]), [['zed', 'owner']]);
});

test('running it again changes nothing', () => {
  const file = writeLegacy();
  migrateFile(file, { owner: 'alice', now: NOW });
  const after = readFileSync(file, 'utf8');
  const again = { changed: false, report: 'already at version 2, nothing to do\n' };
  assert.deepEqual(migrateFile(file, { owner: 'bob', now: '2027-01-01T00:00:00.000Z' }), again);
  assert.deepEqual(migrateFile(file, { owner: 'bob', now: NOW, dryRun: true }), again);
  assert.equal(readFileSync(file, 'utf8'), after);
});

test('input checks come in order: owner, file, then version', () => {
  const file = writeLegacy();
  for (const owner of [undefined, null, '']) {
    assert.throws(() => migrateFile(file, { owner, now: NOW }), { code: 'validation', message: 'owner is required' });
  }
  assert.throws(() => migrateFile(file, { owner: 'Al Ice', now: NOW }), { code: 'validation', message: 'owner must be a valid user id' });
  assert.throws(() => migrateFile(tmpFile(), { owner: 'alice', now: NOW }), { code: 'not_found', message: 'database file not found' });
  assert.throws(() => migrateFile(tmpFile(), { owner: '!', now: NOW }), { message: 'owner must be a valid user id' });
});

test('a migrated file opens as a version 2 database and the counters continue', () => {
  const file = writeLegacy();
  migrateFile(file, { owner: 'alice', now: NOW });
  const db = openDatabase(file);
  assert.deepEqual(db.tasks.findBy('workspaceId', 'w1').map((t) => t.id), ['t1', 't2', 't3', 't4', 't5']);
  assert.deepEqual(db.memberships.findBy('user', 'erin').map((m) => m.id), ['w1:erin']);
  assert.deepEqual([db.nextId('task'), db.nextId('workspace'), db.nextId('audit'), db.nextId('comment'), db.nextId('project')], ['t6', 'w2', 'a5', 'c3', 'p3']);
});
