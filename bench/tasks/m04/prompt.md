We need a cache with expiry for the lookup service. Build `TtlCache` on top of the `LruCache` we already have, plus a `memoize` helper, and export them from `src/index.mjs`. There are stubs for `src/ttl-cache.mjs`, `src/memoize.mjs` and `src/stats.mjs` (the counters behind `stats()`).

`new TtlCache({ max, ttlMs, clock = systemClock })`
- `set(key, value, { ttlMs } = {})` stores the value; an entry is gone exactly `ttlMs` milliseconds after it was set (at that instant it is already expired). The optional `ttlMs` overrides the default for that entry. Setting a key that exists replaces the value, restarts its timer and makes it the most recently used. A `ttlMs` that is not a positive integer throws a RangeError, and so does a bad `max`.
- `get(key)` returns the value, or `undefined` if the key is missing or expired. A successful `get` makes the entry the most recently used. Reading does not extend the timer.
- `has(key)` is true only for live entries and does not count as a use. `delete(key)` returns true only if it removed a live entry. `size` counts live entries only.
- When the cache is full and a new key arrives, expired entries are dropped first; only if it is still full is the least recently used live entry evicted.
- `stats()` returns `{ hits, misses, evictions }`: `get` of a live entry is a hit, `get` of a missing or expired key is a miss, and evictions counts live entries pushed out by the size limit.

`memoize(fn, { ttlMs, max = 100, clock, key })` returns a function that caches `fn`'s results by `key(...args)` (default `JSON.stringify(args)`) using a TtlCache. Whatever `fn` returned is cached, including `undefined`, `null`, `0` and `false`. If `fn` throws, nothing is cached and the error propagates. The returned function has a `cache` property, the TtlCache it uses.

Add tests under `tests/` and make `npm test` pass.

ANSWERS:
- Language and runtime: plain JavaScript ES modules, Node 22, no dependencies
- Where: src/ttl-cache.mjs, src/memoize.mjs, src/stats.mjs and src/index.mjs; tests in tests/
- Time: use the injected clock for every time reading, in milliseconds
- Scope: reuse LruCache rather than writing a second LRU; no timers; no README or package changes
