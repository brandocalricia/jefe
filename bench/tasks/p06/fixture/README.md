# slotwise

Booking and scheduling for small venues: rooms, courts, chairs, equipment. Slotwise keeps opening hours,
recurring availability rules, bookings with cleaning buffers, a waitlist and utilisation reports. It is a plain
Node 22 ES module library with a small command line. No dependencies.

Time zones are fixed offsets from UTC (`+02:00`, `-05:00`, `Z`). There is no daylight saving logic on purpose:
a resource lives at one offset.

## Quick start

```sh
export SLOTWISE_NOW=2025-03-03T08:00Z      # pretend it is Monday morning
node bin/slotwise.mjs resource add --state venue.json --id room-a --name "Room A" \
  --hours "mon=09:00-17:00,tue=09:00-17:00" --buffer 15
node bin/slotwise.mjs book --state venue.json --resource room-a \
  --start 2025-03-10T09:00Z --end 2025-03-10T10:00Z --customer ann
node bin/slotwise.mjs free --state venue.json --resource room-a --date 2025-03-10
node bin/slotwise.mjs report --state venue.json --from 2025-03-10T00:00Z --to 2025-03-11T00:00Z
```

`data/sample-state.json` is a small state file you can read with any command (`--state data/sample-state.json`).

## Layout

- `src/` the library, one module per concern (time, offsets, intervals, opening hours, rules, resources, store,
  availability, bookings, waitlist, cancellation, batch import, reports, formatting, state files, CLI)
- `bin/slotwise.mjs` the executable
- `tests/` one test file per module
- `docs/ISSUES.md` open bug reports
- `SPEC.md` what the library must do

Run the tests with `npm test`.
