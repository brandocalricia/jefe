import { LedgerError } from './errors.mjs';
import { UNCATEGORIZED } from './transactions.mjs';
import { isObject } from './util.mjs';

const KEYS = ['category', 'contains', 'regex', 'flags', 'min', 'max'];

function compileRule(rule) {
  if (!isObject(rule)) return 'must be an object';
  if (typeof rule.category !== 'string' || rule.category.trim() === '') return 'category must be a non-empty string';
  const unknown = Object.keys(rule).find((k) => !KEYS.includes(k));
  if (unknown !== undefined) return `unknown key "${unknown}"`;
  const has = (k) => rule[k] !== undefined;
  if (!['contains', 'regex', 'min', 'max'].some(has)) return 'needs at least one of contains, regex, min, max';
  if (has('contains') && (typeof rule.contains !== 'string' || rule.contains === '')) return 'contains must be a non-empty string';
  if (has('flags') && !has('regex')) return 'flags requires regex';
  let re = null;
  if (has('regex')) {
    try {
      if (typeof rule.regex !== 'string') throw new Error('not a string');
      if (has('flags') && !(typeof rule.flags === 'string' && /^[imsu]*$/.test(rule.flags))) throw new Error('bad flags');
      re = new RegExp(rule.regex, rule.flags ?? '');
    } catch {
      return `invalid regex "${String(rule.regex)}"`;
    }
  }
  if (has('min') && !Number.isInteger(rule.min)) return 'min must be an integer';
  if (has('max') && !Number.isInteger(rule.max)) return 'max must be an integer';
  if (has('min') && has('max') && rule.min > rule.max) return 'min is greater than max';
  return {
    category: rule.category.trim(),
    contains: has('contains') ? rule.contains.toLowerCase() : null,
    re,
    min: has('min') ? rule.min : -Infinity,
    max: has('max') ? rule.max : Infinity,
  };
}

export function compileRules(json) {
  if (!isObject(json) || !Array.isArray(json.rules)) throw new LedgerError('BAD_RULES', 'rules must be an array');
  const rules = json.rules.map((rule, i) => {
    const out = compileRule(rule);
    if (typeof out === 'string') throw new LedgerError('BAD_RULES', `rules[${i}]: ${out}`);
    return out;
  });
  return { rules };
}

function matches(rule, tx) {
  if (rule.contains !== null && !tx.description.toLowerCase().includes(rule.contains)) return false;
  if (rule.re !== null && !rule.re.test(tx.description)) return false;
  return tx.cents >= rule.min && tx.cents <= rule.max;
}

export function matchRule(compiled, tx) {
  return compiled.rules.findIndex((rule) => matches(rule, tx));
}

export function categorize(compiled, tx) {
  const i = matchRule(compiled, tx);
  return i < 0 ? UNCATEGORIZED : compiled.rules[i].category;
}

export function categorizeAll(compiled, transactions) {
  return transactions.map((tx) => ({ ...tx, category: categorize(compiled, tx) }));
}
