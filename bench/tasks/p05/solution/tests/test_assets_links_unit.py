import unittest

from pagewright import assets
from pagewright.links import check_links


class AssetsLinksUnitTest(unittest.TestCase):
    def test_hashed_name(self):
        name = assets.hashed_name("css/site.css", b"x")
        self.assertRegex(name, r"\Acss/site\.[0-9a-f]{8}\.css\Z")
        self.assertRegex(assets.hashed_name("LICENSE", b"x"), r"\ALICENSE\.[0-9a-f]{8}\Z")

    def test_rewrite(self):
        mapping = {"/static/a.css": "/static/a.1.css"}
        self.assertEqual(assets.rewrite('<a href="/static/a.css"> <a href="/static/a.css?x">', mapping),
                         '<a href="/static/a.1.css"> <a href="/static/a.css?x">')

    def test_links(self):
        pages = {"index.html": '<a href="/a/">x</a> <a href="/a/#t">y</a> <a href="/b/">z</a>',
                 "a/index.html": '<h1 id="s">S</h1>'}
        self.assertEqual(check_links(pages, []), ['index.html: broken anchor "/a/#t"', 'index.html: broken link "/b/"'])


if __name__ == "__main__":
    unittest.main()
