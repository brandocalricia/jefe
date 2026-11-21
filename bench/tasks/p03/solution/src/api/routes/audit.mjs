import { ok } from '../http.mjs';

export const auditRoutes = [
  {
    method: 'GET',
    path: '/workspaces/:ws/audit',
    handler: ({ services, user, params, query }) =>
      ok(services.audit.list(user, params.ws, {
        type: query.type,
        limit: query.limit === undefined ? undefined : Number(query.limit),
      })),
  },
];
