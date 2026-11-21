# Load-test methodology

Author: Dana Okafor, updated 2025-09-15

## What each row of bench-results.csv is
One load-test run of one engine on one node.

## Columns
- run_id: running number.
- date: day the run was made.
- engine and engine_version.
- workload: `mixed` is 70 percent reads and 30 percent writes, driven at the maximum
  rate the engine sustains. `ingest` is writes only and has no latency figure.
- valid: `no` when the node throttled or the warm-up did not finish. Invalid runs
  must be ignored.
- writes_per_sec: sustained writes per second over the run.
- read_p99_ms: 99th percentile read latency in milliseconds, mixed runs only.
- disk_gb_per_100m_rows: disk used per 100 million rows after the run.

## Which runs are comparable
Runs dated before 2025-09-01 used pre-release engine builds. They are kept for history,
but only runs from 2025-09-01 onward reflect the engines Tarn would deploy.
The requirements are written in terms of the mixed workload.
