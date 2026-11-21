import { ok } from '../http.mjs';

export const reportRoutes = [
  {
    method: 'GET',
    path: '/workspaces/:ws/reports/summary',
    handler: ({ services, user, params, query }) =>
      ok(services.reports.summary(user, params.ws, { projectId: query.projectId })),
  },
];
