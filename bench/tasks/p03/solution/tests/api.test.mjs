import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTeam, request } from './helpers.mjs';

const W = '/workspaces/w1';

test('create and fetch a project', () => {
  const { app } = makeTeam();
  const created = request(app, 'POST', `${W}/projects`, { body: { name: 'Site' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, 'p1');
  assert.equal(created.body.workspaceId, 'w1');
  assert.deepEqual(request(app, 'GET', `${W}/projects/p1`), { status: 200, body: created.body });
});

test('errors map to status codes and a standard body', () => {
  const { app } = makeTeam();
  assert.deepEqual(request(app, 'GET', `${W}/projects/p9`), { status: 404, body: { error: { code: 'not_found', message: 'project not found' } } });
  assert.equal(request(app, 'POST', `${W}/projects`, { body: {} }).status, 400);
  assert.equal(request(app, 'GET', '/projects').body.error.message, 'route not found');
  assert.equal(request(app, 'PUT', `${W}/projects`).status, 405);
  assert.deepEqual(request(app, 'GET', `${W}/projects`, { user: undefined }).body, { error: { code: 'unauthenticated', message: 'user is required' } });
});

test('roles decide what a request may do', () => {
  const { app } = makeTeam();
  assert.deepEqual(request(app, 'POST', `${W}/projects`, { user: 'carol', body: { name: 'X' } }), {
    status: 403,
    body: { error: { code: 'forbidden', message: 'role viewer cannot project.write' } },
  });
  assert.equal(request(app, 'POST', `${W}/projects`, { user: 'bob', body: { name: 'X' } }).status, 201);
  assert.equal(request(app, 'GET', `${W}/projects`, { user: 'mallory' }).status, 404);
});

test('task routes: filter, move, assign, delete', () => {
  const { app } = makeTeam();
  request(app, 'POST', `${W}/projects`, { body: { name: 'Site' } });
  request(app, 'POST', `${W}/tasks`, { body: { projectId: 'p1', title: 'One' } });
  request(app, 'POST', `${W}/tasks`, { body: { projectId: 'p1', title: 'Two', assignee: 'bob' } });
  assert.deepEqual(request(app, 'GET', `${W}/tasks`, { query: { assignee: 'none' } }).body.map((t) => t.id), ['t1']);
  assert.equal(request(app, 'POST', `${W}/tasks/t1/move`, { body: { status: 'doing' } }).body.status, 'doing');
  assert.equal(request(app, 'POST', `${W}/tasks/t1/move`, { body: { status: 'done' } }).status, 200);
  assert.equal(request(app, 'POST', `${W}/tasks/t1/move`, { body: { status: 'todo' } }).status, 409);
  assert.equal(request(app, 'POST', `${W}/tasks/t1/assign`, { body: { assignee: 'carol' } }).body.assignee, 'carol');
  assert.deepEqual(request(app, 'DELETE', `${W}/tasks/t2`), { status: 204, body: null });
  assert.equal(request(app, 'GET', `${W}/tasks/t2`).status, 404);
});

test('workspace and member routes', () => {
  const { app } = makeTeam();
  assert.equal(request(app, 'POST', '/workspaces', { user: 'dave', body: { name: 'Side project' } }).body.id, 'w2');
  assert.deepEqual(request(app, 'GET', '/workspaces', { user: 'bob' }).body.map((w) => [w.id, w.role]), [['w1', 'editor']]);
  assert.equal(request(app, 'PATCH', `${W}`, { body: { name: 'Core team' } }).body.name, 'Core team');
  const added = request(app, 'POST', `${W}/members`, { body: { user: 'dave', role: 'viewer' } });
  assert.equal(added.status, 201);
  assert.equal(request(app, 'PATCH', `${W}/members/dave`, { body: { role: 'editor' } }).body.role, 'editor');
  assert.equal(request(app, 'GET', `${W}/members`).body.length, 4);
  assert.equal(request(app, 'DELETE', `${W}/members/alice`).status, 409);
  assert.deepEqual(request(app, 'DELETE', `${W}/members/dave`), { status: 204, body: null });
});

test('comments and audit over the API', () => {
  const { app } = makeTeam();
  request(app, 'POST', `${W}/projects`, { body: { name: 'Site' } });
  request(app, 'POST', `${W}/tasks`, { body: { projectId: 'p1', title: 'One' } });
  const comment = request(app, 'POST', `${W}/tasks/t1/comments`, { user: 'carol', body: { body: 'Hello' } });
  assert.equal(comment.status, 201);
  assert.equal(comment.body.author, 'carol');
  assert.equal(request(app, 'GET', `${W}/tasks/t1/comments`).body.length, 1);
  const audit = request(app, 'GET', `${W}/audit`, { query: { limit: '2' } });
  assert.deepEqual(audit.body.map((e) => e.type), ['comment.added', 'task.created']);
  assert.equal(request(app, 'GET', `${W}/audit`, { query: { limit: 'x' } }).status, 400);
  assert.equal(request(app, 'GET', `${W}/audit`, { user: 'bob' }).status, 403);
});
