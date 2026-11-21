// Derives the committed benchmark summary from the git-ignored raw results.
//
//   node bench/results-summary/make-summary.mjs bench/results/<name>.json
//
// Everything written is scrubbed of home paths, user names, session ids and e-mail addresses.
// Writes <name>-summary.json and <name>-table.md next to this script. The table is the output of
// `node bench/scorer.mjs --table <file>` unchanged. The summary uses the scorer's own functions
// (countable runs only, same cost and pass logic), so the numbers agree with that table.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellStats, comparisonTable, costNote, countable, markdownTable, pairedStats, pairedTable, scoreResult, trialTables } from '../scorer.mjs';

// Nothing personal in a committed summary: home-directory paths (with the user name), session ids (UUIDs),
// e-mail addresses, and the temp working folders of a run.
export function scrub(text) {
  return String(text)
    .replace(/\/(Users|home)\/[^\s/"'`)\]]+/g, '~')
    .replace(/\/(private\/)?(var\/folders|tmp)\/[^\s"'`)\]]+/g, '<tmp>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
}

// -> { summary (object), table (markdown) }, both scrubbed.
export function buildSummary(data, name) {
  const arms = {};
  for (const run of (data.runs || []).filter(countable)) {
    const s = scoreResult(run);
    const a = (arms[s.arm] ||= { runs: 0, passed: 0, cost: 0, costKnown: true, bySize: {}, partsFractions: [] });
    if (s.partsFraction !== null) a.partsFractions.push(s.partsFraction);
    const z = (a.bySize[run.size] ||= { runs: 0, passed: 0, cost: 0 });
    for (const t of [a, z]) {
      t.runs += 1;
      t.passed += s.pass ? 1 : 0;
    }
    if (s.costUSD === null) a.costKnown = false;
    else {
      a.cost += s.costUSD;
      z.cost += s.costUSD;
    }
  }
  const m = data.meta || {};
  const money = (c, n) => (n ? Math.round((c / n) * 1000) / 1000 : null);
  const trials = (m.flags || {}).trials;
  const out = {
    source: `bench/results/${name}.json (git-ignored raw data; not committed)`,
    date: m.date,
    claudeVersion: m.claudeVersion,
    skillSha256: (m.plugin || {}).skillSha256 || null,
    pluginTreeSha256: (m.plugin || {}).treeSha256 || null,
    seed: m.seed ?? (m.flags || {}).seed ?? null,
    mode: m.mode ?? null,
    split: m.split,
    trialsPerCell: trials,
    note: `Cost is API-equivalent and approximate (Claude Code's own total_cost_usd). ${trials >= 3 ? 'Three or more trials per cell.' : 'Fewer than three trials per cell: a direction, not a rate.'} costPerPassedTaskUSD is total cost of all runs divided by runs that passed.`,
    costNote: costNote(data),
    cells: cellStats(data),
    paired: pairedStats(data).summaries,
    arms: Object.fromEntries(
      Object.entries(arms).map(([k, a]) => [
        k,
        {
          runs: a.runs,
          passed: a.passed,
          costPerPassedTaskUSD: money(a.cost, a.passed),
          mediumPlusLarge: (() => {
            const z = ['medium', 'large'].map((x) => a.bySize[x] || { runs: 0, passed: 0, cost: 0 });
            const t = { runs: z[0].runs + z[1].runs, passed: z[0].passed + z[1].passed, cost: z[0].cost + z[1].cost };
            return { runs: t.runs, passed: t.passed, costPerPassedTaskUSD: money(t.cost, t.passed) };
          })(),
          // project tasks and the out-of-scope small row, with the same cost-per-passed-task logic
          project: (() => {
            const z = a.bySize.project || { runs: 0, passed: 0, cost: 0 };
            return { runs: z.runs, passed: z.passed, costPerPassedTaskUSD: money(z.cost, z.passed), partsPassedMean: a.partsFractions.length ? Math.round((a.partsFractions.reduce((x, y) => x + y, 0) / a.partsFractions.length) * 1000) / 1000 : null };
          })(),
          smallOutOfScope: (() => {
            const z = a.bySize.small || { runs: 0, passed: 0, cost: 0 };
            return { runs: z.runs, passed: z.passed, costPerPassedTaskUSD: money(z.cost, z.passed) };
          })(),
          bySize: Object.fromEntries(Object.entries(a.bySize).map(([sz, z]) => [sz, { runs: z.runs, passed: z.passed, costPerPassedTaskUSD: money(z.cost, z.passed) }])),
        },
      ]),
    ),
  };
  const table = markdownTable(data) + '\n\n' + comparisonTable(data) + '\n\n' + pairedTable(data) + '\n\n' + trialTables(data) + '\n';
  return { summary: JSON.parse(scrub(JSON.stringify(out))), table: scrub(table) };
}

if ((() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
})()) {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: node bench/results-summary/make-summary.mjs <results.json>');
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(readFileSync(src, 'utf8'));
  const name = src.split('/').pop().replace(/\.json$/, '');
  const { summary, table } = buildSummary(data, name);
  writeFileSync(join(here, `${name}-summary.json`), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(here, `${name}-table.md`), table);
  console.log(`wrote ${name}-summary.json and ${name}-table.md in ${here}`);
}
