# Benchmark results summary

The trimmed, scrubbed results behind the README's benchmark blocks. Two runs are committed, both made on 2026-11-18 on a GitHub-hosted Linux runner, on plugin tree `779dacc0ce17`, with Claude Code 2.1.327 and one trial per task and arm:

| Files | Tasks | Fills the blocks |
| --- | --- | --- |
| `ci-dev-2026-11-18-summary.json`, `ci-dev-2026-11-18-table.md` | the ten development tasks (`m01`-`m03`, `l01`-`l03`, `p01`-`p04`) | headline, job, project |
| `ci-heldout-2026-11-18-summary.json`, `ci-heldout-2026-11-18-table.md` | the five held-out tasks (`m04`, `l04`, `p05`, `p06`, `s03`) | held-out |

The arms are `top` (the Fable model alone, no plugin, as the comparison; Fable means Claude Fable 5.2, the top model available in Claude Code when the runs were made) and `jefe-fable-normal` (Jefe on a session running Fable at the level normal). The runs were headless: no interview and no Go screen.

Each `-table.md` is the unchanged output of `node bench/scorer.mjs --table` on the raw file. It holds what the README tables leave out: how each run ended (the `ended` column), turns and seconds per run, tokens by model, the per-part results of each project task, every single run, and the sign test. Each `-summary.json` holds the same cells and paired comparisons as data.

`make-summary.mjs` derives them from a raw results file (which is git-ignored, because it holds machine paths and session ids). It scrubs home paths, user names, session ids and e-mail addresses and writes `<name>-summary.json` and `<name>-table.md` next to the script:

```bash
node bench/results-summary/make-summary.mjs bench/results/<name>.json
```

The raw files of these two runs were the merged results of two CI benchmark runs, renamed `ci-dev-2026-11-18.json` and `ci-heldout-2026-11-18.json` before this script ran; that name is what the summary's `source` field shows.

Method, caveats and what would change the conclusions: [../README.md](../README.md#what-is-measured).
