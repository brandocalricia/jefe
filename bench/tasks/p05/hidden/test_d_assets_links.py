import hashlib
import os
import tempfile
import unittest

from pagewright import assets
from pagewright.links import check_links


def digest(data):
    return hashlib.sha256(data).hexdigest()[:8]


class HashedNameTest(unittest.TestCase):
    def test_names(self):
        d = digest(b"data")
        cases = {
            "css/site.css": "css/site.%s.css" % d,
            "site.css": "site.%s.css" % d,
            "LICENSE": "LICENSE.%s" % d,
            "a.tar.gz": "a.tar.%s.gz" % d,
            ".htaccess": ".htaccess.%s" % d,
            "img/v1.2/logo.min.js": "img/v1.2/logo.min.%s.js" % d,
            "dir.d/noext": "dir.d/noext.%s" % d,
        }
        for path, want in cases.items():
            self.assertEqual(assets.hashed_name(path, b"data"), want, path)

    def test_depends_on_content_only(self):
        self.assertNotEqual(assets.hashed_name("a.css", b"x"), assets.hashed_name("a.css", b"y"))
        self.assertEqual(assets.hashed_name("a.css", b"x")[2:-4], assets.hashed_name("b/a.css", b"x")[4:-4])
        self.assertEqual(len(digest(b"x")), 8)
        self.assertEqual(assets.hashed_name("a.css", b"x"), "a.%s.css" % digest(b"x"))
        self.assertEqual(assets.hashed_name("a.css", b""), "a.e3b0c442.css")


class CollectTest(unittest.TestCase):
    def test_collect_and_map(self):
        root = tempfile.mkdtemp()
        for rel, data in {"css/site.css": b"body{}", "robots.txt": b"x", "img/a/b.png": b"\x89PNG\x00"}.items():
            os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True)
            with open(os.path.join(root, rel), "wb") as handle:
                handle.write(data)
        files = assets.collect(root)
        self.assertEqual(files, {"css/site.css": b"body{}", "robots.txt": b"x", "img/a/b.png": b"\x89PNG\x00"})
        mapping = assets.build_map(files)
        self.assertEqual(mapping, {
            "/static/css/site.css": "/static/css/site.%s.css" % digest(b"body{}"),
            "/static/robots.txt": "/static/robots.%s.txt" % digest(b"x"),
            "/static/img/a/b.png": "/static/img/a/b.%s.png" % digest(b"\x89PNG\x00")})

    def test_missing_folder(self):
        self.assertEqual(assets.collect(os.path.join(tempfile.mkdtemp(), "nope")), {})
        self.assertEqual(assets.build_map({}), {})


class RewriteTest(unittest.TestCase):
    M = {"/static/a.css": "/static/a.1.css", "/static/img/x.png": "/static/img/x.2.png"}

    def test_replaces_exact_values(self):
        html = '<link href="/static/a.css"><img src="/static/img/x.png"><a href="/static/a.css">'
        self.assertEqual(assets.rewrite(html, self.M),
                         '<link href="/static/a.1.css"><img src="/static/img/x.2.png"><a href="/static/a.1.css">')

    def test_leaves_everything_else(self):
        for html in ['<a href="/static/a.css?v=1">', '<a href="/static/a.cssx">', '<a href="/static/other.css">',
                     '<a data-src="/static/a.css">', "<a href='/static/a.css'>", "see /static/a.css here",
                     '<a href="/static/a.css#top">', '<a href="static/a.css">', '<a title="/static/a.css">',
                     '<a href=" /static/a.css">',
                     '<a xlink:href="/static/a.css">']:
            self.assertEqual(assets.rewrite(html, self.M), html)

    def test_empty_mapping_and_text(self):
        self.assertEqual(assets.rewrite('<a href="/static/a.css">', {}), '<a href="/static/a.css">')
        self.assertEqual(assets.rewrite("", self.M), "")


def links(pages, files=()):
    return check_links(pages, files)


class LinksTest(unittest.TestCase):
    def test_clean_site(self):
        pages = {
            "index.html": '<a href="/about/">a</a> <a href="/about/index.html">b</a> <a href="https://x.org/nope">e</a>'
                          ' <a href="mailto:a@b.c">m</a> <a href="//cdn.x/y">c</a> <a href="HTTP://X/Y">u</a>'
                          ' <a href="javascript:void(0)">j</a> <a href="#top">t</a> <a href="#">h</a> <a href="">e</a>'
                          ' <h1 id="top">T</h1> <a href="/static/a.1.css">s</a> <a href="/">root</a>',
            "about/index.html": '<a href="..">up</a> <a href="../">up2</a> <a href=".">me</a> <a href="./">me2</a>',
        }
        self.assertEqual(links(pages, ["static/a.1.css"]), [])

    def test_broken_links(self):
        pages = {"index.html": '<a href="/nope/">x</a> <a href="/about">y</a> <img src="/img/x.png"> <a href="a.html">z</a>',
                 "about/index.html": ""}
        self.assertEqual(links(pages), [
            'index.html: broken link "/nope/"', 'index.html: broken link "/about"',
            'index.html: broken link "/img/x.png"', 'index.html: broken link "a.html"'])

    def test_relative_resolution(self):
        pages = {"posts/hello/index.html": '<a href="../world/">1</a> <a href="../../about/">2</a> <a href="/posts/world/">3</a> '
                                           '<a href="../..">4</a> <a href="../../..">5</a> <a href="../../../x/">6</a> '
                                           '<a href="./../world/./">7</a> <a href="../../a//b/">8</a> <a href="../../a/b/../../about/">9</a>',
                 "posts/world/index.html": "", "about/index.html": "", "index.html": "", "a/b/index.html": ""}
        self.assertEqual(links(pages), [
            'posts/hello/index.html: broken link "../../.."', 'posts/hello/index.html: broken link "../../../x/"'])

    def test_relative_files_next_to_the_page(self):
        pages = {"posts/hello/index.html": '<a href="notes.txt">n</a> <img src="pic.png"> <a href="other.txt">o</a>'}
        self.assertEqual(links(pages, ["posts/hello/notes.txt", "posts/hello/pic.png"]),
                         ['posts/hello/index.html: broken link "other.txt"'])

    def test_anchors(self):
        pages = {
            "index.html": '<h1 id="top">T</h1><a href="#top">1</a> <a href="#nope">2</a> <a href="#Top">3</a>'
                          ' <a href="/about/#team">4</a> <a href="/about/#nope">5</a> <a href="/about/#TEAM">6</a>'
                          ' <a href="/gone/#team">7</a> <a href="/static/a.css#x">8</a> <a href="/about/?x=1#team">9</a>'
                          ' <a href="?x=1#top">10</a> <a href="/about/?x=1">11</a> <a href="/about/#foo">12</a>',
            "about/index.html": '<h2 id="team">Team</h2><span data-id="foo">x</span>',
        }
        self.assertEqual(links(pages, ["static/a.css"]), [
            'index.html: broken anchor "#nope"', 'index.html: broken anchor "#Top"',
            'index.html: broken anchor "/about/#nope"', 'index.html: broken anchor "/about/#TEAM"',
            'index.html: broken link "/gone/#team"', 'index.html: broken anchor "/about/#foo"'])

    def test_attribute_names_must_stand_alone(self):
        pages = {"index.html": '<a data-href="/nope/">x</a> <a x-src="/nope/">y</a> <a title="href=&quot;/nope/&quot;">z</a>'}
        self.assertEqual(links(pages), [])

    def test_order_and_duplicates(self):
        pages = {"b/index.html": '<a href="/x">1</a> <a href="/y">2</a> <a href="/x">3</a>',
                 "a/index.html": '<a href="/z">4</a>', "index.html": '<a href="/b/#q">5</a>'}
        self.assertEqual(links(pages), [
            'a/index.html: broken link "/z"', 'b/index.html: broken link "/x"', 'b/index.html: broken link "/y"',
            'b/index.html: broken link "/x"', 'index.html: broken anchor "/b/#q"'])

    def test_accepts_any_iterable_of_files(self):
        pages = {"index.html": '<a href="/f.txt">f</a>'}
        self.assertEqual(links(pages, iter(["f.txt"])), [])
        self.assertEqual(links(pages, set()), ['index.html: broken link "/f.txt"'])
        self.assertEqual(links({}, []), [])


if __name__ == "__main__":
    unittest.main()
