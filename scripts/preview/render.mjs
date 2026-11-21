// Filmstrip preview of the Jefe line: node scripts/preview/render.mjs
// Writes SVG and PNG files to scripts/preview/out/ (PNG via macOS qlmanage, or ffmpeg when found).
// Each image is one state; every row is one frame (8 per second). Left: the tone set made for that background
// (dark or light); right: the middle set the mod ships (it cannot tell light from dark). All colours are exact
// xterm-256 entries, so Terminal.app shows exactly these. Dark set on #1e1e1e, light set on #fff.
// Also writes jefe-compare-dark.png: old design vs new design vs a rainbow mock (comparison only).
import { mkdirSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CYCLE_FRAMES, FRAME_MS, SETTLE_FRAMES, SETS, glintTones, jefeLine, lineText } from '../../hooks/line.mjs';
import { initialState, reduce } from '../../hooks/reducer.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

const started = () => reduce(initialState(), { type: 'start', task: 'x' });
const spawn = (s, id, t, m) => reduce(s, { type: 'spawn', id, agentType: t, model: m });
const go = (s) => reduce(reduce(s, { type: 'question', questions: [{ question: 'q', options: ['Go', 'Change'] }] }), { type: 'answer', answers: { q: 'Go' } });
const building = spawn(spawn(go(started()), 'a', 'jefe:builder', 'sonnet'), 'b', 'jefe:runner', 'haiku');
const finished = reduce(building, { type: 'agents', list: [{ id: 'a', status: 'completed' }, { id: 'b', status: 'completed' }] });
const done = reduce(finished, { type: 'turn_end', isAborted: false, parked: null });
const parked = reduce(building, { type: 'turn_end', isAborted: false, parked: 'usage' });
const park = { reason: 'usage', percent: 86, resetsAt: new Date(2026, 10, 17, 20, 30).toISOString() };

const N = CYCLE_FRAMES; // one whole cycle: the sweep and the rest after it
const states = [
  { name: 'plan', frames: Array.from({ length: N }, (_, f) => ({ s: started(), o: { frame: f } })) },
  { name: 'build', frames: Array.from({ length: N }, (_, f) => ({ s: building, o: { frame: f } })) },
  { name: 'check', frames: Array.from({ length: N }, (_, f) => ({ s: { ...building, phase: 'REVIEW' }, o: { frame: f } })) },
  { name: 'done', frames: Array.from({ length: SETTLE_FRAMES + 8 }, (_, f) => ({ s: done, o: { frame: 20 + f, settleFrame: f } })) },
  { name: 'parked', frames: [0, 1, 2].map((f) => ({ s: parked, o: { frame: f, park } })) },
];

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const CW = 9.6, RH = 24, FS = 16;
function rowSvg(segs, x, y, theme) {
  const fg = theme.fg;
  const spans = segs
    .map((g) => {
      const colour = g.color === 'warning' ? theme.warning : g.color || fg;
      return `<tspan fill="${colour}"${g.bold ? ' font-weight="700"' : ''}${g.dim ? ' fill-opacity="0.55"' : ''}>${esc(g.t)}</tspan>`;
    })
    .join('');
  return `<text x="${x}" y="${y}" xml:space="preserve">${spans}</text>`;
}

function svgFor(st, theme) {
  const colW = 52 * CW, W0 = 60 + colW * 2 + 40, H0 = 70 + st.frames.length * RH + 20, W = Math.max(W0, H0), H = W;
  let b = `<rect width="${W}" height="${H}" fill="${theme.bg}"/>`;
  b += `<g font-family="Menlo, Monaco, 'Courier New', monospace" font-size="${FS}">`;
  b += `<text x="20" y="28" fill="${theme.fg}" font-weight="700">${st.name}  (${theme.name}, ${FRAME_MS} ms per row)</text>`;
  b += `<text x="60" y="52" fill="${theme.fg}" fill-opacity="0.6">tone set for this background (${theme.name})</text>`;
  b += `<text x="${60 + colW + 20}" y="52" fill="${theme.fg}" fill-opacity="0.6">shipped middle set (Terminal.app 256)</text>`;
  st.frames.forEach((fr, i) => {
    const y = 78 + i * RH;
    b += `<text x="14" y="${y}" fill="${theme.fg}" fill-opacity="0.4" font-size="11">${String(i).padStart(2, '0')}</text>`;
    b += rowSvg(jefeLine(fr.s, { ...fr.o, scheme: theme.name, columns: 60, park }), 60, y, theme);
    b += rowSvg(jefeLine(fr.s, { ...fr.o, scheme: 'mid', columns: 60, park }), 60 + colW + 20, y, theme);
  });
  b += '</g>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${b}</svg>\n`;
}

const themes = [
  { name: 'dark', bg: '#1e1e1e', fg: '#d4d4d4', warning: '#e5c07b' },
  { name: 'light', bg: '#ffffff', fg: '#1e1e1e', warning: '#9a6700' },
];
const have = (c) => spawnSync('which', [c]).status === 0;
const written = [];

// ---- comparison image: old design, new design, rainbow mock (dark background) ----
function compareSvg() {
  const th = themes[0];
  const frames = Array.from({ length: 8 }, (_, i) => 2 + i * 2);
  const cellW = 170, left = 330, W0 = left + frames.length * cellW + 20, W = Math.max(W0, 700), H = W;
  let b = `<rect width="${W}" height="${H}" fill="${th.bg}"/><g font-family="Menlo, Monaco, 'Courier New', monospace" font-size="20">`;
  b += `<text x="20" y="34" fill="${th.fg}" font-weight="700">comparison (dark, one cell per 250 ms, frames 2-16 of 28)</text>`;
  frames.forEach((f, i) => (b += `<text x="${left + i * cellW}" y="62" font-size="11" fill="${th.fg}" fill-opacity="0.4">f${String(f).padStart(2, '0')}</text>`));
  const row = (y, label, cell) => {
    b += `<text x="20" y="${y}" font-size="13" fill="${th.fg}" fill-opacity="0.7">${label}</text>`;
    frames.forEach((f, i) => (b += cell(f, left + i * cellW, y)));
  };
  // (a) the previous design: three brass tones, bold toggling per letter, no mark
  const OLD = ['#875f00', '#af8700', '#d78700', '#ff8700'];
  row(130, '(a) previous', (f, x, y) => {
    const c = f % 28, p = c < 16 ? c / 16 : -9, e = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, p)), pos = -1.4 + e * 5.8;
    const t = [...'jefe'].map((ch, k) => {
      const d = Math.abs(k - pos), h = p >= 0 && d < 1.4 ? 0.5 + 0.5 * Math.cos((Math.PI * d) / 1.4) : 0;
      return `<tspan fill="${OLD[Math.round((0.4 + 0.6 * h) * 3)]}"${h > 0.6 ? ' font-weight="700"' : ''}>${ch}</tspan>`;
    });
    return `<text x="${x}" y="${y}">${t.join('')}</text>`;
  });
  // (b) the new design: constant bold, crest / near / base tones, glint lands on the mark
  row(210, '(b) NEW', (f, x, y) => {
    const tn = glintTones(f), set = SETS.dark;
    const t = [...'jefe'].map((ch, k) => `<tspan fill="${set[tn[k]]}" font-weight="700">${ch}</tspan>`);
    t.push(`<tspan fill="${th.fg}" fill-opacity="0.55"> </tspan><tspan fill="${set[tn[4]]}">\u25c6</tspan>`);
    return `<text x="${x}" y="${y}" xml:space="preserve">${t.join('')}</text>`;
  });
  // (c) a rough rainbow shimmer on "ultrathink" (comparison mock, not Claude Code's code)
  row(290, '(c) rainbow mock', (f, x, y) => {
    const t = [...'ultrathink'].map((ch, k) => `<tspan fill="hsl(${(f * 14 + k * 36) % 360} 85% 62%)">${ch}</tspan>`);
    return `<text x="${x}" y="${y}" font-size="18">${t.join('')}</text>`;
  });
  b += `<text x="20" y="340" font-size="12" fill="${th.fg}" fill-opacity="0.5">(c) is a comparison mock, not Claude Code's code.</text></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${b}</svg>\n`;
}

for (const th of themes) {
  for (const st of states) {
    const base = `jefe-${st.name}-${th.name}`;
    const svg = join(OUT, base + '.svg');
    writeFileSync(svg, svgFor(st, th));
    const png = join(OUT, base + '.png');
    if (have('qlmanage')) {
      spawnSync('qlmanage', ['-t', '-s', '1800', '-o', OUT, svg]);
      const made = svg + '.png';
      if (existsSync(made)) renameSync(made, png);
    } else if (have('ffmpeg')) spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', svg, png]);
    written.push(existsSync(png) ? png : svg);
  }
}
{
  const svg = join(OUT, 'jefe-compare-dark.svg');
  writeFileSync(svg, compareSvg());
  if (have('qlmanage')) {
    spawnSync('qlmanage', ['-t', '-s', '2400', '-o', OUT, svg]);
    if (existsSync(svg + '.png')) renameSync(svg + '.png', join(OUT, 'jefe-compare-dark.png'));
  }
  written.push(join(OUT, 'jefe-compare-dark.png'));
}
console.log(written.join('\n'));
console.log('text of one frame:', lineText(jefeLine(building, { frame: 3 })));
