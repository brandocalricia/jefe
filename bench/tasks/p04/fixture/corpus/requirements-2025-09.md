# Telemetry store requirements (revision 2)

Date: 2025-09-12
Owner: Priya Raman
Replaces: requirements-2025-03.md

## Targets
- Sustained ingest: at least 12,000 writes per second.
- Read latency: p99 of at most 15 ms on the mixed workload.
- Retention: 400 days of raw events.
- Budget: at most 1,100 USD per month for engine licences, support and nodes combined.

## Deployment
- Minimum cluster size is 3 nodes, one per availability zone, for high availability.
- Every engine is costed on the same node class, described in hardware-notes.md.

## Why the targets changed
The fleet grew to 5,400 vehicles after the spring contracts, and the new telematics
units report twice as often. The older revision no longer covers peak load.
