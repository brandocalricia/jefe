import { escapeHtml } from './escape.mjs';
import { lookup } from './lookup.mjs';

// {{{ raw }}} first, then {{ escaped }}
const TAG = /\{\{\{\s*([^{}]*?)\s*\}\}\}|\{\{\s*([^{}]*?)\s*\}\}/g;

function toText(value) {
  return value === null || value === undefined ? '' : String(value);
}

export function render(template, data = {}) {
  return template.replace(TAG, (_, raw, escaped) => {
    const text = toText(lookup(data, raw ?? escaped));
    return raw !== undefined ? text : escapeHtml(text);
  });
}
