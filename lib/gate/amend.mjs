// amend: change the goal or the plan mid-job.
import { join } from 'node:path';
import { clearEnding } from '../../hooks/allow.mjs';
import { firstUnfinished, planSummary, readPlan } from '../../hooks/plan.mjs';
import { readRegular, safe, writePrivate } from '../../hooks/projects.mjs';
import { optValue, optValues } from './args.mjs';
import { checkValues, setField } from './brief.mjs';
import { SESSION, shared } from './env.mjs';
import { oneLine } from './format.mjs';
import { briefMarkMatches, clearReportFile, recordBriefMark } from './gatefile.mjs';
import { keyValue, stagesFromArgs, writePlan } from './go.mjs';
import { renumberStageCommits } from './report.mjs';
import { renumberStageChecks } from './verify.mjs';

// ---------- amend: change the goal or the plan mid-job ----------

const GOAL_SECTIONS = { '--goal': 'END GOAL', '--done': 'DONE WHEN', '--out': 'OUT OF SCOPE', '--ref': 'REFERENCE' };

// goal.md text -> [{ name, body }] in file order
function parseGoal(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) {
      cur = { name: m[1], body: [] };
      out.push(cur);
    } else if (cur) cur.body.push(line);
  }
  for (const s of out) s.body = s.body.join('\n').trim();
  return out;
}

// EVERY record kept by stage number moves with a renumbering of the plan, here in one place: the recorded stage checks (verify.mjs) and the
// stage commits (report.mjs). A new per-stage record keyed by number belongs in this list.
function renumberStageStores(root, newOf) {
  renumberStageChecks(root, newOf);
  try {
    renumberStageCommits(root, newOf);
  } catch {
    // the final commit list then misses the moved stages' commits
  }
}

const renderGoal = (sections) => sections.map((s) => `## ${s.name}\n${s.body}\n`).join('\n');

export function cmdAmend(args) {
  const root = shared.root || process.cwd();
  const goalFile = join(root, '.jefe', 'goal.md');
  const text = readRegular(goalFile, 512 * 1024);
  if (text === null) return { lines: ['goal: FAILED no .jefe/goal.md here (run go first)'], data: { status: 'ERROR' }, code: 1 };
  const bad = checkValues(args, ['--goal', '--done', '--out', '--ref', '--note', '--answer']);
  if (bad) return { lines: [`goal: ${bad}`], data: { status: 'ERROR' }, code: 2 };
  const sections = parseGoal(text);
  const changed = [];
  const setSection = (name, body, label) => {
    let s = sections.find((x) => x.name === name);
    if (!s) {
      s = { name, body: '' };
      sections.push(s);
    }
    s.body = body;
    changed.push(label);
  };
  for (const [flag, name] of Object.entries(GOAL_SECTIONS)) {
    const v = optValue(args, flag);
    if (v === null) continue;
    if (!v.trim()) return { lines: [`goal: bad ${flag} (empty)`], data: { status: 'ERROR' }, code: 2 };
    // each value is a labelled line in its own section of the seven-part brief; a file without it was not written by go
    const label = name === 'END GOAL' ? 'goal' : name === 'DONE WHEN' ? 'done when' : name === 'OUT OF SCOPE' ? 'out of scope' : 'reference';
    if (setField(sections, name, v.trim())) changed.push(label);
    else return { lines: [`goal: FAILED .jefe/goal.md has no "${name}:" line in its own section (is it a brief that go wrote?); nothing was changed`], data: { status: 'ERROR' }, code: 1 };
  }
  const answers = [];
  for (const t of optValues(args, '--answer')) {
    const kv = keyValue(t);
    if (!kv) return { lines: [`goal: bad --answer "${safe(String(t).slice(0, 40))}": use key=value`], data: { status: 'ERROR' }, code: 2 };
    answers.push(kv);
  }
  if (answers.length) {
    const sec = sections.find((x) => x.name === 'ANSWERS');
    const cur = sec ? sec.body.split('\n').filter((l) => l.trim() && l.trim() !== 'none') : [];
    for (const a of answers) {
      const line = `- ${a.key}: ${a.value}`;
      const i = cur.findIndex((l) => l.startsWith(`- ${a.key}:`));
      if (i === -1) cur.push(line);
      else cur[i] = line;
    }
    setSection('ANSWERS', cur.join('\n'), `answers: ${answers.map((a) => a.key).join(', ')}`);
  }
  // the plan
  const add = stagesFromArgs(args);
  if (add.error) return { lines: [`goal: ${add.error}`], data: { status: 'ERROR' }, code: 2 };
  const dropArgs = optValues(args, '--drop-stage');
  let stages = readPlan(root);
  const drops = new Set();
  for (const d of dropArgs) {
    const n = /^\d+$/.test(d) ? Number(d) : 0;
    const st = stages[n - 1];
    if (!st) return { lines: [`goal: bad --drop-stage ${safe(String(d).slice(0, 20))} (the plan has ${stages.length} stages)`], data: { status: 'ERROR' }, code: 2 };
    if (st.done) return { lines: [`goal: stage ${n} is already done and cannot be dropped`], data: { status: 'ERROR' }, code: 2 };
    drops.add(n);
  }
  const newNumber = new Map(); // old stage number -> new, for the stages that stay
  if (drops.size || add.length) {
    stages.filter((s) => !drops.has(s.n)).forEach((s, i) => newNumber.set(s.n, i + 1));
    stages = [...stages.filter((s) => !drops.has(s.n)), ...add].map((s, i) => ({ ...s, n: i + 1 }));
    if (drops.size) changed.push(`-${drops.size} stage${drops.size === 1 ? '' : 's'}`);
    if (add.length) changed.push(`+${add.length} stage${add.length === 1 ? '' : 's'}`);
  }
  const note = (optValue(args, '--note') || '').trim();
  if (!changed.length && !note) return { lines: ['goal: nothing to amend (give --goal, --done, --out, --ref, --answer, --stage, --drop-stage or --note)'], data: { status: 'ERROR' }, code: 2 };
  // a note alone changes no field: one `note: <text>` line in CHANGES (the report prints no changed: line for it)
  const what = changed.join(', ');
  const entry = `- ${new Date().toISOString().slice(0, 10)}: ${oneLine(!changed.length ? `note: ${note}` : note ? `amended (${what}): ${note}` : `amended (${what})`, 400)}`;
  const log = sections.find((x) => x.name === 'CHANGES');
  if (log) log.body = `${log.body}\n${entry}`.trim();
  else sections.push({ name: 'CHANGES', body: entry });
  const mine = briefMarkMatches(root, text); // the brief of the running job stays its own after this edit
  const newText = renderGoal(sections);
  try {
    writePrivate(goalFile, newText, { guardDir: true });
    if (mine) recordBriefMark(root, newText);
  } catch (err) {
    return { lines: [`goal: FAILED ${safe(err && err.code === 'ESYMLINK' ? err.message : `cannot write .jefe/goal.md: ${(err && (err.code || err.message)) || err}`)}`], data: { status: 'ERROR' }, code: 1 };
  }
  const lines = [changed.length ? `goal: amended (${what})` : 'goal: noted (no field changed)'];
  if (drops.size || add.length) {
    const perr = writePlan(root, stages);
    if (perr) return { lines: [...lines, `plan: FAILED ${safe(perr)}`], data: { status: 'ERROR' }, code: 1 };
    // the records kept by stage number move with the same renumbering (a dropped stage's go with it)
    if (drops.size) renumberStageStores(root, (old) => newNumber.get(old) || null);
    clearReportFile(root); // the job is reopened: the passing report (and with it the push) is gone until the ending finish runs again
    if (firstUnfinished(stages)) clearEnding(root, { session: SESSION }); // the job is not finished after all
  }
  const sum = planSummary(stages);
  if (sum) lines.push(sum);
  return { lines, data: { amended: changed, plan: stages }, code: 0 };
}
