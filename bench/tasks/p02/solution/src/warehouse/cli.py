"""Command line interface: `python3 -m warehouse [--data FILE] COMMAND ...`."""

import datetime
import os
import re
import sys

from .errors import WarehouseError
from .money import parse_money
from .parsing import parse_items
from .reports import pricing_block
from .service import Warehouse
from .store import JsonFileStore

USAGE = """usage: [--data FILE] COMMAND [ARGS...]
commands:
  add-product SKU NAME PRICE CATEGORY [STOCK]
  add-customer ID NAME [TIER] [REGION]
  import-products FILE
  stock SKU DELTA
  quote CUSTOMER ITEMS [COUPON]
  order CUSTOMER ITEMS [COUPON]
  ship ORDER_ID
  cancel ORDER_ID
  report stock|sales
  statement CUSTOMER
  low-stock THRESHOLD"""

# command -> (min args, max args, changes data)
COMMANDS = {
    "add-product": (4, 5, True),
    "add-customer": (2, 4, True),
    "import-products": (1, 1, True),
    "stock": (2, 2, True),
    "quote": (2, 3, False),
    "order": (2, 3, True),
    "ship": (1, 1, True),
    "cancel": (1, 1, True),
    "report": (1, 1, False),
    "statement": (1, 1, False),
    "low-stock": (1, 1, False),
}


class _ArgError(WarehouseError):
    pass


def _digits(text, what, signed=False):
    pattern = r"[+-]?[0-9]+" if signed else r"[0-9]+"
    if re.fullmatch(pattern, text) is None:
        raise _ArgError("bad %s: %r" % (what, text))
    return int(text)


def _today():
    return os.environ.get("WH_TODAY") or datetime.date.today().isoformat()


def _run(wh, cmd, args, out):
    if cmd == "add-product":
        stock = _digits(args[4], "stock") if len(args) == 5 else 0
        wh.add_product(args[0], args[1], parse_money(args[2]), args[3], stock)
        out("added product %s" % args[0])
    elif cmd == "add-customer":
        wh.add_customer(*args)
        out("added customer %s" % args[0])
    elif cmd == "import-products":
        try:
            with open(args[0], encoding="utf-8") as fh:
                text = fh.read()
        except OSError:
            raise _ArgError("cannot read %s" % args[0]) from None
        out("imported %d products" % wh.import_products_csv(text))
    elif cmd == "stock":
        delta = _digits(args[1], "delta", signed=True)
        out("%s stock: %d" % (args[0], wh.adjust_stock(args[0], delta)))
    elif cmd == "quote":
        coupon = args[2] if len(args) > 2 else None
        out(pricing_block(wh.quote(args[0], parse_items(args[1]), coupon)))
    elif cmd == "order":
        coupon = args[2] if len(args) > 2 else None
        order = wh.place_order(args[0], parse_items(args[1]), _today(), coupon)
        out("order %d placed" % order.id)
        out(pricing_block(order))
    elif cmd == "ship":
        order_id = _digits(args[0], "order id")
        wh.ship_order(order_id)
        out("order %d shipped" % order_id)
    elif cmd == "cancel":
        order_id = _digits(args[0], "order id")
        wh.cancel_order(order_id)
        out("order %d cancelled" % order_id)
    elif cmd == "report":
        out(wh.stock_report() if args[0] == "stock" else wh.sales_report())
    elif cmd == "statement":
        out(wh.statement(args[0]))
    elif cmd == "low-stock":
        threshold = _digits(args[0], "threshold")
        found = wh.low_stock(threshold)
        if not found:
            out("no products at or below %d" % threshold)
        else:
            out("low stock (<= %d):" % threshold)
            for p in found:
                out("%-8s %5d  %s" % (p.sku, p.stock, p.name))


def main(argv, stdout=None, stderr=None):
    stdout = stdout if stdout is not None else sys.stdout
    stderr = stderr if stderr is not None else sys.stderr
    args = list(argv)
    data_file = "warehouse.json"
    if len(args) >= 2 and args[0] == "--data":
        data_file, args = args[1], args[2:]

    def usage(message):
        stderr.write("usage error: %s\n%s\n" % (message, USAGE))
        return 2

    if not args:
        return usage("no command")
    cmd, rest = args[0], args[1:]
    if cmd not in COMMANDS:
        return usage("unknown command: %s" % cmd)
    low, high, mutates = COMMANDS[cmd]
    if not low <= len(rest) <= high or (cmd == "report" and rest[0] not in ("stock", "sales")):
        return usage("wrong arguments for %s" % cmd)

    lines = []
    try:
        wh = Warehouse(JsonFileStore(data_file))
        _run(wh, cmd, rest, lines.append)
        if mutates:
            wh.save()
    except WarehouseError as exc:
        stderr.write("error: %s\n" % exc)
        return 1
    for line in lines:
        stdout.write(line + "\n")
    return 0
