I need a rate limiter for our API gateway. Add `createRateLimiter({ limit, windowMs, clock })` in `src/ratelimit.mjs` (there is a stub) and export it from `src/index.mjs` like the other things.

It is a sliding window, tracked per key: a key may make at most `limit` allowed requests in any span of `windowMs` milliseconds. The returned object has `check(key)`, which returns `{ allowed, remaining, retryAfterMs }`. When the request is allowed, `remaining` is how many more would be allowed right now and `retryAfterMs` is 0. When it is denied, `remaining` is 0 and `retryAfterMs` is how long until a request would be allowed. Only allowed requests count toward the limit. `clock` defaults to `systemClock`. A `limit` or `windowMs` that is not a positive integer throws a RangeError.

Add tests under `tests/` and make `npm test` pass.

ANSWERS:
- Language and runtime: plain JavaScript ES module, Node 22, no dependencies
- Where: src/ratelimit.mjs and the export in src/index.mjs; tests in tests/
- Time: always read time through the clock object, never call Date.now() directly in the limiter
- Scope: no timers, no CLI, no README or package changes
