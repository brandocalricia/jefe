// Output helpers: tab-separated rows for lists, "key: value" lines for a single record.
export const row = (...fields) => `${fields.join('\t')}\n`;

export const pairs = (entries) => entries.map(([key, value]) => `${key}: ${value}\n`).join('');

export const orDash = (value) => (value === null || value === undefined || value === '' ? '-' : value);
