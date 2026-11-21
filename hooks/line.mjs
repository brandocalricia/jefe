// The one quiet line Jefe draws above the prompt while a /jefe job is active. Pure: no Claude Code imports.
//
//   jefe · ◆ build · builder(sonnet), runner(haiku)
//   jefe parked: usage 86%, resets 20:30
//
// Jefe's own calm cousin of Claude Code's "ultrathink" rainbow: ONE warm hue (amber to ember), the word at one
// constant bold weight, colour only. Every 3.5 s a glint runs through j-e-f-e (crest tone on the letter it is on,
// one step down on its neighbours, base tone on the rest: three tones at once, eased in and out) and LANDS on
// the phase mark, which flashes for 2-3 frames; then a long rest. Nothing blinks or bounces; at most 8 fps.
// Phase marks: plan ◇, build ◆, check ◈, done ✓ (ASCII fallback o * + v). The separator dots stay dim.
// Nothing else is on the line. The one number allowed is the reason a run is parked.
//
// Colours are exact xterm-256 entries only (the stock macOS Terminal.app has no truecolor), so every mode
// that draws colour draws the same hex; 'none' (NO_COLOR) draws weight and dim only. The mod API does not
// tell a mod whether the theme is light or dark, so the shipped set is a middle one (opts.scheme 'mid');
// 'dark' and 'light' sets exist for preview and for a host that knows.
//
// A segment is { t, color?, bold?, dim? }.

import { cellWidth } from './band.mjs';
import { modelWord } from './levels.mjs';
import { isRunning } from './reducer.mjs';

export const FRAME_MS = 125; // 8 frames per second at most
export const SWEEP_FRAMES = 18; // the glint runs for 2.25 s ...
export const CYCLE_FRAMES = 28; // ... then rests; one glint every 3.5 s
export const LOOP_FRAMES = CYCLE_FRAMES; // the frame counter wraps here
export const SETTLE_FRAMES = SWEEP_FRAMES; // on done: one last glint, landing on the mark
const WORD = 'jefe';
const SEP = ' · ';

// [base, near the crest, crest]; every value is an exact xterm-256 colour.
export const SETS = {
  dark: ['#d78700', '#ffaf00', '#ffd787'], // 172, 214, 222
  light: ['#af5f00', '#d75f00', '#ff8700'], // 130, 166, 208
  mid: ['#d75f00', '#ff8700', '#ffaf00'], // 166, 208, 214: reads on both
};
export const BASE = 0;
export const NEAR = 1;
export const CREST = 2;
const MARK_AT = WORD.length; // the glint's fifth stop

const seg = (t, o = {}) => ({ t, ...o });
const markWidth = (ch) => (ch === '\u2713' ? 1 : cellWidth(ch)); // check mark is one cell in terminal fonts
const width = (s) => [...s].reduce((n, ch) => n + markWidth(ch), 0);
const len = (segs) => segs.reduce((n, s) => n + width(s.t), 0);

// Which colour depth to draw in: 'none' or '256'. (Truecolor is deliberately never used: Terminal.app has none,
// and its environment may still claim it.) Kept as a function of the surface so the host can decide.
export function colorMode({ plain } = {}) {
  return plain ? 'none' : '256';
}

// The colour of a tone (BASE, NEAR, CREST) in a set, or undefined without colour.
export function toneAt(tone, mode = '256', scheme = 'mid') {
  if (mode === 'none') return undefined;
  return (SETS[scheme] || SETS.mid)[tone];
}

// Where the glint is, in letter units (0..3 are the letters, 4 the mark), at progress p in [0,1]: eased in and out.
export const GLINT_FROM = -1.5;
export const GLINT_TO = 5.7;
export function glintPos(p) {
  const q = Math.min(1, Math.max(0, p));
  const e = 0.3 * q + 0.7 * (0.5 - 0.5 * Math.cos(Math.PI * q)); // slow in, quick middle, slow out
  return GLINT_FROM + e * (GLINT_TO - GLINT_FROM);
}

// The tone of stop i (0..4) when the glint is at pos.
export function toneIndex(i, pos) {
  const d = Math.abs(i - pos);
  return d < 0.5 ? CREST : d < 1.5 ? NEAR : BASE;
}

// Sweep progress of a frame: null in the rest. settleFrame (a number) plays the done glint once.
export function sweepProgress(frame, opts = {}) {
  if (Number.isFinite(opts.settleFrame)) return opts.settleFrame >= SETTLE_FRAMES ? null : opts.settleFrame / (SWEEP_FRAMES - 1);
  if (!Number.isFinite(frame)) return null;
  const c = ((frame % CYCLE_FRAMES) + CYCLE_FRAMES) % CYCLE_FRAMES;
  return c < SWEEP_FRAMES ? c / (SWEEP_FRAMES - 1) : null;
}

// The phase in one word: plan | build | check | done | parked, or null when none applies.
export function phaseWord(state) {
  if (!state || !state.active || !state.phase) return null;
  if (state.parked) return 'parked';
  if (state.reviewing) return 'check';
  switch (state.phase) {
    case 'INTERVIEW':
    case 'CONFIRM':
      return 'plan';
    case 'WORKING':
    case 'DELEGATE':
      return 'build';
    case 'REVIEW':
      return 'check';
    case 'REPORT':
      return 'done';
    default:
      return null;
  }
}

function shortModel(m) {
  const s = String(m || '');
  return modelWord(s) || s.slice(0, 12);
}

// Running helpers as `builder(sonnet)`; identical ones are merged as `builder(sonnet) x2`.
export function helperNames(state) {
  const counts = new Map();
  for (const a of (state && state.agents) || []) {
    if (!isRunning(a)) continue;
    const type = String(a.type || 'agent').replace(/^jefe:/, '');
    const model = shortModel(a.model);
    const name = model ? `${type}(${model})` : type;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts].map(([name, n]) => (n > 1 ? `${name} x${n}` : name));
}

// Does the line move in this state? While work is running, and for the one settling glint of `done`
// (opts.settleFrame = frames since done began; the mod stops the timer once it reaches SETTLE_FRAMES).
export function isAnimating(state, opts = {}) {
  if (opts.still || opts.plain || opts.mode === 'none') return false;
  const p = phaseWord(state);
  if (p === 'done') return !state.unchecked && Number.isFinite(opts.settleFrame) && opts.settleFrame < SETTLE_FRAMES;
  return p !== null && p !== 'parked';
}

// Phase marks, unicode and ASCII (single-width in common terminal fonts).
export const MARKS = { plan: '\u25c7', build: '\u25c6', check: '\u25c8', done: '\u2713' };
export const ASCII_MARKS = { plan: 'o', build: '*', check: '+', done: 'v' };
export const markFor = (phase, ascii) => (ascii ? ASCII_MARKS : MARKS)[phase] || '';

// The five tone indexes [j, e, f, e, mark] of a frame (all BASE in the rest, when still, or with no frame).
export function glintTones(frame, opts = {}) {
  if (opts.still) return [BASE, BASE, BASE, BASE, BASE];
  const p = sweepProgress(frame, opts);
  if (p === null) return [BASE, BASE, BASE, BASE, BASE];
  const pos = glintPos(p);
  return [0, 1, 2, 3, MARK_AT].map((i) => toneIndex(i, pos));
}

// "jefe": letters at ONE constant bold weight, colour only. opts: { mode, scheme, still, settleFrame, plain }.
export function shimmer(frame, opts = {}) {
  const mode = opts.plain ? 'none' : opts.mode || '256';
  if (mode === 'none') return [seg(WORD, { bold: true })];
  const tones = glintTones(frame, opts);
  return [...WORD].map((ch, i) => seg(ch, { color: toneAt(tones[i], mode, opts.scheme), bold: true }));
}

// "HH:MM" local time of an ISO string, or null.
export function formatReset(iso) {
  const t = iso ? new Date(iso) : null;
  if (!t || !Number.isFinite(t.getTime())) return null;
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

// The reason text of a parked run: `usage 86%, resets 20:30` | `context 72%` | '' when unknown.
// park: { reason: 'usage'|'context'|null, percent?: number, resetsAt?: string }.
export function parkText(park) {
  const p = park || {};
  const pct = typeof p.percent === 'number' && Number.isFinite(p.percent) ? ` ${Math.round(p.percent)}%` : '';
  if (p.reason === 'usage') {
    const at = formatReset(p.resetsAt);
    return `usage${pct}${at ? `, resets ${at}` : ''}`;
  }
  if (p.reason === 'context') return `context${pct}`;
  return '';
}

const plainOf = (segs, opts) => (opts.plain || opts.mode === 'none' ? segs.map(({ color, ...rest }) => rest) : segs);

// The whole line as segments, [] when no job is active.
// opts: { frame, settleFrame, mode, scheme, plain, still, ascii, columns, park }.
// Never wider than opts.columns: helpers go first, then the phase, then the word is cut.
export function jefeLine(state, opts = {}) {
  const phase = phaseWord(state);
  if (!phase) return [];
  const columns = Math.max(4, Number.isFinite(opts.columns) ? opts.columns : 80);
  const mode = opts.plain ? 'none' : opts.mode || '256';
  const quiet = (t) => seg(t, { dim: true });
  const settling = phase === 'done' && !opts.still && mode !== 'none' && Number.isFinite(opts.settleFrame) && opts.settleFrame < SETTLE_FRAMES;

  if (phase === 'parked') {
    const word = shimmer(opts.frame, { ...opts, still: true, mode });
    const why = parkText(opts.park);
    const warn = { color: 'warning', bold: true };
    const full = [...word, seg(why ? ' parked: ' : ' parked', warn), ...(why ? [seg(why, { color: 'warning' })] : [])];
    const short = [...word, seg(' parked', warn)];
    const pick = [full, short, word].find((l) => len(l) <= columns) || [seg(WORD.slice(0, columns))];
    return plainOf(pick, opts);
  }

  // the job ended with a PASS that checked nothing (no tests, no checks): it is over, but no tick and no glint landing on one
  if (phase === 'done' && state.unchecked) {
    const word = shimmer(opts.frame, { ...opts, still: true, mode });
    const pick = [[...word, quiet(SEP), quiet('done, nothing checked')], [...word, quiet(SEP), quiet('done')], word].find((l) => len(l) <= columns) || [seg(WORD.slice(0, columns))];
    return plainOf(pick, opts);
  }

  const gopts = { ...opts, mode, settleFrame: phase === 'done' ? opts.settleFrame : undefined };
  const word = shimmer(opts.frame, gopts);
  const tones = glintTones(opts.frame, gopts);
  // on done the diamond turns into the check mark at the moment the glint lands on it
  const asCheck = phase === 'done' && !(settling && tones[MARK_AT] === BASE && sweepProgress(opts.frame, gopts) < 0.5);
  const glyph = markFor(asCheck ? 'done' : settling ? 'build' : phase, opts.ascii);
  const mark = seg(glyph, { color: toneAt(tones[MARK_AT], mode, opts.scheme) });
  const lead = [...word, quiet(SEP), mark];
  const helpers = phase === 'done' ? [] : helperNames(state);
  const tiers = [];
  for (let n = helpers.length; n > 0; n--) {
    const shown = helpers.slice(0, n);
    const more = helpers.length - n;
    tiers.push([...lead, quiet(' ' + phase + SEP), seg(shown.join(', ') + (more ? ` +${more}` : ''))]);
  }
  tiers.push([...lead, quiet(' ' + phase)], word);
  const pick = tiers.find((l) => len(l) <= columns) || [seg(WORD.slice(0, columns))];
  return plainOf(pick, opts);
}

export const lineText = (segs) => segs.map((s) => s.t).join('');
