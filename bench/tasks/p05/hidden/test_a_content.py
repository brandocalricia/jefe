import datetime
import unittest

from pagewright import frontmatter, markdown
from pagewright.content import parse_page
from pagewright.errors import ContentError, PagewrightError, SiteError, TemplateError


def fm_error(text):
    with unittest.TestCase().assertRaises(ContentError) as ctx:
        frontmatter.parse(text)
    return str(ctx.exception)


class ErrorTypesTest(unittest.TestCase):
    def test_hierarchy(self):
        for cls in (ContentError, TemplateError, SiteError):
            self.assertTrue(issubclass(cls, PagewrightError))
        self.assertTrue(issubclass(PagewrightError, Exception))


class FrontMatterTest(unittest.TestCase):
    def test_no_front_matter(self):
        self.assertEqual(frontmatter.parse("hello\n"), ({}, "hello\n"))
        self.assertEqual(frontmatter.parse("--- \na: b\n---\n"), ({}, "--- \na: b\n---\n"))

    def test_value_types(self):
        text = ('---\ntitle: "Say \\"hi\\" \\\\ ok"\ncount: -12\nflag: true\noff: false\nempty:\n'
                'name: plain text: with colon\nlist: [a,  b ,, c]\nnone: []\n# a comment\n\n'
                '  indented: yes\nseven: 007\nfloat: 1.5\nplus: +5\nWord: x\n---\nBody\n')
        with self.assertRaises(ContentError):  # "Word" is not a valid key
            frontmatter.parse(text)
        meta, body = frontmatter.parse(text.replace("Word: x\n", ""))
        self.assertEqual(meta, {
            "title": 'Say "hi" \\ ok', "count": -12, "flag": True, "off": False, "empty": "",
            "name": "plain text: with colon", "list": ["a", "b", "c"], "none": [],
            "indented": "yes", "seven": 7, "float": "1.5", "plus": "+5"})
        self.assertEqual(body, "Body\n")

    def test_other_backslashes_are_kept(self):
        meta, _ = frontmatter.parse('---\np: "a\\nb"\nq: True\n---\n')
        self.assertEqual(meta, {"p": "a\\nb", "q": "True"})

    def test_body_boundaries(self):
        self.assertEqual(frontmatter.parse("---\na: b\n---\n\nbody\n"), ({"a": "b"}, "\nbody\n"))
        self.assertEqual(frontmatter.parse("---\na: b\n---"), ({"a": "b"}, ""))
        self.assertEqual(frontmatter.parse("---\n---\nx"), ({}, "x"))

    def test_crlf(self):
        self.assertEqual(frontmatter.parse("---\r\na: b\r\n---\r\nx\r\ny"), ({"a": "b"}, "x\ny"))

    def test_not_closed(self):
        self.assertEqual(fm_error("---\na: b\n"), "front matter is not closed")
        self.assertEqual(fm_error("---"), "front matter is not closed")

    def test_line_errors(self):
        self.assertEqual(fm_error("---\ntitle: x\nbroken line\n---\n"), 'front matter line 3: expected "key: value"')
        self.assertEqual(fm_error("---\nmy key: x\n---\n"), 'front matter line 2: expected "key: value"')
        self.assertEqual(fm_error("---\ntitle : x\n---\n"), 'front matter line 2: expected "key: value"')
        self.assertEqual(fm_error("---\na: 1\nb: 2\na: 3\n---\n"), 'front matter line 4: duplicate key "a"')

    def test_value_errors(self):
        self.assertEqual(fm_error('---\nx: "abc\n---\n'), "front matter line 2: invalid string")
        self.assertEqual(fm_error('---\n\nx: "a" b\n---\n'), "front matter line 3: invalid string")
        self.assertEqual(fm_error('---\nx: "a"b"\n---\n'), "front matter line 2: invalid string")
        self.assertEqual(fm_error("---\nx: [a, b\n---\n"), "front matter line 2: invalid list")
        self.assertEqual(fm_error('---\nx: "a\\"\n---\n'), "front matter line 2: invalid string")
        self.assertEqual(fm_error('---\nx: "\n---\n'), "front matter line 2: invalid string")
        self.assertEqual(frontmatter.parse('---\nx: "a\\\\"\n---\n')[0], {"x": "a\\"})

    def test_config(self):
        self.assertEqual(frontmatter.parse_config("# c\ntitle: Site\nper_page: 3\n"), {"title": "Site", "per_page": 3})
        with self.assertRaises(ContentError) as ctx:
            frontmatter.parse_config("title: a\nbad\n")
        self.assertEqual(str(ctx.exception), 'config line 2: expected "key: value"')
        with self.assertRaises(ContentError) as ctx:
            frontmatter.parse_config("a: 1\na: 2\n")
        self.assertEqual(str(ctx.exception), 'config line 2: duplicate key "a"')


class SlugTest(unittest.TestCase):
    def test_slugify(self):
        for text, want in [("Hello, World!", "hello-world"), ("  --A__B--  ", "a-b"),
                           ("Café Au Lait", "caf-au-lait"), ("", ""), ("!!!", ""), ("x2y", "x2y")]:
            self.assertEqual(markdown.slugify(text), want)

    def test_escape(self):
        self.assertEqual(markdown.escape('a & b < c > "d" \'e\''), "a &amp; b &lt; c &gt; &quot;d&quot; 'e'")
        self.assertEqual(markdown.escape("&amp;"), "&amp;amp;")


class MarkdownBlocksTest(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(markdown.render(""), "")
        self.assertEqual(markdown.render("\n\n  \n"), "")

    def test_paragraphs(self):
        self.assertEqual(markdown.render("one\ntwo\n\nthree\n"), "<p>one\ntwo</p>\n<p>three</p>\n")
        self.assertEqual(markdown.render("  one  \n   two\n"), "<p>one\ntwo</p>\n")
        self.assertEqual(markdown.render("a\r\n\r\nb\r\n"), "<p>a</p>\n<p>b</p>\n")

    def test_headings(self):
        got = markdown.render("# A\n## B b\n###### F\n####### G\n#nospace\n")
        self.assertEqual(got, '<h1 id="a">A</h1>\n<h2 id="b-b">B b</h2>\n<h6 id="f">F</h6>\n'
                              "<p>####### G\n#nospace</p>\n")
        self.assertEqual(markdown.render("## A *b* c  \n"), '<h2 id="a-b-c">A <em>b</em> c</h2>\n')
        self.assertEqual(markdown.render("# See [docs](/d) now\n"),
                         '<h1 id="see-docs-d-now">See <a href="/d">docs</a> now</h1>\n')

    def test_blank_lines_and_block_boundaries(self):
        self.assertEqual(markdown.render("a\n\n\n\n\nb\n"), "<p>a</p>\n<p>b</p>\n")
        self.assertEqual(markdown.render("- a\n\n- b\n"), "<ul>\n<li>a</li>\n</ul>\n<ul>\n<li>b</li>\n</ul>\n")
        self.assertEqual(markdown.render("- a\n# H\n"), '<ul>\n<li>a</li>\n</ul>\n<h1 id="h">H</h1>\n')
        self.assertEqual(markdown.render("- a\n```\nx\n```\n"), "<ul>\n<li>a</li>\n</ul>\n<pre><code>x\n</code></pre>\n")
        self.assertEqual(markdown.render("text\n- a\n"), "<p>text</p>\n<ul>\n<li>a</li>\n</ul>\n")
        self.assertEqual(markdown.render("```\na\n   \n\nb\n```\n\n\nc\n"),
                         "<pre><code>a\n   \n\nb\n</code></pre>\n<p>c</p>\n")
        self.assertEqual(markdown.render("# A #\n"), '<h1 id="a">A #</h1>\n')
        self.assertEqual(markdown.render("\n\n# H\n\n\n"), '<h1 id="h">H</h1>\n')

    def test_heading_ids_are_unique(self):
        ids = [l.split('"')[1] for l in markdown.render("# Intro\n# Intro\n# Intro\n# !!!\n# ??\n## intro\n").splitlines()]
        self.assertEqual(ids, ["intro", "intro-2", "intro-3", "section", "section-2", "intro-4"])

    def test_heading_interrupts_paragraph(self):
        self.assertEqual(markdown.render("text\n# H\nmore\n"), '<p>text</p>\n<h1 id="h">H</h1>\n<p>more</p>\n')

    def test_lists(self):
        self.assertEqual(markdown.render("- a\n* b\n- c *d*\n\nafter\n"),
                         "<ul>\n<li>a</li>\n<li>b</li>\n<li>c <em>d</em></li>\n</ul>\n<p>after</p>\n")
        self.assertEqual(markdown.render("intro\n- a\n- b\ntail\n"),
                         "<p>intro</p>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n<p>tail</p>\n")
        self.assertEqual(markdown.render("-x\n"), "<p>-x</p>\n")
        self.assertEqual(markdown.render("*x* y\n"), "<p><em>x</em> y</p>\n")
        self.assertEqual(markdown.render("- \n"), "<p>-</p>\n")
        self.assertEqual(markdown.render("  - indented\n"), "<p>- indented</p>\n")

    def test_fenced_code(self):
        got = markdown.render("```python\nprint('<hi>')\n\n  indented & \"q\"\n```\nafter\n")
        self.assertEqual(got, '<pre><code class="language-python">print(\'&lt;hi&gt;\')\n\n'
                              '  indented &amp; &quot;q&quot;\n</code></pre>\n<p>after</p>\n')
        self.assertEqual(markdown.render("```\na\nb\n"), "<pre><code>a\nb\n</code></pre>\n")
        self.assertEqual(markdown.render("```\n```\n"), "<pre><code></code></pre>\n")
        self.assertEqual(markdown.render("```js  extra words\nx\n```"), '<pre><code class="language-js">x\n</code></pre>\n')
        self.assertEqual(markdown.render("text\n```\ncode *x*\n# not heading\n```\n"),
                         "<p>text</p>\n<pre><code>code *x*\n# not heading\n</code></pre>\n")
        self.assertEqual(markdown.render("```\na\n```b\n```\n"), "<pre><code>a\n```b\n</code></pre>\n")


class MarkdownInlineTest(unittest.TestCase):
    def para(self, text):
        out = markdown.render(text)
        self.assertTrue(out.startswith("<p>") and out.endswith("</p>\n"), out)
        return out[3:-5]

    def test_spec_examples(self):
        self.assertEqual(self.para("a *b* **c** `d<e>` [x](/y#z)"),
                         'a <em>b</em> <strong>c</strong> <code>d&lt;e&gt;</code> <a href="/y#z">x</a>')
        self.assertEqual(self.para("5 * 3 * 2"), "5 * 3 * 2")
        self.assertEqual(self.para("\\*not em\\*"), "*not em*")

    def test_strong_and_em(self):
        self.assertEqual(self.para("**a** and **b**"), "<strong>a</strong> and <strong>b</strong>")
        self.assertEqual(self.para("**bold *nested* here**"), "<strong>bold <em>nested</em> here</strong>")
        self.assertEqual(self.para("**unclosed"), "**unclosed")
        self.assertEqual(self.para("** spaced**"), "** spaced**")
        self.assertEqual(self.para("**a\nb**"), "**a\nb**")
        self.assertEqual(self.para("_x_"), "_x_")

    def test_nesting(self):
        self.assertEqual(self.para("**a *b* c**"), "<strong>a <em>b</em> c</strong>")
        self.assertEqual(self.para("[`x`](u)"), '<a href="u"><code>x</code></a>')
        self.assertEqual(self.para("*a **b** c*"), "*a <strong>b</strong> c*")
        self.assertEqual(self.para("***x***"), "<strong>*x</strong>*")
        self.assertEqual(self.para("[a](u)(v)"), '<a href="u">a</a>(v)')
        self.assertEqual(markdown.render("- **b** [l](/u)\n* `c`\n"),
                         '<ul>\n<li><strong>b</strong> <a href="/u">l</a></li>\n<li><code>c</code></li>\n</ul>\n')

    def test_code(self):
        self.assertEqual(self.para("`a*b*c` and `x`"), "<code>a*b*c</code> and <code>x</code>")
        self.assertEqual(self.para("a ` b"), "a ` b")
        self.assertEqual(self.para("`` x"), "`` x")

    def test_links(self):
        self.assertEqual(self.para("[*go* now](http://x.org/?a=1&b=2)"),
                         '<a href="http://x.org/?a=1&amp;b=2"><em>go</em> now</a>')
        self.assertEqual(self.para("[not a link] (x)"), "[not a link] (x)")
        self.assertEqual(self.para("[a](b c)"), "[a](b c)")
        self.assertEqual(self.para("[a]()"), "[a]()")

    def test_escapes_and_html(self):
        self.assertEqual(self.para('x < y & z > "q"'), "x &lt; y &amp; z &gt; &quot;q&quot;")
        self.assertEqual(self.para("<b>hi</b>"), "&lt;b&gt;hi&lt;/b&gt;")
        self.assertEqual(self.para("a\\b"), "a\\b")
        self.assertEqual(self.para("\\\\"), "\\")
        self.assertEqual(self.para("\\`x\\`"), "`x`")
        self.assertEqual(self.para("\\[a](b)"), "[a](b)")
        self.assertEqual(self.para("it's"), "it's")


class ParsePageTest(unittest.TestCase):
    def test_full_page(self):
        text = "---\ntitle: Hello\ndate: 2024-02-29\ntags: [a, b, a]\nauthor: Ann\n---\n# Hi\n\ntext\n"
        page = parse_page("content/a.md", text)
        self.assertEqual(page.source, "content/a.md")
        self.assertEqual(page.title, "Hello")
        self.assertEqual(page.date, datetime.date(2024, 2, 29))
        self.assertIs(page.draft, False)
        self.assertEqual(page.tags, ["a", "b"])
        self.assertEqual(page.meta["author"], "Ann")
        self.assertEqual(page.html, '<h1 id="hi">Hi</h1>\n<p>text</p>\n')

    def test_defaults(self):
        page = parse_page("a.md", "---\ntitle: T\ndraft: true\n---\n")
        self.assertEqual((page.date, page.draft, page.tags, page.html), (None, True, [], ""))

    def err(self, text, source="a.md"):
        with self.assertRaises(ContentError) as ctx:
            parse_page(source, text)
        return str(ctx.exception)

    def test_errors(self):
        self.assertEqual(self.err("---\ndate: 2024-01-01\n---\n"), "a.md: missing title")
        self.assertEqual(self.err("body only"), "a.md: missing title")
        self.assertEqual(self.err("---\ntitle: 42\n---\n"), "a.md: title must be text")
        self.assertEqual(self.err("---\ntitle: [a]\n---\n"), "a.md: title must be text")
        self.assertEqual(self.err("---\ntitle: x\ndate: 2026-02-30\n---\n"), 'a.md: invalid date "2026-02-30"')
        self.assertEqual(self.err("---\ntitle: x\ndate: 2026\n---\n"), 'a.md: invalid date "2026"')
        self.assertEqual(self.err("---\ntitle: x\ndate: 2026-1-5\n---\n"), 'a.md: invalid date "2026-1-5"')
        self.assertEqual(self.err("---\ntitle: x\ndraft: yes\n---\n"), "a.md: draft must be true or false")
        self.assertEqual(self.err("---\ntitle: x\ntags: news\n---\n"), "a.md: tags must be a list")

    def test_error_order_and_prefix(self):
        self.assertEqual(self.err("---\ndate: nope\ndraft: maybe\n---\n"), "a.md: missing title")
        self.assertEqual(self.err("---\ntitle: x\ndate: nope\ndraft: maybe\n---\n"), 'a.md: invalid date "nope"')
        self.assertEqual(self.err("---\ntitle: x\nnope\n---\n", "content/a.md"),
                         'content/a.md: front matter line 3: expected "key: value"')
        self.assertEqual(self.err("---\ntitle: x\n"), "a.md: front matter is not closed")


if __name__ == "__main__":
    unittest.main()
