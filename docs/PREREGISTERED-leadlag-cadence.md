# Pre-registration — lead-lag 10-second versus 60-second polling

Written 2026-09-15 before the first cadence-shadow row. This experiment changes no order, size, coin, threshold, risk limit or running test.

## Question

Did cutting lead-lag polling from the 60-second loop used during the September 12 winning streak to 10 seconds reduce first-entry profitability?

## Paired design

The live engine continues to scan every 10 seconds. Every net-positive dislocation is written to `leadlag-cadence-shadow.jsonl`; the first scan in each UTC minute is also marked as the 60-second sample. The grader takes the first qualifying observation for each ticker from each cadence, assigns one hypothetical contract at the recorded executable Kalshi price and taker fee, and joins both entries to the same Kalshi settlement. This holds the market outcome, coin mix, threshold and sizing constant. It does not place orders.

The primary sample contains only settled markets observed by both cadences. Its outcome is the paired difference `10-second net - 60-second net`, clustered by UTC entry day. Markets seen only by the 10-second cadence are reported separately and cannot decide the primary result.

This isolates first-entry timing. It does not estimate IOC fill probability or the value of second and third sweeps.

## Fixed decision rule

Do not read outcomes before **2026-09-21 00:00 UTC**. Run `node scripts/leadlag-cadence-gate.mjs --verdict` only after a fresh read-only Kalshi dump exists.

The decision requires at least **300 paired settled markets** across at least **5 UTC entry days**:

- day-clustered 95% lower bound above zero: keep 10-second polling;
- day-clustered 95% upper bound below zero: switch to 60-second polling;
- otherwise keep collecting without changing the rule until **2026-10-06 00:00 UTC**; if still inconclusive, use 60 seconds because it makes fewer requests and order opportunities.

Rows whose recorded live interval is not exactly 10,000 ms are excluded. Any later test of coin membership, size, threshold or repeat-entry policy must start after this cadence decision and receive its own dated rule.

## Operator amendment 2026-09-16 07:35Z — collection paused

The operator directed Oracle to restore the winning-period cadence rather than wait for the locked read. No outcome from
this experiment was read. New live scans use 60 seconds, so they are excluded by the fixed 10,000 ms rule above;
the rows already collected remain immutable and may be read under the original date and sample bar. This pauses
collection instead of manufacturing a verdict from an incomplete sample.
