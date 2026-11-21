import { forbidden, notFound } from '../domain/errors.mjs';
import { can } from '../domain/permissions.mjs';
import { makeEvent } from '../events/events.mjs';

export const subject = (kind, id) => ({ kind, id });

export const membershipId = (workspaceId, user) => `${workspaceId}:${user}`;

// The first check of every workspace-scoped use case. An unknown workspace and a workspace the
// actor does not belong to look the same. Pass no action to require membership only.
// Returns the actor's membership.
export function authorize(db, actor, workspaceId, action) {
  const membership = typeof workspaceId === 'string' ? db.memberships.get(membershipId(workspaceId, actor)) : undefined;
  if (membership === undefined) throw notFound('workspace');
  if (action !== undefined && !can(membership.role, action)) {
    throw forbidden(`role ${membership.role} cannot ${action}`);
  }
  return membership;
}

// Publishes an event on the bus. `now` is the timestamp the calling use case already read from
// the clock, so a record and its event always carry the same time.
export function emit({ bus }, now, type, actor, workspaceId, about, data) {
  return bus.emit(makeEvent({ type, at: now, actor, workspaceId, subject: about, data }));
}
