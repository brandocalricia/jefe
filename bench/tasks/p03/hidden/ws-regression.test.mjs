import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, boot, bootTeam, cli, req, writeLegacy } from './kit.mjs';
import { migrateFile } from '../src/store/migrate.mjs';

// The behaviour described in the README's behaviour reference, inside a workspace.

function migrated() {
  const file = writeLegacy();
  migrateFile(file, { owner: 'alice', now: NOW });
  return boot({ dataFile: file });
}

const ids = (records) => records.map((r) => r.id);

test('legacy data in the default workspace: list order, filters and archived projects', () => {
  const { s } = migrated();
  assert.deepEqual(ids(s.tasks.list('alice', 'w1', { status: 'todo' })), ['t3', 't1', 't5']);
  assert.deepEqual(ids(s.tasks.list('alice', 'w1', { assignee: null })), ['t2', 't4']);
  assert.deepEqual(ids(s.tasks.list('alice', 'w1', { assignee: 'carol', label: 'BUG' })), ['t3']);
  assert.deepEqual(ids(s.tasks.list('alice', 'w1', { projectId: 'p1', priority: 'high' })), ['t3', 't1']);
  assert.deepEqual(ids(s.tasks.list('alice', 'w1', { q: 'FIX' })), ['t3']);
  assert.deepEqual(ids(s.projects.list('alice', 'w1')), ['p1']);
  assert.deepEqual(ids(s.projects.list('alice', 'w1', { includeArchived: true })), ['p1', 'p2']);
  assert.deepEqual(s.comments.list('bob', 'w1', 't1').map((c) => [c.id, c.author]), [['c1', 'erin'], ['c2', 'alice']]);
});

test('legacy data in the default workspace: report numbers', () => {
  const { s } = migrated();
  assert.deepEqual(s.reports.summary('alice', 'w1'), {
    total: 5, byStatus: { todo: 3, doing: 1, done: 1 }, byPriority: { low: 1, normal: 2, high: 2 }, overdue: 3, unassigned: 2,
  });
  assert.deepEqual(s.reports.summary('alice', 'w1', { projectId: 'p1' }), {
    total: 4, byStatus: { todo: 2, doing: 1, done: 1 }, byPriority: { low: 1, normal: 1, high: 2 }, overdue: 2, unassigned: 2,
  });
  assert.equal(s.tasks.create('bob', 'w1', { projectId: 'p1', title: 'New one' }).id, 't6');
});

test('validation messages and defaults are unchanged', () => {
  const { s } = bootTeam();
  s.projects.create('alice', 'w1', { name: 'Site', description: ' Public ' });
  const bad = (input, message) => assert.throws(() => s.tasks.create('bob', 'w1', { projectId: 'p1', title: 'T', ...input }), { code: 'validation', message });
  bad({ title: '  ' }, 'title is required');
  bad({ title: 'x'.repeat(121) }, 'title must be at most 120 characters');
  bad({ priority: 'urgent' }, 'priority must be one of: low, normal, high');
  bad({ dueDate: '2026-02-30' }, 'dueDate must be a date like 2026-03-01');
  bad({ labels: 'bug' }, 'labels must be an array of strings');
  const task = s.tasks.create('bob', 'w1', { projectId: 'p1', title: ' Write docs ', labels: [' Bug ', 'bug', 'UI'] });
  assert.deepEqual([task.title, task.status, task.priority, task.assignee, task.labels, task.dueDate, task.completedAt], ['Write docs', 'todo', 'normal', null, ['bug', 'ui'], null, null]);
  assert.throws(() => s.tasks.update('bob', 'w1', 't1', {}), { message: 'nothing to update' });
  assert.equal(s.projects.get('alice', 'w1', 'p1').description, 'Public');
});

test('ids: one counter per kind for the file, and a rejected request uses none', () => {
  const { s } = bootTeam();
  assert.throws(() => s.projects.create('alice', 'w1', { name: '' }), { code: 'validation' });
  s.workspaces.create('alice', { name: 'Other' });
  assert.deepEqual([s.projects.create('alice', 'w1', { name: 'A' }).id, s.projects.create('alice', 'w2', { name: 'B' }).id], ['p1', 'p2']);
  assert.throws(() => s.tasks.create('alice', 'w1', { projectId: 'p1', title: '' }), { code: 'validation' });
  assert.equal(s.tasks.create('alice', 'w1', { projectId: 'p1', title: 'ok' }).id, 't1');
});

test('moves, completion time and archived projects', () => {
  const { s, clock } = bootTeam();
  s.projects.create('alice', 'w1', { name: 'A' });
  s.tasks.create('bob', 'w1', { projectId: 'p1', title: 'T' });
  assert.throws(() => s.tasks.move('bob', 'w1', 't1', 'done'), { code: 'conflict', message: 'cannot move task from todo to done' });
  assert.throws(() => s.tasks.move('bob', 'w1', 't1', 'todo'), { code: 'conflict', message: 'cannot move task from todo to todo' });
  assert.throws(() => s.tasks.move('bob', 'w1', 't1', 'late'), { message: 'status must be one of: todo, doing, done' });
  s.tasks.move('bob', 'w1', 't1', 'doing');
  clock.set('2026-03-02T10:00:00.000Z');
  assert.equal(s.tasks.move('bob', 'w1', 't1', 'done').completedAt, '2026-03-02T10:00:00.000Z');
  assert.equal(s.tasks.move('bob', 'w1', 't1', 'doing').completedAt, null);
  s.projects.archive('alice', 'w1', 'p1');
  assert.throws(() => s.tasks.create('bob', 'w1', { projectId: 'p1', title: 'U' }), { code: 'conflict', message: 'project is archived' });
  assert.throws(() => s.projects.archive('alice', 'w1', 'p1'), { code: 'conflict', message: 'project is already archived' });
});

test('deleting a task deletes its comments; comments list oldest first', () => {
  const { s } = bootTeam();
  s.projects.create('alice', 'w1', { name: 'A' });
  s.tasks.create('bob', 'w1', { projectId: 'p1', title: 'T' });
  s.comments.add('bob', 'w1', 't1', ' first ');
  s.comments.add('carol', 'w1', 't1', 'second');
  assert.deepEqual(s.comments.list('alice', 'w1', 't1').map((c) => [c.id, c.body, c.author]), [['c1', 'first', 'bob'], ['c2', 'second', 'carol']]);
  assert.throws(() => s.comments.add('bob', 'w1', 't1', ' '), { message: 'body is required' });
  s.tasks.remove('alice', 'w1', 't1');
  assert.throws(() => s.comments.list('alice', 'w1', 't1'), { code: 'not_found', message: 'task not found' });
});

test('the existing API behaviour inside a workspace', () => {
  const { app } = bootTeam();
  const W = '/workspaces/w1';
  req(app, 'POST', `${W}/projects`, { body: { name: 'A' } });
  req(app, 'POST', `${W}/projects`, { body: { name: 'B' } });
  req(app, 'POST', `${W}/projects/p2/archive`);
  assert.deepEqual(req(app, 'GET', `${W}/projects`).body.map((p) => p.id), ['p1']);
  assert.deepEqual(req(app, 'GET', `${W}/projects`, { query: { includeArchived: 'true' } }).body.map((p) => p.id), ['p1', 'p2']);
  req(app, 'POST', `${W}/tasks`, { body: { projectId: 'p1', title: 'One', priority: 'low' } });
  req(app, 'POST', `${W}/tasks`, { body: { projectId: 'p1', title: 'Two', priority: 'high', assignee: 'bob' } });
  assert.deepEqual(req(app, 'GET', `${W}/tasks`).body.map((t) => t.id), ['t2', 't1']);
  assert.deepEqual(req(app, 'GET', `${W}/tasks`, { query: { assignee: 'none' } }).body.map((t) => t.id), ['t1']);
  assert.deepEqual(req(app, 'GET', `${W}/tasks/t9`), { status: 404, body: { error: { code: 'not_found', message: 'task not found' } } });
  assert.deepEqual(req(app, 'POST', `${W}/tasks/t1/move`, { body: { status: 'done' } }).body, { error: { code: 'conflict', message: 'cannot move task from todo to done' } });
  assert.equal(req(app, 'PATCH', `${W}/tasks/t1`, { body: { title: ' Uno ' } }).body.title, 'Uno');
});

test('the existing CLI output formats inside a workspace', () => {
  const run = cli({ TRACKBOARD_WORKSPACE: 'w1' });
  run('workspace', 'add', 'Team');
  run('member', 'add', 'bob', 'editor');
  assert.equal(run('project', 'add', 'Site', '--description', 'Public').out, 'created project p1\n');
  run('project', 'add', 'Old');
  assert.equal(run('project', 'archive', 'p2').out, 'archived project p2\n');
  assert.equal(run('project', 'list').out, 'p1\tSite\n');
  assert.equal(run('project', 'list', '--all').out, 'p1\tSite\np2\tOld\tarchived\n');
  assert.equal(run('task', 'add', 'Ship it', '--project', 'p1', '--priority', 'high', '--due', '2026-02-01', '--label', 'Rel', '--label', 'ops', '--assignee', 'bob').out, 'created task t1\n');
  run('task', 'add', 'Later', '--project', 'p1');
  assert.equal(run('task', 'list', '--assignee', 'none').out, 't2\ttodo\tnormal\tLater\n');
  assert.equal(run('task', 'show', 't1').out, 'id: t1\ntitle: Ship it\nproject: p1\nstatus: todo\npriority: high\nassignee: bob\ndue: 2026-02-01\nlabels: rel, ops\n');
  assert.equal(run('task', 'assign', 't1', 'none').out, 'unassigned task t1\n');
  assert.equal(run('comment', 'add', 't1', 'Done soon').out, 'added comment c1\n');
  assert.equal(run('comment', 'list', 't1').out, 'c1\talice\tDone soon\n');
  assert.equal(run('report').out, 'total: 2\ntodo: 2\ndoing: 0\ndone: 0\noverdue: 1\nunassigned: 2\n');
  assert.equal(run('task', 'rm', 't2').out, 'removed task t2\n');
  assert.equal(run('audit', '--type', 'comment.added').out, 'a10\t2026-03-01T09:00:00.000Z\talice\tcomment.added\tcomment:c1\n');
});
