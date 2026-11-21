// park: record that this run is parked and write the handoff.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { deactivate } from '../../hooks/allow.mjs';
import { firstUnfinished, readPlan } from '../../hooks/plan.mjs';
import { readRegular, resumeLine, safe, slugify } from '../../hooks/projects.mjs';
import { endFailedLine, notEndedLines } from './allow.mjs';
import { optValue } from './args.mjs';
import { shared } from './env.mjs';
import { oneLine } from './format.mjs';
import { updateGate } from './gatefile.mjs';
import { buildHandoff, changedSince, currentLevel, gitInfo, handoffStep, projectStep, writeHandoff } from './handoff.mjs';
import { taskGoal } from './runfile.mjs';

// ---------- park ----------

// park --reason <context|usage>: the run's parked state, in the gate file, for the mod to show. The model's own
// text never drives it.
// The Goal line of an existing handoff (the one a run wrote earlier), or ''.
function previousGoal(root) {
  try {
    const t = readRegular(join(root, '.jefe', 'handoff.md'), 256 * 1024);
    if (!t) return '';
    const ls = t.split('\n');
    const i = ls.findIndex((l) => /^## Goal/.test(l));
    return i === -1 ? '' : oneLine(ls.slice(i + 1).find((l) => l.trim() && !l.startsWith('Reference:')) || '', 120);
  } catch {
    return '';
  }
}

export function cmdPark(args) {
  const reason = optValue(args, '--reason');
  if (reason !== 'context' && reason !== 'usage') {
    return { lines: ['park: use --reason context or --reason usage'], data: { status: 'ERROR' }, code: 2 };
  }
  const warn = updateGate({ parked: { reason, at: new Date().toISOString() } });
  if (warn) return { lines: [warn], data: { status: 'ERROR' }, code: 1 };
  const cleared = deactivate(shared.root || process.cwd(), 'parked');
  const endFailed = cleared.was && cleared.failed ? cleared.failed : null;
  const lines = [`parked: ${reason}`, ...(cleared.refused ? notEndedLines(cleared.refused) : endFailed ? [endFailedLine(endFailed)] : cleared.was ? ['allowed: ended (parked)'] : [])];
  const root = shared.root || process.cwd();
  const project = projectStep(root);
  const name = project.data.status === 'FAILED' ? slugify(basename(root)) : project.data.name;
  // the handoff, from gate facts only (the same writer as finish): a fresh session continues from it
  const level = currentLevel();
  const goal = taskGoal() || previousGoal(root) || null;
  const gi = gitInfo(root);
  const stages = readPlan(root);
  const text = buildHandoff({
    root,
    goal,
    notes: [],
    verdict: `PARKED (${reason})`,
    stages,
    effective: stages.length ? 'project' : 'job',
    vlines: [],
    vdata: {},
    lesson: null,
    files: changedSince('start'),
    cmds: [],
    level,
    next: [firstUnfinished(stages) ? `- continue with stage ${firstUnfinished(stages).n}: ${firstUnfinished(stages).title} | done when: ${firstUnfinished(stages).doneWhen}` : `- continue: the stage in progress was ${oneLine(goal || 'not given', 120)}`],
    gitText: gi ? `git: branch ${gi.branch}, last commit ${gi.sha}` : null,
    goalFile: existsSync(join(root, '.jefe', 'goal.md')),
  });
  // the handoff never depends on the project registration: it is written first, and a failed registration is a note after it (as finish does)
  const werr = writeHandoff(root, text);
  let handoff = { status: 'FAIL' };
  if (werr) lines.push(`handoff: FAIL ${safe(String(werr).slice(0, 300))}`);
  else {
    const h = handoffStep(root, ' (written by park)');
    lines.push(h.line);
    handoff = { status: h.status, ...(h.words ? { words: h.words } : {}) };
  }
  if (project.data.status === 'FAILED') lines.push(`note: ${project.line}; the resume line below uses the folder name`);
  const resume = resumeLine(root, name);
  lines.push(resume);
  return { lines, data: { parked: reason, ...(cleared.refused ? { allowedRefused: cleared.refused.file } : endFailed ? { allowedFailed: endFailed.file } : cleared.was ? { allowedEnded: true } : {}), handoff, project: name, ...(project.data.status === 'FAILED' ? { projectFailed: project.data.reason } : {}), resume }, code: endFailed || cleared.refused ? 1 : 0 };
}
