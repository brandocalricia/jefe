import { insertNew } from './repo.mjs';

export function addCustomer(repo, { id, name, email }) {
  if (!id || !name) throw new Error('customer needs id and name');
  const customer = { id, name, email: email ?? null, active: true };
  insertNew(repo, customer);
  return customer;
}

export function renameCustomer(repo, id, name) {
  const customer = repo.get(id);
  if (!customer) throw new Error(`no such customer: ${id}`);
  const updated = { ...customer, name };
  repo.put(updated);
  return updated;
}

export function deactivateCustomer(repo, id) {
  const customer = repo.get(id);
  if (!customer) throw new Error(`no such customer: ${id}`);
  repo.put({ ...customer, active: false });
}

export function removeCustomer(repo, id) {
  return repo.delete(id);
}
