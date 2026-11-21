import { notFound } from '../domain/errors.mjs';
import { buildComment } from '../domain/comment.mjs';
import { emit, subject } from './support.mjs';

export function createCommentService(ctx) {
  const { db, clock } = ctx;

  function requireTask(taskId) {
    if (!db.tasks.get(taskId)) throw notFound('task');
  }

  return {
    add(actor, taskId, body) {
      const now = clock();
      const draft = buildComment({ taskId, body, actor, now });
      requireTask(taskId);
      const comment = db.comments.insert({ id: db.nextId('comment'), ...draft });
      emit(ctx, now, 'comment.added', actor, subject('comment', comment.id), { taskId });
      db.save();
      return comment;
    },

    // Oldest first.
    list(actor, taskId) {
      requireTask(taskId);
      return db.comments.findBy('taskId', taskId);
    },
  };
}
