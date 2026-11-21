// An in-memory collection of records keyed by `id`, with optional equality indexes. Every record
// that goes in or comes out is a copy, so callers cannot change stored data by accident.
export class Repository {
  #name;
  #items = new Map();
  #order = new Map();
  #indexes = new Map();
  #seq = 0;

  constructor({ name, indexes = [], items = [] }) {
    this.#name = name;
    for (const field of indexes) this.#indexes.set(field, new Map());
    for (const item of items) this.insert(item);
  }

  insert(record) {
    if (this.#items.has(record.id)) throw new Error(`${this.#name}: duplicate id ${record.id}`);
    const stored = structuredClone(record);
    this.#items.set(stored.id, stored);
    this.#order.set(stored.id, this.#seq++);
    this.#index(stored);
    return structuredClone(stored);
  }

  get(id) {
    const record = this.#items.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  update(id, patch) {
    const current = this.#items.get(id);
    if (current === undefined) throw new Error(`${this.#name}: unknown id ${id}`);
    this.#unindex(current);
    const next = { ...current, ...structuredClone(patch), id };
    this.#items.set(id, next);
    this.#index(next);
    return structuredClone(next);
  }

  remove(id) {
    const current = this.#items.get(id);
    if (current === undefined) return false;
    this.#unindex(current);
    this.#items.delete(id);
    this.#order.delete(id);
    return true;
  }

  // All records in insertion order.
  all() {
    return [...this.#items.values()].map((record) => structuredClone(record));
  }

  // Records whose indexed field equals `value` (a missing field counts as null), in insertion order.
  findBy(field, value) {
    const index = this.#indexes.get(field);
    if (index === undefined) throw new Error(`${this.#name}: no index on ${field}`);
    const ids = [...(index.get(value) ?? [])].sort((a, b) => this.#order.get(a) - this.#order.get(b));
    return ids.map((id) => structuredClone(this.#items.get(id)));
  }

  count() {
    return this.#items.size;
  }

  #index(record) {
    for (const [field, index] of this.#indexes) {
      const key = record[field] ?? null;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(record.id);
    }
  }

  #unindex(record) {
    for (const [field, index] of this.#indexes) {
      const key = record[field] ?? null;
      index.get(key)?.delete(record.id);
    }
  }
}
