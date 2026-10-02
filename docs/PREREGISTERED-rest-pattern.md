# Pre-registered test: market-maker rest patterns (Kalshi)

Registered 2026-10-02 by the daily maintenance session, BEFORE the arm placed a single order
(`restPatternEnabled` ships `false`; the ladder promotes it to tiny-live on its next hourly
tick). Nothing below may be changed after the first fill. If the rule needs redefining, the
redefinition is written here with a date and scoring restarts from that date.

Build-queue item **8(c)** in `docs/BACKLOG.md` ("market-maker rest patterns — join the side whose
resting depth just doubled"). Its own gating note: *"build (c) only if MR v3 shows fills and a
positive checkpoint."* Both held on 2026-10-02: `kalshi-mean-reversion` is tiny-live with **42
settled trades, +$4.75, +8.85c/contract, 80% band [+2.79, +14.90]** — fills, and a checkpoint
(bar 40) that is positive with 80% confidence. That is the trigger, recorded here so the reason
the arm exists is not re-derived later.

## Why this exists

Two measurements, both already in hand, and they disagree in a way that names this arm's seat.

1. The move audit (`docs/reports/backtest-move-audit-2026-09-08.md`, 41,779 qualifying moves)
   priced a **maker resting on the reverting side** at **+3.6c to +5.3c per contract** at the last
   price, against a taker seat at the price actually paid of roughly **zero to −6c** across every
   price bucket. The seat, not the direction, is where the figure lives.
2. The GWU paper on Kalshi's own data (Bürgi, Deng & Whelan 2026, 313,972 contracts) puts makers
   at −9.6% against takers at −31.5% after fees.

Both say the same thing: on this venue the money is in being rested for, not in crossing. What
neither says is **when** to rest, and that is the gap this arm tests. A maker who doubles a
resting bid has committed to being filled at that price. Depth arrives before the print, so the
commitment is observable for free — no fee, no information purchase. Item 8c's one-line rule is
exactly that: *join the side whose resting depth just doubled.*

The reason to doubt it is specific. A doubling can be a market maker widening inventory in both
directions, a single large order that will be pulled in seconds, or (worst) the other side of
toxic flow about to arrive — `flowMonitor`'s whole premise is that one-sided flow predicts maker
losses. The refusals below are aimed at those three.

## The rule (fixed)

**Universe.** The Kalshi main trader's normal scan universe, minus in-play sports (the existing
`calm` filter: sports markets within 6 h of close never reach any book strategy).

**Depth.** Dollars resting at the **top three levels** of one side, `Σ price × size` — the same
measure `bookSignals` already uses, so the two book arms cannot disagree about what depth means.
Bids rest under YES; asks rest under NO.

**History.** One sample per market per scan, recorded **unconditionally** (armed or not), kept for
**20 minutes** (`restPatternWindowMinutes`). The arm's flag gates the signal, never the
observation: evidence that only begins accruing when an arm is armed cannot answer the question
that armed it (the mistake backlog 64 recorded, when a 180-row rolling buffer erased the cohort a
read was waiting for).

**Baseline.** The **median** of the samples strictly before the current one, inside the window. A
median and not the previous sample, so one scan that caught a book mid-refresh cannot manufacture
a doubling on its own. At least **3** baseline samples are required.

**Fire when**, on exactly one side: current depth ≥ **2 ×** its own baseline
(`restPatternMinMultiple`) **and** current depth ≥ **$25** (`restPatternMinSideDepthDollars`).

**Refusals** (each one is an assertion in `scripts/tests/review-fixes.test.ts`):

- **Both sides doubled → no signal.** That is liquidity arriving in the market, not a maker
  taking a side, and it carries no direction.
- **A zero baseline cannot be doubled.** A side that was empty and now rests is a new book, not a
  maker adding to a seat it already held.
- **A doubled but small wall is noise** — hence the $25 floor; a doubled $2 bid is two contracts.
- **Horizon: 6 h to 24 h to close**, read from the mean-reversion config rather than carrying a
  second copy of the same fence. In-play books churn; a near-settled book is pinned.
- **Price band 15c to 85c.** Below and above, a move is usually the market resolving.
- **A current sample older than the window is not the current book** and is refused.

**Side.** Join the grown side: a doubled **bid** buys **YES**, a doubled **ask** buys **NO**.

**Execution.** **Maker rest**, post-only, inside the spread — the seat the +3.6c-to-+5.3c figure
approximates. This is enforced in code (`makerEntryFor`), not by the `makerStrategies` list,
because that list is persisted per install and a new entry in the defaults does not reach an
existing config (BACKLOG 264, measured on this machine the day this was written). A taker version
of this arm is a different hypothesis and is not registered here.

**Exit.** **Hold to settlement.** `rest-pattern` is in `holdsToSettlement`, so no take-profit,
stop-loss, reversal or max-hold exit applies. Exits are what killed momentum and sold nine
consensus positions minutes after entry.

**Size.** The ladder's micro size, one notch, through `GENERIC_STRATEGIES`. No size, limit or arm
setting is touched by this registration.

**Grading.** The app's per-strategy calibration ledger under the key `rest-pattern`: net cents per
contract **after fees**, clustered by day and by event. The venue ledger
(`scripts/venue-pnl.py`) is the record of truth where the two disagree.

## The gate (fixed)

The ladder judges it under the standing rule: micro size, a checkpoint every 20 settled trades,
scale up on making money with 80% confidence, stop on losing with 80% confidence, hard stop at
−$5 per size notch, cool-down and retry after a stop.

Two stops are added here because the ladder cannot see either one:

- **Hard money stop: −$6 realized** on the arm, ungated by the cluster floor.
- **No-flow deadline: 2026-11-02.** Fewer than **20 settled contracts** by that date stops the arm
  for lack of flow, and that is recorded as a *different finding* from lack of edge. A maker
  arm that is never filled has measured the market's willingness to cross to it, which is worth
  knowing and is not evidence about the seat's profitability. This clause exists because
  `kalshi-dutch` has sat armed for 26 days with **zero** settlements and the ladder's stop rule
  cannot reach it (BACKLOG 261): a cohort that never fills never checkpoints, for ever.

The pre-registered **prediction**, so that the result can be wrong:

> The mean net after fees over the first 20 settled trades is **positive**, and the 80% band's
> lower bound is above **−3c** per contract.

Stopped at its first checkpoint with a mean below −3c → the rest-pattern hypothesis is treated as
tested and failed on Kalshi, it goes to the declined list in `docs/BACKLOG.md`, and it is not
re-proposed without new out-of-sample evidence.

## Known weaknesses, written down before the data

1. **Scan cadence, not book cadence.** The baseline is sampled once per scan (tens of seconds to
   minutes apart), so "just doubled" means "doubled since the last scan", not since the last
   book frame. A doubling that appears and is pulled between two scans is invisible, and one that
   is pulled a second after a scan looks real. The WebSocket book (section 172) could tighten
   this later; doing so would be a new version with a new scoring date, not a correction.
2. **The thresholds are not tuned.** 2×, $25, 3 samples, 20 minutes come from item 8c's
   one-line rule plus the existing `bookMinSideDepth` scale. They are not a grid search on this
   data, and tuning them after seeing results would void this registration.
3. **Adverse selection is the whole risk and is not measured in advance.** +3.6c-to-+5.3c is a
   ceiling at the last price; the doubled side may be resting precisely because it is about to be
   run over. If the arm fills and loses, that is the most likely reason, and the grading is
   day- and event-clustered for it.
4. **Correlated fills.** Several strikes of one crypto or weather ladder can double together; the
   clustering is the defence, and the ladder's long-horizon cap bounds the slot count.
5. **It may never fill.** A post-only rest joining a side that just doubled is behind that depth
   in the queue. See the no-flow deadline.

## Code

- Rule: `restVerdict`, and the bounded `DepthHistory`, in `src/main/strategies/restPattern.ts`
  (pure, unit-tested — 24 assertions in `scripts/tests/review-fixes.test.ts`).
- Scan: `recordRestDepth` (unconditional) and `restPatternSignals` in
  `src/main/strategies/autoTrader.ts`; wiring in `computeSignals`.
- Maker seat: `makerEntryFor` in the same file, enforced in code.
- Config: `restPatternEnabled` (false), `restPatternMinMultiple` (2),
  `restPatternMinSideDepthDollars` (25), `restPatternWindowMinutes` (20); the horizon band is
  `meanReversionMinHoursToClose` / `meanReversionMaxHoursToClose`.
- Ladder arm: `kalshi-rest-pattern` in `GENERIC_STRATEGIES` (`src/main/ladder/ladder.ts`); the
  21→22 arm-count drift alarm in `scripts/tests/adversarial.test.ts` is updated with it.
