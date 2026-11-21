import { created, ok } from '../http.mjs';

const BASE = '/workspaces/:ws/tasks/:id/comments';

export const commentRoutes = [
  { method: 'GET', path: BASE, handler: ({ services, user, params }) => ok(services.comments.list(user, params.ws, params.id)) },
  {
    method: 'POST',
    path: BASE,
    handler: ({ services, user, params, body }) => created(services.comments.add(user, params.ws, params.id, body.body)),
  },
];
