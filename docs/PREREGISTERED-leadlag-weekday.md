# Pre-registered: lead-lag on weekdays against weekends

Registered 2026-09-29, before any entry in the cohort below. Operator, on the week's results: "So we keep testing,
understood."

## What prompted it (looked at first, so it does not count)

Live lead-lag on the Kalshi 15-minute crypto markets, marked to the venue's settlements (`scripts/venue-pnl.py`
through the order journal), split by the New York day of entry:

- 2026-09-15 to 2026-09-29: weekdays -$32.48 over 11 days (-3.4c/contract, 964 contracts); weekends +$55.32 over
  4 days (+11.2c/contract, 496 contracts). Every weekend day was positive (09-19 +8.88, 09-20 +1.11, 09-26 +14.37,
  09-27 +29.79); one weekday in seven since 09-21 was.
- Execution does not explain it: since 09-21 every attempt filled, at the logged price to within 0.1c, on both day
  types. Weekends had about three times the signals (90 attempts a day against 32).
- The whole signal log since 09-03, graded at its logged price, shows no weekday/weekend difference (+5.5c against
  +5.3c), but most of that log predates the rules that trade now.

This was found by slicing after looking, on four weekend days. It counts for nothing below.

## Claim under test

Lead-lag's **weekday** trading earns after the taker fee. Mechanism if it does not: with professional market makers
quoting Kalshi on weekdays, the gaps the arm sees then are more often Polymarket noise than Kalshi lag.

## The rule (fixed)

- **Cohort**: every live lead-lag fill logged in `leadlag-dislocations.jsonl` (`executed`, `filledContracts` > 0,
  `fillPrice`) from **2026-09-30T04:00Z** (Wednesday 00:00 New York), both fast and minute paths.
- **Unit**: cents per contract at the fill price, won or lost at Kalshi's settlement, less the one-contract taker fee;
  contract-weighted; 80% band clustered on the New York calendar day. Weekend = Saturday or Sunday in New York.
- Nothing about the arm changes while the cohort builds.

## Decision (fixed, carried out by the app)

`src/main/ladder/registeredReads.ts` `leadLagWeekdayRead`, once a UTC day from **2026-10-19** (three more weekends),
and only once the cohort holds at least **10 weekday days and 6 weekend days**:

- **FAIL** (weekdays lose): the weekday band wholly below zero. The app sets `leadLagWeekdays` false, and lead-lag
  trades live on New York weekends only. The recorders keep running every day.
- **PASS**: the weekday band wholly above zero. No change.
- Otherwise continue daily to **2026-11-02**, then INCONCLUSIVE: no change.

The ladder keeps judging the arm as a whole throughout; this read only decides the weekdays.
