import { LruCache } from './lru.mjs';
import { systemClock } from './clock.mjs';

// TODO: class TtlCache, see the task description
export class TtlCache {
  constructor({ max, ttlMs, clock = systemClock } = {}) {
    throw new Error('not implemented');
  }
}
