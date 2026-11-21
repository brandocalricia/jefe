import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.mjs';

function setup() {
  const ctx = makeApp();
  const project = ctx.app.services.projects.create('alice', { name: 'Site', description: 'Public site' });
  return { ...ctx, project, s: ctx.app.services };
}

test('projects: create, rename, archive', () => {
  const { s, project, clock } = setup();
  assert.equal(project.id, 'p1');
  assert.equal(project.archived, false);
  clock.set('2026-03-02T09:00:00.000Z');
  assert.equal(s.projects.update('alice', 'p1', { name: 'Website' }).updatedAt, '2026-03-02T09:00:00.000Z');
  assert.equal(s.projects.archive('alice', 'p1').archived, true);
  assert.deepEqual(s.projects.list('alice'), []);
  assert.equal(s.projects.list('alice', { includeArchived: true }).length, 1);
  assert.throws(() => s.projects.archive('alice', 'p1'), { code: 'conflict', message: 'project is already archived' });
});

test('a rejected request does not use up an id', () => {
  const { s } = setup();
  assert.throws(() => s.projects.create('alice', { name: '' }), { code: 'validation' });
  assert.equal(s.projects.create('alice', { name: 'Other' }).id, 'p2');
});

test('tasks: create, list in order, move, assign, delete with comments', () => {
  const { s } = setup();
  s.tasks.create('alice', { projectId: 'p1', title: 'Low', priority: 'low' });
  s.tasks.create('alice', { projectId: 'p1', title: 'Urgent', priority: 'high', labels: ['Bug'] });
  assert.deepEqual(s.tasks.list('alice').map((t) => t.title), ['Urgent', 'Low']);
  assert.deepEqual(s.tasks.list('alice', { label: 'BUG' }).map((t) => t.id), ['t2']);
  assert.equal(s.tasks.move('alice', 't2', 'doing').status, 'doing');
  assert.equal(s.tasks.assign('alice', 't2', 'bob').assignee, 'bob');
  assert.deepEqual(s.tasks.list('alice', { assignee: null }).map((t) => t.id), ['t1']);
  s.comments.add('bob', 't2', 'On it');
  s.tasks.remove('alice', 't2');
  assert.throws(() => s.tasks.get('alice', 't2'), { code: 'not_found', message: 'task not found' });
  assert.throws(() => s.comments.list('alice', 't2'), { code: 'not_found' });
});

test('tasks cannot be added to an unknown or archived project', () => {
  const { s } = setup();
  assert.throws(() => s.tasks.create('alice', { projectId: 'p9', title: 'x' }), { message: 'project not found' });
  s.projects.archive('alice', 'p1');
  assert.throws(() => s.tasks.create('alice', { projectId: 'p1', title: 'x' }), { code: 'conflict', message: 'project is archived' });
});

test('reports count by status and flag overdue work', () => {
  const { s } = setup();
  s.tasks.create('alice', { projectId: 'p1', title: 'Late', dueDate: '2026-02-01' });
  s.tasks.create('alice', { projectId: 'p1', title: 'Fine', assignee: 'bob' });
  const summary = s.reports.summary('alice');
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.byStatus, { todo: 2, doing: 0, done: 0 });
  assert.equal(summary.overdue, 1);
  assert.equal(summary.unassigned, 1);
  assert.throws(() => s.reports.summary('alice', { projectId: 'p5' }), { message: 'project not found' });
});
