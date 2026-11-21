"""Part E: the conflicts section and the not-established section."""
import re
import unittest

import rc_lib as R


class PartE(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = R.read_report()
        cls.entries, cls.bad = R.conflict_entries(cls.text)
        cls.qs = R.question_blocks(cls.text)

    def test_every_line_is_a_well_formed_entry(self):
        self.assertEqual(self.bad, [])
        self.assertTrue(self.entries)

    def test_winner_and_loser_hold_one_citation_each(self):
        for e in self.entries:
            with self.subTest(topic=e["topic"][:40]):
                self.assertEqual(len(e["w"]), 1)
                self.assertEqual(len(e["l"]), 1)
                self.assertTrue(3 <= len(e["why"].split()) <= 40)

    def test_citations_in_entries_resolve(self):
        for e in self.entries:
            for f, a in e["w"] + e["l"]:
                with self.subTest(file=f, anchor=a):
                    self.assertTrue(R.anchor_resolves(f, a))

    def test_required_conflicts_present(self):
        for name, win, lose in R.REQUIRED_CONFLICTS:
            with self.subTest(conflict=name):
                self.assertTrue(
                    any(e["w"][0][0] == win and e["l"][0][0] in ((lose,) if isinstance(lose, str) else lose) for e in self.entries if e["w"] and e["l"]),
                    f"no entry with winner {win} and loser {lose}",
                )

    def test_no_superseded_or_blog_winner(self):
        banned = set(R.SUPERSEDED) | {R.BLOG}
        for e in self.entries:
            with self.subTest(topic=e["topic"][:40]):
                self.assertTrue(e["w"][0][0] not in banned)

    def test_no_required_loser_is_also_a_winner(self):
        winners = {e["w"][0][0] for e in self.entries}
        for _n, _w, lose in R.REQUIRED_CONFLICTS:
            for one in ((lose,) if isinstance(lose, str) else lose):
                self.assertNotIn(one, winners)

    def ne(self, n):
        self.assertIn(n, self.qs, f"Q{n} missing")
        return self.qs[n][1]

    def test_not_established_entries_say_the_corpus_does_not_say(self):
        for n in (9, 10):
            with self.subTest(q=n):
                self.assertRegex(self.ne(n), R.NOT_SAY)

    def test_not_established_entries_are_short_and_uncited(self):
        for n in (9, 10):
            body = self.ne(n)
            with self.subTest(q=n):
                self.assertNotIn("[corpus", body)
                self.assertLessEqual(len(body.split()), 40)
                self.assertLessEqual(len(R.sentences(body)), 2)
                self.assertGreaterEqual(len(R.sentences(body)), 1)

    def test_not_established_entries_have_no_numerals(self):
        for n in (9, 10):
            with self.subTest(q=n):
                # the metric name "p99" is allowed; any other digit is not
                plain = re.sub(r"(?i)\bp99\b", "", self.ne(n))
                self.assertIsNone(re.search(r"\d", plain))

    def test_not_established_entries_invent_no_place(self):
        self.assertIsNone(R.PLACE_RE.search(self.ne(10)))
        self.assertIsNone(R.PLACE_RE.search(self.ne(9)))

    def test_questions_section_does_not_answer_nine_or_ten(self):
        body = "\n".join(self.qs[n][1] for n in range(1, 9))
        self.assertNotRegex(body, r"(?i)50,?000 writes")
        self.assertNotRegex(body, r"(?i)\bregion\b")


if __name__ == "__main__":
    unittest.main()
