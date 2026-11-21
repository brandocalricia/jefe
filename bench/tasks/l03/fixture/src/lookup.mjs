// lookup({ a: { b: 1 } }, 'a.b') -> 1; anything missing along the way gives undefined.
export function lookup(data, path) {
  let value = data;
  for (const key of path.split('.')) {
    if (value === null || value === undefined) return undefined;
    value = value[key];
  }
  return value;
}
