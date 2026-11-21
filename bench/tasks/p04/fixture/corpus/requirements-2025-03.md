# Telemetry store requirements (revision 1)

Date: 2025-03-10
Owner: Priya Raman
Status: superseded by requirements-2025-09.md on 2025-09-12

## Targets
- Sustained ingest: at least 5,000 writes per second.
- Read latency: p99 of at most 25 ms.
- Retention: 180 days of raw events.
- Budget: at most 800 USD per month for engine licences, support and nodes combined.

## Deployment
- Minimum cluster size is 2 nodes.

## Notes
These targets were sized for a fleet of 1,900 vehicles. They are kept for the record only.
