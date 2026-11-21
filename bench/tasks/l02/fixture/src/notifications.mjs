export function queueReceipt(stores, orderId) {
  const order = stores.orders.findById(orderId);
  if (!order) throw new Error(`no such order: ${orderId}`);
  const customer = stores.customers.findById(order.customerId);
  if (!customer || !customer.email) return null;
  const existing = stores.outbox.findById(`msg-${orderId}`);
  if (existing) return existing;
  const message = { id: `msg-${orderId}`, to: customer.email, subject: `Receipt for order ${orderId}` };
  stores.outbox.insert(message);
  return message;
}

export function pendingMessages(stores) {
  return stores.outbox.findAll();
}
