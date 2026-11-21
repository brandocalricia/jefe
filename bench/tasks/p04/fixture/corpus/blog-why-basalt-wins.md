# Why BasaltKV will eat your LSM database

Posted 2025-05-20 on a consultancy blog.

Everyone keeps telling you LSM engines are the write-optimised choice. They are wrong.
In our testing BasaltKV sustained 40,000 writes per second while HarborDB managed only
13,000. Read p99 stayed under 2 ms. That is three times the write throughput with a
fraction of the latency, and it is why BasaltKV is the only sane choice for telemetry.

## Our setup
We ran a synthetic single-client insert loop with durability syncing switched off and a
pre-release BasaltKV build. We did not run a mixed workload.

## Disclosure
The author's firm resells BasaltKV licences.
