import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/domain/errors.mjs';
import { isUserId, isoDate, text } from '../src/domain/validation.mjs';
import { buildTask, compareTasks, isOverdue, moveTask, normalizeLabels } from '../src/domain/task.mjs';
import { applyProjectPatch, buildProject } from '../src/domain/project.mjs';

const NOW = '2026-03-01T09:00:00.000Z';

test('user ids are short lower-case slugs', () => {
  assert.equal(isUserId('alice'), true);
  assert.equal(isUserId('ops-team_2'), true);
  assert.equal(isUserId('Alice'), false);
  assert.equal(isUserId(''), false);
  assert.equal(isUserId('-x'), false);
});

test('text trims, requires and limits', () => {
  assert.equal(text('  hi ', 'name'), 'hi');
  assert.equal(text(undefined, 'name'), null);
  assert.throws(() => text('  ', 'name', { required: true }), { code: 'validation', message: 'name is required' });
  assert.throws(() => text('abcd', 'name', { max: 3 }), { message: 'name must be at most 3 characters' });
  assert.throws(() => text(5, 'name'), { message: 'name must be a string' });
});

test('isoDate accepts only real calendar dates', () => {
  assert.equal(isoDate('2026-02-28', 'due'), '2026-02-28');
  assert.throws(() => isoDate('2026-02-30', 'due'), AppError);
  assert.throws(() => isoDate('03/01/2026', 'due'), { message: 'due must be a date like 2026-03-01' });
});

test('labels are normalised', () => {
  assert.deepEqual(normalizeLabels([' Bug ', 'bug', '', 'UI']), ['bug', 'ui']);
  assert.throws(() => normalizeLabels('bug'), { message: 'labels must be an array of strings' });
  assert.throws(() => normalizeLabels(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']), { message: 'at most 8 labels' });
});

test('buildTask applies defaults', () => {
  const task = buildTask({ input: { projectId: 'p1', title: ' Write docs ' }, actor: 'alice', now: NOW });
  assert.equal(task.title, 'Write docs');
  assert.equal(task.status, 'todo');
  assert.equal(task.priority, 'normal');
  assert.equal(task.assignee, null);
  assert.deepEqual(task.labels, []);
  assert.equal(task.createdBy, 'alice');
});

test('moveTask follows the allowed transitions', () => {
  const task = buildTask({ input: { projectId: 'p1', title: 'T' }, actor: 'alice', now: NOW });
  const doing = moveTask(task, 'doing', NOW);
  assert.equal(doing.status, 'doing');
  assert.throws(() => moveTask(task, 'done', NOW), { code: 'conflict', message: 'cannot move task from todo to done' });
  const done = moveTask(doing, 'done', '2026-03-02T00:00:00.000Z');
  assert.equal(done.completedAt, '2026-03-02T00:00:00.000Z');
  assert.equal(moveTask(done, 'doing', NOW).completedAt, null);
});

test('overdue needs a past due date and an open task', () => {
  const base = { dueDate: '2026-02-28', status: 'todo' };
  assert.equal(isOverdue(base, '2026-03-01'), true);
  assert.equal(isOverdue({ ...base, status: 'done' }, '2026-03-01'), false);
  assert.equal(isOverdue({ ...base, dueDate: '2026-03-01' }, '2026-03-01'), false);
  assert.equal(isOverdue({ ...base, dueDate: null }, '2026-03-01'), false);
});

test('tasks sort by priority, due date, then id', () => {
  const t = (id, priority, dueDate) => ({ id, priority, dueDate });
  const sorted = [t('t3', 'normal', null), t('t10', 'high', null), t('t2', 'high', '2026-04-01'), t('t4', 'high', '2026-03-01'), t('t9', 'low', null)].sort(compareTasks);
  assert.deepEqual(sorted.map((x) => x.id), ['t4', 't2', 't10', 't3', 't9']);
});

test('project patches change only the named fields', () => {
  const project = buildProject({ input: { name: 'Site' }, actor: 'alice', now: NOW });
  const { project: next, fields } = applyProjectPatch(project, { description: 'Public site' }, '2026-03-02T00:00:00.000Z');
  assert.deepEqual(fields, ['description']);
  assert.equal(next.name, 'Site');
  assert.equal(next.updatedAt, '2026-03-02T00:00:00.000Z');
  assert.throws(() => applyProjectPatch(project, {}, NOW), { message: 'nothing to update' });
});
