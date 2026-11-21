# Storage Engine Decision Report

## Summary

Recommended engine: HarborDB

## Questions

### Q1. What are the current requirements?

The current requirements ask for a sustained ingest of at least 12,000 writes per second [corpus/requirements-2025-09.md#L8]. Read p99 must be at most 15 ms on the mixed workload [corpus/requirements-2025-09.md#L9]. Raw events are kept for 400 days [corpus/requirements-2025-09.md#L10]. The budget is 1,100 USD per month for licences, support and nodes together [corpus/requirements-2025-09.md#L11].

### Q2. Which runs count, and how many per engine?

Only valid mixed-workload runs dated 2025-09-01 or later are compared [corpus/bench-methodology.md#which-runs-are-comparable]. Runs flagged valid=no, writes-only ingest runs and the April runs on pre-release builds are excluded [corpus/bench-methodology.md#columns]. That leaves 4 runs for HarborDB, 5 for BasaltKV and 4 for QuillStore [corpus/bench-results.csv#L9].

### Q3. Mean writes per second?

HarborDB averages 14313 writes per second [corpus/bench-results.csv#L9]. BasaltKV averages 9040 [corpus/bench-results.csv#L16]. QuillStore averages 21838 [corpus/bench-results.csv#L24]. Only HarborDB and QuillStore reach the 12,000 target [corpus/requirements-2025-09.md#L8].

### Q4. Mean read p99?

HarborDB averages 12.0 ms [corpus/bench-results.csv#L9]. BasaltKV averages 8.0 ms [corpus/bench-results.csv#L16]. QuillStore averages 31.1 ms, which is over the 15 ms limit [corpus/bench-results.csv#L24].

### Q5. Monthly cost per engine?

With 3 nodes at 240 USD each, HarborDB adds a flat 250 USD support plan, so it costs 970 USD [corpus/pricing-2025-10.md#L10]. BasaltKV adds the confirmed 90 USD per node, so it costs 990 USD [corpus/email-thread-licensing.md#L15]. QuillStore adds 300 USD per node, so it costs 1620 USD and breaks the budget [corpus/pricing-2025-10.md#L11].

### Q6. Disk and write-rate percentages?

HarborDB uses 37.7% less disk per 100 million rows than BasaltKV [corpus/bench-results.csv#L10]. Its mean mixed write rate rose 44.1% from the April runs to the September runs [corpus/bench-results.csv#L2].

### Q7. What do the papers report?

Leveled compaction shows a median write amplification of 14 [corpus/paper-lsm-compaction.md#results]. During page-split storms in B-tree stores, read p99 rises by a factor of 2.4 [corpus/paper-btree-tail-latency.md#results].

### Q8. Migration estimate and restore drill?

The HarborDB migration is estimated at 6 engineer-weeks [corpus/migration-estimate.md#L8]. The restore drill on HarborDB took 3.5 hours against a target of under 4 hours [corpus/email-thread-restore-drill.md#L5].

## Decision table

| Engine | Mean writes/s | Mean read p99 ms | Meets write target | Meets p99 target | Monthly cost USD | Within budget | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HarborDB | 14313 | 12.0 | yes | yes | 970 | yes | adopt |
| BasaltKV | 9040 | 8.0 | no | yes | 990 | yes | reject |
| QuillStore | 21838 | 31.1 | yes | no | 1620 | no | reject |

## Conflicts and superseded sources

- Requirements | Winner: [corpus/requirements-2025-09.md#L3] | Loser: [corpus/requirements-2025-03.md#L5] | Why: The 2025-09 revision replaces the March one and says so.
- Pricing | Winner: [corpus/pricing-2025-10.md#L5] | Loser: [corpus/pricing-2025-05.md#L10] | Why: The October sheet is newer and states that it replaces the May sheet.
- BasaltKV licence price | Winner: [corpus/email-thread-licensing.md#L15] | Loser: [corpus/datasheet-basaltkv.md#L15] | Why: The datasheet shows list price; the vendor confirmed 90 USD in writing, which also matches the meeting note.
- Blog write rate | Winner: [corpus/bench-results.csv#L16] | Loser: [corpus/blog-why-basalt-wins.md#L6] | Why: The post used an ingest loop on a pre-release build, while our mixed-workload runs on stable builds show lower BasaltKV writes.
- HarborDB latency claim | Winner: [corpus/bench-results.csv#L9] | Loser: [corpus/datasheet-harbordb.md#L13] | Why: The datasheet claim assumes tuned hardware and a warm cache; our own runs measure the real workload.
- Draft decision record | Winner: [corpus/meeting-2025-10-07.md#decisions] | Loser: [corpus/adr-0003-draft.md#decision] | Why: The draft was never accepted and the decision meeting withdrew it.
- Migration figure | Winner: [corpus/migration-estimate.md#L8] | Loser: [corpus/meeting-2025-06-18.md#L15] | Why: The October estimate replaces the rough June figure and is dated later.

## Not established

### Q9. What is each engine's read p99 at 50,000 writes per second?

The corpus does not say; no run was made at that rate.

### Q10. In which cloud region will the cluster run?

The corpus does not establish a region; the choice is still open.
