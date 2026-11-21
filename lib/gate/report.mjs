// The report block: the ending `finish` (a job, or the last stage) prints one fixed block at the very end of its output,
//   report:
//   tests: ...        check: ... (only when checks ran)   secrets: ...   review: ...   commit: ...   cost: ...   gate: ...
// always complete and always in this order, so the planner can paste "the lines under report:" without picking from the body.
// The lines are the ones finish prints anyway (same wording), moved to the end; a line that has nothing to say reads n/a (<why>) or none.
// For a project, tests: is the full-suite result of this last stage and commit: lists every stage commit (recorded in the run folder, see below).
import { readRegular, safe } from '../../hooks/projects.mjs';
import { shared } from './env.mjs';
import { briefMarkMatches, readCommitsFile, writeCommitsFile } from './gatefile.mjs';

const MAX_CHANGED = 10;
const ORDER = ['tests', 'check', 'secrets', 'review', 'commit', 'cost', 'models', 'gate'];

const WITH_DETAIL = new Set(['tests', 'check', 'secrets']);

// Lines that follow their fact line: echoed child output ("| "), the saved-log path, the shell hint, the "... n more" of the secrets list.
const isDetail = (l) => l.startsWith('| ') || l.startsWith('log: ') || l.startsWith('hint: checks are run without a shell') || /^\.\.\. \d+ more$/.test(l);

// finish's lines -> { body, facts } where facts maps each key of ORDER to its lines (a fact line with its detail lines).
// Information lines that begin like a fact but are not a result: `check: not kept ...`, `check: not run ...`, `tests: not run ...`. They never start
// a fact and never capture the line after them; the block prints them right after the lines of their own key.
const INFO = /^(check|tests): not (kept|run)\b/;
export function splitFacts(lines) {
  const body = [];
  const facts = Object.fromEntries(ORDER.map((k) => [k, []]));
  const info = { check: [], tests: [] };
  let cur = null;
  for (const l of lines) {
    const im = INFO.exec(l);
    if (im) {
      info[im[1]].push(l);
      cur = null;
      continue;
    }
    // `commit: left out ...` is a body line printed before the block, not the commit result
    if (l.startsWith('commit: left out')) {
      cur = null;
      body.push(l);
      continue;
    }
    const key = ORDER.find((k) => l.startsWith(`${k}:`)) || (l.startsWith('SECRET ') ? 'secrets' : null);
    if (key) {
      cur = key;
      facts[key].push(l);
    } else if (cur && WITH_DETAIL.has(cur) && isDetail(l)) facts[cur].push(l);
    else {
      cur = null;
      body.push(l);
    }
  }
  return { body, facts, info };
}

// The mid-job changes: one `changed: <what> (<date>)` line per dated entry of goal.md's `## CHANGES` section that changed a field (each `amend` appends one),
// at most MAX_CHANGED, then `changed: ... and N more`. A note-only entry (`note: <text>`) changed nothing and gives no line. Only the gate writes goal.md
// (a helper can write nothing under .jefe/ but check.sh and handoff.md), so these lines are the planner's and the user's own amends. Only the job that
// is running reports them: the brief marker (gatefile.mjs) must match the file, so a job that never ran `go` prints none of an earlier job's.
export function changedLines(root) {
  const text = readRegular(`${root}/.jefe/goal.md`, 512 * 1024);
  if (text === null || !briefMarkMatches(root, text)) return [];
  const m = /^## CHANGES\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  if (!m) return [];
  const out = [];
  for (const l of m[1].split('\n')) {
    const e = /^- (\d{4}-\d\d-\d\d): (.+)$/.exec(l);
    if (e && !/^note: /.test(e[2])) out.push(safe(`changed: ${e[2]} (${e[1]})`).slice(0, 400));
  }
  return out.length > MAX_CHANGED ? [...out.slice(0, MAX_CHANGED), `changed: ... and ${out.length - MAX_CHANGED} more`] : out;
}

// The final message, ready to paste (fact lines only), closes the ending finish after the `report:` block: its header line is PASTE_HEAD (PASTE_PENDING when the
// reviewer's answer is still to come), then the `skipped:` lines (what Go did not approve, each with the command), the `changed:` and
// `commit: left out` lines when there are any, and the report lines; its last line is the `gate:` line, so gate: is always the last line of the output.
export const PASTE_HEAD = 'paste:';
export const PASTE_PENDING = "paste (replace the review line with the reviewer's answer):";
export const REVIEW_SLOT = "review: <the reviewer's answer: PASS or GAP>";
export const isPasteHead = (l) => l === PASTE_HEAD || l === PASTE_PENDING;

// `skipped:` lines from what the gate itself knows: tests the job did not approve, checks that ran out of approval or were not kept.
function skippedLines(facts, info, testCmd, checkCmd) {
  const out = [];
  // testCmd: a test command the project really has; checkCmd (only without one): the check approved at Go, named as a check, not as the suite;
  // with neither, say so instead of guessing
  const tail = testCmd ? `run it yourself: ${safe(testCmd)}` : checkCmd ? `run the check yourself: ${safe(checkCmd)}` : 'no test command found to name';
  if (info.tests.some((l) => /not run \(the project's test suite was not approved/.test(l)) || facts.tests.some((l) => /not approved at Go/.test(l))) out.push(`skipped: project test suite (not approved at Go); ${tail}`);
  for (const l of info.check) {
    const m = /^check: not (?:run \(approval ended\)|kept for later stages \(not approved at Go\)): (.+)$/.exec(l);
    if (m) out.push(safe(`skipped: ${m[1]} (${/approval ended/.test(l) ? 'its approval ended' : 'not approved at Go'}); run it yourself: ${m[1]}`));
  }
  return out;
}

// The body, then `report:` and the fixed block (gate: last of the block), then the paste section. `commit` replaces the commit: line when given
// (a project's list of stage commits). -> { lines, paste (the lines to paste, ending with the gate: line), gate (that line) }
export function withReport(lines, { commit = null, review = null, testCmd = null, checkCmd = null, leftOut = 0 } = {}) {
  const { body, facts, info } = splitFacts(lines);
  const fill = {
    tests: 'tests: n/a (not run)',
    secrets: 'secrets: n/a (not run)',
    review: 'review: n/a (finish ran without --review pending)',
    commit: 'commit: none (no --commit given)',
    cost: 'cost: n/a',
    models: 'models: n/a (no helper spawn recorded)',
    gate: 'gate: INCOMPLETE (no verdict)',
  };
  const block = [];
  const changed = changedLines(shared.root || process.cwd());
  for (const key of ORDER) {
    if (key === 'gate') block.push(...changed);
    if (key === 'commit' && commit !== null) block.push(commit);
    else if (facts[key].length || (info[key] && info[key].length)) block.push(...facts[key], ...(info[key] || []));
    else if (key !== 'check') block.push(fill[key]);
  }
  // the body line names the files; the paste section and the report file (which reach the Stop hook's reason) carry the count only: a file name is repository text
  const leftOutLines = leftOut > 0 ? [`commit: left out ${leftOut} file${leftOut === 1 ? '' : 's'} with secret-looking names (the names are in the commit line above the report; add them yourself if they belong)`] : [];
  const pending = review === 'pending';
  // the paste section holds the gate's fact lines only: the `| ` child-output lines and `log:` lines of a failing check are repository text, and
  // this section reaches the Stop hook's reason and the user's final message as if the gate had said it
  const rest = block.filter((l) => !changed.includes(l) && !isDetail(l)).map((l) => (pending && l.startsWith('review:') ? REVIEW_SLOT : l));
  const paste = [...skippedLines(facts, info, testCmd, checkCmd), ...changed, ...leftOutLines, ...rest];
  const gate = [...block].reverse().find((l) => l.startsWith('gate:')) || fill.gate;
  return { lines: [...body, 'report:', ...block, pending ? PASTE_PENDING : PASTE_HEAD, ...paste], paste, gate };
}

// ---- stage commits: { "<n>": { title, shas: [...] } } in <jefe home>/run/<key>.commits.json (gatefile.mjs), so the last stage can list them all ----
// Kept outside the project folder (a repository cannot ship it) and cleared by `go`. Only hex shas are read back.

const SHA = /^[0-9a-f]{4,40}$/;

function readStageCommits(root) {
  const j = readCommitsFile(root);
  const out = {};
  for (const [k, r] of Object.entries(j)) {
    if (r && typeof r === 'object' && typeof r.title === 'string' && Array.isArray(r.shas)) out[k] = { title: r.title, shas: r.shas.filter((x) => typeof x === 'string' && SHA.test(x)) };
  }
  return out;
}

// Appends the commit of stage n from finish's own `commit: <sha> on <branch>` line (any other commit: line has no sha and is ignored); no duplicates.
export function recordStageCommit(root, n, title, commitLine) {
  const m = /^commit: ([0-9a-f]{4,40}) on /.exec(String(commitLine));
  if (!m) return;
  const cur = readStageCommits(root);
  const prev = cur[String(n)];
  const shas = prev && prev.title === title ? prev.shas : [];
  if (!shas.includes(m[1])) shas.push(m[1]);
  cur[String(n)] = { title, shas };
  writeCommitsFile(root, cur);
}

// amend renumbered the plan: newOf(old stage number) -> its new number, or null for a dropped stage. The commits move with their stage.
export function renumberStageCommits(root, newOf) {
  const cur = readStageCommits(root);
  if (!Object.keys(cur).length) return;
  const out = {};
  for (const [k, r] of Object.entries(cur)) {
    const n = newOf(Number(k));
    if (n) out[String(n)] = r;
  }
  writeCommitsFile(root, out);
}

// The commit: line of a project's last stage: every stage commit of the current plan, in stage order, on the branch of this finish's own
// commit line (`own`, or null when no --commit was given); `branch` is used when this stage made no commit of its own.
export function projectCommitLine(root, stages, own, branch) {
  const rec = readStageCommits(root);
  const shas = stages.flatMap((s, i) => {
    const r = rec[String(i + 1)];
    return r && r.title === s.title ? r.shas : [];
  });
  if (!shas.length) return own;
  const m = /^commit: [0-9a-f]{4,40} on (.+)$/.exec(own || '');
  const on = m ? m[1] : branch || 'unknown branch';
  const note = m ? '' : ` (this stage: ${own ? own.replace(/^commit: /, '') : 'no --commit given'})`;
  return safe(`commit: ${shas.join(' ')} on ${on}${note}`);
}
