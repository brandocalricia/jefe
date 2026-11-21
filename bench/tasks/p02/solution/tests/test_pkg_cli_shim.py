"""Tests for the command line and the compatibility shim."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import io
import tempfile
import warnings

import stockroom  # noqa: E402
from warehouse.cli import main  # noqa: E402


class CliTest(unittest.TestCase):
    def run_main(self, data, *args):
        out, err = io.StringIO(), io.StringIO()
        os.environ["WH_TODAY"] = "2025-03-01"
        code = main(["--data", data] + list(args), out, err)
        return code, out.getvalue(), err.getvalue()

    def test_flow(self):
        with tempfile.TemporaryDirectory() as d:
            data = os.path.join(d, "shop.json")
            self.run_main(data, "add-product", "A1", "Anvil", "20.00", "tools", "3")
            self.run_main(data, "add-customer", "C1", "Ada")
            code, out, _ = self.run_main(data, "order", "C1", "A1x1")
            self.assertEqual(code, 0)
            self.assertTrue(out.startswith("order 1 placed\nSubtotal"))
            code, out, _ = self.run_main(data, "low-stock", "2")
            self.assertEqual(out, "low stock (<= 2):\nA1           2  Anvil\n")

    def test_errors_and_read_only_commands_do_not_write(self):
        with tempfile.TemporaryDirectory() as d:
            data = os.path.join(d, "shop.json")
            self.assertEqual(self.run_main(data, "report", "stock")[0], 0)
            self.assertFalse(os.path.exists(data))
            code, out, err = self.run_main(data, "stock", "A1", "1")
            self.assertEqual((code, out, err), (1, "", "error: unknown sku: A1\n"))
            self.assertEqual(self.run_main(data, "nope")[0], 2)


class ShimTest(unittest.TestCase):
    def test_warns_once_per_call(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            stockroom.reset()
            stockroom.add_product("A1", "Anvil", 2000, "tools", 5)
            stockroom.add_customer("C1", "Ada")
            stockroom.place_order("C1", "A1x1", date="2025-01-01")
        self.assertEqual(len(caught), 4)
        self.assertTrue(all(w.category is DeprecationWarning for w in caught))
        self.assertEqual(str(caught[0].message),
                         "stockroom.reset() is deprecated; use the warehouse package instead")
        self.assertEqual(caught[0].filename, __file__)


if __name__ == "__main__":
    unittest.main()
