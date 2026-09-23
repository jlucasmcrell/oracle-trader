# Pre-registered: Polymarket US favourite fade, re-armed (live micro-test)

Registered 2026-09-23, before the first order under these terms. Operator, asked whether to lift the fade's panel
hold: "Yes, that's fine, please do."

## Claim under test

On Polymarket US, buying the favourite side of a longshot market (YES priced 3-7.7c, so the favourite costs 92.3c or
more) with a resting maker order and holding to settlement earns after costs. The 2026-09-22 review measured the old
fade on the venue record at +1.56c/contract over 62 contracts with 3 losses (80% band -1.2 to +4.4): a small,
unproven edge. Expect roughly break-even; this is a measurement, not income.

## The rule (fixed)

The fade as it runs (`src/main/strategies/miniAuto.ts`: maker entry one tick inside the spread, two-sided book, spread
at most 5c, both sides at least $3 deep, resting orders cancelled 33 minutes before a game starts, held to settlement),
with the review's terms:
- `fadeMaxPrice` 0.077 (favourite at 92.3c or more, where a one-contract taker fee rounds to zero), `fadeMinPrice` 0.03;
- `fadeCategoryFilterEnabled` on (weather caused one of the three losses);
- `maxPerUnderlying` 1 - one position per game (two of the three losses were one NE-SEA game);
- one contract at the trader's $1 stake;
- `maxOpenPositions` 10 and a $3 daily loss brake (`maxDailyLossDollars`), plus the ladder's -$5 stop.

## Decision (fixed, carried out by the app)

`src/main/ladder/registeredReads.ts` `polyusFadeRead`, once a UTC day, on the trader's closed live fade entries from
2026-09-23 09:00Z. Unit: per contract after fees; band: day-clustered 80%.
- **Read at 15 losses or 250 settled entries.** PASS: lower bound above zero - the ladder may scale it under its own
  rules. FAIL: upper bound below zero - the app retires the arm (`Ladder.retire`).
- Otherwise continue to 30 losses or 500 settled, or 2026-12-31: then INCONCLUSIVE, and the arm stops.
- The maintenance session checks the same entries against the venue record (`scripts/venue-pnl.py --by-arm`).
