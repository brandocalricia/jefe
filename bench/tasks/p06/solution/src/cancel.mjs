import { SlotwiseError, requireOptions } from './errors.mjs';
import { invalidate } from './store.mjs';
import { promoteWaitlist } from './waitlist.mjs';
import { clockOf } from './clock.mjs';

// Cancels a confirmed booking, then offers the freed time to the waitlist.
// Returns { cancelled: <the booking>, promoted: [<new bookings>] }.
export function cancelBooking(store, options) {
  const { bookingId } = requireOptions(options);
  const clock = clockOf(options);
  const booking = store.bookings.get(bookingId);
  if (!booking) throw new SlotwiseError('E_NOT_FOUND', `unknown booking: ${bookingId}`);
  if (booking.status === 'cancelled') throw new SlotwiseError('E_CONFLICT', `already cancelled: ${bookingId}`);
  booking.status = 'cancelled';
  invalidate(store, booking.resourceId);
  const promoted = promoteWaitlist(store, { resourceId: booking.resourceId, clock });
  return { cancelled: { ...booking }, promoted };
}
