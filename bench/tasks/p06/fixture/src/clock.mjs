import { parseInstant } from './time.mjs';

// Deprecated: reads the environment variable SLOTWISE_NOW (an instant) on every call, or the system clock when it
// is not set. Every function that needs "now" calls this itself.
export function legacyClock() {
  return {
    now() {
      const raw = process.env.SLOTWISE_NOW;
      return raw ? parseInstant(raw) : Math.floor(Date.now() / 60000);
    },
  };
}
