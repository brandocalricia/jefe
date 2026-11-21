import datetime
import os
import tempfile
import unittest

from pagewright.errors import ContentError, SiteError, TemplateError
from pagewright.site import render_site

D = datetime.date

TEMPLATES = {
    "page.html": "PAGE {{ page.title }}|{{ page.url }}|{{ page.date }}|prev={% if prev %}{{ prev.url }}{% endif %}"
                 "|next={% if next %}{{ next.url }}{% endif %}|{{{ content }}}|site={{ site.title }}",
    "home.html": "HOME {{ pagination.number }}/{{ pagination.total }} "
                 "prev={% if pagination.prev_url %}{{ pagination.prev_url }}{% else %}-{% endif %} "
                 "next={% if pagination.next_url %}{{ pagination.next_url }}{% else %}-{% endif %} "
                 "[{% for p in posts %}{{ p.title }},{% endfor %}]",
    "tag.html": "TAG {{ tag.name }} {{ tag.slug }} {{ tag.url }} {{ tag.count }} [{% for p in posts %}{{ p.title }},{% endfor %}]",
    "tags.html": "TAGS [{% for t in tags %}{{ t.slug }}={{ t.name }}:{{ t.count }},{% endfor %}]",
}


def post(title, date, body="B.", extra=""):
    return "---\ntitle: %s\ndate: %s\n%s---\n%s\n" % (title, date, extra, body)


class SiteCase(unittest.TestCase):
    def make(self, content=None, config="title: Test Site\nper_page: 2\n", templates=None, extra=None):
        root = tempfile.mkdtemp()
        files = {"config.txt": config}
        if config is None:
            files = {}
        for name, text in (TEMPLATES if templates is None else templates).items():
            files["templates/" + name] = text
        for name, text in (content or {}).items():
            files["content/" + name] = text
        files.update(extra or {})
        for rel, text in files.items():
            path = os.path.join(root, *rel.split("/"))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
        return root

    def build(self, content, today=D(2026, 5, 31), **kw):
        return render_site(self.make(content, **kw), today)

    def fails(self, exc, content=None, today=D(2026, 5, 31), **kw):
        root = self.make(content, **kw)
        with self.assertRaises(exc) as ctx:
            render_site(root, today)
        return str(ctx.exception).replace(root, "ROOT")


class ConfigTest(SiteCase):
    def test_config_errors(self):
        self.assertEqual(self.fails(SiteError, config=None), "config.txt not found in ROOT")
        self.assertEqual(self.fails(SiteError, config="per_page: 3\n"), "config.txt: missing title")
        self.assertEqual(self.fails(SiteError, config="title:\n"), "config.txt: missing title")
        for bad in ("0", "-1", "abc", "true", "[1]"):
            self.assertEqual(self.fails(SiteError, config="title: T\nper_page: %s\n" % bad),
                             "config.txt: per_page must be a positive integer", bad)
        self.assertEqual(self.fails(SiteError, config="title: T\n\nbroken\n"),
                         'config.txt: config line 3: expected "key: value"')

    def test_missing_templates_in_order(self):
        self.assertEqual(self.fails(SiteError, templates={}), "missing template: page.html")
        t = dict(TEMPLATES)
        for name in ("home.html", "tag.html", "tags.html"):
            partial = {k: v for k, v in t.items() if k != name}
            self.assertEqual(self.fails(SiteError, templates=partial), "missing template: " + name)

    def test_defaults_and_site_data(self):
        out = self.build({"a.md": post("A", "2026-01-01")}, config="title: T\n",
                         templates=dict(TEMPLATES, **{"home.html": "{{ site.title }} {{ site.per_page }}"}))
        self.assertEqual(out["index.html"], "T 5")


class PagesTest(SiteCase):
    CONTENT = {
        "about.md": "---\ntitle: About\n---\nAbout us.\n",
        "posts/Hello World.md": post("Hello World", "2026-03-01", "Body one.", "tags: [News, misc]\n"),
        "posts/second.md": post("Second", "2026-04-01", "Body two.", "tags: [news]\n"),
        "posts/old.md": post("Old", "2026-01-15"),
        "notes.txt": "ignored",
    }

    def test_outputs_and_exact_pages(self):
        out = self.build(self.CONTENT)
        self.assertEqual(sorted(out), [
            "about/index.html", "index.html", "page/2/index.html", "posts/hello-world/index.html",
            "posts/old/index.html", "posts/second/index.html", "tags/index.html",
            "tags/misc/index.html", "tags/news/index.html"])
        self.assertEqual(out["posts/second/index.html"],
                         "PAGE Second|/posts/second/|2026-04-01|prev=/posts/hello-world/|next=|<p>Body two.</p>\n|site=Test Site")
        self.assertEqual(out["posts/hello-world/index.html"],
                         "PAGE Hello World|/posts/hello-world/|2026-03-01|prev=/posts/old/|next=/posts/second/|<p>Body one.</p>\n|site=Test Site")
        self.assertEqual(out["posts/old/index.html"],
                         "PAGE Old|/posts/old/|2026-01-15|prev=|next=/posts/hello-world/|<p>B.</p>\n|site=Test Site")

    def test_standalone_page_has_no_neighbours(self):
        out = self.build(self.CONTENT)
        self.assertEqual(out["about/index.html"], "PAGE About|/about/||prev=|next=|<p>About us.</p>\n|site=Test Site")

    def test_home_and_tags(self):
        out = self.build(self.CONTENT)
        self.assertEqual(out["index.html"], "HOME 1/2 prev=- next=/page/2/ [Second,Hello World,]")
        self.assertEqual(out["page/2/index.html"], "HOME 2/2 prev=/ next=- [Old,]")
        self.assertEqual(out["tags/index.html"], "TAGS [misc=misc:1,news=news:2,]")
        self.assertEqual(out["tags/news/index.html"], "TAG news news /tags/news/ 2 [Second,Hello World,]")
        self.assertEqual(out["tags/misc/index.html"], "TAG misc misc /tags/misc/ 1 [Hello World,]")

    def test_page_dict(self):
        tpl = dict(TEMPLATES, **{"page.html": "{% for t in page.tags %}{{ t.name }}={{ t.url }};{% endfor %}|{{ page.meta.author }}|{{ page.html }}"})
        out = self.build({"posts/a.md": post("A", "2026-01-01", "x", "tags: [Big News, big-news, Other]\nauthor: Ann\n"),
                          "b.md": "---\ntitle: B\ntags: [ignored]\nauthor: Bob\n---\n"}, templates=tpl)
        self.assertEqual(out["posts/a/index.html"], "Big News=/tags/big-news/;Other=/tags/other/;|Ann|&lt;p&gt;x&lt;/p&gt;\n")
        self.assertEqual(out["b/index.html"], "|Bob|")
        self.assertEqual(sorted(k for k in out if k.startswith("tags/")), ["tags/big-news/index.html", "tags/index.html", "tags/other/index.html"])
        self.assertEqual(out["tags/index.html"], "TAGS [big-news=Big News:1,other=Other:1,]")

    def test_page_tag_names_are_the_pages_own_spelling(self):
        tpl = dict(TEMPLATES, **{"page.html": "{% for t in page.tags %}{{ t.name }}={{ t.url }};{% endfor %}"})
        out = self.build({"a.md": post("A", "2026-01-01", extra="tags: [Zeta]\n"), "b.md": post("B", "2026-02-01", extra="tags: [zeta, ZETA]\n")},
                         templates=tpl)
        self.assertEqual(out["a/index.html"], "Zeta=/tags/zeta/;")
        self.assertEqual(out["b/index.html"], "zeta=/tags/zeta/;")
        self.assertEqual(out["tags/zeta/index.html"], "TAG zeta zeta /tags/zeta/ 2 [B,A,]")

    def test_tag_name_comes_from_newest_post(self):
        out = self.build({"a.md": post("A", "2026-01-01", extra="tags: [Zeta]\n"), "b.md": post("B", "2026-02-01", extra="tags: [zeta]\n")})
        self.assertEqual(out["tags/zeta/index.html"], "TAG zeta zeta /tags/zeta/ 2 [B,A,]")

    def test_same_date_orders_by_source(self):
        out = self.build({"b.md": post("B", "2026-01-01"), "a.md": post("A", "2026-01-01"), "c.md": post("C", "2026-01-01")},
                         config="title: T\nper_page: 5\n")
        self.assertEqual(out["index.html"], "HOME 1/1 prev=- next=- [A,B,C,]")
        self.assertTrue(out["a/index.html"].startswith("PAGE A|/a/|2026-01-01|prev=/b/|next=|"))
        self.assertTrue(out["b/index.html"].startswith("PAGE B|/b/|2026-01-01|prev=/c/|next=/a/|"))

    def test_template_error_and_partials(self):
        tpl = dict(TEMPLATES, **{"page.html": "x\n{{ nope }}"})
        self.assertEqual(self.fails(TemplateError, {"a.md": "---\ntitle: A\n---\n"}, templates=tpl),
                         'page.html:2: unknown variable "nope"')
        tpl = dict(TEMPLATES, **{"page.html": '{% include "partials/h.html" %}!', "partials/h.html": "<{{ page.title }}>"})
        self.assertEqual(self.build({"a.md": "---\ntitle: A\n---\n"}, templates=tpl)["a/index.html"], "<A>!")
        tpl["partials/h.html"] = "{{ nope }}"
        self.assertEqual(self.fails(TemplateError, {"a.md": "---\ntitle: A\n---\n"}, templates=tpl),
                         'partials/h.html:1: unknown variable "nope"')


class ExclusionTest(SiteCase):
    CONTENT = {
        "drafty.md": post("Drafty", "2026-01-01", extra="draft: true\ntags: [secret]\n"),
        "future.md": post("Future", "2026-06-01", extra="tags: [soon]\n"),
        "today.md": post("Today", "2026-05-31"),
        "past.md": post("Past", "2026-05-30"),
        "d.md": "---\ntitle: Undated draft\ndraft: true\n---\n",
        "plain.md": "---\ntitle: Plain\n---\n",
    }

    def test_exclusions(self):
        out = self.build(self.CONTENT, today=D(2026, 5, 31), config="title: T\nper_page: 9\n")
        self.assertEqual(sorted(out), ["index.html", "past/index.html", "plain/index.html", "tags/index.html", "today/index.html"])
        self.assertEqual(out["index.html"], "HOME 1/1 prev=- next=- [Today,Past,]")
        self.assertEqual(out["tags/index.html"], "TAGS []")

    def test_build_date_moves_the_boundary(self):
        content = {"future.md": post("Future", "2026-06-01", extra="tags: [soon]\n")}
        early = self.build(content, today=D(2026, 5, 31))
        self.assertEqual(sorted(early), ["index.html", "tags/index.html"])
        on_day = self.build(content, today=D(2026, 6, 1))
        self.assertIn("future/index.html", on_day)
        self.assertIn("tags/soon/index.html", on_day)

    def test_neighbours_skip_excluded_posts(self):
        out = self.build({"a.md": post("A", "2026-01-01"), "b.md": post("B", "2026-02-01", extra="draft: true\n"),
                          "c.md": post("C", "2026-03-01")})
        self.assertTrue(out["c/index.html"].startswith("PAGE C|/c/|2026-03-01|prev=/a/|next=|"))

    def test_malformed_files_fail_even_when_excluded(self):
        self.assertEqual(self.fails(ContentError, {"d.md": "---\ntitle: D\ndate: nope\ndraft: true\n---\n"}),
                         'content/d.md: invalid date "nope"')
        self.assertEqual(self.fails(ContentError, {"z.md": "x", "b/c.md": "---\ntitle: C\n", "a.md": "---\ntitle: A\ndraft: 3\n---\n"}),
                         "content/a.md: draft must be true or false")


class PaginationTest(SiteCase):
    def posts(self, n):
        return {"p%02d.md" % i: post("P%d" % i, "2026-01-%02d" % i) for i in range(1, n + 1)}

    def test_five_posts_two_per_page(self):
        out = self.build(self.posts(5))
        self.assertEqual(out["index.html"], "HOME 1/3 prev=- next=/page/2/ [P5,P4,]")
        self.assertEqual(out["page/2/index.html"], "HOME 2/3 prev=/ next=/page/3/ [P3,P2,]")
        self.assertEqual(out["page/3/index.html"], "HOME 3/3 prev=/page/2/ next=- [P1,]")
        self.assertNotIn("page/4/index.html", out)

    def test_page_counts_at_the_boundaries(self):
        cfg = "title: T\nper_page: 5\n"
        self.assertEqual(self.build(self.posts(5), config=cfg)["index.html"], "HOME 1/1 prev=- next=- [P5,P4,P3,P2,P1,]")
        six = self.build(self.posts(6), config=cfg)
        self.assertEqual(six["index.html"], "HOME 1/2 prev=- next=/page/2/ [P6,P5,P4,P3,P2,]")
        self.assertEqual(six["page/2/index.html"], "HOME 2/2 prev=/ next=- [P1,]")
        default = self.build(self.posts(6), config="title: T\n")
        self.assertIn("page/2/index.html", default)

    def test_no_posts(self):
        out = self.build({"about.md": "---\ntitle: A\n---\n"})
        self.assertEqual(out["index.html"], "HOME 1/1 prev=- next=- []")
        self.assertNotIn("page/2/index.html", out)

    def test_per_page_one(self):
        out = self.build(self.posts(2), config="title: T\nper_page: 1\n")
        self.assertEqual(out["page/2/index.html"], "HOME 2/2 prev=/ next=- [P1,]")


class SlugTest(SiteCase):
    def test_slug_rules(self):
        out = self.build({"Hello World!.md": "---\ntitle: A\n---\n", "notes/2026/Deep Dive.md": "---\ntitle: B\n---\n",
                          "who.md": "---\ntitle: C\nslug: people-2\n---\n", "posts/x.md": post("X", "2026-01-01", extra="slug: renamed\n")})
        for path in ("hello-world/index.html", "notes/2026/deep-dive/index.html", "people-2/index.html", "posts/renamed/index.html"):
            self.assertIn(path, out)
        for path in ("who/index.html", "posts/x/index.html", "notes/2026/Deep Dive/index.html"):
            self.assertNotIn(path, out)
        self.assertTrue(out["notes/2026/deep-dive/index.html"].startswith("PAGE B|/notes/2026/deep-dive/|"))
        self.assertTrue(out["posts/renamed/index.html"].startswith("PAGE X|/posts/renamed/|2026-01-01|"))

    def test_invalid_slugs(self):
        for bad in ("Bad Slug", "a--b", "-a", "A", "a_b", "5x!", "5"):
            msg = self.fails(SiteError, {"x.md": "---\ntitle: T\nslug: %s\n---\n" % bad})
            self.assertEqual(msg, 'content/x.md: invalid slug "%s"' % bad, bad)
        self.assertEqual(self.fails(SiteError, {"x.md": "---\ntitle: T\nslug: true\n---\n"}), 'content/x.md: invalid slug "true"')
        self.assertEqual(self.fails(SiteError, {"!!!.md": "---\ntitle: T\n---\n"}), "content/!!!.md: empty slug")

    def test_duplicates(self):
        content = {"x.md": "---\ntitle: X\n---\n", "y.md": "---\ntitle: Y\nslug: x\n---\n"}
        self.assertEqual(self.fails(SiteError, content), 'duplicate output path "x/index.html": content/x.md and content/y.md')
        content["y.md"] = "---\ntitle: Y\nslug: x\ndraft: true\n---\n"
        self.assertIn("x/index.html", self.build(content))
        folder = {"a/x.md": "---\ntitle: X\n---\n", "x.md": "---\ntitle: Y\n---\n"}
        self.assertIn("a/x/index.html", self.build(folder))


if __name__ == "__main__":
    unittest.main()
