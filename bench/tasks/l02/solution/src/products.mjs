import { insertNew } from './repo.mjs';

export function addProduct(repo, { id, name, priceCents }) {
  if (!Number.isInteger(priceCents) || priceCents < 0) throw new Error('bad price');
  const product = { id, name, priceCents };
  insertNew(repo, product);
  return product;
}

export function setPrice(repo, id, priceCents) {
  if (!Number.isInteger(priceCents) || priceCents < 0) throw new Error('bad price');
  const product = repo.get(id);
  if (!product) throw new Error(`no such product: ${id}`);
  repo.put({ ...product, priceCents });
}

export function listProducts(repo) {
  return repo.list().sort((a, b) => a.name.localeCompare(b.name));
}

export function discontinue(repo, id) {
  return repo.delete(id);
}
