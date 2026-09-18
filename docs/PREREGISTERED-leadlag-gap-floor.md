# Pre-registration: lead-lag sweeps only gaps of 6c or more

**Registered 2026-09-18 19:50Z, before any trade under this rule.** Evidence: every executed lead-lag
sweep since 2026-09-07 (3,883 contracts), graded at the fill price plus the taker fee against Kalshi's
published result, keyed by the raw Polymarket-vs-Kalshi gap the engine recorded at decision time
(`dislocationCents`, the quantity `leadLagMinDislocationCents` gates on). Script in REVIEW-CHANGES §115.

## The finding

Per-contract net by raw gap, all sweeps:

| Era | 4-6c | 6-8c | 8-10c | 10-12c | 12c+ |
|---|---|---|---|---|---|
| A 09-07..12 (60 s, winning) | **+0.29c** (307) | +11.78c (79) | +11.52c (30) | +19.49c (43) | +15.24c (213) |
| B+C 09-13..16 (10 s, losing) | **-3.30c** (1,792) | -3.67c (592) | +9.01c (196) | -1.04c (153) | -3.71c (120) |
| D 09-17..18 (orderbook quotes) | **-2.74c** (265) | +1.00c (58) | -7.86c (22) | +34.00c (4) | +2.75c (8) |

The 4-6c bucket is the only one that is never positive, and it carries most of the volume. Era A's
+$54.51 was +$53.60 from gaps of 6c and more; the 4-6c bucket added $0.89 on 307 contracts. The losing
era's -$69.19 was -$59 in that bucket alone. Counterfactual totals per era with a 6c floor: **A +$53.60,
B+C -$10.11, D +$0.42** (current rule: +$54.51, -$69.19, -$6.84).

Crossed with minutes left in the 15-minute window, the bucket that loses in every era is **gap < 6c with
3 or more minutes left**: -4.10c / -4.35c / -3.66c on 283 / 1,724 / 229 contracts. Gaps under 6c inside
the last 3 minutes were positive in every era (+52c / +23c / +3c on 24 / 68 / 36 contracts) - real, but
too thin to trade on yet. See "shadow read" below.

Why this and not the poll interval: 60 s vs 10 s changed sweeps-per-window (1.17 vs 1.95) at identical
latency and identical quoted gaps. 90 s or 120 s would lower re-sweep odds and miss gaps in equal measure.
The gap floor removes the losing bucket regardless of cadence.

## The rule

- `leadLagMinDislocationCents` 4 -> **6** (the value was a hardcoded 4.0 in `leadLagCfg()`; §115 makes it a
  config field clamped to 2-20). Nothing else changes: 60 s poll, orderbook quotes, 1 contract
  per sweep, $15 per window, 2 coins per direction, 3 sweeps per ticker per window, all eight coins.
- Fee: unchanged (`clearsFees` still requires the net after the taker fee to be positive).

## Shadow read (not traded): the endgame exception

The cadence shadow (`leadlag-cadence-shadow.jsonl`) records every clearing gap with its timestamp, so
"gap < 6c with under 3 minutes left" can be graded daily without trading it. **Trigger 2026-09-25**: grade
those rows against results since this registration. If they are positive at 95% (day-clustered) over
>= 100 contracts-equivalent, register the exception as a second step; if not, the 6c floor stays alone.

## Stop rule (fixed)

- The ladder's `tiny-live` stop applies first (-$5 at notch 1).
- Judge at **>= 60 settled contracts across >= 5 day-clusters** on the venue ledger (the 6c floor takes
  roughly one sweep in three, so this is about a week).
- Day-clustered 95% upper bound < 0 -> the floor did not survive contact; revert to 4c and record it.
- Day-clustered 95% lower bound > 0 -> the ladder's checkpoint promotes; nothing extra.
- **Deadline 2026-10-02**: fewer than 60 settled contracts by then -> the floor starved the arm; record
  that, and the decision on whether starvation beats the old bucket is the operator's.

Falsification stated plainly: the record says gaps of 6c+ are +14.69c/contract over 365 contracts in the
winning era and +0.45c over 93 in the honest-quote era. If our fills under the floor are negative over
60 contracts and 5 days, the floor is not where the edge lives.

## Re-baseline

Prior stats stay in `perfByStrategy` under `leadlag:pre-6c-20260918`; the ladder baseline for
`kalshi-leadlag` restarts at this registration. Positions open at the switch (at most one 15-minute
window's worth) settle into the new bucket; that is noted and immaterial at 1 contract.
