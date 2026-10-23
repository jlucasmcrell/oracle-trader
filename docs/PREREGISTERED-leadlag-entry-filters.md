# Pre-registered: lead-lag entry filters, held at x2

Registered 2026-10-23, before any entry under the rules below. Operator, on the proposal to hold the size and add the
two filters: "That's fine."

## What prompted it (looked at first, so it does not count)

After the 2026-10-14 move from ASTRAL to BEAST, every live lead-lag fill in `leadlag-dislocations.jsonl`
(2026-10-14 to 2026-10-23, 747 fills on 537 markets) was graded at its fill price against Kalshi's settlement, less
the logged taker fee:

- At x4 (restored by hand from ASTRAL's 2026-10-05 stage, 10-14 to 10-16): -4.4c/contract over 392 contracts, -$17.22.
  The ladder stopped it at its 30-trade checkpoint (net -$19.02).
- At one contract since 10-17: +1.2c/contract over 593 contracts. ASTRAL's 2026-09-25..10-07 venue settlements on the
  15-minute series: +3.1c/contract over about 1,900 contracts.
- Execution does not explain it: median order latency 70-100 ms, Polymarket book age under 0.1 s, fills at or
  better than the logged price.
- Sliced after looking: a second or later entry on the same market -4.0c/contract (210 entries) against +0.1c for
  first entries; gaps of 12c or more -7.1c (140), 8-12c +5.9c (251), 6-8c -3.6c (356). First entries under 12c:
  +2.0c/trade, 80% day-clustered band [-0.96, +4.96] over 10 days.

That was found by slicing, on ten days. It counts for nothing below.

## Claim under test

Lead-lag earns after the taker fee when it takes **one entry per market per window** and **skips gaps of 12c or
more**. Mechanism if it does: a repeat entry buys again into a gap the first one did not close, which is Kalshi
moving, not lagging; a very wide gap is information Kalshi has and Polymarket has not priced, not a stale Kalshi book.

## The rule (fixed)

- `leadLagOneEntryPerMarket` true and `leadLagMaxDislocationCents` 12 (`entryFilter` in
  `src/main/strategies/leadLag.ts`, checked in `sweep()` before anything is reserved, so both the minute and fast
  paths obey it). Filtered gaps are still written to `leadlag-dislocations.jsonl` with `executed` false.
- Lead-lag trades at **x2** (where ASTRAL held it on 2026-10-03) and the ladder cannot scale it above x2
  (`LEADLAG_HELD_NOTCH` in `src/main/ladder/ladder.ts`, or `ladderMaxNotch['kalshi-leadlag']` in config). Its stops
  (the -$10 hard stop per notch, so -$20 at x2) and the lifetime floor are unchanged.
- **Cohort**: every live lead-lag fill (`executed`, `filledContracts` > 0, `fillPrice`) from **2026-10-23T14:30Z**.
- **Unit**: cents per contract at the fill price, won or lost at Kalshi's settlement, less the logged taker fee;
  contract-weighted; 80% band clustered on the New York calendar day.

## Decision (fixed, read by hand)

`node scripts/leadlag-filters-gate.mjs --dir <userData> --verdict`, on or after **2026-10-30**, once the cohort holds
at least **150 fills on 7 New York days**:

- **PASS**: the band wholly above zero. Set `ladderMaxNotch['kalshi-leadlag']` to 4: the ladder may take it to x4 at
  its next checkpoint, skipping a second x2 test.
- **FAIL**: the band wholly below zero. Turn lead-lag live off (`leadLagLiveEnabled` false); the recorders keep running.
- Otherwise continue daily to **2026-11-13**, then INCONCLUSIVE: keep x2 and the filters, and say so to the operator.

Reported beside the verdict, deciding nothing: the shadow (the first gap per market and side under 12c in
`leadlag-cadence-shadow.jsonl`, one contract at the logged Kalshi price) and what the skipped 12c+ gaps would have made.

## Amendment 2026-10-23 14:25Z, before the cohort's first fill

Operator: "How can we speed the lead lag test up? ... I do not mind if more money is risked for faster completed
tests." The size moved from x1 to x2, the read from 2026-11-06 (150 fills, 10 days) to 2026-10-30 (150 fills, 7 days),
and the shadow grade was added. The cohort starts after this amendment, so no fill under the original terms counts.
