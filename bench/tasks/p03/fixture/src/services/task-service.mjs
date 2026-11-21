import { conflict, notFound } from '../domain/errors.mjs';
import { applyTaskPatch, buildTask, compareTasks, moveTask, PRIORITIES, STATUSES } from '../domain/task.mjs';
import { choice, userId } from '../domain/validation.mjs';
import { emit, subject } from './support.mjs';

export function createTaskService(ctx) {
  const { db, clock } = ctx;

  function load(id) {
    const task = db.tasks.get(id);
    if (!task) throw notFound('task');
    return task;
  }

  return {
    create(actor, input) {
      const now = clock();
      const draft = buildTask({ input, actor, now });
      const project = db.projects.get(draft.projectId);
      if (!project) throw notFound('project');
      if (project.archived) throw conflict('project is archived');
      const task = db.tasks.insert({ id: db.nextId('task'), ...draft });
      emit(ctx, now, 'task.created', actor, subject('task', task.id), { title: task.title, projectId: task.projectId });
      db.save();
      return task;
    },

    get(actor, id) {
      return load(id);
    },

    // Filters: projectId, status, priority, assignee (null means unassigned), label, q (title
    // substring, case-insensitive). Sorted by compareTasks.
    list(actor, filter = {}) {
      const { projectId, status, priority, assignee, label, q } = filter;
      if (status !== undefined) choice(status, 'status', STATUSES);
      if (priority !== undefined) choice(priority, 'priority', PRIORITIES);
      let tasks = projectId === undefined ? db.tasks.all() : db.tasks.findBy('projectId', projectId);
      if (status !== undefined) tasks = tasks.filter((task) => task.status === status);
      if (priority !== undefined) tasks = tasks.filter((task) => task.priority === priority);
      if (assignee !== undefined) tasks = tasks.filter((task) => task.assignee === assignee);
      if (label !== undefined) {
        const wanted = String(label).trim().toLowerCase();
        tasks = tasks.filter((task) => task.labels.includes(wanted));
      }
      if (q !== undefined && q !== '') {
        const needle = String(q).toLowerCase();
        tasks = tasks.filter((task) => task.title.toLowerCase().includes(needle));
      }
      return tasks.sort(compareTasks);
    },

    update(actor, id, patch) {
      const now = clock();
      const { task, fields } = applyTaskPatch(load(id), patch, now);
      const saved = db.tasks.update(id, task);
      emit(ctx, now, 'task.updated', actor, subject('task', id), { fields });
      db.save();
      return saved;
    },

    move(actor, id, status) {
      const now = clock();
      const task = load(id);
      const moved = moveTask(task, status, now);
      const saved = db.tasks.update(id, moved);
      emit(ctx, now, 'task.moved', actor, subject('task', id), { from: task.status, to: status });
      db.save();
      return saved;
    },

    // assignee is a user id, or null to unassign.
    assign(actor, id, assignee) {
      const now = clock();
      const value = assignee == null ? null : userId(assignee, 'assignee');
      const task = load(id);
      const saved = db.tasks.update(id, { assignee: value, updatedAt: now });
      emit(ctx, now, 'task.assigned', actor, subject('task', id), { assignee: value, previous: task.assignee });
      db.save();
      return saved;
    },

    // Deleting a task deletes its comments too.
    remove(actor, id) {
      const now = clock();
      const task = load(id);
      for (const comment of db.comments.findBy('taskId', id)) db.comments.remove(comment.id);
      db.tasks.remove(id);
      emit(ctx, now, 'task.deleted', actor, subject('task', id), { title: task.title });
      db.save();
    },
  };
}
