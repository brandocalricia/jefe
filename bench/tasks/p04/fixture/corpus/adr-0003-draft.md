# ADR-0003: Storage engine for the telemetry store

Date: 2025-06-25
Status: draft (never accepted)

## Decision
Adopt BasaltKV.

## Reasons
- A public blog post reports 40,000 writes per second for BasaltKV.
- The B-tree design is familiar to the team.
- Read latency looks excellent.

## Consequences
Licence fees apply. Migration work is estimated at about 11 engineer-weeks.

## Review
Revisit after the September runs.
