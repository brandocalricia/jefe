import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASCII_MARKS, BASE, CREST, CYCLE_FRAMES, FRAME_MS, LOOP_FRAMES, MARKS, NEAR, SETS, SETTLE_FRAMES, SWEEP_FRAMES, colorMode, glintPos, glintTones, helperNames, isAnimating, jefeLine, lineText, markFor, parkText, phaseWord, shimmer, toneAt } from '../hooks/line.mjs';
import { initialState, reduce } from '../hooks/reducer.mjs';

const started = () => reduce(initialState(), { type: 'start', task: 'x' });
const spawn = (s, id, agentType, model) => reduce(s, { type: 'spawn', id, agentType, model });
const go = (s) => reduce(reduce(s, { type: 'question', questions: [{ question: 'q', options: ['Go', 'Change'] }] }), { type: 'answer', answers: { q: 'Go' } });
const text = (s, o) => lineText(jefeLine(s, o));

test('no job active: no line at all', () => {
  assert.deepEqual(jefeLine(initialState(), {}), []);
  assert.deepEqual(jefeLine(null, {}), []);
});

test('phase words: plan, build, check, done, parked', () => {
  let s = started();
  assert.equal(phaseWord(s), 'plan');
  s = go(s);
  assert.equal(phaseWord(s), 'build'); // direct run
  s = spawn(s, 'a', 'jefe:builder', 'sonnet');
  assert.equal(phaseWord(s), 'build');
  assert.equal(phaseWord({ ...s, phase: 'REVIEW' }), 'check');
  assert.equal(phaseWord({ ...s, phase: 'REPORT' }), 'done');
  assert.equal(phaseWord({ ...s, parked: true }), 'parked');
  assert.equal(phaseWord({ ...s, reviewing: true, phase: 'WORKING' }), 'check');
});

test('line content per state, plain text', () => {
  let s = started();
  assert.equal(text(s, { plain: true }), 'jefe · ◇ plan');
  s = spawn(go(s), 'a', 'jefe:builder', 'claude-sonnet-4-6');
  s = spawn(s, 'b', 'jefe:runner', 'haiku');
  assert.equal(text(s, { plain: true }), 'jefe · ◆ build · builder(sonnet), runner(haiku)');
  s = reduce(s, { type: 'agents', list: [{ id: 'a', status: 'completed' }, { id: 'b', status: 'completed' }] });
  assert.equal(text(s, { plain: true }), 'jefe · ◆ build');
  s = reduce(s, { type: 'turn_end', isAborted: false, parked: null, end: 'pass' });
  assert.equal(text(s, { plain: true }), 'jefe · ✓ done');
});

test('identical helpers merge', () => {
  let s = go(started());
  s = spawn(spawn(s, 'a', 'jefe:builder', 'sonnet'), 'b', 'jefe:builder', 'sonnet');
  assert.deepEqual(helperNames(s), ['builder(sonnet) x2']);
});

test('parked line: the reason is the one number allowed', () => {
  let s = spawn(go(started()), 'a', 'jefe:builder', 'sonnet');
  s = reduce(s, { type: 'turn_end', isAborted: false, parked: 'usage' });
  const at = new Date(2026, 10, 17, 20, 30).toISOString();
  assert.equal(text(s, { plain: true, park: { reason: 'usage', percent: 86.2, resetsAt: at } }), 'jefe parked: usage 86%, resets 20:30');
  assert.equal(text(s, { plain: true, park: { reason: 'usage', percent: 86 } }), 'jefe parked: usage 86%');
  assert.equal(text(s, { plain: true, park: { reason: 'context', percent: 72 } }), 'jefe parked: context 72%');
  assert.equal(text(s, { plain: true, park: { reason: null } }), 'jefe parked');
  assert.equal(parkText(null), '');
});

test('nothing else on the line: no context, usage, cost or level', () => {
  let s = spawn(go(started()), 'a', 'jefe:builder', 'sonnet');
  s = reduce(s, { type: 'context', reading: { tokens: 9, window: 10, percent: 90, over: true } });
  s = { ...s, planner: 'opus' };
  const t = text(s, { plain: true, level: { level: 'high', usedPercent: 91 } });
  assert.equal(t, 'jefe · ◆ build · builder(sonnet)');
  assert.ok(!/%|ctx|\$|level|planner|opus|plan usage/.test(t.replace('jefe · ◆ build', '')));
});

test('never wider than the columns: helpers go first, then the phase', () => {
  let s = go(started());
  for (const [i, t] of ['builder', 'runner', 'researcher'].entries()) s = spawn(s, 'x' + i, 'jefe:' + t, 'sonnet');
  const full = text(s, { plain: true, columns: 200 });
  assert.equal(full, 'jefe · ◆ build · builder(sonnet), runner(sonnet), researcher(sonnet)');
  for (let c = 4; c <= 70; c++) {
    const t = text(s, { plain: true, columns: c });
    assert.ok([...t].length <= c, `${c}: ${t}`);
    assert.ok(t.startsWith('jefe'.slice(0, c)), t);
  }
  assert.equal(text(s, { plain: true, columns: 42 }), 'jefe · ◆ build · builder(sonnet) +2');
  assert.equal(text(s, { plain: true, columns: 14 }), 'jefe · ◆ build');
  assert.equal(text(s, { plain: true, columns: 13 }), 'jefe');
  assert.equal(text(s, { plain: true, columns: 2 }), 'jefe'); // floor of 4 columns
});

const HEX = /^#[0-9a-f]{6}$/;
// exact xterm-256 colours: components from the cube 0,95,135,175,215,255
const CUBE = [0, 95, 135, 175, 215, 255];
const exact256 = (c) => HEX.test(c) && [1, 3, 5].every((i) => CUBE.includes(parseInt(c.slice(i, i + 2), 16)));
const frames = (f) => Array.from({ length: CYCLE_FRAMES }, (_, i) => f(i));

test('timing: at most 8 fps, one glint then a rest, about every 3.5 s, seamless wrap', () => {
  assert.ok(FRAME_MS >= 125);
  assert.ok(CYCLE_FRAMES * FRAME_MS >= 2500 && CYCLE_FRAMES * FRAME_MS <= 3600);
  assert.ok(CYCLE_FRAMES - SWEEP_FRAMES >= 8, 'a real pause between glints');
  assert.equal(LOOP_FRAMES % CYCLE_FRAMES, 0);
  assert.deepEqual(shimmer(0), shimmer(LOOP_FRAMES));
  assert.deepEqual(shimmer(-1), shimmer(LOOP_FRAMES - 1));
  assert.deepEqual(glintTones(CYCLE_FRAMES + 3), glintTones(3));
});

test('constant weight: the whole word is bold in every frame, colour only changes', () => {
  for (let f = 0; f < CYCLE_FRAMES; f++) for (const x of shimmer(f)) assert.equal(x.bold, true);
  for (let f = 0; f < CYCLE_FRAMES; f++) for (const x of jefeLine(go(started()), { frame: f }).slice(0, 4)) assert.equal(x.bold, true);
});

test('glint with falloff: crest, neighbours one step down, rest at base; three tones visible at once', () => {
  let three = 0;
  const crestAt = [];
  for (let f = 0; f < CYCLE_FRAMES; f++) {
    const t = glintTones(f);
    if (new Set(t).size === 3) three++;
    const c = t.indexOf(CREST);
    crestAt.push(c);
    if (c >= 0) {
      t.forEach((v, i) => assert.equal(v, Math.abs(i - c) === 1 ? NEAR : i === c ? CREST : BASE, `f${f} ${t}`));
    }
  }
  assert.ok(three >= 4, 'three tones at once for several frames');
  const seen = crestAt.filter((c) => c >= 0);
  assert.deepEqual([...new Set(seen)], [0, 1, 2, 3, 4], 'the crest visits j, e, f, e and the mark');
  assert.deepEqual(seen, [...seen].sort((x, y) => x - y), 'left to right only');
});

test('the glint lands on the mark: it flashes for 2-3 frames, then the long rest', () => {
  const flash = frames((f) => glintTones(f)[4]).filter((t) => t === CREST).length;
  assert.ok(flash >= 2 && flash <= 3, `flash frames: ${flash}`);
  const idx = frames((f) => glintTones(f)[4]);
  const first = idx.indexOf(CREST);
  assert.ok(idx.slice(first, first + flash).every((t) => t === CREST), 'consecutive');
  for (let f = SWEEP_FRAMES; f < CYCLE_FRAMES; f++) assert.deepEqual(glintTones(f), [BASE, BASE, BASE, BASE, BASE], `rest ${f}`);
  // the separator dots stay dim in every frame
  for (let f = 0; f < CYCLE_FRAMES; f++) {
    const sep = jefeLine(go(started()), { frame: f })[4];
    assert.equal(sep.t, ' · ');
    assert.equal(sep.dim, true);
    assert.equal(sep.color, undefined);
  }
});

test('easing: the glint accelerates in and decelerates out', () => {
  const pos = [];
  for (let f = 0; f < SWEEP_FRAMES; f++) pos.push(f / (SWEEP_FRAMES - 1));
  const step = pos.slice(1).map((p, i) => glintPos(p) - glintPos(pos[i]));
  assert.ok(step[0] < step[Math.floor(step.length / 2)] && step[step.length - 1] < step[Math.floor(step.length / 2)]);
  assert.ok(step.every((d) => d > 0), 'never goes back');
});

test('colours: only exact xterm-256 hex in every set, three distinct tones, none without colour', () => {
  for (const [name, set] of Object.entries(SETS)) {
    assert.equal(set.length, 3, name);
    assert.equal(new Set(set).size, 3, name);
    for (const c of set) assert.ok(exact256(c), `${name} ${c}`);
  }
  assert.deepEqual(SETS.dark, ['#d78700', '#ffaf00', '#ffd787']); // 172, 214, 222
  assert.deepEqual(SETS.light, ['#af5f00', '#d75f00', '#ff8700']); // 130, 166, 208
  assert.deepEqual(SETS.mid, ['#d75f00', '#ff8700', '#ffaf00']); // 166, 208, 214, the set the mod ships
  for (const scheme of ['dark', 'light', 'mid']) {
    for (let f = 0; f < CYCLE_FRAMES; f++) {
      for (const x of shimmer(f, { scheme })) assert.ok(SETS[scheme].includes(x.color));
      for (const x of jefeLine(go(started()), { frame: f, scheme }).filter((x) => x.color)) assert.ok(SETS[scheme].includes(x.color));
    }
  }
  for (const f of [0, 5, 11]) for (const x of shimmer(f, { mode: 'none' })) assert.equal(x.color, undefined);
  for (const f of [0, 5, 11]) for (const x of shimmer(f, { plain: true })) assert.equal(x.color, undefined);
  assert.equal(toneAt(CREST, 'none'), undefined);
  assert.equal(toneAt(BASE), SETS.mid[0]);
  // the light set's crest is darker than a white-background floor: relative luminance well under 0.6
  const lum = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).reduce((a, v, k) => a + v * [0.2126, 0.7152, 0.0722][k], 0);
  assert.ok(lum(SETS.light[2]) < 0.6 && lum(SETS.light[0]) < lum(SETS.light[2]));
  assert.ok(lum(SETS.dark[2]) > lum(SETS.dark[1]) && lum(SETS.dark[1]) > lum(SETS.dark[0]));
});

test('no truecolor ever: colorMode is 256 or none whatever the environment says', () => {
  assert.equal(colorMode({ surface: 'terminal', termProgram: 'Apple_Terminal', colorterm: 'truecolor' }), '256');
  assert.equal(colorMode({ surface: 'terminal', colorterm: '24bit' }), '256');
  assert.equal(colorMode({ surface: 'desktop' }), '256');
  assert.equal(colorMode({ surface: 'desktop', plain: true }), 'none');
  assert.equal(colorMode({ plain: true, colorterm: 'truecolor' }), 'none');
  const src = readFileSync(new URL('../hooks/line.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/rgb\(|\\x1b|\\u001b/.test(src));
});

test('static modes: still freezes the word, plain has no colour and no motion', () => {
  assert.deepEqual(shimmer(5, { still: true }), shimmer(9, { still: true }));
  assert.deepEqual(glintTones(9, { still: true }), [BASE, BASE, BASE, BASE, BASE]);
  for (const x of shimmer(5, { plain: true })) assert.equal(x.color, undefined);
  const s = spawn(go(started()), 'a', 'jefe:builder', 'sonnet');
  for (const x of jefeLine(s, { plain: true, frame: 3 })) assert.equal(x.color, undefined);
  assert.deepEqual(jefeLine(s, { still: true, frame: 1 }), jefeLine(s, { still: true, frame: 9 }));
  assert.equal(isAnimating(s, { still: true }), false);
  assert.equal(isAnimating(s, { plain: true }), false);
  assert.equal(isAnimating(s, { mode: 'none' }), false);
});

test('animation only while work is running', () => {
  const s = go(started());
  assert.equal(isAnimating(s), true);
  assert.equal(isAnimating(initialState()), false);
  assert.equal(isAnimating({ ...s, parked: true }), false);
  assert.equal(isAnimating({ ...s, phase: 'REPORT' }), false);
});

test('phase marks: unicode, ascii fallback, one cell each', () => {
  assert.deepEqual(Object.keys(MARKS), ['plan', 'build', 'check', 'done']);
  const all = new Set([...Object.values(MARKS), ...Object.values(ASCII_MARKS)]);
  assert.equal(all.size, 8, 'all distinct');
  for (const m of Object.values(ASCII_MARKS)) assert.match(m, /^[\x21-\x7e]$/);
  for (const m of Object.values(MARKS)) assert.equal([...m].length, 1);
  assert.equal(markFor('build'), '◆');
  assert.equal(markFor('build', true), '*');
  assert.equal(markFor('parked'), '');
  const s = spawn(go(started()), 'a', 'jefe:builder', 'sonnet');
  assert.equal(text(s, { plain: true, ascii: true }), 'jefe · * build · builder(sonnet)');
  assert.equal(text(started(), { plain: true, ascii: true }), 'jefe · o plan');
  assert.equal(text({ ...s, phase: 'REVIEW' }, { plain: true }), 'jefe · ◈ check · builder(sonnet)');
  assert.equal(text({ ...s, phase: 'REVIEW' }, { plain: true, ascii: true }), 'jefe · + check · builder(sonnet)');
});

test('done: one last glint lands on the mark as it turns into the check, then it rests on the check', () => {
  const s = reduce(go(started()), { type: 'turn_end', isAborted: false, parked: null, end: 'pass' });
  assert.equal(phaseWord(s), 'done');
  assert.equal(isAnimating(s, { settleFrame: 0 }), true);
  assert.equal(isAnimating(s, { settleFrame: SETTLE_FRAMES - 1 }), true);
  assert.equal(isAnimating(s, { settleFrame: SETTLE_FRAMES }), false);
  assert.equal(isAnimating(s, {}), false);
  assert.equal(isAnimating(s, { settleFrame: 0, still: true }), false);
  const crest = new Set();
  const marks = [];
  for (let f = 0; f < SETTLE_FRAMES; f++) {
    const segs = jefeLine(s, { frame: 5 + f, settleFrame: f });
    segs.slice(0, 4).forEach((x, i) => x.color === SETS.mid[CREST] && crest.add(i));
    const m = segs[5];
    if (m.color === SETS.mid[CREST]) crest.add(4);
    marks.push(m.t);
    assert.ok(segs.slice(0, 4).every((x) => x.bold));
  }
  assert.deepEqual([...crest].sort(), [0, 1, 2, 3, 4], 'the last glint covers every letter and the mark');
  assert.equal(marks[0], '◆');
  assert.equal(marks[marks.length - 1], '✓');
  assert.ok(marks.indexOf('✓') > 0 && marks.slice(marks.indexOf('✓')).every((m) => m === '✓'), 'turns into the check once, as the glint lands');
  const after = jefeLine(s, { frame: 30, settleFrame: SETTLE_FRAMES });
  assert.equal(lineText(after), 'jefe · ✓ done');
  assert.ok(after.slice(0, 4).every((x) => x.color === SETS.mid[BASE]));
  assert.equal(lineText(jefeLine(s, { plain: true })), 'jefe · ✓ done');
  assert.equal(lineText(jefeLine(s, { still: true, settleFrame: 0 })), 'jefe · ✓ done');
});

test('parked: static, readable, one reason; word and text do not move', () => {
  let s = spawn(go(started()), 'a', 'jefe:builder', 'sonnet');
  s = reduce(s, { type: 'turn_end', isAborted: false, parked: 'usage' });
  const park = { reason: 'usage', percent: 86, resetsAt: new Date(2026, 10, 17, 20, 30).toISOString() };
  const a = jefeLine(s, { frame: 3, park });
  assert.equal(lineText(a), 'jefe parked: usage 86%, resets 20:30');
  assert.deepEqual(a, jefeLine(s, { frame: 17, park }));
  assert.equal(isAnimating(s, {}), false);
  assert.equal(lineText(jefeLine(s, { mode: '256', park, columns: 20 })), 'jefe parked');
  assert.equal(lineText(jefeLine(s, { mode: '256', park, columns: 6 })), 'jefe');
});

test('truncation drops helpers first, then the phase, with colour on too', () => {
  let s = go(started());
  for (const [i, t] of ['builder', 'runner'].entries()) s = spawn(s, 'x' + i, 'jefe:' + t, 'sonnet');
  for (const mode of ['256', 'none']) {
    for (let c = 4; c <= 70; c++) assert.ok([...lineText(jefeLine(s, { mode, frame: 4, columns: c }))].length <= c);
  }
  assert.equal(lineText(jefeLine(s, { mode: '256', columns: 80 })), 'jefe · ◆ build · builder(sonnet), runner(sonnet)');
  assert.equal(lineText(jefeLine(s, { mode: '256', columns: 38 })), 'jefe · ◆ build · builder(sonnet) +1');
  assert.equal(lineText(jefeLine(s, { mode: '256', columns: 20 })), 'jefe · ◆ build');
});

test('the mod sends nothing to the model on its own', () => {
  const src = readFileSync(new URL('../hooks/jefe.jsx', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  for (const bad of ['$.prompt', '$.turn', 'sendMessage', 'enqueue', '$.session.send', '$.model.']) assert.ok(!src.includes(bad), bad);
  assert.ok(!/SessionMode/.test(src), 'no footer chip');
});

test('cellWidth counts wide characters as two cells, combining marks as none', async () => {
  const { cellWidth } = await import('../hooks/band.mjs');
  assert.equal(cellWidth('a'), 1);
  assert.equal(cellWidth('漢'), 2);
  assert.equal(cellWidth('🚀'), 2);
  assert.equal(cellWidth('́'), 0);
});

test('the mod reads only documented motion/colour env names, and the parked percentage is the five-hour window', () => {
  const src = readFileSync(new URL('../hooks/jefe.jsx', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!src.includes('REDUCED_MOTION'));
  assert.ok(src.includes("'NO_COLOR'") && src.includes("'JEFE_STILL'"));
  assert.ok(/fiveHourOf\(lastUsage\)/.test(src));
});
