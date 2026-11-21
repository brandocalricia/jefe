import { LedgerError } from './errors.mjs';
import { isObject } from './util.mjs';

const fail = (message) => { throw new LedgerError('BAD_BUDGET', message); };

function checkAmounts(json, name) {
  if (json[name] === undefined) return {};
  if (!isObject(json[name])) fail(`${name} must be an object`);
  for (const [category, value] of Object.entries(json[name])) {
    if (!Number.isInteger(value) || value < 0) fail(`${name}.${category} must be a non-negative integer`);
  }
  return { ...json[name] };
}

export function parseBudgets(json) {
  if (!isObject(json)) fail('budget must be an object');
  const unknown = Object.keys(json).find((k) => !['monthly', 'yearly', 'carryOver'].includes(k));
  if (unknown !== undefined) fail(`unknown key "${unknown}"`);
  const monthly = checkAmounts(json, 'monthly');
  const yearly = checkAmounts(json, 'yearly');
  let carryOver = [];
  if (json.carryOver !== undefined) {
    if (!Array.isArray(json.carryOver) || !json.carryOver.every((c) => typeof c === 'string')) fail('carryOver must be an array of strings');
    for (const name of json.carryOver) {
      if (!(name in monthly) && !(name in yearly)) fail(`carryOver names unknown category "${name}"`);
    }
    carryOver = [...json.carryOver];
  }
  return { monthly, yearly, carryOver };
}

export function monthBudget(budgets, category, month) {
  const has = (o) => Object.hasOwn(o, category);
  if (!has(budgets.monthly) && !has(budgets.yearly)) return null;
  const yearly = has(budgets.yearly) ? budgets.yearly[category] : 0;
  const number = Number(month.slice(5, 7));
  const share = Math.floor(yearly / 12) + (number <= yearly % 12 ? 1 : 0);
  return (has(budgets.monthly) ? budgets.monthly[category] : 0) + share;
}
