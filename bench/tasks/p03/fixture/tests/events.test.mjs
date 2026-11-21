import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/events/bus.mjs';
import { makeEvent } from '../src/events/events.mjs';
import { makeApp } from './helpers.mjs';

test('the bus calls typed handlers before wildcard handlers', () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('*', () => seen.push('any'));
  bus.on('task.created', () => seen.push('typed'));
  bus.emit(makeEvent({ type: 'task.created', at: 'x', actor: 'a', subject: { kind: 'task', id: 't1' } }));
  assert.deepEqual(seen, ['typed', 'any']);
});

test('unsubscribing stops delivery', () => {
  const bus = new EventBus();
  let count = 0;
  const off = bus.on('x', () => count++);
  bus.emit({ type: 'x' });
  off();
  bus.emit({ type: 'x' });
  assert.equal(count, 1);
});

test('services publish events and the audit log records them', () => {
  const { app } = makeApp();
  const events = [];
  app.bus.on('*', (event) => events.push(event));
  const project = app.services.projects.create('alice', { name: 'Site' });
  app.services.tasks.create('bob', { projectId: project.id, title: 'Draft' });
  assert.deepEqual(events.map((e) => e.type), ['project.created', 'task.created']);
  assert.deepEqual(events[1].data, { title: 'Draft', projectId: 'p1' });
  const entries = app.services.audit.list('alice');
  assert.deepEqual(entries.map((e) => e.id), ['a2', 'a1']);
  assert.equal(entries[0].actor, 'bob');
  assert.deepEqual(app.services.audit.list('alice', { type: 'project.created' }).map((e) => e.id), ['a1']);
  assert.equal(app.services.audit.list('alice', { limit: 1 }).length, 1);
});
