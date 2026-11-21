// allow: the job's approved command kinds (<registry>/run/<key>.allow.json, outside the project).
import { deactivate } from '../../hooks/allow.mjs';
import { activeKinds, readState, shq } from '../../hooks/permit-core.mjs';
import { safe } from '../../hooks/projects.mjs';
import { realOf, refusedState, stateDir } from '../../hooks/approvals-state.mjs';
import { shared } from './env.mjs';
import { stampOf } from './format.mjs';

// ---------- allow: the job's approved command kinds ----------
// hooks/allow.mjs writes <registry>/run/<key>.allow.json (outside the project); hooks/permit.mjs reads it on every tool call. Nothing here touches settings files.

const USAGE = ['allowed: usage: jefe-gate allow --show | --clear', 'allowed: --show prints what is approved for this folder now; --clear ends the approvals'];
const cmdText = (argv) => argv.map(shq).join(' ');

// allow --show: read-only. What is approved for this folder right now, as the permit hook reads it (active, unexpired, this folder).
function show(root) {
  const state = readState(root);
  const kinds = activeKinds(root, state);
  if (kinds === null) {
    const refused = refusedStateLine(root);
    if (refused) return { lines: [refused], data: { active: false, kinds: [], refused: true }, code: 0 };
    return { lines: ['allowed: nothing active'], data: { active: false, kinds: [] }, code: 0 };
  }
  const expires = Date.parse(state.expires);
  const lines = [`allowed: active until ${stampOf(expires)}`];
  const shown = [];
  for (const name of new Set(kinds.map((k) => k.name))) {
    const of = kinds.filter((k) => k.name === name);
    if (name === 'providers') {
      const list = (of.find((k) => Array.isArray(k.providers)) || { providers: [] }).providers.map((p) => safe(p.name));
      lines.push(`kind: providers (${list.join(', ') || 'none'})`);
      shown.push({ name, providers: list });
    } else if (of.some((k) => k.exact)) {
      for (const k of of) {
        lines.push(`kind: ${name} (${safe(cmdText(k.argv))})`);
        shown.push({ name, command: k.argv });
      }
    } else if (name === 'tests' || name === 'check-script') {
      const cmds = [...new Set(of.map((k) => cmdText(k.argv)))];
      lines.push(`kind: ${name} (${safe(cmds.join(', '))})`);
      shown.push({ name, commands: cmds });
    } else {
      lines.push(`kind: ${name}`);
      shown.push({ name });
    }
  }
  const session = typeof state.session === 'string' && state.session ? safe(state.session.slice(0, 60)) : null;
  if (session) lines.push(`session: ${session} (the one that recorded the approvals)`);
  const ending = state.ending === true;
  if (ending) {
    const limit = Date.parse(state.limit);
    lines.push(`idle window: the job is finished and the approvals stay on for the reviewers; they end at ${stampOf(expires)} unless the recording session makes an approved call first${Number.isFinite(limit) ? `, and never after ${stampOf(limit)}` : ''}`);
  }
  return { lines, data: { active: true, until: new Date(expires).toISOString(), kinds: shown, session, ending }, code: 0 };
}

// The line for an approvals file that exists but is ignored (not private: hooks/approvals-state.mjs fileProblem), or null.
export function refusedStateLine(root) {
  const r = refusedState(root);
  return r ? refusedLineOf(r) : null;
}
const RUN_LINK_FIX = 'make the run folder a real folder, or use another Jefe home';
function refusedLineOf(r) {
  const fix = r.why === 'is writable by others' ? 'fix its mode to 600, or use a Jefe home only you can write' : r.why === 'is in a folder everyone can write to' ? 'use a Jefe home only you can write' : r.why === 'is in a folder that is a symbolic link' ? RUN_LINK_FIX : 'remove it and run go again, or use a Jefe home only you can write';
  return `allowed: NOT in effect (the approvals file ${safe(String(r.file))} ${r.why}; Jefe ignores it: ${fix})`;
}

// The two lines for approvals that were not ended because their file is ignored (deactivate's `refused`): Jefe leaves that file as it is, so the
// printed fix would bring back whatever it holds; ending them takes another allow --clear after the fix.
export function notEndedLines(refused) {
  return [refusedLineOf(refused), 'allowed: NOT ended (Jefe did not change the ignored file; after that fix, run allow --clear again)'];
}

// A write refused because the registry's run folder is a symbolic link (`refusing to write: <run> is a symlink`): the line gets the fix that
// refusedStateLine gives for the same case. Any other line comes back as it is.
export function withRunLinkFix(root, line) {
  try {
    if (typeof line === 'string' && line.endsWith(`refusing to write: ${stateDir(realOf(root))} is a symlink`)) return `${line}; ${RUN_LINK_FIX}`;
  } catch {
    // no usable registry folder: nothing to add
  }
  return line;
}

// The line for approvals that could not be ended (deactivate's `failed`): they stay active until they expire.
export function endFailedLine(failed) {
  return `allowed: FAILED to end ${failedTail(failed)}`;
}
// The line for an idle window that could not be set (markEnding's `failed`): the approvals keep their old expiry.
export function shortenFailedLine(failed) {
  return `allowed: could NOT shorten the approvals ${failedTail(failed)}`;
}
function failedTail(failed) {
  const exp = Date.parse(failed && failed.expires);
  return `(could not rewrite the approvals file ${safe(String((failed && failed.file) || 'unknown'))}); they stay active until ${Number.isFinite(exp) ? stampOf(exp) : 'they expire'}`;
}

export function cmdAllow(args) {
  const clear = args.includes('--clear');
  const shows = args.includes('--show');
  if (clear === shows) return { lines: USAGE, data: { status: 'ERROR' }, code: 2 };
  const root = shared.root || process.cwd();
  if (shows) return show(realOf(root));
  const c = deactivate(root, 'cleared');
  // an ignored file is left as it is: never "nothing was active" (the printed fix would bring its approvals back)
  if (c.refused) return { lines: notEndedLines(c.refused), data: { status: 'ERROR', cleared: 0, refused: c.refused.file }, code: 1 };
  if (c.was && c.failed) return { lines: [endFailedLine(c.failed)], data: { status: 'ERROR', cleared: 0, failed: c.failed.file }, code: 1 };
  return { lines: [c.was ? 'allowed: ended' : 'allowed: nothing was active'], data: { cleared: c.was ? 1 : 0 }, code: 0 };
}
