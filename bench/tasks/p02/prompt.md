Our shop's inventory and order system is one 600-line file, `src/stockroom.py`, with global state, three slightly different copies of the pricing code, and parsing, reports and file handling all mixed together. I need it refactored into a proper package without changing what it does. The full requirements are in `SPEC.md` in the repo root. Please read it first, it has the exact names, signatures, messages and output formats, and it lists the two places where the old code disagrees with itself and which behaviour is the right one.

In short: split it into a `warehouse/` package built around a `Warehouse` object, put every pricing rule in one place, put storage behind a small interface with a JSON file version and an in-memory version, keep `stockroom.py` as a thin compatibility layer that warns it is deprecated, and rebuild the command line on the new package (plus one new command). `tests/test_characterisation.py` must keep passing. Add tests of your own for the new code under `tests/`, and make `python3 -m unittest discover -s tests` pass.

ANSWERS:
- Language and runtime: Python 3.11, standard library only, tests with unittest
- Where things go: the new package in src/warehouse/, the old src/stockroom.py and src/stockroom_cli.py stay as thin wrappers, new tests in tests/
- Design constraints: no global mutable state in the package; behaviour, messages and output formats exactly as SPEC.md says; the two documented pricing discrepancies are fixed the way SPEC.md says
- Scope: no new dependencies; do not touch data/, SPEC.md or the existing characterisation test; no packaging or README changes
