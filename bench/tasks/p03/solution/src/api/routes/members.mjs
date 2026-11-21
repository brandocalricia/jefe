import { created, noContent, ok } from '../http.mjs';

export const memberRoutes = [
  { method: 'GET', path: '/workspaces/:ws/members', handler: ({ services, user, params }) => ok(services.members.list(user, params.ws)) },
  {
    method: 'POST',
    path: '/workspaces/:ws/members',
    handler: ({ services, user, params, body }) => created(services.members.add(user, params.ws, body)),
  },
  {
    method: 'PATCH',
    path: '/workspaces/:ws/members/:user',
    handler: ({ services, user, params, body }) => ok(services.members.setRole(user, params.ws, params.user, body.role)),
  },
  {
    method: 'DELETE',
    path: '/workspaces/:ws/members/:user',
    handler: ({ services, user, params }) => {
      services.members.remove(user, params.ws, params.user);
      return noContent();
    },
  },
];
