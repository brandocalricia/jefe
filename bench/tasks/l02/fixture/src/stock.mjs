export function setStock(repo, productId, qty) {
  const record = { id: productId, qty };
  if (repo.findById(productId)) repo.update(record);
  else repo.insert(record);
}

export function getStock(repo, productId) {
  const record = repo.findById(productId);
  return record ? record.qty : 0;
}

export function adjustStock(repo, productId, delta) {
  const record = repo.findById(productId);
  if (!record) throw new Error(`no stock record: ${productId}`);
  if (record.qty + delta < 0) throw new Error(`insufficient stock for ${productId}`);
  repo.update({ ...record, qty: record.qty + delta });
}

export function lowStock(repo, threshold) {
  return repo.findAll().filter((r) => r.qty <= threshold).map((r) => r.id).sort();
}
