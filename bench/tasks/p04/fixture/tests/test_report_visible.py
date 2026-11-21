"""A sample of the structure rules from SPEC.md Part A."""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "report" / "REPORT.md"
HEADINGS = [
    "# Storage Engine Decision Report",
    "## Summary",
    "## Questions",
    "## Decision table",
    "## Conflicts and superseded sources",
    "## Not established",
]


class VisibleStructure(unittest.TestCase):
    def setUp(self):
        self.assertTrue(REPORT.is_file(), "report/REPORT.md is missing")
        self.text = REPORT.read_text(encoding="utf-8")

    def test_fixed_headings_in_order(self):
        found = [l.rstrip() for l in self.text.splitlines() if re.match(r"#{1,2} ", l)]
        self.assertEqual(found, HEADINGS)

    def test_question_headings(self):
        nums = [int(m) for m in re.findall(r"^### Q(\d+)\. ", self.text, re.M)]
        self.assertEqual(nums, list(range(1, 11)))

    def test_summary_line(self):
        m = re.search(r"^Recommended engine: (HarborDB|BasaltKV|QuillStore)\s*$", self.text, re.M)
        self.assertIsNotNone(m)

    def test_sources_json_parses(self):
        data = json.loads((ROOT / "report" / "sources.json").read_text(encoding="utf-8"))
        self.assertIsInstance(data.get("sources"), list)
        self.assertTrue(data["sources"])


if __name__ == "__main__":
    unittest.main()
