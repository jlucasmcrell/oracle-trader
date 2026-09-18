# Pre-registered test: the morning forecast update on overnight weather brackets (Kalshi)

Registered 2026-09-08 by the daily maintenance session, BEFORE the arm placed a single order
(`weatherMorningEnabled` ships `false`; the ladder promotes it to tiny-live on a later hourly
tick, under the stagger). Nothing below may be changed after the first fill. If the rule needs
redefining, the redefinition is written here with a date and scoring restarts from that date.

Build-queue item 8(b) in `docs/BACKLOG.md` ("time-of-day effects: overnight-listed weather
brackets vs the morning forecast").

## Why this exists

Kalshi lists a city's daily high/low temperature brackets the evening before the measurement
day. They then trade all night against the previous afternoon's forecast. The NWS hourly
product this app already reads (`fetchHourlyForecast`) is refreshed from the overnight model
runs, so by the station's own mid-morning the forecast has moved while the overnight book may
not have. That is a time-of-day effect with a named mechanism, not a pattern found by search.

The app already computes a forecast-implied fair value for exactly these brackets — the quoter
uses it to price two-sided quotes, and the 2026-09-06 audit showed that quoting around the
midpoint instead lost 3.9c/contract to forecast-horizon adverse selection. That is evidence the
fair value carries information the book does not. This arm takes the same information as a
taker, once per market, in the morning window only.

## The rule (fixed)

Universe: Kalshi daily temperature brackets in the main trader's scan universe — `tempSeriesKind`
returns `high` or `low` (KXHIGHT*/KXLOWT*), the event ticker resolves to a known station, a
measurement date and a time zone.

Window: station-local hour in **[08:00, 11:00)** (`weatherMorningFromHour` 8,
`weatherMorningToHour` 11). After the overnight runs have landed in the hourly product, and
entirely before the quoter's local high blackout (12:00-20:00), when the day's extreme forms.

Fair value: `bracketFairValue(kind, strikeType, floor, cap, mu, forecastSigma(hours))` where
`mu` is the extreme of the forecast's REMAINING hours of the measurement day
(`remainingExtremes`). No banked running extreme is folded in: in the morning the day's extreme
has not formed, and the ratchet is an afternoon instrument.

Edge, after fees: buying YES pays the best ask, buying NO pays the best bid, and the Kalshi
taker fee at that price is subtracted before the comparison. Fire only when the better side's
net edge is at least **5c per contract** (`weatherMorningMinEdgeCents`).

Price fence: the traded side must be strictly between 2c and 98c.

Horizon: at least **2 hours** to close (`weatherMorningMinHoursToClose`).

Conflict rule: if the quoter is resting on that market, this arm stands down — crossing our own
quote pays a taker fee to trade with ourselves.

Side: whichever side the forecast prefers; both sides are evaluated and only the better one may
fire.

Exit: **hold to settlement.** `weather-morning` is in the hold-to-settle list. The only event
that resolves a forecast bet is the day ending; an exit rule could only pay a second spread.

Execution: the trader's normal taker path at the ladder's stake for this arm (micro, one
contract at notch 1). Weather collateral sits on Kalshi shard 0; the adapter routes the order
by market ticker.

Grading: the per-strategy calibration ledger under the key `weather-morning`, net cents per
contract after fees, clustered by day and by event. Brackets of one city-day are one event, so
several strikes moving together count once.

## The gate (fixed)

The ladder judges it: micro size, checkpoint every 20 settled trades, scale up on making money
with 80% confidence, stop on losing with 80% confidence, hard stop at -$5 per size notch,
cool-down and retry after a stop.

The pre-registered prediction:

> Over the first 20 settled trades the mean net after fees is **positive**, and the 80% band's
> lower bound is above -3c per contract.

If the arm is stopped at its first checkpoint with a mean below -3c per contract, the
"overnight book is stale at the morning update" hypothesis is treated as tested and failed, and
it is not re-proposed without new out-of-sample evidence.

## Known weaknesses, written down before the data

1. **The forecast is not a private signal.** Everyone quoting these brackets can read the same
   NWS product. The claim is only that the overnight book updates late, not that we forecast
   better. If the book is already current at 08:00 local, the 5c fence should simply mean the
   arm never fires — a silent arm here is a result, not a bug.
2. **`forecastSigma` is a fitted horizon curve, not a calibrated posterior.** A wrong sigma
   biases every bracket in the same direction on the same day, which is why the evidence is
   event- and day-clustered.
3. **Thin books.** These are the markets the quoter exists for. A 5c net edge on a 3-contract
   ask can be an artifact of one stale resting order; the depth we take is one contract, so the
   test measures what one contract can actually get.
4. **Adverse selection on the ask.** The counterparty resting the ask may be the one who has
   already read the new run. The 5c after-fee fence is the only protection, and it is not a
   tuned number: it is 5c because that is roughly three times the mid-price taker fee.
5. **Same-family correlation with the quoter's inventory.** Both trade weather on shard 0. The
   conflict rule removes the same-market case, not the same-city case.

## Code

- Rule: `morningForecastVerdict` in `src/main/strategies/autoTrader.ts` (pure, unit-tested in
  `scripts/tests/review-fixes.test.ts`).
- Scan: `morningForecastSignals` in the same file; wiring in `computeSignals`.
- Config: `weatherMorningEnabled`, `weatherMorningFromHour` (8), `weatherMorningToHour` (11),
  `weatherMorningMinEdgeCents` (5), `weatherMorningMinHoursToClose` (2).
- Ladder arm: `kalshi-weather-morning` in `GENERIC_STRATEGIES` (`src/main/ladder/ladder.ts`).
