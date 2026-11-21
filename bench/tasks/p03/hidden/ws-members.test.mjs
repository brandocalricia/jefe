import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, boot, bootTeam } from './kit.mjs';

test('creating a workspace makes the creator its owner', () => {
  const { s } = boot();
  assert.deepEqual(s.workspaces.create('alice', { name: '  Platform ' }), { id: 'w1', name: 'Platform', createdAt: NOW, createdBy: 'alice', role: 'owner' });
  assert.deepEqual(s.members.list('alice', 'w1'), [{ id: 'w1:alice', workspaceId: 'w1', user: 'alice', role: 'owner', addedAt: NOW, addedBy: 'alice' }]);
  assert.throws(() => s.workspaces.create('alice', { name: ' ' }), { code: 'validation', message: 'name is required' });
  assert.equal(s.workspaces.create('bob', { name: 'Second' }).id, 'w2');
});

test('listForUser and get show the caller role', () => {
  const { s } = bootTeam();
  s.workspaces.create('carol', { name: 'Carol own' });
  assert.deepEqual(s.workspaces.listForUser('carol').map((w) => [w.id, w.role]), [['w1', 'viewer'], ['w2', 'owner']]);
  assert.deepEqual(s.workspaces.listForUser('nobody'), []);
  assert.deepEqual(s.workspaces.get('bob', 'w1'), { id: 'w1', name: 'Team', createdAt: NOW, createdBy: 'alice', role: 'editor' });
  assert.throws(() => s.workspaces.get('bob', 'w2'), { code: 'not_found', message: 'workspace not found' });
});

test('renaming needs workspace.update', () => {
  const { s } = bootTeam();
  assert.deepEqual(s.workspaces.rename('alice', 'w1', { name: ' Core ' }), { id: 'w1', name: 'Core', createdAt: NOW, createdBy: 'alice', role: 'owner' });
  assert.equal(s.workspaces.get('carol', 'w1').name, 'Core');
  assert.throws(() => s.workspaces.rename('bob', 'w1', { name: 'X' }), { code: 'forbidden', message: 'role editor cannot workspace.update' });
  assert.throws(() => s.workspaces.rename('alice', 'w1', { name: '' }), { message: 'name is required' });
});

test('members are listed owners first, then editors, then viewers, by user id', () => {
  const { s } = bootTeam();
  s.members.add('alice', 'w1', { user: 'aaron', role: 'viewer' });
  s.members.add('alice', 'w1', { user: 'zoe', role: 'owner' });
  s.members.add('alice', 'w1', { user: 'abe', role: 'editor' });
  assert.deepEqual(s.members.list('carol', 'w1').map((m) => `${m.role}:${m.user}`), ['owner:alice', 'owner:zoe', 'editor:abe', 'editor:bob', 'viewer:aaron', 'viewer:carol']);
});

test('adding members', () => {
  const { s } = bootTeam();
  assert.deepEqual(s.members.add('alice', 'w1', { user: 'dave', role: 'viewer' }), { id: 'w1:dave', workspaceId: 'w1', user: 'dave', role: 'viewer', addedAt: NOW, addedBy: 'alice' });
  assert.throws(() => s.members.add('alice', 'w1', { user: 'dave', role: 'editor' }), { code: 'conflict', message: 'user is already a member' });
  assert.throws(() => s.members.add('alice', 'w1', { user: 'erin', role: 'boss' }), { code: 'validation', message: 'role must be one of: viewer, editor, owner' });
  assert.throws(() => s.members.add('alice', 'w1', { user: 'E R', role: 'viewer' }), { message: 'user must be a valid user id' });
  assert.throws(() => s.members.add('bob', 'w1', { user: 'erin', role: 'viewer' }), { code: 'forbidden', message: 'role editor cannot member.manage' });
});

test('changing roles', () => {
  const { s } = bootTeam();
  assert.equal(s.members.setRole('alice', 'w1', 'carol', 'editor').role, 'editor');
  assert.equal(s.members.list('alice', 'w1').find((m) => m.user === 'carol').role, 'editor');
  assert.equal(s.members.setRole('alice', 'w1', 'carol', 'editor').role, 'editor');
  assert.throws(() => s.members.setRole('alice', 'w1', 'zed', 'editor'), { code: 'not_found', message: 'member not found' });
  assert.throws(() => s.members.setRole('alice', 'w1', 'zed', 'boss'), { code: 'validation', message: 'role must be one of: viewer, editor, owner' });
  assert.throws(() => s.members.setRole('bob', 'w1', 'carol', 'owner'), { code: 'forbidden', message: 'role editor cannot member.manage' });
});

test('a workspace always keeps one owner', () => {
  const { s } = bootTeam();
  const keep = { code: 'conflict', message: 'workspace must keep at least one owner' };
  assert.throws(() => s.members.setRole('alice', 'w1', 'alice', 'editor'), keep);
  assert.throws(() => s.members.remove('alice', 'w1', 'alice'), keep);
  s.members.setRole('alice', 'w1', 'bob', 'owner');
  assert.equal(s.members.setRole('alice', 'w1', 'alice', 'viewer').role, 'viewer');
  assert.throws(() => s.members.remove('bob', 'w1', 'bob'), keep);
  assert.throws(() => s.members.setRole('bob', 'w1', 'bob', 'viewer'), keep);
});

test('removing members and leaving', () => {
  const { s } = bootTeam();
  assert.equal(s.members.remove('carol', 'w1', 'carol'), undefined);
  assert.throws(() => s.workspaces.get('carol', 'w1'), { code: 'not_found', message: 'workspace not found' });
  assert.throws(() => s.members.remove('bob', 'w1', 'alice'), { code: 'forbidden', message: 'role editor cannot member.manage' });
  assert.throws(() => s.members.remove('alice', 'w1', 'carol'), { code: 'not_found', message: 'member not found' });
  s.members.remove('alice', 'w1', 'bob');
  assert.deepEqual(s.members.list('alice', 'w1').map((m) => m.user), ['alice']);
});

test('removing a member unassigns their tasks in that workspace only', () => {
  const { s } = bootTeam();
  s.workspaces.create('alice', { name: 'Other' });
  s.members.add('alice', 'w2', { user: 'bob', role: 'editor' });
  s.projects.create('alice', 'w1', { name: 'A' });
  s.projects.create('alice', 'w2', { name: 'B' });
  s.tasks.create('alice', 'w1', { projectId: 'p1', title: 'one', assignee: 'bob' });
  s.tasks.create('alice', 'w1', { projectId: 'p1', title: 'two', assignee: 'carol' });
  s.tasks.create('alice', 'w2', { projectId: 'p2', title: 'three', assignee: 'bob' });
  s.members.remove('alice', 'w1', 'bob');
  assert.deepEqual(s.tasks.list('alice', 'w1').map((t) => [t.id, t.assignee]), [['t1', null], ['t2', 'carol']]);
  assert.equal(s.tasks.get('alice', 'w2', 't3').assignee, 'bob');
});
