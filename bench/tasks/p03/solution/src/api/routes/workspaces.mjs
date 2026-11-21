import { created, ok } from '../http.mjs';

export const workspaceRoutes = [
  { method: 'GET', path: '/workspaces', handler: ({ services, user }) => ok(services.workspaces.listForUser(user)) },
  { method: 'POST', path: '/workspaces', handler: ({ services, user, body }) => created(services.workspaces.create(user, body)) },
  { method: 'GET', path: '/workspaces/:ws', handler: ({ services, user, params }) => ok(services.workspaces.get(user, params.ws)) },
  {
    method: 'PATCH',
    path: '/workspaces/:ws',
    handler: ({ services, user, params, body }) => ok(services.workspaces.rename(user, params.ws, body)),
  },
];
