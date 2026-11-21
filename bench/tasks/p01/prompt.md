Please build `ledgerly` from scratch: a small personal-finance tool written as a Node 22 ES-module library plus a command line. The repository only has a README, `SPEC.md`, two small starter tests in `tests/` and some sample files in `data/`. `SPEC.md` is the full requirement and it is exact: every function name, return shape, file format, output line, error message and exit code is written down there, so follow it to the letter and read it all before you start.

It has five parts that build on each other:
- A: CSV import (quoted fields, three date formats, amount formats, row errors with line numbers, duplicate ids)
- B: categorisation rules (validated rules file, ordered first-match rules)
- C: budgets and monthly summaries (integer cents, yearly budgets split exactly, carry-over, rounding)
- D: the JSON ledger file (version 1 to version 2 migration, idempotent import, atomic save)
- E: the `ledgerly` command line (`import`, `categorize`, `report`, `budget`)

Everything public is exported from `src/index.mjs`, and the command line starts at `bin/ledgerly.mjs`. Add your own tests under `tests/` and make `npm test` pass, including the two starter tests.

ANSWERS:
- Language and runtime: plain JavaScript ES modules on Node 22, standard library only, no dependencies and no build step
- Where things go: library code under `src/` (split it into sensible modules), the command line in `bin/ledgerly.mjs`, tests under `tests/`; keep `package.json` as it is
- Design constraints: money is always integer cents with no floating point in stored or computed values; functions return new values instead of changing their arguments; no clock, network or randomness anywhere
- Scope: only what `SPEC.md` describes; do not add commands, options or file formats, and do not edit `SPEC.md` or the files in `data/`
