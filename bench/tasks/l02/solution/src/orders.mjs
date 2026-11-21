import { insertNew } from './repo.mjs';
import { adjustStock, getStock } from './stock.mjs';

// stores: { customers, products, stock, orders, ... }
export function placeOrder(stores, { id, customerId, lines }) {
  const customer = stores.customers.get(customerId);
  if (!customer) throw new Error(`no such customer: ${customerId}`);
  if (!customer.active) throw new Error(`customer is inactive: ${customerId}`);
  if (!lines || lines.length === 0) throw new Error('order has no lines');
  let totalCents = 0;
  for (const { productId, qty } of lines) {
    const product = stores.products.get(productId);
    if (!product) throw new Error(`no such product: ${productId}`);
    if (getStock(stores.stock, productId) < qty) throw new Error(`insufficient stock for ${productId}`);
    totalCents += product.priceCents * qty;
  }
  insertNew(stores.orders, { id, customerId, lines, status: 'placed', totalCents });
  for (const { productId, qty } of lines) adjustStock(stores.stock, productId, -qty);
  return stores.orders.get(id);
}

export function cancelOrder(stores, id) {
  const order = stores.orders.get(id);
  if (!order) throw new Error(`no such order: ${id}`);
  if (order.status !== 'placed') throw new Error(`cannot cancel a ${order.status} order`);
  for (const { productId, qty } of order.lines) adjustStock(stores.stock, productId, qty);
  stores.orders.put({ ...order, status: 'cancelled' });
}
