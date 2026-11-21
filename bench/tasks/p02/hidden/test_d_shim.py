import contextlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import warnings

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
sys.path.insert(0, SRC)

import stockroom  # noqa: E402
from warehouse import JsonFileStore, WarehouseError  # noqa: E402

PREFIX = "stockroom.%s() is deprecated; use the warehouse package instead"


@contextlib.contextmanager
def env(**values):
    old = {k: os.environ.get(k) for k in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def quiet(fn, *args, **kwargs):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        return fn(*args, **kwargs)


class WarningTest(unittest.TestCase):
    def setUp(self):
        quiet(stockroom.reset)

    def calls(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "s.json")
        return [
            ("reset", lambda: stockroom.reset()),
            ("parse_money", lambda: stockroom.parse_money("1.00")),
            ("parse_line_items", lambda: stockroom.parse_line_items("A1x1")),
            ("add_product", lambda: stockroom.add_product("A1", "Anvil", 2000, "tools", 5)),
            ("add_customer", lambda: stockroom.add_customer("C1", "Ada")),
            ("adjust_stock", lambda: stockroom.adjust_stock("A1", 1)),
            ("quote_order", lambda: stockroom.quote_order("C1", "A1x1")),
            ("place_order", lambda: stockroom.place_order("C1", "A1x1", date="2025-01-01")),
            ("ship_order", lambda: stockroom.ship_order(1)),
            ("stock_report", lambda: stockroom.stock_report()),
            ("sales_report", lambda: stockroom.sales_report()),
            ("customer_statement", lambda: stockroom.customer_statement("C1")),
            ("save", lambda: stockroom.save(path)),
            ("load", lambda: stockroom.load(path)),
        ]

    def test_every_function_warns_exactly_once_with_the_fixed_message(self):
        for name, call in self.calls():
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                call()
            self.assertEqual(len(caught), 1, name)
            self.assertIs(caught[0].category, DeprecationWarning, name)
            self.assertEqual(str(caught[0].message), PREFIX % name, name)
            self.assertEqual(os.path.realpath(caught[0].filename), os.path.realpath(__file__), name)

    def test_cancel_order_warns(self):
        quiet(stockroom.add_product, "A1", "Anvil", 2000, "tools", 5)
        quiet(stockroom.add_customer, "C1", "Ada")
        quiet(stockroom.place_order, "C1", "A1x1", date="2025-01-01")
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            stockroom.cancel_order(1)
        self.assertEqual([str(w.message) for w in caught], [PREFIX % "cancel_order"])

    def test_warning_points_at_the_caller(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            line = sys._getframe().f_lineno + 1
            stockroom.reset()
        self.assertEqual(os.path.realpath(caught[0].filename), os.path.realpath(__file__))
        self.assertEqual(caught[0].lineno, line)

    def test_warning_is_raised_as_error_when_asked(self):
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            with self.assertRaises(DeprecationWarning):
                stockroom.parse_money("1.00")

    def test_importing_does_not_warn(self):
        r = subprocess.run([sys.executable, "-W", "error", "-c", "import stockroom"],
                           capture_output=True, text=True, env=dict(os.environ, PYTHONPATH=SRC))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

    def test_failed_calls_still_warn_once(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            with self.assertRaises(ValueError):
                stockroom.parse_money("nope")
        self.assertEqual(len(caught), 1)

    def test_failed_calls_through_helpers_warn_once_at_the_caller(self):
        quiet(stockroom.add_customer, "C1", "Ada")
        failing = [
            ("place_order", lambda: stockroom.place_order("C1", "NOPEx1", date="2025-01-01")),
            ("quote_order", lambda: stockroom.quote_order("C9", "A1x1")),
            ("ship_order", lambda: stockroom.ship_order(4)),
            ("customer_statement", lambda: stockroom.customer_statement("C9")),
            ("load", lambda: self._load_bad()),
        ]
        for name, call in failing:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                with self.assertRaises(ValueError):
                    call()
            self.assertEqual([str(w.message) for w in caught], [PREFIX % name], name)
            self.assertEqual(os.path.realpath(caught[0].filename), os.path.realpath(__file__), name)

    def _load_bad(self):
        path = os.path.join(tempfile.mkdtemp(), "bad.json")
        with open(path, "w") as fh:
            fh.write("{oops")
        return stockroom.load(path)


class ShimShapeTest(unittest.TestCase):
    def test_removed_names_and_thin_module(self):
        for name in ("PRODUCTS", "CUSTOMERS", "ORDERS", "NEXT_ORDER_ID", "import_products", "get_order",
                     "low_stock_skus", "pricing_block", "fmt_money", "reprice_order", "parse_products_csv"):
            self.assertFalse(hasattr(stockroom, name), name)
        with open(stockroom.__file__, encoding="utf-8") as fh:
            self.assertLess(len(fh.read().splitlines()), 150)
        for name in ("reset", "parse_money", "parse_line_items", "add_product", "add_customer", "adjust_stock",
                     "place_order", "quote_order", "ship_order", "cancel_order", "stock_report", "sales_report",
                     "customer_statement", "save", "load"):
            self.assertTrue(callable(getattr(stockroom, name)), name)


class ShimBehaviourTest(unittest.TestCase):
    def setUp(self):
        quiet(stockroom.reset)
        quiet(stockroom.add_product, "HAM-16", "Claw hammer", 1899, "tools", 14)
        quiet(stockroom.add_product, "GLV-L", "Gloves", 720, "safety", 60)
        quiet(stockroom.add_product, "SAW", "Saw", 2450, "tools", 6)
        quiet(stockroom.add_product, "T1", "Tie breaker", 1010, "tools", 5)
        quiet(stockroom.add_product, "P1", "Pricey", 5200, "tools", 5)
        quiet(stockroom.add_customer, "C1", "Ada Lovelace", "gold", "CA")
        quiet(stockroom.add_customer, "C2", "Bob")

    def test_return_values(self):
        self.assertEqual(quiet(stockroom.parse_money, "$12.50"), 1250)
        self.assertEqual(quiet(stockroom.parse_line_items, "A1x2,B2x1,A1x3"), [("A1", 5), ("B2", 1)])
        self.assertEqual(quiet(stockroom.add_product, "NEW", " New ", 100, "c"),
                         {"sku": "NEW", "name": "New", "price_cents": 100, "category": "c", "stock": 0})
        self.assertEqual(quiet(stockroom.add_customer, "C3", "Cy", "silver", "ny"),
                         {"id": "C3", "name": "Cy", "tier": "silver", "region": "NY"})
        self.assertEqual(quiet(stockroom.adjust_stock, "SAW", -2), 4)

    def test_legacy_order_dicts(self):
        q = quiet(stockroom.quote_order, "C1", "HAM-16x2,GLV-Lx10", "SAVE10")
        self.assertEqual(q, {"gross_cents": 10998, "bulk_discount_cents": 360, "tier_discount_cents": 1064,
                             "coupon_discount_cents": 957, "shipping_cents": 0, "tax_cents": 711,
                             "total_cents": 9328})
        o = quiet(stockroom.place_order, "C1", "HAM-16x2,GLV-Lx10", "save10", "2025-03-02")
        self.assertEqual(o, {
            "id": 1, "customer_id": "C1", "date": "2025-03-02", "coupon": "SAVE10", "status": "placed",
            "lines": [{"sku": "HAM-16", "qty": 2, "unit_cents": 1899}, {"sku": "GLV-L", "qty": 10, "unit_cents": 720}],
            "gross_cents": 10998, "bulk_discount_cents": 360, "tier_discount_cents": 1064,
            "coupon_discount_cents": 957, "shipping_cents": 0, "tax_cents": 711, "total_cents": 9328})
        o2 = quiet(stockroom.place_order, "C2", "SAWx2,HAM-16x1,SAWx1", None, "2025-03-03")
        self.assertEqual(o2["lines"], [{"sku": "SAW", "qty": 3, "unit_cents": 2450},
                                       {"sku": "HAM-16", "qty": 1, "unit_cents": 1899}])
        self.assertEqual((o2["id"], o2["coupon"], o2["tax_cents"], o2["total_cents"]), (2, None, 462, 9711))
        self.assertEqual(quiet(stockroom.ship_order, 1)["status"], "shipped")
        self.assertEqual(quiet(stockroom.cancel_order, 2)["status"], "cancelled")

    def test_reports_match_the_old_output(self):
        quiet(stockroom.place_order, "C1", "HAM-16x2,GLV-Lx10", "save10", "2025-03-02")
        quiet(stockroom.place_order, "C2", "SAWx2,HAM-16x1,SAWx1", None, "2025-03-03")
        self.assertEqual(quiet(stockroom.stock_report), "\n".join([
            "SKU      NAME                 CATEGORY   STOCK     PRICE",
            "GLV-L    Gloves               safety        50      7.20",
            "HAM-16   Claw hammer          tools         11     18.99",
            "P1       Pricey               tools          5     52.00",
            "SAW      Saw                  tools          3     24.50",
            "T1       Tie breaker          tools          5     10.10",
            "Total units: 74, value: 952.89",
        ]))
        self.assertEqual(quiet(stockroom.sales_report), "\n".join([
            "Orders: 2 (placed 2, shipped 0, cancelled 0)", "Revenue: 190.39", "Tax collected: 11.73",
            "Units sold:", "  GLV-L       10", "  HAM-16       3", "  SAW          3"]))
        self.assertEqual(quiet(stockroom.customer_statement, "C1"),
                         "Statement for C1 (Ada Lovelace)\n#1   2025-03-02  placed         93.28\nBalance due: 93.28")

    def test_corrected_pricing_comes_through_the_shim(self):
        q = quiet(stockroom.quote_order, "C2", "T1x1")
        self.assertEqual(q["tax_cents"], 51)
        o = quiet(stockroom.place_order, "C2", "T1x1", None, "2025-03-01")
        self.assertEqual(q["total_cents"], o["total_cents"])
        o = quiet(stockroom.place_order, "C1", "P1x1", None, "2025-03-01")
        self.assertEqual((o["shipping_cents"], o["total_cents"]), (799, 5865))
        self.assertIn("#2   2025-03-01  placed         58.65", quiet(stockroom.customer_statement, "C1"))

    def test_default_date(self):
        with env(WH_TODAY="2031-07-04"):
            self.assertEqual(quiet(stockroom.place_order, "C2", "SAWx1")["date"], "2031-07-04")
            self.assertEqual(quiet(stockroom.place_order, "C2", "SAWx1", date="2020-01-02")["date"], "2020-01-02")
        with env(WH_TODAY=""):
            import datetime
            got = quiet(stockroom.place_order, "C2", "SAWx1")["date"]
            self.assertRegex(got, r"^\d{4}-\d{2}-\d{2}$")
            datetime.date.fromisoformat(got)

    def test_errors_are_value_errors_with_the_old_messages(self):
        cases = [
            (stockroom.place_order, ("C2", "SAWx9"), "insufficient stock for SAW: have 6, need 9"),
            (stockroom.place_order, ("C9", "SAWx1"), "unknown customer: C9"),
            (stockroom.place_order, ("C2", "SAWx1", "nope"), "unknown coupon: NOPE"),
            (stockroom.place_order, ("C2", "SAWx1", None, "yesterday"), "bad date: 'yesterday'"),
            (stockroom.ship_order, (4,), "unknown order: 4"),
            (stockroom.add_product, ("HAM-16", "x", 1, "c"), "duplicate sku: HAM-16"),
            (stockroom.parse_line_items, ("",), "no items"),
        ]
        for fn, args, expected in cases:
            with self.assertRaises(ValueError) as ctx:
                quiet(fn, *args)
            self.assertIsInstance(ctx.exception, WarehouseError)
            self.assertEqual(str(ctx.exception), expected)

    def test_reset_starts_over(self):
        quiet(stockroom.place_order, "C2", "SAWx1", None, "2025-03-01")
        quiet(stockroom.reset)
        self.assertEqual(quiet(stockroom.stock_report).split("\n")[-1], "Total units: 0, value: 0.00")
        quiet(stockroom.add_product, "A1", "Anvil", 100, "c", 1)
        quiet(stockroom.add_customer, "C1", "Ada")
        self.assertEqual(quiet(stockroom.place_order, "C1", "A1x1", None, "2025-03-01")["id"], 1)

    def test_save_and_load(self):
        quiet(stockroom.place_order, "C1", "HAM-16x2", None, "2025-03-02")
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "sub", "s.json")
            self.assertIsNone(quiet(stockroom.save, path))
            data = JsonFileStore(path).load()
            self.assertEqual(data["version"], 1)
            self.assertEqual(data["next_order_id"], 2)
            before = quiet(stockroom.sales_report)
            quiet(stockroom.reset)
            self.assertIsNone(quiet(stockroom.load, path))
            self.assertEqual(quiet(stockroom.sales_report), before)
            self.assertEqual(quiet(stockroom.place_order, "C1", "SAWx1", None, "2025-03-05")["id"], 2)
            self.assertIsNone(quiet(stockroom.load, os.path.join(d, "missing.json")))
            self.assertEqual(quiet(stockroom.stock_report).split("\n")[-1], "Total units: 0, value: 0.00")
            with open(path, "w") as fh:
                fh.write("{oops")
            with self.assertRaises(ValueError) as ctx:
                quiet(stockroom.load, path)
            self.assertEqual(str(ctx.exception), "invalid data file: " + path)

    def test_old_data_file_still_loads(self):
        old = {"products": [{"sku": "A1", "name": "Anvil", "price_cents": 2000, "category": "tools", "stock": 3}],
               "customers": [{"id": "C1", "name": "Ada", "tier": "standard", "region": "OTHER"}],
               "orders": [], "next_order_id": 1}
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "old.json")
            with open(path, "w") as fh:
                json.dump(old, fh)
            quiet(stockroom.load, path)
            self.assertEqual(quiet(stockroom.place_order, "C1", "A1x3", None, "2025-01-01")["total_cents"], 2000 * 3 + 0 + 300)


if __name__ == "__main__":
    unittest.main()
