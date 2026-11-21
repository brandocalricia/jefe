#!/usr/bin/env node
// UserPromptSubmit command hook. Reads the hook JSON on stdin (the prompt is data: it never reaches a shell).
// ONLY when the prompt starts with /jefe or /jefe:jefe, writes the text after the command name to
// <project root>/.jefe/task.md (inside the project, so helpers can read it without a permission prompt; mode 0600;
// overwritten; .jefe/ ignores itself through .jefe/.gitignore; when the file cannot be written the hook prints one line, which Claude Code hands to the model) so `jefe-gate start` can print its path and the
// planner can say "read .jefe/task.md" instead of repeating the task in every brief. For that same prompt it creates or refreshes
// the project's wrappers .jefe/bin/jefe-gate and .jefe/bin/jefe-project (hooks/wrappers.mjs).
// A user prompt does NOT touch the job's approved command kinds (the approval state outside the project, read by hooks/permit.mjs). Prints nothing otherwise; always exits 0 (a failure here must never block the user's prompt).

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { taskFailFile } from './approvals-state.mjs';
import { join } from 'node:path';
import { writePrivate } from './projects.mjs';
import { findRoot } from './permit-core.mjs';
import { ensureWrappers } from './wrappers.mjs';

const MAX_BYTES = 256 * 1024;
const CMD = /^\s*\/jefe(?::jefe)?(?=\s|$)([\s\S]*)$/;

// -> the task text, or null when this prompt is not a /jefe command (or has no text).
export function taskText(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = CMD.exec(prompt);
  if (!m) return null;
  const text = m[1].trim();
  return text ? text : null;
}

export const isJefePrompt = (prompt) => typeof prompt === 'string' && CMD.test(prompt);

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const prompt = input && input.prompt;
  const text = taskText(prompt);
  const cwd = input && typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = findRoot(cwd);
  if (root === null) return; // the folder cannot be resolved
  const jefe = isJefePrompt(prompt);
  if (jefe) ensureWrappers(root);
  if (text === null) return;
  const body = Buffer.from(text, 'utf8').subarray(0, MAX_BYTES).toString('utf8') + '\n';
  // a failed write is not swallowed silently: the registry records it (outside the project) so `jefe-gate start` can say the file is missing
  try {
    writePrivate(join(root, '.jefe', 'task.md'), body, { guardDir: true });
    markTaskWrite(root, true);
  } catch {
    markTaskWrite(root, false);
    // UserPromptSubmit stdout reaches the model: tell it the file is missing, so the task goes into the brief instead
    console.log('Jefe: the task text could not be saved to .jefe/task.md; put the whole task in each helper brief.');
  }
}

function markTaskWrite(root, ok) {
  try {
    const f = taskFailFile(root);
    if (ok) {
      unlinkSync(f);
      return;
    }
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch {
    // no registry folder, or nothing to remove: start then says nothing
  }
}

try {
  await main();
} catch {
  // never fail the prompt
}
process.exit(0);
