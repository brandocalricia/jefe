import { notFound } from '../domain/errors.mjs';
import { buildComment } from '../domain/comment.mjs';
import { authorize, emit, subject } from './support.mjs';

export function createCommentService(ctx) {
  const { db, clock } = ctx;

  function requireTask(workspaceId, taskId) {
    const task = db.tasks.get(taskId);
    if (!task || task.workspaceId !== workspaceId) throw notFound('task');
  }

  return {
    add(actor, workspaceId, taskId, body) {
      authorize(db, actor, workspaceId, 'comment.write');
      const now = clock();
      const draft = buildComment({ taskId, body, actor, now });
      requireTask(workspaceId, taskId);
      const comment = db.comments.insert({ id: db.nextId('comment'), workspaceId, ...draft });
      emit(ctx, now, 'comment.added', actor, workspaceId, subject('comment', comment.id), { taskId });
      db.save();
      return comment;
    },

    // Oldest first.
    list(actor, workspaceId, taskId) {
      authorize(db, actor, workspaceId, 'comment.read');
      requireTask(workspaceId, taskId);
      return db.comments.findBy('taskId', taskId);
    },
  };
}
