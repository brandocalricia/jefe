Our `linestat` tool prints the longest lines of a text file. Add a `--min-length` option so lines shorter than the given length are left out, and make it behave like the other options. The tests run with `npm test`.

ANSWERS:
- Language and runtime: plain JavaScript ES modules, Node 22, no dependencies
- Where: wherever the existing options are handled; add tests in tests/
- Scope: no new files except tests, no README or package changes, do not change how the existing options behave
