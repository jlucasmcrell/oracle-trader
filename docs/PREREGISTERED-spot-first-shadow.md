# Pre-registered: spot-first fair value on Kalshi 15-minute crypto (shadow)

Registered 2026-09-14 13:19Z, before the first row was recorded. Taxonomy E2; build-queue 63 / backlog 96.

## Claim under test

Exchange spot moves before Kalshi's KX<COIN>15M book reprices. A lognormal fair value from the Coinbase spot
tick, the window's published strike (`floor_strike`) and a 240-minute realised vol identifies moments where
Kalshi's touch is mispriced by more than the taker fee, and buying at that touch earns after fees at
settlement. The literature's window on Kalshi is three to seven seconds; ours is sampled every two seconds.

## Instrument

`scripts/spot-shadow.mjs`, running as the `OracleTrader-SpotShadow` task. Public data only, trades nothing:
Coinbase ticker WebSocket (BTC, ETH, SOL, XRP, DOGE), Kalshi batched public order books every 2 s, the
Polymarket CLOB WebSocket for the same windows, and Kalshi's public result three minutes after each close.
Fair value: `Phi(d2)`, `d2 = (ln(S/K) - 0.5 sigma^2 tau) / (sigma sqrt(tau))`, `tau` measured to 30 s before
close (the settlement average's midpoint), sigma = annualised sd of Coinbase 1-minute log returns over the
last 240 minutes, refreshed at each window start. Rows: `data/spot-shadow/YYYY-MM-DD.jsonl`.

## Decision unit and rule (fixed; the grader is `scripts/spot-shadow-gate.mjs`)

- One decision per (coin, window, side): the FIRST 2-second poll where the spot tick is at most 3 s old, at
  least 90 s remain, the fair value exists, the touch has at least one contract, and the edge net of the
  taker fee (`ceil(7 P (1 - P))` cents) is at least the threshold. YES buys at the ask; NO buys at 1 - bid.
- Net per contract at Kalshi's settlement: `(won ? 100 - paid : -paid) - fee`, integer cents.
- Primary threshold 3c. 2c and 5c are reported, never chosen after the fact.
- Uncertainty: day-clustered (UTC day) mean with an 80% band (Z = 1.28).
- Read date: **on or after 2026-09-21T00:00Z**. `--verdict` refuses earlier; `--interim` shows health only.
- PASS = at 3c, n >= 300 decisions, >= 5 day-clusters, day-clustered lower band > 0.
- Secondary reads (descriptive, never a pass): persistence (how many consecutive polls kept the edge; the
  "3-7 s" claim), the fair value's Brier against the Kalshi mid on the same minutes (if the mid is better
  calibrated the model adds nothing and the edge is noise), per-coin and per-side bands.

## What a PASS earns

A proposal for a tiny-live arm through the ladder at its floor size, BTC/ETH first, with the same
per-window caps as lead-lag (rounds 93-94), and only after the Kalshi socket (build-queue 61) is live so
the arm acts on a fresh book. Nothing here re-arms momentum or changes any live size.

## What a FAIL means

The 2-second sample cannot see a sub-2-second edge; a FAIL at this cadence closes the question at this
cadence only. Reopen only with socket-resolution Kalshi books and the same rule.

## Amendments after registration (rule untouched)

- 2026-09-14 13:35Z: grader loader now reads only `k`/`settle`/`win` rows (spot and Polymarket rows are ~70% of a
  ~110 MB/day file) and labels the interim line accordingly; one self-test assertion corrected (it expected the
  5c threshold to drop a window instead of taking the later 7c poll). Decision unit, thresholds, read date and
  PASS rule unchanged. Grader sha256 at registration 624d3956fedbc950..., now 1335cdde7f22a9be...; recorder a00dceb4c1d3b3b8... unchanged.
