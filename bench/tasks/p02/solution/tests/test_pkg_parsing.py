"""Tests for money and text parsing."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from warehouse import ValidationError, format_money, parse_items, parse_money, parse_products_csv  # noqa: E402


class MoneyTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_money("12.50"), 1250)
        self.assertEqual(parse_money(" $3 "), 300)
        self.assertEqual(parse_money("7.5"), 750)

    def test_parse_rejects(self):
        for bad in ("", "-1", ".5", "1,000", "12.345", "abc"):
            with self.assertRaises(ValidationError, msg=bad):
                parse_money(bad)

    def test_format(self):
        self.assertEqual(format_money(5), "0.05")
        self.assertEqual(format_money(-50), "-0.50")
        self.assertEqual(format_money(123456789), "1234567.89")


class ItemsTest(unittest.TestCase):
    def test_merge_keeps_first_position(self):
        self.assertEqual(parse_items("A1x2,B2x1,A1x3"), [("A1", 5), ("B2", 1)])

    def test_errors(self):
        for text, message in (("", "no items"), ("A1x1,,B2x1", "bad item: ''"),
                              ("A1x0", "bad quantity in 'A1x0'"), ("a1x1", "bad item: 'a1x1'")):
            with self.assertRaises(ValidationError) as ctx:
                parse_items(text)
            self.assertEqual(str(ctx.exception), message)


class CsvTest(unittest.TestCase):
    def test_rows(self):
        products = parse_products_csv("sku,name,price,category,stock\nA1, Anvil ,20.00,tools,3\n\nB2,Bolt,1.5,hw,0\n")
        self.assertEqual([p.sku for p in products], ["A1", "B2"])
        self.assertEqual(products[0].name, "Anvil")
        self.assertEqual(products[1].price_cents, 150)

    def test_errors(self):
        with self.assertRaises(ValidationError) as ctx:
            parse_products_csv("sku,name,price,category,stock\n\nA1,Anvil,x,tools,3\n")
        self.assertEqual(str(ctx.exception), "bad row 3: bad price")
        with self.assertRaises(ValidationError):
            parse_products_csv("")


if __name__ == "__main__":
    unittest.main()
