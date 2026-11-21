import datetime
import os
import tempfile
import unittest

from pagewright.errors import SiteError
from pagewright.site import render_site

TEMPLATES = {
    "page.html": "{{ page.title }}",
    "home.html": "{{ pagination.number }}/{{ pagination.total }}:{% for p in posts %}{{ p.url }} {% endfor %}",
    "tag.html": "{{ tag.slug }}",
    "tags.html": "{% for t in tags %}{{ t.slug }} {% endfor %}",
}


def make(content, config="title: T\nper_page: 1\n"):
    root = tempfile.mkdtemp()
    files = {"config.txt": config}
    files.update({"templates/" + k: v for k, v in TEMPLATES.items()})
    files.update({"content/" + k: v for k, v in content.items()})
    for rel, text in files.items():
        path = os.path.join(root, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
    return root


class SiteUnitTest(unittest.TestCase):
    def test_pagination_and_exclusion(self):
        root = make({
            "posts/a.md": "---\ntitle: A\ndate: 2026-01-01\ntags: [x]\n---\n",
            "posts/b.md": "---\ntitle: B\ndate: 2026-02-01\n---\n",
            "posts/c.md": "---\ntitle: C\ndate: 2027-01-01\n---\n",
            "posts/d.md": "---\ntitle: D\ndate: 2026-03-01\ndraft: true\n---\n",
        })
        out = render_site(root, datetime.date(2026, 6, 1))
        self.assertEqual(out["index.html"], "1/2:/posts/b/ ")
        self.assertEqual(out["page/2/index.html"], "2/2:/posts/a/ ")
        self.assertEqual(out["tags/index.html"], "x ")
        self.assertNotIn("posts/c/index.html", out)
        self.assertNotIn("posts/d/index.html", out)

    def test_bad_config(self):
        with self.assertRaises(SiteError):
            render_site(make({}, config="per_page: 2\n"), datetime.date(2026, 1, 1))


if __name__ == "__main__":
    unittest.main()
