Please write `top_words(text, n)` in `src/wordfreq.py`. It returns the `n` most common words in `text` as a list of `(word, count)` tuples, most common first, with ties broken alphabetically.

A word is a run of letters and digits, and it may contain apostrophes between its letters, so `don't` is one word, but quotes around a word are not part of it. Anything else separates words. Matching ignores case, and the words come back lowercased. Our texts have accents and some are typed with a base letter plus a combining accent, so `café` written either way is the same word. `n` larger than the number of distinct words returns all of them, `n` of 0 or empty text returns `[]`, and a negative `n` raises `ValueError`. It will be run on files with millions of words, so keep it fast.

Plain Python 3, standard library only; tests run with `python3 -m unittest discover -s tests`. Add tests under `tests/`.

ANSWERS:
- Language and runtime: Python 3, standard library only
- Where: src/wordfreq.py only; tests in tests/
- Scope: no CLI, no new dependencies, no README
