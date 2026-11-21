import { makeEvent } from '../events/events.mjs';

export const subject = (kind, id) => ({ kind, id });

// Publishes an event on the bus. `now` is the timestamp the calling use case already read from
// the clock, so a record and its event always carry the same time.
export function emit({ bus }, now, type, actor, about, data) {
  return bus.emit(makeEvent({ type, at: now, actor, subject: about, data }));
}
