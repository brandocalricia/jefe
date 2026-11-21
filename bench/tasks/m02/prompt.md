`src/utils.mjs` has turned into a grab bag and I want it split up. Please move the helpers into three modules:

- `src/strings.mjs`: `titleCase`, `truncate`, `padLeft`
- `src/numbers.mjs`: `clamp`, `roundTo`, `percent`
- `src/dates.mjs`: `formatDate`, `daysBetween`, `addDays`

`padLeft` is the current `pad` and `formatDate` is the current `fmtDate`; rename them as part of the move and drop the old names. Update `csv.mjs`, `report.mjs` and `cli.mjs` so they import from the new modules instead of `utils.mjs`. Keep `src/utils.mjs` as a thin file that re-exports everything from the three new modules, so any other code that still imports it keeps working. This is a refactor: nothing may behave differently, including the odd corners. The tests run with `npm test`.

ANSWERS:
- Language and runtime: plain JavaScript ES modules, Node 22, no dependencies
- Where: src/ only; the three new modules, utils.mjs, csv.mjs, report.mjs, cli.mjs
- Scope: no behaviour changes, no new features, no README or package changes
