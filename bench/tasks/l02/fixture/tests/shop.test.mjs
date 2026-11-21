import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStores } from '../src/repo.mjs';
import { addCustomer } from '../src/customers.mjs';
import { addProduct } from '../src/products.mjs';
import { setStock, getStock } from '../src/stock.mjs';
import { placeOrder, cancelOrder } from '../src/orders.mjs';
import { shipOrder } from '../src/shipping.mjs';
import { invoiceOrder } from '../src/billing.mjs';
import { ordersByStatus, revenueCents } from '../src/reports.mjs';

function shop() {
  const s = createStores();
  addCustomer(s.customers, { id: 'c1', name: 'Ann', email: 'ann@example.com' });
  addProduct(s.products, { id: 'p1', name: 'Widget', priceCents: 250 });
  setStock(s.stock, 'p1', 10);
  return s;
}

test('placing, cancelling and shipping orders', () => {
  const s = shop();
  const order = placeOrder(s, { id: 'o1', customerId: 'c1', lines: [{ productId: 'p1', qty: 3 }] });
  assert.equal(order.totalCents, 750);
  assert.equal(getStock(s.stock, 'p1'), 7);
  cancelOrder(s, 'o1');
  assert.equal(getStock(s.stock, 'p1'), 10);
  placeOrder(s, { id: 'o2', customerId: 'c1', lines: [{ productId: 'p1', qty: 1 }] });
  shipOrder(s, 'o2', 'ups');
  assert.deepEqual(ordersByStatus(s), { cancelled: 1, shipped: 1 });
  assert.equal(revenueCents(s), 250);
});

test('invoices are idempotent', () => {
  const s = shop();
  placeOrder(s, { id: 'o1', customerId: 'c1', lines: [{ productId: 'p1', qty: 2 }] });
  assert.deepEqual(invoiceOrder(s, 'o1'), invoiceOrder(s, 'o1'));
});
