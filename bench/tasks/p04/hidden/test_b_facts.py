"""Part B: the key facts of each answer, and the facts that must not appear."""
import re
import unittest

import rc_lib as R

FACTS = R.build_facts()


class PartB(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.qs = R.question_blocks(R.read_report())

    def body(self, n):
        self.assertIn(n, self.qs, f"Q{n} missing")
        return self.qs[n][1]

    def check_q(self, n):
        for fact in FACTS[n]:
            with self.subTest(q=n, fact=fact["id"]):
                self.assertTrue(R.fact_stated(self.body(n), fact), f"Q{n} does not state: {fact['id']}")

    def check_forbidden(self, n):
        text = R.strip_cites(self.body(n))
        for bad in R.FORBID_NUMS[n]:
            with self.subTest(q=n, number=bad):
                vals = [v for _p, v in R.numbers_pos(text)]
                self.assertFalse(any(abs(v - bad) < 1e-9 for v in vals), f"Q{n} uses the outdated or refuted figure {bad}")
        for rx in R.FORBID_RE.get(n, []):
            with self.subTest(q=n, pattern=rx):
                self.assertIsNone(re.search(rx, text, re.I), f"Q{n} repeats a refuted claim ({rx})")

    def test_q1_requirements(self):
        self.check_q(1)
        self.check_forbidden(1)

    def test_q2_run_counts_and_exclusions(self):
        self.check_q(2)
        body = self.body(2)
        plain = R.strip_cites(body)
        with self.subTest(part="invalid runs excluded"):
            self.assertRegex(plain, r"(?i)invalid|valid\s*=\s*`?no|not valid|throttl|warm|failed")
        with self.subTest(part="ingest runs excluded"):
            self.assertRegex(plain, r"(?i)ingest|writes-only|write-only")
        with self.subTest(part="April runs excluded"):
            self.assertRegex(plain, r"(?i)april|pre-?release|before 2025-09-01|earlier|older|prior")

    def test_q3_mean_writes(self):
        self.check_q(3)
        self.check_forbidden(3)

    def test_q4_mean_p99(self):
        self.check_q(4)
        self.check_forbidden(4)

    def test_q5_monthly_cost(self):
        self.check_q(5)
        self.check_forbidden(5)

    def test_q6_percentages(self):
        self.check_q(6)

    def test_q7_papers(self):
        self.check_q(7)

    def test_q8_migration_and_restore(self):
        self.check_q(8)
        self.check_forbidden(8)

    def test_recommended_engine_is_the_adopted_one(self):
        m = re.search(r"^Recommended engine: (\w+)\s*$", R.read_report(), re.M)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "HarborDB")

    def test_answers_do_not_cite_or_name_blog_claims(self):
        for n in range(1, 9):
            with self.subTest(q=n):
                self.assertNotIn(R.BLOG, {f for f, _a in R.citations(self.body(n))})


if __name__ == "__main__":
    unittest.main()
