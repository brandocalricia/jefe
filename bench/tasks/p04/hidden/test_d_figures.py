"""Part D: computed figures and the decision table."""
import re
import unittest

import rc_lib as R

COLS = ["Engine", "Mean writes/s", "Mean read p99 ms", "Meets write target", "Meets p99 target", "Monthly cost USD", "Within budget", "Verdict"]


class PartD(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = R.read_report()
        cls.fig = R.figures()
        rows = R.table_rows(cls.text)
        cls.rows = {r[0]: dict(zip(COLS, (R.norm_cell(c) for c in r))) for r in rows[1:]}

    def num(self, eng, col):
        self.assertIn(eng, self.rows)
        try:
            return float(self.rows[eng][col])
        except ValueError:
            self.fail(f"{eng}/{col}: not a plain number: {self.rows[eng][col]!r}")

    def test_reference_figures_are_what_the_spec_says(self):
        f = self.fig
        self.assertEqual(
            [int(f[e]["writes_r"]) for e in R.ENGINES] + [float(f[e]["p99_r"]) for e in R.ENGINES],
            [14313, 9040, 21838, 12.0, 8.0, 31.1],
        )
        self.assertEqual((float(f["disk_drop_pct"]), float(f["rise_pct"])), (37.7, 44.1))

    def test_table_mean_writes(self):
        for e in R.ENGINES:
            with self.subTest(engine=e):
                self.assertEqual(self.num(e, "Mean writes/s"), float(self.fig[e]["writes_r"]))

    def test_table_mean_p99(self):
        for e in R.ENGINES:
            with self.subTest(engine=e):
                self.assertAlmostEqual(self.num(e, "Mean read p99 ms"), float(self.fig[e]["p99_r"]), places=6)

    def test_table_monthly_cost(self):
        for e in R.ENGINES:
            with self.subTest(engine=e):
                self.assertEqual(self.num(e, "Monthly cost USD"), float(self.fig[e]["cost"]))

    def test_table_yes_no_columns(self):
        for e in R.ENGINES:
            with self.subTest(engine=e):
                self.assertEqual(self.rows[e]["Meets write target"], self.fig[e]["meets_w"])
                self.assertEqual(self.rows[e]["Meets p99 target"], self.fig[e]["meets_p"])
                self.assertEqual(self.rows[e]["Within budget"], self.fig[e]["in_budget"])

    def test_table_verdicts(self):
        for e in R.ENGINES:
            with self.subTest(engine=e):
                self.assertEqual(self.rows[e]["Verdict"], self.fig[e]["verdict"])
        self.assertEqual([e for e in R.ENGINES if self.rows[e]["Verdict"] == "adopt"], ["HarborDB"])

    def test_table_has_no_citations(self):
        sec = "\n".join(R.section_lines(self.text, "Decision table"))
        self.assertEqual(R.citations(sec), [])
        self.assertNotIn("[corpus", sec)

    def test_summary_matches_table(self):
        m = re.search(r"^Recommended engine: (\w+)\s*$", self.text, re.M)
        adopted = [e for e in R.ENGINES if self.rows[e]["Verdict"] == "adopt"]
        self.assertEqual([m.group(1)], adopted)

    def test_q6_percent_figures_in_answer(self):
        body = R.question_blocks(self.text)[6][1]
        vals = [v for _p, v in R.numbers_pos(body)]
        for key in ("disk_drop_pct", "rise_pct"):
            with self.subTest(figure=key):
                self.assertTrue(any(abs(v - float(self.fig[key])) < 1e-6 for v in vals))

    def test_answer_figures_match_table(self):
        qs = R.question_blocks(self.text)
        for n, col in ((3, "Mean writes/s"), (4, "Mean read p99 ms"), (5, "Monthly cost USD")):
            for e in R.ENGINES:
                with self.subTest(q=n, engine=e):
                    want = self.num(e, col)
                    hit = any(abs(v - want) < 1e-6 and R.nearest_engine(R.strip_cites(sent), p) == e
                              for sent in R.sentences(qs[n][1]) for p, v in R.numbers_pos(sent))
                    self.assertTrue(hit)


if __name__ == "__main__":
    unittest.main()
