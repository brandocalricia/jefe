import { formatInstant } from './time.mjs';

// <id> <resource> <start> <end> <customer> <status>, with times written in the given offset (minutes).
export function formatBooking(booking, offset = 0) {
  return [booking.id, booking.resourceId, formatInstant(booking.start, offset), formatInstant(booking.end, offset), booking.customer, booking.status].join(' ');
}

// <start>..<end>
export function formatSlot(slot, offset = 0) {
  return `${formatInstant(slot.start, offset)}..${formatInstant(slot.end, offset)}`;
}

// Plain text report. Times are written in UTC (+00:00). Columns are separated by one tab.
export function formatReport(report) {
  const cell = (r) => [r.bookings, r.cancelled, r.bookedMinutes, r.openMinutes, `${r.utilization}%`];
  const lines = [
    `report ${formatInstant(report.from)}..${formatInstant(report.to)} as of ${formatInstant(report.asOf)}`,
    ['resource', 'bookings', 'cancelled', 'booked', 'open', 'util'].join('\t'),
  ];
  for (const row of report.rows) lines.push([row.resourceId, ...cell(row)].join('\t'));
  lines.push(['TOTAL', ...cell(report.totals)].join('\t'));
  return lines.join('\n');
}
