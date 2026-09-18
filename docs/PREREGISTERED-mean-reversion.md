# Pre-registered test: mean reversion on extremes (Kalshi)

Registered 2026-09-07 18:05Z by the daily maintenance session, BEFORE the arm placed a single
order (`meanReversionEnabled` shipped `false`; the ladder promotes it to tiny-live on its next
hourly tick). Nothing below may be changed after the first fill. If the rule needs redefining,
the redefinition is written here with a date and scoring restarts from that date.

Build-queue item 8(a) in `docs/BACKLOG.md`.

## Why this exists

The 2026-08-28 historical validation of the momentum arm (`docs/validation-results.md`) did not
just fail to find momentum — it found the opposite. Over the replay, the mean FORWARD move after
a 10-minute price move was **-6.6c** on a 36% hit rate. That is a directional statement about
the other side of the trade: the move reverted. Momentum was later redesigned and stopped again
at -$4.41 over 20 live trades (2026-09-06 in-play churn). Nothing has ever tested the reverting
side directly, and it is the side the only real evidence points at.

This arm takes that side, once, at micro size, on the ladder.

## The rule (fixed)

Universe: the Kalshi main trader's normal scan universe, minus in-play sports (the existing
`calm` filter: sports markets within 6 h of close are excluded before any candle strategy sees
them).

Window: the last **10 minutes** of 1-minute candles (`meanReversionWindowMinutes`).

Price: each candle's `close`, or the bid/ask midpoint when the candle has no close.

Move: `to - from` across the window, in cents, where `from` is the oldest candle in the window
and `to` the newest. Fire only when `|move| >= 8c` (`meanReversionMinMoveCents`).

Traded confirmation: at least **3** of the window's candles must have non-zero volume. A move
nobody traded is a quote flicker on a thin book, not a crowd overreacting.

Horizon: the market must have at least **6 hours** to close
(`meanReversionMinHoursToClose`) — room to revert in, and the same fence that keeps the arm out
of in-play and same-session settlement noise.

Tail fence: no entry when the post-move price `to` is below 5c or above 95c. There, a move is
usually the market resolving and the side we would buy has no room left to pay.

Side: **fade the move.** Buy NO when the price rose, YES when it fell.

Execution: the trader's normal path for this strategy — maker entry is NOT enabled for
`mean-reversion` (it is absent from `makerStrategies`), so entries are taker at the app's
configured stake, one contract-sized micro position.

Exit: **hold to settlement.** `mean-reversion` is in the hold-to-settle list, so no take-profit,
stop-loss, reversal or max-hold exit applies. The churn that killed momentum came from exits.

Conflict rule: if the momentum arm fires on the same market in the same scan, momentum keeps the
market and this arm stands down — buying both sides of one contract pays two fees for a certain
loss.

Grading: the app's existing per-strategy calibration ledger under the key `mean-reversion`, net
cents per contract after fees, clustered by day (`byDay`) and by event (`byEvent`).

## The gate (fixed)

The ladder judges it, not a human, under the standing rule: micro size, checkpoint every 20
settled trades, scale up on making money with 80% confidence, stop on losing with 80%
confidence, hard stop at -$5 per size notch, cool-down and retry after a stop.

No separate promotion gate is claimed here. What IS pre-registered is the prediction:

> The mean net after fees over the first 20 settled trades is **positive**, and the 80% band's
> lower bound is above -3c per contract.

If the arm is stopped at its first checkpoint with a mean below -3c per contract, the
mean-reversion hypothesis is treated as tested and failed on Kalshi, and it is not re-proposed
without new out-of-sample evidence (it goes to the declined list in `docs/BACKLOG.md`).

## Known weaknesses, written down before the data

1. **Taker fees.** At Kalshi's quadratic fee a mid-priced round trip to settlement costs roughly
   1.5-2c per contract. An 8c overreaction has to revert by more than that to pay.
2. **Selection by the fence.** The 8c/10-min/6h numbers come from the backlog item as written on
   2026-09-06, not from a grid search on this data. They are not tuned, and tuning them after
   seeing results would void this registration.
3. **The -6.6c figure is a replay statistic**, measured with quote data and no execution model.
   It justifies the test; it does not predict the size of the live edge.
4. **Correlated fills.** Several strikes of one weather or crypto ladder can move together; the
   evidence is day- and event-clustered for exactly this reason.

## Code

- Rule: `meanReversionVerdict` in `src/main/strategies/autoTrader.ts` (pure, unit-tested in
  `scripts/tests/review-fixes.test.ts`).
- Scan: `meanReversionSignals` in the same file; wiring in `computeSignals`.
- Config: `meanReversionEnabled`, `meanReversionWindowMinutes` (10),
  `meanReversionMinMoveCents` (8), `meanReversionMinHoursToClose` (6).
- Ladder arm: `kalshi-mean-reversion` in `GENERIC_STRATEGIES` (`src/main/ladder/ladder.ts`).

## Addendum 2026-09-08 (written by the assistant during the 09-08 research pass; v1 scoring continues unchanged)

External evidence arrived after v1's first fills: Bürgi, Deng and Whelan, "Makers or Takers: The Economics of the
Kalshi Prediction Market" (GWU working paper 2026-001, 313,972 contract observations, 2021–2025) estimates pre-fee
profit per contract as −1.74c + 0.034c × price (all contracts; crypto −1.94 + 0.058 × price; closing day −2.03 +
0.036 × price). Contracts under ~50c lose before fees and 1–10c contracts lose worst; 90–99c contracts earn ~1.3c
pre-fee, and makers buy 56.5% of them. v1's rule buys the side that just fell, which on a large move is the
1–20c bucket the paper identifies as the systematically losing side (the +$20.56 so far is one 8c hit).

v2 (to take effect only when v1 reaches its 20-trade checkpoint, whichever way it goes): identical rule with the
tail fence raised from 5c/95c to **35c/65c on the side bought** (buy only when the post-move price of the side we
buy is ≥ 35c), so the arm fades moves without buying longshots. Scoring restarts from the v2 date. If v1 passes its
checkpoint, v2 replaces it at the same notch; if v1 stops, v2 starts as a fresh tiny-live test after the cool-down.

## Addendum 2026-09-08 (b): the Becker-dataset longshot table

`docs/reports/backtest-fade-audit-2026-09-08.md`, trades since 2024-10-01, 1–15c side, net of taker fee, cents
per contract: taker loses in every group but Esports (Crypto −1.99, Sports −1.82, Weather −1.57, Politics −4.63,
Finance −2.92, Entertainment −2.43); the maker seat is positive only in Weather (+1.21), Entertainment (+1.48),
Media, Esports and World Events. v1 buys the longshot side as a taker. The 35c fence in v2 stands; a maker-seat
longshot variant in weather/entertainment is a separate idea for the quoter, not for this arm.

## Addendum 2026-09-08 (c): v2 active

Applied 12:06Z on the operator's authorization: `meanReversionMinEntryPrice` 0.35 (`ReversionRule.minEntryPrice`, five new
assertions); the arm re-promotes from `disabled` with a fresh baseline, so v1's 5 settled (+$17.75, one longshot)
are not v2 evidence.

## Addendum 2026-09-08 (d): v3 = maker seat, before v2 ever traded

The move audit (`docs/reports/backtest-move-audit-2026-09-08.md`, 41,779 qualifying moves) first showed the
reverting side earning +1.8c to +14c per contract at the last-trade price and the moving side losing everywhere.
A bid-ask bounce control (only minutes where takers bought both sides, entry at the price a taker actually PAID for
that side) removed it: at the paid price the taker seat nets −3.7c below 20c, −6.3c at 20–34c, +0.1c at 35–49c,
−1.8c at 50–64c, −1.1c at 65–79c, −0.4c at 80c+. The post-move last price overshoots the tradable price by about
the spread. So the taker seat is at best break-even and v2 would have been a live test of zero.

v3 (applied 2026-09-08 before the ladder re-promoted the arm, so no v2 fill exists): same rule and 35c fence, but
the entry is a **maker rest** (`makerStrategies` now includes `mean-reversion`): a post-only bid on the reverting
side at the best bid, filled only by a taker crossing to it, which is the seat the "at last price" column
approximates (+3.6c to +5.3c ceiling before adverse selection). The ladder gates it exactly as any arm; the
throughput caveat of fade v2 applies (few fills is a finding, not a failure).
