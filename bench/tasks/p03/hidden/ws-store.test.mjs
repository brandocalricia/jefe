import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/store/database.mjs';
import { readData, tmpFile, writeLegacy } from './kit.mjs';

const COLLECTIONS = ['audit', 'comments', 'memberships', 'projects', 'tasks', 'workspaces'];

test('a new database is version 2 with the workspace counter and collections', () => {
  const file = tmpFile();
  const db = openDatabase(file);
  assert.deepEqual([db.nextId('workspace'), db.nextId('workspace'), db.nextId('project')], ['w1', 'w2', 'p1']);
  db.save();
  const data = readData(file);
  assert.equal(data.version, 2);
  assert.deepEqual(data.counters, { workspace: 2, project: 1, task: 0, comment: 0, audit: 0 });
  assert.deepEqual(Object.keys(data).filter((k) => Array.isArray(data[k])).sort(), COLLECTIONS);
});

test('a version 1 file is refused until it is migrated', () => {
  const file = writeLegacy();
  const expected = { code: 'migration_required', message: 'database is at version 1; run "trackboard migrate --owner <user>"' };
  assert.throws(() => openDatabase(file), expected);
  assert.throws(() => createApp({ dataFile: file }), expected);
});

test('records are indexed by workspace, and memberships by user', () => {
  const file = tmpFile();
  const rec = (id, workspaceId, extra = {}) => ({ id, workspaceId, ...extra });
  writeFileSync(file, JSON.stringify({
    version: 2,
    counters: { workspace: 2, project: 3, task: 3, comment: 1, audit: 2 },
    workspaces: [rec('w1'), rec('w2')].map(({ id }) => ({ id, name: id })),
    memberships: [
      rec('w1:alice', 'w1', { user: 'alice', role: 'owner' }),
      rec('w2:alice', 'w2', { user: 'alice', role: 'viewer' }),
      rec('w2:bob', 'w2', { user: 'bob', role: 'owner' }),
    ],
    projects: [rec('p1', 'w1'), rec('p2', 'w2'), rec('p3', 'w1')],
    tasks: [rec('t1', 'w1', { projectId: 'p1', assignee: 'bob' }), rec('t2', 'w2', { projectId: 'p2', assignee: null }), rec('t3', 'w1', { projectId: 'p1', assignee: null })],
    comments: [rec('c1', 'w2', { taskId: 't2' })],
    audit: [rec('a1', 'w1'), rec('a2', 'w2')],
  }));
  const db = openDatabase(file);
  const ids = (records) => records.map((r) => r.id);
  assert.deepEqual(ids(db.tasks.findBy('workspaceId', 'w1')), ['t1', 't3']);
  assert.deepEqual(ids(db.projects.findBy('workspaceId', 'w1')), ['p1', 'p3']);
  assert.deepEqual([ids(db.comments.findBy('workspaceId', 'w2')), ids(db.audit.findBy('workspaceId', 'w1'))], [['c1'], ['a1']]);
  assert.deepEqual(ids(db.memberships.findBy('user', 'alice')), ['w1:alice', 'w2:alice']);
  assert.deepEqual(ids(db.memberships.findBy('workspaceId', 'w2')), ['w2:alice', 'w2:bob']);
  assert.deepEqual([ids(db.tasks.findBy('projectId', 'p1')), ids(db.tasks.findBy('assignee', null))], [['t1', 't3'], ['t2', 't3']]);
  assert.equal(db.nextId('workspace'), 'w3');
});
