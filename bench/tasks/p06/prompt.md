Please clean up `slotwise`, our booking and scheduling library with a small command line (resources, opening hours, recurring availability rules, bookings with buffers, waitlist, cancellations, reports). It mostly works and its few tests pass, but users have reported twelve bugs (`docs/ISSUES.md`), we want to retire the old positional-argument calling style and the global clock, and most modules have no tests at all.

`SPEC.md` is the authority on correct behaviour and has five parts: A (issues 1-4, core logic), B (issues 5-8, bookings, waitlist, cancellation, batch), C (issues 9-12, reports, sorting, CLI), D (replace the deprecated `legacyClock` and positional calls with the options-object API at every call site, remove the old entry points and make them fail with a clear error) and E (a test file per module under `tests/`). Work through them in order, find the real cause of each reported problem rather than patching symptoms, and make `npm test` pass at the end.

ANSWERS:
- Language and runtime: plain JavaScript ES modules, Node 22, standard library only, tests with `node --test`
- Where: fix the code in `src/` and `bin/` in place and keep the module layout; new tests go in `tests/<module>.test.mjs`
- Design: keep behaviour outside the reported problems exactly as it is; `SPEC.md` fixes every function name, signature, error message and output format
- Scope: no new dependencies, no new modules, no changes to `SPEC.md` or `docs/`; update the existing tests that use the old calling style
