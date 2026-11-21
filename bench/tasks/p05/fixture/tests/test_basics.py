import unittest

from pagewright import frontmatter, markdown, template


class BasicsTest(unittest.TestCase):
    def test_front_matter_and_body(self):
        meta, body = frontmatter.parse("---\ntitle: Hi\ntags: [a, b]\n---\ntext\n")
        self.assertEqual(meta, {"title": "Hi", "tags": ["a", "b"]})
        self.assertEqual(body, "text\n")

    def test_paragraph_and_heading(self):
        self.assertEqual(markdown.render("# Hello World\n\nSome *text*.\n"),
                         '<h1 id="hello-world">Hello World</h1>\n<p>Some <em>text</em>.</p>\n')

    def test_template_escapes_by_default(self):
        self.assertEqual(template.render("<{{ x }}|{{{ x }}}>", {"x": "a<b"}), "<a&lt;b|a<b>")


if __name__ == "__main__":
    unittest.main()
