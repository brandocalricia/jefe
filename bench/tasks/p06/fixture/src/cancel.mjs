import { SlotwiseError } from './errors.mjs';
import { promoteWaitlist } from './waitlist.mjs';
import { legacyClock } from './clock.mjs';

// Cancels a confirmed booking, then offers the freed time to the waitlist.
// Returns { cancelled: <the booking>, promoted: [<new bookings>] }.
export function cancelBooking(store, bookingId) {
  const now = legacyClock().now();
  const booking = store.bookings.get(bookingId);
  if (!booking) throw new SlotwiseError('E_NOT_FOUND', `unknown booking: ${bookingId}`);
  if (booking.status === 'cancelled') throw new SlotwiseError('E_CONFLICT', `already cancelled: ${bookingId}`);
  booking.status = 'cancelled';
  const promoted = promoteWaitlist(store, booking.resourceId, now);
  return { cancelled: { ...booking }, promoted };
}
