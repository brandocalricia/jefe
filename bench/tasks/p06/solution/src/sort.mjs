// Sorts a copy of the list by key(item). The sort is stable: items with equal keys keep their original order,
// in either direction.
export function sortBy(list, key, direction = 'asc') {
  const sign = direction === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -sign : ka > kb ? sign : 0;
  });
}
