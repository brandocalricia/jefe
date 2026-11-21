import { LruCache } from './lru.mjs';
import { systemClock } from './clock.mjs';
import { createStats } from './stats.mjs';

function positiveInt(name, v) {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer`);
}

export class TtlCache {
  #lru;
  #ttlMs;
  #clock;
  #stats = createStats();

  constructor({ max, ttlMs, clock = systemClock } = {}) {
    positiveInt('ttlMs', ttlMs);
    this.#lru = new LruCache(max);
    this.#ttlMs = ttlMs;
    this.#clock = clock;
  }

  #live(entry, now) {
    return entry !== undefined && now < entry.expiresAt;
  }

  #purge(now) {
    for (const key of this.#lru.keys()) {
      if (!this.#live(this.#lru.peek(key), now)) this.#lru.delete(key);
    }
  }

  set(key, value, { ttlMs } = {}) {
    if (ttlMs !== undefined) positiveInt('ttlMs', ttlMs);
    const now = this.#clock.now();
    if (!this.#lru.has(key) && this.#lru.size >= this.#lru.max) this.#purge(now);
    const evicted = this.#lru.set(key, { value, expiresAt: now + (ttlMs ?? this.#ttlMs) });
    if (evicted) this.#stats.evict();
    return this;
  }

  get(key) {
    const now = this.#clock.now();
    const entry = this.#lru.peek(key);
    if (entry === undefined) {
      this.#stats.miss();
      return undefined;
    }
    if (!this.#live(entry, now)) {
      this.#lru.delete(key);
      this.#stats.miss();
      return undefined;
    }
    this.#lru.get(key);
    this.#stats.hit();
    return entry.value;
  }

  has(key) {
    const entry = this.#lru.peek(key);
    if (entry === undefined) return false;
    if (this.#live(entry, this.#clock.now())) return true;
    this.#lru.delete(key);
    return false;
  }

  delete(key) {
    const live = this.has(key);
    this.#lru.delete(key);
    return live;
  }

  get size() {
    this.#purge(this.#clock.now());
    return this.#lru.size;
  }

  stats() {
    return this.#stats.snapshot();
  }
}
