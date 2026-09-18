# Polymarket.US paper tests and market-making reassessment

## Decision

Eight new Polymarket.US paper arms are deployed. Real-money entries remain held. Deprioritize naive
market-making as a funding candidate: the operator-requested early read is negative. The existing Kalshi
recorder continues with its original strategy, records and October 17 end date.

## Existing market-making test

Started September 12 at 23:04 UTC (19:04 Eastern), about four days before this review. The integrity check
found 1,060 conflicting sequence IDs spanning September 15 06:20–08:24 UTC. Different observations share
identifiers. The new exploratory reader excludes all conflicting IDs and associated fill IDs (2,120 rows),
preserving originals. The normal grader still refuses an early verdict, and will reject these conflicts
at the scheduled read. Waiting alone will not repair the historical data problem.

Snapshot: `tmp/mmsim-exploratory-20260916.txt`.

| Measure | Exploratory result |
|---|---:|
| Remaining simulated fills | 758 |
| Fills with 15-minute observations | 601 (79.3%) |
| Day groups | 5 |
| Equal-day-weighted net markout | -1.46 cents/contract |
| Day-bootstrap 10th–90th percentiles | -2.36 to -0.44 cents/contract |
| Join best quote | -4.56 cents/contract, 4 days |
| Improve best quote | -0.92 cents/contract, 5 days |
| Largest day share of graded fills | 40.3% |

Markout measures subsequent price movement less entry fees, not realized trading profit. It excludes
an executable closing spread/fee. Missing observations, record conflicts, five days and early inspection
limit the inference. Both variants nevertheless point in the wrong direction: no live activation is
supported. Continued cheap collection can show whether this persists; it cannot produce a clean formal
pass without resolving the historical integrity issue. The recorder (PID 20688) remains running.

Reproduce with `node scripts/mmsim-grade.mjs --exploratory`. This mode never issues a formal verdict.
The scheduled/date-gated mode and operational `--interim` mode retain their meanings.

## New Polymarket.US paper arms

Each arm has $1,000 simulated starting cash and buys one contract per entry. Only public reading methods
are supplied to the lab; it has no order-submission, cancellation or credential interface.

| Arm | Entry rule |
|---|---|
| Passive join | Both best bids; 2–6c spread, 15–85c midpoint |
| Passive improve | Improve each bid one tick without crossing |
| Quote momentum | Follow a 3c midpoint move over 5–12 minutes |
| Mean reversion | Fade a 4c midpoint move over 5–12 minutes |
| Book pressure | Passive entry toward top-three-level depth ratio above 3:1 |
| Longshot control | Passive purchase of 3–10c side; hold to settlement |
| Favorite control | Passive purchase of 90–97c side; hold to settlement |
| Alternating-side benchmark | Alternate YES/NO every 30 minutes without a predictive signal |

These are hypotheses and controls, not eight claimed profitable strategies. Passive-entry arms use timed
exits; they are not full high-frequency market makers.

Execution: one-minute scans, public requests paced 1.5 seconds apart and five-minute market backoff on 429.
Every 30 minutes, select 12 samples spread across eligible markets; retain held/pending markets for
management. Discovery is bounded to 3,000 raw catalog rows and 1,000 returned candidates, not exhaustive.
Require binary open markets closing in 30 minutes–72 hours, spread <=6c, minimum quantity <=1. Four
open/pending entries per arm, at most two per underlying event, and a $5 realized daily loss cap.

Every fill requires a later observation. Passive orders fill only when a later ask is strictly below the
resting limit; touching does not count. Require displayed size for one contract. Takers pay the next ask
plus 1c within the signal limit; exits receive bid minus 1c. Other than the settlement controls, exit at
+3c net, -5c net or 15 minutes when liquidity permits. Halted/closed books cannot fabricate exits.
Settlement uses published venue results, including fractional payouts and NO complements. Missing/stale
prices remain unpriced. Orders, positions, cash, completed trades and daily quote evidence persist.

The [official US fee schedule](https://docs.polymarket.us/fees), read September 16, announces a taker
coefficient increase from 0.06 to 0.0695 at September 16 23:59 Eastern. The simulator handles that boundary
and uses the higher of the scheduled or market coefficient, charging coefficient × price × (1-price).
No maker rebates are credited. Combos, with a separate fee curve, are excluded.

## Review and UI

The paper scorecard is at the top of the Polymarket US tab: cash, realized net, open net estimate/unpriced
inventory, pending orders, closed trades, rules and evidence counts. It operates independently of the
global Paper/Live switch. Pause removes pending simulated entries while continuing position management.

Results are visible immediately. Preliminary assessment requires 100 closes, 10 underlying event groups
and seven days with closes. Day-mean ranges use mean +/- 2.8 standard errors; these are descriptive and
not multiple-testing-adjusted proof. Positive candidates require fresh confirmation and comparison with
the benchmark before a live trial. No result automatically enables live trading. Changed rules need a
separate cohort; do not pool before/after results. Minute snapshots cannot establish queue priority or
high-frequency profitability.

## Verification

Core tests cover all eight arms, fee/date boundary, delayed fills, strict passive trade-through, minimum
quantity, pause/exit management, persistence, cash reconciliation, fractional settlement, stale-book
refusal and inventory management during discovery failure. Removing the strict trade-through guard
made its test fail; source restored byte-for-byte afterward.

Actual public-data smoke found 408 candidates and generated later-quote simulated fills. Initial 429s
prompted pacing/backoff. Built Electron UI verified eight rows, cloned-ledger pause/resume, visibility
and unchanged global Live mode. Typecheck/build, ladder (126), adversarial (89), collection integrity
(7 scenarios) passed. Review initially hit an existing minute-boundary cadence assertion (484/485),
then passed 485/485 without source changes; both logs retained. Receipts: `tmp/poly-ui-round113.log`,
`tmp/poly-ui-round113.png`, and `tmp/testout/*round113*.txt`.
