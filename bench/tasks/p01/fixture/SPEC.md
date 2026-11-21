# ledgerly specification

ledgerly is a small personal-finance tool: a Node 22 ES-module library (`src/index.mjs`) and a command line (`bin/ledgerly.mjs`). It imports bank CSV exports, puts each transaction in a category using a rules file, keeps everything in one JSON ledger file, and prints monthly reports and budget-versus-actual tables. Standard library only, no dependencies, no network, no clock.

Everything in this file is required. Where a format, message or ordering is given, it is exact. Anything not stated is up to you.

## 0. Conventions

- All money is an integer number of cents. Negative is money out (an expense), positive is money in. Floating point is never used for stored or computed money.
- A date is the string `YYYY-MM-DD`. A month is the string `YYYY-MM`.
- Every public function below is a named export of `src/index.mjs`. Tests import only from `src/index.mjs` and run only `node bin/ledgerly.mjs`.
- `LedgerError` (exported) is an `Error` subclass with a string property `code`. Every error that this spec says is raised is a `LedgerError` with the stated `code` and exact `message`. Functions never mutate their arguments; they return new values.
- `UNCATEGORIZED` (exported) is the string `"Uncategorized"`.
- Strings are compared with plain `<` / `>` (UTF-16 code unit order) wherever this spec says "ascending" for text.

Wherever this spec says "object" or "plain object" for a parsed JSON value it means a JSON object: `null` and arrays are not objects.

A transaction is an object with exactly these properties:

```
{ id, date, description, cents, category }
```

## Part A. CSV import

### A1. `parseCsv(text)`

Returns an array of records, each `{ line, fields }`, where `fields` is an array of strings and `line` is the 1-based physical line number on which the record starts. Rules:

- A leading byte-order mark (U+FEFF) is ignored.
- Fields are separated by `,`. Records end with `\n` or `\r\n`. The final record may omit its line break. The text contains no lone `\r`.
- A record with no characters at all (an empty line) is skipped. A line holding only spaces is a record with one field.
- A field that starts with `"` is quoted. It ends at the next `"` that is not doubled; `""` inside it stands for one `"`. A quoted field may contain commas and line breaks. Every `\n` in the text counts as a physical line, including those inside quotes.
- After the closing quote the next character must be `,`, a line break or the end of the text. Otherwise raise code `CSV_SYNTAX`, message `line <N>: unexpected character after closing quote`.
- A quoted field that never closes raises code `CSV_SYNTAX`, message `line <N>: unterminated quoted field`.
- In both messages `<N>` is the `line` of the record being read.
- A `"` in the middle of an unquoted field is an ordinary character. Spaces outside quotes are kept.
- `parseCsv("")` is `[]`.

### A2. `parseDate(text)`

Trims `text` and accepts exactly three formats, returning `YYYY-MM-DD`, or `null` if the text is not one of them or is not a real calendar date (Gregorian leap years apply):

- `YYYY-MM-DD` (four, two, two digits)
- `M/D/YYYY` (month first; one or two digits for month and day, four for year)
- `DD.MM.YYYY` (exactly two digits for day and month, four for year)

`parseDate("3/7/2026")` is `"2026-03-07"`, `parseDate("07.03.2026")` is `"2026-03-07"`, `parseDate("2026-02-29")` is `null`, `parseDate("2024-02-29")` is `"2024-02-29"`.

### A3. `parseAmount(text)`

Trims `text` and returns an integer number of cents, or `null` if the text is not valid. A valid amount is, in order:

1. optionally a sign `+` or `-`, or the whole number wrapped in parentheses (parentheses mean negative; a sign inside parentheses is invalid);
2. optionally `$` (so the sign comes before the `$`: `-$5.00` is valid, `$-5.00` is not);
3. the integer part: either plain digits, or a thousands-grouped number (one to three digits, then one or more groups of `,` and exactly three digits). Mixed use such as `1234,567` is invalid;
4. optionally `.` followed by one or two digits.

There is no whitespace inside. `12.5` is `1250`; `$1,234.56` is `123456`; `(12.34)` is `-1234`; `+7` is `700`; `.5`, `5.`, `1.234`, `1,23.00`, `--5`, `abc` and the empty string are `null`. A zero result is always the number `0`, never `-0` (`-0.00` is `0`).

### A4. `normalizeDescription(text)`

Trims the text and collapses every run of whitespace characters into one space.

### A5. `transactionId(tx, occurrence)`

`tx` has `date`, `cents`, `description`; `occurrence` is a 1-based integer. Returns the first 12 hexadecimal characters of the SHA-256 digest of the UTF-8 string `` `${date}|${cents}|${description.toLowerCase()}#${occurrence}` ``.

### A6. `parseTransactions(text)`

Parses a bank CSV export into `{ transactions, errors }`.

- The first record is the header. Header names are trimmed and compared in lower case. The columns `date`, `description` and `amount` are required and may appear in any order; other columns are ignored. If one is missing raise code `BAD_HEADER`, message `missing column: <name>`, naming the first missing one in the order date, description, amount.
- If the text has no records, return `{ transactions: [], errors: [] }`. A header with no data rows gives the same.
- Every later record is a data row. It is checked in this order, and only its first problem is reported, as `{ line, message }` with the record's `line`:
  1. the field count differs from the header's: `expected <H> fields, found <N>`
  2. the date is not accepted by `parseDate`: `invalid date "<raw>"` (`<raw>` is the field exactly as read)
  3. the amount is not accepted by `parseAmount`: `invalid amount "<raw>"`
  4. the description is empty after `normalizeDescription`: `empty description`
- Rows with a problem are left out of `transactions`; the other rows are kept. `errors` is in file order.
- A valid row becomes `{ id, date, description, cents, category: UNCATEGORIZED }`, with the normalized description. The `id` is `transactionId(tx, n)` where `n` counts how many valid rows earlier in this file have the same `date`, `cents` and lower-cased `description`, plus one. So two identical purchases on one day get different ids, and the same file imported twice gives the same ids.
- `transactions` keeps file order.

### A7. `splitDuplicates(transactions, existingIds)`

`existingIds` is an array or a `Set` of ids. Returns `{ fresh, duplicates }`: the transactions whose `id` is not in `existingIds`, and the ones whose `id` is, each in the original order.

## Part B. Categorisation rules

A rules file is JSON:

```json
{ "rules": [
  { "category": "Groceries", "contains": "kroger" },
  { "category": "Income", "regex": "^payroll", "flags": "i", "min": 0 },
  { "category": "Eating out", "min": -4000, "max": -1 }
] }
```

A rule has a `category` and one or more conditions: `contains`, `regex` (with optional `flags`), `min`, `max`. A rule matches a transaction only if all its conditions hold:

- `contains`: the description contains this text, ignoring case.
- `regex`: the pattern, built with `new RegExp(regex, flags)`, finds a match in the description as stored (case matters unless the `i` flag is given).
- `min` / `max`: `cents >= min` / `cents <= max`, both inclusive, in signed cents.

### B1. `compileRules(json)`

`json` is the already-parsed value. It must be an object whose `rules` property is an array, else raise code `BAD_RULES`, message `rules must be an array`. Other top-level keys are ignored. Each rule is checked in this order; the first problem raises code `BAD_RULES` with message `rules[<i>]: <problem>` (`<i>` is the 0-based index; rules are checked in order, so the lowest index wins):

1. the rule is not a plain object: `must be an object`
2. `category` is not a string with a non-blank trimmed value: `category must be a non-empty string`
3. a key other than `category`, `contains`, `regex`, `flags`, `min`, `max` (the first such key in the rule's own key order): `unknown key "<key>"`
4. none of `contains`, `regex`, `min`, `max` is present: `needs at least one of contains, regex, min, max`
5. `contains` is present but not a non-empty string: `contains must be a non-empty string`
6. `flags` is present without `regex`: `flags requires regex`
7. `regex` is present but not a string, or `flags` is not a string made only of the letters `i`, `m`, `s`, `u`, or the pattern does not compile: `invalid regex "<regex>"` (`<regex>` is the value of `regex` converted to a string)
8. `min` present but not an integer: `min must be an integer`; then the same for `max`: `max must be an integer`
9. both present and `min > max`: `min is greater than max`

Returns an opaque compiled value for the functions below. The category is trimmed.

### B2. `matchRule(compiled, tx)`

Returns the 0-based index of the first rule that matches `tx`, or `-1`.

### B3. `categorize(compiled, tx)`

Returns the category of the first matching rule, or `UNCATEGORIZED`. First match wins; later rules are ignored.

### B4. `categorizeAll(compiled, transactions)`

Returns a new array of new transaction objects, in the same order, each with `category` set by `categorize` (whatever category it had before is replaced). The input is not changed.

## Part C. Budgets and monthly summaries

### C1. `formatCents(cents)`

Formats an integer as a decimal with exactly two decimals and comma thousands groups, with a leading `-` for negatives and no `+`: `0` is `0.00`, `5` is `0.05`, `123456` is `1,234.56`, `-100000005` is `-1,000,000.05`.

### C2. Budget file and `parseBudgets(json)`

A budget file is JSON, all keys optional:

```json
{ "monthly": { "Groceries": 45000, "Dining": 10000 },
  "yearly":  { "Travel": 100000 },
  "carryOver": ["Groceries"] }
```

Amounts are non-negative integer cents. `parseBudgets` takes the parsed value and returns `{ monthly, yearly, carryOver }` with defaults `{}`, `{}`, `[]`. Problems raise code `BAD_BUDGET`; checks run in this order and the first problem wins:

1. the value is not a plain object: `budget must be an object`
2. a top-level key other than `monthly`, `yearly`, `carryOver` (first in key order): `unknown key "<key>"`
3. `monthly` present but not an object: `monthly must be an object`; then each entry in key order whose value is not a non-negative integer: `monthly.<category> must be a non-negative integer`
4. the same for `yearly` (`yearly must be an object`, `yearly.<category> must be a non-negative integer`)
5. `carryOver` present but not an array of strings: `carryOver must be an array of strings`; then each name (in order) that is a key of neither `monthly` nor `yearly`: `carryOver names unknown category "<name>"`

### C3. `monthBudget(budgets, category, month)`

`budgets` is the output of `parseBudgets`. Returns `null` if the category is in neither `monthly` nor `yearly`. Otherwise it is `monthly[category]` (0 if absent) plus the month's share of the yearly amount `Y` (0 if absent): `floor(Y / 12)`, plus 1 more cent if the month number (1 to 12) is at most `Y mod 12`. So `Y = 100000` gives 8334 cents for months 1 to 4 and 8333 for months 5 to 12, and the twelve shares add up to exactly `Y`.

### C4. `monthlySummary(transactions, budgets, month)`

Considers each transaction's `date.slice(0, 7)` as its month; a missing or empty `category` counts as `UNCATEGORIZED`. Returns:

```
{ month, income, expenses, net, categories: [ row, ... ] }
```

- `income`: the sum of `cents` over the month's transactions with `cents > 0`. `expenses`: the sum of `-cents` over those with `cents < 0` (a positive number). `net = income - expenses`.
- For a category, `spent = max(0, -(sum of cents of all the month's transactions in that category))`, so a refund reduces spending and spending never goes negative.
- `categories` has one row for every category that has a budget in `budgets` (see C3), and one for every other category with `spent > 0`. Rows are sorted by `spent` descending, then by category ascending.
- A row is `{ category, spent, budget, carry, available, remaining, percent }`:
  - `budget` is `monthBudget(...)`, `null` for a category with no budget.
  - `carry` is the carry-over into this month (see below), 0 when there is none.
  - `available = budget + carry`; `remaining = available - spent` (may be negative).
  - `percent` is `spent / available` as a percentage rounded half up to an integer, computed in integers as `floor((spent * 200 + available) / (2 * available))`; `null` if `available` is 0.
  - for a category with no budget, `budget`, `available`, `remaining` and `percent` are `null` and `carry` is `0`.
- Carry-over: only categories listed in `budgets.carryOver` carry. Let `first` be the earliest month of any transaction passed in. For the months from `first` up to the month before `month`, in order, start with carry 0, and for each month `m`: `available(m) = monthBudget(m) + carry`, `carry = max(0, available(m) - spent(m))`. Months with no transactions count (spent 0). The final carry is the carry into `month`. If `month` is `first` or earlier, or there are no transactions, the carry is 0. Overspending never carries forward as a debt.

## Part D. Storage

### D1. Ledger formats

Version 2 (current): `{ "version": 2, "transactions": [tx, ...], "imports": [ { "source", "added", "skipped" }, ... ] }`.

Version 1 (old): `{ "version": 1, "entries": [ { "date", "desc", "amount", "cat", "deleted" }, ... ] }` where `amount` is a number of dollars (like `-12.34`), `cat` is optional, `deleted: true` marks an entry that was removed, and `date` is either `YYYY-MM-DD` or `M/D/YYYY`.

In every v2 ledger returned by `migrateLedger`, `importInto` and `loadLedger`, `transactions` is sorted by `date` ascending, then `id` ascending.

### D2. `migrateLedger(ledger)`

Takes a parsed ledger and returns a version 2 ledger.

- Version 2 input is returned as an equal ledger with `imports` defaulting to `[]` and transactions sorted. If `transactions` is not an array raise code `BAD_LEDGER`, message `transactions must be an array`.
- Version 1 input: entries with `deleted: true` are dropped without being checked at all. Each other entry becomes a transaction: `date` via `parseDate`; `description` via `normalizeDescription(desc)`; `category` is `cat` if it is a non-blank string (trimmed), else `UNCATEGORIZED`; `cents` comes from `amount` written with `toFixed(2)`, the decimal point removed, and read as an integer (so `-12.34` is `-1234`, `0.1 + 0.2` is `30`, `5` is `500`, `-0.001` is `0`; a zero is always the number `0`, never `-0`). Ids are `transactionId(tx, n)` with `n` counted over the kept entries in order, as in A6; any id in the old entry is ignored. `imports` is `[]`.
- A v1 entry is checked in this order, and the first problem raises code `BAD_LEDGER` with message `entries[<i>]: <problem>` where `<i>` is the entry's index in the original `entries` array (deleted entries still occupy an index): `invalid date "<raw>"`, then `invalid amount` (the `amount` value is not of type number, or is `NaN` or infinite, so the string `"5"` and `null` are invalid), then `empty description`. `entries` not being an array raises `entries must be an array`.
- A missing `version` (the property is absent; `0` is a present version): code `BAD_LEDGER`, message `missing ledger version`. Any other version (including 3): `unsupported ledger version <v>`. A non-object input is `missing ledger version`.
- Migrating a version 2 result again changes nothing.

### D3. `importInto(ledger, transactions, source)`

`ledger` is a version 2 ledger. Applies `splitDuplicates` against the ledger's existing ids and returns `{ ledger, added, skipped }`: the new ledger holds the old transactions plus the fresh ones (sorted as in D1), `added` is the number of fresh transactions and `skipped` the number of duplicates. When `added > 0`, an entry `{ source, added, skipped }` is appended to `imports`; when `added` is 0 `imports` is unchanged. Importing the same transactions again therefore adds nothing and changes nothing.

### D4. `loadLedger(path)`

If the file does not exist, returns a fresh ledger `{ version: 2, transactions: [], imports: [] }`. Otherwise reads and parses it and returns `migrateLedger(parsed)` (the file is not rewritten). Text that is not valid JSON raises code `BAD_LEDGER`, message `<path> is not valid JSON` with `path` exactly as passed. Other read errors propagate.

### D5. `saveLedger(path, ledger)`

Writes `JSON.stringify({ version: 2, transactions, imports }, null, 2) + "\n"` to `path`, where `transactions` is sorted as in D1 and the key order of the top-level object is as shown. A ledger whose `version` is not 2 raises code `BAD_LEDGER`, message `can only save version 2 ledgers`. The write is atomic: serialize first; write to a temporary file in the same directory; rename it over `path`. If anything fails, the previous file at `path` is unchanged, no temporary file is left behind, and the error propagates. After a successful save the directory contains no extra files.

## Part E. Command line

`node bin/ledgerly.mjs <command> [arguments] [options]`. The ledger file is `--ledger <path>` if given, else the environment variable `LEDGERLY_LEDGER` if set and non-empty, else `ledger.json` in the current directory. Every line printed ends with `\n`. Errors go to stderr, results to stdout.

Commands:

- `import <csv-file>`
- `categorize --rules <file>`
- `report <month>`
- `budget <budget-file> <month>`

Options: `--ledger <path>` (all commands), `--rules <path>` (only `categorize`). Options may appear anywhere after the command. The `--name=value` form is not supported.

### E1. Exit codes and errors

- `0`: success.
- `1`: usage error. stdout is empty and stderr is a single line `error: <message>`.
- `2`: invalid data. Nothing is written to any file.
- `3`: a file named on the command line could not be read: stderr `error: cannot read <path>` (path as given), nothing written.

Usage checks run in this order, first problem wins:

1. no command: `error: missing command`
2. unknown command: `error: unknown command "<name>"`
3. each argument after the command in order: an argument starting with `-` that is not an option valid for the command: `error: unknown option "<arg>"`; a valid option with no following argument: `error: option "<name>" requires a value`; the argument after an option is always its value
4. positional arguments missing: `import`: `error: import requires a CSV file`; `categorize` without `--rules`: `error: categorize requires --rules <file>`; `report`: `error: report requires a month (YYYY-MM)`; `budget` with fewer than two: `error: budget requires a budget file and a month`
5. too many positional arguments: `error: unexpected argument "<first extra>"`
6. a month (the first positional argument of `report`, the second of `budget`) that does not match `YYYY-MM` with month 01 to 12: `error: invalid month "<value>"`

Invalid data (exit 2): a `LedgerError` raised while working prints `error: <message>`. A JSON file named on the command line (rules, budget) that is not valid JSON prints `error: <path> is not valid JSON` (path as given). A missing ledger file is not an error (it is an empty ledger).

### E2. `import`

Reads the CSV (exit 3 if it cannot be read), runs `parseTransactions` (a `LedgerError` gives exit 2), then if there are row errors prints one line per error to stderr, `error: <csv-path>:<line>: <message>`, in file order, and exits 2 without touching the ledger (it is not created). Otherwise loads the ledger, runs `importInto` with the CSV's base name as `source`, saves the ledger (even when nothing was added), prints `imported <added> added, <skipped> skipped`, and exits 0. Imported transactions have the category `Uncategorized`.

### E3. `categorize`

Reads the rules file (exit 3 if unreadable; invalid JSON or invalid rules exit 2), loads the ledger, applies `categorizeAll` to every transaction, saves, and prints `categorized <N> transactions, <U> uncategorized` where `N` is the number of transactions in the ledger and `U` how many are `Uncategorized` afterwards. `N` is always followed by the word `transactions`, even when it is 1.

### E4. `report`

Loads the ledger and prints, for the month (using `monthlySummary` with empty budgets):

```
Month: 2026-03
Income: 3,000.00
Expenses: 1,234.56
Net: 1,765.44
Categories:
  Groceries: 400.00
  Dining: 120.50
```

Amounts use `formatCents`. Under `Categories:` come the rows with `spent > 0`, in summary order, each as two spaces, the name, `: ` and `formatCents(spent)`; if there are none, the single line `  (none)`.

### E5. `budget`

Reads the budget file (exit 3 if unreadable; invalid JSON or an invalid budget exits 2), parses it with `parseBudgets`, loads the ledger and prints:

```
Budget for 2026-03
Groceries: spent 400.00 of 450.00 (89%), remaining 50.00
Dining: spent 120.50 of 100.00 (121%), over by 20.50
```

One line per summary row whose `budget` is not null, in summary order. The line is `<category>: spent <spent> of <available> (<percent>%), ` followed by `remaining <remaining>` when `remaining >= 0` or `over by <abs(remaining)>` when negative; if `percent` is null the parenthesis is `(n/a)` instead of `(<percent>%)`. When `carry > 0`, ` [carry <carry>]` is appended at the end of the line. All amounts use `formatCents`. If no category has a budget only the header line is printed.

Both `report` and `budget` leave every file untouched.

### E6. Ledger versions

Any command that saves writes a version 2 ledger. A version 1 ledger file is read through `migrateLedger`, so `report` and `budget` work on one and `import` or `categorize` upgrade it when saving.
