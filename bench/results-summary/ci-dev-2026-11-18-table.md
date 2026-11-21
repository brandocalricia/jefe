Headline by scope (job-sized = medium + large tasks; small is out of scope):

| scope | arm | tasks | runs | pass | ended at cap, crash or timeout | $/run | $/passed task | parts passed (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| job-sized (medium + large) | jefe-fable-normal | 6 | 6 | 6/6 | 0/6 | $0.528 | $0.528 | - |
| job-sized (medium + large) | top | 6 | 6 | 5/6 | 0/6 | $0.564 | $0.677 | - |
| project | jefe-fable-normal | 4 | 4 | 4/4 | 0/4 | $1.555 | $1.555 | 100% |
| project | top | 4 | 4 | 4/4 | 0/4 | $2.835 | $2.835 | 100% |

Per-part pass rates (project tasks):

| task | part | title | arm | parts passed |
| --- | --- | --- | --- | --- |
| p01 | A | CSV import: parser, date and amount formats, row validation, duplicate detection | jefe-fable-normal | 1/1 |
| p01 | A | CSV import: parser, date and amount formats, row validation, duplicate detection | top | 1/1 |
| p01 | B | Categorisation rules: validation, ordered first-match rules | jefe-fable-normal | 1/1 |
| p01 | B | Categorisation rules: validation, ordered first-match rules | top | 1/1 |
| p01 | C | Budgets and monthly summaries: integer cents, yearly split, carry-over, rounding | jefe-fable-normal | 1/1 |
| p01 | C | Budgets and monthly summaries: integer cents, yearly split, carry-over, rounding | top | 1/1 |
| p01 | D | Storage: versioned JSON ledger, v1 to v2 migration, idempotent import, atomic save | jefe-fable-normal | 1/1 |
| p01 | D | Storage: versioned JSON ledger, v1 to v2 migration, idempotent import, atomic save | top | 1/1 |
| p01 | E | Command line: import, categorize, report, budget with exact output and exit codes | jefe-fable-normal | 1/1 |
| p01 | E | Command line: import, categorize, report, budget with exact output and exit codes | top | 1/1 |
| p02 | A | package layout, models, errors, parsing and the Warehouse object (no global state) | jefe-fable-normal | 1/1 |
| p02 | A | package layout, models, errors, parsing and the Warehouse object (no global state) | top | 1/1 |
| p02 | B | pricing rules in one place, the two documented fixes, orders and reports | jefe-fable-normal | 1/1 |
| p02 | B | pricing rules in one place, the two documented fixes, orders and reports | top | 1/1 |
| p02 | C | persistence behind a Store interface (memory and JSON file) | jefe-fable-normal | 1/1 |
| p02 | C | persistence behind a Store interface (memory and JSON file) | top | 1/1 |
| p02 | D | stockroom.py as a deprecation shim over the new package | jefe-fable-normal | 1/1 |
| p02 | D | stockroom.py as a deprecation shim over the new package | top | 1/1 |
| p02 | E | command line on the new API plus the low-stock command | jefe-fable-normal | 1/1 |
| p02 | E | command line on the new API plus the low-stock command | top | 1/1 |
| p03 | A | domain: roles, permission matrix, workspace and membership entities | jefe-fable-normal | 1/1 |
| p03 | A | domain: roles, permission matrix, workspace and membership entities | top | 1/1 |
| p03 | B | store: version 2 data file, indexes, idempotent migration with dry run | jefe-fable-normal | 1/1 |
| p03 | B | store: version 2 data file, indexes, idempotent migration with dry run | top | 1/1 |
| p03 | C | services: workspace-scoped, permission-checked use cases, isolation, members | jefe-fable-normal | 1/1 |
| p03 | C | services: workspace-scoped, permission-checked use cases, isolation, members | top | 1/1 |
| p03 | D | events and audit: membership events, workspace on entries, retention rule | jefe-fable-normal | 1/1 |
| p03 | D | events and audit: membership events, workspace on entries, retention rule | top | 1/1 |
| p03 | E | API routes and CLI commands, including the migrate command | jefe-fable-normal | 1/1 |
| p03 | E | API routes and CLI commands, including the migrate command | top | 1/1 |
| p03 | F | existing behaviour unchanged inside a workspace | jefe-fable-normal | 1/1 |
| p03 | F | existing behaviour unchanged inside a workspace | top | 1/1 |
| p04 | A | Report structure, headings and word limits | jefe-fable-normal | 1/1 |
| p04 | A | Report structure, headings and word limits | top | 1/1 |
| p04 | B | Key facts of each answer, and no outdated or refuted figures | jefe-fable-normal | 1/1 |
| p04 | B | Key facts of each answer, and no outdated or refuted figures | top | 1/1 |
| p04 | C | Citations resolve, support their facts, and match sources.json | jefe-fable-normal | 1/1 |
| p04 | C | Citations resolve, support their facts, and match sources.json | top | 1/1 |
| p04 | D | Figures computed from the CSV and the decision table | jefe-fable-normal | 1/1 |
| p04 | D | Figures computed from the CSV and the decision table | top | 1/1 |
| p04 | E | Conflicts section and not-established section | jefe-fable-normal | 1/1 |
| p04 | E | Conflicts section and not-established section | top | 1/1 |

| size | arm | pass | approx $/run | turns/run | s/run | tokens by model | ended | $/task | $/passed task |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| large | top | 3/3 | $0.521 | 4.3 | 51 | fable 332.4k | ok:3 | $0.521 | $0.521 |
| large | jefe-fable-normal | 3/3 | $0.483 | 5.3 | 64 | fable 358.0k, sonnet 371.6k | ok:3 | $0.483 | $0.483 |
| medium | top | 2/3 | $0.607 | 4.0 | 70 | fable 325.6k | ok:3 | $0.607 | $0.910 |
| medium | jefe-fable-normal | 3/3 | $0.572 | 7.0 | 86 | fable 452.5k, sonnet 502.2k | ok:3 | $0.572 | $0.572 |
| project | jefe-fable-normal | 4/4 | $1.555 | 14.5 | 291 | fable 1.34M, sonnet 3.43M | ok:4 | $1.555 | $1.555 |
| project | top | 4/4 | $2.835 | 9.5 | 326 | fable 2.39M | ok:4 | $2.835 | $2.835 |

Per run:

| task | size | split | arm | trial | result | approx $ | turns | s | ended | hidden failed/total | parts passed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| l01 | large | dev | top | 1 | PASS | $0.669 | 6 | 72 | ok | 0/35 | - |
| l01 | large | dev | jefe-fable-normal | 1 | PASS | $0.489 | 5 | 67 | ok | 0/35 | - |
| l02 | large | dev | jefe-fable-normal | 1 | PASS | $0.567 | 6 | 83 | ok | 0/26 | - |
| l02 | large | dev | top | 1 | PASS | $0.554 | 4 | 52 | ok | 0/25 | - |
| l03 | large | dev | top | 1 | PASS | $0.340 | 3 | 29 | ok | 0/31 | - |
| l03 | large | dev | jefe-fable-normal | 1 | PASS | $0.392 | 5 | 42 | ok | 0/27 | - |
| m01 | medium | dev | top | 1 | PASS | $0.403 | 3 | 37 | ok | 0/31 | - |
| m01 | medium | dev | jefe-fable-normal | 1 | PASS | $0.529 | 8 | 71 | ok | 0/29 | - |
| m02 | medium | dev | jefe-fable-normal | 1 | PASS | $0.449 | 5 | 47 | ok | 0/12 | - |
| m02 | medium | dev | top | 1 | PASS | $0.311 | 4 | 17 | ok | 0/12 | - |
| m03 | medium | dev | top | 1 | FAIL | $1.106 | 5 | 155 | ok | 1/40 | - |
| m03 | medium | dev | jefe-fable-normal | 1 | PASS | $0.739 | 8 | 139 | ok | 0/29 | - |
| p01 | project | dev | jefe-fable-normal | 1 | PASS | $1.636 | 18 | 322 | ok | 0/126 | 100% |
| p01 | project | dev | top | 1 | PASS | $2.416 | 6 | 297 | ok | 0/119 | 100% |
| p02 | project | dev | jefe-fable-normal | 1 | PASS | $1.625 | 15 | 296 | ok | 0/175 | 100% |
| p02 | project | dev | top | 1 | PASS | $4.005 | 12 | 495 | ok | 0/214 | 100% |
| p03 | project | dev | top | 1 | PASS | $3.819 | 13 | 398 | ok | 0/120 | 100% |
| p03 | project | dev | jefe-fable-normal | 1 | PASS | $2.019 | 18 | 409 | ok | 0/114 | 100% |
| p04 | project | dev | jefe-fable-normal | 1 | PASS | $0.938 | 7 | 137 | ok | 0/56 | 100% |
| p04 | project | dev | top | 1 | PASS | $1.099 | 7 | 115 | ok | 0/66 | 100% |

Split: dev. Skill version: SKILL.md sha256 de1c0f521275, git a6800ed.
Costs are API-equivalent and approximate (prices.json fetched 2026-11-17); tokens are client-reported, summed over every model in modelUsage (subagents included).


Comparison by session model (a Jefe arm is compared with the non-Jefe arms of the same session model; $/run = mean over runs; cost % and pass points are Jefe minus baseline):

| session | sizes | arm | pass | $/run | $/passed | turns | s | vs baseline: $/passed, $/run, pass points |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fable | job-sized (medium + large) | top | 5/6 | $0.564 | $0.677 | 4.2 | 60 | baseline |
| fable | job-sized (medium + large) | jefe-fable-normal | 6/6 | $0.528 | $0.528 | 6.2 | 75 | top: -22%, -6%, +17 |
| fable | medium | top | 2/3 | $0.607 | $0.910 | 4.0 | 70 | baseline |
| fable | medium | jefe-fable-normal | 3/3 | $0.572 | $0.572 | 7.0 | 86 | top: -37%, -6%, +33 |
| fable | large | top | 3/3 | $0.521 | $0.521 | 4.3 | 51 | baseline |
| fable | large | jefe-fable-normal | 3/3 | $0.483 | $0.483 | 5.3 | 64 | top: -7%, -7%, +0 |
| fable | project | jefe-fable-normal | 4/4 | $1.555 | $1.555 | 14.5 | 291 | top: -45%, -45%, +0 |
| fable | project | top | 4/4 | $2.835 | $2.835 | 9.5 | 326 | baseline |


Paired by task (Jefe arm minus baseline of the same session model on the same task; counted runs only):

| session | sizes | arm | baseline | tasks | mean $ diff | mean % diff | cheaper on | mean pass diff (points) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fable | job-sized (medium + large) | jefe-fable-normal | top | 6 | -$0.036 | +6% | 2/6 | +17 |
| fable | project | jefe-fable-normal | top | 4 | -$1.280 | -38% | 4/4 | +0 |

| task | session | arm | baseline | $ diff | % diff | pass diff |
| --- | --- | --- | --- | --- | --- | --- |
| l01 | fable | jefe-fable-normal | top | -$0.181 | -27% | +0 |
| l02 | fable | jefe-fable-normal | top | +$0.014 | +2% | +0 |
| l03 | fable | jefe-fable-normal | top | +$0.052 | +15% | +0 |
| m01 | fable | jefe-fable-normal | top | +$0.126 | +31% | +0 |
| m02 | fable | jefe-fable-normal | top | +$0.138 | +45% | +0 |
| m03 | fable | jefe-fable-normal | top | -$0.367 | -33% | +100 |
| p01 | fable | jefe-fable-normal | top | -$0.780 | -32% | +0 |
| p02 | fable | jefe-fable-normal | top | -$2.380 | -59% | +0 |
| p03 | fable | jefe-fable-normal | top | -$1.800 | -47% | +0 |
| p04 | fable | jefe-fable-normal | top | -$0.161 | -15% | +0 |

Per cell (size x arm; cost = Claude Code's own total_cost_usd per run):

| size | arm | n | pass | mean $/run | median $/run | min-max $ | $/passed task | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| job-sized (medium + large) | jefe-fable-normal | 6 | 6/6 | $0.528 | $0.509 | $0.392-$0.739 | $0.528 | n<3: direction only |
| job-sized (medium + large) | top | 6 | 5/6 | $0.564 | $0.478 | $0.311-$1.106 | $0.677 | n<3: direction only |
| medium | jefe-fable-normal | 3 | 3/3 | $0.572 | $0.529 | $0.449-$0.739 | $0.572 | n<3: direction only |
| medium | top | 3 | 2/3 | $0.607 | $0.403 | $0.311-$1.106 | $0.910 | n<3: direction only |
| large | jefe-fable-normal | 3 | 3/3 | $0.483 | $0.489 | $0.392-$0.567 | $0.483 | n<3: direction only |
| large | top | 3 | 3/3 | $0.521 | $0.554 | $0.340-$0.669 | $0.521 | n<3: direction only |
| project | jefe-fable-normal | 4 | 4/4 | $1.555 | $1.631 | $0.938-$2.019 | $1.555 | n<3: direction only |
| project | top | 4 | 4/4 | $2.835 | $3.118 | $1.099-$4.005 | $2.835 | n<3: direction only |

Paired per task (mean of the Jefe arm's trials minus mean of the baseline's trials, same session model):

| task | size | arm | baseline | $ diff | % diff | pass (arm vs baseline) | pass diff (points) | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| l01 | large | jefe-fable-normal | top | -$0.181 | -27% | 1/1 vs 1/1 | +0 | n<3: direction only |
| l02 | large | jefe-fable-normal | top | +$0.014 | +2% | 1/1 vs 1/1 | +0 | n<3: direction only |
| l03 | large | jefe-fable-normal | top | +$0.052 | +15% | 1/1 vs 1/1 | +0 | n<3: direction only |
| m01 | medium | jefe-fable-normal | top | +$0.126 | +31% | 1/1 vs 1/1 | +0 | n<3: direction only |
| m02 | medium | jefe-fable-normal | top | +$0.138 | +45% | 1/1 vs 1/1 | +0 | n<3: direction only |
| m03 | medium | jefe-fable-normal | top | -$0.367 | -33% | 1/1 vs 0/1 | +100 | n<3: direction only |
| p01 | project | jefe-fable-normal | top | -$0.780 | -32% | 1/1 vs 1/1 | +0 | n<3: direction only |
| p02 | project | jefe-fable-normal | top | -$2.380 | -59% | 1/1 vs 1/1 | +0 | n<3: direction only |
| p03 | project | jefe-fable-normal | top | -$1.800 | -47% | 1/1 vs 1/1 | +0 | n<3: direction only |
| p04 | project | jefe-fable-normal | top | -$0.161 | -15% | 1/1 vs 1/1 | +0 | n<3: direction only |

Paired summary (sign test: one-sided exact p for "cheaper on more tasks than chance", ties dropped; interval: seeded bootstrap, 10,000 resamples over tasks, 95%, of the mean % cost difference):

| session | arm | baseline | scope | tasks | cheaper | sign-test p | mean % diff | 95% interval | mean pass diff (points) | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fable | jefe-fable-normal | top | job-sized (medium + large) | 6 | 2/6 | 0.891 | +5.6% | -17.1% to +28.3% | +17 | n<3: direction only |
| fable | jefe-fable-normal | top | medium | 3 | 1/3 | 0.875 | +14.2% | -33.2% to +44.5% | +33 | n<3: direction only |
| fable | jefe-fable-normal | top | large | 3 | 1/3 | 0.875 | -3.1% | -27.0% to +15.3% | +0 | n<3: direction only |
| fable | jefe-fable-normal | top | project | 4 | 4/4 | 0.063 | -38.4% | -53.3% to -22.8% | +0 | n<3: direction only |
| fable | jefe-fable-normal | top | overall | 10 | 6/10 | 0.377 | -12.0% | -31.6% to +8.8% | +10 | n<3: direction only |
