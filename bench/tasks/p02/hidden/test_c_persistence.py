import copy
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from warehouse import JsonFileStore, MemoryStore, StateError, Store, StoreError, Warehouse  # noqa: E402

LEGACY_STATE = {
    "products": [{"sku": "A1", "name": "Anvil", "price_cents": 2000, "category": "tools", "stock": 7}],
    "customers": [{"id": "C1", "name": "Ada", "tier": "gold", "region": "CA"}],
    "orders": [
        {"id": 3, "customer_id": "C1", "date": "2025-02-01", "coupon": None, "status": "shipped",
         "lines": [{"sku": "A1", "qty": 2, "unit_cents": 2000}], "gross_cents": 4000,
         "bulk_discount_cents": 0, "tier_discount_cents": 400, "coupon_discount_cents": 0,
         "shipping_cents": 799, "tax_cents": 297, "total_cents": 4696},
        {"id": 5, "customer_id": "C1", "date": "2025-02-03", "coupon": "FREESHIP", "status": "cancelled",
         "lines": [{"sku": "A1", "qty": 1, "unit_cents": 2000}], "gross_cents": 2000,
         "bulk_discount_cents": 0, "tier_discount_cents": 200, "coupon_discount_cents": 0,
         "shipping_cents": 0, "tax_cents": 149, "total_cents": 1949},
    ],
}


def populate(wh):
    wh.add_product("B2", "Bolt", 150, "hardware", 100)
    wh.add_product("A1", "Anvil", 2000, "tools", 10)
    wh.add_customer("C2", "Bob")
    wh.add_customer("C1", "Ada", "gold", "ca")
    wh.place_order("C1", [("A1", 2), ("B2", 10)], "2025-03-02", "save10")
    wh.place_order("C2", [("B2", 1)], "2025-03-03")
    wh.ship_order(1)
    wh.cancel_order(2)
    return wh


class InterfaceTest(unittest.TestCase):
    def test_module_and_exports(self):
        import warehouse
        import warehouse.store
        self.assertIs(warehouse.store.Store, Store)
        self.assertIs(warehouse.store.MemoryStore, MemoryStore)
        self.assertIs(warehouse.store.JsonFileStore, JsonFileStore)
        self.assertIs(warehouse.Store, Store)

    def test_store_is_abstract(self):
        with self.assertRaises(TypeError):
            Store()
        self.assertIsInstance(MemoryStore(), Store)
        self.assertIsInstance(JsonFileStore("x.json"), Store)
        self.assertEqual(Store.__abstractmethods__, frozenset({"load", "save"}))

    def test_default_store_is_memory(self):
        self.assertIsInstance(Warehouse().store, MemoryStore)
        store = MemoryStore()
        self.assertIs(Warehouse(store).store, store)


class MemoryStoreTest(unittest.TestCase):
    def test_empty_loads_none(self):
        self.assertIsNone(MemoryStore().load())

    def test_copies_both_ways(self):
        state = {"a": [1, 2]}
        store = MemoryStore(state)
        state["a"].append(3)
        self.assertEqual(store.load(), {"a": [1, 2]})
        loaded = store.load()
        loaded["a"].append(9)
        self.assertEqual(store.load(), {"a": [1, 2]})
        store.save(state)
        state["a"].append(4)
        self.assertEqual(store.load(), {"a": [1, 2, 3]})


class JsonFileStoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "shop.json")

    def test_missing_file_loads_none(self):
        self.assertIsNone(JsonFileStore(self.path).load())
        self.assertFalse(os.path.exists(self.path))

    def test_invalid_files(self):
        for text in ("", "{not json", "[1, 2]", "42", '"x"'):
            with open(self.path, "w") as fh:
                fh.write(text)
            with self.assertRaises(StoreError) as ctx:
                JsonFileStore(self.path).load()
            self.assertEqual(str(ctx.exception), "invalid data file: " + self.path)
            with self.assertRaises(StoreError):
                Warehouse(JsonFileStore(self.path))

    def test_exact_file_format(self):
        state = {"z": 1, "a": {"y": [1, 2], "b": "é"}}
        JsonFileStore(self.path).save(state)
        with open(self.path, "rb") as fh:
            raw = fh.read()
        self.assertEqual(raw, (json.dumps(state, indent=2, sort_keys=True) + "\n").encode("utf-8"))
        self.assertEqual(JsonFileStore(self.path).load(), state)

    def test_accepts_path_objects(self):
        import pathlib
        store = JsonFileStore(pathlib.Path(self.path))
        store.save({"a": 1})
        self.assertEqual(store.load(), {"a": 1})

    def test_creates_parent_folders_and_leaves_no_temp_files(self):
        nested = os.path.join(self.dir, "deep", "er", "shop.json")
        store = JsonFileStore(nested)
        store.save({"a": 1})
        store.save({"a": 2})
        self.assertEqual(os.listdir(os.path.dirname(nested)), ["shop.json"])
        self.assertEqual(store.load(), {"a": 2})

    def test_save_replaces_an_existing_file(self):
        store = JsonFileStore(self.path)
        store.save({"a": 1, "b": 2})
        store.save({"c": 3})
        self.assertEqual(store.load(), {"c": 3})


class WarehouseStateTest(unittest.TestCase):
    def test_snapshot_shape(self):
        snap = populate(Warehouse()).snapshot()
        self.assertEqual(sorted(snap), ["customers", "next_order_id", "orders", "products", "version"])
        self.assertEqual(snap["version"], 1)
        self.assertEqual(snap["next_order_id"], 3)
        self.assertEqual([p["sku"] for p in snap["products"]], ["A1", "B2"])
        self.assertEqual([c["id"] for c in snap["customers"]], ["C1", "C2"])
        self.assertEqual([o["id"] for o in snap["orders"]], [1, 2])
        self.assertEqual(snap["customers"][0], {"id": "C1", "name": "Ada", "tier": "gold", "region": "CA"})
        self.assertEqual(snap["orders"][0]["status"], "shipped")
        self.assertEqual(snap["orders"][0]["lines"][1], {"sku": "B2", "qty": 10, "unit_cents": 150})

    def test_snapshot_shares_nothing(self):
        wh = populate(Warehouse())
        snap = wh.snapshot()
        snap["products"][0]["stock"] = 999
        snap["orders"][0]["lines"].clear()
        snap["orders"].clear()
        self.assertEqual(wh.get_product("A1").stock, 8)
        self.assertEqual(len(wh.snapshot()["orders"]), 2)
        self.assertEqual(len(wh.get_order(1).lines), 2)

    def test_mutations_do_not_save_by_themselves(self):
        store = MemoryStore()
        wh = Warehouse(store)
        wh.add_product("A1", "Anvil", 1, "c")
        self.assertIsNone(store.load())
        wh.save()
        self.assertEqual(len(store.load()["products"]), 1)
        wh.add_product("B2", "Bolt", 1, "c")
        self.assertEqual(len(store.load()["products"]), 1)

    def test_state_is_read_once_at_construction(self):
        store = MemoryStore(copy.deepcopy(LEGACY_STATE))
        wh = Warehouse(store)
        store.save({})
        self.assertEqual([p.sku for p in wh.products()], ["A1"])

    def test_round_trip_through_both_stores(self):
        with tempfile.TemporaryDirectory() as d:
            for store in (MemoryStore(), JsonFileStore(os.path.join(d, "x", "shop.json"))):
                wh = populate(Warehouse(store))
                wh.save()
                again = Warehouse(store)
                self.assertEqual(again.snapshot(), wh.snapshot())
                self.assertEqual(again.products(), wh.products())
                self.assertEqual(again.orders(), wh.orders())
                self.assertEqual(again.get_customer("C1"), wh.get_customer("C1"))
                for report in ("stock_report", "sales_report"):
                    self.assertEqual(getattr(again, report)(), getattr(wh, report)())
                self.assertEqual(again.statement("C1"), wh.statement("C1"))
                self.assertEqual(again.place_order("C2", [("B2", 1)], "2025-04-01").id, 3)
                with self.assertRaises(StateError):
                    again.cancel_order(1)
                self.assertEqual(again.cancel_order(3).status, "cancelled")
                self.assertEqual(again.get_product("B2").stock, 90)

    def test_stores_behave_identically(self):
        with tempfile.TemporaryDirectory() as d:
            mem = populate(Warehouse(MemoryStore()))
            disk = populate(Warehouse(JsonFileStore(os.path.join(d, "shop.json"))))
            self.assertEqual(mem.snapshot(), disk.snapshot())
            self.assertEqual(mem.sales_report(), disk.sales_report())

    def test_ids_are_never_reused_after_a_round_trip(self):
        store = MemoryStore()
        wh = populate(Warehouse(store))
        wh.save()
        again = Warehouse(store)
        self.assertEqual(again.place_order("C2", [("B2", 1)], "2025-04-01").id, 3)
        self.assertEqual([o.id for o in again.orders()], [1, 2, 3])

    def test_loads_the_old_file_format(self):
        wh = Warehouse(MemoryStore(copy.deepcopy(LEGACY_STATE)))
        self.assertEqual(wh.get_product("A1").stock, 7)
        self.assertEqual(wh.get_customer("C1").tier, "gold")
        self.assertEqual([o.id for o in wh.orders()], [3, 5])
        self.assertEqual(wh.get_order(5).coupon, "FREESHIP")
        self.assertEqual(wh.get_order(3).lines[0].qty, 2)
        self.assertEqual(wh.place_order("C1", [("A1", 1)], "2025-02-10").id, 6)
        self.assertEqual(wh.snapshot()["version"], 1)

    def test_missing_next_order_id_without_orders(self):
        state = {"products": copy.deepcopy(LEGACY_STATE["products"]),
                 "customers": copy.deepcopy(LEGACY_STATE["customers"])}
        wh = Warehouse(MemoryStore(state))
        self.assertEqual(wh.place_order("C1", [("A1", 1)], "2025-02-10").id, 1)

    def test_explicit_next_order_id_wins(self):
        state = copy.deepcopy(LEGACY_STATE)
        state["next_order_id"] = 40
        wh = Warehouse(MemoryStore(state))
        self.assertEqual(wh.place_order("C1", [("A1", 1)], "2025-02-10").id, 40)

    def test_old_file_on_disk(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "shop.json")
            with open(path, "w") as fh:
                json.dump(LEGACY_STATE, fh, indent=2)
            wh = Warehouse(JsonFileStore(path))
            self.assertEqual(wh.sales_report().split("\n")[:3],
                             ["Orders: 2 (placed 0, shipped 1, cancelled 1)", "Revenue: 46.96",
                              "Tax collected: 2.97"])


if __name__ == "__main__":
    unittest.main()
