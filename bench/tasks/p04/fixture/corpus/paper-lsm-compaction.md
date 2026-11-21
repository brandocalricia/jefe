# Compaction Costs in Log-Structured Stores

Authors: M. Albrecht, S. Nair. Technical report TR-2024-17.

## Abstract
We measure write amplification and read tail latency for two compaction strategies
across six production-like workloads.

## Method
Each workload was replayed against an LSM engine configured with leveled compaction and
then with tiered compaction. Write amplification is bytes written to disk divided by
bytes accepted from clients.

## Results
- Leveled compaction: median write amplification of 14 across the six workloads.
- Tiered compaction: median write amplification of 5.
- Tiered compaction raised read p99 by a factor of 1.8 compared with leveled.

## Limitations
Single-node runs, SSD storage, no replication traffic.
