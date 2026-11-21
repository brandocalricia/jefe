export function invoiceOrder(stores, orderId) {
  const order = stores.orders.findById(orderId);
  if (!order) throw new Error(`no such order: ${orderId}`);
  const existing = stores.invoices.findById(`inv-${orderId}`);
  if (existing) return existing;
  const invoice = { id: `inv-${orderId}`, orderId, totalCents: order.totalCents, paid: false };
  stores.invoices.insert(invoice);
  return invoice;
}

export function markPaid(stores, invoiceId) {
  const invoice = stores.invoices.findById(invoiceId);
  if (!invoice) throw new Error(`no such invoice: ${invoiceId}`);
  stores.invoices.update({ ...invoice, paid: true });
}

export function unpaidInvoices(stores) {
  return stores.invoices.findAll({ paid: false }).map((i) => i.id);
}
