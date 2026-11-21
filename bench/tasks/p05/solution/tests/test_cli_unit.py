import contextlib
import io
import os
import tempfile
import unittest

from pagewright.cli import main


class CliUnitTest(unittest.TestCase):
    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(list(args))
        return code, out.getvalue(), err.getvalue()

    def test_usage(self):
        self.assertEqual(self.run_cli()[0], 2)
        self.assertEqual(self.run_cli("build", "x", "--date", "nope")[0], 2)

    def test_new_creates_a_draft(self):
        site = tempfile.mkdtemp()
        self.assertEqual(self.run_cli("new", site, "A B", "--date", "2026-01-02"), (0, "created content/posts/a-b.md\n", ""))
        with open(os.path.join(site, "content", "posts", "a-b.md")) as handle:
            self.assertEqual(handle.read(), '---\ntitle: "A B"\ndate: 2026-01-02\ndraft: true\n---\n\n')
        self.assertEqual(self.run_cli("new", site, "A B")[0], 1)


if __name__ == "__main__":
    unittest.main()
