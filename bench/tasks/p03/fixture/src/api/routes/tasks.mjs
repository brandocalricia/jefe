import { created, noContent, ok } from '../http.mjs';

// ?assignee=none selects unassigned tasks.
function filterFromQuery(query) {
  const { projectId, status, priority, assignee, label, q } = query;
  return { projectId, status, priority, assignee: assignee === 'none' ? null : assignee, label, q };
}

export const taskRoutes = [
  { method: 'GET', path: '/tasks', handler: ({ services, user, query }) => ok(services.tasks.list(user, filterFromQuery(query))) },
  { method: 'POST', path: '/tasks', handler: ({ services, user, body }) => created(services.tasks.create(user, body)) },
  { method: 'GET', path: '/tasks/:id', handler: ({ services, user, params }) => ok(services.tasks.get(user, params.id)) },
  {
    method: 'PATCH',
    path: '/tasks/:id',
    handler: ({ services, user, params, body }) => ok(services.tasks.update(user, params.id, body)),
  },
  {
    method: 'POST',
    path: '/tasks/:id/move',
    handler: ({ services, user, params, body }) => ok(services.tasks.move(user, params.id, body.status)),
  },
  {
    method: 'POST',
    path: '/tasks/:id/assign',
    handler: ({ services, user, params, body }) => ok(services.tasks.assign(user, params.id, body.assignee)),
  },
  {
    method: 'DELETE',
    path: '/tasks/:id',
    handler: ({ services, user, params }) => {
      services.tasks.remove(user, params.id);
      return noContent();
    },
  },
];
