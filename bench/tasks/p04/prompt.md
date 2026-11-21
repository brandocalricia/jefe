We are choosing a storage engine for our vehicle event store and I need a written decision report built only from the documents in `corpus/`. `SPEC.md` has the exact format: fixed headings, eight questions answered in 120 words or fewer each, a citation after every sentence, a decision table, a conflicts section and a section for the two questions the documents cannot answer. Some documents are out of date or wrong, and some numbers have to be computed from the CSV, so read the whole corpus before you write. Create `report/REPORT.md` and `report/sources.json`, and make the tests pass.

ANSWERS:
- Language and runtime: Markdown and JSON output; Python 3.11 standard library only for any helper or test you add
- Where: `report/REPORT.md` and `report/sources.json`; any extra tests in `tests/`; leave `corpus/` untouched
- Design: answers come from the corpus only, using current figures; superseded or refuted sources appear only in the conflicts section
- Scope: no network, no outside knowledge, no new dependencies, do not answer the two not-established questions
