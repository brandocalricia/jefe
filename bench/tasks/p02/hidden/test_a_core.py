import dataclasses
import os
import subprocess
import sys
import unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
sys.path.insert(0, SRC)

import warehouse  # noqa: E402
from warehouse import (Customer, DuplicateError, NotFoundError, Order, OrderLine, Product,  # noqa: E402
                       StateError, StockError, StoreError, ValidationError, Warehouse,
                       WarehouseError, format_money, parse_items, parse_money,
                       parse_products_csv)

CSV_HEAD = "sku,name,price,category,stock\n"


def message(test, exc_type, fn, *args, **kwargs):
    with test.assertRaises(exc_type) as ctx:
        fn(*args, **kwargs)
    return str(ctx.exception)


class LayoutTest(unittest.TestCase):
    def test_modules_and_names(self):
        import importlib
        for name in ("errors", "money", "parsing", "models", "service"):
            importlib.import_module("warehouse." + name)
        from warehouse.money import parse_money as pm
        from warehouse.parsing import parse_items as pi
        from warehouse.service import Warehouse as W
        self.assertIs(W, Warehouse)
        self.assertIs(pm, parse_money)
        self.assertIs(pi, parse_items)

    def test_importing_is_silent(self):
        r = subprocess.run([sys.executable, "-W", "error", "-c", "import warehouse"],
                           capture_output=True, text=True, env=dict(os.environ, PYTHONPATH=SRC))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

    def test_no_module_level_shop_data(self):
        # a shop built by one object must be invisible to the next one
        a = Warehouse()
        a.add_product("A1", "Anvil", 100, "tools", 1)
        a.add_customer("C1", "Ada")
        a.place_order("C1", [("A1", 1)], "2025-01-01")
        b = Warehouse()
        self.assertEqual((b.products(), b.orders()), ([], []))
        b.add_product("A1", "Anvil", 100, "tools", 1)
        b.add_customer("C1", "Ada")
        self.assertEqual(b.place_order("C1", [("A1", 1)], "2025-01-01").id, 1)


class ErrorsTest(unittest.TestCase):
    def test_hierarchy(self):
        self.assertTrue(issubclass(WarehouseError, ValueError))
        for cls in (ValidationError, DuplicateError, NotFoundError, StockError, StateError, StoreError):
            self.assertTrue(issubclass(cls, WarehouseError))
            self.assertEqual(cls.__bases__, (WarehouseError,))
        self.assertEqual(str(ValidationError("bad name")), "bad name")


class MoneyTest(unittest.TestCase):
    def test_parse_money(self):
        self.assertEqual(parse_money("12.50"), 1250)
        self.assertEqual(parse_money("$3"), 300)
        self.assertEqual(parse_money("7.5"), 750)
        self.assertEqual(parse_money("  0.05 "), 5)
        self.assertEqual(parse_money("0"), 0)

    def test_parse_money_errors(self):
        for bad in ("", "abc", "-1", "1,000", ".5", "12.345", "1.", "$"):
            self.assertEqual(message(self, ValidationError, parse_money, bad), "bad money: %r" % bad)

    def test_format_money(self):
        self.assertEqual(format_money(1250), "12.50")
        self.assertEqual(format_money(5), "0.05")
        self.assertEqual(format_money(0), "0.00")
        self.assertEqual(format_money(-50), "-0.50")
        self.assertEqual(format_money(123456789), "1234567.89")


class ItemsTest(unittest.TestCase):
    def test_parse_items(self):
        self.assertEqual(parse_items("A1x2, B2x10"), [("A1", 2), ("B2", 10)])
        self.assertEqual(parse_items("BOX1x2"), [("BOX1", 2)])
        self.assertEqual(parse_items(" HAM-16x1 "), [("HAM-16", 1)])

    def test_repeats_are_added_in_first_position(self):
        self.assertEqual(parse_items("A1x2,B2x1,A1x3"), [("A1", 5), ("B2", 1)])
        self.assertEqual(parse_items("B2x1,A1x1,B2x1"), [("B2", 2), ("A1", 1)])

    def test_errors(self):
        self.assertEqual(message(self, ValidationError, parse_items, ""), "no items")
        self.assertEqual(message(self, ValidationError, parse_items, "   "), "no items")
        self.assertEqual(message(self, ValidationError, parse_items, None), "no items")
        self.assertEqual(message(self, ValidationError, parse_items, "A1x1,,B2x1"), "bad item: ''")
        self.assertEqual(message(self, ValidationError, parse_items, "a1x1"), "bad item: 'a1x1'")
        self.assertEqual(message(self, ValidationError, parse_items, "A1 x 1"), "bad item: 'A1 x 1'")
        self.assertEqual(message(self, ValidationError, parse_items, "A1"), "bad item: 'A1'")
        self.assertEqual(message(self, ValidationError, parse_items, "A1x0"), "bad quantity in 'A1x0'")


class CsvTest(unittest.TestCase):
    def test_rows(self):
        text = CSV_HEAD + "A1, Anvil ,20.00,tools,3\n\n B2,Bolt,1.5,hw,0\n"
        got = parse_products_csv(text)
        self.assertEqual(got, [Product("A1", "Anvil", 2000, "tools", 3), Product("B2", "Bolt", 150, "hw", 0)])

    def test_header_only_and_trailing_blank(self):
        self.assertEqual(parse_products_csv(CSV_HEAD), [])
        self.assertEqual(parse_products_csv("  " + CSV_HEAD.strip() + "  \n\n\n"), [])

    def test_errors(self):
        for text in ("", "sku,name\n", "name,sku,price,category,stock\n"):
            self.assertEqual(message(self, ValidationError, parse_products_csv, text), "bad header")
        self.assertEqual(message(self, ValidationError, parse_products_csv, CSV_HEAD + "A1,Anvil,2.00,tools\n"),
                         "bad row 2: expected 5 fields")
        self.assertEqual(message(self, ValidationError, parse_products_csv, CSV_HEAD + "\nA1,Anvil,x,tools,3\n"),
                         "bad row 3: bad price")
        self.assertEqual(message(self, ValidationError, parse_products_csv, CSV_HEAD + "A1,Anvil,2.00,tools,-3\n"),
                         "bad row 2: bad stock")
        self.assertEqual(message(self, ValidationError, parse_products_csv, CSV_HEAD + "A1,Anvil,2.00,tools,1.5\n"),
                         "bad row 2: bad stock")


class ModelsTest(unittest.TestCase):
    def test_frozen_and_dicts(self):
        p = Product("A1", "Anvil", 2000, "tools", 3)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            p.stock = 9
        self.assertEqual(p.to_dict(), {"sku": "A1", "name": "Anvil", "price_cents": 2000,
                                       "category": "tools", "stock": 3})
        c = Customer("C1", "Ada", "gold", "CA")
        self.assertEqual(c.to_dict(), {"id": "C1", "name": "Ada", "tier": "gold", "region": "CA"})
        self.assertEqual(OrderLine("A1", 2, 2000).to_dict(), {"sku": "A1", "qty": 2, "unit_cents": 2000})

    def test_returned_objects_cannot_alter_the_warehouse(self):
        wh = Warehouse()
        p = wh.add_product("A1", "Anvil", 2000, "tools", 3)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            p.stock = 99
        self.assertEqual(wh.get_product("A1").stock, 3)


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.wh = Warehouse()

    def test_add_and_get_product(self):
        p = self.wh.add_product("A1", "  Anvil ", 2000, " tools ", 3)
        self.assertEqual(p, Product("A1", "Anvil", 2000, "tools", 3))
        self.assertEqual(self.wh.get_product("A1"), p)
        self.assertEqual(self.wh.add_product("B2", "Bolt", 0, "hw").stock, 0)

    def test_products_sorted_by_sku(self):
        for sku in ("C3", "A1", "B2"):
            self.wh.add_product(sku, "n", 1, "c")
        self.assertEqual([p.sku for p in self.wh.products()], ["A1", "B2", "C3"])

    def test_product_validation_messages(self):
        add = self.wh.add_product
        self.assertEqual(message(self, ValidationError, add, "a1", "n", 1, "c"), "bad sku: 'a1'")
        self.assertEqual(message(self, ValidationError, add, "-A", "n", 1, "c"), "bad sku: '-A'")
        self.assertEqual(message(self, ValidationError, add, "A1", "  ", 1, "c"), "bad name")
        self.assertEqual(message(self, ValidationError, add, "A1", "n", -5, "c"), "bad price: -5")
        self.assertEqual(message(self, ValidationError, add, "A1", "n", True, "c"), "bad price: True")
        self.assertEqual(message(self, ValidationError, add, "A1", "n", 1.5, "c"), "bad price: 1.5")
        self.assertEqual(message(self, ValidationError, add, "A1", "n", 1, ""), "bad category")
        self.assertEqual(message(self, ValidationError, add, "A1", "n", 1, "c", -1), "bad stock: -1")
        self.assertEqual(self.wh.products(), [])

    def test_duplicate_and_unknown_product(self):
        self.wh.add_product("A1", "n", 1, "c")
        self.assertEqual(message(self, DuplicateError, self.wh.add_product, "A1", "m", 2, "d"), "duplicate sku: A1")
        self.assertEqual(self.wh.get_product("A1").name, "n")
        self.assertEqual(message(self, NotFoundError, self.wh.get_product, "Z9"), "unknown sku: Z9")

    def test_customers(self):
        c = self.wh.add_customer("C1", " Ada ", "gold", " ca ")
        self.assertEqual(c, Customer("C1", "Ada", "gold", "CA"))
        self.assertEqual(self.wh.add_customer("c_2-x", "Bob"), Customer("c_2-x", "Bob", "standard", "OTHER"))
        self.assertEqual(self.wh.get_customer("C1"), c)

    def test_customer_validation_messages(self):
        add = self.wh.add_customer
        self.assertEqual(message(self, ValidationError, add, "C 1", "n"), "bad customer id: 'C 1'")
        self.assertEqual(message(self, ValidationError, add, "", "n"), "bad customer id: ''")
        self.assertEqual(message(self, ValidationError, add, "C1", " "), "bad name")
        self.assertEqual(message(self, ValidationError, add, "C1", "n", "platinum"), "bad tier: 'platinum'")
        self.assertEqual(message(self, ValidationError, add, "C1", "n", "gold", " "), "bad region: ' '")
        add("C1", "n")
        self.assertEqual(message(self, DuplicateError, add, "C1", "m"), "duplicate customer: C1")
        self.assertEqual(message(self, NotFoundError, self.wh.get_customer, "C9"), "unknown customer: C9")

    def test_adjust_stock(self):
        self.wh.add_product("A1", "n", 1, "c", 5)
        self.assertEqual(self.wh.adjust_stock("A1", 3), 8)
        self.assertEqual(self.wh.adjust_stock("A1", -8), 0)
        self.assertEqual(self.wh.adjust_stock("A1", 0), 0)
        self.assertEqual(message(self, StockError, self.wh.adjust_stock, "A1", -1),
                         "insufficient stock for A1: have 0, need 1")
        self.assertEqual(self.wh.get_product("A1").stock, 0)
        self.assertEqual(message(self, NotFoundError, self.wh.adjust_stock, "Z9", 1), "unknown sku: Z9")
        self.assertEqual(message(self, ValidationError, self.wh.adjust_stock, "A1", "3"), "bad delta: '3'")
        self.assertEqual(message(self, ValidationError, self.wh.adjust_stock, "A1", True), "bad delta: True")

    def test_low_stock(self):
        for sku, stock in (("C3", 5), ("A1", 5), ("B2", 0), ("D4", 6)):
            self.wh.add_product(sku, "n" + sku, 1, "c", stock)
        self.assertEqual([p.sku for p in self.wh.low_stock(5)], ["B2", "A1", "C3"])
        self.assertEqual([p.sku for p in self.wh.low_stock(0)], ["B2"])
        self.assertEqual([p.sku for p in self.wh.low_stock(99)], ["B2", "A1", "C3", "D4"])
        self.assertEqual(message(self, ValidationError, self.wh.low_stock, -1), "bad threshold: -1")
        self.assertEqual(message(self, ValidationError, self.wh.low_stock, "3"), "bad threshold: 3")

    def test_import_csv(self):
        self.assertEqual(self.wh.import_products_csv(CSV_HEAD + "A1,Anvil,20.00,tools,3\nB2,Bolt,1.5,hw,9\n"), 2)
        self.assertEqual(self.wh.get_product("B2"), Product("B2", "Bolt", 150, "hw", 9))
        self.assertEqual(self.wh.import_products_csv(CSV_HEAD), 0)

    def test_import_csv_is_all_or_nothing(self):
        self.wh.add_product("A1", "Anvil", 1, "c")
        text = CSV_HEAD + "B2,Bolt,1,hw,1\nA1,Again,1,hw,1\n"
        self.assertEqual(message(self, DuplicateError, self.wh.import_products_csv, text), "duplicate sku: A1")
        self.assertEqual(message(self, DuplicateError, self.wh.import_products_csv,
                                 CSV_HEAD + "C3,Cog,1,hw,1\nC3,Cog,1,hw,1\n"), "duplicate sku: C3")
        self.assertEqual(message(self, ValidationError, self.wh.import_products_csv,
                                 CSV_HEAD + "D4,Drill,1,hw,1\nbad sku,Drill,1,hw,1\n"), "bad sku: 'bad sku'")
        self.assertEqual(message(self, ValidationError, self.wh.import_products_csv,
                                 CSV_HEAD + "E5, ,1,hw,1\n"), "bad name")
        self.assertEqual(message(self, ValidationError, self.wh.import_products_csv,
                                 CSV_HEAD + "E5,Egg,1, ,1\n"), "bad category")
        self.assertEqual([p.sku for p in self.wh.products()], ["A1"])


if __name__ == "__main__":
    unittest.main()
