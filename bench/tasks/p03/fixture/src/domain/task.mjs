import { conflict, validation } from './errors.mjs';
import { choice, isoDate, text, userId } from './validation.mjs';

export const STATUSES = ['todo', 'doing', 'done'];
export const PRIORITIES = ['low', 'normal', 'high'];

const MOVES = { todo: ['doing'], doing: ['todo', 'done'], done: ['doing'] };

// Labels are lower-cased and trimmed; blanks are dropped and repeats keep their first position.
export function normalizeLabels(value) {
  if (!Array.isArray(value) || value.some((label) => typeof label !== 'string')) {
    throw validation('labels must be an array of strings');
  }
  const labels = [];
  for (const raw of value) {
    const label = raw.trim().toLowerCase();
    if (label === '') continue;
    if (label.length > 24) throw validation('a label must be at most 24 characters');
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length > 8) throw validation('at most 8 labels');
  return labels;
}

export function buildTask({ input, actor, now }) {
  const projectId = text(input?.projectId, 'projectId', { required: true });
  const title = text(input?.title, 'title', { max: 120, required: true });
  const description = text(input?.description, 'description', { max: 2000 }) ?? '';
  const priority = input?.priority === undefined ? 'normal' : choice(input.priority, 'priority', PRIORITIES);
  const assignee = input?.assignee == null ? null : userId(input.assignee, 'assignee');
  const labels = input?.labels === undefined ? [] : normalizeLabels(input.labels);
  const dueDate = input?.dueDate == null ? null : isoDate(input.dueDate, 'dueDate');
  return {
    projectId, title, description, status: 'todo', priority, assignee, labels, dueDate,
    completedAt: null, createdAt: now, updatedAt: now, createdBy: actor,
  };
}

export function applyTaskPatch(task, patch, now) {
  const next = { ...task };
  const fields = [];
  if (patch?.title !== undefined) {
    next.title = text(patch.title, 'title', { max: 120, required: true });
    fields.push('title');
  }
  if (patch?.description !== undefined) {
    next.description = text(patch.description, 'description', { max: 2000 }) ?? '';
    fields.push('description');
  }
  if (patch?.priority !== undefined) {
    next.priority = choice(patch.priority, 'priority', PRIORITIES);
    fields.push('priority');
  }
  if (patch?.labels !== undefined) {
    next.labels = normalizeLabels(patch.labels);
    fields.push('labels');
  }
  if (patch?.dueDate !== undefined) {
    next.dueDate = patch.dueDate === null ? null : isoDate(patch.dueDate, 'dueDate');
    fields.push('dueDate');
  }
  if (fields.length === 0) throw validation('nothing to update');
  next.updatedAt = now;
  return { task: next, fields };
}

export function moveTask(task, status, now) {
  choice(status, 'status', STATUSES);
  if (!MOVES[task.status].includes(status)) {
    throw conflict(`cannot move task from ${task.status} to ${status}`);
  }
  return { ...task, status, completedAt: status === 'done' ? now : null, updatedAt: now };
}

export function isOverdue(task, today) {
  return task.dueDate !== null && task.dueDate < today && task.status !== 'done';
}

// High priority first, then earliest due date (tasks without one last), then creation order.
export function compareTasks(a, b) {
  const byPriority = PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority);
  if (byPriority !== 0) return byPriority;
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return Number(a.id.slice(1)) - Number(b.id.slice(1));
}
