"""Part A: structure and limits."""
import json
import re
import unittest

import rc_lib as R

H2 = ["Summary", "Questions", "Decision table", "Conflicts and superseded sources", "Not established"]
COLS = ["Engine", "Mean writes/s", "Mean read p99 ms", "Meets write target", "Meets p99 target", "Monthly cost USD", "Within budget", "Verdict"]


class PartA(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert R.REPORT.is_file(), "report/REPORT.md is missing"
        cls.text = R.read_report()
        cls.hs = R.headings(cls.text)
        cls.qs = R.question_blocks(cls.text)

    def test_corpus_unchanged(self):
        self.assertEqual(R.corpus_digest(), R.CORPUS_SHA256)

    def test_title_heading(self):
        h1 = [t for _i, l, t in self.hs if l == 1]
        self.assertEqual(h1, ["Storage Engine Decision Report"])
        self.assertEqual(self.hs[0][1:], (1, "Storage Engine Decision Report"))

    def test_level2_headings_exact_and_ordered(self):
        self.assertEqual([t for _i, l, t in self.hs if l == 2], H2)

    def test_level3_headings_are_the_ten_questions(self):
        h3 = [t for _i, l, t in self.hs if l == 3]
        self.assertEqual(len(h3), 10)
        self.assertEqual([int(re.match(r"Q(\d+)\.\s+\S", t).group(1)) for t in h3], list(range(1, 11)))

    def test_no_deeper_headings(self):
        self.assertFalse([t for _i, l, t in self.hs if l > 3])

    def test_questions_placed_under_right_sections(self):
        for n in range(1, 9):
            self.assertEqual(self.qs[n][0], "Questions", f"Q{n}")
        for n in (9, 10):
            self.assertEqual(self.qs[n][0], "Not established", f"Q{n}")

    def test_summary_is_one_line(self):
        sec = [l.strip() for l in R.section_lines(self.text, "Summary") if l.strip()]
        self.assertEqual(len(sec), 1)
        self.assertRegex(sec[0], r"^Recommended engine: (HarborDB|BasaltKV|QuillStore)$")

    def test_each_answer_within_120_words(self):
        for n in range(1, 9):
            with self.subTest(q=n):
                w = len(R.words(self.qs[n][1]))
                self.assertGreater(w, 0)
                self.assertLessEqual(w, 120)

    def test_overall_within_1500_words(self):
        self.assertLessEqual(len(R.words(self.text)), 1500)

    def test_decision_table_header_exact(self):
        rows = R.table_rows(self.text)
        self.assertTrue(rows)
        self.assertEqual(rows[0], COLS)

    def test_decision_table_three_engine_rows(self):
        rows = R.table_rows(self.text)[1:]
        self.assertEqual(sorted(r[0] for r in rows), sorted(R.ENGINES))
        for r in rows:
            self.assertEqual(len(r), 8)

    def test_sources_json_shape(self):
        data = json.loads(R.SOURCES.read_text(encoding="utf-8"))
        self.assertIsInstance(data, dict)
        self.assertEqual(list(data), ["sources"])
        self.assertIsInstance(data["sources"], list)
        for e in data["sources"]:
            self.assertEqual(sorted(e), ["file", "reason"])


if __name__ == "__main__":
    unittest.main()
