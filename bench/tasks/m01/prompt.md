I use the todo tool in this repo every day and I want tags. When I add a todo, any word that starts with `#` is a tag: `todo add "Buy milk #home #errands"` creates the todo "Buy milk" with tags `home` and `errands`. Tags are saved in the data file as a `tags` array on each todo, lowercased, no duplicates, in the order they appeared. `todo list` should show them after the title, and `todo list --tag home` (and the equivalent `todo list --tag=home`) should only show todos that have that tag (case-insensitive). If I pass `--tag` more than once, a todo must have all of them. My existing data file has no tags in it and must keep working. Add tests and make `npm test` pass.

ANSWERS:
- Language and runtime: plain JavaScript ES modules, Node 22, no dependencies
- Where: the existing modules in src/; tests in tests/
- Output format: the tags go after the title separated by a single space, as `#home #errands`
- Scope: no new files except tests, no README or package changes, existing commands keep their current behaviour
