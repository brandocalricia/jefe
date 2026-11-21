# ledgerly

A small personal-finance tool for people who would rather keep their numbers in a plain JSON file than in an app.

You export a CSV from your bank, ledgerly imports it (skipping anything it has already seen), sorts each transaction into a category using a rules file you control, and prints monthly reports and budget-versus-actual tables.

```
node bin/ledgerly.mjs import data/sample-bank.csv --ledger my-ledger.json
node bin/ledgerly.mjs categorize --rules data/rules.json --ledger my-ledger.json
node bin/ledgerly.mjs report 2026-03 --ledger my-ledger.json
node bin/ledgerly.mjs budget data/budget.json 2026-03 --ledger my-ledger.json
```

## Status

The repository only has the written specification so far. `SPEC.md` is the source of truth for every format, message and exit code; this README is just the tour.

## Layout

- `SPEC.md` - the full requirements
- `data/` - sample bank export, rules file, budget file and an old version 1 ledger to try things on
- `src/` - the library (`src/index.mjs` is the public entry point)
- `bin/ledgerly.mjs` - the command line
- `tests/` - tests, run with `npm test` (Node 22, built-in test runner, no dependencies)

## Money

Everything is stored as integer cents. Negative means money out. There is no floating point in the ledger.
