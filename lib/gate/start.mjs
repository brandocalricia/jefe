// start: everything the planner needs at entry, in one call.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, realOf, registryHome, registryProblem, taskFailFile } from '../../hooks/approvals-state.mjs';
import { clearEnding, deactivate, jobState, pruneStates } from '../../hooks/allow.mjs';
import { readState } from '../../hooks/permit-core.mjs';
import { homeNote, ignoredNote } from '../../hooks/root.mjs';
import { ignoredJefeSync, rootHome } from '../../hooks/root-node.mjs';
import { TASK_FRESH_MS } from '../../hooks/runfile.mjs';
import { formatKnobs, knobsFor, parseHelperSpec } from '../../hooks/levels.mjs';
import { firstUnfinished, planLine, readPlan } from '../../hooks/plan.mjs';
import { clearWinner, elsewhereLines, elsewhereTarget, foreignJefe, hereInfo, isSymlink, readPrefs, readRegular, safe, squash } from '../../hooks/projects.mjs';
import { ensureWrappers, wrapperPath } from '../../hooks/wrappers.mjs';
import { usable as usableProviders } from '../providers/config.mjs';
import { wrapperOk } from '../../hooks/wrapper-text.mjs';
import { endFailedLine, notEndedLines, withRunLinkFix } from './allow.mjs';
import { testLabel } from './brief.mjs';
import { detectTests } from './tests.mjs';
import { optValue } from './args.mjs';
import { baseData, baseLine } from './base.mjs';
import { BIN_URL, ORIG_CWD, SESSION, shared } from './env.mjs';
import { writeFileList } from './files.mjs';
import { writeAtomic } from './fsutil.mjs';
import { modelsLine, PREF_KEY, resolveModels } from './models.mjs';
import { clearBriefMark, clearReportFile, readGateFile, writeGate } from './gatefile.mjs';
import { detectedArgv, notResumableLine, resumeCommand, resumeState } from './go.mjs';
import { configProblem, programKeys } from '../../hooks/git-safe.mjs';
import { BARE_REPO_LINE, currentBranchName, git, gitDirOnly, repoTop, trackedJefe, trackedJefeLines, unreadableConfigLines, workTreeState } from './git.mjs';
import { pushToLine, resolveDestination } from './push.mjs';
import { effectiveLevel, levelArg, levelData, levelFile, levelLineOf, levelWarning, readConfigQuiet, resolveNow, usageOfRun, userConfigFile, writeConfig } from './levels.mjs';
import { cmdContext, HEADLESS, headless, num, readRun, sessionMode, taskInfo } from './runfile.mjs';
import { cmdSize, takeSnapshot } from './size.mjs';
import { keepOrSetBaseline } from './secrets-baseline.mjs';

function sibling(name, args) {
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL(name, BIN_URL)), ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000, env: process.env, stdio: ['ignore', 'pipe', 'ignore'], killSignal: 'SIGKILL' });
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

// After an optional leading `continue` or `resume`, are the words EXACTLY the name or an alias of the one match? (a longer task that merely contains a name is not)
function namesExactly(words, match) {
  const rest = String(words).replace(/^\s*(continue|resume)\b/i, '').trim();
  if (!rest) return false;
  if (squash(rest) === squash(match.name)) return true;
  const al = sibling('./jefe-project', ['aliases', match.name]);
  return !!(al && Array.isArray(al.aliases) && al.aliases.some((a) => squash(a) === squash(rest)));
}

export function usageLineOf(u, state, hl = false) {
  if (state === 'off') return 'usage: off (JEFE_USAGE_GUARD)';
  if (!u) return hl ? `usage: unknown (${HEADLESS})` : 'usage: unknown';
  let resets = 'unknown';
  const t = u.resetsAt ? new Date(u.resetsAt) : null;
  if (t && Number.isFinite(t.getTime())) resets = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return `usage: ${Math.round(u.usedPercent)}% of plan window, resets ${resets}${state === 'downshift' || state === 'park' ? ` -> ${state}` : ''}`;
}

const HINT = 'hint: Level normal is the default. Say "set jefe to thorough" for more reviewing and more fix rounds.';
const CODE_MODE_NOTE = 'note: Code Mode (experimental) is switched on in this environment. If this session runs in Code Mode, Jefe will not work: helpers\' approved commands are refused. Start the session with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0 claude; in a session started that way this note still shows and can be ignored';

// `start --guide`: the texts of the skill's guide files, each as the file has it (fixed names, nothing a caller chooses), read from the plugin's own folder.
// -> the text, or null when the file cannot be read.
const GUIDE_MAX = 64 * 1024;
const guideText = (name) => readRegular(fileURLToPath(new URL(`../skills/jefe/${name}.md`, BIN_URL)), GUIDE_MAX);

// -> { name, path, handoff } when matches has exactly one clear winner (the only match, or a top score at least twice the second), else null.
function clearMatch(matches) {
  return matchInfo(clearWinner(matches));
}
function matchInfo(top) {
  if (!top) return null;
  const hf = typeof top.path === 'string' ? join(top.path, '.jefe', 'handoff.md') : null;
  return { name: top.name, path: top.path, handoff: hf && existsSync(hf) ? hf : null };
}

// where the session runs: terminal | desktop | cloud | unknown. JEFE_WHERE overrides; CLAUDE_CODE_REMOTE (documented, set in cloud
// environments) means cloud; CLAUDE_CODE_ENTRYPOINT cli / sdk-cli is the terminal and claude-desktop the desktop app; failing that the
// surface the mod recorded in the run file (terminal or desktop); otherwise unknown (an IDE extension is not one of the four).
function sessionWhere(run) {
  const o = String(process.env.JEFE_WHERE || '').trim().toLowerCase();
  if (['terminal', 'desktop', 'cloud', 'unknown'].includes(o)) return o;
  const remote = String(process.env.CLAUDE_CODE_REMOTE || '').trim();
  if (remote !== '' && !/^(0|false|no|off)$/i.test(remote)) return 'cloud';
  const ep = String(process.env.CLAUDE_CODE_ENTRYPOINT || '');
  if (ep === 'cli' || ep === 'sdk-cli') return 'terminal';
  if (/^claude-desktop/.test(ep)) return 'desktop';
  const s = run && typeof run.surface === 'string' ? run.surface : '';
  return s === 'terminal' || s === 'desktop' ? s : 'unknown';
}

// The wrapper for root as a short path from the folder the command was started in (or the absolute path when that is not shorter).
function gateRel(root) {
  const abs = wrapperPath(root, 'jefe-gate');
  let rel = '';
  try {
    rel = relative(ORIG_CWD, abs);
  } catch {
    rel = '';
  }
  return rel && rel.length < abs.length ? rel : abs;
}

// Did hooks/task.mjs record, in the last two minutes, that it could not write .jefe/task.md? (the helpers are told to read that file)
function taskWriteFailed(root) {
  try {
    const j = readJson(taskFailFile(root));
    const at = j ? Date.parse(j.at) : NaN;
    return Number.isFinite(at) && Date.now() - at <= TASK_FRESH_MS && at - Date.now() < 60000;
  } catch {
    return false;
  }
}

// One call at entry. Always exit 0. Only lines that carry information are printed.
// Order: mode, where, level, knobs, gate, task, project, plan, allowed, prefs, matches (or the three elsewhere lines), usage, context, size, hint, base, interview.
// One project named from a folder that is not that project: ONLY root:, resume: and next: (see elsewhereLines), decided before anything is written.
// -> { line, data } for the `push-to:` line, or null when the folder is not a git work tree.
function pushToInfo(work) {
  try {
    const top = repoTop(work);
    if (!top) return null;
    let branch = null;
    try {
      branch = currentBranchName(top) || null;
    } catch {
      branch = null;
    }
    const d = branch ? resolveDestination(top, branch) : { refuse: 'HEAD is detached: no branch to push' };
    if (d.refuse) return { line: `push-to: none (${safe(d.refuse)})`, data: { none: d.refuse } };
    return { line: pushToLine(d), data: { remote: d.remote, url: d.url } };
  } catch {
    return null;
  }
}

// ONE rule for "this start continues a job": go --resume could continue it (resumeState: parked, or approvals that ran out by time, which also
// covers approvals still live for an unfinished job), or its approvals are a finished job's ending window that an added stage reopens (start
// then clears the ending mark for the session that recorded it). An open plan alone is not enough: a job the user ended or that finished is not
// continuing, and the next start begins a new job.
function continuingJob(root) {
  if (resumeState(root)) return true;
  const s = readState(root);
  const stages = readPlan(root);
  return !!(s && s.active === true && s.ending === true && SESSION && s.session === SESSION && stages.length && firstUnfinished(stages) && Date.parse(s.expires) > Date.now());
}

export function cmdStart(args) {
  const lines = [];
  const mode = sessionMode();
  const run0 = readRun();
  const where = sessionWhere(run0);
  lines.push(`mode: ${mode}`, `where: ${where}`);
  const a = levelArg(args);
  if (a.bad !== undefined) lines.push(`warning: ignoring unknown --level "${safe(String(a.bad).slice(0, 40))}"; use normal or thorough`);
  const resolved = resolveNow({ override: a.level || null });
  const usage = usageOfRun();
  const e = effectiveLevel(resolved, usage);
  lines.push(levelLineOf(e), ...levelWarning(resolved));
  // a start that continues a job (continuingJob: parked, run out by time, or live for an unfinished job) shows the job's own table (its brief);
  // any other start shows what a new job gets: saved preference or defaults. The preference is read and checked every time (its warning).
  const fromPrefs = resolveModels(shared.root || process.cwd(), { ignoreBrief: true });
  const modelTable = continuingJob(shared.root || process.cwd()) ? { ...resolveModels(shared.root || process.cwd()), warning: fromPrefs.warning } : fromPrefs;
  const knobs = knobsFor(e.level, modelTable.models);
  lines.push(formatKnobs(knobs), ...(modelTable.warning ? [modelTable.warning] : []), modelsLine(modelTable));
  const hl = headless(run0);
  const usageLines = usage || e.state === 'off' || e.state === 'downshift' || e.state === 'park' ? [usageLineOf(usage, e.state, hl)] : [];
  const ctx = cmdContext();
  const ctxLines = ctx.data.status !== 'unknown' ? ctx.lines : [];
  const here = hereInfo(process.env, shared.root || process.cwd()); // shared module: no second node process; the project root of this call
  const path = here && typeof here.path === 'string' ? here.path : null;
  let size = cmdSize([]);
  if (size.data.size === 'UNKNOWN' && size.data.reason === 'not a git repo' && path) {
    // inside a Jefe project that is not a git repo: not an error, the planner estimates instead
    size = { lines: ['size: NONE (not a git repo; size will be estimated)'], data: { size: 'NONE', files: 0, lines: 0, triggers: [], reason: 'not a git repo; size will be estimated' }, code: 0 };
  }
  const sizeLines = size.data.size !== 'NONE' ? size.lines : [];

  const registered = !!(path && typeof here.name === 'string');
  const name = path ? (registered ? here.name : 'unregistered') : 'none';
  const handoff = here && typeof here.handoff === 'string' && existsSync(here.handoff) ? here.handoff : null;
  const projectLine = registered || handoff ? [`project: ${safe(name)} path=${safe(path || 'none')} handoff=${safe(handoff || 'none')}`] : [];
  // a .jefe/ this installation did not create (a tarball): note it, and let nothing in it (prefs, task) into this start
  const foreign = foreignJefe(shared.root || process.cwd());
  // the preferences it prints: the ones Jefe understands carry a validated value (`helpers` must parse as a helper-model choice, else it is left out; the
  // models: line and a warning already say the defaults apply); every other key is a standing answer of the user's own, one plain line (readPrefs)
  const prefs = foreign ? {} : Object.fromEntries(Object.entries(readPrefs(shared.root || process.cwd())).filter(([k, v]) => k !== PREF_KEY || parseHelperSpec(v).ok));
  const prefKeys = Object.keys(prefs);
  const prefsLine = prefKeys.length ? [`prefs: ${prefKeys.map((k) => `${k}=${safe(prefs[k])}`).join('; ')}`] : [];

  const task = foreign ? null : taskInfo();
  const taskFresh = !!(task && task.fresh);

  // project matching: --words when given; otherwise the task text itself, but only from a folder that is no known project
  const words = optValue(args, '--words');
  const lost = !registered && !handoff;
  let query = words !== null ? words : null;
  if (query === null && lost && taskFresh) {
    const t = readRegular(task.file, 512 * 1024);
    if (t !== null) query = t.slice(0, 2000);
  }
  let matches = null;
  let resume = null;
  const matchLines = [];
  if (query !== null) {
    const found = query.trim() ? sibling('./jefe-project', ['find', '--json', query]) : null;
    const list = found && Array.isArray(found.matches) ? found.matches : [];
    matches = list.map((m) => ({ name: m.name, score: m.score }));
    // only for words that name exactly ONE other project (or start with continue/resume and have one clear match), and never this very folder (or one
    // inside it): any other text starts normally with the usual matches: line
    const workDir = shared.root || process.cwd();
    const aliasesOf = (n) => {
      const al = sibling('./jefe-project', ['aliases', n]);
      return al && Array.isArray(al.aliases) ? al.aliases : [];
    };
    resume = lost ? matchInfo(elsewhereTarget(query, list, aliasesOf, [workDir, ORIG_CWD])) : null;
    // a registered folder too: "continue B" / "B" naming exactly one OTHER project is the same answer (never a longer task that mentions B)
    if (!resume && !lost && words !== null && list.length === 1 && typeof list[0].path === 'string' && (list[0].via === 'name' || list[0].via === 'alias') && list[0].score >= 0.95 && realOf(list[0].path) !== realOf(path || '') && namesExactly(words, list[0])) resume = clearMatch(list);
    if (!resume) {
      if (matches.length) matchLines.push(`matches: ${matches.map((m) => `${safe(m.name)}(${m.score})`).join(' ')}`);
      else if (words !== null) matchLines.push('matches: none');
      if (lost && matches.length > 1) matchLines.push(`next: ask the user which project they mean (${matches.map((m) => safe(m.name)).join(', ')}), then run ${safe(gateRel(shared.root || process.cwd()))} start --words "<name>"`);
    }
  }
  if (resume) {
    // ONE project named from a folder that is not that project: the answer is the command to continue it in its own folder, and nothing else
    // (the same three lines `jefe-project find` prints). Nothing is written: no snapshot, no gate or level file, the one-time hint stays unused.
    const el = elsewhereLines(resume.path, resume.name);
    return { lines: el, data: { mode, where, elsewhere: true, root: resume.path, resume, matches, project: { name: null, path, handoff, registered } }, code: 0 };
  }

  // The folder the work happens in: this one (the elsewhere answer has already returned). Its wrappers are the `gate:` path.
  const work = shared.root || process.cwd();
  // a bare repository (or the inside of a .git folder) has no work tree: refused before anything is written
  if (gitDirOnly(work)) return { lines: [`mode: ${mode}`, `where: ${where}`, BARE_REPO_LINE], data: { mode, where, gate: null, refused: 'bare repository' }, code: 1 };
  // a repository must not ship its own .jefe: tracked content there (a wrapper, a plan, ...) is not trusted
  const tracked = trackedJefe(work);
  if (tracked.unreadable) return { lines: [`mode: ${mode}`, `where: ${where}`, ...unreadableConfigLines(tracked.unreadable, safe, tracked.what)], data: { mode, where, gate: null, refused: 'unreadable git configuration', reason: tracked.unreadable }, code: 1 };
  if (tracked.length) {
    return { lines: [`mode: ${mode}`, `where: ${where}`, ...trackedJefeLines(tracked, safe)], data: { mode, where, gate: null, refused: 'tracked .jefe', tracked }, code: 1 };
  }
  const wr = ensureWrappers(work);
  if (!wrapperOk(work, 'jefe-gate') || !wrapperOk(work, 'jefe-project')) {
    if (isSymlink(join(work, '.jefe'))) return { lines: [`mode: ${mode}`, `where: ${where}`, 'gate: unavailable (.jefe is a symbolic link, and Jefe does not write through one)', 'next: stop; tell the user: .jefe here is a symbolic link; replace it with a real folder and run /jefe again'], data: { mode, where, gate: null, refused: 'symlinked .jefe' }, code: 1 };
    const why = wr.error ? `cannot write the wrappers in .jefe/bin: ${safe(wr.error.slice(0, 100))}; is the folder read-only?` : 'the wrapper in .jefe/bin is not the one this install writes';
    return { lines: [`mode: ${mode}`, `where: ${where}`, `gate: unavailable (${why})`, 'next: stop; tell the user: remove .jefe/bin and run /jefe again'], data: { mode, where, gate: null, refused: 'wrapper' }, code: 1 };
  }
  const gateLine = `gate: ${safe(gateRel(work))}`;
  const stages = readPlan(work);
  const planLines = planLine(stages) ? [planLine(stages)] : [];
  // approved command kinds (the state outside the project): a resume of an unfinished plan says what is still active; start never grants any (only `go` does), in any mode
  let reapplied = 0;
  const allowLines = [];
  const headlessLines = [];
  pruneStates(Date.now(), work);
  const regProblem = registryProblem(work);
  if (regProblem) allowLines.push(`warning: ${regProblem}; ${registryHome(work) === null ? 'approvals are off for this folder' : 'approvals use ~/.claude/jefe instead'}`);
  // a finished job's approvals (its ending finish passed) are never inherited, unless a stage was added since (then the job is not finished)
  const prior = readState(work);
  let endedLeft = false;
  let endFailed = null;
  let notEnded = null; // the approvals file became ignored meanwhile and was left as it is (deactivate's `refused`)
  if (prior && prior.active === true && prior.ending === true) {
    if (stages.length && firstUnfinished(stages)) clearEnding(work, { session: SESSION });
    else {
      const d = deactivate(work, 'ended-at-start');
      endedLeft = d.was && !d.failed;
      if (d.was && d.failed) endFailed = d.failed;
      if (d.refused) notEnded = d.refused;
    }
  }
  // at most one `allowed:` line about the approvals (none when there is nothing to say)
  const js = jobState(work);
  if (notEnded) allowLines.push(...notEndedLines(notEnded));
  else if (endFailed) allowLines.push(endFailedLine(endFailed));
  else if (endedLeft) {
    if (mode !== 'headless') allowLines.push('allowed: ended (left on by a finished job)');
  } else if (js.state === 'active') {
    reapplied = js.n;
    allowLines.push(`allowed: ${js.n} approved command kinds still active for this job (expires ${js.expires})`);
  } else if (resumeState(work) && mode !== 'headless') {
    // the command alone on its line (it can be pasted whole); the push branch, which the command cannot name, on the next line
    const rc = resumeCommand(work);
    allowLines.push(`allowed: approvals ended; to continue, approve again with: ${rc.command}`, ...(rc.branch ? [`note: the push goes to branch ${rc.branch} only`] : []));
  }
  else if (stages.length && firstUnfinished(stages) && mode !== 'headless') allowLines.push(notResumableLine(work)); // finished, or ended by the user
  // a continuing job (continuingJob) keeps its brief mark, start and stage snapshots and secrets baseline; any other start begins a new job
  const continuing = continuingJob(work);
  // the brief marker belongs to the job that wrote the brief
  if (!continuing) clearBriefMark(work);
  clearReportFile(work); // the final report of an earlier job must not arm the Stop hook or allow a push for this one (a resumed plan is a reopened job)
  // approvals are granted only by `go`: no mode (not even headless, which a repository's settings can fake) grants any here
  if (mode === 'headless') headlessLines.push('git: commit per stage; leave a single job uncommitted unless the request asks for a commit');

  // optional text-only providers (docs/PROVIDERS.md): only those configured AND with their key variable set. Naming one here does not approve it: `go --allow-kind providers --allow-provider <name>` does.
  const providerLines = usableProviders(work).map((p) => `providers: ${safe(p.name)} (${p.uses.join(', ')})`);
  lines.push(gateLine, ...providerLines);
  if (taskFresh) lines.push(`task: ${task.rel}`);
  else if (taskWriteFailed(work)) lines.push('task: missing (could not write .jefe/task.md)');
  else if (!foreign && words === null && lost && args.includes('--guide')) lines.push('note: no task text came with this prompt; to continue a project kept elsewhere, say its name');
  // the repository's own git configuration names programs (filters, an external diff, a hooks folder, ...): Jefe's git calls switch them off (hooks/git-safe.mjs); the person hears about it before Go
  const problem = configProblem(work); // null when it could be read
  if (problem) lines.push(`note: this repository's git configuration could not be read (${safe(problem)}): Jefe's own git calls are off here`);
  const progs = programKeys(work);
  if (progs.length) lines.push(`note: this repository's git configuration names programs (${progs.slice(0, 8).map((k) => safe(k)).join(', ')}${progs.length > 8 ? ', ...' : ''}): Jefe's own git calls do not run them`);
  if (foreign) lines.push('note: this folder already has a .jefe/ that this Jefe did not create; its prefs, task and check script are ignored until you start a job here');
  // Claude Code's experimental Code Mode sends commands as `cd '<folder>' && <command>`, which the permission hook never approves (docs/LIMITS.md)
  if (/^(1|true)$/i.test(String(process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE || '').trim())) lines.push(CODE_MODE_NOTE);
  const home = rootHome();
  if (homeNote(work, home)) lines.push(homeNote(work, home)); // the session started in the home folder: it is the project
  const passedOver = ignoredJefeSync(work, home); // a real .jefe above the repository; only `start` looks that far up
  if (passedOver) lines.push(safe(ignoredNote(passedOver)));
  lines.push(...projectLine, ...planLines, ...allowLines, ...prefsLine, ...matchLines, ...usageLines, ...ctxLines, ...sizeLines);

  // The hint appears once, ever: the first start whose level comes from the default.
  let hinted = false;
  if (resolved.source === 'default' && readConfigQuiet(userConfigFile()).hinted !== true && writeConfig(userConfigFile(), { hinted: true }).ok) {
    lines.push(HINT);
    hinted = true;
  }
  lines.push(...headlessLines);

  // The start snapshot (for --since start) and a clean parked state: one gate file per start.
  let snapshot = null;
  let snapshotFailed = null; // why the snapshot could not be taken inside a repository (a timeout, an unreadable index)
  try {
    snapshot = takeSnapshot();
  } catch (err) {
    snapshotFailed = err && (err.code === 'ETIMEDOUT' || err.signal === 'SIGKILL') ? 'git timed out' : String((err && (err.stderr || err.message)) || 'git failed').trim().split('\n')[0].slice(0, 100);
    // no snapshot: --since start says so
  }
  // a continuing job keeps the snapshots its first start (and its last passed stage) took, whichever session wrote them, when they are of this repository
  const fresh = snapshot;
  let stageSnapshot = null;
  if (continuing && fresh) {
    const prev = readGateFile() || {};
    const ours = (s) => (s && typeof s === 'object' && s.top === fresh.top && s.files && typeof s.files === 'object' && !Array.isArray(s.files) ? s : null);
    if (ours(prev.snapshot)) {
      snapshot = prev.snapshot;
      stageSnapshot = ours(prev.stageSnapshot);
    }
  }
  // base: the commit the job starts from, so a reviewer's `git diff <base>...HEAD` shows this job's commits (lib/gate/base.mjs)
  const base = baseData(snapshot);
  lines.push(baseLine(snapshot, base));
  // where a push of the current branch would go (the same resolution and URL rules as `go --allow-kind git-push`), so the planner can name it in Go's --push-to
  const pushTo = pushToInfo(work);
  if (pushTo) lines.push(pushTo.line);
  // the project's test command as the gate detects it (the same detection `go` records for the tests kind and the gate runs)
  let testCommand = null;
  try {
    testCommand = testLabel(detectTests(work));
  } catch {
    testCommand = null;
  }
  lines.push(`test command: ${testCommand === null ? 'none found' : safe(testCommand)}`);
  // the commands run from the project root, whatever folder this call came from; say so, and where a git repository really is
  const rootReal = realOf(work);
  const fromElsewhere = ORIG_CWD !== rootReal;
  if (fromElsewhere) lines.push(`note: checks and git commands run from the project root ${safe(rootReal)}, not from this folder`);
  let gitBelow = null;
  if (!snapshot && ORIG_CWD.startsWith(rootReal + sep)) {
    const top = repoTop(ORIG_CWD);
    if (top && realOf(top).startsWith(rootReal + sep)) gitBelow = realOf(top);
  }
  if (gitBelow) lines.push(`note: the git repository is below the project root (${safe(gitBelow)}); start Jefe from that folder so commits and base work`);
  if (!snapshot && !gitBelow) {
    // "no git repository" only when git says so; a snapshot that failed inside a repository says what failed
    const wt = workTreeState(work);
    if (wt.state === 'no') lines.push('note: no git repository here: no branch, base, size or commit; run git init first if you want them');
    else if (wt.state === 'yes') lines.push(`note: the start snapshot could not be taken (${safe(snapshotFailed || 'git did not report the repository root: it failed or timed out')}): --since start measures the whole tree and base is unknown; run start again`);
    else lines.push(`note: could not tell whether this is a git repository (${safe(wt.reason)}): no branch, base, size or commit were recorded; run start again`);
  }
  keepOrSetBaseline(work, fresh, continuing); // the secrets scan's baseline stays the job's first start's
  const startRun = readRun();
  const fiveAtStart = startRun && startRun.fiveHour && typeof startRun.fiveHour === 'object' ? num(startRun.fiveHour.usedPercent) : null;
  const gateWarn = writeGate({ startedAt: new Date().toISOString(), ...(foreign ? { foreignJefe: true } : {}), ...(snapshot ? { snapshot } : {}), ...(stageSnapshot ? { stageSnapshot } : {}), ...(fiveAtStart !== null ? { usageAtStart: { fiveHour: fiveAtStart } } : {}) });
  if (gateWarn) lines.push(withRunLinkFix(work, gateWarn));

  // for the mod's display: the level in effect for this run
  try {
    writeAtomic(levelFile(), JSON.stringify({ level: e.level, source: e.source, base: e.base, usedPercent: e.usedPercent, at: new Date().toISOString() }) + '\n', true);
  } catch (err) {
    // the same refusal as the gate file's (both live in the run folder) is said once
    if (err && err.code === 'ESYMLINK' && `warning: ${err.message}` !== gateWarn) lines.push(withRunLinkFix(work, `warning: ${err.message}`));
    // otherwise display only
  }

  // the project's file list for the helpers (they read it instead of running a Bash listing); never fails start
  lines.push(writeFileList(work));

  // the guide texts ride along (no model Read of the plugin's own files, so no permission prompt), each as the file has it under `--- guide: <name> ---`.
  // A plain `start` carries the interview (never in a headless run); `start --guide` (the skill's inline call) carries the whole guide: interview (not in a headless run), checks, project, levels, research,
  // and providers only when this start printed `providers:` lines.
  const guide = {};
  {
    const names = [];
    if (mode !== 'headless') names.push('interview');
    if (args.includes('--guide')) names.push('checks', 'project', 'levels', 'research', ...(providerLines.length ? ['providers'] : []));
    const broken = [];
    for (const n of names) {
      const t = guideText(n);
      if (t === null) broken.push(`${n}.md`);
      else {
        guide[n] = t;
        lines.push(`--- guide: ${n} ---`, t);
      }
    }
    if (broken.length) lines.push(`guide: could not read ${broken.join(', ')} from the plugin folder; the plugin install looks broken`);
  }

  return {
    lines,
    data: { mode, where, guide, ...levelData(e), knobs, models: modelTable.models, modelsSource: modelTable.source, gate: gateRel(work), usage, ...(hl && !usage ? { usageReason: HEADLESS } : {}), context: ctx.data, size: size.data, project: { name: name === 'none' || name === 'unregistered' ? null : name, path, handoff, registered }, plan: stages, allowedReapplied: reapplied, matches, resume, hinted, prefs, task: taskFresh ? task.rel : null, base, root: rootReal, callerFolder: fromElsewhere ? ORIG_CWD : null, gitBelow, pushTo: pushTo ? pushTo.data : null, testCommand },
    code: 0,
  };
}
