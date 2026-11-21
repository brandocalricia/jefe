export function setStock(repo, productId, qty) {
  const record = { id: productId, qty };
  repo.put(record);
}

export function getStock(repo, productId) {
  const record = repo.get(productId);
  return record ? record.qty : 0;
}

export function adjustStock(repo, productId, delta) {
  const record = repo.get(productId);
  if (!record) throw new Error(`no stock record: ${productId}`);
  if (record.qty + delta < 0) throw new Error(`insufficient stock for ${productId}`);
  repo.put({ ...record, qty: record.qty + delta });
}

export function lowStock(repo, threshold) {
  return repo.list().filter((r) => r.qty <= threshold).map((r) => r.id).sort();
}
