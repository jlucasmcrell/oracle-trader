# Pre-registered test: KXBTCD near-settlement convergence

Registered 2026-09-02 12:45Z, BEFORE the collector produced any data. Nothing below may be
changed after data collection starts. If the rule needs redefining (see the basis clause), the
redefinition is written down here with a date, and scoring restarts from that date.

## Why this exists

The favorite-longshot fade was trusted on a 34-0 paper record that turned out to be the ~90%
favorite base rate; a 62-day point-in-time replay measured it at -2.9c (longshot, maker) and
-8.4c (favorite, maker). The strategy-breakout investigation (24 agents, 2026-09-02) screened
five structural alternatives. Exactly one replicated out of sample: buying the spot-implied side
of an hourly BTC strike market five minutes before close, in a moderate-margin band. But the
band was chosen after seeing a 20-cell grid, so that replication is confirmation of a selected
cell, not a pre-registered test. This document makes the next test pre-registered.

Kalshi's 1-minute candle history is retained for only ~2 weeks, which is why every BTC screen
was stuck at 13-16 days. The collector (`scripts/btc-collector.mjs`) records the data
ourselves so the sample can grow.

## The rule (fixed)

Universe: Kalshi series `KXBTCD` (hourly "BTC above strike" ladders; fee_type `quadratic`,
settlement source CF Benchmarks BRTI, verified 2026-09-02).

Signal time: T = 5 minutes before `close_time` (tolerance +/-45s, one decision per event).

Spot: Coinbase BTC-USD last trade at T (Kraken last trade recorded as a check).

Margin: `m = |spot - floor_strike| / spot`. Trade only strikes with `0.001 <= m <= 0.006`
(0.1% to 0.6% of spot).

Side: YES if `spot > floor_strike`, NO if `spot < floor_strike`.

Execution model: TAKER. Lift the live ask on that side as observed in the collector's orderbook
snapshot at T (not a candle close). Fill assumed at the ask for the size resting at the ask; if
no ask rests, no trade.

Cost: Kalshi taker fee `ceil(0.07 * contracts * p * (1-p) * 100) / 100` dollars per order,
with `contracts = floor(10 / cost)` (the app's $10 sizing), converted to cents per contract.

Grading: settlement `result` of the market. Net cents per contract = payout - cost - fee.

## The gate (fixed)

Pass requires ALL of:

1. At least 200 NEW hourly events (events whose close_time is after this document's timestamp)
   with at least one qualifying strike.
2. Event-clustered mean net taker edge with a 95% confidence interval whose LOWER bound exceeds
   +1.0 cents per contract. Because the rule came from a 20-cell grid, the interval is
   Bonferroni-corrected: use z = 3.02 (alpha = 0.05 / 20) instead of 1.96.
3. Day-clustered interval reported alongside; it must also exclude zero.
4. Coinbase-vs-BRTI basis: for every settled event, compare Coinbase spot at close against the
   market's `expiration_value` (BRTI). Report the implied-probability basis at the traded
   margins. If it exceeds 1 cent, the spot definition is redefined as the Coinbase/Kraken
   composite (dated amendment below) and scoring restarts from that date.

Fail on any one, and this rule is not built. The same dataset is then used to test the
secondary candidate (lognormal fair-value model at T-15/T-30, maker) as a separately
pre-registered rule.

## What passing buys

Passing does NOT authorize real money. It authorizes: (a) a 20-hour minimal implementation
(KXBTCD carve-out mirroring `weatherExtra`, external spot feed, 5-10s sub-loop, margin gate in
percent-of-spot, per-observation logging), (b) a two-week demo soak with pass criteria
(realized fill within 1c of signal-time ask on >= 90% of orders, signal-to-ack < 3s, zero
shard/order-group errors), then (c) tiny-live ($1-2 per contract, cap 5 contracts/event, max 3
events/day) for four weeks, passing only on a positive day-clustered CI over >= 100 live
events. Size doubles only while the trailing-30-day clustered CI stays positive and halves on
any window that crosses zero; never exceed 2% of touch depth.

## Amendments

- 2026-09-02 13:35Z - NOTE, not a rule change. An exploratory offline screen of the same
  convergence logic on the 15-minute crypto windows (KXBTC15M/ETH/SOL, 14 days, 11,846
  point-in-time rows, 1,233 clustered windows; scratchpad/pit15.mjs) found NO edge in any of
  15 cells: T-2 all-margins -2.56c [-4.58, -0.54]; in every cell the spot-vs-index flip rate
  equalled the adverse rate (24.8/24.8, 13.9/13.7, 8.3/8.3), i.e. the price already is the
  reversal probability. No 15-minute rule is registered. This lowers the prior for the
  hourly rule above but does not alter it; the forward test continues unchanged.
