import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseBudgets } from '../budgets.mjs';
import { importInto, loadLedger, saveLedger } from '../ledger.mjs';
import { categorizeAll, compileRules } from '../rules.mjs';
import { monthlySummary } from '../summary.mjs';
import { budgetLines, reportLines } from './format.mjs';
import { parseTransactions, UNCATEGORIZED } from '../transactions.mjs';

// Thrown to stop a command with a given exit code and stderr lines.
export class Exit extends Error {
  constructor(code, lines) {
    super(lines.join('\n'));
    this.code = code;
    this.lines = lines;
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Exit(3, [`error: cannot read ${path}`]);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readText(path));
  } catch (err) {
    if (err instanceof SyntaxError) throw new Exit(2, [`error: ${path} is not valid JSON`]);
    throw err;
  }
}

export function importCommand({ positionals: [csvPath], ledgerPath }) {
  const { transactions, errors } = parseTransactions(readText(csvPath));
  if (errors.length > 0) throw new Exit(2, errors.map((e) => `error: ${csvPath}:${e.line}: ${e.message}`));
  const result = importInto(loadLedger(ledgerPath), transactions, basename(csvPath));
  saveLedger(ledgerPath, result.ledger);
  return [`imported ${result.added} added, ${result.skipped} skipped`];
}

export function categorizeCommand({ options, ledgerPath }) {
  const compiled = compileRules(readJson(options.rules));
  const ledger = loadLedger(ledgerPath);
  const transactions = categorizeAll(compiled, ledger.transactions);
  saveLedger(ledgerPath, { ...ledger, transactions });
  const left = transactions.filter((t) => t.category === UNCATEGORIZED).length;
  return [`categorized ${transactions.length} transactions, ${left} uncategorized`];
}

const EMPTY_BUDGETS = { monthly: {}, yearly: {}, carryOver: [] };

export function reportCommand({ positionals: [month], ledgerPath }) {
  return reportLines(monthlySummary(loadLedger(ledgerPath).transactions, EMPTY_BUDGETS, month));
}

export function budgetCommand({ positionals: [budgetPath, month], ledgerPath }) {
  const budgets = parseBudgets(readJson(budgetPath));
  return budgetLines(monthlySummary(loadLedger(ledgerPath).transactions, budgets, month));
}

export const HANDLERS = { import: importCommand, categorize: categorizeCommand, report: reportCommand, budget: budgetCommand };
