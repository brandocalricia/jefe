import os
import random
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from wordfreq import top_words  # noqa: E402


class HiddenTopWords(unittest.TestCase):
    def test_ranking_and_ties(self):
        text = "b a c b a d"
        self.assertEqual(top_words(text, 4), [("a", 2), ("b", 2), ("c", 1), ("d", 1)])
        self.assertEqual(top_words(text, 3), [("a", 2), ("b", 2), ("c", 1)])

    def test_case_insensitive_and_lowercased(self):
        self.assertEqual(top_words("Apple apple APPLE Banana", 5), [("apple", 3), ("banana", 1)])

    def test_apostrophes(self):
        self.assertEqual(top_words("don't Don't DON'T stop", 2), [("don't", 3), ("stop", 1)])
        self.assertEqual(top_words("'hello' 'hello' world", 2), [("hello", 2), ("world", 1)])
        self.assertEqual(top_words("rock 'n' roll", 3), [("n", 1), ("rock", 1), ("roll", 1)])

    def test_digits_underscore_and_punctuation_separate(self):
        self.assertEqual(top_words("route 66, route 66; route-66", 3), [("66", 3), ("route", 3)])
        self.assertEqual(top_words("snake_case snake", 3), [("snake", 2), ("case", 1)])

    def test_accents_precomposed_and_decomposed_are_one_word(self):
        composed = "caf\u00e9"
        decomposed = "cafe\u0301"
        self.assertEqual(top_words(f"{composed} {decomposed} {composed.upper()} cafe", 3), [("caf\u00e9", 3), ("cafe", 1)])

    def test_unicode_words(self):
        self.assertEqual(top_words("Привет мир привет 日本語 日本語", 3), [("привет", 2), ("日本語", 2), ("мир", 1)])

    def test_edge_sizes(self):
        self.assertEqual(top_words("", 5), [])
        self.assertEqual(top_words("   \n\t ,.;", 5), [])
        self.assertEqual(top_words("a b", 0), [])
        self.assertEqual(top_words("a b", 10), [("a", 1), ("b", 1)])

    def test_negative_n(self):
        with self.assertRaises(ValueError):
            top_words("a b", -1)
        with self.assertRaises(ValueError):
            top_words("", -1)

    def test_returns_tuples_in_a_list(self):
        r = top_words("x x y", 2)
        self.assertIsInstance(r, list)
        self.assertTrue(all(isinstance(t, tuple) and len(t) == 2 for t in r))

    def test_large_input_is_fast(self):
        rng = random.Random(7)
        vocab = [f"w{i}" for i in range(50000)]
        words = [vocab[min(int(rng.expovariate(1 / 3000)), 49999)] for _ in range(1_000_000)]
        text = " ".join(words)
        start = time.time()
        result = top_words(text, 3)
        elapsed = time.time() - start
        self.assertLess(elapsed, 6.0)
        self.assertEqual(len(result), 3)
        self.assertGreaterEqual(result[0][1], result[1][1])
        self.assertGreaterEqual(result[1][1], result[2][1])
        self.assertEqual(sum(1 for w in words if w == result[0][0]), result[0][1])


if __name__ == "__main__":
    unittest.main()
