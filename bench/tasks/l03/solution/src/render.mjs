import { escapeHtml } from './escape.mjs';
import { applyFilter } from './filters.mjs';
import { lookup } from './lookup.mjs';

// {{{ raw }}} first, then {{ escaped }}
const TAG = /\{\{\{\s*([^{}]*?)\s*\}\}\}|\{\{\s*([^{}]*?)\s*\}\}/g;

function toText(value) {
  return value === null || value === undefined ? '' : String(value);
}

export function render(template, data = {}) {
  return template.replace(TAG, (_, raw, escaped) => {
    const [path, ...filters] = (raw ?? escaped).split('|').map((part) => part.trim());
    let value = lookup(data, path);
    for (const name of filters) value = applyFilter(name, value);
    const text = toText(value);
    return raw !== undefined ? text : escapeHtml(text);
  });
}
