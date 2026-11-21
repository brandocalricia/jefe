import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from wordfreq import top_words  # noqa: E402


class TopWordsTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(top_words("the cat and the hat and the bat", 2), [("the", 3), ("and", 2)])


if __name__ == "__main__":
    unittest.main()
