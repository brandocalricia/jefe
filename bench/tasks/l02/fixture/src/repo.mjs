const clone = (record) => structuredClone(record);

// An in-memory repository of records that have an `id`.
export function createRepo() {
  const rows = new Map();
  return {
    // the record, or null
    findById(id) {
      return rows.has(id) ? clone(rows.get(id)) : null;
    },
    // records whose fields equal every field of `filter`, in insertion order
    findAll(filter = {}) {
      return [...rows.values()].filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)).map(clone);
    },
    insert(record) {
      if (rows.has(record.id)) throw new Error(`duplicate id: ${record.id}`);
      rows.set(record.id, clone(record));
    },
    update(record) {
      if (!rows.has(record.id)) throw new Error(`no such record: ${record.id}`);
      rows.set(record.id, clone(record));
    },
    // true if something was removed
    remove(id) {
      return rows.delete(id);
    },
  };
}

export function createStores() {
  return { customers: createRepo(), products: createRepo(), stock: createRepo(), orders: createRepo(), shipments: createRepo(), invoices: createRepo(), outbox: createRepo() };
}
