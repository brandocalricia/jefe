import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepo, createStores } from '../src/repo.mjs';
import { addCustomer, renameCustomer, deactivateCustomer, removeCustomer } from '../src/customers.mjs';
import { addProduct, setPrice, listProducts, discontinue } from '../src/products.mjs';
import { setStock, getStock, adjustStock, lowStock } from '../src/stock.mjs';
import { placeOrder, cancelOrder } from '../src/orders.mjs';
import { shipOrder, pendingShipments } from '../src/shipping.mjs';
import { invoiceOrder, markPaid, unpaidInvoices } from '../src/billing.mjs';
import { queueReceipt, pendingMessages } from '../src/notifications.mjs';
import { ordersByStatus, revenueCents, customerSummary } from '../src/reports.mjs';
import { purgeCancelled, purgeInactiveCustomers } from '../src/cleanup.mjs';

// A repository that implements ONLY the new interface and fails loudly on anything else.
function strictRepo() {
  const rows = new Map();
  const api = {
    get: (id) => (rows.has(id) ? structuredClone(rows.get(id)) : null),
    list: (filter = {}) => [...rows.values()].filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)).map((r) => structuredClone(r)),
    put(record) {
      const isNew = !rows.has(record.id);
      rows.set(record.id, structuredClone(record));
      return isNew;
    },
    delete: (id) => rows.delete(id),
  };
  return new Proxy(api, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop in target) return target[prop];
      throw new Error(`repository method ${String(prop)} is not part of the interface`);
    },
  });
}

function strictStores() {
  return Object.fromEntries(['customers', 'products', 'stock', 'orders', 'shipments', 'invoices', 'outbox'].map((k) => [k, strictRepo()]));
}

test('createRepo implements exactly the new interface', () => {
  const repo = createRepo();
  assert.deepEqual(Object.keys(repo).sort(), ['delete', 'get', 'list', 'put']);
  assert.equal(repo.get('x'), null);
  assert.equal(repo.put({ id: 'x', n: 1 }), true);
  assert.equal(repo.put({ id: 'x', n: 2 }), false);
  assert.deepEqual(repo.get('x'), { id: 'x', n: 2 });
  assert.equal(repo.delete('x'), true);
  assert.equal(repo.delete('x'), false);
  assert.equal(repo.get('x'), null);
});

test('createRepo list filters by equality in insertion order and returns copies', () => {
  const repo = createRepo();
  repo.put({ id: 'b', kind: 'k', n: 1 });
  repo.put({ id: 'a', kind: 'k', n: 2 });
  repo.put({ id: 'c', kind: 'z', n: 1 });
  assert.deepEqual(repo.list().map((r) => r.id), ['b', 'a', 'c']);
  assert.deepEqual(repo.list({ kind: 'k' }).map((r) => r.id), ['b', 'a']);
  assert.deepEqual(repo.list({ kind: 'k', n: 1 }).map((r) => r.id), ['b']);
  assert.deepEqual(repo.list({ kind: 'none' }), []);
  repo.list()[0].n = 999;
  repo.get('b').n = 999;
  assert.equal(repo.get('b').n, 1);
  repo.put({ id: 'b', kind: 'k', n: 5 }); // replacing keeps its place
  assert.deepEqual(repo.list().map((r) => r.id), ['b', 'a', 'c']);
});

function scenarios(name, makeStores) {
  const seed = () => {
    const s = makeStores();
    addCustomer(s.customers, { id: 'c1', name: 'Ann', email: 'ann@example.com' });
    addCustomer(s.customers, { id: 'c2', name: 'Bob' });
    addProduct(s.products, { id: 'p1', name: 'Widget', priceCents: 250 });
    addProduct(s.products, { id: 'p2', name: 'Gadget', priceCents: 1000 });
    setStock(s.stock, 'p1', 10);
    setStock(s.stock, 'p2', 2);
    return s;
  };
  const order = (s, id = 'o1', lines = [{ productId: 'p1', qty: 2 }], customerId = 'c1') => placeOrder(s, { id, customerId, lines });

  test(`${name}: customers`, () => {
    const s = makeStores();
    assert.deepEqual(addCustomer(s.customers, { id: 'c1', name: 'Ann' }), { id: 'c1', name: 'Ann', email: null, active: true });
    assert.throws(() => addCustomer(s.customers, { id: 'c1', name: 'Other' }), /^Error: duplicate id: c1$/);
    assert.equal(s.customers.get('c1').name, 'Ann');
    assert.throws(() => addCustomer(s.customers, { name: 'x' }), /^Error: customer needs id and name$/);
    assert.throws(() => addCustomer(s.customers, { id: 'x' }), /^Error: customer needs id and name$/);
    assert.deepEqual(renameCustomer(s.customers, 'c1', 'Anna'), { id: 'c1', name: 'Anna', email: null, active: true });
    assert.equal(s.customers.get('c1').name, 'Anna');
    assert.throws(() => renameCustomer(s.customers, 'zz', 'x'), /^Error: no such customer: zz$/);
    assert.equal(deactivateCustomer(s.customers, 'c1'), undefined);
    assert.equal(s.customers.get('c1').active, false);
    assert.throws(() => deactivateCustomer(s.customers, 'zz'), /^Error: no such customer: zz$/);
    assert.equal(removeCustomer(s.customers, 'c1'), true);
    assert.equal(removeCustomer(s.customers, 'c1'), false);
  });

  test(`${name}: products and stock`, () => {
    const s = seed();
    assert.throws(() => addProduct(s.products, { id: 'p1', name: 'Dup', priceCents: 1 }), /^Error: duplicate id: p1$/);
    for (const bad of [-1, 1.5, '3', undefined]) assert.throws(() => addProduct(s.products, { id: 'px', name: 'x', priceCents: bad }), /^Error: bad price$/);
    assert.equal(s.products.get('px'), null);
    assert.deepEqual(listProducts(s.products).map((p) => p.name), ['Gadget', 'Widget']);
    setPrice(s.products, 'p1', 300);
    assert.equal(s.products.get('p1').priceCents, 300);
    assert.throws(() => setPrice(s.products, 'p1', -5), /^Error: bad price$/);
    assert.throws(() => setPrice(s.products, 'zz', 5), /^Error: no such product: zz$/);
    assert.equal(discontinue(s.products, 'p2'), true);
    assert.equal(discontinue(s.products, 'p2'), false);

    assert.equal(getStock(s.stock, 'p1'), 10);
    assert.equal(getStock(s.stock, 'nope'), 0);
    setStock(s.stock, 'p1', 4);
    assert.equal(getStock(s.stock, 'p1'), 4);
    setStock(s.stock, 'p3', 0);
    adjustStock(s.stock, 'p1', -4);
    assert.equal(getStock(s.stock, 'p1'), 0);
    assert.throws(() => adjustStock(s.stock, 'p1', -1), /^Error: insufficient stock for p1$/);
    assert.throws(() => adjustStock(s.stock, 'zz', 1), /^Error: no stock record: zz$/);
    adjustStock(s.stock, 'p1', 7);
    assert.deepEqual(lowStock(s.stock, 2), ['p2', 'p3']);
    assert.deepEqual(lowStock(s.stock, 100), ['p1', 'p2', 'p3']);
  });

  test(`${name}: placing and cancelling orders`, () => {
    const s = seed();
    const o = order(s, 'o1', [{ productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1 }]);
    assert.deepEqual(o, { id: 'o1', customerId: 'c1', lines: [{ productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1 }], status: 'placed', totalCents: 1500 });
    assert.equal(getStock(s.stock, 'p1'), 8);
    assert.equal(getStock(s.stock, 'p2'), 1);
    assert.deepEqual(s.orders.get('o1'), o);

    assert.throws(() => order(s, 'o9', [{ productId: 'p1', qty: 1 }], 'zz'), /^Error: no such customer: zz$/);
    assert.throws(() => order(s, 'o9', []), /^Error: order has no lines$/);
    assert.throws(() => placeOrder(s, { id: 'o9', customerId: 'c1' }), /^Error: order has no lines$/);
    assert.throws(() => order(s, 'o9', [{ productId: 'zz', qty: 1 }]), /^Error: no such product: zz$/);
    assert.throws(() => order(s, 'o9', [{ productId: 'p1', qty: 1 }, { productId: 'p2', qty: 5 }]), /^Error: insufficient stock for p2$/);
    assert.equal(getStock(s.stock, 'p1'), 8, 'a failed order leaves stock alone');
    assert.equal(s.orders.get('o9'), null);

    assert.throws(() => order(s, 'o1', [{ productId: 'p1', qty: 1 }]), /^Error: duplicate id: o1$/);
    assert.equal(getStock(s.stock, 'p1'), 8, 'a duplicate order id must not touch stock');

    deactivateCustomer(s.customers, 'c2');
    assert.throws(() => order(s, 'o8', [{ productId: 'p1', qty: 1 }], 'c2'), /^Error: customer is inactive: c2$/);

    assert.equal(cancelOrder(s, 'o1'), undefined);
    assert.equal(s.orders.get('o1').status, 'cancelled');
    assert.equal(getStock(s.stock, 'p1'), 10);
    assert.equal(getStock(s.stock, 'p2'), 2);
    assert.throws(() => cancelOrder(s, 'o1'), /^Error: cannot cancel a cancelled order$/);
    assert.throws(() => cancelOrder(s, 'zz'), /^Error: no such order: zz$/);
  });

  test(`${name}: shipping`, () => {
    const s = seed();
    order(s, 'o1');
    order(s, 'o2', [{ productId: 'p1', qty: 1 }]);
    assert.deepEqual(pendingShipments(s), ['o1', 'o2']);
    assert.deepEqual(shipOrder(s, 'o1', 'ups'), { id: 'sh-o1', orderId: 'o1', carrier: 'ups' });
    assert.equal(s.orders.get('o1').status, 'shipped');
    assert.deepEqual(s.shipments.get('sh-o1'), { id: 'sh-o1', orderId: 'o1', carrier: 'ups' });
    assert.deepEqual(pendingShipments(s), ['o2']);
    assert.throws(() => shipOrder(s, 'o1', 'ups'), /^Error: order o1 is not ready to ship$/);
    assert.throws(() => shipOrder(s, 'zz', 'ups'), /^Error: no such order: zz$/);
    assert.throws(() => cancelOrder(s, 'o1'), /^Error: cannot cancel a shipped order$/);
    s.shipments.put({ id: 'sh-o2', orderId: 'o2', carrier: 'old' });
    assert.throws(() => shipOrder(s, 'o2', 'dhl'), /^Error: duplicate id: sh-o2$/);
    assert.equal(s.orders.get('o2').status, 'placed', 'a failed shipment must not change the order');
    assert.equal(s.shipments.get('sh-o2').carrier, 'old');
  });

  test(`${name}: billing`, () => {
    const s = seed();
    order(s, 'o1');
    const inv = invoiceOrder(s, 'o1');
    assert.deepEqual(inv, { id: 'inv-o1', orderId: 'o1', totalCents: 500, paid: false });
    assert.deepEqual(invoiceOrder(s, 'o1'), inv);
    assert.equal(s.invoices.list().length, 1);
    assert.throws(() => invoiceOrder(s, 'zz'), /^Error: no such order: zz$/);
    order(s, 'o2');
    invoiceOrder(s, 'o2');
    assert.deepEqual(unpaidInvoices(s), ['inv-o1', 'inv-o2']);
    assert.equal(markPaid(s, 'inv-o1'), undefined);
    assert.equal(s.invoices.get('inv-o1').paid, true);
    assert.deepEqual(unpaidInvoices(s), ['inv-o2']);
    assert.throws(() => markPaid(s, 'zz'), /^Error: no such invoice: zz$/);
    invoiceOrder(s, 'o1');
    assert.equal(s.invoices.get('inv-o1').paid, true, 'asking again must not reset a paid invoice');
  });

  test(`${name}: notifications`, () => {
    const s = seed();
    order(s, 'o1');
    order(s, 'o2', [{ productId: 'p1', qty: 1 }], 'c2');
    const msg = queueReceipt(s, 'o1');
    assert.deepEqual(msg, { id: 'msg-o1', to: 'ann@example.com', subject: 'Receipt for order o1' });
    assert.deepEqual(queueReceipt(s, 'o1'), msg);
    assert.equal(queueReceipt(s, 'o2'), null, 'no email, no receipt');
    assert.throws(() => queueReceipt(s, 'zz'), /^Error: no such order: zz$/);
    assert.deepEqual(pendingMessages(s), [msg]);
    removeCustomer(s.customers, 'c1');
    assert.deepEqual(queueReceipt(s, 'o1'), null, 'customer gone, nothing to send to');
  });

  test(`${name}: reports`, () => {
    const s = seed();
    order(s, 'o1');
    order(s, 'o2', [{ productId: 'p2', qty: 1 }]);
    order(s, 'o3', [{ productId: 'p1', qty: 1 }], 'c2');
    cancelOrder(s, 'o2');
    shipOrder(s, 'o3', 'ups');
    assert.deepEqual(ordersByStatus(s), { placed: 1, cancelled: 1, shipped: 1 });
    assert.equal(revenueCents(s), 750);
    assert.deepEqual(customerSummary(s, 'c1'), { name: 'Ann', orders: 2, spentCents: 500 });
    assert.deepEqual(customerSummary(s, 'c2'), { name: 'Bob', orders: 1, spentCents: 250 });
    assert.throws(() => customerSummary(s, 'zz'), /^Error: no such customer: zz$/);
    assert.deepEqual(ordersByStatus(makeStores()), {});
    assert.equal(revenueCents(makeStores()), 0);
  });

  test(`${name}: cleanup`, () => {
    const s = seed();
    addCustomer(s.customers, { id: 'c3', name: 'Cy' });
    addCustomer(s.customers, { id: 'c4', name: 'Di' });
    order(s, 'o1');
    order(s, 'o2');
    order(s, 'o3', [{ productId: 'p1', qty: 1 }], 'c2');
    cancelOrder(s, 'o1');
    cancelOrder(s, 'o2');
    assert.equal(purgeCancelled(s), 2);
    assert.equal(purgeCancelled(s), 0);
    assert.deepEqual(s.orders.list().map((o) => o.id), ['o3']);
    for (const id of ['c1', 'c2', 'c3']) deactivateCustomer(s.customers, id);
    assert.deepEqual(purgeInactiveCustomers(s), ['c1', 'c3']);
    assert.deepEqual(s.customers.list().map((c) => c.id), ['c2', 'c4']);
    assert.deepEqual(purgeInactiveCustomers(s), []);
  });
}

scenarios('strict repository', strictStores);
scenarios('createStores', createStores);
