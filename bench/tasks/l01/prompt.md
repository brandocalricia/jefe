Please finish `schemata`, our small schema validation library. `src/result.mjs` already defines the contract every validator follows, and every other file in `src/` is a stub for you to fill in. All of them have to agree on that contract so schemas can be nested freely. Add tests under `tests/` and make `npm test` pass.

Validators (each is an object with `parse(input, path = [])` as described in `src/result.mjs`; none of them ever throws for bad input, and none changes its input):
- `string({ min, max, pattern })`: a string. `min`/`max` are lengths, `pattern` is a RegExp.
- `number({ min, max, int })`: a finite number (NaN and Infinity are not numbers). `int: true` requires an integer.
- `boolean()`.
- `array(item, { min, max })`: an array whose elements all pass `item`. The result is a new array of the parsed elements.
- `object(shape, { strict })`: a plain object (not null, not an array) where `shape` maps keys to validators. The result is a new object holding only the keys of `shape`; a key whose parsed value is `undefined` is left out. With `strict: true`, keys not in the shape are issues; otherwise they are dropped.
- `optional(validator, { default })`: `undefined` is accepted (and replaced by `default` if one was given); anything else goes to `validator`.
- `oneOf(...validators)`: the first validator that accepts the input wins.

Issue messages are fixed: `required` (the input is `undefined` and the validator is not optional; this applies to string, number, boolean, array and object), `expected string`, `expected number`, `expected boolean`, `expected array`, `expected object`, `too short`, `too long`, `too small`, `too large`, `not an integer`, `does not match pattern`, `unexpected key`, `no alternative matched`. A string or number reports at most one constraint issue (checked in the order listed in its options above, with `int` first for numbers). An array reports a length issue (at the array's own path) first and then the issues of its elements in index order. An object reports the issues of its shape keys in shape order, then unexpected keys in the order they appear in the input. Issue paths are arrays of keys and indexes from the root, so a bad email in the second user is `['users', 1, 'email']`.

Also: `validate(schema, input)` returns the schema's result for a top-level parse. `assertValid(schema, input)` returns the parsed value, or throws a `ValidationError` that has `.issues` and whose message is `formatIssues(issues)`. `formatIssues(issues)` returns one line per issue, `<path>: <message>`, joined with newlines, where the path is written like `users[1].email`, a root-level array index like `[0].name`, and the empty path as `(root)`. Export everything from `src/index.mjs`.

ANSWERS:
- Language and runtime: plain JavaScript ES modules, Node 22, no dependencies
- Where: the stub files in src/; tests in tests/
- Design: factories that return plain objects; share small helpers through result.mjs if needed, but keep its three existing exports unchanged
- Scope: no new dependencies, no README or package changes
