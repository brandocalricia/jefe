"""Part C: citations and sources.json."""
import json
import re
import unittest

import rc_lib as R

FACTS = R.build_facts()


class PartC(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = R.read_report()
        cls.qs = R.question_blocks(cls.text)
        cls.entries, _bad = R.conflict_entries(cls.text)

    def test_citations_are_well_formed(self):
        loose = R.CIT_LOOSE.findall(self.text)
        strict = [m.group(0) for m in R.CIT_RE.finditer(self.text)]
        self.assertTrue(strict)
        self.assertEqual(sorted(loose), sorted(strict), "malformed citation present")

    def test_every_citation_resolves(self):
        cites = R.citations(self.text)
        self.assertTrue(cites)
        for f, a in sorted(set(cites)):
            with self.subTest(file=f, anchor=a):
                self.assertTrue((R.CORPUS / f).is_file(), f"no such file {f}")
                self.assertTrue(R.anchor_resolves(f, a), f"anchor {a} not found in {f}")

    def test_every_answer_sentence_ends_with_a_citation(self):
        for n in range(1, 9):
            body = self.qs[n][1]
            sents = R.sentences(body)
            with self.subTest(q=n):
                self.assertTrue(sents)
                for s in sents:
                    self.assertRegex(s, r"\](\s*\[corpus/[^\]]+\])*$", f"uncited sentence in Q{n}: {s[:60]}")

    def test_every_answer_has_a_citation(self):
        for n in range(1, 9):
            with self.subTest(q=n):
                self.assertTrue(R.citations(self.qs[n][1]))

    def test_key_figures_come_from_acceptable_documents(self):
        for n, facts in FACTS.items():
            for fact in facts:
                with self.subTest(q=n, fact=fact["id"]):
                    self.assertTrue(R.fact_sourced(self.qs[n][1], fact),
                                    f"Q{n}: '{fact['id']}' is not cited to a document that contains it")

    def test_superseded_documents_come_with_their_superseder(self):
        blocks = [self.qs[n][1] for n in range(1, 9)] + [e["raw"] for e in self.entries]
        for block in blocks:
            files = {f for f, _a in R.citations(block)}
            for old, new in R.SUPERSEDED.items():
                if old in files:
                    with self.subTest(old=old):
                        self.assertIn(new, files)

    def test_blog_cited_only_with_measurements_in_conflicts(self):
        for n in range(1, 9):
            self.assertNotIn(R.BLOG, {f for f, _a in R.citations(self.qs[n][1])})
        for e in self.entries:
            files = {f for f, _a in R.citations(e["raw"])}
            if R.BLOG in files:
                self.assertIn(R.CSV_NAME, files)
        outside = "\n".join(self.qs[n][1] for n in (9, 10))
        self.assertEqual(R.citations(outside), [])

    def test_sources_json_matches_cited_files(self):
        data = json.loads(R.SOURCES.read_text(encoding="utf-8"))
        files = [e["file"] for e in data["sources"]]
        self.assertEqual(len(files), len(set(files)), "duplicate entries")
        cited = {"corpus/" + f for f in R.all_cited_files(self.text)}
        self.assertEqual(set(files), cited)

    def test_sources_json_reasons(self):
        data = json.loads(R.SOURCES.read_text(encoding="utf-8"))
        for e in data["sources"]:
            with self.subTest(file=e["file"]):
                self.assertTrue((R.ROOT / e["file"]).is_file())
                self.assertIsInstance(e["reason"], str)
                self.assertNotIn("\n", e["reason"].strip())
                self.assertTrue(3 <= len(e["reason"].split()) <= 25)


if __name__ == "__main__":
    unittest.main()
