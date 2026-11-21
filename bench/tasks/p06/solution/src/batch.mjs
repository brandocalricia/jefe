import { SlotwiseError, requireOptions } from './errors.mjs';
import { createBooking } from './booking.mjs';
import { clockOf } from './clock.mjs';

// Books every spec ({ resourceId, start, end, customer }) in the order given. A spec that fails does not stop the
// others. Returns { booked: [bookings], failed: [{ index, code, message }] } where index is the spec's position.
export function bookMany(store, options) {
  const { bookings: specs } = requireOptions(options);
  const clock = clockOf(options);
  if (!Array.isArray(specs)) throw new SlotwiseError('E_INVALID', 'invalid bookings list');
  const booked = [];
  const failed = [];
  specs.forEach((spec, index) => {
    try {
      booked.push(createBooking(store, { resourceId: spec.resourceId, start: spec.start, end: spec.end, customer: spec.customer, clock }));
    } catch (err) {
      if (!(err instanceof SlotwiseError)) throw err;
      failed.push({ index, code: err.code, message: err.message });
    }
  });
  return { booked, failed };
}
