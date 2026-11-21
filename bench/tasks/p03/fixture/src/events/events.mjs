// Event types published by the services. Every event looks like
// { type, at, actor, subject: { kind, id }, data }.
export const EVENTS = Object.freeze({
  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_ARCHIVED: 'project.archived',
  TASK_CREATED: 'task.created',
  TASK_UPDATED: 'task.updated',
  TASK_MOVED: 'task.moved',
  TASK_ASSIGNED: 'task.assigned',
  TASK_DELETED: 'task.deleted',
  COMMENT_ADDED: 'comment.added',
});

export function makeEvent({ type, at, actor, subject, data = {} }) {
  return { type, at, actor, subject, data };
}
