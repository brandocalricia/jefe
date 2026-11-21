# slotwise specification

This file says what slotwise must do. Where the code and this file disagree, this file is right. `docs/ISSUES.md`
lists problems users reported; each one is a place where the code does not follow this file. Work is split into
parts A to E. Parts A, B and C fix bugs (issues 1-4, 5-8 and 9-12), part D replaces an old calling style, part E adds
tests. Everything outside the parts below keeps working as it does now.

The parts are meant to be done in the order A, B, C, D, E: the behaviour in B and C relies on the interval, hours and rule
fixes of A (for example bookings and reports are built on `overlaps` and `mergeIntervals`), D changes how the functions
fixed in B and C are called, and the tests of part E should be written against the final code of A to D.

Node 22, ES modules, standard library only. Test runner: `node --test` (`npm test`).

## Conventions

- **Instant**: whole minutes since 1970-01-01T00:00Z (a JavaScript integer). Text form `YYYY-MM-DDTHH:MM` followed
  by `Z`, `+HH:MM` or `-HH:MM`, for example `2025-03-10T09:00+02:00`. No seconds. Offsets run from `-12:00` to `+14:00`.
- **Date**: `YYYY-MM-DD`, a calendar day in some resource's local time. **Offset**: whole minutes east of UTC.
- **Interval**: `{ start, end }` in minutes, half-open: it contains `start` and does not contain `end`. Two intervals
  that only touch (`a.end === b.start`) do not overlap.
- **Weekday**: 0 = Sunday ... 6 = Saturday; day names are `sun mon tue wed thu fri sat`. 2025-03-10 is a Monday.
- **Errors**: everything the library rejects on purpose throws `SlotwiseError` (from `src/errors.mjs`), which has `.code`
  and `.message`. Codes: `E_INVALID`, `E_NOT_FOUND`, `E_CONFLICT`, `E_PAST`, `E_CLOSED`, `E_LEGACY_CALL`. Messages quoted
  below are exact.
- Functions never modify the arguments they are given, and return new arrays and objects (never internal state).
- Modules are imported by path in tests, for example `../src/interval.mjs`. Every name listed below is exported from
  its module and also from `src/index.mjs`. Other exports are allowed.

---

## Part A: time, offsets, intervals, opening hours, rules (issues 1-4)

### `src/time.mjs`
- `parseDate(text)` returns the day number (days since 1970-01-01). Real calendar dates only. Otherwise (also for
  non-strings) throws E_INVALID `invalid date: <text>`.
- `formatDate(dayNumber)` is the inverse. `addDays(date, n)` returns a date text (n may be negative).
  `weekdayOf(date)` returns 0-6.
- `parseInstant(text)` returns the instant. Wrong shape, impossible calendar date, hour above 23, minute above 59
  or an offset outside the allowed range throws E_INVALID `invalid instant: <text>`.
- `formatInstant(instant, offset = 0)` writes the instant as local time in that offset, always with a numeric
  suffix: `formatInstant(0)` is `1970-01-01T00:00+00:00`, with offset -300 it is `1969-12-31T19:00-05:00`.

### `src/offset.mjs`
- `parseOffset(text)`: `Z` is 0; `+HH:MM` / `-HH:MM` give minutes. Outside -720..840, minutes above 59 or any other
  text throws E_INVALID `invalid offset: <text>`. `formatOffset(minutes)` gives `+HH:MM`/`-HH:MM` (`+00:00` for 0).
- `localParts(instant, offset)` returns `{ date, minuteOfDay, weekday }` for that instant in that offset.
- `dayRange(date, offset)` returns the interval from local midnight of `date` (inclusive) to the next local midnight
  (exclusive), as instants. It is always exactly 1440 minutes long.

### `src/interval.mjs`
- `makeInterval(start, end)`: both must be integers with `start < end`, else E_INVALID `invalid interval`.
- `overlaps(a, b)`: true when the two intervals share at least one minute. Touching intervals do not overlap.
- `contains(outer, inner)`: `inner` lies completely inside `outer` (sharing an edge is fine).
- `intersect(a, b)`: the shared interval, or `null` when they share no minute.
- `mergeIntervals(list)`: sorted copies in which every group of overlapping **or touching** intervals is one
  interval from the smallest start to the largest end of the group (so an interval inside another disappears into
  it). The input list is not reordered or changed.
- `subtractIntervals(list, removals)`: the parts of the (merged) `list` not covered by any removal, sorted, with no
  empty pieces.
- `totalLength(list)`: minutes covered by the union of the intervals (overlaps are counted once).
- `coverageAtLeast(list, n)`: merged, sorted intervals during which at least `n` of the listed intervals are active
  at the same time. An interval ending at the minute another starts does not count as active together with it.

### `src/hours.mjs`
- `DAYS`: the array of the seven day names starting with `sun`.
- `parseClock(text)`: `HH:MM` to minutes after midnight. `24:00` is allowed and means 1440 (end of the day);
  nothing later is. Anything else throws E_INVALID `invalid clock: <text>`.
- `formatClock(minutes)`: the inverse (`1440` gives `24:00`).
- `validateHours(hours)`: `hours` maps day names to lists of `[open, close]` clock pairs; `undefined` or `{}` means
  always closed. Returns an object with all seven days, each a sorted list of `{ open, close }` in minutes in which
  overlapping or touching windows are merged. An unknown key throws E_INVALID `invalid hours: unknown day <key>`;
  a pair with `close` not after `open` throws E_INVALID `invalid hours for <day>`.
- `openIntervals(hours, date, offset)`: `hours` as returned by `validateHours`; the opening windows of that local
  date as instants. A window closing at `24:00` ends at the next local midnight.

### `src/rules.mjs`
A recurring availability rule opens an extra window on the dates it produces:
`{ frequency: 'daily' | 'weekly', interval, start, until, count, weekdays, from, to }`.
- `validateRule(rule)` returns the normalized rule `{ frequency, interval, start, until, count, weekdays, from, to }`
  with `interval` defaulting to 1, `until`/`count` to `null`, and for weekly rules `weekdays` defaulting to the
  weekday of `start` and being sorted in week order (`[]` for daily rules). Failures throw E_INVALID
  `invalid rule: <what>` checking in this order: `not an object`, `frequency` (must be daily or weekly),
  `interval` (positive integer), `start` (a date), `until` (a date not before `start`), `count` (positive integer),
  `needs until or count` (a rule needs at least one), `weekdays` (non-empty list of day names, weekly only),
  `window` (`from` and `to` are clocks and `to` is later than `from`).
- `occurrenceDates(rule, fromDate, toDate)`: the dates from `fromDate` to `toDate` (both inclusive), ascending, on which
  the rule occurs. Daily: `start`, then every `interval` days. Weekly: a date counts when its weekday is in
  `weekdays` and the number of whole 7-day blocks since `start` is a multiple of `interval`. `until` is inclusive: it
  is the last date the rule may occur on. `count` is the number of occurrences in the whole series counted from
  `start` (not from `fromDate`); when both are given the series stops at whichever comes first. Dates before `start`
  never occur.
- `ruleIntervals(rule, date, offset)`: `[]` if the rule does not occur on that local date, else one interval from
  `from` to `to` on that date as instants.

### `src/resource.mjs`
- `createResource(input)` returns `{ id, name, offset, capacity, buffer, hours, rules }`: `offset` is minutes (input is
  an offset text, default `Z`), `capacity` is how many bookings may overlap (default 1), `buffer` is minutes kept
  free around every booking (default 0), `hours` is validated hours, `rules` the normalized rules (default none).
  Errors are E_INVALID `invalid resource: <what>`, checked in order: `not an object`, `id` (lowercase letters,
  digits and `-` only), `name` (non-empty text), `capacity` (integer >= 1), `buffer` (integer >= 0); then bad offsets,
  hours and rules throw their own errors.

---

## Part B: bookings, waitlist, cancellations (issues 5-8)

Part B describes behaviour; how the functions are called is final in part D.

### `src/store.mjs`
- `createStore()`: a new empty store.
- `addResource(store, input)`: creates the resource (part A rules), stores it, returns it. A second resource with
  the same id throws E_CONFLICT `resource exists: <id>`.
- `getResource(store, id)`: the resource, or E_NOT_FOUND `unknown resource: <id>`. `listResources(store)`: all
  resources in the order they were added.
- `addRule(store, resourceId, rule)`: validates and appends a rule to the resource, returns the resource.
- `listBookings(store, filter = {})`: copies of bookings, optionally filtered by `resourceId` and/or `status`, ordered by
  `start`; bookings with the same start stay in the order they were made.
- `invalidate(store, resourceId)`: forgets cached availability for the resource.

A booking is `{ id, resourceId, start, end, customer, status, createdAt }`: ids are `b1`, `b2`, ... per store in the
order bookings are made and are never reused; `start`/`end`/`createdAt` are instants; `status` is `confirmed` or
`cancelled`.

### `src/availability.mjs`
- A confirmed booking holds its resource from `start - buffer` to `end + buffer` (`occupiedInterval(resource, booking)`
  returns that interval). Cancelled bookings hold nothing. The resource is **full** whenever `capacity` bookings
  hold it at the same time (`fullIntervals(store, resource)`).
- `openWindows(resource, date)`: opening hours plus rule windows for that local date, merged.
- `isWithinOpen(resource, start, end)`: `[start, end)` lies inside the open windows. Windows of consecutive days that
  touch (closing at `24:00`, opening at `00:00`) form one window, so a booking may run across midnight.
- `bookingFits(store, resource, start, end)`: the resource is never full during `[start, end)`.
- `freeSlots(store, resourceId, date, minMinutes = 1)`: the open windows of the local `date` minus the full times,
  sorted, cut so that nothing starts before the clock's current instant, keeping only slots at least `minMinutes`
  long. Unknown resource: E_NOT_FOUND; bad date: E_INVALID `invalid date: <text>`; `minMinutes` not a positive integer:
  E_INVALID `invalid minimum length`. Results always reflect the bookings, cancellations and rules at the time of the
  call, however often the same question was asked before.

### `src/booking.mjs`
- `toInstant(value)`: an integer is returned as is; text goes through `parseInstant`.
- `createBooking` makes a confirmed booking and returns a copy of it with `createdAt` set to the clock's current
  instant. Checks run in this order and the first failure throws, changing nothing:
  1. customer is non-empty text, else E_INVALID `invalid customer`
  2. start and end are valid instants (`invalid instant: <text>`), and `start < end`, else E_INVALID `invalid interval`
  3. the resource exists (`unknown resource: <id>`, E_NOT_FOUND)
  4. `start` is not before the current instant, else E_PAST `cannot book in the past` (starting exactly now is fine)
  5. the booking lies inside the open windows, else E_CLOSED `outside opening hours`
  6. the resource is not full at any minute of the booking, else E_CONFLICT `slot not available`

  So bookings that merely touch are fine, and with a buffer of 15 a booking may start exactly 15 minutes after the end
  of another one, or end exactly 15 minutes before the start of another one (but not closer on either side).

### `src/waitlist.mjs`
- `joinWaitlist(store, { resourceId, start, end, customer })` adds an entry and returns
  `{ id, resourceId, start, end, customer }` with ids `w1`, `w2`, ... and instants as integers. Checks in order: resource
  (E_NOT_FOUND), customer, instants, interval (same errors as `createBooking`). No availability check is made.
- `listWaitlist(store, resourceId)`: copies of the entries in joining order; with a resource id only that
  resource's entries.
- `promoteWaitlist` goes through the resource's entries in joining order. An entry is promoted when a booking with
  the same times and customer would pass checks 4-6 of `createBooking` **at that moment, including bookings
  promoted earlier in the same pass**. Promoted entries leave the waitlist and become confirmed bookings
  (`createdAt` = current instant); entries that cannot be placed stay, in order. It returns the new bookings in
  promotion order.

### `src/cancel.mjs`
- `cancelBooking` marks a confirmed booking cancelled, then runs `promoteWaitlist` for its resource. It returns
  `{ cancelled: <copy of the booking>, promoted: [<new bookings>] }`. Unknown id: E_NOT_FOUND `unknown booking: <id>`;
  already cancelled: E_CONFLICT `already cancelled: <id>`. The freed time is available immediately afterwards.

### `src/batch.mjs`
- `bookMany` books each entry `{ resourceId, start, end, customer }` of a list in the order given, exactly as
  `createBooking` would. One failing entry does not stop the rest. It returns `{ booked: [bookings], failed:
  [{ index, code, message }] }` where `index` is the entry's position in the list given and `code`/`message` are those
  of the `SlotwiseError`. Failures are in list order. A list that is not an array throws E_INVALID
  `invalid bookings list`. Errors that are not `SlotwiseError`s are not caught. The list and its entries are not
  changed (not even reordered).

---

## Part C: sorting, reports, formatting, state files, CLI (issues 9-12)

### `src/sort.mjs`
- `sortBy(list, key, direction = 'asc')`: a new array ordered by `key(item)` (numbers or strings), `'desc'` for highest
  first. Stable in both directions: items with equal keys keep their original order.

### `src/report.mjs`
- `percent(part, whole)`: `part / whole` as a whole percent, halves rounded up (1/8 is 13, 1/3 is 33, 2/3 is 67);
  0 when `whole` is 0 or less.
- `buildReport` covers `[from, to)` (instants as integers or text; `from` before `to`, else E_INVALID
  `invalid interval`) and returns `{ from, to, asOf, rows, totals }` where `from`/`to`/`asOf` are integer instants (`asOf`
  = current instant of the clock). `rows` has one entry per resource,
  `{ resourceId, name, bookings, cancelled, bookedMinutes, openMinutes, utilization }`, with
  - `bookings`: confirmed bookings sharing at least one minute with the range; `cancelled`: the same for cancelled ones
  - `bookedMinutes`: minutes of confirmed bookings inside the range (a booking half outside counts its inside half;
    overlapping bookings of a resource with capacity above 1 each count)
  - `openMinutes`: minutes inside the range during which the resource is open (opening hours and rules, overlaps counted once)
  - `utilization`: `percent(bookedMinutes, openMinutes * capacity)`

  Rows are ordered by `bookedMinutes`, highest first; resources with equal minutes stay in the order they were added.
  `totals` is `{ bookings, cancelled, bookedMinutes, openMinutes, utilization }`: the first four are sums over the rows and
  `utilization` is `percent(total bookedMinutes, sum of openMinutes * capacity over resources)`. Every minute value, in rows
  and totals, is an integer.

### `src/format.mjs`
- `formatBooking(booking, offset = 0)`: `<id> <resourceId> <start> <end> <customer> <status>` joined by single spaces, times
  as `formatInstant(.., offset)`.
- `formatSlot(slot, offset = 0)`: `<start>..<end>` the same way.
- `formatReport(report)`: lines joined by `\n` (no trailing newline): `report <from>..<to> as of <asOf>` (times in UTC like
  `formatInstant(x)`), then the header `resource<TAB>bookings<TAB>cancelled<TAB>booked<TAB>open<TAB>util`, then one line per row
  `<resourceId><TAB><bookings><TAB><cancelled><TAB><bookedMinutes><TAB><openMinutes><TAB><utilization>%`, then the same with
  `TOTAL` first.

### `src/state-io.mjs`
- `exportState(store)` returns plain JSON data `{ version: 1, resources, bookings, waitlist, counters }`; `importState(data)`
  rebuilds a store from it (any other `version` throws E_INVALID `unsupported state version`). Resources, bookings (with
  their ids, statuses and creation times), the waitlist and the id counters survive a round trip, so ids are not reused
  after a reload.
- `saveStateFile(path, store)` writes `JSON.stringify(exportState(store), null, 2)` plus a final newline.
  `loadStateFile(path)` reads it back; a file that does not exist gives an empty store; text that is not JSON throws
  E_INVALID `invalid state file: <path>`.

### `src/args.mjs`
- `parseArgs(argv)` returns `{ command, positional, options }`. Words not starting with `--` are plain words; the first is
  `command` (`null` if none) and the rest are `positional`. `--name value` and `--name=value` set `options.name`; `--json` is
  a flag and sets `options.json = true`. A `--name` without a value at the end throws E_INVALID `missing value for --<name>`.
  `argv` is not changed.

### `src/cli.mjs` and `bin/slotwise.mjs`
`run(argv, env = process.env, cwd = process.cwd())` runs one command line (the words after `slotwise`) and returns
`{ code, stdout, stderr }` without printing. The state file is `--state <path>` (relative to `cwd`, default `slotwise.json`);
it is loaded first (missing file = empty store) and saved again only when the command succeeded and changed something.
`--now <instant>` sets the current instant (default: `env.SLOTWISE_NOW`, else the system clock); a bad value is E_INVALID
`invalid instant: <value>` (exit 1).
Exit codes: `0` success; `1` a `SlotwiseError` (stderr is `error: <message>\n`) or an import with failed entries; `2` no command
(stderr `usage: slotwise <command> [options]\n`) or unknown command (stderr `unknown command: <name>\n`). Output lines end with `\n`.

| Command | Options | stdout on success |
| --- | --- | --- |
| `resource add` | `--id --name` required; `--offset --capacity --buffer --hours` | `resource added: <id>` |
| `rule add` | `--resource --frequency --start --from --to` required; `--every --until --count --weekdays a,b` | `rule added: <resource>` |
| `book` | `--resource --start --end --customer` | `booked ` + `formatBooking` |
| `cancel` | `--id` | `cancelled <id>`, then `promoted ` + `formatBooking` per promoted booking |
| `free` | `--resource --date`, `--min` | one `formatSlot` per slot, or `no free slots` |
| `waitlist add` | `--resource --start --end --customer` | `waitlisted <id>` |
| `waitlist list` | `--resource` | `<id> <resource> <start> <end> <customer>` per entry |
| `list` | `--resource --status --json` | `formatBooking` per booking; with `--json` the array as `JSON.stringify(x, null, 2)` |
| `report` | `--from --to --json` | `formatReport`; with `--json` the report object as `JSON.stringify(x, null, 2)` |
| `import` | `--file` (JSON array of `{ resourceId, start, end, customer }`) | `booked <n>`, then `failed <index>: <message>` per failure (state is saved with what was booked) |

`--hours` is `day=HH:MM-HH:MM` entries separated by commas, a day may repeat (`mon=09:00-12:00,mon=13:00-17:00`). Times in
output use the resource's offset. A missing required option is E_INVALID `missing option --<name>` (when several are missing, the first one in the order the
table lists them is reported); a wrong `waitlist`, `rule` or
`resource` subcommand is E_INVALID `unknown subcommand: <word>`. `bin/slotwise.mjs` calls `run` and sets the exit code.

---

## Part D: options objects instead of positional arguments

Six functions currently take positional arguments, and read the current time from the global `legacyClock()`, which
reads the environment variable `SLOTWISE_NOW`. Replace that everywhere (library, CLI, tests).

New clock, in `src/clock.mjs` (exported from `src/index.mjs`):
- `createClock({ now } = {})` returns `{ now() }`. With `now` given (an instant as integer or text) `now()` always returns it
  (invalid: E_INVALID `invalid instant: <value>`); without it `now()` returns the system time in whole minutes.
  `legacyClock` no longer exists, neither as an export nor as the word `legacyClock` anywhere in `src/` or `bin/`.

New signatures. `clock` is optional in each (default: `createClock()`); all other keys are as before. Any object with a `now()` method that
returns an instant is accepted as a clock, not only the result of `createClock`.

| Old | New |
| --- | --- |
| `createBooking(store, resourceId, start, end, customer)` | `createBooking(store, { resourceId, start, end, customer, clock })` |
| `cancelBooking(store, bookingId)` | `cancelBooking(store, { bookingId, clock })` |
| `promoteWaitlist(store, resourceId, now)` | `promoteWaitlist(store, { resourceId, clock })` |
| `freeSlots(store, resourceId, date, minMinutes)` | `freeSlots(store, { resourceId, date, minMinutes, clock })` |
| `bookMany(store, specs)` | `bookMany(store, { bookings, clock })` |
| `buildReport(store, from, to)` | `buildReport(store, { from, to, clock })` |

- The library never reads `SLOTWISE_NOW` itself. Only `run` in the CLI does, as the default of `--now`, and it passes a
  clock built with `createClock` to everything it calls.
- Calling any of the six with something that is not a plain object as the second argument (a string, number, array,
  `null` or nothing) throws `SlotwiseError` with code `E_LEGACY_CALL` and message
  `positional arguments are no longer supported; pass an options object`, before anything is validated or changed.
- Every call site in the code base and in the tests uses the new style; the six functions keep their behaviour from
  parts A to C.

---

## Part E: tests

`tests/` must hold one test file per module, named exactly `tests/<module>.test.mjs` for each of: `time`, `offset`, `interval`,
`hours`, `rules`, `resource`, `clock`, `sort`, `store`, `availability`, `booking`, `waitlist`, `cancel`, `batch`, `report`, `format`,
`state-io`, `args`, `cli` (19 files; `errors` needs none). Each file imports the module from `../src/<module>.mjs`, uses only
`node:test` and `node:assert`, and does not depend on the real clock or the working directory (use `createClock` or `--now`,
temporary folders, and paths relative to the test file). Test code may import only the names listed in this file and may read
only `src/`, `bin/`, `data/` and files it creates itself. Extra helper files in `tests/` are allowed.

The tests are run against a different, correct implementation of this specification, so they must assert only what this
file states (return values, thrown codes and messages, outputs), never internal structure or behaviour this file leaves open.

Each file is checked by the following rule, which is exact. For every function in the list below, a copy of the code is made in
which that one function (exported from the module named in the list) is replaced by a stub that throws an error, and the
test file of that same module is run against the copy. It must fail. So every function listed for a module needs at least one test in that module's file that calls it, directly or through another function of the same module or one that module imports (and, to be
useful, asserts on its result or its error); a function that no test in the module's own file calls survives the stub and fails
the check. A call made only from another module's test file does not count. The files must also pass on the correct code.

- `time`: `parseDate`, `formatDate`, `addDays`, `weekdayOf`, `parseInstant`, `formatInstant`
- `offset`: `parseOffset`, `formatOffset`, `localParts`, `dayRange`
- `interval`: `makeInterval`, `overlaps`, `contains`, `intersect`, `mergeIntervals`, `subtractIntervals`, `totalLength`, `coverageAtLeast`
- `hours`: `parseClock`, `formatClock`, `validateHours`, `openIntervals`
- `rules`: `validateRule`, `occurrenceDates`, `ruleIntervals`
- `resource`: `createResource`
- `clock`: `createClock`
- `sort`: `sortBy`
- `store`: `createStore`, `addResource`, `getResource`, `listResources`, `addRule`, `listBookings`, `invalidate`
- `availability`: `occupiedInterval`, `fullIntervals`, `openWindows`, `isWithinOpen`, `bookingFits`, `freeSlots`
- `booking`: `toInstant`, `createBooking`
- `waitlist`: `joinWaitlist`, `listWaitlist`, `promoteWaitlist`
- `cancel`: `cancelBooking`
- `batch`: `bookMany`
- `report`: `percent`, `buildReport`
- `format`: `formatBooking`, `formatSlot`, `formatReport`
- `state-io`: `exportState`, `importState`, `saveStateFile`, `loadStateFile`
- `args`: `parseArgs`
- `cli`: `run`
