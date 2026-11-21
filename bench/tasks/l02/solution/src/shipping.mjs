import { insertNew } from './repo.mjs';

export function shipOrder(stores, orderId, carrier) {
  const order = stores.orders.get(orderId);
  if (!order) throw new Error(`no such order: ${orderId}`);
  if (order.status !== 'placed') throw new Error(`order ${orderId} is not ready to ship`);
  const shipment = { id: `sh-${orderId}`, orderId, carrier };
  insertNew(stores.shipments, shipment);
  stores.orders.put({ ...order, status: 'shipped' });
  return shipment;
}

export function pendingShipments(stores) {
  return stores.orders.list({ status: 'placed' }).map((o) => o.id);
}
