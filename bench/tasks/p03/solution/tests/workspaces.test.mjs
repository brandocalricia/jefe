import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTeam } from './helpers.mjs';

test('roles gate the services and a missing workspace looks like no membership', () => {
  const { app } = makeTeam();
  const s = app.services;
  s.projects.create('alice', 'w1', { name: 'Site' });
  assert.throws(() => s.projects.create('carol', 'w1', { name: 'X' }), { code: 'forbidden', message: 'role viewer cannot project.write' });
  assert.throws(() => s.tasks.remove('bob', 'w1', 't1'), { code: 'forbidden', message: 'role editor cannot task.remove' });
  assert.throws(() => s.projects.list('mallory', 'w1'), { code: 'not_found', message: 'workspace not found' });
  assert.throws(() => s.projects.list('alice', 'w9'), { code: 'not_found', message: 'workspace not found' });
});

test('records never cross workspaces', () => {
  const { app } = makeTeam();
  const s = app.services;
  s.projects.create('alice', 'w1', { name: 'Site' });
  s.tasks.create('alice', 'w1', { projectId: 'p1', title: 'Draft' });
  s.workspaces.create('alice', { name: 'Other' });
  assert.throws(() => s.tasks.get('alice', 'w2', 't1'), { message: 'task not found' });
  assert.throws(() => s.tasks.create('alice', 'w2', { projectId: 'p1', title: 'X' }), { message: 'project not found' });
  assert.throws(() => s.comments.add('alice', 'w2', 't1', 'hi'), { message: 'task not found' });
  assert.deepEqual(s.tasks.list('alice', 'w2'), []);
});

test('assignees must belong to the workspace; removing a member frees their tasks', () => {
  const { app } = makeTeam();
  const s = app.services;
  s.projects.create('alice', 'w1', { name: 'Site' });
  assert.throws(() => s.tasks.create('alice', 'w1', { projectId: 'p1', title: 'X', assignee: 'zed' }), { message: 'assignee must be a member of the workspace' });
  s.tasks.create('alice', 'w1', { projectId: 'p1', title: 'Mine', assignee: 'bob' });
  s.members.remove('alice', 'w1', 'bob');
  assert.equal(s.tasks.get('alice', 'w1', 't1').assignee, null);
});

test('a workspace keeps one owner; same-role changes are quiet', () => {
  const { app } = makeTeam();
  const s = app.services;
  const events = [];
  app.bus.on('*', (e) => events.push(e.type));
  assert.throws(() => s.members.remove('alice', 'w1', 'alice'), { code: 'conflict', message: 'workspace must keep at least one owner' });
  s.members.setRole('alice', 'w1', 'bob', 'editor');
  s.members.setRole('alice', 'w1', 'bob', 'owner');
  assert.deepEqual(events, ['member.role_changed']);
  assert.deepEqual(s.members.list('carol', 'w1').map((m) => m.user), ['alice', 'bob', 'carol']);
});

test('audit retention keeps membership entries and prunes per workspace', () => {
  const { app } = makeTeam({ auditRetention: { maxEntries: 2 } });
  const s = app.services;
  s.projects.create('alice', 'w1', { name: 'P' });
  for (const title of ['a', 'b', 'c']) s.tasks.create('alice', 'w1', { projectId: 'p1', title });
  const types = s.audit.list('alice', 'w1').map((e) => e.type);
  assert.equal(types.filter((t) => t === 'task.created').length, 2);
  assert.equal(types.filter((t) => t.startsWith('member.')).length, 3);
  assert.equal(types.includes('project.created'), false);
});
