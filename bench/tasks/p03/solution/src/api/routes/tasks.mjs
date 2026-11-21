import { created, noContent, ok } from '../http.mjs';

const BASE = '/workspaces/:ws/tasks';

// ?assignee=none selects unassigned tasks.
function filterFromQuery(query) {
  const { projectId, status, priority, assignee, label, q } = query;
  return { projectId, status, priority, assignee: assignee === 'none' ? null : assignee, label, q };
}

export const taskRoutes = [
  {
    method: 'GET',
    path: BASE,
    handler: ({ services, user, params, query }) => ok(services.tasks.list(user, params.ws, filterFromQuery(query))),
  },
  { method: 'POST', path: BASE, handler: ({ services, user, params, body }) => created(services.tasks.create(user, params.ws, body)) },
  { method: 'GET', path: `${BASE}/:id`, handler: ({ services, user, params }) => ok(services.tasks.get(user, params.ws, params.id)) },
  {
    method: 'PATCH',
    path: `${BASE}/:id`,
    handler: ({ services, user, params, body }) => ok(services.tasks.update(user, params.ws, params.id, body)),
  },
  {
    method: 'POST',
    path: `${BASE}/:id/move`,
    handler: ({ services, user, params, body }) => ok(services.tasks.move(user, params.ws, params.id, body.status)),
  },
  {
    method: 'POST',
    path: `${BASE}/:id/assign`,
    handler: ({ services, user, params, body }) => ok(services.tasks.assign(user, params.ws, params.id, body.assignee)),
  },
  {
    method: 'DELETE',
    path: `${BASE}/:id`,
    handler: ({ services, user, params }) => {
      services.tasks.remove(user, params.ws, params.id);
      return noContent();
    },
  },
];
