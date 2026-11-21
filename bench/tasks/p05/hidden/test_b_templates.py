import datetime
import unittest

from pagewright.errors import PagewrightError, TemplateError
from pagewright.template import render


class TemplateTestCase(unittest.TestCase):
    def err(self, source, context=None, includes=None, name="t"):
        with self.assertRaises(TemplateError) as ctx:
            render(source, {} if context is None else context, includes, name)
        return str(ctx.exception)


class VariablesTest(unittest.TestCase):
    def test_substitution_and_escaping(self):
        self.assertEqual(render("Hello {{ name }}!", {"name": "W"}), "Hello W!")
        self.assertEqual(render("{{name}}|{{   name   }}", {"name": "W"}), "W|W")
        self.assertEqual(render("{{ x }}", {"x": '<a href="u">&</a>'}), "&lt;a href=&quot;u&quot;&gt;&amp;&lt;/a&gt;")
        self.assertEqual(render("{{{ x }}}|{{{x}}}", {"x": "<b>&"}), "<b>&|<b>&")

    def test_value_conversion(self):
        ctx = {"none": None, "t": True, "f": False, "n": 42, "z": 0, "d": datetime.date(2026, 3, 5), "s": ""}
        self.assertEqual(render("[{{ none }}][{{ t }}][{{ f }}][{{ n }}][{{ z }}][{{ d }}][{{ s }}]", ctx),
                         "[][true][false][42][0][2026-03-05][]")

    def test_paths(self):
        ctx = {"a": {"b": {"c": "deep"}}, "xs": [{"t": "first"}, {"t": "second"}], "k_1": "ok"}
        self.assertEqual(render("{{ a.b.c }} {{ xs.0.t }} {{ xs.1.t }} {{ k_1 }}", ctx), "deep first second ok")

    def test_text_is_untouched(self):
        self.assertEqual(render("{ x } {{ y }} }} 100% {", {"y": "1"}), "{ x } 1 }} 100% {")
        self.assertEqual(render("  \n\t{{ y }}\n\n", {"y": "1"}), "  \n\t1\n\n")

    def test_context_not_modified(self):
        ctx = {"xs": [1, 2], "x": "keep"}
        render("{% for x in xs %}{{ x }}{% endfor %}", ctx)
        self.assertEqual(ctx, {"xs": [1, 2], "x": "keep"})


class BlocksTest(unittest.TestCase):
    def test_if_else(self):
        src = "{% if v %}Y{% else %}N{% endif %}"
        for value in ("", 0, None, False, [], {}):
            self.assertEqual(render(src, {"v": value}), "N", repr(value))
        for value in ("false", 1, [0], {"a": 1}, True):
            self.assertEqual(render(src, {"v": value}), "Y", repr(value))

    def test_if_not_and_nesting(self):
        self.assertEqual(render("{% if not v %}empty{% endif %}|{% if notes %}n{% endif %}", {"v": [], "notes": 1}), "empty|n")
        src = "{% if a %}A{% if b %}B{% else %}b{% endif %}{% else %}a{% endif %}"
        self.assertEqual(render(src, {"a": 1, "b": 1}), "AB")
        self.assertEqual(render(src, {"a": 1, "b": 0}), "Ab")
        self.assertEqual(render(src, {"a": 0, "b": 1}), "a")

    def test_whitespace_around_blocks_is_kept(self):
        self.assertEqual(render("  {% if x %}\n  a\n  {% endif %}\n", {"x": True}), "  \n  a\n  \n")
        self.assertEqual(render("  {% if x %}\n  a\n  {% endif %}\n", {"x": False}), "  \n")

    def test_for_and_loop(self):
        src = "{% for x in xs %}{{ loop.index }}:{{ x }}{% if loop.last %}.{% else %},{% endif %}{% endfor %}"
        self.assertEqual(render(src, {"xs": ["a", "b", "c"]}), "1:a,2:b,3:c.")
        self.assertEqual(render("{% for x in xs %}{% if loop.first %}F{% endif %}{{ x }}{% endfor %}", {"xs": [1, 2]}), "F12")
        self.assertEqual(render("[{% for x in xs %}{{ x }}{% endfor %}]", {"xs": []}), "[]")
        self.assertEqual(render("{% for p in posts %}{{ p.title }};{% endfor %}", {"posts": [{"title": "A"}, {"title": "<B>"}]}),
                         "A;&lt;B&gt;;")
        self.assertEqual(render("{% for x in xs %}{{ loop.index }}{{ loop.first }}{{ loop.last }} {% endfor %}", {"xs": [0]}),
                         "1truetrue ")

    def test_scoping(self):
        src = "{% for a in xs %}{% for b in ys %}{{ a }}{{ b }}{{ loop.index }} {% endfor %}{{ loop.index }}|{% endfor %}"
        self.assertEqual(render(src, {"xs": [1, 2], "ys": ["x", "y"]}), "1x1 1y2 1|2x1 2y2 2|")
        self.assertEqual(render("{% for x in xs %}{{ x }}{% endfor %}{{ x }}", {"xs": ["l"], "x": "ctx"}), "lctx")

    def test_for_over_non_list(self):
        for value in ("abc", 3, None, {"a": 1}):
            with self.assertRaises(TemplateError) as ctx:
                render("a\n{% for x in n %}{% endfor %}", {"n": value}, name="T")
            self.assertEqual(str(ctx.exception), 'T:2: "n" is not a list')


class IncludesTest(TemplateTestCase):
    def test_include(self):
        inc = {"a": "[{{ x }}]", "b": "<{% include \"a\" %}>"}
        self.assertEqual(render('{% include "a" %}', {"x": "<1>"}, inc), "[&lt;1&gt;]")
        self.assertEqual(render('{% for x in xs %}{% include "b" %}{% endfor %}', {"xs": [1, 2]}, inc), "<[1]><[2]>")

    def test_include_error_names(self):
        inc = {"inner": "line1\n{{ nope }}"}
        self.assertEqual(self.err('{% include "inner" %}', {}, inc, "main"), 'inner:2: unknown variable "nope"')
        self.assertEqual(self.err("x\n{% include \"zz\" %}", {}, inc, "main"), 'main:2: unknown include "zz"')
        self.assertEqual(self.err('{% include "zz" %}', {}, None, "main"), 'main:1: unknown include "zz"')

    def test_depth_limit(self):
        inc = {"c" + str(i): '{% include "c' + str(i + 1) + '" %}' for i in range(1, 11)}
        inc["c10"] = "end"
        self.assertEqual(render('{% include "c1" %}', {}, inc), "end")  # c10 is level 10
        inc["c10"] = '{% include "c11" %}'
        inc["c11"] = "end"
        self.assertEqual(self.err('{% include "c1" %}', {}, inc, "main"), "c10:1: includes nested too deeply")

    def test_depth_is_checked_before_the_name_is_looked_up(self):
        inc = {"c" + str(i): '{% include "c' + str(i + 1) + '" %}' for i in range(1, 11)}
        self.assertEqual(self.err('{% include "c1" %}', {}, inc, "main"), "c10:1: includes nested too deeply")

    def test_cycle(self):
        inc = {"a": 'x{% include "a" %}'}
        self.assertEqual(self.err('{% include "a" %}', {}, inc, "main"), "a:1: includes nested too deeply")

    def test_included_syntax_is_read_when_executed(self):
        inc = {"bad": "{% if %}"}
        self.assertEqual(render('{% if f %}{% include "bad" %}{% endif %}ok', {"f": False}, inc), "ok")
        self.assertEqual(self.err('{% include "bad" %}', {}, inc, "main"), 'bad:1: invalid "if" tag')


class ErrorsTest(TemplateTestCase):
    def test_unknown_variable(self):
        self.assertEqual(self.err("a\n{{ nope }}", name="t.html"), 't.html:2: unknown variable "nope"')
        self.assertEqual(self.err("{{{ user.age }}}", {"user": {"name": "x"}}), 't:1: unknown variable "user.age"')
        self.assertEqual(self.err("x{{ user.name.first }}", {"user": {"name": "x"}}), 't:1: unknown variable "user.name.first"')
        self.assertEqual(self.err("{{ xs.5 }}", {"xs": [1]}), 't:1: unknown variable "xs.5"')
        self.assertEqual(self.err("{% if ghost %}{% endif %}"), 't:1: unknown variable "ghost"')
        self.assertEqual(self.err("\n\n{% for x in ghost %}{% endfor %}"), 't:3: unknown variable "ghost"')
        self.assertEqual(self.err("{% for x in xs %}{% endfor %}{{ loop.first }}", {"xs": [1]}), 't:1: unknown variable "loop.first"')

    def test_variables_are_looked_up_lazily(self):
        self.assertEqual(render("{% if flag %}{{ nope }}{% endif %}ok", {"flag": False}), "ok")
        self.assertEqual(render("{% if flag %}a{% else %}{{ b }}{% endif %}", {"flag": True}), "a")
        self.assertEqual(render("{% for x in xs %}{{ nope }}{% endfor %}.", {"xs": []}), ".")

    def test_unterminated(self):
        self.assertEqual(self.err("a\nb {{ x"), "t:2: unterminated tag")
        self.assertEqual(self.err("{{{ x }}", {"x": 1}), "t:1: unterminated tag")
        self.assertEqual(self.err("ok\n{% if x "), "t:2: unterminated tag")
        self.assertEqual(self.err("{{ x\n }}", {"x": 1}), "t:1: unterminated tag")

    def test_invalid_expression(self):
        for src in ("{{ a b }}", "{{ }}", "{{ a-b }}", "{{ 1x }}", "{{ a. }}", "{{{ }}}"):
            self.assertEqual(self.err(src, {"a": 1}), "t:1: invalid expression", src)

    def test_unknown_and_invalid_tags(self):
        self.assertEqual(self.err("x\n{% foo %}"), 't:2: unknown tag "foo"')
        self.assertEqual(self.err("{% %}"), 't:1: unknown tag ""')
        cases = [("{% if %}", "if"), ("{% for x %}", "for"), ("{% for 1x in y %}", "for"), ("{% include foo %}", "include"),
                 ('{% include "" %}', "include"), ("{% endif now %}", "endif"), ("{% else x %}", "else"), ("{% if a b %}", "if")]
        for src, word in cases:
            self.assertEqual(self.err(src), 't:1: invalid "%s" tag' % word, src)

    def test_unexpected(self):
        self.assertEqual(self.err("{% endif %}"), 't:1: unexpected "endif"')
        self.assertEqual(self.err("{% else %}"), 't:1: unexpected "else"')
        self.assertEqual(self.err("{% if a %}{% endfor %}"), 't:1: unexpected "endfor"')
        self.assertEqual(self.err("{% for x in y %}\n{% endif %}"), 't:2: unexpected "endif"')
        self.assertEqual(self.err("{% if a %}{% else %}\n{% else %}{% endif %}"), 't:2: unexpected "else"')
        self.assertEqual(self.err("{% for x in y %}{% else %}{% endfor %}"), 't:1: unexpected "else"')

    def test_unclosed(self):
        self.assertEqual(self.err("a\n{% if x %}\nb"), 't:2: unclosed "if" block')
        self.assertEqual(self.err("{% for a in b %}\n{% if c %}"), 't:2: unclosed "if" block')
        self.assertEqual(self.err("{% if c %}\n{% for a in b %}\n{% endfor %}"), 't:1: unclosed "if" block')
        self.assertEqual(self.err("x\n\n{% for a in b %}"), 't:3: unclosed "for" block')

    def test_syntax_is_checked_before_lookups(self):
        self.assertEqual(self.err("{{ nope }}\n{% endif %}"), 't:2: unexpected "endif"')
        self.assertEqual(self.err("{% foo %}\n{{ a b }}"), 't:1: unknown tag "foo"')
        self.assertEqual(self.err("{{ a b }}\n{% foo %}"), "t:1: invalid expression")
        self.assertEqual(self.err("{% if x %}{{ nope }}"), 't:1: unclosed "if" block')

    def test_error_type(self):
        with self.assertRaises(PagewrightError):
            render("{{ nope }}", {})


if __name__ == "__main__":
    unittest.main()
