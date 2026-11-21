import { AppError } from '../domain/errors.mjs';
import { isUserId } from '../domain/validation.mjs';
import { auditRoutes } from './routes/audit.mjs';
import { commentRoutes } from './routes/comments.mjs';
import { projectRoutes } from './routes/projects.mjs';
import { reportRoutes } from './routes/reports.mjs';
import { taskRoutes } from './routes/tasks.mjs';
import { fromError } from './http.mjs';
import { createRouter } from './router.mjs';

// A request is { method, path, query, body, user }; the answer is { status, body }. Nothing here
// touches the network, so the same function serves tests, the CLI and any real server.
export function createApi({ services }) {
  const router = createRouter([...projectRoutes, ...taskRoutes, ...commentRoutes, ...reportRoutes, ...auditRoutes]);
  return {
    handle({ method, path, query = {}, body, user }) {
      try {
        const found = router.match(method, path);
        if (found === null) throw new AppError('not_found', 'route not found');
        if (found.methodNotAllowed) throw new AppError('method_not_allowed', 'method not allowed');
        if (!isUserId(user)) throw new AppError('unauthenticated', 'user is required');
        return found.route.handler({ services, user, params: found.params, query, body: body ?? {} });
      } catch (error) {
        return fromError(error);
      }
    },
  };
}
