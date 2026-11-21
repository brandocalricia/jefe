import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, boot, bootTeam, req } from './kit.mjs';

const err = (status, code, message) => ({ status, body: { error: { code, message } } });

test('the old unscoped routes are gone', () => {
  const { app } = bootTeam();
  assert.deepEqual(req(app, 'GET', '/projects'), err(404, 'not_found', 'route not found'));
  assert.deepEqual(req(app, 'POST', '/tasks', { body: { projectId: 'p1', title: 'x' } }), err(404, 'not_found', 'route not found'));
  assert.deepEqual(req(app, 'GET', '/audit'), err(404, 'not_found', 'route not found'));
});

test('workspace routes', () => {
  const { app } = boot();
  assert.deepEqual(req(app, 'POST', '/workspaces', { body: { name: ' Team ' } }), {
    status: 201, body: { id: 'w1', name: 'Team', createdAt: NOW, createdBy: 'alice', role: 'owner' },
  });
  assert.deepEqual(req(app, 'POST', '/workspaces', { body: {} }), err(400, 'validation', 'name is required'));
  req(app, 'POST', '/workspaces', { user: 'bob', body: { name: 'Bob' } });
  assert.deepEqual(req(app, 'GET', '/workspaces', { user: 'bob' }).body.map((w) => [w.id, w.role]), [['w2', 'owner']]);
  assert.deepEqual(req(app, 'GET', '/workspaces/w1').body, { id: 'w1', name: 'Team', createdAt: NOW, createdBy: 'alice', role: 'owner' });
  assert.deepEqual(req(app, 'GET', '/workspaces/w1', { user: 'bob' }), err(404, 'not_found', 'workspace not found'));
  assert.equal(req(app, 'PATCH', '/workspaces/w1', { body: { name: 'Core' } }).body.name, 'Core');
});

test('workspace routes: roles and errors', () => {
  const { app } = bootTeam();
  assert.deepEqual(req(app, 'PATCH', '/workspaces/w1', { user: 'bob', body: { name: 'X' } }), err(403, 'forbidden', 'role editor cannot workspace.update'));
  assert.deepEqual(req(app, 'GET', '/workspaces', { user: undefined }), err(401, 'unauthenticated', 'user is required'));
  assert.equal(req(app, 'PUT', '/workspaces').status, 405);
  assert.deepEqual(req(app, 'GET', '/projects', { user: undefined }), err(404, 'not_found', 'route not found'));
});

test('member routes', () => {
  const { app } = bootTeam();
  assert.deepEqual(req(app, 'GET', '/workspaces/w1/members', { user: 'carol' }).body.map((m) => [m.user, m.role]), [['alice', 'owner'], ['bob', 'editor'], ['carol', 'viewer']]);
  const added = req(app, 'POST', '/workspaces/w1/members', { body: { user: 'dave', role: 'viewer' } });
  assert.deepEqual(added, { status: 201, body: { id: 'w1:dave', workspaceId: 'w1', user: 'dave', role: 'viewer', addedAt: NOW, addedBy: 'alice' } });
  assert.deepEqual(req(app, 'POST', '/workspaces/w1/members', { body: { user: 'dave', role: 'viewer' } }), err(409, 'conflict', 'user is already a member'));
  assert.deepEqual(req(app, 'POST', '/workspaces/w1/members', { body: { user: 'erin', role: 'god' } }), err(400, 'validation', 'role must be one of: viewer, editor, owner'));
  assert.deepEqual(req(app, 'POST', '/workspaces/w1/members', { user: 'bob', body: { user: 'erin', role: 'viewer' } }), err(403, 'forbidden', 'role editor cannot member.manage'));
  assert.equal(req(app, 'PATCH', '/workspaces/w1/members/dave', { body: { role: 'editor' } }).body.role, 'editor');
  assert.deepEqual(req(app, 'PATCH', '/workspaces/w1/members/zed', { body: { role: 'editor' } }), err(404, 'not_found', 'member not found'));
  assert.deepEqual(req(app, 'DELETE', '/workspaces/w1/members/alice'), err(409, 'conflict', 'workspace must keep at least one owner'));
  assert.deepEqual(req(app, 'DELETE', '/workspaces/w1/members/dave'), { status: 204, body: null });
  assert.deepEqual(req(app, 'DELETE', '/workspaces/w1/members/carol', { user: 'carol' }), { status: 204, body: null });
  assert.equal(req(app, 'GET', '/workspaces/w1', { user: 'carol' }).status, 404);
});

test('scoped routes: same behaviour, role checks, isolation', () => {
  const { app } = bootTeam();
  const W = '/workspaces/w1';
  const project = req(app, 'POST', `${W}/projects`, { user: 'bob', body: { name: 'Site' } });
  assert.deepEqual([project.status, project.body.id, project.body.workspaceId], [201, 'p1', 'w1']);
  assert.deepEqual(req(app, 'POST', `${W}/tasks`, { user: 'carol', body: { projectId: 'p1', title: 'x' } }), err(403, 'forbidden', 'role viewer cannot task.write'));
  const task = req(app, 'POST', `${W}/tasks`, { user: 'bob', body: { projectId: 'p1', title: 'Draft', assignee: 'carol' } });
  assert.deepEqual([task.status, task.body.id, task.body.assignee], [201, 't1', 'carol']);
  assert.deepEqual(req(app, 'POST', `${W}/tasks/t1/assign`, { body: { assignee: 'zed' } }), err(400, 'validation', 'assignee must be a member of the workspace'));
  assert.equal(req(app, 'POST', `${W}/tasks/t1/comments`, { user: 'carol', body: { body: 'Hi' } }).status, 201);
  assert.equal(req(app, 'GET', `${W}/tasks/t1/comments`).body.length, 1);
  assert.deepEqual(req(app, 'GET', `${W}/tasks`, { query: { assignee: 'none' } }).body, []);
  assert.equal(req(app, 'GET', `${W}/reports/summary`, { user: 'carol' }).body.total, 1);
  assert.deepEqual(req(app, 'DELETE', `${W}/tasks/t1`, { user: 'bob' }), err(403, 'forbidden', 'role editor cannot task.remove'));
  req(app, 'POST', '/workspaces', { body: { name: 'Other' } });
  assert.deepEqual(req(app, 'GET', '/workspaces/w2/tasks/t1'), err(404, 'not_found', 'task not found'));
  assert.deepEqual(req(app, 'GET', '/workspaces/w2/tasks/t1/comments'), err(404, 'not_found', 'task not found'));
  assert.deepEqual(req(app, 'GET', '/workspaces/w2/tasks').body, []);
  assert.deepEqual(req(app, 'GET', '/workspaces/w9/tasks'), err(404, 'not_found', 'workspace not found'));
});

test('the audit route is owner-only and workspace-scoped', () => {
  const { app } = bootTeam();
  req(app, 'POST', '/workspaces/w1/projects', { user: 'bob', body: { name: 'Site' } });
  assert.deepEqual(req(app, 'GET', '/workspaces/w1/audit', { query: { limit: '2' } }).body.map((e) => [e.id, e.type, e.workspaceId]), [['a5', 'project.created', 'w1'], ['a4', 'member.added', 'w1']]);
  assert.deepEqual(req(app, 'GET', '/workspaces/w1/audit', { user: 'bob' }), err(403, 'forbidden', 'role editor cannot audit.read'));
  assert.deepEqual(req(app, 'GET', '/workspaces/w1/audit', { query: { limit: 'x' } }), err(400, 'validation', 'limit must be an integer between 1 and 200'));
});
