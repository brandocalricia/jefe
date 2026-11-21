// Least-recently-inserted cache: only set() changes the eviction order, get() never does.
export class LruCache {
  #max;
  #map = new Map();

  constructor(max) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
    this.#max = max;
  }

  get max() {
    return this.#max;
  }

  get size() {
    return this.#map.size;
  }

  // Does not count as a use.
  has(key) {
    return this.#map.has(key);
  }

  // Read without counting as a use.
  peek(key) {
    return this.#map.get(key);
  }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  // Returns [key, value] of the entry that was pushed out, if any.
  set(key, value) {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      const evicted = [oldest, this.#map.get(oldest)];
      this.#map.delete(oldest);
      return evicted;
    }
    return undefined;
  }

  // Returns the removed value.
  delete(key) {
    return this.#map.delete(key);
  }

  // Keys from least to most recently used.
  keys() {
    return [...this.#map.keys()];
  }
}
