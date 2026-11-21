import { SlotwiseError } from './errors.mjs';
import { parseInstant } from './time.mjs';

// A clock is { now() } returning the current instant in whole minutes. With `now` given the clock is fixed at
// that instant (integer or instant text); without it the clock follows the system time.
export function createClock({ now } = {}) {
  if (now === undefined) return { now: () => Math.floor(Date.now() / 60000) };
  const fixed = Number.isInteger(now) ? now : typeof now === 'string' ? parseInstant(now) : NaN;
  if (Number.isNaN(fixed)) throw new SlotwiseError('E_INVALID', `invalid instant: ${now}`);
  return { now: () => fixed };
}

// The clock named by an options object, or the system clock when none was given.
export function clockOf(options) {
  return options.clock ?? createClock();
}
