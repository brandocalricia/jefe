// Decides whether a finished shard really worked: exit 1 (with one ::error:: line per problem) when
//   - the runner's log has a probe line with an exit that is not 0 (including `null`: killed, timed out, could not start), or
//   - the results file has runs but none produced a countable result.
// "Countable" is the scorer's own definition (bench/scorer.mjs): `ok`, `error` (a turn cap or per-run budget hit) and
// `timeout` are valid outcomes of a hard task; rate-limit, no-result and aborted-overage are not, and neither is an
// invalid or stale run. A shard with valid data is not failed just because the model did not pass.
//   node .github/scripts/bench-shard-check.mjs <results.json> <runner log>
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { countable } from '../../bench/scorer.mjs';

// Problems found in the log text and the parsed results; [] means fine.
export function shardProblems(logText, data) {
  const problems = [];
  for (const m of String(logText || '').matchAll(/\(probe exit ([^)]*)\)/g)) {
    if (m[1].trim() !== '0') problems.push(`the runner's rate-limit probe call failed (probe exit ${m[1].trim()}): the token is probably not working`);
  }
  const runs = data && Array.isArray(data.runs) ? data.runs : [];
  if (runs.length > 0 && !runs.some(countable)) {
    problems.push(`none of the ${runs.length} runs produced a countable result (every one was rate-limited, had no result, was aborted, or was marked invalid or stale)`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, log] = process.argv.slice(2);
  let data = null;
  try {
    if (file && existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`::error::cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
  const logText = log && existsSync(log) ? readFileSync(log, 'utf8') : '';
  const problems = shardProblems(logText, data);
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(problems.length ? 1 : 0);
}
