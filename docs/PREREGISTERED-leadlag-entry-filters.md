# Pre-registered: lead-lag entry filters, held at x2

Registered 2026-10-23, before any entry under the rules below. Operator, on the proposal to hold the size and add the
two filters: "That's fine."

## What prompted it (looked at first, so it does not count)

After the 2026-10-14 move from ASTRAL to BEAST, every live lead-lag fill in `leadlag-dislocations.jsonl`
(2026-10-14 to 2026-10-23, 747 fills on 537 markets) was graded at its fill price against Kalshi's settlement, less
the logged taker fee:

- At x4 (restored by hand from ASTRAL's 2026-10-05 stage, 10-14 to 10-16): -4.4c/contract over 392 contracts, -$17.22.
  The ladder stopped it at its 30-trade checkpoint (net -$19.02).
- At one contract since 10-17: +1.2c/contract over 593 contracts. ASTRAL's 2026-09-25..10-07 venue settlements on the
  15-minute series: +3.1c/contract over about 1,900 contracts.
- Execution does not explain it: median order latency 70-100 ms, Polymarket book age under 0.1 s, fills at or
  better than the logged price.
- Sliced after looking: a second or later entry on the same market -4.0c/contract (210 entries) against +0.1c for
  first entries; gaps of 12c or more -7.1c (140), 8-12c +5.9c (251), 6-8c -3.6c (356). First entries under 12c:
  +2.0c/trade, 80% day-clustered band [-0.96, +4.96] over 10 days.

That was found by slicing, on ten days. It counts for nothing below.

## Claim under test

Lead-lag earns after the taker fee when it takes **one entry per market per window** and **skips gaps of 12c or
more**. Mechanism if it does: a repeat entry buys again into a gap the first one did not close, which is Kalshi
moving, not lagging; a very wide gap is information Kalshi has and Polymarket has not priced, not a stale Kalshi book.

## The rule (fixed)

- `leadLagOneEntryPerMarket` true and `leadLagMaxDislocationCents` 12 (`entryFilter` in
  `src/main/strategies/leadLag.ts`, checked in `sweep()` before anything is reserved, so both the minute and fast
  paths obey it). Filtered gaps are still written to `leadlag-dislocations.jsonl` with `executed` false.
- Lead-lag trades at **x2** (where ASTRAL held it on 2026-10-03) and the ladder cannot scale it above x2
  (`LEADLAG_HELD_NOTCH` in `src/main/ladder/ladder.ts`, or `ladderMaxNotch['kalshi-leadlag']` in config). Its stops
  (the -$10 hard stop per notch, so -$20 at x2) and the lifetime floor are unchanged.
- **Cohort**: every live lead-lag fill (`executed`, `filledContracts` > 0, `fillPrice`) from **2026-10-23T14:30Z**.
- **Unit**: cents per contract at the fill price, won or lost at Kalshi's settlement, less the logged taker fee;
  contract-weighted; 80% band clustered on the New York calendar day.

## Decision (fixed, read by hand)

`node scripts/leadlag-filters-gate.mjs --dir <userData> --verdict`, on or after **2026-10-30**, once the cohort holds
at least **150 fills on 7 New York days**:

- **PASS**: the band wholly above zero. Set `ladderMaxNotch['kalshi-leadlag']` to 4: the ladder may take it to x4 at
  its next checkpoint, skipping a second x2 test.
- **FAIL**: the band wholly below zero. Turn lead-lag live off (`leadLagLiveEnabled` false); the recorders keep running.
- Otherwise continue daily to **2026-11-13**, then INCONCLUSIVE: keep x2 and the filters, and say so to the operator.

Reported beside the verdict, deciding nothing: the shadow (the first gap per market and side under 12c in
`leadlag-cadence-shadow.jsonl`, one contract at the logged Kalshi price) and what the skipped 12c+ gaps would have made.

## Amendment 2026-10-23 14:25Z, before the cohort's first fill

Operator: "How can we speed the lead lag test up? ... I do not mind if more money is risked for faster completed
tests." The size moved from x1 to x2, the read from 2026-11-06 (150 fills, 10 days) to 2026-10-30 (150 fills, 7 days),
and the shadow grade was added. The cohort starts after this amendment, so no fill under the original terms counts.

## Amendment 2026-11-02 19:40Z — x4 by operator decision

Operator: "Put it up to 4x." Taken before the read decided (the cohort stood at 392 fills, +1.57c/contract, 80%
[-0.12, 3.26], CONTINUE). `ladderMaxNotch['kalshi-leadlag']` is 4 in config and the arm was set to live x4 by hand.
The filters and the read stay as registered; the hard stop at x4 is -$40. Fills from here are reported as their own
x4 slice beside the x2 cohort, so a size effect on fill prices is visible. A 2026-10-30 unclean shutdown wiped the
arm's state; it was restored from the 2026-10-30 16:25 local backup on 11-02, and no fills were made in between.

## Amendment 2026-11-02 19:58Z — a rule for the 12c cap

Operator: "Yes" to deciding the cap as well as the size. On **2026-11-13**, read the skipped 12c+ gaps from the same
grader (shadow, one contract at the logged Kalshi price, from 2026-10-23T14:30Z), at 7 New York days or more:

- band wholly above zero: raise `leadLagMaxDislocationCents` to **16**;
- band wholly below zero: keep **12**;
- otherwise keep 12 and keep scoring.

At this amendment the skipped gaps stood at 80, +1.19c, 80% [-5.91, 8.28]. The size read above is unchanged.

## Amendment 2026-11-04 16:35Z — back to x2

Operator: "We can go back to x2." At x4 (11-02 19:41Z to 11-04 15:28Z, when the daily loss limit tripped): 142 fills,
-3.37c/contract, -$11.71; the shadow of every first gap lost too (-9.1c over the last day), and fill slippage, latency,
Polymarket book age, gap size and the socket-versus-book agreement matched the x2 week, so no execution change was
found. `ladderMaxNotch['kalshi-leadlag']` is 2 again and the arm is live x2. The reads are unchanged.

## Amendment 2026-11-04 16:45Z — BNB recorded, not traded

Operator: "Yes" to pausing BNB. Binance (BNB's main market) was hacked on 2026-10-29 and halted trading; since then
lead-lag's BNB fills settled at -7.2c/contract (92 fills, -$13.19) against -1.8c for the other coins, and before the
hack (10-23..28) the arm made +2.4c. `leadLagNoTradeCoins: ['BNB']` keeps BNB scanned and its gaps logged, untraded.
BNB fills drop out of the cohort from here; the read is otherwise unchanged. Re-arm BNB when its logged gaps grade
positive again, on the operator's word.

## Amendment 2026-11-06 16:05Z — four coins traded, four recorded

Operator: "Yes." Since the BNB pause (11-04 16:40Z) the traded coins lost -11.4c/contract over 54 fills while BNB's
untraded first gaps graded +15.1c over 51: coin-by-coin swings on a few days are noise. Across the two machines, as
independent samples: BTC +10.2c (ASTRAL 09-25..10-07) and +5.0c (BEAST since 10-14), SOL +6.1/+5.3, HYPE +6.1/+3.6,
ZEC +6.7/+4.7; ETH -1.1/-9.3 and BNB -0.5/-1.3 lost on both; XRP and DOGE changed sign. ASTRAL's +$59 on the 15-minute
series was +$48.57 BTC. `leadLagNoTradeCoins` is now BNB, ETH, XRP and DOGE (scanned and logged, not traded); size
stays x2. Fills from here are a four-coin cohort, read with the rest on 2026-11-13.

## Amendment 2026-11-10 08:18Z — weekdays back at one contract, more coins on weekends

The registered weekday read (PREREGISTERED-leadlag-weekday.md) FAILED on 2026-11-09 (weekdays -1.70c/contract, 80%
[-3.34, -0.06], all eight coins; weekends +4.88c) and set `leadLagWeekdays` false. Operator, on seeing the four traded
coins at +1.2c on weekdays (327 trades) and +11.7c on weekends: "positive is positive... increase the number of trades
on only weekends and turn on weekdays at a reduced amount for testing further."

- Weekdays: `leadLagWeekdays` true again, `leadLagWeekdayContracts` 1, coins BTC, SOL, HYPE, ZEC.
- Weekends: x2, every coin but BNB (`leadLagWeekendNoTradeCoins: ['BNB']`; weekend BNB since 10-14: -4.0c over 132).
- Fills are reported as weekday and weekend slices from here, beside the cohort; the 11-13 reads are unchanged.
- Corrected 08:25Z, operator: "increase the number of trades on the coins we know are winning, not start trading again
  on coins that were losing." Weekends are back to BTC, SOL, HYPE and ZEC (`leadLagWeekendNoTradeCoins` = the weekday
  list). No weekend passed in between, so no fill was made on the other coins.

## Amendment 2026-11-10 08:30Z — weekends x4, ETH back on weekends

Operator: "Yes, and turn ETH back on." Weekends trade BTC, SOL, HYPE, ZEC and ETH at x4 (`ladderMaxNotch` 4, notch 4,
`leadLagProvenCoins` those five so each sweeps the full size); weekdays stay BTC, SOL, HYPE, ZEC at one contract
(`leadLagWeekdayContracts` 1). ETH's untraded weekend gaps since 11-06 graded +11.3c (18), its weekday gaps -8.9c (8),
so it is back on weekends only. Hard stop at x4 is -$40.

## Amendment 2026-11-10 10:30Z — repairs from the full code review (no change to the rule's terms)

Found by review, fixed in the build started 2026-11-10 after 10:16Z. They make the code do what this document says:

- The gap floor is compared on the rounded gap. `0.61 - 0.55 >= 0.06` is false in binary floats, so about a quarter
  of exactly-6.0c gaps were skipped; they now trade, as "6c+" always said.
- A sweep is refused when its Polymarket quote is over 5 s old, and the engine refuses, before the POST, an order
  still queued 2 s after its gap was seen (one fill on 11-03 went out 27.8 s late, another on a 14.6 s old quote).
- The window ledger only rolls forward, and a pass that outlives its window no longer adjusts the next window.
- The ladder now gives lead-lag a lifetime floor (twice the stage stop, across every re-base). An earlier amendment
  here said that floor was "unchanged"; for this arm it had never existed.
- Orders name their exchange shard, which Kalshi's sharding guide says avoids a routing delay.
- The ReadRunner ends a read still WAITing at its final date as INCONCLUSIVE. `leadlag-weekday` (final 2026-11-02)
  instead FAILED on 11-09 and switched weekdays off; the operator re-enabled them at one contract on 11-10.

Looked at, not changed (slices of 1,418 fills; leads only): fills with a Polymarket socket top 5 s or older
(77 fills, -13.6c); gaps where Kalshi moved and Polymarket did not (222 fills, -$21.50); event-speed gaps (negative
after fees at every size, 26 days) and resting orders (-15c per simulated fill) are not worth building.
