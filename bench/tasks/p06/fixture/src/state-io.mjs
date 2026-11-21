import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SlotwiseError } from './errors.mjs';
import { createStore, addResource, listResources } from './store.mjs';
import { formatOffset } from './offset.mjs';
import { DAYS, formatClock } from './hours.mjs';

// The state file is JSON: { version: 1, resources, bookings, waitlist, counters }. Resources are written the same
// way they are added, so a saved file can be loaded again unchanged.
export function exportState(store) {
  return {
    version: 1,
    resources: listResources(store).map((r) => ({
      id: r.id,
      name: r.name,
      offset: formatOffset(r.offset),
      capacity: r.capacity,
      buffer: r.buffer,
      hours: Object.fromEntries(DAYS.filter((d) => r.hours[d].length).map((d) => [d, r.hours[d].map((w) => [formatClock(w.open), formatClock(w.close)])])),
      rules: r.rules.map((rule) => ({ ...rule })),
    })),
    bookings: [...store.bookings.values()].map((b) => ({ ...b })),
    waitlist: store.waitlist.map((w) => ({ ...w })),
    counters: { ...store.counters },
  };
}

export function importState(data) {
  if (data === null || typeof data !== 'object' || data.version !== 1) throw new SlotwiseError('E_INVALID', 'unsupported state version');
  const store = createStore();
  for (const r of data.resources ?? []) addResource(store, r);
  for (const b of data.bookings ?? []) store.bookings.set(b.id, { ...b });
  store.waitlist.push(...(data.waitlist ?? []).map((w) => ({ ...w })));
  if (data.counters) store.counters = { ...store.counters, ...data.counters };
  return store;
}

// A file that does not exist is an empty store.
export function loadStateFile(path) {
  if (!existsSync(path)) return createStore();
  try {
    return importState(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    if (err instanceof SyntaxError) throw new SlotwiseError('E_INVALID', `invalid state file: ${path}`);
    throw err;
  }
}

export function saveStateFile(path, store) {
  writeFileSync(path, `${JSON.stringify(exportState(store), null, 2)}\n`);
}
