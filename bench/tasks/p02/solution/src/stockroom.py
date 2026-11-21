"""Compatibility shim for the old single-module API.

Everything here forwards to the `warehouse` package and warns about it. The module keeps one
private default Warehouse because the old API had implicit global state.
"""

import datetime
import os
import warnings

from warehouse import JsonFileStore, Warehouse
from warehouse import parse_items as _parse_items
from warehouse import parse_money as _parse_money

_default = Warehouse()


def _deprecated(name):
    warnings.warn("stockroom.%s() is deprecated; use the warehouse package instead" % name,
                  DeprecationWarning, stacklevel=3)


def reset():
    global _default
    _deprecated("reset")
    _default = Warehouse()


def parse_money(text):
    _deprecated("parse_money")
    return _parse_money(text)


def parse_line_items(text):
    _deprecated("parse_line_items")
    return _parse_items(text)


def add_product(sku, name, price_cents, category, stock=0):
    _deprecated("add_product")
    return _default.add_product(sku, name, price_cents, category, stock).to_dict()


def add_customer(customer_id, name, tier="standard", region="OTHER"):
    _deprecated("add_customer")
    return _default.add_customer(customer_id, name, tier, region).to_dict()


def adjust_stock(sku, delta):
    _deprecated("adjust_stock")
    return _default.adjust_stock(sku, delta)


def place_order(customer_id, items_text, coupon=None, date=None):
    _deprecated("place_order")
    if date is None:
        date = os.environ.get("WH_TODAY") or datetime.date.today().isoformat()
    return _default.place_order(customer_id, _parse_items(items_text), date, coupon).to_dict()


def quote_order(customer_id, items_text, coupon=None):
    _deprecated("quote_order")
    return _default.quote(customer_id, _parse_items(items_text), coupon).to_dict()


def ship_order(order_id):
    _deprecated("ship_order")
    return _default.ship_order(order_id).to_dict()


def cancel_order(order_id):
    _deprecated("cancel_order")
    return _default.cancel_order(order_id).to_dict()


def stock_report():
    _deprecated("stock_report")
    return _default.stock_report()


def sales_report():
    _deprecated("sales_report")
    return _default.sales_report()


def customer_statement(customer_id):
    _deprecated("customer_statement")
    return _default.statement(customer_id)


def save(path):
    _deprecated("save")
    JsonFileStore(path).save(_default.snapshot())


def load(path):
    global _default
    _deprecated("load")
    _default = Warehouse(JsonFileStore(path))
