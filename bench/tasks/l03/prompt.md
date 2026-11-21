Please add filters to `tinytpl`, our small template library. A tag like `{{ name | upper }}` should pass the value through the named filter before it is printed, and filters can be chained left to right: `{{ name | trim | upper }}`. The filters are:

- `upper` and `lower`: change case
- `trim`: strip whitespace at both ends
- `json`: `JSON.stringify` of the value

An unknown filter name throws an `Error` with the message `unknown filter: <name>` when the template is rendered. Filters also work in raw tags (`{{{ name | lower }}}`). Escaping still happens as the last step for normal tags.

Document this in the README with a new "Filters" section that lists every filter and has a runnable example like the other ones there (the README test runs every example and compares its output). `npm test` must pass; add tests for the filters under `tests/`.

ANSWERS:
- Language and runtime: plain JavaScript ES modules, Node 22, no dependencies
- Where: code in src/ (a new src/filters.mjs is fine), docs in README.md; tests in tests/
- README style: follow the existing examples, a js block followed by a text block with its exact output
- Scope: no new dependencies, no package metadata changes
