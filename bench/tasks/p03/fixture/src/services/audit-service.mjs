import { validation } from '../domain/errors.mjs';

export function createAuditService({ audit }) {
  return {
    // Newest first. limit defaults to 50 and must be an integer from 1 to 200.
    list(actor, { type, limit } = {}) {
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
        throw validation('limit must be an integer between 1 and 200');
      }
      return audit.list({ type, limit });
    },
  };
}
