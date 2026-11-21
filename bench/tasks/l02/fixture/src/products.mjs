export function addProduct(repo, { id, name, priceCents }) {
  if (!Number.isInteger(priceCents) || priceCents < 0) throw new Error('bad price');
  const product = { id, name, priceCents };
  repo.insert(product);
  return product;
}

export function setPrice(repo, id, priceCents) {
  if (!Number.isInteger(priceCents) || priceCents < 0) throw new Error('bad price');
  const product = repo.findById(id);
  if (!product) throw new Error(`no such product: ${id}`);
  repo.update({ ...product, priceCents });
}

export function listProducts(repo) {
  return repo.findAll().sort((a, b) => a.name.localeCompare(b.name));
}

export function discontinue(repo, id) {
  return repo.remove(id);
}
