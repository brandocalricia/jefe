import { created, ok } from '../http.mjs';

export const commentRoutes = [
  { method: 'GET', path: '/tasks/:id/comments', handler: ({ services, user, params }) => ok(services.comments.list(user, params.id)) },
  {
    method: 'POST',
    path: '/tasks/:id/comments',
    handler: ({ services, user, params, body }) => created(services.comments.add(user, params.id, body.body)),
  },
];
