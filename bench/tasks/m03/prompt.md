Please finish the expression calculator. `src/` has stubs for the tokenizer, parser, evaluator, `calc` and the CLI, and a ready-made `CalcError` in `src/errors.mjs`. Make them work together and add tests under `tests/` so `npm test` passes.

`calc(text, vars = {})` evaluates an arithmetic expression and returns a number.
- Numbers are digits with an optional fractional part (`3`, `3.14`). Whitespace is allowed between tokens.
- Binary operators `+ - * / %`; `%` behaves like JavaScript's `%`. `* / %` bind tighter than `+ -`, and all of them are left-associative.
- Unary `-` and `+`, which can be stacked (`--3` is 3). `^` is power; it is right-associative (`2^3^2` is 512), binds tighter than unary minus on its left (`-2^2` is -4), and allows a unary operator in its exponent (`2^-1` is 0.5).
- Parentheses.
- Variables: identifiers made of letters, digits and underscores, not starting with a digit, looked up in `vars` (own properties only). An unknown variable is a CalcError.
- Functions `min` and `max` (one or more arguments), `sqrt` and `abs` (exactly one), called as `max(1, 2, x)`. An unknown function or the wrong number of arguments is a CalcError.
- Every failure is a `CalcError` whose `position` is the 0-based index in the input of the first character that cannot be accepted. For an unexpected end of input (including an empty expression and a missing `)`) that is the input length. For an unknown variable or function it is the start of the name, and a call with the wrong number of arguments (`min()`, `sqrt(1, 2)`) reports the start of the function name too.
- Any operation whose result is not a finite number (division or modulo by zero, `sqrt` of a negative number, overflow) throws a CalcError.

`main(argv, { out, err })` in `src/cli.mjs`: `argv[0]` is the expression and each `--var name=number` adds a variable. On success it calls `out(String(result) + "\n")` and returns 0. On a CalcError it calls `err("error: <message> (at <position>)\n")` and returns 1. No expression, an unknown option, or a `--var` that is not `name=number` writes `usage: calc <expression> [--var name=value]...\n` to `err` and returns 2.

ANSWERS:
- Language and runtime: plain JavaScript ES modules, Node 22, no dependencies
- Where: the five stub files in src/; tests in tests/
- Design: tokenizer -> parser (recursive descent, builds a tree) -> evaluator; keep CalcError as it is
- Scope: no new dependencies, no README or package changes
