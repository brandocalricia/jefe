import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { NOW, boot, bootTeam } from './kit.mjs';

const ids = (entries) => entries.map((e) => e.id);
const types = (entries) => entries.map((e) => e.type);

test('audit entries carry workspace and actor, newest first', () => {
  const { s } = bootTeam();
  const entries = s.audit.list('alice', 'w1');
  assert.deepEqual(ids(entries), ['a4', 'a3', 'a2', 'a1']);
  assert.deepEqual(entries[0], {
    id: 'a4', at: NOW, type: 'member.added', actor: 'alice', workspaceId: 'w1', subject: { kind: 'member', id: 'carol' }, data: { role: 'viewer' },
  });
  assert.deepEqual(entries[3], { id: 'a1', at: NOW, type: 'workspace.created', actor: 'alice', workspaceId: 'w1', subject: { kind: 'workspace', id: 'w1' }, data: { name: 'Team' } });
});

test('the audit list is per workspace and filterable', () => {
  const { s } = bootTeam();
  s.workspaces.create('dave', { name: 'Dave' });
  s.projects.create('bob', 'w1', { name: 'Site' });
  assert.deepEqual(ids(s.audit.list('dave', 'w2')), ['a6', 'a5']);
  assert.deepEqual(ids(s.audit.list('alice', 'w1', { type: 'project.created' })), ['a7']);
  assert.deepEqual(ids(s.audit.list('alice', 'w1', { limit: 2 })), ['a7', 'a4']);
  assert.throws(() => s.audit.list('alice', 'w1', { limit: 0 }), { code: 'validation', message: 'limit must be an integer between 1 and 200' });
  assert.throws(() => s.audit.list('dave', 'w1'), { code: 'not_found', message: 'workspace not found' });
});

test('retention: only the newest maxEntries ordinary entries are kept, membership entries stay', () => {
  const ctx = bootTeam({ auditRetention: { maxEntries: 3 } });
  const { s } = ctx;
  s.projects.create('alice', 'w1', { name: 'P' });
  for (const title of ['1', '2', '3', '4', '5']) s.tasks.create('alice', 'w1', { projectId: 'p1', title });
  const entries = s.audit.list('alice', 'w1');
  assert.deepEqual(ids(entries), ['a10', 'a9', 'a8', 'a4', 'a3', 'a2', 'a1']);
  assert.deepEqual(types(entries.slice(0, 3)), ['task.created', 'task.created', 'task.created']);
  s.tasks.create('alice', 'w1', { projectId: 'p1', title: '6' });
  assert.deepEqual(ids(s.audit.list('alice', 'w1', { limit: 2 })), ['a11', 'a10']);
  const reopened = createApp({ dataFile: ctx.dataFile, clock: () => NOW, auditRetention: { maxEntries: 3 } });
  assert.deepEqual(ids(reopened.services.audit.list('alice', 'w1')), ['a11', 'a10', 'a9', 'a4', 'a3', 'a2', 'a1']);
});

test('retention: entries older than maxAgeDays go, exactly maxAgeDays old stays', () => {
  const { s, clock } = bootTeam({ auditRetention: { maxAgeDays: 10 } });
  s.projects.create('alice', 'w1', { name: 'P' });
  clock.set('2026-03-11T09:00:00.000Z');
  s.tasks.create('alice', 'w1', { projectId: 'p1', title: 'T' });
  assert.deepEqual(types(s.audit.list('alice', 'w1', { limit: 2 })), ['task.created', 'project.created']);
  clock.set('2026-03-11T09:00:00.001Z');
  s.comments.add('alice', 'w1', 't1', 'hello');
  const after = s.audit.list('alice', 'w1');
  assert.deepEqual(types(after), ['comment.added', 'task.created', 'member.added', 'member.added', 'member.added', 'workspace.created']);
});

test('retention only prunes the workspace that just got an entry', () => {
  const { s, clock } = bootTeam({ auditRetention: { maxAgeDays: 10 } });
  s.projects.create('alice', 'w1', { name: 'P' });
  clock.set('2026-04-15T09:00:00.000Z');
  s.workspaces.create('dave', { name: 'Dave' });
  s.projects.create('dave', 'w2', { name: 'Q' });
  assert.ok(types(s.audit.list('alice', 'w1')).includes('project.created'));
  s.tasks.create('alice', 'w1', { projectId: 'p1', title: 'T' });
  assert.deepEqual(types(s.audit.list('alice', 'w1')).filter((t) => t === 'project.created'), []);
  assert.deepEqual(types(s.audit.list('dave', 'w2')), ['project.created', 'member.added', 'workspace.created']);
});

test('default retention is 90 days', () => {
  const { s, clock } = bootTeam();
  s.projects.create('alice', 'w1', { name: 'P' });
  clock.set('2026-05-29T09:00:00.000Z');
  s.tasks.create('alice', 'w1', { projectId: 'p1', title: 'T' });
  assert.ok(types(s.audit.list('alice', 'w1')).includes('project.created'));
  clock.set('2026-05-31T09:00:00.000Z');
  s.tasks.update('alice', 'w1', 't1', { title: 'T2' });
  assert.deepEqual(types(s.audit.list('alice', 'w1', { limit: 3 })), ['task.updated', 'task.created', 'member.added']);
});
