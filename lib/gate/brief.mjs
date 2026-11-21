// brief: the seven-part goal brief that `go` writes to .jefe/goal.md, and the field edit `amend` makes to it.
import { shq } from '../../hooks/permit-core.mjs';
import { optValue, optValues } from './args.mjs';
import { oneLine } from './format.mjs';
import { safe } from '../../hooks/projects.mjs';

export const AUTONOMY = 'Work completely autonomously and do not ask for anything until all of it is done. `DECISION NEEDED` only when the brief is wrong or a choice cannot be undone. A refused command is a stop for that step: do not work around it; report `skipped: <command>`.';
const FREE_DEFAULT = 'free on how; strict on everything stated here';
const LOOK_FIRST = 'Look first (search, then Read) and use what the project already has before writing new code.';

// Longest value per flag, in characters. MULTI values may hold newlines (indented in the file); the rest are one line.
export const LIMITS = { '--why': 160, '--free': 300, '--goal': 600, '--done': 1200, '--out': 600, '--ref': 600, '--note': 300, '--answer': 300 };
const MULTI = new Set(['--goal', '--done', '--out', '--ref']);
const BAD_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// a newline stays allowed in a multi-line value; every other control or line-break character (CR, NEL, LS, PS) is refused
const BAD_MULTI = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const BIDI = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/;

// One value of a brief flag: -> an error text (for `<cmd>: <text>`) or null.
export function badValue(flag, value) {
  const v = String(value);
  // bidirectional controls can reorder what Claude Code's permission prompt shows for the command being approved: never in any value
  if (BIDI.test(v)) return `bad ${flag} (no bidirectional control characters: U+200E, U+200F, U+061C, U+202A to U+202E, U+2066 to U+2069)`;
  if ((MULTI.has(flag) ? BAD_MULTI : BAD_ONE_LINE).test(v)) return `bad ${flag} (${MULTI.has(flag) ? 'no control or line-break characters other than newline' : 'one line only'})`;
  if (v.trim().length > LIMITS[flag]) return `bad ${flag} (${LIMITS[flag]} characters at most)`;
  return null;
}

// Checks the named flags of `args` (each value of a repeatable one). -> null | an error text
export function checkValues(args, flags) {
  for (const flag of flags) {
    for (const v of optValues(args, flag)) {
      const e = badValue(flag, v);
      if (e) return e;
    }
  }
  return null;
}

// The optional --why and --free values. -> { why, free } (null when absent or empty) | { error }
export function briefFlags(args) {
  const e = checkValues(args, ['--why', '--free']);
  if (e) return { error: e };
  return { why: (optValue(args, '--why') || '').trim() || null, free: (optValue(args, '--free') || '').trim() || null };
}

// LABEL: first line, then the rest of a multi-line value indented two spaces (so no line of it can open a section).
const field = (label, text) => {
  const [first, ...rest] = String(text).split('\n');
  return [`${label}: ${first}`, ...rest.map((l) => `  ${l}`)];
};

const oneLineGoal = (goal) => oneLine(String(goal).replace(/\s+/g, ' '), 200);

// The test command as the gate names it: a fixed format and no count that can change after go. The only project text in it is a nested Go
// module's folder name, cleaned by safe() so it can hold no control character or line break.
export function testLabel(d) {
  if (!d) return null;
  // no file counts: they change after go; every suite that runs is named, a nested Go module by its label (`go test ./... (in <folder>)`),
  // the folder name cleaned as every printed name is
  return [d, ...(d.more || [])].map((s) => (s.cmd === process.execPath ? 'node --test' : s.dir && s.label ? safe(s.label) : `${s.cmd} ${s.args.join(' ')}`)).join(' and ');
}

// The goal.md text. Every line comes from a flag or from what the gate knows; an unknown part says so.
// detected: the result of detectTests (or null); branch: the branch go ended on, or null in a folder that is not a git work tree.
// Nothing here is a value that can change later (level, reviewers, stage checks): the brief points at its source.
export function buildBrief({ detected, goal, why, done, ref, out, free, answers, built, branch, providers = [], modelsLine = null }) {
  const tests = testLabel(detected);
  const cmds = built.kinds.filter((k) => k.exact).map((k) => k.argv.map(shq).join(' '));
  // the gate runs the detected tests only when the job's approved kinds include `tests`; the brief says so when they do not
  const notApproved = tests && !built.names.includes('tests') ? `${tests} (not approved at Go: the gate does not run it; do not run it yourself)` : null;
  const git = built.names.includes('git-push') ? 'commit and push' : built.names.includes('git-commit') ? 'commit locally' : 'leave uncommitted';
  return [
    '## 1. WHAT AND WHY', ...field('END GOAL', goal), `WHY: ${why || 'not given'}`, '',
    '## 2. QUALITY BAR', ...field('DONE WHEN', done), ...field('REFERENCE', ref || 'none given'), "LEVEL: the gate's knobs output (`start` prints it)", '',
    '## 3. TOOLS', `TESTS: ${notApproved || tests || 'none detected'}`, `APPROVED KINDS: ${built.names.join(', ') || 'none'}`, ...(cmds.length ? [`APPROVED COMMANDS: ${cmds.join('; ')}`] : []), ...(providers.length ? [`APPROVED PROVIDERS: ${providers.join(', ')}`] : []), ...(modelsLine ? [modelsLine] : []), LOOK_FIRST, '',
    '## 4. FREEDOM', `FREE: ${free || FREE_DEFAULT}`, ...field('OUT OF SCOPE', out || 'none given'), '',
    '## 5. CHECKS',
    tests ? `1. TESTS: ${notApproved || `${tests}, run by the gate`}` : '1. TESTS: none detected; the DONE WHEN commands carry the proof',
    "2. OWN CHECKS: the DONE WHEN commands, or each stage's checks in .jefe/plan.md when the job has stages",
    "3. REVIEW: as many reviewers as the gate's knobs output says (reviewers=), judging the diff against section 2", '',
    '## 6. DELIVERY', ...(branch ? [`BRANCH: ${branch}`] : []), `GIT: ${git}`, 'REPORT: the fixed report lines (gate:, review:, noticed:, skipped:)', '',
    '## 7. GOAL', `GOAL: ${oneLineGoal(goal)}`, AUTONOMY, '',
    '## ANSWERS', ...(answers.length ? answers.map((x) => `- ${x.key}: ${x.value}`) : ['none']), '',
  ].join('\n');
}

// Each label lives in one section of the brief; amend edits it there and nowhere else.
const SECTION_OF = { 'END GOAL': '1. WHAT AND WHY', 'DONE WHEN': '2. QUALITY BAR', REFERENCE: '2. QUALITY BAR', 'OUT OF SCOPE': '4. FREEDOM', GOAL: '7. GOAL' };

// amend: sets the `LABEL: value` field (its line plus the indented lines under it) in the label's own section;
// END GOAL also sets the one-line GOAL in section 7. -> 1 when set, 0 when the section has no such line (not a brief `go` wrote)
export function setField(sections, label, value) {
  const put = (name, lines) => {
    const s = sections.find((x) => x.name === SECTION_OF[name]);
    if (!s) return 0;
    const body = s.body.split('\n');
    const i = body.findIndex((l) => l.startsWith(`${name}: `) || l === `${name}:`);
    if (i === -1) return 0;
    let j = i + 1;
    while (j < body.length && body[j].startsWith('  ')) j++;
    body.splice(i, j - i, ...lines);
    s.body = body.join('\n');
    return 1;
  };
  const n = put(label, field(label, value));
  if (n && label === 'END GOAL') put('GOAL', [`GOAL: ${oneLineGoal(value)}`]);
  return n;
}
