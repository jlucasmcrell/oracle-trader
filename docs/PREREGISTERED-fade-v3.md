# Pre-registered: fade v3 - the favourite-longshot arm without commodities and weather, crypto tail capped

Registered 2026-09-22, before the first v3 entry. Operator: "Do whatever you can to get us back to profitable."

## Claim under test

Prediction-market longshots are overpriced and favourites underpriced (the favourite-longshot bias). fade buys the
favourite side - NO on a YES priced 3-10c - with at least 6 hours to close, as a maker. The claim is that this earns
after fees at one contract **once the two market families that carried its losses are excluded and its correlated
crypto tail is capped**.

## Evidence, and why it does not count as proof

- **Historical, out of sample for us** (REVIEW-CHANGES item 79, `scripts/backtests/calibration_slopes.py`, 4.8M
  politics trades): favourites at 85-94c with at least 6 h to close earned +3.6c and +8.2c per contract after the
  taker fee in the two halves of the sample. Caveat recorded there: five events carry 77% of the favourite contracts.
- **fade's own record, sliced after looking** (section 157, `scripts/backtests/fade_by_family.py`, 120 markets in the
  2026-09-20 dump): commodities -$3.93 on 26 (81% won), weather -$3.35 on 2, retail gas/diesel -$0.45 on 11; most
  other families small gains. Four crypto dailies closing 2026-09-21 17:00 ET lost together after that dump.
- The exclusions were chosen **after** seeing that record. So nothing above counts toward the verdict. **Only
  entries made after the v3 restart count**, and the exclusions stand or fall on forward data too (below).

## The rule (fixed)

Unchanged from fade v2: maker entry, YES 3-10c, at least 6 h to close (`fadeMinHorizonMinutes` 360), calibrated
edge net of fee at least `fadeMinEdgeCents` (1.5c), one contract (`amountPerTrade` $1), hold to settlement.

New in v3 (commit of this document):
1. **Commodity and retail-fuel price-level series are blocked** (`isCommoditySeries`: WTI, Brent, natural gas,
   copper, gold, silver, platinum, palladium, grains, softs, lumber, AAA gasoline, diesel).
2. **Weather is blocked at every horizon** (it was blocked only inside 48 h).
3. **At most one fade position on crypto closing in any one clock hour**, across all coins
   (`fadeMaxCryptoPerCloseHour` 1).

## Size and risk

Trade-small mode, one contract. The ladder's standing rules apply unchanged: the -$5 stage stop, the band stop over
at least four day-clusters, and the -$10 lifetime floor across every fade cohort (fade's lifetime stood at +$2.17 on
314 trades at registration, so the floor has $12.17 of room). The worst single position is about $0.97.

## Decision (fixed)

The cohort starts at the restart that deploys this rule. The ladder judges it as it judges every arm; in addition:

- **Read on or after 2026-10-06**, and only once at least 40 v3 entries have settled on at least 5 UTC days.
- **PASS**: day-clustered 80% band on net cents per contract with the lower bound above zero. The ladder may then
  scale it under its own rules.
- **FAIL**: the band wholly below zero. The arm stops and this registration is closed.
- Otherwise: keep collecting to 100 settled entries, the ladder's thorough rule.
- **The exclusions are tested too.** The veto ledger records every entry v3 blocks (`category:commodities`,
  `category:weather`, `crypto-close-hour`). At the read, if the blocked entries would have earned at least as much
  per contract as the admitted ones, the exclusion was not doing its job; say so and drop it in a v4.
