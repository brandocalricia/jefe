// Part E: the tests the model wrote must exist, pass on a correct implementation, and each module's test file must fail
// when any one listed function of that module is replaced by a stub that throws (the rule stated in SPEC.md part E).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OURS = /^(part-[a-e]-|_compat\.mjs$|_ref\.json$)/;
// The correct implementation, as { 'src/time.mjs': '<text>', ... } (kept flat so that hidden/ holds plain files only).
const REF = JSON.parse(readFileSync(join(HERE, '_ref.json'), 'utf8'));

// Exactly the lists in SPEC.md part E.
const FUNCTIONS = {
  time: ['parseDate', 'formatDate', 'addDays', 'weekdayOf', 'parseInstant', 'formatInstant'],
  offset: ['parseOffset', 'formatOffset', 'localParts', 'dayRange'],
  interval: ['makeInterval', 'overlaps', 'contains', 'intersect', 'mergeIntervals', 'subtractIntervals', 'totalLength', 'coverageAtLeast'],
  hours: ['parseClock', 'formatClock', 'validateHours', 'openIntervals'],
  rules: ['validateRule', 'occurrenceDates', 'ruleIntervals'],
  resource: ['createResource'],
  clock: ['createClock'],
  sort: ['sortBy'],
  store: ['createStore', 'addResource', 'getResource', 'listResources', 'addRule', 'listBookings', 'invalidate'],
  availability: ['occupiedInterval', 'fullIntervals', 'openWindows', 'isWithinOpen', 'bookingFits', 'freeSlots'],
  booking: ['toInstant', 'createBooking'],
  waitlist: ['joinWaitlist', 'listWaitlist', 'promoteWaitlist'],
  cancel: ['cancelBooking'],
  batch: ['bookMany'],
  report: ['percent', 'buildReport'],
  format: ['formatBooking', 'formatSlot', 'formatReport'],
  'state-io': ['exportState', 'importState', 'saveStateFile', 'loadStateFile'],
  args: ['parseArgs'],
  cli: ['run'],
};
const MODULES = Object.keys(FUNCTIONS);

function scratch() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'slotwise-stub-')));
}

// A correct implementation plus the model's own test files (everything in tests/ that is not ours).
function baseTree() {
  const dir = scratch();
  for (const [path, text] of Object.entries(REF)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  mkdirSync(join(dir, 'tests'), { recursive: true });
  for (const entry of readdirSync(HERE, { withFileTypes: true })) {
    if (OURS.test(entry.name)) continue;
    cpSync(join(HERE, entry.name), join(dir, 'tests', entry.name), { recursive: true });
  }
  return dir;
}

function runTests(dir, files) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.SLOTWISE_NOW;
    delete env.NODE_TEST_CONTEXT;
    execFile(process.execPath, ['--test', ...files], { cwd: dir, env, timeout: 90000, maxBuffer: 20e6 }, (err, stdout) => {
      resolve({ ok: !err, tail: String(stdout).split('\n').slice(-30).join('\n') });
    });
  });
}

function stubbed(source, fn) {
  const head = new RegExp(`export function ${fn}\\(`);
  assert.ok(head.test(source), `reference module has no exported function ${fn}`);
  return `${source.replace(head, `function __real_${fn}(`)}\nexport function ${fn}() { throw new Error('stubbed ${fn}'); }\n`;
}

test('there is a test file for every module', () => {
  const missing = MODULES.filter((m) => !existsSync(join(HERE, `${m}.test.mjs`)));
  assert.deepEqual(missing, []);
});

test('all the tests pass against a correct implementation', async () => {
  const dir = baseTree();
  const files = readdirSync(join(dir, 'tests')).filter((f) => f.endsWith('.test.mjs')).map((f) => join('tests', f));
  const r = await runTests(dir, files);
  assert.ok(r.ok, r.tail);
});

for (const mod of MODULES) {
  test(`${mod}.test.mjs fails when any single function of ${mod} is stubbed out`, async () => {
    assert.ok(existsSync(join(HERE, `${mod}.test.mjs`)), `tests/${mod}.test.mjs is missing`);
    const base = baseTree();
    const original = readFileSync(join(base, 'src', `${mod}.mjs`), 'utf8');
    const survivors = [];
    const queue = [...FUNCTIONS[mod]];
    async function worker() {
      while (queue.length) {
        const fn = queue.shift();
        const dir = scratch();
        cpSync(base, dir, { recursive: true });
        writeFileSync(join(dir, 'src', `${mod}.mjs`), stubbed(original, fn));
        const r = await runTests(dir, [join('tests', `${mod}.test.mjs`)]);
        if (r.ok) survivors.push(fn);
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    assert.deepEqual(survivors.sort(), [], `these functions can be stubbed without failing tests/${mod}.test.mjs`);
  });
}
