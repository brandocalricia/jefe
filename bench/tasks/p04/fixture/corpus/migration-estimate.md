# Migration estimate

Date: 2025-10-03
Author: Priya Raman
Replaces: the rough figure given in the 2025-06-18 meeting.

## Estimates in engineer-weeks
- HarborDB: 6
- BasaltKV: 5
- QuillStore: 9

## Basis
Schema mapping, ingest service changes, back-fill of 400 days of events and cut-over.
HarborDB is higher than BasaltKV because of the compaction tuning work.
