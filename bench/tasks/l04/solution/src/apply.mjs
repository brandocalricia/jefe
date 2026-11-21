import { copyFileSync, mkdirSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function applyPlan(plan, srcRoot, dstRoot) {
  for (const rel of [...plan.copy, ...plan.update]) {
    const target = join(dstRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(srcRoot, rel), target);
  }
  const root = resolve(dstRoot);
  for (const rel of plan.delete) {
    const target = join(dstRoot, rel);
    rmSync(target);
    for (let dir = resolve(dirname(target)); dir !== root && dir.startsWith(root); dir = dirname(dir)) {
      if (readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    }
  }
}
