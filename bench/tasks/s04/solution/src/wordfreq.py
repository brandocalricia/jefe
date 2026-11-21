"""Word frequency counting."""

import heapq
import re
import unicodedata
from collections import Counter

# letters and digits, with single apostrophes allowed between them
_WORD = re.compile(r"[^\W_]+(?:'[^\W_]+)*")


def top_words(text, n):
    """Return the n most common words in text as (word, count) tuples."""
    if n < 0:
        raise ValueError("n must not be negative")
    if n == 0 or not text:
        return []
    text = unicodedata.normalize("NFC", text.casefold())
    text = unicodedata.normalize("NFC", text)
    counts = Counter(_WORD.findall(text))
    return heapq.nsmallest(n, counts.items(), key=lambda kv: (-kv[1], kv[0]))
