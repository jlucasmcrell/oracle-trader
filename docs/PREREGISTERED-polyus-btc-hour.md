# Pre-registered: lead-lag on Polymarket US's hourly Bitcoin market (shadow)

Registered 2026-10-04, before the recorder logged a row. Operator: "Let's do that for Poly."

## Why this market, and why the authenticated feed

Polymarket US lists one crypto market of this kind: "BTC Up or Down Hourly" (`cpc-btc-updown-1h-<date>-<HH>00z`),
one per hour, settling on CF Benchmarks' BRTI at the hour's end against its start - the index Kalshi's crypto markets
use - with the 0.0695 fee coefficient. On 2026-10-04 07:00Z it had about 50,000 contracts traded and a 1c spread.

The September Polymarket US lag arm failed because the public REST prices are a 30-second cache with longer freezes
(section 164). `scripts/readonly-polyus-ws-probe.cjs` measured the authenticated market-data socket on the same
market for two minutes: 787 top-of-book updates, 87 changes, a median 0.4 s between changes, 403 trades - against
the public /bbo, which changed 4 times (median 30 s apart) and ended at 0.29/0.35 while the live book stood at
0.37/0.38. Only the authenticated book is used.

## Claim under test

The Polymarket US hourly book lags one of two leaders by more than the taker fee often enough, and long enough, for a
taker to earn at settlement:

1. **international**: the mid of Polymarket's international market for the same hour (slug bitcoin-up-or-down-<month>-<day>-<year>-<h><am|pm>-et, Binance BTC/USDT settled; the
   basis is recorded, not assumed away), when its spread is at most 5c and its top is under 5 s old;
2. **spot**: a lognormal fair value of P(up) from the Coinbase spot tick (under 3 s old), the hour's opening price
   (Coinbase one-minute open at the hour) and Coinbase five-minute realised volatility.

## The rule (fixed)

- `src/main/strategies/polyusBtcHour.ts`, inside the app, every 250 ms while the book is under 5 s old and at least
  60 s of the hour remain. A gap is the net cents of buying YES at the ask (`leader - ask - fee(ask)`) or NO at
  `1 - bid` (`bid - leader - fee(1 - bid)`), fee = `polyUsTakerFee`. Rows are written when a gap of 2c or more opens
  and when it closes (with its duration) to `polyus-btc-hour-shadow.jsonl`. It trades nothing.
- **Decision unit**: the FIRST gap of at least **6c** per market, side and leader, bought at the logged price and held
  to settlement. Unit cents per contract after the fee; band clustered on the UTC day, z = 1.645 per leader
  (Bonferroni over the two leaders for an 80% family).

## Decision (fixed, carried out by the app)

`src/main/ladder/registeredReads.ts` `polyusBtcHourRead`, once a UTC day from **2026-10-18**. A leader is readable at
100 first gaps over 7 days.

- **PASS**: any readable leader's lower bound above zero. The recorder keeps running and the verdict is pushed; a live
  arm is then built under its own registration (its size and loss limits are the operator's).
- **FAIL**: both leaders readable with upper bounds below zero. The app sets `btcHourShadowEnabled` false.
- Otherwise continue daily to **2026-11-01**, then INCONCLUSIVE: the recorder stops.

Durations are reported with the verdict: a gap that closes faster than an order reaches the venue is not an edge.
