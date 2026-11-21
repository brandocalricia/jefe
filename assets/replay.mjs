#!/usr/bin/env node
// REPLAY, not a recording of a live session. Deterministic: feeds the event log in
// tests/fixtures/real-sequence.json through hooks/reducer.mjs and draws each state with
// hooks/band.mjs. No model call. Steps marked "synthetic" in the fixture were added by
// hand to finish the story and are labelled as such here.
//
//   node assets/replay.mjs                 frames to the terminal, ~0.8 s apart
//   node assets/replay.mjs --fast          no delay
//   NO_COLOR=1 node assets/replay.mjs      plain text
//   node assets/replay.mjs --gif-script    prints the commands that would make the GIF

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reduce, initialState } from '../hooks/reducer.mjs';
import { bandLines, bannerLine, BANNER_STEPS, toAnsi } from '../hooks/band.mjs';

const args = process.argv.slice(2);
const plain = process.env.NO_COLOR !== undefined;
const still = process.env.JEFE_STILL !== undefined;
const ascii = !/utf-?8/i.test(process.env.LC_ALL || process.env.LANG || '');
const columns = Math.min(process.stdout.columns || 100, 110);

if (args.includes('--gif-script')) {
  console.log(`# Needs vhs (https://github.com/charmbracelet/vhs), or asciinema + agg. Install one of them first.
# vhs:      vhs assets/demo/demo.tape         (write a tape that runs: node assets/replay.mjs)
# asciinema: asciinema rec -c "node assets/replay.mjs" assets/demo/demo.cast && agg assets/demo/demo.cast assets/demo/demo.gif`);
  process.exit(0);
}

const fx = JSON.parse(readFileSync(fileURLToPath(new URL('../tests/fixtures/real-sequence.json', import.meta.url)), 'utf8'));
const sleep = (ms) => (args.includes('--fast') ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
const opts = { plain, ascii, columns };
const draw = (lines) => console.log(toAnsi(lines, { plain }));

console.log(`REPLAY of the event log in tests/fixtures/real-sequence.json (no model, no live session)`);
console.log('');
let s = initialState();
let i = 0;
for (const step of fx.steps) {
  s = reduce(s, step.event);
  i += 1;
  if (i === 1 && !still) {
    for (let b = 0; b < BANNER_STEPS; b++) {
      draw([bannerLine(b, opts)]);
      await sleep(100);
    }
  }
  console.log(`-- frame ${i}: ${step.label}${step.source === 'synthetic' ? '  [synthetic step, not observed]' : ''}`);
  draw(bandLines(s, opts));
  console.log('');
  await sleep(800);
}
