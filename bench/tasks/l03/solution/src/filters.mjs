const text = (value) => (value === null || value === undefined ? '' : String(value));

export const FILTERS = {
  upper: (value) => text(value).toUpperCase(),
  lower: (value) => text(value).toLowerCase(),
  trim: (value) => text(value).trim(),
  json: (value) => JSON.stringify(value),
};

export function applyFilter(name, value) {
  if (!Object.hasOwn(FILTERS, name)) throw new Error(`unknown filter: ${name}`);
  return FILTERS[name](value);
}
