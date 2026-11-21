// TODO: buildPlan(srcHashes, dstHashes, { deleteExtra }) -> { copy, update, delete, unchanged }
// srcHashes and dstHashes are Maps from relative path to content hash. Every list is sorted.
// `delete` is empty unless deleteExtra is true.
export function buildPlan(srcHashes, dstHashes, { deleteExtra = false } = {}) {
  throw new Error('not implemented');
}
