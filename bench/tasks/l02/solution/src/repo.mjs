const clone = (record) => structuredClone(record);

// An in-memory repository of records that have an `id`.
export function createRepo() {
  const rows = new Map();
  return {
    // the record, or null
    get(id) {
      return rows.has(id) ? clone(rows.get(id)) : null;
    },
    // records whose fields equal every field of `filter`, in insertion order
    list(filter = {}) {
      return [...rows.values()].filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)).map(clone);
    },
    // create or replace; true if the record was new
    put(record) {
      const isNew = !rows.has(record.id);
      rows.set(record.id, clone(record));
      return isNew;
    },
    // true if something was removed
    delete(id) {
      return rows.delete(id);
    },
  };
}

// Creates a record that must not exist yet (what the old repo.insert guaranteed).
export function insertNew(repo, record) {
  if (repo.get(record.id) !== null) throw new Error(`duplicate id: ${record.id}`);
  repo.put(record);
}

export function createStores() {
  return { customers: createRepo(), products: createRepo(), stock: createRepo(), orders: createRepo(), shipments: createRepo(), invoices: createRepo(), outbox: createRepo() };
}
