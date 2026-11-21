import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, request } from './helpers.mjs';

test('create and fetch a project', () => {
  const { app } = makeApp();
  const created = request(app, 'POST', '/projects', { body: { name: 'Site' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, 'p1');
  const fetched = request(app, 'GET', '/projects/p1');
  assert.deepEqual(fetched, { status: 200, body: created.body });
});

test('errors map to status codes and a standard body', () => {
  const { app } = makeApp();
  assert.deepEqual(request(app, 'GET', '/projects/p9'), { status: 404, body: { error: { code: 'not_found', message: 'project not found' } } });
  assert.equal(request(app, 'POST', '/projects', { body: {} }).status, 400);
  assert.equal(request(app, 'GET', '/nothing').body.error.message, 'route not found');
  assert.equal(request(app, 'PUT', '/projects').status, 405);
  assert.deepEqual(request(app, 'GET', '/projects', { user: undefined }).body, { error: { code: 'unauthenticated', message: 'user is required' } });
});

test('task routes: filter, move, assign, delete', () => {
  const { app } = makeApp();
  request(app, 'POST', '/projects', { body: { name: 'Site' } });
  request(app, 'POST', '/tasks', { body: { projectId: 'p1', title: 'One' } });
  request(app, 'POST', '/tasks', { body: { projectId: 'p1', title: 'Two', assignee: 'bob' } });
  assert.deepEqual(request(app, 'GET', '/tasks', { query: { assignee: 'none' } }).body.map((t) => t.id), ['t1']);
  assert.equal(request(app, 'POST', '/tasks/t1/move', { body: { status: 'doing' } }).body.status, 'doing');
  assert.equal(request(app, 'POST', '/tasks/t1/move', { body: { status: 'todo' } }).status, 200);
  assert.equal(request(app, 'POST', '/tasks/t1/move', { body: { status: 'done' } }).status, 409);
  assert.equal(request(app, 'POST', '/tasks/t1/assign', { body: { assignee: 'carol' } }).body.assignee, 'carol');
  assert.deepEqual(request(app, 'DELETE', '/tasks/t2'), { status: 204, body: null });
  assert.equal(request(app, 'GET', '/tasks/t2').status, 404);
});

test('comments and audit over the API', () => {
  const { app } = makeApp();
  request(app, 'POST', '/projects', { body: { name: 'Site' } });
  request(app, 'POST', '/tasks', { body: { projectId: 'p1', title: 'One' } });
  const comment = request(app, 'POST', '/tasks/t1/comments', { user: 'bob', body: { body: 'Hello' } });
  assert.equal(comment.status, 201);
  assert.equal(comment.body.author, 'bob');
  assert.equal(request(app, 'GET', '/tasks/t1/comments').body.length, 1);
  const audit = request(app, 'GET', '/audit', { query: { limit: '2' } });
  assert.deepEqual(audit.body.map((e) => e.type), ['comment.added', 'task.created']);
  assert.equal(request(app, 'GET', '/audit', { query: { limit: 'x' } }).status, 400);
});
