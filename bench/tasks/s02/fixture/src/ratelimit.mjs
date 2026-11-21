import { systemClock } from './clock.mjs';

// TODO: createRateLimiter({ limit, windowMs, clock = systemClock }) -> { check(key) }
export function createRateLimiter({ limit, windowMs, clock = systemClock } = {}) {
  throw new Error('not implemented');
}
