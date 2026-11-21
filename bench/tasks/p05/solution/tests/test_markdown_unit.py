import unittest

from pagewright.markdown import inline, render, slugify


class MarkdownUnitTest(unittest.TestCase):
    def test_blocks(self):
        text = "# Title\n\nSome **bold** text.\n\n- one\n- two\n\n```py\nx < 1\n```\n"
        self.assertEqual(render(text), '<h1 id="title">Title</h1>\n<p>Some <strong>bold</strong> text.</p>\n'
                                       '<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n'
                                       '<pre><code class="language-py">x &lt; 1\n</code></pre>\n')

    def test_duplicate_heading_ids(self):
        self.assertEqual(render("## A\n## A\n"), '<h2 id="a">A</h2>\n<h2 id="a-2">A</h2>\n')

    def test_inline_rules(self):
        self.assertEqual(inline("`a<b` [l](/u) *e*"), '<code>a&lt;b</code> <a href="/u">l</a> <em>e</em>')
        self.assertEqual(inline("2 * 3 * 4 \\* x"), "2 * 3 * 4 * x")

    def test_slugify(self):
        self.assertEqual(slugify("  Hi, There! 2"), "hi-there-2")


if __name__ == "__main__":
    unittest.main()
