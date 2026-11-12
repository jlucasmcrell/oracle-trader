# Pre-registered: Kalshi vs Polymarket US on the 15-minute Bitcoin market (paper)

Registered 2026-11-12, before the recorder wrote a row. Operator: "Do them all please. I want to make sure we are
checking every nook and cranny for opportunities we may be missing." It trades nothing.

## Why this pair

Both venues list a 15-minute "Bitcoin up or down" market for the same window (Kalshi `KXBTC15M`, Polymarket US
`cpc-btc-updown-15m-<date>-<HHMM>z`), and since 2026-09-21 both settle on CF Benchmarks' BRTI. The live lead-lag arm
compares Kalshi with Polymarket's international market, which settles on a different index, so part of every gap it
sees is index basis. This pair has none, and the operator holds accounts on both sides. Polymarket US lists no other
coin at 15 minutes (checked 2026-11-12).

Known handicap: Polymarket US's taker fee for a small account is 0.095 p(1-p), about 2.4c at 50c, against Kalshi's
1.75c. The earlier Polymarket US hourly test (`PREREGISTERED-polyus-btc-hour.md`) ended INCONCLUSIVE near -1c with
Polymarket US as the follower and Polymarket international or Coinbase spot as the leader; this is a different leader.

## The recorder (fixed)

`src/main/strategies/polyusK15.ts`, inside the app: Polymarket US's authenticated top of book and Kalshi's in-memory
book for the same window, written side by side to `polyus-k15-quotes.jsonl` whenever a price changes, at most every
2 s, only when the Polymarket US top is under 5 s old and both books are two-sided.

## The rule (fixed)

`scripts/polyus-k15-gate.mjs`. Two legs, graded separately:

- **kalshi**: buy on Kalshi when Polymarket US's mid is past Kalshi's ask (YES) or bid (NO).
- **polyus**: buy on Polymarket US when Kalshi's mid is past Polymarket US's ask or bid.

Unit: the first row per market, side and leg whose gap, net of that leg's taker fee, is at least **4c**, with at least
60 s of the window left; one contract at the logged price, held to Kalshi's settlement; cents per contract after the
fee; 90% band per leg (two legs), clustered on the New York day. Nets of 2, 6 and 8c are printed beside it and decide
nothing.

## Decision (fixed, read by hand)

On or after **2026-11-26**, per leg, at 100 entries on 10 New York days:

- **PASS**: band wholly above zero. A live arm is proposed under its own registration, at one contract.
- **FAIL**: band wholly below zero. The leg is closed.
- Otherwise continue to **2026-12-10**, then INCONCLUSIVE: closed, the recorder is switched off (`k15ShadowEnabled`).

Reported with the verdict: how long qualifying gaps stay open (from consecutive rows), because a gap that closes
faster than an order arrives is not an edge, and whether Polymarket US resolved the same way as Kalshi on a sample.
