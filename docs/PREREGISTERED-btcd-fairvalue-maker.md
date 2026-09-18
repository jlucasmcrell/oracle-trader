# Pre-registered test: fair-value-anchored passive quotes on Kalshi crypto ladders

Registered 2026-09-02 15:20Z. Applies to events closing after this timestamp. Sibling of
`PREREGISTERED-btcd-maker.md` (which rests wherever the market's own bid sits at 80-95c). This
rule instead computes a model fair value from an independent spot feed and rests only where the
market's bid is cheap relative to that value, at any price band. The two rules share data,
fill proxy, clustering, and gate mechanics so their results are directly comparable.

## Why (and why it is one cell, not a grid)

The 2026-09-02 external review's Strategy 4 and our own lognormal screen (maker +4.39c
[+0.75, +8.04], with look-ahead in strike selection and a blind replication that fired nothing)
both point at the same mechanism: resting quotes on crypto ladders lag an observable spot price
in the final minutes. Rather than search a grid of models and thresholds, this registers ONE
fully specified rule. A plain 95% interval is therefore appropriate.

## The rule (fixed)

Universe: KXBTCD (primary); KXETHD, KXSOLD, KXXRPD (secondary, reported separately). Events
closing after registration. Signal time T = 5 minutes before close (the collector's T-5 book
snapshot). T-15 and T-30 snapshots are reported descriptively only.

Fair value: `p_fair = Phi(d2)`, `d2 = (ln(S/K) - 0.5 * sigma^2 * tau) / (sigma * sqrt(tau))`,
with r = 0,
- S = Coinbase spot recorded in the T-5 book snapshot (`spot.cb`),
- K = the strike's `floor_strike`,
- tau = 5 minutes in years (5 / 525,600),
- sigma = annualised realised volatility of Coinbase 1-minute log returns over the 240 minutes
  ending at T, fetched from Coinbase's public candles at grading time (all prices at or before
  T; no look-ahead).

Side and price: for each strike, let `yesBid` and `noBid` be the best resting bids in the
snapshot. If `p_fair - yesBid >= 0.03` and `0.05 <= yesBid <= 0.95`, rest a bid to buy YES at
`yesBid` (join the queue). Else if `(1 - p_fair) - noBid >= 0.03` and `0.05 <= noBid <= 0.95`,
rest a bid to buy NO at `noBid`. At most one order per strike.

Fill proxy (identical to the maker sibling): filled if a later per-minute ladder record before
close shows the opposite ask at or below our price (YES: `yes_ask <= bid`; NO:
`1 - yes_bid <= bid`). Unfilled orders are dropped and counted in the fill rate.

Cost: our price. Fee: zero on KXBTCD (`quadratic`); series fee_type checked for the others.
Grading: settlement result; net cents per contract = payout - cost - fee.
Clustering: by close timestamp; day-clustered interval reported.

## The gate (fixed)

Pass requires ALL of:

1. >= 60 filled trades over >= 40 distinct closes on KXBTCD alone.
2. Close-clustered 95% interval lower bound > 0 AND point estimate >= +0.34c.
3. Day-clustered interval excludes zero.
4. Opposite-side baseline (the other side at its own bid, same proxy) NOT also positive.
5. Fill rate >= 30%.
6. Reported alongside, not gating: the maker sibling's result on the same events, so the
   incremental value of the model over the plain 80-95c rule is visible.

Passing authorizes the same path as the sibling: a post-only executor on KXBTCD only, size
<= 2% of touch depth, cancel at T-1, demo round-trip, then tiny-live ($1-2 per contract, cap 5
per ladder) for 30 closes with a positive close-clustered interval before any size.

## Amendments

(none)
