import { TtlCache } from './ttl-cache.mjs';

export function memoize(fn, { ttlMs, max = 100, clock, key = (...args) => JSON.stringify(args) } = {}) {
  const cache = new TtlCache({ max, ttlMs, ...(clock ? { clock } : {}) });
  const wrapped = function (...args) {
    const k = key(...args);
    if (cache.has(k)) return cache.get(k);
    const value = fn.apply(this, args);
    cache.set(k, value);
    return value;
  };
  wrapped.cache = cache;
  return wrapped;
}
