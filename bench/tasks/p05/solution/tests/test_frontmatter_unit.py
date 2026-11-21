import unittest

from pagewright import frontmatter
from pagewright.errors import ContentError


class FrontMatterUnitTest(unittest.TestCase):
    def test_scalars_and_lists(self):
        meta, body = frontmatter.parse('---\na: 1\nb: "x y"\nc: [p, q]\nd: false\ne: text\n---\nrest')
        self.assertEqual(meta, {"a": 1, "b": "x y", "c": ["p", "q"], "d": False, "e": "text"})
        self.assertEqual(body, "rest")

    def test_plain_text_has_no_meta(self):
        self.assertEqual(frontmatter.parse("just text"), ({}, "just text"))

    def test_error_lines(self):
        for text, message in [("---\nx\n---\n", 'front matter line 2: expected "key: value"'),
                              ("---\na: 1\na: 2\n---\n", 'front matter line 3: duplicate key "a"'),
                              ('---\na: "b\n---\n', "front matter line 2: invalid string"),
                              ("---\na: [b\n---\n", "front matter line 2: invalid list"),
                              ("---\na: 1\n", "front matter is not closed")]:
            with self.assertRaises(ContentError) as ctx:
                frontmatter.parse(text)
            self.assertEqual(str(ctx.exception), message)

    def test_config_prefix(self):
        with self.assertRaises(ContentError) as ctx:
            frontmatter.parse_config("oops")
        self.assertEqual(str(ctx.exception), 'config line 1: expected "key: value"')


if __name__ == "__main__":
    unittest.main()
