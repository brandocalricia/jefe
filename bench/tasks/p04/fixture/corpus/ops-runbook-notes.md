# Operations runbook notes

Author: Tomas Weber

## Backups
- Snapshots are taken nightly at 02:00 and kept for 14 days.
- A weekly snapshot is copied to cold storage and kept for 13 months.

## Restore procedure
1. Provision a fresh cluster of the same size.
2. Attach the snapshot volume.
3. Start the engine in recovery mode and wait for the health check.
4. Switch the ingest service to the new cluster.

## Acceptance
A drill counts as passed only when the full restore finishes inside the agreed target
time; the target is recorded in the meeting minutes.
