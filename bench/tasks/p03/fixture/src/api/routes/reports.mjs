import { ok } from '../http.mjs';

export const reportRoutes = [
  {
    method: 'GET',
    path: '/reports/summary',
    handler: ({ services, user, query }) => ok(services.reports.summary(user, { projectId: query.projectId })),
  },
];
