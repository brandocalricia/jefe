import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { migrateFile } from '../src/store/migrate.mjs';
import { createApp } from '../src/app.mjs';
import { openDatabase } from '../src/store/database.mjs';
import { tempDataFile } from './helpers.mjs';

const NOW = '2026-03-01T09:00:00.000Z';

function legacyFile() {
  const file = tempDataFile();
  const at = '2026-02-01T09:00:00.000Z';
  writeFileSync(file, JSON.stringify({
    version: 1,
    counters: { project: 1, task: 1, comment: 1, audit: 1 },
    projects: [{ id: 'p1', name: 'Site', description: '', archived: false, createdAt: at, updatedAt: at, createdBy: 'alice' }],
    tasks: [{ id: 't1', projectId: 'p1', title: 'Draft', description: '', status: 'todo', priority: 'normal', assignee: 'carol', labels: [], dueDate: null, completedAt: null, createdAt: at, updatedAt: at, createdBy: 'bob' }],
    comments: [{ id: 'c1', taskId: 't1', body: 'Hi', author: 'dave', createdAt: at }],
    audit: [{ id: 'a1', at, type: 'project.created', actor: 'alice', subject: { kind: 'project', id: 'p1' }, data: { name: 'Site' } }],
  }));
  return file;
}

test('a version 1 file is refused until it is migrated', () => {
  const file = legacyFile();
  assert.throws(() => openDatabase(file), { code: 'migration_required' });
  assert.throws(() => createApp({ dataFile: file }), { code: 'migration_required' });
});

test('dry run reports and leaves the file alone', () => {
  const file = legacyFile();
  const before = readFileSync(file, 'utf8');
  const { changed, report } = migrateFile(file, { owner: 'alice', now: NOW, dryRun: true });
  assert.equal(changed, false);
  assert.equal(report.split('\n')[0], 'dry run: version 1 to 2 (no changes written)');
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('migration creates the default workspace, members and scoped records, and is idempotent', () => {
  const file = legacyFile();
  const { changed, report } = migrateFile(file, { owner: 'alice', now: NOW });
  assert.equal(changed, true);
  assert.match(report, /^migrated version 1 to 2\nworkspace: w1 \(Default\)\nowner: alice\neditors: bob, carol, dave\nprojects: 1\n/);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(data.memberships.map((m) => `${m.user}:${m.role}`), ['alice:owner', 'bob:editor', 'carol:editor', 'dave:editor']);
  assert.ok([...data.projects, ...data.tasks, ...data.comments, ...data.audit].every((r) => r.workspaceId === 'w1'));
  const after = readFileSync(file, 'utf8');
  assert.deepEqual(migrateFile(file, { owner: 'alice', now: NOW }), { changed: false, report: 'already at version 2, nothing to do\n' });
  assert.equal(readFileSync(file, 'utf8'), after);
  assert.equal(createApp({ dataFile: file, clock: () => NOW }).services.tasks.get('carol', 'w1', 't1').title, 'Draft');
});

test('owner and file are checked', () => {
  assert.throws(() => migrateFile(legacyFile(), { now: NOW }), { message: 'owner is required' });
  assert.throws(() => migrateFile(legacyFile(), { owner: 'No Good', now: NOW }), { message: 'owner must be a valid user id' });
  assert.throws(() => migrateFile(tempDataFile(), { owner: 'alice', now: NOW }), { code: 'not_found' });
});
