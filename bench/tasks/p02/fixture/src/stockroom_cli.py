#!/usr/bin/env python3
"""Command line front end for stockroom.

    stockroom_cli.py [--data FILE] COMMAND [ARGS...]

The data file defaults to warehouse.json in the current folder.  Commands that
change something save the file when they succeed; the others never write.
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import stockroom  # noqa: E402

USAGE = """usage: stockroom_cli.py [--data FILE] COMMAND [ARGS...]
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
  statement CUSTOMER"""

MUTATING = ["add-product", "add-customer", "import-products", "stock", "order", "ship", "cancel"]


def usage_error(msg):
    sys.stderr.write("usage error: %s\n%s\n" % (msg, USAGE))
    return 2


def fail(msg):
    sys.stderr.write("error: %s\n" % msg)
    return 1


def need(args, low, high):
    return low <= len(args) <= high


def run(argv):
    data_file = "warehouse.json"
    args = list(argv)
    if len(args) >= 2 and args[0] == "--data":
        data_file = args[1]
        args = args[2:]
    if not args:
        return usage_error("no command")
    cmd = args[0]
    rest = args[1:]
    known = MUTATING + ["quote", "report", "statement"]
    if cmd not in known:
        return usage_error("unknown command: %s" % cmd)

    # every command loads the file first
    try:
        stockroom.load(data_file)
    except ValueError as e:
        return fail(str(e))

    try:
        if cmd == "add-product":
            if not need(rest, 4, 5):
                return usage_error("add-product takes 4 or 5 arguments")
            price = stockroom.parse_money(rest[2])
            stock = 0
            if len(rest) == 5:
                if not re.fullmatch(r"[0-9]+", rest[4]):
                    return fail("bad stock: %r" % rest[4])
                stock = int(rest[4])
            stockroom.add_product(rest[0], rest[1], price, rest[3], stock)
            print("added product %s" % rest[0])
        elif cmd == "add-customer":
            if not need(rest, 2, 4):
                return usage_error("add-customer takes 2 to 4 arguments")
            tier = rest[2] if len(rest) > 2 else "standard"
            region = rest[3] if len(rest) > 3 else "OTHER"
            stockroom.add_customer(rest[0], rest[1], tier, region)
            print("added customer %s" % rest[0])
        elif cmd == "import-products":
            if not need(rest, 1, 1):
                return usage_error("import-products takes 1 argument")
            try:
                with open(rest[0], encoding="utf-8") as fh:
                    text = fh.read()
            except OSError:
                return fail("cannot read %s" % rest[0])
            n = stockroom.import_products(text)
            print("imported %d products" % n)
        elif cmd == "stock":
            if not need(rest, 2, 2):
                return usage_error("stock takes 2 arguments")
            if not re.fullmatch(r"[+-]?[0-9]+", rest[1]):
                return fail("bad delta: %r" % rest[1])
            n = stockroom.adjust_stock(rest[0], int(rest[1]))
            print("%s stock: %d" % (rest[0], n))
        elif cmd == "quote":
            if not need(rest, 2, 3):
                return usage_error("quote takes 2 or 3 arguments")
            coupon = rest[2] if len(rest) > 2 else None
            q = stockroom.quote_order(rest[0], rest[1], coupon)
            print(stockroom.pricing_block(q))
        elif cmd == "order":
            if not need(rest, 2, 3):
                return usage_error("order takes 2 or 3 arguments")
            coupon = rest[2] if len(rest) > 2 else None
            o = stockroom.place_order(rest[0], rest[1], coupon)
            print("order %d placed" % o["id"])
            print(stockroom.pricing_block(o))
        elif cmd == "ship":
            if not need(rest, 1, 1):
                return usage_error("ship takes 1 argument")
            if not re.fullmatch(r"[0-9]+", rest[0]):
                return fail("bad order id: %r" % rest[0])
            stockroom.ship_order(int(rest[0]))
            print("order %s shipped" % int(rest[0]))
        elif cmd == "cancel":
            if not need(rest, 1, 1):
                return usage_error("cancel takes 1 argument")
            if not re.fullmatch(r"[0-9]+", rest[0]):
                return fail("bad order id: %r" % rest[0])
            stockroom.cancel_order(int(rest[0]))
            print("order %s cancelled" % int(rest[0]))
        elif cmd == "report":
            if not need(rest, 1, 1) or rest[0] not in ("stock", "sales"):
                return usage_error("report takes stock or sales")
            if rest[0] == "stock":
                print(stockroom.stock_report())
            else:
                print(stockroom.sales_report())
        elif cmd == "statement":
            if not need(rest, 1, 1):
                return usage_error("statement takes 1 argument")
            print(stockroom.customer_statement(rest[0]))
    except ValueError as e:
        return fail(str(e))

    if cmd in MUTATING:
        stockroom.save(data_file)
    return 0


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
