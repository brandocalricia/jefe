# HarborDB 2.1 datasheet

Vendor: Harbor Open Data Collective. Saved 2025-08-30.

## Overview
HarborDB is a log-structured merge-tree (LSM) storage engine. It is open source; the
collective sells an optional support plan.

## Specifications
- Default compaction strategy: leveled.
- Replication: Raft, minimum cluster of 3 nodes.
- Vendor-tested ingest: up to 30,000 writes per second per cluster.
- Read latency: p99 typically under 5 ms on tuned hardware with a warm cache.
- Supported architectures: x86-64 and ARM.

## Licensing
No licence fee. Support is sold as a flat monthly plan; see the current pricing sheet.
