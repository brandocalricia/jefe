import contextlib
import datetime
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from pagewright import build as builder
from pagewright.cli import main
from pagewright.content import parse_page

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXED = 1_000_000_000_000_000_000
TODAY = datetime.date(2026, 5, 31)
CSS = b"body{}"

TEMPLATES = {
    "page.html": '<h1>{{ page.title }}</h1>{{{ content }}}<link rel="stylesheet" href="/static/css/site.css">',
    "home.html": '<ul>{% for p in posts %}<li><a href="{{ p.url }}">{{ p.title }}</a></li>{% endfor %}</ul>'
                 '<link href="/static/css/site.css">',
    "tag.html": "<h1>{{ tag.name }}</h1>",
    "tags.html": '<ul>{% for t in tags %}<li><a href="{{ t.url }}">{{ t.name }}</a></li>{% endfor %}</ul>',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()[:8]


def css_name(data=CSS):
    return "static/css/site.%s.css" % digest(data)


def write(root, rel, data):
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data if isinstance(data, bytes) else data.encode("utf-8"))


def snapshot(root):
    found = {}
    for base, _dirs, names in os.walk(root):
        for name in names:
            full = os.path.join(base, name)
            with open(full, "rb") as handle:
                found[os.path.relpath(full, root).replace(os.sep, "/")] = handle.read()
    return found


class CliCase(unittest.TestCase):
    def make_site(self, content=None, templates=None, static=None, config="title: T\nper_page: 5\n"):
        site = tempfile.mkdtemp()
        write(site, "config.txt", config)
        for name, text in (TEMPLATES if templates is None else templates).items():
            write(site, "templates/" + name, text)
        default = {"about.md": "---\ntitle: About\n---\nAbout us.\n",
                   "posts/one.md": "---\ntitle: One\ndate: 2026-01-01\ntags: [a]\n---\nFirst.\n"}
        for name, text in (default if content is None else content).items():
            write(site, "content/" + name, text)
        for name, data in ({"css/site.css": CSS} if static is None else static).items():
            write(site, "static/" + name, data)
        return site

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(list(args))
        return code, out.getvalue(), err.getvalue()

    def build(self, site, out, date="2026-05-31", *extra):
        return self.run_cli("build", site, "--out", out, "--date", date, *extra)

    def freeze(self, out):
        for rel in snapshot(out):
            os.utime(os.path.join(out, *rel.split("/")), ns=(FIXED, FIXED))

    def mtime(self, out, rel):
        return os.stat(os.path.join(out, *rel.split("/"))).st_mtime_ns


class PlanTest(CliCase):
    def test_plan(self):
        site = self.make_site(content={"about.md": "---\ntitle: About\n---\nCafé ☕\n"})
        plan = builder.plan(site, TODAY)
        self.assertIn('href="/%s"' % css_name(), plan.pages["index.html"])
        self.assertNotIn('href="/static/css/site.css"', plan.pages["index.html"])
        self.assertEqual(plan.assets, {css_name(): CSS})
        files = plan.files()
        self.assertEqual(sorted(files), ["about/index.html", "index.html", "static/css/site.%s.css" % digest(CSS), "tags/index.html"])
        self.assertTrue(all(isinstance(v, bytes) for v in files.values()))
        self.assertIn("Café ☕".encode("utf-8"), files["about/index.html"])
        self.assertEqual(files["index.html"].decode("utf-8"), plan.pages["index.html"])

    def test_unknown_static_references_are_left_alone(self):
        tpl = dict(TEMPLATES, **{"home.html": '<link href="/static/nope.css"><link href="/static/css/site.css?v=2">'})
        plan = builder.plan(self.make_site(templates=tpl), TODAY)
        self.assertEqual(plan.pages["index.html"], '<link href="/static/nope.css"><link href="/static/css/site.css?v=2">')

    def test_no_static_folder(self):
        site = self.make_site(static={})
        self.assertEqual(builder.plan(site, TODAY).assets, {})


class BuildTest(CliCase):
    def test_first_build_report_and_files(self):
        site, out = self.make_site(), os.path.join(tempfile.mkdtemp(), "out")
        code, stdout, stderr = self.build(site, out)
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(stdout, "write about/index.html\nwrite index.html\nwrite posts/one/index.html\n"
                                 "write %s\nwrite tags/a/index.html\nwrite tags/index.html\n"
                                 "built 6 files: 6 written, 0 kept, 0 removed\n" % css_name())
        files = snapshot(out)
        self.assertEqual(files[css_name()], CSS)
        self.assertEqual(files["posts/one/index.html"].decode(), '<h1>One</h1><p>First.</p>\n<link rel="stylesheet" href="/%s">' % css_name())
        manifest = sorted(k for k in files if k != ".pagewright-manifest.json")
        self.assertEqual(files[".pagewright-manifest.json"].decode(), json.dumps({"files": manifest}, indent=2) + "\n")
        self.assertEqual(len(manifest), 6)

    def test_second_build_touches_nothing(self):
        site, out = self.make_site(), tempfile.mkdtemp()
        self.build(site, out)
        self.freeze(out)
        before = snapshot(out)
        # The frozen time is far in the past and a whole number of seconds, so a rewrite (even with
        # identical bytes) always shows up as a different modification time, on any file system.
        # Read-only files also make an attempt to open them for writing fail (a no-op when run as root).
        for rel in before:
            os.chmod(os.path.join(out, *rel.split("/")), 0o444)
        self.addCleanup(lambda: [os.chmod(os.path.join(out, *rel.split("/")), 0o644) for rel in before])
        code, stdout, _ = self.build(site, out)
        self.assertEqual(code, 0)
        self.assertEqual(stdout.splitlines()[-1], "built 6 files: 0 written, 6 kept, 0 removed")
        self.assertEqual(set(l.split()[0] for l in stdout.splitlines()[:-1]), {"keep"})
        self.assertEqual(snapshot(out), before)
        for rel in before:
            self.assertEqual(self.mtime(out, rel), FIXED, rel)

    def test_only_content_decides_not_time_or_size(self):
        site, out = self.make_site(), tempfile.mkdtemp()
        self.build(site, out)
        self.freeze(out)
        path = os.path.join(out, "about", "index.html")
        with open(path, "rb") as handle:
            good = handle.read()
        with open(path, "wb") as handle:  # same size, different bytes, old time
            handle.write(b"x" * len(good))
        os.utime(path, ns=(FIXED, FIXED))
        other = os.path.join(out, "index.html")
        newer = FIXED + 5_000_000_000  # same bytes, newer time: still unchanged
        os.utime(other, ns=(newer, newer))
        code, stdout, _ = self.build(site, out)
        lines = stdout.splitlines()
        self.assertEqual(lines[0], "write about/index.html")
        self.assertEqual(lines[1], "keep index.html")
        self.assertEqual(lines[-1], "built 6 files: 1 written, 5 kept, 0 removed")
        with open(path, "rb") as handle:
            self.assertEqual(handle.read(), good)
        self.assertEqual(self.mtime(out, "index.html"), newer)

    def test_only_changed_outputs_are_rewritten(self):
        site, out = self.make_site(), tempfile.mkdtemp()
        self.build(site, out)
        self.freeze(out)
        write(site, "content/about.md", "---\ntitle: About\n---\nAbout them.\n")
        code, stdout, _ = self.build(site, out)
        self.assertEqual(stdout.splitlines()[0], "write about/index.html")
        self.assertEqual(stdout.splitlines()[1:5], ["keep index.html", "keep posts/one/index.html", "keep " + css_name(), "keep tags/a/index.html"])
        self.assertEqual(stdout.splitlines()[-1], "built 6 files: 1 written, 5 kept, 0 removed")
        self.assertNotEqual(self.mtime(out, "about/index.html"), FIXED)
        for rel in ("index.html", "posts/one/index.html", css_name(), "tags/index.html"):
            self.assertEqual(self.mtime(out, rel), FIXED, rel)
        self.assertIn(b"About them.", snapshot(out)["about/index.html"])

    def test_changed_asset_gets_a_new_name_and_the_old_one_goes(self):
        site, out = self.make_site(), tempfile.mkdtemp()
        self.build(site, out)
        write(site, "static/css/site.css", b"body{color:red}")
        new = css_name(b"body{color:red}")
        code, stdout, _ = self.build(site, out)
        self.assertEqual(stdout.splitlines(), [
            "write about/index.html", "write index.html", "write posts/one/index.html", "write " + new,
            "keep tags/a/index.html", "keep tags/index.html", "remove " + css_name(),
            "built 6 files: 4 written, 2 kept, 1 removed"])
        files = snapshot(out)
        self.assertNotIn(css_name(), files)
        self.assertEqual(files[new], b"body{color:red}")
        self.assertIn(new.encode(), files["index.html"])

    def test_removed_page_and_empty_folders(self):
        site, out = self.make_site(), tempfile.mkdtemp()
        self.build(site, out)
        os.remove(os.path.join(site, "content", "posts", "one.md"))
        code, stdout, _ = self.build(site, out)
        self.assertEqual(stdout.splitlines(), [
            "keep about/index.html", "write index.html", "keep " + css_name(), "write tags/index.html",
            "remove posts/one/index.html", "remove tags/a/index.html", "built 4 files: 2 written, 2 kept, 2 removed"])
        self.assertFalse(os.path.exists(os.path.join(out, "posts")))
        self.assertFalse(os.path.exists(os.path.join(out, "tags", "a")))
        self.assertTrue(os.path.isdir(os.path.join(out, "tags")))
        manifest = json.loads(snapshot(out)[".pagewright-manifest.json"])
        self.assertEqual(manifest, {"files": ["about/index.html", "index.html", css_name(), "tags/index.html"]})

    def test_unlisted_files_are_never_touched(self):
        site, out = self.make_site(), tempfile.mkdtemp()
        write(out, "notes.txt", "mine")
        self.build(site, out)
        write(out, "posts/one/extra.txt", "mine too")
        os.remove(os.path.join(site, "content", "posts", "one.md"))
        self.build(site, out)
        files = snapshot(out)
        self.assertEqual((files["notes.txt"], files["posts/one/extra.txt"]), (b"mine", b"mine too"))
        self.assertNotIn("posts/one/index.html", files)

    def test_deep_folders_are_pruned_up_to_the_output_folder(self):
        site = self.make_site(content={"notes/2026/deep/talk.md": "---\ntitle: Talk\n---\n"})
        out = tempfile.mkdtemp()
        self.build(site, out)
        self.assertTrue(os.path.isfile(os.path.join(out, "notes", "2026", "deep", "talk", "index.html")))
        os.remove(os.path.join(site, "content", "notes", "2026", "deep", "talk.md"))
        code, stdout, _ = self.build(site, out)
        self.assertIn("remove notes/2026/deep/talk/index.html", stdout.splitlines())
        self.assertFalse(os.path.exists(os.path.join(out, "notes")))
        self.assertTrue(os.path.isdir(out))

    def test_missing_or_broken_manifest(self):
        for broken in (None, "not json at all"):
            site, out = self.make_site(), tempfile.mkdtemp()
            self.build(site, out)
            write(out, "stale.html", "stale")
            manifest = os.path.join(out, ".pagewright-manifest.json")
            if broken is None:
                os.remove(manifest)
            else:
                write(out, ".pagewright-manifest.json", broken)
            code, stdout, _ = self.build(site, out)
            self.assertEqual(code, 0, broken)
            self.assertEqual(stdout.splitlines()[-1], "built 6 files: 0 written, 6 kept, 0 removed", broken)
            self.assertTrue(os.path.exists(os.path.join(out, "stale.html")), broken)
            self.assertEqual(sorted(json.loads(snapshot(out)[".pagewright-manifest.json"])["files"]), sorted(k for k in snapshot(out) if k not in (".pagewright-manifest.json", "stale.html")))

    def test_failed_build_changes_nothing(self):
        site, out = self.make_site(), tempfile.mkdtemp()
        self.build(site, out)
        before = snapshot(out)
        write(site, "templates/page.html", "{{ nope }}")
        write(site, "static/css/site.css", b"changed")
        code, stdout, stderr = self.build(site, out)
        self.assertEqual((code, stdout), (1, ""))
        self.assertEqual(stderr, 'error: page.html:1: unknown variable "nope"\n')
        self.assertEqual(snapshot(out), before)
        fresh = os.path.join(tempfile.mkdtemp(), "never")
        self.assertEqual(self.build(site, fresh)[0], 1)
        self.assertFalse(os.path.exists(fresh))

    def test_missing_config(self):
        empty = tempfile.mkdtemp()
        code, stdout, stderr = self.build(empty, os.path.join(empty, "o"))
        self.assertEqual((code, stdout, stderr), (1, "", "error: config.txt not found in %s\n" % empty))

    def test_date_and_option_order(self):
        site = self.make_site(content={"posts/soon.md": "---\ntitle: Soon\ndate: 2026-06-01\n---\nx\n"})
        out = tempfile.mkdtemp()
        self.run_cli("build", "--date", "2026-05-31", site, "--out", out)
        self.assertNotIn("posts/soon/index.html", snapshot(out))
        self.run_cli("build", "--out", out, site, "--date", "2026-06-01")
        self.assertIn("posts/soon/index.html", snapshot(out))

    def test_default_output_folder_is_public(self):
        site, cwd = self.make_site(), tempfile.mkdtemp()
        old = os.getcwd()
        os.chdir(cwd)
        self.addCleanup(os.chdir, old)
        code, stdout, _ = self.run_cli("build", site, "--date", "2026-05-31")
        self.assertEqual(code, 0)
        self.assertTrue(os.path.isfile(os.path.join(cwd, "public", "index.html")))

    def test_builds_are_deterministic(self):
        site = self.make_site()
        a, b = tempfile.mkdtemp(), tempfile.mkdtemp()
        self.build(site, a)
        self.build(site, b)
        self.assertEqual(snapshot(a), snapshot(b))


class CheckTest(CliCase):
    def test_ok(self):
        site = self.make_site()
        before = snapshot(site)
        code, stdout, stderr = self.run_cli("check", site, "--date", "2026-05-31")
        self.assertEqual((code, stdout, stderr), (0, "ok: checked 5 pages\n", ""))
        self.assertEqual(snapshot(site), before)

    def test_problems(self):
        site = self.make_site(content={"about.md": "---\ntitle: About\n---\n[x](/nope/) and [y](/about/#zz) and [z](/posts/)\n"})
        code, stdout, stderr = self.run_cli("check", site, "--date", "2026-05-31")
        self.assertEqual(code, 1)
        self.assertEqual(stdout, 'about/index.html: broken link "/nope/"\nabout/index.html: broken anchor "/about/#zz"\n'
                                 'about/index.html: broken link "/posts/"\n3 problems\n')
        self.assertEqual(stderr, "")

    def test_one_problem_and_assets(self):
        tpl = dict(TEMPLATES, **{"home.html": '<link href="/static/missing.css"><link href="/static/css/site.css">'})
        site = self.make_site(templates=tpl, content={})
        code, stdout, _ = self.run_cli("check", site, "--date", "2026-05-31")
        self.assertEqual((code, stdout), (1, 'index.html: broken link "/static/missing.css"\n1 problem\n'))

    def test_hidden_pages_are_not_checked(self):
        site = self.make_site(content={"posts/d.md": "---\ntitle: D\ndate: 2026-01-01\ndraft: true\n---\n[x](/nope/)\n"})
        self.assertEqual(self.run_cli("check", site, "--date", "2026-05-31")[:2], (0, "ok: checked 2 pages\n"))

    def test_site_errors(self):
        tpl = dict(TEMPLATES, **{"home.html": "{{ nope }}"})
        site = self.make_site(templates=tpl)
        self.assertEqual(self.run_cli("check", site, "--date", "2026-05-31"),
                         (1, "", 'error: home.html:1: unknown variable "nope"\n'))


class NewTest(CliCase):
    def read(self, site, rel):
        with open(os.path.join(site, *rel.split("/")), encoding="utf-8", newline="") as handle:
            return handle.read()

    def test_creates_a_draft(self):
        site = tempfile.mkdtemp()
        code, stdout, stderr = self.run_cli("new", site, "My Title", "--date", "2026-11-17")
        self.assertEqual((code, stdout, stderr), (0, "created content/posts/my-title.md\n", ""))
        self.assertEqual(self.read(site, "content/posts/my-title.md"), '---\ntitle: "My Title"\ndate: 2026-11-17\ndraft: true\n---\n\n')

    def test_existing_file_is_kept(self):
        site = tempfile.mkdtemp()
        self.run_cli("new", site, "My Title", "--date", "2026-11-17")
        write(site, "content/posts/my-title.md", "changed")
        code, stdout, stderr = self.run_cli("new", site, "my   TITLE!", "--date", "2026-11-18")
        self.assertEqual((code, stdout, stderr), (1, "", "error: content/posts/my-title.md already exists\n"))
        self.assertEqual(self.read(site, "content/posts/my-title.md"), "changed")

    def test_quoting_round_trips(self):
        site = tempfile.mkdtemp()
        title = 'Say "hi" \\ now: ok'
        self.assertEqual(self.run_cli("new", site, title, "--date", "2026-11-17")[1], "created content/posts/say-hi-now-ok.md\n")
        text = self.read(site, "content/posts/say-hi-now-ok.md")
        self.assertIn('title: "Say \\"hi\\" \\\\ now: ok"\n', text)
        self.assertEqual(parse_page("x.md", text).title, title)

    def test_trimming_default_date_and_empty_slug(self):
        site = tempfile.mkdtemp()
        self.assertEqual(self.run_cli("new", site, "  Hello  ")[1], "created content/posts/hello.md\n")
        text = self.read(site, "content/posts/hello.md")
        self.assertRegex(text, r'\A---\ntitle: "Hello"\ndate: \d{4}-\d{2}-\d{2}\ndraft: true\n---\n\n\Z')
        self.assertEqual(self.run_cli("new", site, "???"), (1, "", 'error: cannot make a slug from "???"\n'))

    def test_new_post_is_a_draft_for_build(self):
        site, out = self.make_site(), tempfile.mkdtemp()
        self.run_cli("new", site, "Fresh Idea", "--date", "2026-05-01")
        code, stdout, _ = self.build(site, out)
        self.assertNotIn("fresh-idea", stdout)
        self.assertEqual(stdout.splitlines()[-1], "built 6 files: 6 written, 0 kept, 0 removed")


class UsageTest(CliCase):
    def test_usage_errors(self):
        site = self.make_site()
        cases = [[], ["frobnicate"], ["build"], ["check"], ["new", site], ["new", site, ""], ["new", site, "   "],
                 ["build", site, "--date", "tomorrow"], ["build", site, "--date", "2026-13-01"],
                 ["check", site, "--date", "2026-02-30"], ["check", site, "--date", "2026-2-3"],
                 ["build", site, "--out"], ["build", site, "--bogus"]]
        for args in cases:
            code, stdout, stderr = self.run_cli(*args)
            self.assertEqual(code, 2, args)
            self.assertEqual(stdout, "", args)
            self.assertTrue(stderr.startswith("error: "), (args, stderr))

    def test_main_returns_and_never_exits(self):
        for args in (["bogus"], [], ["build"], ["build", "x", "--date", "bad"]):
            try:
                self.run_cli(*args)
            except SystemExit:
                self.fail("main(%r) raised SystemExit" % (args,))

    def test_main_reads_sys_argv_by_default(self):
        site = self.make_site()
        out, err = io.StringIO(), io.StringIO()
        argv = ["pagewright", "check", site, "--date", "2026-05-31"]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main()
        self.assertEqual((code, out.getvalue(), err.getvalue()), (0, "ok: checked 5 pages\n", ""))

    def test_usage_errors_write_nothing(self):
        site, out = self.make_site(), os.path.join(tempfile.mkdtemp(), "out")
        self.assertEqual(self.run_cli("build", site, "--out", out, "--date", "nope")[0], 2)
        self.assertFalse(os.path.exists(out))

    def test_module_entry_point(self):
        site = self.make_site()
        run = lambda *a: subprocess.run([sys.executable, "-m", "pagewright", *a], cwd=ROOT, capture_output=True, text=True)
        ok = run("check", site, "--date", "2026-05-31")
        self.assertEqual((ok.returncode, ok.stdout), (0, "ok: checked 5 pages\n"))
        write(site, "content/about.md", "---\ntitle: A\n---\n[x](/nope/)\n")
        bad = run("check", site, "--date", "2026-05-31")
        self.assertEqual((bad.returncode, bad.stdout), (1, 'about/index.html: broken link "/nope/"\n1 problem\n'))
        self.assertEqual(run("bogus").returncode, 2)
        self.assertEqual(run("build", site, "--out", os.path.join(tempfile.mkdtemp(), "o"), "--date", "2026-05-31").returncode, 0)


if __name__ == "__main__":
    unittest.main()
