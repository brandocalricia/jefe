import { systemClock } from './clock.mjs';

function positiveInt(name, v) {
  if (!Number.isInteger(v) || v <= 0) throw new RangeError(`${name} must be a positive integer`);
}

export function createRateLimiter({ limit, windowMs, clock = systemClock } = {}) {
  positiveInt('limit', limit);
  positiveInt('windowMs', windowMs);
  const hits = new Map(); // key -> allowed request timestamps, oldest first

  return {
    check(key) {
      const now = clock.now();
      const list = hits.get(key) ?? [];
      // a request made at t stops counting at t + windowMs
      while (list.length && list[0] <= now - windowMs) list.shift();
      if (list.length >= limit) {
        hits.set(key, list);
        return { allowed: false, remaining: 0, retryAfterMs: list[0] + windowMs - now };
      }
      list.push(now);
      hits.set(key, list);
      return { allowed: true, remaining: limit - list.length, retryAfterMs: 0 };
    },
  };
}
