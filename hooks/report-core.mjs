// Pure decisions of the Stop hook hooks/report-check.mjs (see there): is the job's final message missing the gate's line, or does it state another verdict?
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { jobEnded, recordFresh } from './report-record.mjs';

export { jobEnded }; // the rule lives in ./report-record.mjs, shared with the status-line mod
const MAX_LINES = 40;
const MAX_LINE = 400;
const TAIL_BYTES = 512 * 1024;

// Text of the last assistant message in a transcript (JSONL), or ''.
export function lastAssistantText(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return '';
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    const rows = buf.toString('utf8').split('\n');
    for (let i = rows.length - 1; i >= 0; i--) {
      let j;
      try {
        j = JSON.parse(rows[i]);
      } catch {
        continue;
      }
      const m = j && (j.type === 'assistant' || (j.message && j.message.role === 'assistant')) ? j.message : null;
      if (!m) continue;
      const c = m.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n') : '';
      if (text.trim()) return text;
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

// Emphasis marks and code ticks do not change what a line says.
const bare = (t) => String(t).replace(/[*`]/g, '');

// Closing punctuation and white space cut from the end. A loop over character codes, not a pattern: `/[\s.,;:!]+$/` is quadratic on a long run of spaces
// that does not reach the end (100k spaces then `x` outran the hook's timeout).
const TRAIL = new Set(['.', ',', ';', ':', '!']);
export function trimTrail(s) {
  let end = s.length;
  while (end > 0) {
    const ch = s[end - 1];
    if (TRAIL.has(ch) || /\s/.test(ch)) end--;
    else break;
  }
  return end === s.length ? s : s.slice(0, end);
}

// Does one line of the message carry the gate line as text, as the END of the line? Marks before it (list, quote, emphasis, ticks, words) and closing punctuation
// after it do not matter; more words after it do (`gate: PASS (and more)` is another verdict).
const carries = (line, gate) => {
  const l = trimTrail(bare(line));
  const g = bare(gate);
  return l.endsWith(g) && (l.length === g.length || !/[A-Za-z0-9]/.test(l[l.length - g.length - 1]));
};

// A gate line of the message: a line that, after emphasis and ticks, leading list, quote and heading marks (`-`, `*`, `>`, `#`, `1.`) and closing punctuation
// are taken away, STARTS with `gate: `. -> that text, or null. A sentence that only mentions `gate: PASS` after other words is not one.
export function gateLineOf(line) {
  const l = trimTrail(bare(line).replace(/^(?:[\s>\-•⏺●#+]|\d+[.)])+/, ''));
  return l.startsWith('gate: ') ? l : null;
}

// The verdict a line states, if any. The line is normalised first: emphasis and strike marks (`*`, `_`, `~`), ticks, soft hyphens and zero-width
// characters removed, Unicode spaces made one plain space, lowercased. A line states a verdict when either part matches:
//   Part A, anywhere in the line: the whole word `gate`, an optional space, `:`, an optional space, then the WHOLE word `pass`, `fail` or `incomplete`
//     (`summary: all good, gate: PASS`; `quality gate: failed` is not one: `failed` is not the whole word `fail`).
//   Part B, only at the start of the line, after everything before the first ASCII letter or digit is dropped (list, quote and heading marks, emoji,
//     brackets), and then a list number (`1.`, `12)`) with the marks after it: at most ONE word of letters (at most 30) and a space; the whole word `gate`; at most TWO further words of letters (`result`,
//     `status`, `check result`); a separator: `:`, `：`, `∶` or `=` (a space before it optional), `–`, `—`, `→`, `->`, `=>` (spaces around optional)
//     or `-` with a space on both sides; at most 12 characters (code points; a lone surrogate counts as one) none of which is an ASCII letter or
//     digit; then a WHOLE word: `pass`, `passed`, `passes`, `passing`, `ok`, `green`, `succeeded` (pass), `fail`, `failed`, `fails`, `failing`,
//     `failure` (fail) or `incomplete`. (`**Gate:** ✅ PASS`, `Final gate: OK`, `> Gate result → passed`, `Gate—PASS`.)
// -> { base: 'pass' | 'fail' | 'incomplete', rest } (rest: the normalised text after the verdict word to the end of the line), or null. With several
// matches the FIRST counts: Part B's `gate` is the line's first whole word `gate`, so it is tried first (`Result gate: ~~FAIL~~ PASS` states fail).
// One forward pass: indexOf steps and look-ahead bounded by fixed counts, no pattern that can backtrack.
// NOT caught (a net for a careless summary, not a guard against wording): `gate` with brackets or a possessive (`Gate (final): PASS`,
// `Gate's verdict: PASS`), words after the separator (`Gate: all tests passed`), more than one word before `gate` or a verdict mid-line in any
// form other than Part A (`The deploy gate: passes`), a sentence without a separator (`The gate passed.`), a heading with the verdict on the next
// line (`## Gate` then `✅ PASS`), a table cell (`| gate | PASS |`), other separators (`|`, `>`, `is`), other verdict words (`Gate: ✅`,
// `Gate: 12/12`), look-alike letters (a Cyrillic `а`, fullwidth `ＰＡＳＳ`) and markup that splits a word (`ga<b></b>te`, `PA&#83;S`).
const isWordChar = (c) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'));
const isLetter = (c) => c !== undefined && c >= 'a' && c <= 'z';
const isHighHalf = (c) => c >= 0xd800 && c <= 0xdbff;
const isLowHalf = (c) => c >= 0xdc00 && c <= 0xdfff;
const MAX_WORDS = 2;
const MAX_WORD = 30;
const MAX_RUN = 12;
const A_WORDS = [
  ['pass', 'pass'],
  ['fail', 'fail'],
  ['incomplete', 'incomplete'],
];
const B_WORDS = [
  ...['pass', 'passed', 'passes', 'passing', 'ok', 'green', 'succeeded'].map((w) => [w, 'pass']),
  ...['fail', 'failed', 'fails', 'failing', 'failure'].map((w) => [w, 'fail']),
  ['incomplete', 'incomplete'],
];
const LOOSE_SEPS = ['->', '=>', '–', '—', '→']; // spaces around optional
const TIGHT_SEPS = [':', '：', '∶', '=']; // a space before optional

export function normLine(line) {
  return String(line)
    .replace(/[*_`~\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ')
    .toLowerCase();
}

// A whole word from `words` starting at k -> { base, rest }, or null.
function wordAt(l, k, words) {
  for (const [w, base] of words) if (l.startsWith(w, k) && !isWordChar(l[k + w.length])) return { base, rest: l.slice(k + w.length) };
  return null;
}
const wholeGate = (l, i) => l.startsWith('gate', i) && !isWordChar(l[i - 1]) && !isWordChar(l[i + 4]);

// Part A at a whole word `gate` at i.
function partA(l, i) {
  let j = i + 4;
  if (l[j] === ' ') j++;
  if (l[j] !== ':') return null;
  j++;
  if (l[j] === ' ') j++;
  return wordAt(l, j, A_WORDS);
}

// Part B's separator starting at j (after an optional space) -> its end, or -1.
function sepEnd(l, j) {
  const a = l[j] === ' ' ? j + 1 : j;
  const loose = LOOSE_SEPS.find((t) => l.startsWith(t, a));
  if (loose !== undefined) return a + loose.length;
  if (TIGHT_SEPS.includes(l[a])) return a + 1;
  if (a > j && l[a] === '-' && l[a + 1] === ' ') return a + 1;
  return -1;
}

// Part B, at the start of the line.
function partB(l) {
  const skip = (q) => {
    while (q < l.length && !isWordChar(l[q])) q++;
    return q;
  };
  let p = skip(0);
  // a list number (`1.`, `12)`) is a list mark too
  let d = p;
  while (d - p < 3 && l[d] >= '0' && l[d] <= '9') d++;
  if (d > p && (l[d] === '.' || l[d] === ')')) p = skip(d + 1);
  let g = -1;
  if (wholeGate(l, p)) g = p;
  else {
    let k = p;
    while (k - p < MAX_WORD && isLetter(l[k])) k++;
    if (k > p && l[k] === ' ' && wholeGate(l, k + 1)) g = k + 1;
  }
  if (g < 0) return null;
  // up to two words of letters, then the separator
  let j = g + 4;
  let end = -1;
  for (let w = 0; ; w++) {
    end = sepEnd(l, j);
    if (end >= 0 || w === MAX_WORDS || l[j] !== ' ') break;
    let k = j + 1;
    while (k - j <= MAX_WORD && isLetter(l[k])) k++;
    if (k === j + 1 || k - j > MAX_WORD) break;
    j = k;
  }
  if (end < 0) return null;
  // the run before the verdict word: at most 12 code points, none an ASCII letter or digit
  let k = end;
  for (let n = 0; k < l.length && !isWordChar(l[k]); k++) {
    if (!(isLowHalf(l.charCodeAt(k)) && isHighHalf(l.charCodeAt(k - 1)))) n++;
    if (n > MAX_RUN) return null;
  }
  return wordAt(l, k, B_WORDS);
}

export function verdictOf(line) {
  const l = normLine(line);
  const b = partB(l);
  if (b) return b;
  for (let from = 0; ; ) {
    const i = l.indexOf('gate', from);
    if (i < 0) return null;
    from = i + 4;
    if (!wholeGate(l, i)) continue;
    const a = partA(l, i);
    if (a) return a;
  }
}

// The record's verdict, as the comparison needs it: its base and the inner text of its bracketed qualifier ('' when it has none):
// `gate: PASS (tests not run)` -> { base: 'pass', qualifier: 'tests not run' }. null when the record's line states no verdict.
export function recordVerdict(gate) {
  const v = verdictOf(gate);
  if (!v) return null;
  const open = v.rest.indexOf('(');
  const close = v.rest.lastIndexOf(')');
  return { base: v.base, qualifier: open >= 0 && close > open ? v.rest.slice(open + 1, close).trim() : '' };
}

// Does a stated verdict differ from the record's? Its base is another, or the record's line has a qualifier and the verdict's rest lacks that text.
// With no record verdict, every stated verdict differs.
export function verdictDiffers(v, want) {
  if (!want) return true;
  return v.base !== want.base || (want.qualifier !== '' && !v.rest.includes(want.qualifier));
}

// A line as the gate's own pasted lines are compared: emphasis and ticks, leading list, quote and heading marks and closing punctuation taken away.
export const pasteKey = (line) => trimTrail(bare(line).replace(/^(?:[\s>\-•⏺●#+]|\d+[.)])+/, '')).trim();

// At most MAX_LINES lines, and never without the end (the gate: line the message is sent back for): the first lines and the last ones, the gap marked.
export function capLines(list) {
  if (list.length <= MAX_LINES) return list;
  const head = Math.floor(MAX_LINES / 2);
  const tail = MAX_LINES - head - 1;
  return [...list.slice(0, head), `... ${list.length - head - tail} lines left out ...`, ...list.slice(list.length - tail)];
}

// -> null (stay silent) or the reason text to send back. rec: the parsed report file; message: the last assistant message.
// A pending review ends with the reviewer's answer (`review: PASS` / `review: GAP`) or, when no reviewer answered, `review: not done (<why>)`: any of the three marks the final message.
// ended: the job's approval record says the job is over (see jobEnded); with the review still pending that is what tells the end from a stop in the middle.
export function decide(rec, message, { session, now = Date.now(), ended = false } = {}) {
  if (!rec || typeof rec !== 'object' || rec.fired === true) return null;
  if (typeof session !== 'string' || !recordFresh(rec, { session, now })) return null;
  if (typeof rec.gate !== 'string' || !/^gate: /.test(rec.gate) || !Array.isArray(rec.paste)) return null;
  const msgLines = String(message || '').split('\n');
  if (msgLines.some((l) => carries(l, rec.gate))) {
    // one right line does not excuse a wrong one: every gate line of the message must be the report's (a line starting with `gate: `, gateLineOf),
    // and no other line may state a verdict that differs from it (verdictOf, verdictDiffers). The gate's own pasted lines are its words, not a claim.
    const want = trimTrail(bare(rec.gate));
    const hasG = (l) => l.indexOf('g') >= 0 || l.indexOf('G') >= 0; // no `gate` can survive normalisation without a g: a fast skip for long messages
    let other;
    for (const l of msgLines) {
      const g = hasG(l) ? gateLineOf(l) : null;
      if (g !== null && g !== want) {
        other = g;
        break;
      }
    }
    if (other === undefined) {
      const wantVerdict = recordVerdict(want);
      const own = new Set(rec.paste.filter((l) => typeof l === 'string').map(pasteKey).filter((k) => k !== ''));
      const hit = msgLines.find((l) => {
        if (!hasG(l)) return false;
        if (own.has(pasteKey(l))) return false;
        const v = verdictOf(l);
        return v !== null && verdictDiffers(v, wantVerdict);
      });
      if (hit !== undefined) other = trimTrail(bare(hit).trim());
    }
    if (other === undefined) return null;
    return `The job's final message must carry only the gate's own line. It has \`${want}\` and also \`${other.replace(/[\u0000-\u001f\u007f-\u009f`]/g, ' ').slice(0, MAX_LINE)}\`; the gate printed \`${want}\`. Send the final message again with that one gate line and no other.`;
  }
  if (rec.review === 'pending' && !ended && !msgLines.some((l) => /^review: (PASS|GAP|not done)\b/.test(bare(l).replace(/^[\s>\-•⏺●]+/, '')))) return null;
  const paste = capLines(rec.paste.filter((l) => typeof l === 'string')).map((l) => l.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, MAX_LINE));
  return `The job's final message must end with the gate's lines exactly as printed; yours has no \`${rec.gate}\` line. Send the final message again with these lines${rec.review === 'pending' ? " (the review line is the reviewer's answer, or `review: not done (<why>)` when no reviewer answered)" : ''}:\n${paste.join('\n')}`;
}

