import { created, ok } from '../http.mjs';

const BASE = '/workspaces/:ws/projects';

export const projectRoutes = [
  {
    method: 'GET',
    path: BASE,
    handler: ({ services, user, params, query }) =>
      ok(services.projects.list(user, params.ws, { includeArchived: query.includeArchived === 'true' })),
  },
  { method: 'POST', path: BASE, handler: ({ services, user, params, body }) => created(services.projects.create(user, params.ws, body)) },
  { method: 'GET', path: `${BASE}/:id`, handler: ({ services, user, params }) => ok(services.projects.get(user, params.ws, params.id)) },
  {
    method: 'PATCH',
    path: `${BASE}/:id`,
    handler: ({ services, user, params, body }) => ok(services.projects.update(user, params.ws, params.id, body)),
  },
  {
    method: 'POST',
    path: `${BASE}/:id/archive`,
    handler: ({ services, user, params }) => ok(services.projects.archive(user, params.ws, params.id)),
  },
];
