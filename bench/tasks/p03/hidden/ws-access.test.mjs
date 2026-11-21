import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootTeam } from './kit.mjs';

// w1: alice owner, bob editor, carol viewer; project p1 and task t1 exist.
function setup() {
  const ctx = bootTeam();
  ctx.s.projects.create('alice', 'w1', { name: 'Site' });
  ctx.s.tasks.create('alice', 'w1', { projectId: 'p1', title: 'Draft' });
  return ctx;
}

const forbidden = (message) => ({ code: 'forbidden', message });

test('viewers can read and comment but not write', () => {
  const { s } = setup();
  assert.deepEqual(s.projects.list('carol', 'w1').map((p) => p.id), ['p1']);
  assert.equal(s.tasks.get('carol', 'w1', 't1').title, 'Draft');
  assert.equal(s.comments.add('carol', 'w1', 't1', 'Looks good').author, 'carol');
  assert.equal(s.reports.summary('carol', 'w1').total, 1);
  assert.throws(() => s.projects.create('carol', 'w1', { name: 'X' }), forbidden('role viewer cannot project.write'));
  assert.throws(() => s.projects.update('carol', 'w1', 'p1', { name: 'X' }), forbidden('role viewer cannot project.write'));
  assert.throws(() => s.tasks.create('carol', 'w1', { projectId: 'p1', title: 'X' }), forbidden('role viewer cannot task.write'));
  assert.throws(() => s.tasks.move('carol', 'w1', 't1', 'doing'), forbidden('role viewer cannot task.write'));
  assert.throws(() => s.tasks.assign('carol', 'w1', 't1', 'bob'), forbidden('role viewer cannot task.write'));
});

test('editors write tasks and projects; archiving, deleting and the audit log are owner-only', () => {
  const { s } = setup();
  assert.equal(s.projects.create('bob', 'w1', { name: 'Docs' }).id, 'p2');
  assert.equal(s.tasks.update('bob', 'w1', 't1', { title: 'Draft v2' }).title, 'Draft v2');
  assert.throws(() => s.projects.archive('bob', 'w1', 'p1'), forbidden('role editor cannot project.archive'));
  assert.throws(() => s.tasks.remove('bob', 'w1', 't1'), forbidden('role editor cannot task.remove'));
  assert.throws(() => s.audit.list('bob', 'w1'), forbidden('role editor cannot audit.read'));
  assert.equal(s.projects.archive('alice', 'w1', 'p2').archived, true);
  s.tasks.remove('alice', 'w1', 't1');
  assert.deepEqual(s.tasks.list('alice', 'w1'), []);
});

test('an unknown workspace and a workspace you are not in look the same', () => {
  const { s } = setup();
  const gone = { code: 'not_found', message: 'workspace not found' };
  assert.throws(() => s.tasks.list('mallory', 'w1'), gone);
  assert.throws(() => s.tasks.list('alice', 'w9'), gone);
  assert.throws(() => s.projects.create('mallory', 'w1', {}), gone);
  assert.throws(() => s.comments.list('mallory', 'w1', 't1'), gone);
  assert.throws(() => s.reports.summary('mallory', 'w1'), gone);
});

test('the permission check runs before validation and lookups', () => {
  const { s } = setup();
  assert.throws(() => s.tasks.update('carol', 'w1', 't99', {}), forbidden('role viewer cannot task.write'));
  assert.throws(() => s.projects.create('carol', 'w1', { name: '' }), forbidden('role viewer cannot project.write'));
  assert.throws(() => s.tasks.create('bob', 'w1', { projectId: 'p99' }), { code: 'validation', message: 'title is required' });
  assert.throws(() => s.tasks.update('bob', 'w1', 't99', { title: 'x' }), { code: 'not_found', message: 'task not found' });
});

test('records of another workspace do not exist', () => {
  const { s } = setup();
  s.workspaces.create('alice', { name: 'Other' });
  const missing = (what) => ({ code: 'not_found', message: `${what} not found` });
  assert.throws(() => s.tasks.get('alice', 'w2', 't1'), missing('task'));
  assert.throws(() => s.tasks.update('alice', 'w2', 't1', { title: 'x' }), missing('task'));
  assert.throws(() => s.tasks.move('alice', 'w2', 't1', 'doing'), missing('task'));
  assert.throws(() => s.tasks.remove('alice', 'w2', 't1'), missing('task'));
  assert.throws(() => s.comments.add('alice', 'w2', 't1', 'hi'), missing('task'));
  assert.throws(() => s.comments.list('alice', 'w2', 't1'), missing('task'));
  assert.throws(() => s.projects.get('alice', 'w2', 'p1'), missing('project'));
  assert.throws(() => s.projects.archive('alice', 'w2', 'p1'), missing('project'));
  assert.throws(() => s.tasks.create('alice', 'w2', { projectId: 'p1', title: 'x' }), missing('project'));
  assert.throws(() => s.reports.summary('alice', 'w2', { projectId: 'p1' }), missing('project'));
  assert.deepEqual([s.tasks.list('alice', 'w2'), s.projects.list('alice', 'w2'), s.tasks.list('alice', 'w2', { projectId: 'p1' })], [[], [], []]);
});

test('each workspace sees only its own records, with shared id counters', () => {
  const { s } = setup();
  s.workspaces.create('alice', { name: 'Other' });
  const project = s.projects.create('alice', 'w2', { name: 'Elsewhere' });
  const task = s.tasks.create('alice', 'w2', { projectId: project.id, title: 'Far away' });
  assert.deepEqual([project.id, project.workspaceId, task.id, task.workspaceId], ['p2', 'w2', 't2', 'w2']);
  assert.deepEqual(s.tasks.list('alice', 'w1').map((t) => t.id), ['t1']);
  assert.deepEqual(s.tasks.list('alice', 'w2').map((t) => t.id), ['t2']);
  assert.equal(s.reports.summary('alice', 'w1').total, 1);
  assert.equal(s.tasks.get('alice', 'w1', 't1').workspaceId, 'w1');
});

test('assignees must be members of the workspace', () => {
  const { s } = setup();
  s.workspaces.create('dave', { name: 'Dave only' });
  const notMember = { code: 'validation', message: 'assignee must be a member of the workspace' };
  assert.throws(() => s.tasks.assign('alice', 'w1', 't1', 'dave'), notMember);
  assert.throws(() => s.tasks.create('alice', 'w1', { projectId: 'p1', title: 'x', assignee: 'dave' }), notMember);
  assert.throws(() => s.tasks.assign('alice', 'w1', 't1', 'Dave'), { message: 'assignee must be a valid user id' });
  assert.throws(() => s.tasks.assign('alice', 'w1', 't99', 'dave'), notMember);
  assert.equal(s.tasks.assign('alice', 'w1', 't1', 'carol').assignee, 'carol');
  assert.equal(s.tasks.assign('alice', 'w1', 't1', null).assignee, null);
  assert.equal(s.tasks.create('bob', 'w1', { projectId: 'p1', title: 'y', assignee: 'bob' }).assignee, 'bob');
});
