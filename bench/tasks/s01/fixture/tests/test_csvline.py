import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from csvline import split_line  # noqa: E402
from table import read_rows  # noqa: E402


class SplitLineTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(split_line("a,b,c"), ["a", "b", "c"])

    def test_empty_middle_field(self):
        self.assertEqual(split_line("a,,c"), ["a", "", "c"])

    def test_quoted_field_with_comma(self):
        self.assertEqual(split_line('name,"Smith, Jane",42'), ["name", "Smith, Jane", "42"])


class ReadRowsTest(unittest.TestCase):
    def test_rows(self):
        text = "id,name\n1,Ann\n2,Bob\n"
        self.assertEqual(read_rows(text), [{"id": "1", "name": "Ann"}, {"id": "2", "name": "Bob"}])

    def test_wrong_field_count(self):
        with self.assertRaises(ValueError):
            read_rows("a,b\n1\n")


if __name__ == "__main__":
    unittest.main()
