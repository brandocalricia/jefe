export function addCustomer(repo, { id, name, email }) {
  if (!id || !name) throw new Error('customer needs id and name');
  const customer = { id, name, email: email ?? null, active: true };
  repo.insert(customer);
  return customer;
}

export function renameCustomer(repo, id, name) {
  const customer = repo.findById(id);
  if (!customer) throw new Error(`no such customer: ${id}`);
  const updated = { ...customer, name };
  repo.update(updated);
  return updated;
}

export function deactivateCustomer(repo, id) {
  const customer = repo.findById(id);
  if (!customer) throw new Error(`no such customer: ${id}`);
  repo.update({ ...customer, active: false });
}

export function removeCustomer(repo, id) {
  return repo.remove(id);
}
