export function buildPlan(srcHashes, dstHashes, { deleteExtra = false } = {}) {
  const plan = { copy: [], update: [], delete: [], unchanged: [] };
  for (const [path, hash] of srcHashes) {
    if (!dstHashes.has(path)) plan.copy.push(path);
    else if (dstHashes.get(path) !== hash) plan.update.push(path);
    else plan.unchanged.push(path);
  }
  if (deleteExtra) for (const path of dstHashes.keys()) if (!srcHashes.has(path)) plan.delete.push(path);
  for (const list of Object.values(plan)) list.sort();
  return plan;
}
