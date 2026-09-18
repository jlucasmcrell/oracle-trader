# Pre-registration: mean-reversion as a TAKER, on the series its evidence covers

**Registered 2026-09-18 19:05Z, before any trade under this rule.** Operator-directed
("do the taker retest"), on the evidence in `docs/reports/TRADE-HISTORY-2026-09-18-what-won-what-lost.md`
§6 and the first gate tally (REVIEW-CHANGES §114).

## Why this exists

- The move audit behind the arm (§52, 17.9M one-minute candles, 53,346 signals at a 6c/10-min move)
  graded **+2.2 to +3.6c/contract, taken as a TAKER at the post-move price and held to result**.
- The live arm since 2026-09-09 (v3) rested a **MAKER** order instead, and its only setups were on
  weather series, where `weatherSeatBlock` (classify.ts) refuses every non-weather-native maker entry
  because that seat measured -1.70c/contract over 801,258 venue contracts. First gate tally, 50 scans:
  34 generated, 34 vetoed, all that reason. The Becker dataset behind §52 contains zero weather rows.
- So the live arm was never the backtested arm. This registration runs the backtested one.

## The rule (unchanged where it was measured)

- Signal: `meanReversionVerdict` as is - price moved >= 6c over the last 10 minutes across >= 3 traded
  one-minute candles, market 6-24 h from close, post-move price inside 5-95c, and the side bought costs
  >= 35c (never a longshot). Buy the side the price moved away from.
- Seat: **taker at the current ask** (the arm leaves `makerStrategies`). Hold to settlement, as graded.
- Universe: whatever the scan universe offers **minus weather** - `weatherSeatBlock` stands and applies
  to takers too ("no arm evidence in this class"). The recorder shows the remaining setups are daily
  crypto and oil brackets (KXBTCD, KXETHD, KXWTI) at roughly 25 tickers a day.
- Size: the ladder's `tiny-live` notch 1 ($1 stake, one contract) - never through this document.
- Fees: §52 does not state its fee treatment. This test is judged on the venue ledger net of the taker
  fee (about 1.75c at 50c); the bar is therefore stricter than the audit's numbers.

## Stop rule (fixed)

- The ladder's `tiny-live` stop applies first: -$5 realized at notch 1.
- Judge only once **>= 40 settled contracts across >= 5 day-clusters**, on the venue ledger.
- Day-clustered 95% **upper bound < 0** -> stop, record that the taker audit did not survive our fills.
- Day-clustered 95% **lower bound > 0** -> the ladder's own checkpoint promotes it; nothing extra.
- **Deadline 2026-10-09.** Fewer than 40 settled contracts by then -> stopped for lack of flow, and the
  distinction is recorded (the maker version died of flow, not of edge; this one must not be confused
  with it).

## Re-baseline

The prior stats stay in `perfByStrategy` under `mean-reversion:pre-taker-20260918` (12 entries, 8W/6L,
+$19.18 of which +$22.33 is one LALIGA ticket under v1). The ladder baseline for `kalshi-mean-reversion`
restarts at this registration; no trade opened under the maker rule counts toward this judgment.

What would falsify it, stated plainly: the audit says +2.2c or better per contract net of nothing. If
our own taker fills, net of the fee, are negative over 40 contracts and 5 days, the audit measured
something our execution cannot reach, exactly as the consensus registration puts it.
