export function formatResult(result, { dryRun = false } = {}) {
  const lines = [];
  if (dryRun) lines.push('dry run: nothing was changed');
  for (const p of result.copied) lines.push(`copy ${p}`);
  for (const p of result.updated) lines.push(`update ${p}`);
  for (const p of result.deleted) lines.push(`delete ${p}`);
  lines.push(`${result.copied.length} copied, ${result.updated.length} updated, ${result.deleted.length} deleted, ${result.unchanged.length} unchanged`);
  return lines.join('\n') + '\n';
}
