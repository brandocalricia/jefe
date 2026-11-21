import { resolve } from 'node:path';
import { SlotwiseError } from './errors.mjs';
import { createClock } from './clock.mjs';
import { parseArgs } from './args.mjs';
import { addResource, addRule, getResource, listBookings } from './store.mjs';
import { loadStateFile, saveStateFile } from './state-io.mjs';
import { createBooking } from './booking.mjs';
import { cancelBooking } from './cancel.mjs';
import { freeSlots } from './availability.mjs';
import { joinWaitlist, listWaitlist } from './waitlist.mjs';
import { bookMany } from './batch.mjs';
import { buildReport } from './report.mjs';
import { formatBooking, formatReport, formatSlot } from './format.mjs';
import { formatInstant } from './time.mjs';
import { readFileSync } from 'node:fs';

function need(options, name) {
  if (options[name] === undefined) throw new SlotwiseError('E_INVALID', `missing option --${name}`);
  return options[name];
}

function whole(text, name) {
  const n = Number(text);
  if (text === '' || !Number.isInteger(n)) throw new SlotwiseError('E_INVALID', `invalid number for --${name}: ${text}`);
  return n;
}

// --hours "mon=09:00-12:00,mon=13:00-17:00,tue=09:00-17:00"
function parseHoursOption(text) {
  const hours = {};
  for (const entry of text.split(',')) {
    const m = /^([a-z]{3})=(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(entry);
    if (!m) throw new SlotwiseError('E_INVALID', `invalid hours option: ${entry}`);
    (hours[m[1]] ??= []).push([m[2], m[3]]);
  }
  return hours;
}

const sub = (positional, allowed) => {
  if (!allowed.includes(positional[0])) throw new SlotwiseError('E_INVALID', `unknown subcommand: ${positional[0] ?? ''}`);
  return positional[0];
};

const COMMANDS = {
  resource({ store, positional, options, print }) {
    sub(positional, ['add']);
    const input = { id: need(options, 'id'), name: need(options, 'name'), offset: options.offset };
    if (options.capacity !== undefined) input.capacity = whole(options.capacity, 'capacity');
    if (options.buffer !== undefined) input.buffer = whole(options.buffer, 'buffer');
    if (options.hours !== undefined) input.hours = parseHoursOption(options.hours);
    addResource(store, input);
    print(`resource added: ${input.id}`);
    return { changed: true };
  },
  rule({ store, positional, options, print }) {
    sub(positional, ['add']);
    const rule = { frequency: need(options, 'frequency'), start: need(options, 'start'), from: need(options, 'from'), to: need(options, 'to') };
    if (options.every !== undefined) rule.interval = whole(options.every, 'every');
    if (options.until !== undefined) rule.until = options.until;
    if (options.count !== undefined) rule.count = whole(options.count, 'count');
    if (options.weekdays !== undefined) rule.weekdays = options.weekdays.split(',');
    addRule(store, need(options, 'resource'), rule);
    print(`rule added: ${options.resource}`);
    return { changed: true };
  },
  book({ store, options, print, clock }) {
    const booking = createBooking(store, { resourceId: need(options, 'resource'), start: need(options, 'start'), end: need(options, 'end'), customer: need(options, 'customer'), clock });
    print(`booked ${formatBooking(booking, getResource(store, booking.resourceId).offset)}`);
    return { changed: true };
  },
  cancel({ store, options, print, clock }) {
    const { cancelled, promoted } = cancelBooking(store, { bookingId: need(options, 'id'), clock });
    print(`cancelled ${cancelled.id}`);
    for (const b of promoted) print(`promoted ${formatBooking(b, getResource(store, b.resourceId).offset)}`);
    return { changed: true };
  },
  free({ store, options, print, clock }) {
    const resource = getResource(store, need(options, 'resource'));
    const slots = freeSlots(store, { resourceId: resource.id, date: need(options, 'date'), minMinutes: options.min === undefined ? 1 : whole(options.min, 'min'), clock });
    if (slots.length === 0) print('no free slots');
    for (const slot of slots) print(formatSlot(slot, resource.offset));
    return { changed: false };
  },
  waitlist({ store, positional, options, print }) {
    if (sub(positional, ['add', 'list']) === 'add') {
      const entry = joinWaitlist(store, { resourceId: need(options, 'resource'), start: need(options, 'start'), end: need(options, 'end'), customer: need(options, 'customer') });
      print(`waitlisted ${entry.id}`);
      return { changed: true };
    }
    for (const w of listWaitlist(store, options.resource)) {
      const offset = getResource(store, w.resourceId).offset;
      print([w.id, w.resourceId, formatInstant(w.start, offset), formatInstant(w.end, offset), w.customer].join(' '));
    }
    return { changed: false };
  },
  list({ store, options, print }) {
    const bookings = listBookings(store, { resourceId: options.resource, status: options.status });
    if (options.json) print(JSON.stringify(bookings, null, 2));
    else for (const b of bookings) print(formatBooking(b, getResource(store, b.resourceId).offset));
    return { changed: false };
  },
  report({ store, options, print, clock }) {
    const report = buildReport(store, { from: need(options, 'from'), to: need(options, 'to'), clock });
    print(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return { changed: false };
  },
  import({ store, options, print, cwd, clock }) {
    let specs;
    try {
      specs = JSON.parse(readFileSync(resolve(cwd, need(options, 'file')), 'utf8'));
    } catch (err) {
      if (err instanceof SyntaxError || err.code === 'ENOENT') throw new SlotwiseError('E_INVALID', `cannot read bookings file: ${options.file}`);
      throw err;
    }
    const { booked, failed } = bookMany(store, { bookings: specs, clock });
    print(`booked ${booked.length}`);
    for (const f of failed) print(`failed ${f.index}: ${f.message}`);
    return { changed: true, code: failed.length ? 1 : 0 };
  },
};

// Runs one command line (the words after "slotwise"). Returns { code, stdout, stderr }; nothing is printed here.
// Exit codes: 0 success, 1 a SlotwiseError or a failed import entry, 2 usage error (no or unknown command).
export function run(argv, env = process.env, cwd = process.cwd()) {
  let stdout = '';
  const print = (line) => { stdout += `${line}\n`; };
  try {
    const { command, positional, options } = parseArgs(argv);
    if (command === null) return { code: 2, stdout, stderr: 'usage: slotwise <command> [options]\n' };
    if (!Object.hasOwn(COMMANDS, command)) return { code: 2, stdout, stderr: `unknown command: ${command}\n` };
    const clock = createClock({ now: options.now ?? env.SLOTWISE_NOW });
    const statePath = resolve(cwd, options.state ?? 'slotwise.json');
    const store = loadStateFile(statePath);
    const result = COMMANDS[command]({ store, positional, options, print, cwd, clock });
    if (result.changed) saveStateFile(statePath, store);
    return { code: result.code ?? 0, stdout, stderr: '' };
  } catch (err) {
    if (!(err instanceof SlotwiseError)) throw err;
    return { code: 1, stdout, stderr: `error: ${err.message}\n` };
  }
}
