We are replacing the storage interface that every service in `src/` is written against. `src/repo.mjs` currently gives out repositories with `findById(id)`, `findAll(filter)`, `insert(record)`, `update(record)` and `remove(id)`. The new interface, which the production storage layer will implement, is:

- `get(id)`: the record, or `null` when there is none
- `list(filter = {})`: the records whose fields equal every field of `filter`, in insertion order
- `put(record)`: creates or replaces the record with that `id`; returns `true` if it was new and `false` if it replaced one
- `delete(id)`: returns `true` if a record was removed, `false` if there was none

Please change `createRepo()` in `src/repo.mjs` to this interface (the old methods go away) and move every service module over to it. The services must keep behaving exactly as they do today, including the errors they throw, even where the old behaviour came from the old `insert` or `update` rather than from the service's own code. Run `npm test` when you are done; add tests under `tests/` for anything you want covered.

ANSWERS:
- Language and runtime: plain JavaScript ES modules, Node 22, no dependencies
- Where: src/repo.mjs and the service modules in src/
- Scope: no behaviour changes, no new features, no README or package changes
