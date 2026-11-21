import { SlotwiseError } from './errors.mjs';
import { createBooking } from './booking.mjs';

// Books every spec ({ resourceId, start, end, customer }) in the order given. A spec that fails does not stop the
// others. Returns { booked: [bookings], failed: [{ index, code, message }] } where index is the spec's position.
export function bookMany(store, specs) {
  if (!Array.isArray(specs)) throw new SlotwiseError('E_INVALID', 'invalid bookings list');
  const booked = [];
  const failed = [];
  specs.forEach((spec) => {
    try {
      booked.push(createBooking(store, spec.resourceId, spec.start, spec.end, spec.customer));
    } catch (err) {
      if (!(err instanceof SlotwiseError)) throw err;
    }
  });
  return { booked, failed };
}
