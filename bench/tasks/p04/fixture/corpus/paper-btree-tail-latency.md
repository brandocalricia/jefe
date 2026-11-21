# Page Splits and Tail Latency in B-tree Stores

Authors: K. Ostrowski, J. Mbeki. Workshop paper.

## Abstract
B-tree engines show excellent median reads, but heavy random inserts trigger bursts of
page splits. We quantify the effect on the 99th percentile.

## Method
A mixed workload with random keys was run on three B-tree engines while the insert
rate was increased until split storms appeared.

## Results
- During split storms, read p99 rose by a factor of 2.4 against steady state.
- Sequential key workloads avoided split storms almost entirely.
- Median read latency stayed flat in every run.

## Limitations
Engines were run with default page sizes. Only single-node results are reported.
