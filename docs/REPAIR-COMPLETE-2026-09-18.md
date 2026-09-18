# Oracle Trader - Fee Model Repair: Complete Handoff

**Date:** 2026-09-18
**Scope:** the Kalshi fee model, its call sites, and the defects raised in
`AUDIT-CODE-API-STRATEGY-2026-09-18.md` and `AUDIT-REVIEW-VERIFICATION-2026-09-18.md`.
**Code altered:** yes - this document describes applied changes, not proposals.
**Rollback:** complete pre-change copies of all 12 touched files are in
`backups/_repair_20260918/` (see Part G).

---

## 0. Status summary

| | |
|---|---|
| Test suites | **16 / 16 pass** (13 `.test.ts` + 3 `.mjs`) |
| `tsc --noEmit` | **exit 0** |
| Manifold | **untouched**, out of scope by instruction |
| `amountPerTrade` | **left at 1** - the N1 fix is applied but stays dormant at C=1, by design |
| Kill-switch exit bypass | **confirmed intentional**, now documented in code (N8) |
| New regression test | `scripts/tests/kalshi-fee.test.ts` (14 checks), wired as `npm run test:fee` |

Higher logic that depends on this work: **every fee number in the app now comes
from one function.**

---

## 1. Defect ledger

| ID | Sev | Defect | Location | Status |
|----|-----|--------|----------|--------|
| **N1** | **HIGH** | Fee divided by contract count twice in the promotion metric | `autoTrader.netCentsOf()` | **FIXED** |
| **N2** | **HIGH** | Six divergent fee implementations (one arithmetically wrong, one with no rounding at all) | 6 files | **FIXED** - canonical module |
| **N3** | MED | A *failed* series-fee lookup was cached as `mult: 1` for 24h, silently mispricing every fee on that series | `kalshi.applySeriesFees()` | **FIXED** |
| **D6** | MED | Three unguarded portfolio reads; one transient error blanked the snapshot | `engine.computePortfolio()` | **FIXED** |
| **N6** | LOW | `res.fee` is exit-side only - undocumented invariant | `autoTrader.closeTrade()` | **DOCUMENTED** |
| **N8** | n/a | Exits bypass the kill switch | `autoTrader.closeTrade()` | **CONFIRMED INTENTIONAL** + documented |
| **N7** | - | "Entry IOC at $1.00 unprotected" | - | **NOT A DEFECT** - `clamp01` caps at 0.99 |
| **N4** | - | "`ttl = 0` re-fetches 160 series every scan" | - | **DISPROVEN** - no `ttl = 0` exists |

---

## 2. Part A - Corrections to the earlier audit

These are findings in `AUDIT-CODE-API-STRATEGY-2026-09-18.md` that do **not**
survive checking. Recorded so nobody re-opens them.

**A1. Seven cited source files do not exist.** The audit attributes strategies,
line counts and trade statistics to `tradeFeed.ts`, `correlatedMarkets.ts`,
`manifoldCopy.ts`, `manifoldPaper.ts`, `settlement.ts`, `store/executionArchive.ts`
and `store/tradeLog.ts`. None exist anywhere under `src/`, `scripts/` or
`backups/`. The *strategies* described are real; the *module attributions* are not.
Treat every file-line citation in that audit as unverified.

**A2. D6 mis-states the blast radius.** The audit says `getAccount`/`getPositions`
are wrapped and only `getOpenOrders` is not. In fact **none of the three were
wrapped** (`engine.ts:473`, `:486`). Its recommended fix - wrap `getOpenOrders`
- would have left two calls able to kill the same handler.

**A3. S5 was already implemented.** The audit claims `leadLag.ts:700-704` gates on
a flat-cent `edgeC >= minEdgeC`. Those variables do not exist in the file;
lines 599-630 already compute `netCents = gapCents - kalshiTakerFeeCents(...)`
and gate on `clearsFees`. The proposed "420 free trades from re-scoring" upside
is void.

**A4. The `ttl = 0` anomaly does not exist.** The only TTL in `kalshi.ts` is
`24 * 3600_000`. The real problem was the *opposite* of the claim: a long TTL
combined with failure-poisoning (A5, below), not an over-eager refresh.

**A5. D1's "true fee" is the un-rounded *model* fee, not what is charged.**
`kalshi.ts:1354` and `autoTrader.ts:2586` look contradictory ("rounded up per
fill to $0.000001" vs "rounded up to the next cent"). They are the two halves of
Kalshi's documented mechanic: the model fee is computed to 6dp, then a
**rounding fee restores the account's balance precision** (a cent), with a fee
accumulator issuing rebates to prevent systematic overpayment. So the cent ceil
*is* what leaves the balance on a whole-cent order. The audit's "drop the cent
ceil entirely" is right for the EV gate and wrong for the accounting path.
Correct answer: two functions, which is what now exists.

---

## 3. Part B - The canonical fee model

**File:** `src/main/util/kalshiFee.ts` (213 lines, new)

### The rule

```
model fee (dollars)  = rate * C * P * (1 - P)
order fee (dollars)  = ceil_to_cent(model fee)          <- what the balance loses
per-contract (cents) = order fee * 100 / C
```

`rate` is `KALSHI_TAKER_FEE_COEF (0.07) * series multiplier`, or
`KALSHI_MAKER_FEE_COEF (0.0175) * multiplier` on `quadratic_with_maker_fees`
series. **Maker fee is exactly 0 on plain `quadratic` series** (`kalshi.ts:1430`).

### The three things that were being got wrong

1. **The ceil is on the ORDER TOTAL, not per contract.** This is the whole
   ballgame. Per-contract ceilling overstates the per-contract cost of any
   multi-contract order, and the error grows as size falls.
2. **`P * (1 - P)` is symmetric**, so passing the *outcome* price instead of the
   YES price is safe for a NO leg. The old code relied on this implicitly; it is
   now stated.
3. **A `1e-9` guard is required.** `0.07 * 4 * 0.5 * 0.5 * 100` evaluates to
   `7.000000000000001`, which ceils to 8 instead of 7. The guard was present in
   three of the six implementations and absent in two.

### Exported API

| Function | Returns |
|---|---|
| `kalshiOrderFeeDollars(rate, yesPrice, contracts)` | dollars, order-total ceil - **the cash-accurate figure** |
| `kalshiFeeCentsPerContract(rate, yesPrice, contracts)` | cents per contract |
| `kalshiTakerOrderFeeDollars(yesPrice, contracts, mult?)` | dollars, taker rate resolved for you |
| `kalshiTakerFeeCentsFor(yesPrice, contracts, mult?)` | exact cents/contract - **deliberately NOT re-ceiled** |
| `kalshiMakerOrderFeeDollars(...)` | dollars at the maker rate |
| `kalshiModelFeeDollars(...)` | the un-rounded model value (for display/analysis) |
| `kalshiTakerRate(mult)` / `kalshiMakerRate(mult)` | resolve coefficients, never return 0 or NaN |
| `kalshiNetEdgeCents(...)` | convenience edge helper |

### Residual open question (needs live data, not a code change)

Whether the effective charge is `ceil_to_cent(model)` or
`ceil_to_6dp(model)` followed by a balance-precision rounding fee is decided by
the *account's* precision, which `/portfolio/balance` does not expose. Proposal
**A5**: fetch one balance, buy 1 contract on a cheap `quadratic` series, read the
delta. If the delta is whole cents, the current model is exact. Until then the
cent ceil is the **conservative** choice (it never understates cash out).

---

## 4. Part C - Changes applied

All edits were made by exact-string substitution with a fail-loud
"exactly one match" assertion (`backups/_repair_20260918/patch.ps1`), preserving
each file's original line endings and non-ASCII bytes.

### C1. New canonical module

`src/main/util/kalshiFee.ts` - new file. Header documents all six prior
implementations and why they diverged.

### C2. N1 - the promotion metric (`autoTrader.ts`)

```diff
-  const feePerContract = kalshiOrderFeeCents(t.feeRate ?? 0, yesPx, C) / C
+  const feePerContract = kalshiFeeCentsPerContract(t.feeRate ?? 0, yesPx, C)
```

`kalshiOrderFeeCents` already returned a **per-contract** value; dividing by `C`
again understated the fee by exactly `Cx`.

**Why this mattered more than the cash:** `entryFeeDollars()` was already
correct, so **the money was always tracked right**. `netCentsOf()` feeds
`gradeEntry()` - the metric the promotion ladder ranks strategies on. The bias
was price-dependent, so the ladder systematically over-credited cheap-contract
strategies. Measured error:

| price | C | true round-trip fee | N1 claimed | understated by |
|---|---|---|---|---|
| 0.02 | 50 | 0.28c | 0.0028c | **50x** |
| 0.05 | 20 | 0.70c | 0.0175c | **20x** |
| 0.10 | 10 | 1.40c | 0.0700c | **10x** |
| 0.20 | 5 | 2.40c | 0.2400c | **5x** |
| 0.50 | 2 | 4.00c | 1.0000c | **2x** |
| 0.80 | 1 | 4.00c | 2.0000c | **1x (no-op)** |

**The error is exactly `Cx` and exactly zero at C=1.** At the current
`amountPerTrade = 1` with the fade arm's `>= 0.65` leg rule, every leg is C=1,
so the bug is currently *inactive* - but `DEFAULT_CONFIG.amountPerTrade` is 5, so
**it switches on the moment you scale**, and it switches on
differentially (cheap-leg arms inflate, the fade arm does not).

### C3. N1b - the migration (`autoTrader.ts`, config version 26 -> 27)

`netSum` / `netSq` / `byEvent` / `byDay` are running **sums**, so a contaminated
total cannot be repaired by filtering - an epoch timestamp cannot help. The only
honest option is a one-time clear, which is what migration **v27** does.

- Cleared: `netN`, `netSum`, `netSq`, `byEvent`, `byDay` per strategy.
- **Retained:** `n`, `brierSum`, `buckets` - these never touched the fee term, so
  hit rate and calibration survive.
- **Deliberately not touched:** `perfByStrategy` - that is the *cash* ledger, and
  `entryFeeDollars()` was always correct.
- Logs once: `[auto-trader] v27 fee-model fix: cleared net-cents evidence for N strategy(ies)`.

> **Note:** v26 was already taken (`meanReversionMaxHoursToClose`). The earlier
> plan in `REPAIR-PLAN-2026-09-18.md` says to add v26 - that would have
> collided and silently skipped the `meanReversionMaxHoursToClose` floor for
> anyone at version 25. Corrected to v27.

**Cost of the clear:** strategies that only ever traded C=1 lose valid-but-
unrecoverable evidence. Accepted deliberately - a metric that silently mixes two
fee bases is worse than one that restarts.

### C4. N2 - re-pointed all call sites

| File | Before | After |
|---|---|---|
| `engine/paper.ts` | `rate * shares * p * (1-p)` - **no ceil at all** | Kalshi branch -> `kalshiOrderFeeDollars`; other venues unchanged |
| `strategies/leadLag.ts` | `ceil(7*p*(1-p))` per contract, hardcoded 0.07, applied to a 3-contract sweep | `kalshiTakerFeeCentsFor(px, sweepSizeFor(pair.coin, cfg))` |
| `strategies/cryptoConvergence.ts` | `ceil(0.07*p*(1-p)*100)/100 * count` - also had **no float guard** | `kalshiTakerOrderFeeDollars(px, count)` |
| `strategies/dutchBook.ts` | `ceil(0.07*count*p*(1-p)*100 - 1e-9)/100` | `kalshiTakerOrderFeeDollars(px, count)` |
| `intelligence/candidatePacket.ts` | `ceil(rate*p*(1-p)*100)/100*100` | `kalshiFeeCentsPerContract(rate, p, 1)` |
| `venues/kalshi.ts` | declared its own `KALSHI_MAKER_FEE_COEF`; two `0.07 *` literals | imports + re-exports the canonical constants |
| `strategies/autoTrader.ts` | two `?? 0.07` fee fallbacks | `?? KALSHI_TAKER_FEE_COEF` |

**`paper.ts` was the most important of these** - it is the simulator that grades
strategies *before* live capital, and it modelled no rounding whatsoever, so it
was optimistic exactly at the promotion gate. It now branches on
`venue === 'kalshi'`; **Polymarket, Manifold, IBKR behaviour is byte-identical**.

`leadLag.ts` kept `kalshiTakerFeeCents(p)` unchanged (a test pins its 1-contract
values, which are correct) but it is now marked DEPRECATED for sizing.

### C5. N3 - fee-cache poisoning (`kalshi.ts`)

```diff
-} catch {
-  this.seriesFeeCache.set(s, { mult: 1, at: now })
-}
+} catch (err) {
+  if (!this.feeLookupWarned.has(s)) { this.feeLookupWarned.add(s); console.warn(...) }
+}
```

A failed `/series/{ticker}` lookup cached `mult: 1` for the full 24h TTL. One
transient 429 therefore froze that series' multiplier at 1x for a day - fees 2x
too high on the 0.5x S&P/Nasdaq series, and the maker-fee flag lost. Failures are
no longer cached, so the next scan retries; the operator is warned once per
series. The 20-series-per-scan cap is kept (it is a rate-limit guard) and now
self-heals over successive scans.

### C6. D6 - portfolio read resilience (`engine.ts`)

`getAccount`, `getPositions` and `getOpenOrders` are now inside one guarded read.
On failure the engine serves the **last good snapshot** from `portfolioCache` and
warns; if there is no last-good it rethrows. It deliberately does **not**
fabricate a zero-equity view - an empty position list when positions exist would
be worse than an error.

### C7. N6 / N8 - documentation only (`autoTrader.ts`)

- **N8:** `closeTrade()` carries a comment recording that the entry path consults
  `killSwitchCheck` and the exit path deliberately does not - so a tripped switch
  stops new risk without trapping an open position during testing.
- **N6:** the `closeTrade` pnl line records the invariant that `res.fee` is
  exit-side only and the entry fee is added back separately.

### C8. Tests

- `scripts/tests/config-migration.test.ts` - version assertion updated to 27, and
  **extended to actually cover v27**: seeds a state file with populated net
  accumulators at version 26, reopens, asserts the net fields are gone and
  `n`/`brierSum`/`buckets` survive.
- `scripts/tests/kalshi-fee.test.ts` - **new.** Pins the model, the multipliers,
  degenerate inputs, the float-dust guard, and the load-bearing invariant:

  ```
  entryFeeDollars(t) * 100 / C === the fee term inside netCentsOf(t)
  ```

  This fails at every `C > 1` under the old code. It also fails if someone
  "fixes" `entryFeeDollars` instead - the wrong-end-of-the-telescope mistake this
  bug invites.
- `package.json` - added `test:fee`.

---

## 5. Part D - Verified NON-defects (do not re-fix)

| Claim | Verdict | Evidence |
|---|---|---|
| Entry IOC can be an unprotected $1.00 market order (N7) | **False** | `clamp01` = `min(0.99, max(0.01, v))`, applied at `autoTrader.ts:2961-2962`. 0.99 is the max valid Kalshi price. |
| `limitPrice` for a NO leg is a sign error | **False** | `kalshi.ts:1080` documents `limitPrice` as **always the YES-leg price**; buying NO is selling YES, so `bids[0].price - 0.01` is correct. |
| `ttl = 0` causes a re-fetch storm (N4) | **False** | No `ttl = 0` exists anywhere. Only TTL is 24h. |
| `kalshiOrderFeeCents` is arithmetically wrong | **False** | It correctly returns per-contract cents. Its **name** and its displaced doc comment invited the misuse in `netCentsOf`. |
| `dutchBook` fee is wrong in shape | **False** | Each leg is a separate order, so a per-leg ceil is *correct* here. Only the hardcoded multiplier is a limitation. |
| `candidatePacket` fee is wrong | **False** | The packet declares `contracts: 1`, for which the value is exact. |

---

## 6. Part E - Not done, with specs

### E1. Quoter Tier-1 `/decrease` (the highest-value open item)

**Not implemented. This is an enhancement, not a repair, and it should not ship
without a live shadow period.** Spec, ready to build:

**The problem.** **The problem.** On plain-`quadratic` series the maker fee is **0**, so a resting
quote's P&L is pure adverse selection - there is no fee component to blame.
`quoter.ts:989` amends on
`Math.abs(existing.yesPrice - yesPrice) >= 0.03`, and `amendOrder` always sends
price **and** count (quoter.ts:991). Kalshi's docs - and the code's own comment
at `kalshi.ts:1138` - say a price change **forfeits queue position**; only a size
decrease preserves it.

**Evidence, from the quoter's own state file**
(`backups/20260905_audit_patch/quoter-kalshi.json`, the most recent snapshot in
the repo - the live file lives in the Electron userData dir): `placed: 1432`,
`amended: 793`, `canceled: 741`, `filled: 33.1`. So **55% of every quote ever
placed was amended** - the queue position was voluntarily surrendered more than
half the time - at a 2.3% fill rate.

> **Correction to my earlier report.** I previously cited a markout of -1.93c
> over n=1,083 for the quoter. **I could not substantiate that figure and it
> should be disregarded.** The -1.93 values in this repo are a *leadLag* cohort
> figure and a weather backtest, not the quoter. The quoter also records **no
> markout field at all** (`markWatch: []`), and the only arms carrying stats in
> the 2026-09-05 auto state are `fade` (markoutN 40, -0.325c) and
> `book-imbalance`. The quoter markout is therefore currently **unmeasurable** -
> which is itself the argument for the shadow instrumentation below.

Net effect:

- price *correct* -> you just amended to it -> **back of the queue** -> you fill
  only under heavy flow from informed takers;
- price *stale* -> you were resting there first -> **front of the queue** -> an
  informed taker lifts you immediately.

**The policy is therefore at the front exactly when wrong and at the back exactly
when right**, which produces a negative markout with zero fees, zero latency and
perfect self-knowledge. It is not a speed problem - faster polling makes it
*worse*, because you forfeit the queue more often. Which is why re-tuning
`quoterMinEdgeCents` never fixed it.

**The fix.** `POST /portfolio/events/orders/{order_id}/decrease` is decrease-only
and **preserves queue position**. Two tiers:

- adverse move ~1c -> `decrease` the **threatened side only**, in place, keeping
  the queue slot but cutting the notional that gets picked off;
- move >= 3c or crossed -> reprice as today, where forfeiting is correct because
  the price genuinely changed.

**Three implementation hazards:**

1. Use **`reduce_to`**, never `reduce_by` - the adapter retries, and `reduce_by`
   is not idempotent.
2. **Verify `count` semantics against Kalshi's docs first.** V2 `count` is total
   fillable = `already_filled + desired_remaining`. If `/decrease` shares that
   convention and you pass desired-remaining without adding `filledSoFar`, you
   over-shrink; at `reduce_to <= filledSoFar` the order completes, **silently
   turning Tier 1 into a full cancel and destroying the exact queue position the
   feature exists to protect.** This is the one thing to settle before building.
3. **Shadow first:** log intended decreases without sending; compare markout on
   the would-have-decreased cohort vs the rest. If both look alike, the trigger is
   firing at random and enabling it would only shrink good quotes.

Also note: gate on `feeType`. Maker fee is 0 on `quadratic` but
`0.0175 * mult` on `quadratic_with_maker_fees`, which changes the calculus.

### E2. D1 empirical settlement (Proposal A5)

One balance read, one 1-contract buy on a cheap `quadratic` series, read the
delta. Answers whether the cent ceil is exact. Gated on nothing now - the
canonical module makes it a one-file change if the answer is "no".

### E3. Manifold removal

Out of scope by instruction. For the record: `manifold` is in the `VenueId`
union, has a strategy dir, a venue adapter and tests. A rip-out touches the
`VenueId` union, `shared/types.ts`, the adapter registry and any Manifold rows in
the strategy tables. `paper.ts` was written to leave its behaviour unchanged.

### E4. Strategy re-evaluation (Phase 6)

After v27 clears the evidence, the ladder restarts from zero for every strategy.
That is the correct moment to re-score, and it needs a few days of live data, not
a code change.

---

## 7. Part F - Fee economics and strategy implications

This falls straight out of the corrected model and is, I think, the most
commercially useful result here.

### The per-contract fee is small on cheap contracts and huge in the middle

At the order sizes this app actually uses (`C = stake / price`), round-trip taker
fee per contract:

| price | C ($1 stake) | per-contract | **round-trip** |
|---|---|---|---|
| 0.02 | 50 | 0.14c | **0.28c** |
| 0.05 | 20 | 0.35c | **0.70c** |
| 0.10 | 10 | 0.70c | **1.40c** |
| 0.20 | 5 | 1.20c | **2.40c** |
| 0.35 | 3 | 1.67c | **3.33c** |
| 0.50 | 2 | 2.00c | **4.00c** |
| 0.65 | 2 | 2.00c | **4.00c** |
| 0.80 | 1 | 2.00c | **4.00c** |
| 0.90 | 1 | 1.00c | **2.00c** |
| 0.95 | 1 | 1.00c | **2.00c** |

Two consequences:

**(a) The fee peaks in the middle, in the unit that matters.** Edge on a
prediction market is a mispricing in *cents*, so the operative cost is the fee in
*ticks*. A taker strategy in the 0.35-0.85 band needs **more than 4 cents of edge
per contract** just to break even on a round trip. Cheap contracts (<= 0.10) pay
0.28-1.40c round trip, so a 4c dislocation nets 2.6-3.7c. This is why `leadLag`
works on cheap crypto contracts and why mid-priced taker arms struggle: **it is
not a model problem, it is the fee schedule.**

**(b) The `needle` and `quoter` arms were the ones N1 flattered most.** Because
N1's error was exactly `Cx`, and `C` is largest on cheap contracts, N1
over-credited precisely the cheap-contract arms (50x at C=50, 1x at C=1). It
amplified a real effect rather than inventing one - which is why it went
unnoticed.

### Recommendations

1. **Route taker flow by price band.** Below ~0.15 and above ~0.90 the taker fee
   is 2c or less round trip; between 0.35 and 0.85 it is 4c. Any taker strategy
   whose edge is 1-3c should simply not run in the middle band.
2. **Reserve the middle band for maker orders.** Maker fee is **0** on plain
   `quadratic` series. A resting order in the 0.5 band pays nothing; the same
   trade taken pays 4c round trip. That is an 8x cost difference on the same
   view, and it is the strongest structural argument for fixing the quoter (E1)
   rather than abandoning it.
3. **Check `feeType` before assuming free maker.** `quadratic_with_maker_fees`
   series charge `0.0175 * mult`. A maker strategy must know which it is on.
4. **Prefer fewer, larger orders on the same series** where the tick cost allows
   it: the order-level ceil amortises, so doubling size never doubles the fee.
   (Small effect at low prices - the % of stake is nearly flat - so treat this as
   a tie-breaker, not a strategy.)
5. **Re-rank the ladder after v27 on the *tick* view, not the win rate.** Two
   strategies with equal hit rate can differ by 3c/contract purely by price band.
6. **Consider a per-strategy minimum-edge floor derived from the table** rather
   than one global threshold: the required edge is a function of the price band it
   trades.

---

## 8. Part G - Backups and rollback

**Location:** `G:\PROJECTS\oracle-trader\backups\_repair_20260918\`
(mirrors the repo's relative paths; also holds `patch.ps1` and `blocks/`, the
edit tooling).

| File | before -> after (lines) | backup bytes |
|---|---|---|
| `package.json` | 59 -> 60 | 2639 |
| `scripts/tests/config-migration.test.ts` | 29 -> 74 | 1500 |
| `src/main/engine/engine.ts` | 801 -> 828 | 37079 |
| `src/main/engine/paper.ts` | 234 -> 249 | 8008 |
| `src/main/intelligence/candidatePacket.ts` | 19 -> 24 | 2163 |
| `src/main/strategies/autoTrader.ts` | 5040 -> 5102 | 246901 |
| `src/main/strategies/cryptoConvergence.ts` | 482 -> 495 | 20702 |
| `src/main/strategies/dutchBook.ts` | 381 -> 394 | 14199 |
| `src/main/strategies/leadLag.ts` | 800 -> 811 | 35993 |
| `src/main/venues/kalshi.ts` | 1635 -> 1657 | 71886 |
| `src/main/strategies/quoter.ts` | **unchanged** | 56065 |
| `src/shared/types.ts` | **unchanged** | 12893 |

`quoter.ts` and `shared/types.ts` were backed up defensively but **never
modified** - they can be ignored.

**Rollback:** copy the backup over the live file. There is no git repository in
this project, so these copies are the only history - do not delete them.

**New files (nothing to roll back to):** `src/main/util/kalshiFee.ts`,
`scripts/tests/kalshi-fee.test.ts`.

---

## 9. Part H - Verification log

Baseline captured before any edit, re-run after every change.

```
npx tsc --noEmit                     -> exit 0   (before and after)

review-fixes        ok      ladder              ok      adversarial     ok
risk-controls       ok      ibkr                ok      ibkr-execution  ok
ibkr-lab            ok      remaining-defects   ok      completion      ok
model-usage         ok      config-migration    ok      poly-paper      ok
kalshi-fee          ok (new)
execution-quality.test.mjs ok   collection-integrity.test.mjs ok
settlement-accounting-regression.mjs ok
                                     -> 16/16, 0 failures
```

The `config-migration` suite is the one that catches the v27 block; it printed
`[auto-trader] v27 fee-model fix: cleared net-cents evidence for 1 strategy(ies)`
- the second seeded strategy had no net fields and was correctly skipped.

### Two errors I introduced and caught

Recorded because they are the failure modes this codebase invites:

1. **A patch anchor consumed the line after it.** My first v27 edit used
   `this.persist(26)\n    }\n  }` as the anchor and my replacement did not
   reproduce those lines, so the v26 block lost its `persist(26)` and closing
   brace. Caught by reading the result, not by trusting the "OK". Fixed by
   restoring both lines.
2. **My own canonical module re-introduced the bug it exists to kill.**
   `kalshiTakerFeeCentsFor` initially re-ceiled the per-contract value to a whole
   cent, turning 0.33c into 1c - i.e. restoring the exact 3x overstatement on a
   3-contract sweep. Found while wiring `leadLag` and fixed there.

Both are why every change was verified by re-reading the region and re-running
the suite, rather than by trusting the edit script's success message.

---

## 10. Part I - Tooling gotchas for the next agent

1. **`npx tsc` can hang for minutes** (network resolution). Use
   `node node_modules/typescript/bin/tsc --noEmit` - 2.3s.
2. **`node` inherits the *PowerShell location*, not `[Environment]::CurrentDirectory`.**
   Relative tool invocations silently resolve against the wrong cwd; `cd` first
   or use absolute paths.
3. **This repo has mixed line endings** - `autoTrader.ts`, `paper.ts`, `leadLag.ts`
   and `kalshi.ts` are LF; `engine.ts`, `cryptoConvergence.ts`, `dutchBook.ts`
   and `candidatePacket.ts` are CRLF. Anchors must match the file's own EOL or
   they will silently fail to match.
4. **Any editor that writes CRLF will diff the whole file.** The two files
   rewritten here were normalised back to their original convention.
5. **`Compare-Object` is not a diff** - on comment-heavy blocks it reports
   phantom `+ /**` lines. Verify by reading the region.
6. **`R` is an alias for `Invoke-History`** in PowerShell - do not name a helper
   function `R`.
7. **Grep returns only the first matching line per file.** Use
   `Select-String` (or `Get-ChildItem | Select-String`) for complete line lists.
8. Existing in-repo cruft, untouched: `scripts/fix-adapter.mjs`,
   `scripts/fix-convergence.mjs` (one-off patch scripts), and a dangling doc
   comment above `clusterDayOf`.

---

## 11. Part J - Open questions for you

1. **`amountPerTrade` back to 5?** The N1 fix is in but stays dormant at C=1. At
   C=5+ it is live and the ladder's ranking changes. I would let v27's cleared
   evidence accumulate for a few days at $1 first, then step up - so the
   promotion decisions are made on clean evidence at the size you intend to run.
2. **Kill-switch exits:** confirmed intentional and now documented. If you ever
   want it *configurable* (flatten-on-trip vs block-all) that is a small change,
   but I left behaviour exactly as you have it.
3. **Settlement-fee assumption:** `paper.ts` charges no fee at settlement,
   matching Kalshi. Worth one live confirmation, as it is a silent input to every
   paper result.
4. **The `/decrease` `count` semantics** (E1 hazard 2) - the one thing I would
   resolve from Kalshi's docs before anyone builds Tier 1.
5. **Approve `Quoter` shadow instrumentation?** If you want the cohort
   measurement from E1 before committing to the feature, that is a self-contained
   next task with no live order mutation.

---

## Appendix - what "done" means here

- One fee formula in the codebase, with two tested entry points for the two
  distinct questions (what does cash lose / what is the per-contract edge).
- The promotion metric no longer rewards price band.
- A failed fee lookup can no longer bake a wrong multiplier into prices for a day.
- A transient venue error can no longer blank the portfolio.
- The two "fixes" that would have created new bugs (unwrapping only
  `getOpenOrders`; dropping the cent ceil from the accounting path) are recorded
  so they are not attempted again.
- The four false leads (N4, N7, and the two limit-price suspicions) are recorded
  as verified-correct, with evidence.
