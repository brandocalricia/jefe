import { ok } from '../http.mjs';

export const auditRoutes = [
  {
    method: 'GET',
    path: '/audit',
    handler: ({ services, user, query }) =>
      ok(services.audit.list(user, { type: query.type, limit: query.limit === undefined ? undefined : Number(query.limit) })),
  },
];
