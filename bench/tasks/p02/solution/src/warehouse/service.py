"""The Warehouse object: all shop state lives in an instance of this class."""

import dataclasses
import re

from . import reports
from .errors import (DuplicateError, NotFoundError, StateError, StockError,
                     ValidationError)
from .models import Customer, Order, OrderLine, Product
from .parsing import merge_items, parse_products_csv
from .pricing import normalise_coupon, price_order
from .store import MemoryStore

TIERS = ("standard", "silver", "gold")
SKU_RE = re.compile(r"[A-Z0-9][A-Z0-9-]*")
CUSTOMER_RE = re.compile(r"[A-Za-z0-9_-]+")
DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _blank(value):
    return not isinstance(value, str) or value.strip() == ""


def _check_product(sku, name, price_cents, category, stock):
    if not isinstance(sku, str) or SKU_RE.fullmatch(sku) is None:
        raise ValidationError("bad sku: %r" % (sku,))
    if _blank(name):
        raise ValidationError("bad name")
    if not _is_int(price_cents) or price_cents < 0:
        raise ValidationError("bad price: %s" % (price_cents,))
    if _blank(category):
        raise ValidationError("bad category")
    if not _is_int(stock) or stock < 0:
        raise ValidationError("bad stock: %s" % (stock,))


class Warehouse:
    def __init__(self, store=None):
        self.store = store if store is not None else MemoryStore()
        self._products = {}
        self._customers = {}
        self._orders = {}
        self._next_order_id = 1
        state = self.store.load()
        if state is not None:
            self._restore(state)

    # -- persistence ---------------------------------------------------

    def _restore(self, state):
        for p in state.get("products", []):
            self._products[p["sku"]] = Product(p["sku"], p["name"], p["price_cents"],
                                               p["category"], p["stock"])
        for c in state.get("customers", []):
            self._customers[c["id"]] = Customer(c["id"], c["name"], c["tier"], c["region"])
        for o in state.get("orders", []):
            self._orders[o["id"]] = Order.from_dict(o)
        nxt = state.get("next_order_id")
        if nxt is None:
            nxt = max(self._orders, default=0) + 1
        self._next_order_id = nxt

    def snapshot(self):
        return {
            "version": 1,
            "next_order_id": self._next_order_id,
            "products": [p.to_dict() for p in self.products()],
            "customers": [self._customers[k].to_dict() for k in sorted(self._customers)],
            "orders": [o.to_dict() for o in self.orders()],
        }

    def save(self):
        self.store.save(self.snapshot())

    # -- catalog -------------------------------------------------------

    def add_product(self, sku, name, price_cents, category, stock=0):
        _check_product(sku, name, price_cents, category, stock)
        if sku in self._products:
            raise DuplicateError("duplicate sku: %s" % sku)
        product = Product(sku, name.strip(), price_cents, category.strip(), stock)
        self._products[sku] = product
        return product

    def get_product(self, sku):
        try:
            return self._products[sku]
        except KeyError:
            raise NotFoundError("unknown sku: %s" % sku) from None

    def products(self):
        return [self._products[k] for k in sorted(self._products)]

    def import_products_csv(self, text):
        rows = parse_products_csv(text)
        seen = set()
        for r in rows:
            if SKU_RE.fullmatch(r.sku) is None:
                raise ValidationError("bad sku: %r" % (r.sku,))
            if r.sku in self._products or r.sku in seen:
                raise DuplicateError("duplicate sku: %s" % r.sku)
            if r.name == "":
                raise ValidationError("bad name")
            if r.category == "":
                raise ValidationError("bad category")
            seen.add(r.sku)
        for r in rows:
            self._products[r.sku] = r
        return len(rows)

    def add_customer(self, customer_id, name, tier="standard", region="OTHER"):
        if not isinstance(customer_id, str) or CUSTOMER_RE.fullmatch(customer_id) is None:
            raise ValidationError("bad customer id: %r" % (customer_id,))
        if _blank(name):
            raise ValidationError("bad name")
        if tier not in TIERS:
            raise ValidationError("bad tier: %r" % (tier,))
        if _blank(region):
            raise ValidationError("bad region: %r" % (region,))
        if customer_id in self._customers:
            raise DuplicateError("duplicate customer: %s" % customer_id)
        customer = Customer(customer_id, name.strip(), tier, region.strip().upper())
        self._customers[customer_id] = customer
        return customer

    def get_customer(self, customer_id):
        try:
            return self._customers[customer_id]
        except KeyError:
            raise NotFoundError("unknown customer: %s" % (customer_id,)) from None

    def adjust_stock(self, sku, delta):
        product = self.get_product(sku)
        if not _is_int(delta):
            raise ValidationError("bad delta: %r" % (delta,))
        new_stock = product.stock + delta
        if new_stock < 0:
            raise StockError("insufficient stock for %s: have %d, need %d"
                             % (sku, product.stock, -delta))
        self._products[sku] = dataclasses.replace(product, stock=new_stock)
        return new_stock

    def low_stock(self, threshold):
        if not _is_int(threshold) or threshold < 0:
            raise ValidationError("bad threshold: %s" % (threshold,))
        found = [p for p in self._products.values() if p.stock <= threshold]
        return sorted(found, key=lambda p: (p.stock, p.sku))

    # -- orders --------------------------------------------------------

    def _clean_items(self, items):
        pairs = []
        for sku, qty in items:
            if not _is_int(qty) or qty < 1:
                raise ValidationError("bad quantity in %r" % ("%sx%s" % (sku, qty),))
            pairs.append((sku, qty))
        if not pairs:
            raise ValidationError("no items")
        merged = merge_items(pairs)
        for sku, _ in merged:
            self.get_product(sku)
        return merged

    def _price(self, customer, items, coupon):
        lines = [(self._products[sku].price_cents, qty) for sku, qty in items]
        return price_order(lines, customer.tier, customer.region, coupon)

    def quote(self, customer_id, items, coupon=None):
        customer = self.get_customer(customer_id)
        merged = self._clean_items(items)
        normalise_coupon(coupon)
        return self._price(customer, merged, coupon)

    def place_order(self, customer_id, items, date, coupon=None):
        if not isinstance(date, str) or DATE_RE.fullmatch(date) is None:
            raise ValidationError("bad date: %r" % (date,))
        customer = self.get_customer(customer_id)
        merged = self._clean_items(items)
        coupon = normalise_coupon(coupon)
        for sku, qty in merged:
            have = self._products[sku].stock
            if have < qty:
                raise StockError("insufficient stock for %s: have %d, need %d" % (sku, have, qty))
        pricing = self._price(customer, merged, coupon)
        lines = tuple(OrderLine(sku, qty, self._products[sku].price_cents) for sku, qty in merged)
        for sku, qty in merged:
            self._products[sku] = dataclasses.replace(self._products[sku],
                                                      stock=self._products[sku].stock - qty)
        order = Order(self._next_order_id, customer_id, date, coupon, "placed", lines,
                      **pricing.to_dict())
        self._orders[order.id] = order
        self._next_order_id += 1
        return order

    def get_order(self, order_id):
        try:
            return self._orders[order_id]
        except KeyError:
            raise NotFoundError("unknown order: %s" % (order_id,)) from None

    def orders(self):
        return [self._orders[k] for k in sorted(self._orders)]

    def _change_status(self, order_id, verb, status):
        order = self.get_order(order_id)
        if order.status != "placed":
            raise StateError("order %s is %s, cannot %s" % (order_id, order.status, verb))
        updated = dataclasses.replace(order, status=status)
        self._orders[order_id] = updated
        return updated

    def ship_order(self, order_id):
        return self._change_status(order_id, "ship", "shipped")

    def cancel_order(self, order_id):
        order = self._change_status(order_id, "cancel", "cancelled")
        for line in order.lines:
            product = self._products[line.sku]
            self._products[line.sku] = dataclasses.replace(product, stock=product.stock + line.qty)
        return order

    # -- reports -------------------------------------------------------

    def stock_report(self):
        return reports.stock_report(self.products())

    def sales_report(self):
        return reports.sales_report(self.orders())

    def statement(self, customer_id):
        customer = self.get_customer(customer_id)
        mine = [o for o in self.orders() if o.customer_id == customer_id]
        return reports.statement(customer, mine)
