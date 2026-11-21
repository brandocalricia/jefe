"""Tests for the pricing rules."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from warehouse import ValidationError, Warehouse, price_order  # noqa: E402
from warehouse.pricing import half_up  # noqa: E402


class PricingTest(unittest.TestCase):
    def test_half_up(self):
        self.assertEqual(half_up(5, 10), 1)
        self.assertEqual(half_up(4, 10), 0)
        self.assertEqual(half_up(25, 10), 3)

    def test_plain_basket(self):
        p = price_order([(2000, 1)])
        self.assertEqual((p.gross_cents, p.shipping_cents, p.tax_cents, p.total_cents),
                         (2000, 799, 100, 2899))

    def test_bulk_tier_and_free_shipping(self):
        p = price_order([(600, 10)], "gold", "CA")
        self.assertEqual(p.to_dict(), {
            "gross_cents": 6000, "bulk_discount_cents": 300, "tier_discount_cents": 570,
            "coupon_discount_cents": 0, "shipping_cents": 0, "tax_cents": 423, "total_cents": 5553})

    def test_tax_ties_round_up(self):
        self.assertEqual(price_order([(1010, 1)]).tax_cents, 51)

    def test_shipping_threshold_uses_discounted_amount(self):
        self.assertEqual(price_order([(5200, 1)], "gold").shipping_cents, 799)
        self.assertEqual(price_order([(5200, 1)]).shipping_cents, 0)

    def test_coupons(self):
        self.assertEqual(price_order([(1000, 1)], coupon=" save10 ").coupon_discount_cents, 100)
        self.assertEqual(price_order([(300, 1)], coupon="FLAT500").coupon_discount_cents, 300)
        self.assertEqual(price_order([(1000, 1)], coupon="freeship").shipping_cents, 0)
        with self.assertRaises(ValidationError):
            price_order([(1000, 1)], coupon="NOPE")

    def test_quote_matches_order(self):
        wh = Warehouse()
        wh.add_product("A1", "Anvil", 1010, "tools", 5)
        wh.add_customer("C1", "Ada")
        quote = wh.quote("C1", [("A1", 1)])
        order = wh.place_order("C1", [("A1", 1)], "2025-01-01")
        self.assertEqual(quote.total_cents, order.total_cents)


if __name__ == "__main__":
    unittest.main()
