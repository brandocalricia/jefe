export function purgeCancelled(stores) {
  let removed = 0;
  for (const order of stores.orders.list({ status: 'cancelled' })) {
    if (stores.orders.delete(order.id)) removed++;
  }
  return removed;
}

export function purgeInactiveCustomers(stores) {
  const removed = [];
  for (const customer of stores.customers.list({ active: false })) {
    if (stores.orders.list({ customerId: customer.id }).length === 0 && stores.customers.delete(customer.id)) removed.push(customer.id);
  }
  return removed;
}
