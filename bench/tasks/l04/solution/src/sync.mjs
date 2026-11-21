import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyPlan } from './apply.mjs';
import { hashFile } from './hash.mjs';
import { buildPlan } from './plan.mjs';
import { walkFiles } from './walk.mjs';

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

function hashes(root) {
  return new Map(walkFiles(root).map((rel) => [rel, hashFile(join(root, rel))]));
}

export function syncDirs(src, dst, { dryRun = false, deleteExtra = false } = {}) {
  if (!isDir(src)) throw new Error(`source is not a directory: ${src}`);
  if (existsSync(dst) && !statSync(dst).isDirectory()) throw new Error(`destination is not a directory: ${dst}`);
  const plan = buildPlan(hashes(src), isDir(dst) ? hashes(dst) : new Map(), { deleteExtra });
  if (!dryRun) applyPlan(plan, src, dst);
  return { copied: plan.copy, updated: plan.update, deleted: plan.delete, unchanged: plan.unchanged };
}
