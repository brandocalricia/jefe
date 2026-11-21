import { insertNew } from './repo.mjs';

export function queueReceipt(stores, orderId) {
  const order = stores.orders.get(orderId);
  if (!order) throw new Error(`no such order: ${orderId}`);
  const customer = stores.customers.get(order.customerId);
  if (!customer || !customer.email) return null;
  const existing = stores.outbox.get(`msg-${orderId}`);
  if (existing) return existing;
  const message = { id: `msg-${orderId}`, to: customer.email, subject: `Receipt for order ${orderId}` };
  insertNew(stores.outbox, message);
  return message;
}

export function pendingMessages(stores) {
  return stores.outbox.list();
}
