export function createStats() {
  const counts = { hits: 0, misses: 0, evictions: 0 };
  return {
    hit: () => void counts.hits++,
    miss: () => void counts.misses++,
    evict: () => void counts.evictions++,
    snapshot: () => ({ ...counts }),
  };
}
