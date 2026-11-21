import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from csvline import split_line  # noqa: E402
from table import read_rows  # noqa: E402


class HiddenSplitLine(unittest.TestCase):
    def test_comma_inside_quotes(self):
        self.assertEqual(split_line('a,"b,c",d'), ["a", "b,c", "d"])
        self.assertEqual(split_line('"x,y,z"'), ["x,y,z"])
        self.assertEqual(split_line('1,"a, b, c"'), ["1", "a, b, c"])

    def test_doubled_quote_is_a_literal_quote(self):
        self.assertEqual(split_line('"say ""hi""",2'), ['say "hi"', "2"])
        self.assertEqual(split_line('""""'), ['"'])

    def test_empty_quoted_field(self):
        self.assertEqual(split_line('a,"",b'), ["a", "", "b"])
        self.assertEqual(split_line('""'), [""])

    def test_empty_and_trailing_fields(self):
        self.assertEqual(split_line(""), [""])
        self.assertEqual(split_line("a,b,"), ["a", "b", ""])
        self.assertEqual(split_line(",a"), ["", "a"])
        self.assertEqual(split_line(","), ["", ""])

    def test_custom_delimiter(self):
        self.assertEqual(split_line('a;"b;c";d', ";"), ["a", "b;c", "d"])
        self.assertEqual(split_line("a,b;c", ";"), ["a,b", "c"])

    def test_whitespace_is_kept(self):
        self.assertEqual(split_line(" a , b "), [" a ", " b "])
        self.assertEqual(split_line('"a b", c'), ["a b", " c"])

    def test_unicode(self):
        self.assertEqual(split_line('é,"ü,ñ",日本'), ["é", "ü,ñ", "日本"])


class HiddenReadRows(unittest.TestCase):
    def test_quoted_values_in_rows(self):
        text = 'id,name,city\n1,"Smith, Jane","Austin, TX"\n2,Bob,Dallas\n'
        self.assertEqual(
            read_rows(text),
            [
                {"id": "1", "name": "Smith, Jane", "city": "Austin, TX"},
                {"id": "2", "name": "Bob", "city": "Dallas"},
            ],
        )

    def test_error_line_number_still_counts_from_header(self):
        with self.assertRaisesRegex(ValueError, r"^line 3:"):
            read_rows('a,b\n1,"x,y"\n"only,one"\n')


if __name__ == "__main__":
    unittest.main()
