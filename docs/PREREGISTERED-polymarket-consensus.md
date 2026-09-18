# Pre-registration — Polymarket smart-money consensus, on Kalshi, at micro size

Written 2026-09-13 by the daily maintenance session. This is step 1 of build-queue item 13
(`docs/BACKLOG.md`), which the 2026-09-12 session triggered but could not finish in one run. It fixes the
entry rule, the size, the caveats and the stop **before** the arm exists, so that the arm cannot later be
tuned to its own results.

## Signal

`scripts/polymarket_consensus.py` (hourly, Windows task `OracleTrader-PolyConsensus`, read-only, running
since 2026-09-08) watches the top-100 lifetime-profit Polymarket wallets. It emits a signal when **>= 3 of
them are on the same side of the same market within 48 h**, records the side, the price at signal and the
lead time, matches the market to a Kalshi or Polymarket US market with the Metaculus/anchor matcher, and
grades it on Polymarket's own resolution.

## Evidence as of 2026-09-13 (the trigger reading)

`python scripts\polymarket_consensus.py report`: 4,221 signals, 3,418 graded, hit rate **0.70** at a mean
price of **0.69**, Brier **0.0940**.

Net per contract, day-clustered (t on G-1 df, the round-73 correction), computed over
`data/polymarket-consensus/grades.jsonl`:

| priced at | n | days | mean | 95% |
|---|---|---|---|---|
| Kalshi ask, net of the taker fee | 584 | 6 | **+6.64c** | **[+2.06, +11.23]** |
| Polymarket US price, net of fee | 518 | 6 | +5.67c | [-0.58, +11.91] |
| Polymarket price (all graded) | 3,418 | 6 | +0.71c | [-0.22, +1.63] |

The pre-registered trigger in backlog item 13 — ">= 100 graded signals, net positive after fees at the
price we could have acted on" — is met, and on Kalshi the day-clustered interval excludes zero.

### The three caveats, recorded here rather than argued away

1. **Only Kalshi clears its own bar today.** On 2026-09-12 the PolyUS band excluded zero
   ([+0.77, +11.08]); one day later it does not ([-0.58, +11.91]). **This arm is Kalshi-only.** PolyUS is
   not pre-registered and does not get an arm on this reading.
2. **Clustering by category, not day, widens Kalshi to [-0.54, +13.83] — it includes zero.** 1,100 of
   3,418 graded rows are `btc` and 563 are `highest`. The edge is not evenly spread and may be a
   property of a few families rather than of consensus.
3. **Six signal days.** The shadow began 2026-09-08 and only graded anything from 2026-09-12, when the
   Gamma `closed=true` bug was fixed. Nothing here has survived a regime change.

Under the operator's standing rules the answer to caveats 2 and 3 is a real-money arm at micro size that the
ladder can stop — not another week of paper. That is what this pre-registers.

## Entry rule (fixed)

- **Venue:** Kalshi only.
- **Trigger:** a consensus signal from the shadow, **not yet acted on**, whose Kalshi match is still open.
- **Freshness:** the signal is at most **24 h** old and the market is at least **6 h** from close. The
  measured edge is a lead-time effect (mean lead 36 h); a signal read after the market has caught up is
  not the thing that was graded.
- **Price:** enter at the **Kalshi ask** on the consensus side, which is the price the +6.64c was
  measured at. No maker seat, because a maker seat was not what was graded.
- **Refuse** if the ask is above **0.90** or below **0.10** (the graded mean price is 0.69; the tails are
  where the fee and the rounding eat a 6c edge whole), or if the Kalshi ask has already moved **more than
  10c** past the Polymarket price at signal.
- **Size:** micro — the ladder's `tiny-live` stake, one notch, exactly like every other new arm. It goes
  on the ladder through `GENERIC_STRATEGIES` as `{ id: 'kalshi-consensus', venue: 'kalshi',
  key: 'consensus', flag: 'consensusEnabled' }`. **Never** through the arm, size or limit settings.
- **One entry per market**, and at most **one open position per Polymarket source market**, so a single
  consensus event cannot become five correlated positions.
- **Hold to settlement.** The grading was hold-to-resolution; an exit rule would be a different strategy.

## Stop rule (fixed)

The ladder's standard `tiny-live` stage stop applies unchanged and fires first. In addition, judged on
the venue ledger (settlements, netted as `scripts/venue-pnl.py` nets them):

- Judge only once **>= 40 settled contracts** across **>= 5 day-clusters**.
- **Day-clustered 95% upper bound < 0** → stop the arm, cool-down 14 days, and record that the shadow's
  +6.64c did not survive contact with our own fills.
- **Day-clustered 95% lower bound > 0** → the ladder's own checkpoint promotes it; nothing extra.
- Hard money stop, ungated by the cluster floor (the momentum precedent, 2026-09-13): **-$8 realized**
  stops the arm immediately regardless of sample size.
- **Deadline:** if fewer than 40 contracts have settled by **2026-10-13**, the arm is stopped for lack of
  signal flow, not for lack of edge, and the distinction is recorded.

The number that would falsify this is stated plainly: the shadow says +6.64c/contract at the Kalshi ask.
Our own fills pay the same ask plus slippage. If the arm's own settled net per contract is negative over
40 contracts and 5 days, the shadow measured something our execution cannot reach.

## Build state (2026-09-13)

**Not built.** The signal source does not exist in the app: no TypeScript reads
`data/polymarket-consensus/` (checked — no file under `src/` references any shadow data directory). The
work is a `consensusSignals()` reader following the existing pattern at
`src/main/strategies/autoTrader.ts:1619-1620` (`if (this.config.xEnabled) out.push(...this.xSignals(...))`),
a `consensusEnabled` flag in `src/shared/ipc.ts` and the trader's defaults, the strategy-key mapping at
`autoTrader.ts:557`, the `GENERIC_STRATEGIES` entry, and tests.

It was not started today because `autoTrader.ts` (231 KB) was being edited by another Claude session in
the same hour (round 92, built 11:00:14Z), and because step 4 forbids starting work that cannot be
finished and verified in the same run. Carried in `docs/BACKLOG.md` item 13 as tomorrow's first build,
with the injection point above already identified so the next session does not re-derive it.

## Amendment 2026-09-14 13:55Z (round 96), before day 1 closed

Day 0 showed the arm's throughput is bound by the trader's shared long-horizon slot cap (4), which resting
volume-spike orders can fill, and by its own first position: a market closing in 202 days
(KXNCAAMBUAC-27-EKY, 4.55 contracts at 21c) that cannot settle before the 2026-10-13 deadline and holds a
slot for the whole test. Two changes, both throughput, neither a change to how a signal is priced or graded:

- **Horizon ceiling:** `maxHoursToClose` = 504 (21 days), refusal `too-far`. Every entry from now on can
  settle inside the window. The shadow's grading universe had no ceiling; entries beyond 21 days are a
  different, slower hypothesis and are simply not part of this test.
- **Reserved slots:** `consensusExtraLongSlots` = 2 on top of `maxLongHorizonPositions` (4), used only by
  this arm. Other arms keep the shared cap of 4.

The stop rule, the 40-contract / 5-cluster judgment, the -$8 hard stop and the deadline are unchanged. The
open 202-day position is held to settlement as the rule says; it is excluded from nothing and counts for
nothing until it settles.

## Amendment 2026-09-15 06:45Z (round 97): the build now does what this document already said

"Hold to settlement" (rule above) was not implemented: `manageExits` in `autoTrader.ts` exempts a fixed list
of strategies from take-profit / stop-loss / pre-close / max-hold / reversal exits, and `consensus` was not on
it. With the trader's defaults (take-profit 5%, stop-loss 10%) the arm sold nine positions on 2026-09-14,
most within 0-13 minutes of entry, several on in-play soccer and tennis prices. Nine of the arm's first
fourteen settlements on the venue ledger are these round trips (venue-true -$3.01 on 09-14), and none of
them measured the hypothesis this document registered. Fix: the list moved into the exported pure function
`holdsToSettlement()` with `consensus` added; tests assert it and a mutant without the line fails them.

For grading: count only positions entered at or after the restart on the round-97 bundle (2026-09-15) toward
the 40-contract / 5-cluster judgment. Positions sold early before that are recorded here and excluded; they
are neither wins nor losses of the registered rule. The -$8 hard money stop still counts every dollar.
