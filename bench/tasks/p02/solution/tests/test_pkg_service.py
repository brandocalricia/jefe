"""Tests for the warehouse object and its stores."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import json
import tempfile

from warehouse import (JsonFileStore, MemoryStore, NotFoundError, StateError, StockError,  # noqa: E402
                       Warehouse)


def stocked(store=None):
    wh = Warehouse(store)
    wh.add_product("A1", "Anvil", 2000, "tools", 10)
    wh.add_customer("C1", "Ada", "gold", "ca")
    return wh


class WarehouseTest(unittest.TestCase):
    def test_instances_are_independent(self):
        stocked()
        self.assertEqual(Warehouse().products(), [])

    def test_failed_order_changes_nothing(self):
        wh = stocked()
        with self.assertRaises(StockError):
            wh.place_order("C1", [("A1", 11)], "2025-01-01")
        self.assertEqual(wh.get_product("A1").stock, 10)
        self.assertEqual(wh.place_order("C1", [("A1", 1)], "2025-01-01").id, 1)

    def test_cancel_restocks_and_ship_blocks_cancel(self):
        wh = stocked()
        wh.place_order("C1", [("A1", 4)], "2025-01-01")
        wh.place_order("C1", [("A1", 1)], "2025-01-02")
        wh.cancel_order(1)
        wh.ship_order(2)
        self.assertEqual(wh.get_product("A1").stock, 9)
        with self.assertRaises(StateError):
            wh.cancel_order(2)
        with self.assertRaises(NotFoundError):
            wh.get_order(3)

    def test_low_stock_order(self):
        wh = stocked()
        wh.add_product("B2", "Bolt", 100, "hw", 2)
        self.assertEqual([p.sku for p in wh.low_stock(10)], ["B2", "A1"])


class StoreTest(unittest.TestCase):
    def test_round_trip_both_stores(self):
        with tempfile.TemporaryDirectory() as d:
            for store in (MemoryStore(), JsonFileStore(os.path.join(d, "sub", "shop.json"))):
                wh = stocked(store)
                wh.place_order("C1", [("A1", 2)], "2025-01-01", "save10")
                wh.save()
                again = Warehouse(store)
                self.assertEqual(again.snapshot(), wh.snapshot())
                self.assertEqual(again.stock_report(), wh.stock_report())
                self.assertEqual(again.place_order("C1", [("A1", 1)], "2025-01-02").id, 2)

    def test_file_format(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "shop.json")
            wh = stocked(JsonFileStore(path))
            wh.save()
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), json.dumps(wh.snapshot(), indent=2, sort_keys=True) + "\n")
            self.assertEqual(os.listdir(d), ["shop.json"])


if __name__ == "__main__":
    unittest.main()
