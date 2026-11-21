# SPEC: engine decision report

Write `report/REPORT.md` and `report/sources.json`, answering the questions below from the
files in `corpus/` only. Do not modify anything under `corpus/`. Use no outside knowledge
and no network.

## Part A. Structure and limits

`report/REPORT.md` has exactly these headings, as level-1/2 lines, in this order, with
these exact texts:

```
# Storage Engine Decision Report
## Summary
## Questions
## Decision table
## Conflicts and superseded sources
## Not established
```

- `## Summary` contains exactly one non-blank line: `Recommended engine: <name>` where
  `<name>` is `HarborDB`, `BasaltKV` or `QuillStore`.
- `## Questions` contains eight level-3 headings `### Q1. <text>` to `### Q8. <text>`, in
  order, with the question number written as `Q<n>.` (any heading text after it). Each is
  followed by its answer, which is at most 120 words. Words are whitespace-separated
  tokens after the citations are removed.
- `## Not established` contains two level-3 headings, `### Q9. <text>` and `### Q10. <text>`.
- The whole file is at most 1500 words, counted the same way, ignoring tokens that contain
  no letter or digit (table pipes, dashes).
- No other level-1, level-2 or level-3 headings.
- Do not use abbreviations that contain a full stop followed by a space (such as "e.g. ").

## Part B. The questions

Answer in your own words, but state the facts the corpus supports. Name the engine next to every per-engine figure (write the engine name in the same comma-separated clause as its figure, for example `HarborDB 14313` or `14313 (HarborDB)`), and give durations with their unit (for example `3.5 hours` or `210 minutes`). Numbers may be written as digits or, up to ten, as words. Use only current
figures in answers and in the table: figures from superseded or refuted documents may
appear only in the Conflicts section.

- Q1. What are the current requirements: ingest rate, read p99, retention and budget?
- Q2. How many valid mixed-workload runs from 2025-09-01 onward exist for each engine, and
  which runs does the comparison exclude?
- Q3. What is each engine's mean sustained writes per second on the included runs?
- Q4. What is each engine's mean read p99 in ms on the included runs?
- Q5. What is each engine's monthly cost on the current requirements' cluster size?
- Q6. By what percent is HarborDB's mean disk use per 100 million rows lower than
  BasaltKV's, and by what percent did HarborDB's mean mixed writes per second rise from
  the April runs to the September runs?
- Q7. What do the two papers report: leveled-compaction write amplification (paper on
  log-structured stores) and the read-p99 effect of page splits (paper on B-tree stores)?
- Q8. What is the HarborDB migration estimate, and how long did the restore drill take?
- Q9. What is each engine's read p99 at 50,000 writes per second?
- Q10. In which cloud region will the cluster run?

Q9 and Q10 cannot be answered from the corpus. Do not answer them. In `## Not established`
each of their entries is one or two sentences, at most 40 words, with no citation and no
numerals (the metric name `p99` is allowed), saying that the corpus does not say or does not establish the answer. Do not
guess a value, a place or a name there.

### Included runs for computed figures
- "Included" runs (Q2 to Q6, September side): rows of `corpus/bench-results.csv` with
  `valid` = `yes`, `workload` = `mixed` and `date` on or after 2025-09-01.
- April side of Q6: HarborDB rows with `valid` = `yes`, `workload` = `mixed` and `date`
  before 2025-09-01.
- Means are arithmetic means of the included rows, computed unrounded.
- Percent change = (new - old) / old x 100 from the unrounded means (for the disk figure,
  old is BasaltKV and new is HarborDB; report the size of the drop as a positive number
  and say it is lower).
- Rounding is half-up: writes per second to a whole number, read p99 to one decimal,
  percentages to one decimal, costs to a whole number.
- Monthly cost = nodes x node price + licence or support, using the cluster size in the
  current requirements and the current pricing sheet. For BasaltKV use the licence rate the
  vendor confirmed in writing.

## Part C. Citations and sources

- Every sentence in an answer ends with one or more citations placed immediately before the
  closing full stop, for example `... 12 ms [corpus/bench-results.csv#L9].`
- A citation is `[corpus/<file>#<anchor>]`. `<file>` is a file in `corpus/`. `<anchor>` is
  either `L<n>`, a 1-based line number that exists in the file, or the slug of a heading
  in a Markdown file (lower case, characters other than letters, digits, spaces and
  hyphens removed, spaces turned into hyphens). Files without headings, such as the CSV,
  take line anchors only.
- A cited document must actually contain the key figure or term of the fact it supports.
- Cite the document that holds the fact; for a computed figure, cite the CSV.
- A superseded document (`requirements-2025-03.md`, `pricing-2025-05.md`,
  `adr-0003-draft.md`) may be cited only inside the same answer or conflict entry that also
  cites the document that supersedes it. The blog post may be cited only in a conflict
  entry that also cites `bench-results.csv`.
- `report/sources.json` is `{"sources": [{"file": "corpus/<file>", "reason": "<text>"}, ...]}`
  with one entry for every document cited anywhere in the report, no others, no
  duplicates. Each reason is one line of 3 to 25 words.

## Part D. Decision table

`## Decision table` holds a Markdown table with exactly this header row:

`| Engine | Mean writes/s | Mean read p99 ms | Meets write target | Meets p99 target | Monthly cost USD | Within budget | Verdict |`

and one row each for `HarborDB`, `BasaltKV` and `QuillStore`, in any order. Figures follow
the rounding above, written without thousands separators or currency signs. The three
yes/no columns hold `yes` or `no` (targets and budget from the current requirements, using
the rounded figures). `Verdict` is `adopt` when all three are `yes`, otherwise `reject`.
The summary's recommended engine is the one with verdict `adopt`. Table cells carry no
citations.

## Part E. Conflicts and not-established

`## Conflicts and superseded sources` lists one line per conflict, in this form:

`- <topic> | Winner: [corpus/<file>#<anchor>] | Loser: [corpus/<file>#<anchor>] | Why: <reason>`

Each Winner and Loser holds exactly one citation; the reason is 3 to 40 words with no
pipe. The list must cover these conflicts (extra well-formed entries are allowed):

1. current versus old requirements
2. current versus old pricing
3. the BasaltKV per-node licence price (the datasheet and the written vendor confirmation
   disagree)
4. the blog post's write-rate claim versus the load-test measurements
5. the HarborDB datasheet's read-latency claim versus the load-test measurements
6. the withdrawn draft decision record versus the decision meeting
7. the June migration figure versus the later migration estimate (the loser may be either document that
   carries the June figure)

A superseded document or the blog post can never be a Winner.
