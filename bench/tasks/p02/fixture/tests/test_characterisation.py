"""Characterisation tests for the old stockroom module.

They pin down behaviour that must not change while the code is reorganised.
They only use the documented functions and the command line script.
"""

import os
import subprocess
import sys
import tempfile
import unittest
import warnings

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "src")
sys.path.insert(0, SRC)

import stockroom  # noqa: E402

warnings.simplefilter("ignore", DeprecationWarning)


class MoneyAndItemsTest(unittest.TestCase):
    def test_parse_money(self):
        self.assertEqual(stockroom.parse_money("12.50"), 1250)
        self.assertEqual(stockroom.parse_money("$3"), 300)
        self.assertEqual(stockroom.parse_money("7.5"), 750)

    def test_parse_money_rejects_garbage(self):
        with self.assertRaises(ValueError):
            stockroom.parse_money("twelve")

    def test_parse_line_items_adds_up_repeats(self):
        self.assertEqual(stockroom.parse_line_items("A1x2, B2x1,A1x3"), [("A1", 5), ("B2", 1)])


class OrderFlowTest(unittest.TestCase):
    def setUp(self):
        stockroom.reset()
        stockroom.add_product("A1", "Anvil", 2000, "tools", 10)
        stockroom.add_product("B2", "Bolt", 150, "hardware", 100)
        stockroom.add_customer("C1", "Ada", "gold", "CA")
        stockroom.add_customer("C2", "Bob")

    def test_place_order_prices_a_simple_basket(self):
        o = stockroom.place_order("C2", "A1x1", date="2025-03-01")
        self.assertEqual(o["id"], 1)
        self.assertEqual(o["status"], "placed")
        self.assertEqual(o["gross_cents"], 2000)
        self.assertEqual(o["shipping_cents"], 799)
        self.assertEqual(o["tax_cents"], 100)
        self.assertEqual(o["total_cents"], 2899)

    def test_stock_is_taken_and_restored(self):
        stockroom.place_order("C2", "A1x4", date="2025-03-01")
        self.assertEqual(stockroom.adjust_stock("A1", 0), 6)
        stockroom.cancel_order(1)
        self.assertEqual(stockroom.adjust_stock("A1", 0), 10)

    def test_out_of_stock_changes_nothing(self):
        with self.assertRaises(ValueError) as ctx:
            stockroom.place_order("C2", "B2x5,A1x11", date="2025-03-01")
        self.assertEqual(str(ctx.exception), "insufficient stock for A1: have 10, need 11")
        self.assertEqual(stockroom.adjust_stock("B2", 0), 100)

    def test_ship_then_cancel_is_refused(self):
        stockroom.place_order("C2", "A1x1", date="2025-03-01")
        stockroom.ship_order(1)
        with self.assertRaises(ValueError) as ctx:
            stockroom.cancel_order(1)
        self.assertEqual(str(ctx.exception), "order 1 is shipped, cannot cancel")

    def test_stock_report(self):
        self.assertEqual(stockroom.stock_report(), "\n".join([
            "SKU      NAME                 CATEGORY   STOCK     PRICE",
            "A1       Anvil                tools         10     20.00",
            "B2       Bolt                 hardware     100      1.50",
            "Total units: 110, value: 350.00",
        ]))


class CommandLineTest(unittest.TestCase):
    def run_cli(self, data, *args):
        env = dict(os.environ, WH_TODAY="2025-03-01")
        return subprocess.run(
            [sys.executable, os.path.join(SRC, "stockroom_cli.py"), "--data", data] + list(args),
            capture_output=True, text=True, env=env)

    def test_add_and_report(self):
        with tempfile.TemporaryDirectory() as d:
            data = os.path.join(d, "shop.json")
            r = self.run_cli(data, "add-product", "A1", "Anvil", "20.00", "tools", "3")
            self.assertEqual((r.returncode, r.stdout), (0, "added product A1\n"))
            r = self.run_cli(data, "report", "stock")
            self.assertEqual(r.returncode, 0)
            self.assertIn("A1       Anvil", r.stdout)

    def test_unknown_command_is_a_usage_error(self):
        with tempfile.TemporaryDirectory() as d:
            r = self.run_cli(os.path.join(d, "x.json"), "frobnicate")
            self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
