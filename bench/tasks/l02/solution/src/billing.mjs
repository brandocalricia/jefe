import { insertNew } from './repo.mjs';

export function invoiceOrder(stores, orderId) {
  const order = stores.orders.get(orderId);
  if (!order) throw new Error(`no such order: ${orderId}`);
  const existing = stores.invoices.get(`inv-${orderId}`);
  if (existing) return existing;
  const invoice = { id: `inv-${orderId}`, orderId, totalCents: order.totalCents, paid: false };
  insertNew(stores.invoices, invoice);
  return invoice;
}

export function markPaid(stores, invoiceId) {
  const invoice = stores.invoices.get(invoiceId);
  if (!invoice) throw new Error(`no such invoice: ${invoiceId}`);
  stores.invoices.put({ ...invoice, paid: true });
}

export function unpaidInvoices(stores) {
  return stores.invoices.list({ paid: false }).map((i) => i.id);
}
