// <root>/.jefe/plan.md: the stages of a project.
//   # Plan
//   1. [ ] <title> | done when: <done when>
//   2. [x] <title> | done when: <done when> | PASS 2026-11-17
// Shared by bin/jefe-gate (go, finish, amend, park, start) and hooks/task.mjs (is there an unfinished plan?).

import { join } from 'node:path';
import { readRegular, safe } from './projects.mjs';

export const PLAN_REL = '.jefe/plan.md';
export const planPath = (root) => join(root, '.jefe', 'plan.md');

const clean = (t) => safe(String(t)).replace(/\s+/g, ' ').replace(/\|/g, '/').trim();

// "<title> :: <done when>" -> { title, doneWhen } | null (no title)
export function parseStageArg(text) {
  const t = String(text);
  const i = t.indexOf(' :: ');
  const title = clean(i === -1 ? t : t.slice(0, i)).slice(0, 120);
  const doneWhen = clean(i === -1 ? '' : t.slice(i + 4)).slice(0, 240) || 'the stage works as described';
  return title ? { title, doneWhen, done: false, pass: null } : null;
}

// plan.md text -> [{ n, title, doneWhen, done, pass }]
export function parsePlan(text) {
  const stages = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\.\s+\[( |x|X)\]\s+(.*)$/.exec(line.slice(0, 600));
    if (!m) continue;
    let rest = m[3];
    let pass = null;
    const p = /\s\|\sPASS\s(\S+)\s*$/.exec(rest);
    if (p) {
      pass = p[1];
      rest = rest.slice(0, p.index);
    }
    const d = rest.indexOf(' | done when: ');
    stages.push({
      n: stages.length + 1,
      title: d === -1 ? rest.trim() : rest.slice(0, d).trim(),
      doneWhen: d === -1 ? '' : rest.slice(d + ' | done when: '.length).trim(),
      done: m[2] !== ' ',
      pass,
    });
  }
  return stages;
}

export function formatPlan(stages) {
  return ['# Plan', ...stages.map((s, i) => `${i + 1}. [${s.done ? 'x' : ' '}] ${s.title} | done when: ${s.doneWhen}${s.done && s.pass ? ` | PASS ${s.pass}` : ''}`), ''].join('\n');
}

export function readPlan(root) {
  const t = readRegular(planPath(root), 256 * 1024);
  return t === null ? [] : parsePlan(t);
}

export const firstUnfinished = (stages) => stages.find((s) => !s.done) || null;

// "plan: 2/5 stages done; next: 3 <title>" or null when there is no unfinished stage.
export function planLine(stages) {
  const next = firstUnfinished(stages);
  if (!stages.length || !next) return null;
  return `plan: ${stages.filter((s) => s.done).length}/${stages.length} stages done; next: ${next.n} ${next.title}`;
}

// like planLine, but also says when everything is done; null when there is no plan.
export function planSummary(stages) {
  if (!stages.length) return null;
  return planLine(stages) || `plan: ${stages.length}/${stages.length} stages done; all stages done`;
}
