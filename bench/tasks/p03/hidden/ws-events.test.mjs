import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, boot, bootTeam } from './kit.mjs';

function capture(app) {
  const events = [];
  app.bus.on('*', (event) => events.push(event));
  return events;
}

const ev = (type, actor, workspaceId, subject, data) => ({ type, at: NOW, actor, workspaceId, subject, data });

test('existing events carry the workspace id and nothing else changed', () => {
  const { app, s } = bootTeam();
  const events = capture(app);
  s.projects.create('bob', 'w1', { name: 'Site' });
  s.tasks.create('bob', 'w1', { projectId: 'p1', title: 'Draft' });
  s.tasks.move('bob', 'w1', 't1', 'doing');
  assert.deepEqual(events, [
    ev('project.created', 'bob', 'w1', { kind: 'project', id: 'p1' }, { name: 'Site' }),
    ev('task.created', 'bob', 'w1', { kind: 'task', id: 't1' }, { title: 'Draft', projectId: 'p1' }),
    ev('task.moved', 'bob', 'w1', { kind: 'task', id: 't1' }, { from: 'todo', to: 'doing' }),
  ]);
});

test('creating a workspace publishes workspace.created then member.added', () => {
  const { app, s } = boot();
  const events = capture(app);
  s.workspaces.create('alice', { name: 'Team' });
  assert.deepEqual(events, [
    ev('workspace.created', 'alice', 'w1', { kind: 'workspace', id: 'w1' }, { name: 'Team' }),
    ev('member.added', 'alice', 'w1', { kind: 'member', id: 'alice' }, { role: 'owner' }),
  ]);
});

test('membership and rename events', () => {
  const { app, s } = bootTeam();
  const events = capture(app);
  s.members.add('alice', 'w1', { user: 'dave', role: 'viewer' });
  s.members.setRole('alice', 'w1', 'dave', 'editor');
  s.members.setRole('alice', 'w1', 'dave', 'editor');
  s.workspaces.rename('alice', 'w1', { name: 'Core' });
  assert.deepEqual(events, [
    ev('member.added', 'alice', 'w1', { kind: 'member', id: 'dave' }, { role: 'viewer' }),
    ev('member.role_changed', 'alice', 'w1', { kind: 'member', id: 'dave' }, { role: 'editor', previous: 'viewer' }),
    ev('workspace.renamed', 'alice', 'w1', { kind: 'workspace', id: 'w1' }, { name: 'Core', previous: 'Team' }),
  ]);
});

test('removing a member publishes member.removed, then task.assigned for each freed task', () => {
  const { app, s } = bootTeam();
  s.projects.create('alice', 'w1', { name: 'A' });
  for (const title of ['one', 'two', 'three']) s.tasks.create('alice', 'w1', { projectId: 'p1', title, assignee: title === 'two' ? 'carol' : 'bob' });
  const events = capture(app);
  s.members.remove('alice', 'w1', 'bob');
  assert.deepEqual(events, [
    ev('member.removed', 'alice', 'w1', { kind: 'member', id: 'bob' }, { role: 'editor' }),
    ev('task.assigned', 'alice', 'w1', { kind: 'task', id: 't1' }, { assignee: null, previous: 'bob' }),
    ev('task.assigned', 'alice', 'w1', { kind: 'task', id: 't3' }, { assignee: null, previous: 'bob' }),
  ]);
  const self = capture(app);
  s.members.remove('carol', 'w1', 'carol');
  assert.deepEqual(self.map((e) => [e.type, e.actor, e.data]), [
    ['member.removed', 'carol', { role: 'viewer' }],
    ['task.assigned', 'carol', { assignee: null, previous: 'carol' }],
  ]);
});
