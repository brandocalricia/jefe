import { SlotwiseError } from './errors.mjs';
import { createResource } from './resource.mjs';
import { validateRule } from './rules.mjs';
import { sortBy } from './sort.mjs';

// In-memory state: resources, bookings (id -> booking), the waitlist, id counters and a cache of open slots.
export function createStore() {
  return { resources: new Map(), bookings: new Map(), waitlist: [], cache: new Map(), counters: { booking: 1, waitlist: 1 } };
}

export function addResource(store, input) {
  const resource = createResource(input);
  if (store.resources.has(resource.id)) throw new SlotwiseError('E_CONFLICT', `resource exists: ${resource.id}`);
  store.resources.set(resource.id, resource);
  return resource;
}

export function getResource(store, id) {
  const resource = store.resources.get(id);
  if (!resource) throw new SlotwiseError('E_NOT_FOUND', `unknown resource: ${id}`);
  return resource;
}

export function listResources(store) {
  return [...store.resources.values()];
}

export function addRule(store, resourceId, rule) {
  const resource = getResource(store, resourceId);
  resource.rules.push(validateRule(rule));
  invalidate(store, resourceId);
  return resource;
}

// Copies of the bookings, ordered by start; bookings with the same start keep the order they were made in.
export function listBookings(store, filter = {}) {
  const all = [...store.bookings.values()].filter(
    (b) => (filter.resourceId === undefined || b.resourceId === filter.resourceId) && (filter.status === undefined || b.status === filter.status),
  );
  return sortBy(all, (b) => b.start).map((b) => ({ ...b }));
}

export function invalidate(store, resourceId) {
  for (const key of [...store.cache.keys()]) {
    if (key.startsWith(`${resourceId}|`)) store.cache.delete(key);
  }
}
