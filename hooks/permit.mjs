#!/usr/bin/env node
// The permit hook, registered for two events (hooks/hooks.json):
//  - PreToolUse: auto-approves ONLY what hooks/permit-core.mjs decides is safe (see SECURITY.md). Prints one allow JSON line; otherwise nothing
//    (the normal permission flow decides, so the user's own allow rules keep working). The one other answer is "ask", for a
//    call of this project's own wrapper that is not an approved form (`jefe-gate go` above all: it grants the job's approvals, and Claude Code's
//    prompt for it is the user's consent): then the prompt appears even if some rule would have pre-approved it. The one denial: a `go` whose
//    --allow-cmd value the gate itself would refuse is refused before the prompt (askFor -> deny), so no consent is spent on a call that cannot work.
//  - PermissionRequest (a dialog is about to be shown): never allows, so a dialog the user's own `ask` rule wants stays. Its one job: while a job's
//    approvals are active, a call of one of Jefe's helper agents that is not approved is REFUSED with a short instruction instead of asking the
//    user (decision.behavior "deny" with a message; `interrupt` false, so the helper carries on). Main-session calls are never refused.
// JEFE_PERMIT=off makes it silent. Every allow and every refusal is logged in <root>/.jefe/logs/permit.log; an allow whose line cannot be
// written is not given (the hook stays silent), a refusal is given anyway.
// Fails safe: a crash, a module that cannot load or unreadable input never approves anything (silence: Claude Code's normal flow decides, and a
// timeout is treated the same way). The one thing silence would lose is the forced prompt for `go` and `allow` (auto mode could approve them): when
// the decision code cannot run, a call that names a Jefe script with go, allow or provider is answered "ask" by the small check at the bottom.

import { appendFileSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function log(root, tool, d) {
  if (!root) return false;
  try {
    const dir = join(root, '.jefe', 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink() || lstatSync(join(root, '.jefe')).isSymbolicLink()) return false;
    const file = join(dir, 'permit.log');
    try {
      if (lstatSync(file).isSymbolicLink()) return false;
    } catch {
      // new file
    }
    appendFileSync(file, `${new Date().toISOString()} | ${tool} | ${d.kind} | ${d.text}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

async function main(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const { touchEnding } = await import('./approvals-state.mjs');
  const { askFor, evaluate, helperDenial, isHelperCall } = await import('./permit-core.mjs');
  if (input && input.hook_event_name === 'PermissionRequest') {
    if (!isHelperCall(input)) return; // only Jefe's own helpers are ever refused: the main session and other agents are not even evaluated
    const h = helperDenial(input, { ev: evaluate(input) });
    if (!h) return;
    log(h.root, input.tool_name, h);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: h.message, interrupt: false } } }) + '\n');
    return;
  }
  const ev = evaluate(input);
  const d = ev.d;
  if (!d) {
    // A call of this project's wrapper that is not an approved form (`go` above all): make sure Claude Code asks, whatever rule might pre-approve it.
    const a = askFor(input, { ev });
    if (!a) return;
    log(a.root, input.tool_name, a);
    if (a.deny === true) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: a.reason } }) + '\n');
    else ask(a.reason);
    return;
  }
  if (!log(d.root, input.tool_name, d) && !(d.kind === 'plugin:jefe-gate' && d.root === null)) return; // only the plugin's own `start`, with no project folder yet to log in, runs unlogged
  touchEnding(d.root, input.session_id); // an `ending` job's idle window is renewed by its own session's approved calls
  const reason = `Jefe: ${d.kind} (logged in .jefe/logs/permit.log)`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason } }) + '\n');
}

const ask = (reason) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }) + '\n');

// The decision code could not run: still make the grant prompt appear. Never allows, never denies.
function failSafe(raw) {
  try {
    const i = JSON.parse(raw);
    const c = i && i.tool_input && i.tool_input.command;
    if (i.hook_event_name === 'PermissionRequest' || i.permission_mode === 'plan' || typeof c !== 'string') return;
    // two plain linear patterns; a command longer than 8000 characters that names a script is asked about whatever else it says
    if (/jefe-(gate|project)/i.test(c) && (c.length > 8000 || /\b(go|allow|provider)\b/i.test(c))) ask('Jefe: the permit hook could not run, and this command names a Jefe script with go, allow or provider (it may grant approvals). Read it before you approve.');
  } catch {
    // silent
  }
}

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
  if (process.env.JEFE_PERMIT !== 'off') await main(raw);
} catch {
  if (process.env.JEFE_PERMIT !== 'off') failSafe(raw);
}
process.exit(0);
