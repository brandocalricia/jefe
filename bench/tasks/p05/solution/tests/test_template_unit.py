import unittest

from pagewright.errors import TemplateError
from pagewright.template import render


class TemplateUnitTest(unittest.TestCase):
    def test_blocks_and_loops(self):
        src = "{% for x in xs %}{% if loop.first %}[{% endif %}{{ x }}{% if loop.last %}]{% else %},{% endif %}{% endfor %}"
        self.assertEqual(render(src, {"xs": [1, 2, 3]}), "[1,2,3]")

    def test_escape_and_raw(self):
        self.assertEqual(render("{{ a }}{{{ a }}}", {"a": "<&>"}), "&lt;&amp;&gt;<&>")

    def test_include(self):
        self.assertEqual(render('{% include "p" %}', {"n": "x"}, {"p": "<{{ n }}>"}), "<x>")

    def test_errors_carry_line_numbers(self):
        for src, message in [("a\n{{ nope }}", 't:2: unknown variable "nope"'),
                             ("{% if a %}\n", 't:1: unclosed "if" block'),
                             ("{% endfor %}", 't:1: unexpected "endfor"')]:
            with self.assertRaises(TemplateError) as ctx:
                render(src, {"a": 1}, name="t")
            self.assertEqual(str(ctx.exception), message)


if __name__ == "__main__":
    unittest.main()
