import { created, ok } from '../http.mjs';

export const projectRoutes = [
  {
    method: 'GET',
    path: '/projects',
    handler: ({ services, user, query }) =>
      ok(services.projects.list(user, { includeArchived: query.includeArchived === 'true' })),
  },
  { method: 'POST', path: '/projects', handler: ({ services, user, body }) => created(services.projects.create(user, body)) },
  { method: 'GET', path: '/projects/:id', handler: ({ services, user, params }) => ok(services.projects.get(user, params.id)) },
  {
    method: 'PATCH',
    path: '/projects/:id',
    handler: ({ services, user, params, body }) => ok(services.projects.update(user, params.id, body)),
  },
  {
    method: 'POST',
    path: '/projects/:id/archive',
    handler: ({ services, user, params }) => ok(services.projects.archive(user, params.id)),
  },
];
