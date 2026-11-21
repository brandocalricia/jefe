export function purgeCancelled(stores) {
  let removed = 0;
  for (const order of stores.orders.findAll({ status: 'cancelled' })) {
    if (stores.orders.remove(order.id)) removed++;
  }
  return removed;
}

export function purgeInactiveCustomers(stores) {
  const removed = [];
  for (const customer of stores.customers.findAll({ active: false })) {
    if (stores.orders.findAll({ customerId: customer.id }).length === 0 && stores.customers.remove(customer.id)) removed.push(customer.id);
  }
  return removed;
}
