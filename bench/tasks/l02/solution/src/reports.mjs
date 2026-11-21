export function ordersByStatus(stores) {
  const counts = {};
  for (const order of stores.orders.list()) counts[order.status] = (counts[order.status] ?? 0) + 1;
  return counts;
}

export function revenueCents(stores) {
  return stores.orders.list().filter((o) => o.status !== 'cancelled').reduce((sum, o) => sum + o.totalCents, 0);
}

export function customerSummary(stores, customerId) {
  const customer = stores.customers.get(customerId);
  if (!customer) throw new Error(`no such customer: ${customerId}`);
  const orders = stores.orders.list({ customerId });
  return { name: customer.name, orders: orders.length, spentCents: orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.totalCents, 0) };
}
