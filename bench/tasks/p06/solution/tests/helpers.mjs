import { createStore, addResource } from '../src/store.mjs';
import { createClock } from '../src/clock.mjs';

// Monday 2025-03-03 08:00 UTC. 2025-03-10 is the Monday after.
export const NOW = '2025-03-03T08:00Z';
export const clock = createClock({ now: NOW });
export const at = (day, hm) => `2025-03-${String(day).padStart(2, '0')}T${hm}Z`;

export function venue(extra = {}) {
  const store = createStore();
  addResource(store, { id: 'room-a', name: 'Room A', hours: { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']] }, ...extra });
  return store;
}
