# Pre-registered: fade v2 (Kalshi) — maker seat, wider horizon

Registered 2026-09-08 ~12:00Z by the assistant from the fade audit on the Becker dataset
(`docs/reports/backtest-fade-audit-2026-09-08.md`, 127,119,062 seat-rows, trades since 2024-10-01).
Takes effect at kalshi-fade v1's 20-trade checkpoint, whichever way it goes; v1 keeps trading its
registered rule until then. Scoring restarts from the switch. The ladder decides stage and size.

## Evidence (cents per contract, net of the taker fee 7c·P·(1−P); maker fee 0)

| Seat, 90–99c side | Crypto | Sports | Weather | Politics | Finance | Entertainment |
|---|---|---|---|---|---|---|
| taker (v1's seat) | −0.95 | −0.91 | −1.34 | **+1.47** | +0.14 | −1.29 |
| maker | +1.28 | +1.40 | +1.03 | **+3.39** | +1.93 | +1.97 |

By hours to close, 90–99c side: taker 1–6 h **−2.70**, <1 h −0.41, 6–24 h −1.17, 1–3 d +0.34,
>3 d +1.43; maker 1–6 h +0.64, <1 h +1.42, 6–24 h +1.79, 1–3 d +2.08, >3 d +3.18. Price bucket
for the maker: 90–94c +2.32 (size-weighted +2.70), 95–97c +1.65, 98–99c +0.79.
By hour ET the taker is worst 13–15 (−1.0 to −1.8) and the maker best at 8, 12, 16–17 and 20.

v1 (taker, NO at YES 3–10c, ≥ 60 min to close, crypto/sports/politics/other) sits in the two
worst cells of that table: taker seat, 1–6 h to close. Its +$1.16 on 7 settled is inside noise.

## The rule (fixed)

1. Seat: **maker**. Rest post-only at the current ask on the favourite side (NO when YES trades
   3–10c, YES when NO trades 3–10c), never cross. Amend to stay at the ask; pull when the edge
   gate no longer clears. Fill attribution by order id (the reconciler already does this).
2. Horizon: **≥ 6 hours to close** at entry (v1: 60 minutes). Nothing changes about exits: hold
   to settlement.
3. Universe: v1's category filter unchanged (crypto excepted; finance, entertainment, weather<48h
   blocked) plus **World Events blocked** (n small, taker −3.6). Politics keeps priority when the
   per-scan slot count binds.
4. Band: YES 3–10c unchanged (the 90–97c favourite); 98–99c stays excluded (maker +0.79 only).
5. Size and stops: the ladder's (unchanged).

## The gate (fixed)

- Checkpoints every 20 settled at the 80% band, as for every arm.
- **Throughput gate:** if fewer than 10 v2 fills land in the first 7 days, v2 is not a fair test of
  the seat; it is replaced by **v2-taker**: taker entries restricted to Politics and Finance (the
  only groups where the taker seat is positive) at ≥ 1 day to close. That fallback is written here
  so it is not a mid-test improvisation.
- Nothing above may change after the first v2 fill except by a dated addendum with scoring restart.

## Activation 2026-09-08 12:06Z

The operator: "Feel free to alter any live settings that improve our testing and chances." v2 applied ahead of v1's
checkpoint: `fadeEntryMode` maker, `fadeMinHorizonMinutes` 360; the World Events block is not a config group
(deferred to code when a World Events fade candidate ever appears). Scoring restart: the arm was set to
`disabled` with an expired cool-down so the ladder re-promotes it with a fresh baseline on its next tick. The
throughput gate (10 fills in 7 days, else v2-taker in Politics/Finance) starts at the re-promotion time.
