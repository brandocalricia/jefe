import { SlotwiseError } from './errors.mjs';
import { parseOffset } from './offset.mjs';
import { validateHours } from './hours.mjs';
import { validateRule } from './rules.mjs';

const bad = (what) => new SlotwiseError('E_INVALID', `invalid resource: ${what}`);

// Something that can be booked: a room, a chair, a court. `capacity` bookings may overlap at the same time and
// `buffer` minutes are kept free before and after every booking.
export function createResource(input) {
  if (input === null || typeof input !== 'object') throw bad('not an object');
  if (typeof input.id !== 'string' || !/^[a-z0-9-]+$/.test(input.id)) throw bad('id');
  if (typeof input.name !== 'string' || input.name.trim() === '') throw bad('name');
  const capacity = input.capacity ?? 1;
  if (!Number.isInteger(capacity) || capacity < 1) throw bad('capacity');
  const buffer = input.buffer ?? 0;
  if (!Number.isInteger(buffer) || buffer < 0) throw bad('buffer');
  return {
    id: input.id,
    name: input.name,
    offset: parseOffset(input.offset ?? 'Z'),
    capacity,
    buffer,
    hours: validateHours(input.hours),
    rules: (input.rules ?? []).map(validateRule),
  };
}
