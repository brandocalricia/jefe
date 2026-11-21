export function shipOrder(stores, orderId, carrier) {
  const order = stores.orders.findById(orderId);
  if (!order) throw new Error(`no such order: ${orderId}`);
  if (order.status !== 'placed') throw new Error(`order ${orderId} is not ready to ship`);
  const shipment = { id: `sh-${orderId}`, orderId, carrier };
  stores.shipments.insert(shipment);
  stores.orders.update({ ...order, status: 'shipped' });
  return shipment;
}

export function pendingShipments(stores) {
  return stores.orders.findAll({ status: 'placed' }).map((o) => o.id);
}
