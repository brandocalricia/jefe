Headline by scope (job-sized = medium + large tasks; small is out of scope):

| scope | arm | tasks | runs | pass | ended at cap, crash or timeout | $/run | $/passed task | parts passed (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| job-sized (medium + large) | jefe-fable-normal | 2 | 2 | 2/2 | 0/2 | $0.490 | $0.490 | - |
| job-sized (medium + large) | top | 2 | 2 | 2/2 | 0/2 | $0.770 | $0.770 | - |
| project | jefe-fable-normal | 2 | 2 | 1/2 | 0/2 | $2.494 | $4.988 | 90% |
| project | top | 2 | 2 | 1/2 | 0/2 | $4.755 | $9.509 | 90% |
| small (out of scope: not what Jefe is for) | jefe-fable-normal | 1 | 1 | 1/1 | 0/1 | $0.485 | $0.485 | - |
| small (out of scope: not what Jefe is for) | top | 1 | 1 | 1/1 | 0/1 | $0.318 | $0.318 | - |

Per-part pass rates (project tasks):

| task | part | title | arm | parts passed |
| --- | --- | --- | --- | --- |
| p05 | A | content loading: front matter, markdown subset, pages | jefe-fable-normal | 1/1 |
| p05 | A | content loading: front matter, markdown subset, pages | top | 1/1 |
| p05 | B | template language with includes and line-numbered errors | jefe-fable-normal | 1/1 |
| p05 | B | template language with includes and line-numbered errors | top | 1/1 |
| p05 | C | site structure: slugs, tags, pagination, drafts and future dates | jefe-fable-normal | 1/1 |
| p05 | C | site structure: slugs, tags, pagination, drafts and future dates | top | 1/1 |
| p05 | D | asset hashing and internal link checking | jefe-fable-normal | 1/1 |
| p05 | D | asset hashing and internal link checking | top | 1/1 |
| p05 | E | CLI build, check and new with an incremental content-based build | jefe-fable-normal | 1/1 |
| p05 | E | CLI build, check and new with an incremental content-based build | top | 1/1 |
| p06 | A | Core interval, time and rule logic (issues 1-4) | jefe-fable-normal | 1/1 |
| p06 | A | Core interval, time and rule logic (issues 1-4) | top | 1/1 |
| p06 | B | Bookings, buffers, waitlist, cancellation, batch (issues 5-8) | jefe-fable-normal | 1/1 |
| p06 | B | Bookings, buffers, waitlist, cancellation, batch (issues 5-8) | top | 1/1 |
| p06 | C | Reports, sorting, state files and CLI (issues 9-12) | jefe-fable-normal | 1/1 |
| p06 | C | Reports, sorting, state files and CLI (issues 9-12) | top | 1/1 |
| p06 | D | Replace positional calls and the global clock with options objects | jefe-fable-normal | 1/1 |
| p06 | D | Replace positional calls and the global clock with options objects | top | 1/1 |
| p06 | E | A test file per module that catches broken implementations | jefe-fable-normal | 0/1 |
| p06 | E | A test file per module that catches broken implementations | top | 0/1 |

| size | arm | pass | approx $/run | turns/run | s/run | tokens by model | ended | $/task | $/passed task |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| large | jefe-fable-normal | 1/1 | $0.493 | 5.0 | 65 | fable 110.7k, sonnet 100.1k | ok:1 | $0.493 | $0.493 |
| large | top | 1/1 | $0.941 | 6.0 | 108 | fable 183.5k | ok:1 | $0.941 | $0.941 |
| medium | top | 1/1 | $0.600 | 3.0 | 67 | fable 77.4k | ok:1 | $0.600 | $0.600 |
| medium | jefe-fable-normal | 1/1 | $0.488 | 5.0 | 66 | fable 110.9k, sonnet 118.0k | ok:1 | $0.488 | $0.488 |
| project | top | 1/2 | $4.755 | 10.5 | 584 | fable 1.75M | ok:2 | $4.755 | $9.509 |
| project | jefe-fable-normal | 1/2 | $2.494 | 17.0 | 603 | fable 869.9k, sonnet 4.61M | ok:2 | $2.494 | $4.988 |
| small | jefe-fable-normal | 1/1 | $0.485 | 8.0 | 62 | fable 163.6k, sonnet 100.0k | ok:1 | $0.485 | $0.485 |
| small | top | 1/1 | $0.318 | 3.0 | 22 | fable 67.4k | ok:1 | $0.318 | $0.318 |

Per run:

| task | size | split | arm | trial | result | approx $ | turns | s | ended | hidden failed/total | parts passed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| l04 | large | heldout | jefe-fable-normal | 1 | PASS | $0.493 | 5 | 65 | ok | 0/35 | - |
| l04 | large | heldout | top | 1 | PASS | $0.941 | 6 | 108 | ok | 0/52 | - |
| m04 | medium | heldout | top | 1 | PASS | $0.600 | 3 | 67 | ok | 0/43 | - |
| m04 | medium | heldout | jefe-fable-normal | 1 | PASS | $0.488 | 5 | 66 | ok | 0/33 | - |
| p05 | project | heldout | top | 1 | PASS | $3.158 | 9 | 405 | ok | 0/186 | 100% |
| p05 | project | heldout | jefe-fable-normal | 1 | PASS | $1.755 | 18 | 380 | ok | 0/177 | 100% |
| p06 | project | heldout | top | 1 | FAIL | $6.352 | 12 | 762 | ok | 1/275 | 80% |
| p06 | project | heldout | jefe-fable-normal | 1 | FAIL | $3.233 | 16 | 825 | ok | 1/225 | 80% |
| s03 | small | heldout | jefe-fable-normal | 1 | PASS | $0.485 | 8 | 62 | ok | 0/22 | - |
| s03 | small | heldout | top | 1 | PASS | $0.318 | 3 | 22 | ok | 0/24 | - |

Split: heldout. Skill version: SKILL.md sha256 de1c0f521275, git a6800ed.
Costs are API-equivalent and approximate (prices.json fetched 2026-11-17); tokens are client-reported, summed over every model in modelUsage (subagents included).


Comparison by session model (a Jefe arm is compared with the non-Jefe arms of the same session model; $/run = mean over runs; cost % and pass points are Jefe minus baseline):

| session | sizes | arm | pass | $/run | $/passed | turns | s | vs baseline: $/passed, $/run, pass points |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fable | job-sized (medium + large) | jefe-fable-normal | 2/2 | $0.490 | $0.490 | 5.0 | 65 | top: -36%, -36%, +0 |
| fable | job-sized (medium + large) | top | 2/2 | $0.770 | $0.770 | 4.5 | 87 | baseline |
| fable | medium | top | 1/1 | $0.600 | $0.600 | 3.0 | 67 | baseline |
| fable | medium | jefe-fable-normal | 1/1 | $0.488 | $0.488 | 5.0 | 66 | top: -19%, -19%, +0 |
| fable | large | jefe-fable-normal | 1/1 | $0.493 | $0.493 | 5.0 | 65 | top: -48%, -48%, +0 |
| fable | large | top | 1/1 | $0.941 | $0.941 | 6.0 | 108 | baseline |
| fable | project | top | 1/2 | $4.755 | $9.509 | 10.5 | 584 | baseline |
| fable | project | jefe-fable-normal | 1/2 | $2.494 | $4.988 | 17.0 | 603 | top: -48%, -48%, +0 |
| fable | small (out of scope: not what Jefe is for) | jefe-fable-normal | 1/1 | $0.485 | $0.485 | 8.0 | 62 | top: +53%, +53%, +0 |
| fable | small (out of scope: not what Jefe is for) | top | 1/1 | $0.318 | $0.318 | 3.0 | 22 | baseline |


Paired by task (Jefe arm minus baseline of the same session model on the same task; counted runs only):

| session | sizes | arm | baseline | tasks | mean $ diff | mean % diff | cheaper on | mean pass diff (points) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fable | job-sized (medium + large) | jefe-fable-normal | top | 2 | -$0.280 | -33% | 2/2 | +0 |
| fable | project | jefe-fable-normal | top | 2 | -$2.261 | -47% | 2/2 | +0 |
| fable | small (out of scope: not what Jefe is for) | jefe-fable-normal | top | 1 | +$0.167 | +53% | 0/1 | +0 |

| task | session | arm | baseline | $ diff | % diff | pass diff |
| --- | --- | --- | --- | --- | --- | --- |
| l04 | fable | jefe-fable-normal | top | -$0.448 | -48% | +0 |
| m04 | fable | jefe-fable-normal | top | -$0.112 | -19% | +0 |
| p05 | fable | jefe-fable-normal | top | -$1.403 | -44% | +0 |
| p06 | fable | jefe-fable-normal | top | -$3.119 | -49% | +0 |
| s03 | fable | jefe-fable-normal | top | +$0.167 | +53% | +0 |

Per cell (size x arm; cost = Claude Code's own total_cost_usd per run):

| size | arm | n | pass | mean $/run | median $/run | min-max $ | $/passed task | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| job-sized (medium + large) | jefe-fable-normal | 2 | 2/2 | $0.490 | $0.490 | $0.488-$0.493 | $0.490 | n<3: direction only |
| job-sized (medium + large) | top | 2 | 2/2 | $0.770 | $0.770 | $0.600-$0.941 | $0.770 | n<3: direction only |
| medium | jefe-fable-normal | 1 | 1/1 | $0.488 | $0.488 | $0.488-$0.488 | $0.488 | n<3: direction only |
| medium | top | 1 | 1/1 | $0.600 | $0.600 | $0.600-$0.600 | $0.600 | n<3: direction only |
| large | jefe-fable-normal | 1 | 1/1 | $0.493 | $0.493 | $0.493-$0.493 | $0.493 | n<3: direction only |
| large | top | 1 | 1/1 | $0.941 | $0.941 | $0.941-$0.941 | $0.941 | n<3: direction only |
| project | jefe-fable-normal | 2 | 1/2 | $2.494 | $2.494 | $1.755-$3.233 | $4.988 | n<3: direction only |
| project | top | 2 | 1/2 | $4.755 | $4.755 | $3.158-$6.352 | $9.509 | n<3: direction only |
| small (out of scope: not what Jefe is for) | jefe-fable-normal | 1 | 1/1 | $0.485 | $0.485 | $0.485-$0.485 | $0.485 | n<3: direction only |
| small (out of scope: not what Jefe is for) | top | 1 | 1/1 | $0.318 | $0.318 | $0.318-$0.318 | $0.318 | n<3: direction only |

Paired per task (mean of the Jefe arm's trials minus mean of the baseline's trials, same session model):

| task | size | arm | baseline | $ diff | % diff | pass (arm vs baseline) | pass diff (points) | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| l04 | large | jefe-fable-normal | top | -$0.448 | -48% | 1/1 vs 1/1 | +0 | n<3: direction only |
| m04 | medium | jefe-fable-normal | top | -$0.112 | -19% | 1/1 vs 1/1 | +0 | n<3: direction only |
| p05 | project | jefe-fable-normal | top | -$1.403 | -44% | 1/1 vs 1/1 | +0 | n<3: direction only |
| p06 | project | jefe-fable-normal | top | -$3.119 | -49% | 0/1 vs 0/1 | +0 | n<3: direction only |
| s03 | small | jefe-fable-normal | top | +$0.167 | +53% | 1/1 vs 1/1 | +0 | n<3: direction only |

Paired summary (sign test: one-sided exact p for "cheaper on more tasks than chance", ties dropped; interval: seeded bootstrap, 10,000 resamples over tasks, 95%, of the mean % cost difference):

| session | arm | baseline | scope | tasks | cheaper | sign-test p | mean % diff | 95% interval | mean pass diff (points) | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fable | jefe-fable-normal | top | job-sized (medium + large) | 2 | 2/2 | 0.250 | -33.1% | -47.6% to -18.7% | +0 | n<3: direction only |
| fable | jefe-fable-normal | top | medium | 1 | 1/1 | 0.500 | -18.7% | -18.7% to -18.7% | +0 | n<3: direction only |
| fable | jefe-fable-normal | top | large | 1 | 1/1 | 0.500 | -47.6% | -47.6% to -47.6% | +0 | n<3: direction only |
| fable | jefe-fable-normal | top | project | 2 | 2/2 | 0.250 | -46.8% | -49.1% to -44.4% | +0 | n<3: direction only |
| fable | jefe-fable-normal | top | small (out of scope: not what Jefe is for) | 1 | 0/1 | 1.000 | +52.6% | +52.6% to +52.6% | +0 | n<3: direction only |
| fable | jefe-fable-normal | top | overall | 5 | 4/5 | 0.187 | -21.4% | -47.6% to +18.0% | +0 | n<3: direction only |
