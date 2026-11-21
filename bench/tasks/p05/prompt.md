We want to retire the hand-edited HTML for the chess club newsletter, so please build `pagewright`, a small static-site generator, from the near-empty repository in front of you. `README.md` says what it is for and `SPEC.md` is the full specification: five parts (content loading, the template language, site structure, asset hashing and link checking, and the command line with an incremental build) with exact file formats, function signatures, error messages and output formats. Follow it to the letter, since other tools and checks will rely on the exact strings. `site/` holds a small example site you can try it on, and `tests/` has a few sample tests; add your own tests for the rest, in `tests/` too, and keep `python3 -m unittest discover -s tests` green.

The pieces build on each other: the markdown and front matter code feeds the template rendering, which feeds the site builder, which feeds the link checker and the CLI.

ANSWERS:
- Language and runtime: Python 3.11, standard library only (no third-party markdown, template or CLI libraries)
- Where: the `pagewright/` package using the module names SPEC.md gives; tests in `tests/` named `test_*.py`
- Design: pure functions where SPEC.md describes return values, exact strings and exit codes as written, never read the clock except for the default `--date`; no new files outside the package, tests and `site/`
- Scope: only what SPEC.md describes; no watch mode, no preview server, no extra markdown features, no config options beyond the ones listed
