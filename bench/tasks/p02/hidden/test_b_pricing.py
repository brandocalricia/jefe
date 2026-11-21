import dataclasses
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from warehouse import (NotFoundError, Order, OrderLine, Pricing, StateError, StockError,  # noqa: E402
                       ValidationError, Warehouse, price_order)
from warehouse.pricing import half_up  # noqa: E402


def message(test, exc_type, fn, *args, **kwargs):
    with test.assertRaises(exc_type) as ctx:
        fn(*args, **kwargs)
    return str(ctx.exception)


def parts(p):
    return (p.gross_cents, p.bulk_discount_cents, p.tier_discount_cents, p.coupon_discount_cents,
            p.shipping_cents, p.tax_cents, p.total_cents)


class HalfUpTest(unittest.TestCase):
    def test_half_up(self):
        self.assertEqual(half_up(5, 10), 1)
        self.assertEqual(half_up(4, 10), 0)
        self.assertEqual(half_up(15, 10), 2)
        self.assertEqual(half_up(25, 10), 3)
        self.assertEqual(half_up(0, 7), 0)
        self.assertEqual(half_up(505000, 10000), 51)


class PriceOrderTest(unittest.TestCase):
    def test_plain_basket(self):
        self.assertEqual(parts(price_order([(2000, 1)])), (2000, 0, 0, 0, 799, 100, 2899))

    def test_pricing_object(self):
        p = price_order([(2000, 1)])
        self.assertIsInstance(p, Pricing)
        self.assertEqual(sorted(p.to_dict()), sorted(["gross_cents", "bulk_discount_cents", "tier_discount_cents",
                                                      "coupon_discount_cents", "shipping_cents", "tax_cents",
                                                      "total_cents"]))
        self.assertEqual(p.to_dict()["total_cents"], 2899)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            p.total_cents = 1

    def test_bulk_discount_steps(self):
        self.assertEqual(parts(price_order([(1000, 9)])), (9000, 0, 0, 0, 0, 450, 9450))
        self.assertEqual(parts(price_order([(1000, 10)])), (10000, 500, 0, 0, 0, 475, 9975))
        self.assertEqual(parts(price_order([(100, 49)])), (4900, 245, 0, 0, 799, 233, 5687))
        self.assertEqual(parts(price_order([(100, 50)])), (5000, 500, 0, 0, 799, 225, 5524))

    def test_bulk_rounds_per_line(self):
        self.assertEqual(price_order([(33, 10)]).bulk_discount_cents, 17)
        self.assertEqual(price_order([(33, 10), (33, 10)]).bulk_discount_cents, 34)
        self.assertEqual(price_order([(33, 5), (33, 5)]).bulk_discount_cents, 0)

    def test_tier_discount(self):
        self.assertEqual(parts(price_order([(1000, 1)], "silver")), (1000, 0, 50, 0, 799, 48, 1797))
        self.assertEqual(parts(price_order([(1000, 1)], "gold")), (1000, 0, 100, 0, 799, 45, 1744))
        self.assertEqual(price_order([(1010, 1)], "silver").tier_discount_cents, 51)
        self.assertEqual(price_order([(1000, 1)], "standard").tier_discount_cents, 0)

    def test_coupons(self):
        self.assertEqual(parts(price_order([(1000, 1)], coupon="SAVE10")), (1000, 0, 0, 100, 799, 45, 1744))
        self.assertEqual(parts(price_order([(1000, 1)], coupon="FLAT500")), (1000, 0, 0, 500, 799, 25, 1324))
        self.assertEqual(parts(price_order([(1000, 1)], coupon="FREESHIP")), (1000, 0, 0, 0, 0, 50, 1050))
        self.assertEqual(price_order([(1005, 1)], coupon="SAVE10").coupon_discount_cents, 101)

    def test_flat_coupon_never_exceeds_the_order(self):
        self.assertEqual(parts(price_order([(300, 1)], coupon="FLAT500")), (300, 0, 0, 300, 799, 0, 799))
        self.assertEqual(price_order([(500, 1)], coupon="FLAT500").coupon_discount_cents, 500)

    def test_coupon_names(self):
        self.assertEqual(price_order([(1000, 1)], coupon=" Save10 ").coupon_discount_cents, 100)
        self.assertEqual(price_order([(1000, 1)], coupon="freeship").shipping_cents, 0)
        for blank in (None, "", "   "):
            self.assertEqual(parts(price_order([(1000, 1)], coupon=blank)), (1000, 0, 0, 0, 799, 50, 1849))
        self.assertEqual(message(self, ValidationError, price_order, [(1000, 1)], coupon="bogus "),
                         "unknown coupon: BOGUS")

    def test_discounts_apply_in_order(self):
        # bulk, then tier, then coupon, each on what is left
        p = price_order([(1000, 10), (2000, 1)], "gold", "CA", "SAVE10")
        self.assertEqual(parts(p), (12000, 500, 1150, 1035, 0, 768, 10083))
        self.assertEqual(parts(price_order([(10000, 1)], "gold", "OTHER", "SAVE10")), (10000, 0, 1000, 900, 0, 405, 8505))

    def test_regions(self):
        for region, tax in (("CA", 825), ("ca", 825), ("ny", 800), ("TX", 625), ("OR", 0),
                            ("OTHER", 500), ("XX", 500)):
            self.assertEqual(price_order([(10000, 1)], region=region).tax_cents, tax, region)

    def test_shipping_threshold(self):
        self.assertEqual(price_order([(5000, 1)]).shipping_cents, 0)
        self.assertEqual(price_order([(4999, 1)]).shipping_cents, 799)

    def test_validation(self):
        self.assertEqual(message(self, ValidationError, price_order, []), "no items")
        self.assertEqual(message(self, ValidationError, price_order, [(100, 1)], "platinum"), "bad tier: 'platinum'")

    # the two documented disagreements of the old code: the spec's rule wins

    def test_tax_ties_round_half_up(self):
        self.assertEqual(parts(price_order([(1010, 1)])), (1010, 0, 0, 0, 799, 51, 1860))
        self.assertEqual(price_order([(3030, 1)]).tax_cents, 152)
        self.assertEqual(price_order([(10, 1)]).tax_cents, 1)

    def test_free_shipping_is_judged_after_discounts(self):
        self.assertEqual(parts(price_order([(5200, 1)], "gold")), (5200, 0, 520, 0, 799, 234, 5713))
        self.assertEqual(price_order([(5200, 1)], coupon="FLAT500").shipping_cents, 799)
        self.assertEqual(price_order([(5200, 1)], coupon="FLAT500").total_cents, 4700 + 799 + 235)
        self.assertEqual(price_order([(5200, 1)]).shipping_cents, 0)
        self.assertEqual(price_order([(5556, 1)], "gold").shipping_cents, 0)


def shop():
    wh = Warehouse()
    wh.add_product("A1", "Anvil", 2000, "tools", 10)
    wh.add_product("B2", "Bolt", 150, "hardware", 100)
    wh.add_product("P1", "Pricey thing", 5200, "tools", 5)
    wh.add_product("T1", "Tie breaker", 1010, "tools", 5)
    wh.add_customer("C1", "Ada Lovelace", "gold", "CA")
    wh.add_customer("C2", "Bob")
    return wh


class OrderTest(unittest.TestCase):
    def setUp(self):
        self.wh = shop()

    def test_place_order(self):
        o = self.wh.place_order("C2", [("A1", 1)], "2025-03-01")
        self.assertIsInstance(o, Order)
        self.assertEqual((o.id, o.customer_id, o.date, o.coupon, o.status), (1, "C2", "2025-03-01", None, "placed"))
        self.assertEqual(o.lines, (OrderLine("A1", 1, 2000),))
        self.assertEqual((o.gross_cents, o.shipping_cents, o.tax_cents, o.total_cents), (2000, 799, 100, 2899))
        self.assertEqual(self.wh.get_product("A1").stock, 9)
        self.assertEqual(self.wh.get_order(1), o)

    def test_order_to_dict(self):
        o = self.wh.place_order("C1", [("A1", 2), ("B2", 10)], "2025-03-02", " save10 ")
        d = o.to_dict()
        self.assertEqual(sorted(d), sorted([
            "id", "customer_id", "date", "coupon", "status", "lines", "gross_cents", "bulk_discount_cents",
            "tier_discount_cents", "coupon_discount_cents", "shipping_cents", "tax_cents", "total_cents"]))
        self.assertEqual(d["coupon"], "SAVE10")
        self.assertEqual(d["lines"], [{"sku": "A1", "qty": 2, "unit_cents": 2000},
                                      {"sku": "B2", "qty": 10, "unit_cents": 150}])
        self.assertEqual(d["gross_cents"], 5500)
        self.assertEqual(d["bulk_discount_cents"], 75)

    def test_ids_increase(self):
        ids = [self.wh.place_order("C2", [("B2", 1)], "2025-03-01").id for _ in range(3)]
        self.assertEqual(ids, [1, 2, 3])
        self.assertEqual([o.id for o in self.wh.orders()], [1, 2, 3])

    def test_repeated_skus_merge_in_first_position(self):
        o = self.wh.place_order("C2", [("B2", 1), ("A1", 1), ("B2", 2)], "2025-03-01")
        self.assertEqual([(l.sku, l.qty) for l in o.lines], [("B2", 3), ("A1", 1)])
        self.assertEqual(self.wh.get_product("B2").stock, 97)

    def test_quote_matches_the_charged_total(self):
        q = self.wh.quote("C2", [("T1", 1)])
        o = self.wh.place_order("C2", [("T1", 1)], "2025-03-01")
        self.assertEqual(q.tax_cents, 51)
        self.assertEqual(q.to_dict(), {k: getattr(o, k) for k in q.to_dict()})
        q = self.wh.quote("C1", [("A1", 3), ("B2", 12)], "FLAT500")
        o = self.wh.place_order("C1", [("A1", 3), ("B2", 12)], "2025-03-01", "FLAT500")
        self.assertEqual(q.to_dict(), {k: getattr(o, k) for k in q.to_dict()})

    def test_quote_changes_nothing_and_ignores_stock(self):
        q = self.wh.quote("C2", [("A1", 50)])
        self.assertEqual(q.gross_cents, 100000)
        self.assertEqual(self.wh.get_product("A1").stock, 10)
        self.assertEqual(self.wh.orders(), [])
        self.assertEqual(message(self, NotFoundError, self.wh.quote, "C9", [("A1", 1)]), "unknown customer: C9")
        self.assertEqual(message(self, NotFoundError, self.wh.quote, "C2", [("Z9", 1)]), "unknown sku: Z9")
        self.assertEqual(message(self, ValidationError, self.wh.quote, "C2", [("A1", 1)], "NOPE"), "unknown coupon: NOPE")
        self.assertEqual(message(self, ValidationError, self.wh.quote, "C2", []), "no items")

    def test_place_order_errors_in_order(self):
        place = self.wh.place_order
        self.assertEqual(message(self, ValidationError, place, "C9", [("A1", 1)], "2025-3-1"), "bad date: '2025-3-1'")
        self.assertEqual(message(self, ValidationError, place, "C2", [("A1", 1)], "20250301"), "bad date: '20250301'")
        self.assertEqual(message(self, NotFoundError, place, "C9", [("A1", 1)], "2025-03-01"), "unknown customer: C9")
        self.assertEqual(message(self, ValidationError, place, "C2", [], "2025-03-01"), "no items")
        self.assertEqual(message(self, ValidationError, place, "C2", [("A1", 0)], "2025-03-01"), "bad quantity in 'A1x0'")
        self.assertEqual(message(self, NotFoundError, place, "C2", [("A1", 1), ("Z9", 1)], "2025-03-01"), "unknown sku: Z9")
        self.assertEqual(message(self, ValidationError, place, "C2", [("A1", 1)], "2025-03-01", "nope"), "unknown coupon: NOPE")
        self.assertEqual(message(self, StockError, place, "C2", [("A1", 11), ("B2", 101)], "2025-03-01"),
                         "insufficient stock for A1: have 10, need 11")
        self.assertEqual(message(self, StockError, place, "C2", [("A1", 10), ("B2", 101)], "2025-03-01"),
                         "insufficient stock for B2: have 100, need 101")

    def test_failed_order_changes_nothing(self):
        with self.assertRaises(StockError):
            self.wh.place_order("C2", [("B2", 5), ("A1", 11)], "2025-03-01")
        self.assertEqual((self.wh.get_product("B2").stock, self.wh.get_product("A1").stock), (100, 10))
        self.assertEqual(self.wh.orders(), [])
        self.assertEqual(self.wh.place_order("C2", [("B2", 1)], "2025-03-01").id, 1)

    def test_selling_the_last_unit(self):
        self.wh.place_order("C2", [("P1", 5)], "2025-03-01")
        self.assertEqual(self.wh.get_product("P1").stock, 0)

    def test_ship_and_cancel(self):
        self.wh.place_order("C2", [("A1", 4)], "2025-03-01")
        self.wh.place_order("C2", [("A1", 1)], "2025-03-02")
        self.assertEqual(self.wh.ship_order(1).status, "shipped")
        self.assertEqual(self.wh.get_order(1).status, "shipped")
        c = self.wh.cancel_order(2)
        self.assertEqual(c.status, "cancelled")
        self.assertEqual(self.wh.get_product("A1").stock, 6)

    def test_cancel_puts_every_line_back(self):
        self.wh.place_order("C2", [("A1", 4), ("B2", 30)], "2025-03-01")
        self.wh.cancel_order(1)
        self.assertEqual((self.wh.get_product("A1").stock, self.wh.get_product("B2").stock), (10, 100))

    def test_state_errors(self):
        self.wh.place_order("C2", [("A1", 1)], "2025-03-01")
        self.wh.place_order("C2", [("A1", 1)], "2025-03-01")
        self.wh.ship_order(1)
        self.wh.cancel_order(2)
        self.assertEqual(message(self, StateError, self.wh.cancel_order, 1), "order 1 is shipped, cannot cancel")
        self.assertEqual(message(self, StateError, self.wh.ship_order, 1), "order 1 is shipped, cannot ship")
        self.assertEqual(message(self, StateError, self.wh.cancel_order, 2), "order 2 is cancelled, cannot cancel")
        self.assertEqual(message(self, StateError, self.wh.ship_order, 2), "order 2 is cancelled, cannot ship")
        self.assertEqual(self.wh.get_product("A1").stock, 9)

    def test_unknown_order(self):
        for fn in (self.wh.get_order, self.wh.ship_order, self.wh.cancel_order):
            self.assertEqual(message(self, NotFoundError, fn, 7), "unknown order: 7")


class ReportTest(unittest.TestCase):
    def test_empty_reports(self):
        wh = Warehouse()
        self.assertEqual(wh.stock_report(), "SKU      NAME                 CATEGORY   STOCK     PRICE\n"
                                            "Total units: 0, value: 0.00")
        self.assertEqual(wh.sales_report(), "Orders: 0 (placed 0, shipped 0, cancelled 0)\nRevenue: 0.00\n"
                                            "Tax collected: 0.00\nUnits sold:\n  (none)")

    def test_stock_report(self):
        wh = Warehouse()
        wh.add_product("B2", "Bolt", 150, "hardware", 100)
        wh.add_product("A1", "An extremely long product name", 2000, "outdoor-tools", 10)
        self.assertEqual(wh.stock_report(), "\n".join([
            "SKU      NAME                 CATEGORY   STOCK     PRICE",
            "A1       An extremely long pr outdoor-to    10     20.00",
            "B2       Bolt                 hardware     100      1.50",
            "Total units: 110, value: 350.00",
        ]))

    def test_sales_and_statement(self):
        wh = shop()
        wh.place_order("C1", [("A1", 2), ("B2", 10)], "2025-03-02", "save10")
        wh.place_order("C2", [("B2", 20)], "2025-03-03")
        wh.place_order("C2", [("A1", 1)], "2025-03-04")
        wh.place_order("C1", [("B2", 5), ("A1", 1)], "2025-03-05")
        wh.ship_order(1)
        wh.cancel_order(2)
        self.assertEqual(wh.sales_report(), "\n".join([
            "Orders: 4 (placed 2, shipped 1, cancelled 1)",
            "Revenue: 119.33",
            "Tax collected: 6.67",
            "Units sold:",
            "  B2          15",
            "  A1           4",
        ]))
        self.assertEqual(wh.statement("C1"), "\n".join([
            "Statement for C1 (Ada Lovelace)",
            "#1   2025-03-02  shipped        55.56",
            "#4   2025-03-05  placed         34.78",
            "Balance due: 90.34",
        ]))
        self.assertEqual(wh.statement("C2"), "\n".join([
            "Statement for C2 (Bob)",
            "#2   2025-03-03  cancelled      37.92",
            "#3   2025-03-04  placed         28.99",
            "Balance due: 28.99",
        ]))

    def test_statement_without_orders_and_unknown_customer(self):
        wh = shop()
        self.assertEqual(wh.statement("C2"), "Statement for C2 (Bob)\n(no orders)")
        self.assertEqual(message(self, NotFoundError, wh.statement, "C9"), "unknown customer: C9")

    def test_statement_shows_the_charged_total(self):
        wh = shop()
        o = wh.place_order("C1", [("P1", 1)], "2025-03-01")
        self.assertEqual(o.total_cents, 5865)
        self.assertEqual(o.shipping_cents, 799)
        self.assertEqual(wh.statement("C1"), "\n".join([
            "Statement for C1 (Ada Lovelace)",
            "#1   2025-03-01  placed         58.65",
            "Balance due: 58.65",
        ]))

    def test_many_orders_keep_columns(self):
        wh = shop()
        for _ in range(10):
            wh.place_order("C2", [("B2", 1)], "2025-03-01")
        rows = wh.statement("C2").split("\n")
        self.assertEqual(rows[10], "#10  2025-03-01  placed          9.57")


if __name__ == "__main__":
    unittest.main()
