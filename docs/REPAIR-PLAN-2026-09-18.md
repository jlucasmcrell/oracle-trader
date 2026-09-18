# REPAIR PLAN & NEW-CAPABILITY PROPOSAL  oracle-trader

**Date:** 2026-09-18
**Companion to:** `AUDIT-REVIEW-VERIFICATION-2026-09-18.md` (verification of the 2026-09-18 code/API/strategy audit)
**Status:** PLAN ONLY. No code was altered in producing this document.
**Audience:** a developer or a frontier LLM working unsupervised. Every step names exact files, line numbers, the change, the acceptance test, and what NOT to do.

---

## 0. Read this first  corrections to the verification review

Three claims in the companion review are refined here after reading the actual function bodies. **Use these numbers, not the earlier ones.**

### 0.1 `kalshiOrderFeeCents` returns PER-CONTRACT cents (the doc comment is misleading, the code is right)

`src/main/strategies/autoTrader.ts:4894`

```ts
export function kalshiOrderFeeCents(feeRate: number, yesPrice: number, contracts: number): number {
  if (contracts <= 0 || feeRate <= 0) return 0
  const feeDollars = Math.ceil(feeRate * contracts * yesPrice * (1 - yesPrice) * 100 - 1e-9) / 100
  return (feeDollars * 100) / contracts          // <-- amortised back to per-contract
}
```

It ceils at **order** level (correct per Kalshi's model) then divides by `contracts`, so it returns **cents per contract**. The doc comment at 4736 opens "Kalshi taker fee per contract, in cents" and then describes an order-total ceil; both halves are true and the juxtaposition reads as a contradiction. It is not one. **Do not "fix" this function.**

Consequence for the three call sites:

| Site | Expression | Verdict |
|---|---|---|
| `2557` fade EV gate | `feeCents = kalshiOrderFeeCents(rate, yesExec, contracts)`, subtracted from a per-contract edge at `2560` | **CORRECT** |
| `4748` `entryFeeDollars` | `kalshiOrderFeeCents(...) * C / 100`  order-total dollars | **CORRECT** |
| `4753` `netCentsOf` | `kalshiOrderFeeCents(...) / C`  divides a per-contract value by C again | **BUG (N1)** |
| `4851` | `kalshiOrderFeeCents(rate, yesPx, 1)` | **CORRECT** |

So **N1 is exactly one line: `autoTrader.ts:4753`.** Cash accounting (`3669`, `3684`, `3761`, all via `entryFeeDollars`) is correct. The corrupted path is `netCentsOf`  `gradeEntry` (`3750`, `3763`)  `calib.byStrategy[].netCents/netSum/netSq`  `clusteredNet`  **ladder promotion/demotion and the nightly parameter retune.**

### 0.2 There are FIVE divergent Kalshi fee implementations, not four

| # | Location | Formula | Ceil? | Uses `mult`? | Uses C? |
|---|---|---|---|---|---|
| 1 | `strategies/autoTrader.ts:4894` `kalshiOrderFeeCents` | order-level ceil, amortised per contract | **order** | yes (via `feeRate`) | yes |
| 2 | `strategies/leadLag.ts:32` `kalshiTakerFeeCents(p)` | `ceil(7p(1p))` | **per contract** | **NO  hardcoded 0.07** | no |
| 3 | `strategies/cryptoConvergence.ts:104` `calcTakerFee(p,n)` | `ceil(0.07p(1p)100)/100  n` | **per contract** | **NO  hardcoded 0.07** | linear |
| 4 | `engine/paper.ts:233` `feeFor(rate,shares,price)` | `ratesharesprice(1price)` | **NONE** | yes | linear |
| 5 | `strategies/dutchBook.ts:202-203,262,285` | accumulates `totalAskFee`/`totalBidFee` per leg | per leg |  |  |

`venues/kalshi.ts:1355` sets `feeRate = 0.07 * mult` and `1408` sets `makerFeeRate = KALSHI_MAKER_FEE_COEF * mult`. So the series multiplier **is** available on the market object. Implementations 2 and 3 hardcode `0.07` and are therefore **wrong for every series with `mult = 1`**, independent of the ceil question.

Direction of the divergences matters:

- **#4 (`engine/paper.ts`) has no ceil at all**  it *understates* fees. This is the simulator that grades a strategy **before** the ladder promotes it to live capital. Optimistic bias sits exactly at the promotion gate.
- **#2 and #3 ceil per contract**  they *overstate* fees for C > 1 (conservative), and are flatly wrong when `mult = 1`.
- **#1 is the reference.**

### 0.3 N1 magnitude  honest numbers

Understatement factor is exactly **C**, where `C = Math.max(1, Math.round(t.shares))` (actual filled contracts). Computed from the real function:

| leg cost | C at `amountPerTrade=1` | C at `amountPerTrade=5` | true fee/ct | recorded fee/ct (apT=5) | error |
|---|---|---|---|---|---|
| 0.900 | 1 | 5 | 0.8000 | 0.1600 | 0.6400 |
| 0.650 | 1 | 7 | 1.7143 | 0.2449 | 1.4694 |
| 0.500 | 2 | 10 | 1.8000 | 0.1800 | 1.6200 |
| 0.300 | 3 | 16 | 1.5000 | 0.0938 | 1.4063 |
| 0.100 | 10 | 50 | 0.6400 | 0.0128 | 0.6272 |
| 0.042 | 23 | 119 | 0.2857 | 0.0024 | 0.2833 |

Two properties make this worth fixing even though each error is sub-cent-to-~1.6:

1. **It is exactly zero at C=1.** At the current live setting (`amountPerTrade = 1`, forced by migration v18) the *fade* arm is unaffected  its legs are  0.65 by rule (`fadeLongshotMaxPrice = 0.35`, `fadeFavoriteMinPrice = 0.82`), so `floor(1/0.65) = 1`. **`DEFAULT_CONFIG.amountPerTrade` is 5.** The moment sizing is scaled up  which is the whole point of a profitable ladder  the bug switches on across every arm.
2. **It is differential, not uniform.** Cheap-leg strategies (ratchet buying NO at 4.2  C=23; consensus buying YES  0.30  C3) are inflated; expensive-leg strategies (fade) are not. The ladder ranks arms *against each other* on `netCents`. A bias that hits some arms and not others distorts the ranking itself, which is the promotion decision.

**Severity HIGH is about leverage and about scaling, not about today's dollar error.** Say so plainly in any commit message; do not oversell it.

---

## 1. Ordering principle

> **Fix measurement before behaviour. Never change both in one commit.**

Almost every downstream decision in this app  ladder promotion, nightly parameter retune, the clustered-CI stop gates, the kill switch's netCents threshold  reads `calib.byStrategy[].netCents`. That statistic is currently computed two different ways in five places, one of which is arithmetically wrong and one of which has no rounding at all. Any strategy work done before that is fixed produces evidence that cannot be trusted and cannot be compared to evidence gathered after.

Corollary: **behaviour-changing fixes that do not touch metrics can run in parallel** on a second track. Phase 3 below is independent.

### Dependency graph

```
Phase 0  freeze evidence  
                                       
Phase 1  canonical fee module  Phase 2  N1 one-liner + epoch  Phase 6  strategy re-eval
          (util/kalshiFee.ts)                      
                                                    Phase 4  D1 empirical alignment (A5)
Phase 3  robustness (PARALLEL) 
          D6 / N8 / N6 / N7

Phase 5  decrease-order-v2   requires Phase 1+2 landed (needs a clean markout baseline)
```

---

## 2. Phase 0  Freeze the evidence (no code change, ~15 min)

**Why first:** `calib` **survives `reset()`**  `doReset` explicitly carries it forward (`fresh.calib = this.state.calib`). There is no UI path that clears it. Once Phase 2 changes the basis of `netCents`, the pre-fix numbers are unrecoverable unless snapshotted now.

**Do:**
1. Copy `config.json` (the live one, under the Electron `userData` dir  locate via `app.getPath('userData')`; the repo copy is a template) to `docs/evidence/2026-09-18-pre-fee-fix/config.json`.
2. Copy the `episodes` JSONL archive(s) to the same folder.
3. Emit a table of `calib.byStrategy[]`  `{key, n, wins, netN, netCents, netSum, netSq, events, days}` and save as CSV. This is the baseline every later claim is measured against.
4. Note that `tmp/review-baseline/src/` already exists as a source snapshot  confirm whether it is current before relying on it.

**Acceptance:** the CSV reproduces the `netCents` values currently shown in the ladder UI.

---

## 3. Phase 1  One canonical fee module (N2)

**Goal:** a single source of truth, so that Phase 4 (the D1 alignment question) is a one-file change instead of five.

### 3.1 Create `src/main/util/kalshiFee.ts`

`src/main/util/` already holds `alert.ts`, `http.ts`, `kelly.ts`  this is the right home.

```ts
/** Kalshi fee, order-level cent ceil, amortised to per-contract cents. THE reference. */
export function kalshiFeeCentsPerContract(feeRate: number, yesPrice: number, contracts: number): number
/** Same, as order-total dollars. */
export function kalshiFeeDollars(feeRate: number, yesPrice: number, contracts: number): number
```

Body of #1 is **byte-identical in behaviour** to `autoTrader.ts:4894`. #2 is `#1 * contracts / 100`. Add a doc comment stating the invariant:

> `kalshiFeeDollars(r,p,C) * 100 / C === kalshiFeeCentsPerContract(r,p,C)`

That invariant is precisely what N1 violated. Encoding it in the module and testing it makes the whole bug class unrepeatable.

### 3.2 Re-point, in this order

| Step | Target | Risk | Note |
|---|---|---|---|
| 1a | `engine/paper.ts:233` `feeFor` | **low** | Pure bugfix: adds the missing ceil. Changes paper results  but paper results were *wrong*, and this is the promotion grader. Do this first and re-run any paper-based judgement. |
| 1b | `autoTrader.ts:4894` | **none** | Replace body with a re-export/delegation. Keep the exported name; `2557`, `4748`, `4753`, `4851` all keep working. |
| 1c | `leadLag.ts:32` `kalshiTakerFeeCents` | **medium** | Two changes at once: (i) stop hardcoding `0.07`, take the market's `feeRate`; (ii) order-level rather than per-contract ceil. Both **lower** the computed fee  the `netCents >= minEdgeCents` gates at `602`/`635` admit *more* trades. Ship behind a config flag, or record a basis-change timestamp. Note `scripts/tests/review-fixes.test.ts:293-296` asserts the current values (`fee at 50c  2`, `95c  1`, `99c  1`, `10c  1`)  **these tests will need updating**, and updating them is the point, not a regression. |
| 1d | `cryptoConvergence.ts:104` `calcTakerFee` | **medium** | Same two changes. Note it is called at `349` with `count = 1` and then scaled by `t.feeCents * t.contracts` at `251`  i.e. per-contract-then-linear, which is the *wrong* shape. Re-point to `kalshiFeeDollars(rate, price, contracts)` and drop the `* t.contracts` at `251`. |
| 1e | `dutchBook.ts:200-285` | **low** | Sum `kalshiFeeDollars` per leg. |

### 3.3 Tests to add (`scripts/tests/`)

The harness is `scripts/tests/run.cjs` (compiles with the project's own TypeScript, no downloaded runner) and `npm test` runs it. Add `fee.test.ts`:

- The 3.1 invariant across a grid of `(rate, price, C)`.
- `kalshiFeeCentsPerContract(0.07, 0.90, 10) === 0.7` (worked example, 0.3).
- C=1  equals `ceil(ratep(1p)100)` exactly.
- `mult = 1`: `feeRate = 0.07 * 2` doubles the fee.
- paper `feeFor` and the canonical module agree to the cent for C  {1,5,10,50}.

**Acceptance:** `npm test` green, `npx tsc --noEmit` exit 0.

---

## 4. Phase 2  N1: the one-line fix, plus the epoch problem

### 4.1 The fix

`src/main/strategies/autoTrader.ts:4753`

```ts
// BEFORE
const feePerContract = kalshiOrderFeeCents(t.feeRate ?? 0, yesPx, C) / C
// AFTER
const feePerContract = kalshiOrderFeeCents(t.feeRate ?? 0, yesPx, C)
```

`kalshiOrderFeeCents` already returns per-contract cents. Delete the `/ C`.

### 4.2 The part that is easy to miss: the ledger is already contaminated

`netSum` / `netSq` / `netN` are **cumulative** and `calib` **survives `reset()`**. Fixing the formula does not fix history  it starts appending correct values to an incorrect running total, which is worse than either alone because the mixture is uninterpretable.

`openTrades` entries are removed on settle (`3751`, `3764`), so the per-trade inputs are not in `config.json`. Two options:

- **(A) Recompute from the episodes JSONL**  only viable if each archived row carries `outcome`, `entryPrice`, `shares`, `feeRate` and the settled `win`. **Verify this before committing to (A).** If any field is missing, (A) is impossible.
- **(B) Epoch-cut.** Add `netEpochTs?: number` to `AppConfig`, set it in a new migration (**v26**, following `CURRENT_VERSION = 25`), and have the ladder / `clusteredNet` consume only rows stamped after it.

**Recommend (B).** There is an exact precedent in this codebase: migration v25 added `killEpochTs` with the comment *"the trip recorded under the old basis is cleared once, and the switch arms under the new basis only."* Same problem, same shape, already reviewed. Copy that idiom rather than inventing one.

If `gradeEntry` cannot stamp individual rows, the cheaper variant is: on migration, **zero `netN/netSum/netSq/byDay` for every arm** and set `netEpochTs = Date.now()`. This costs the accumulated netCents evidence (the win/loss `n` and `wins` counters can be preserved  they are unaffected by the fee bug) and buys a clean basis. **Preserve `n` and `wins`; clear only the netCents accumulators.** Say this explicitly in the migration comment.

### 4.3 Regression test

```ts
// The invariant N1 broke: the two helpers must agree.
for (const C of [1, 2, 5, 23, 100]) {
  const t = { outcome: 'NO', entryPrice: 0.042, shares: C, feeRate: 0.07 }
  const feePerCt = entryFeeDollars(t) * 100 / C
  const netWin   = netCentsOf(t, 1)
  eq(`netCentsOf consistent at C=${C}`, netWin, (1 - 0.042) * 100 - feePerCt)
}
```

This single test fails on the current code at every C > 1 and passes after the fix. It also fails if anyone ever "fixes" `entryFeeDollars` instead  which is the wrong-end-of-the-telescope mistake this bug invites.

---

## 5. Phase 3  Robustness (PARALLEL TRACK, independent of Phases 1-2)

None of these touch metrics, so they can be developed and merged concurrently without invalidating evidence.

### 5.1 D6  retry wrapper at `engine/engine.ts:473` and `:486`

**The audit's recommended fix is wrong as written.** It states that `getAccount`/`getPositions` are already wrapped and only `getOpenOrders` is bare. Reading the source:

```ts
473:  const [account, rawPositions] = await Promise.all([adapter.getAccount(), adapter.getPositions()])
486:  const openOrders = adapter.getOpenOrders ? await adapter.getOpenOrders() : []
```

**All three are unwrapped.** A single 429 or socket reset on any of them rejects the whole `Promise.all` and kills the caller  the 15-second UI refresh path documented in the comment at `474-477`.

Fix: wrap the combined operation, not one leg.

```ts
const [account, rawPositions, openOrders] = await withRetry(async () => {
  const [a, p] = await Promise.all([adapter.getAccount(), adapter.getPositions()])
  const o = adapter.getOpenOrders ? await adapter.getOpenOrders() : []
  return [a, p, o] as const
}, { label: `snapshot:${venue}` })
```

Wrapping the three individually is also acceptable but produces three retry storms under a shared rate limit. **Wrap once.**

Also check `478`: `enrichPositions` is skipped when `account?.portfolioValue !== undefined`. If `getAccount` succeeds but returns no `portfolioValue`, the code falls into N sequential market requests  the exact 429 storm the comment says was fixed. Confirm the Kalshi path always sets it.

### 5.2 N8  exits bypass the kill switch

Verify whether the exit path consults `killSwitchArmed` / `killSwitchTripped` before submitting. The entry path does. If exits are ungated, a tripped switch stops new risk but still fires closing orders  which is *usually* desirable (you want to be able to flatten), so **this may be intentional**. Resolve by decision, not by assumption:

- If intentional: add a comment saying so, and close the finding.
- If not: gate exits on `killSwitchTripped` with an explicit `flattenOnly` allowance.

Do not "fix" this without deciding which behaviour is wanted.

### 5.3 N7  entry-path IOC at $1.00

Confirm the limit-price clamp on the taker entry path. A `1.00` IOC on a thin book is a market order with no protection. Clamp to `min(0.99, reference + slippageBudget)`.

### 5.4 N6  fractional-fill accounting

`3669` prorates the entry fee by `fraction`; `3684` does not (full exit). **On inspection both look correct.** The residual risk is narrower: both branches only run when `res.realizedPnl === undefined`, and both subtract `res.fee ?? 0` *and* `entryFeeDollars(t)`. If any venue ever populates `realizedPnl` net of the entry fee while leaving `res.fee` set, the entry fee is double-counted. Add an assertion or a comment documenting that `res.fee` is exit-side only. **Downgrade N6 from "defect" to "invariant not documented".**

### 5.5 N3/N4  fee-cache throttling and `ttl = 0`

`kalshi.ts:1372` comment says multipliers are "cached forever". Confirm the refresh is throttled to ~20 series per scan and that a `ttl` of 0 does not mean "always expired" (which would re-fetch ~160 series every scan). If it does, treat 0 as "no expiry".

---

## 6. Phase 4  D1: settle the fee model empirically (proposal A5)

**Gated on Phase 1**  this is why Phase 1 comes first. Once there is one fee function, this is a one-file change.

The open question: does Kalshi charge

- **(i)** `ceil_to_balance_precision(cost + ceil_6dp(modelFee))  cost` (the converged model the audit computes), or
- **(ii)** the whole-cent ceil the code currently implements?

When `cost` is a whole number of cents  the app's current case, since prices are 2dp  **(i) and (ii) coincide.** So the audit's recommendation to "drop the cent ceil entirely" is:

- **right** for the EV gate at `2557` (a decision quantity; smoothing it removes a systematic ~0.5 pessimism), and
- **wrong** for the accounting path at `4748` (money actually charged; must match the venue).

**Resolution:** an empirical test, not a reading of the docs.

1. Read `/portfolio/balance`.
2. Submit one IOC taker order for a known `C` at a price where (i) and (ii) differ by a cent  i.e. a **fractional-cent** price. Kalshi tick size permits 0.001 on some series; find one. If no series trades sub-cent, the two models are indistinguishable in practice and the question is moot: **keep the ceil and close D1.**
3. Read `/portfolio/balance` again; subtract the fill cost; the residual is the charged fee.
4. Repeat at three prices.

**Only then** decide whether to split into `kalshiFeeForGate()` (smooth) and `kalshiFeeForLedger()` (venue-exact). Do not split them speculatively  two functions that must agree are how N1 happened.

---

## 7. Phase 5  `decrease-order-v2`: the new capability

See 9 for the full argument. Summary of the work:

1. `src/shared/venue.ts`  add optional `decreaseOrder?(orderId, marketId, reduceTo): Promise<{ remainingCount: number }>` alongside `amendOrder?` at `:118`.
2. `src/main/venues/kalshi.ts`  implement against `POST /portfolio/events/orders/{order_id}/decrease`, reusing the shard-routing already written for `amendOrder` (`:1141`) and `cancelOrder` (`:1113-1127`).
3. `src/main/engine/engine.ts`  add the routing wrapper next to `:635-642`.
4. `src/main/strategies/quoter.ts`  insert the two-tier response at `:987-1007`.
5. Capability-gate it exactly as `quoter.ts:654` gates `amendOrder`.

**Shadow first.** Log intended decreases for a full session without sending them, then compare realised markout on decreased-vs-not cohorts.

---

## 8. Phase 6  Strategy re-evaluation

Only after Phases 1-2 land and `netEpochTs` cuts the basis.

- **S5 is already implemented. Drop it from the backlog.** The audit claims `leadLag.ts:700-704` gates on a flat-cent `edgeC >= minEdgeCents`. Those variables do not exist in the file. `leadLag.ts:599-635` computes `feeCents = kalshiTakerFeeCents(...)` and gates on a fee-net `netCents`, which is persisted per dislocation. The claimed upside ("420 free trades from re-scoring") is void. What Phase 1c *does* change is the fee **model** underneath that gate (hardcoded 0.07  real `feeRate`; per-contract ceil  order ceil)  that is a real but much smaller effect, and it loosens the gate.
- Re-run every arm's `netCents` CI on post-epoch data before promoting anything.
- Re-examine the arms whose C is largest (ratchet, consensus) first  they are the ones whose recorded performance moves most.
- **Correct the audit document itself.** Seven files it cites do not exist anywhere in `src/`, `scripts/` or `backups/`: `tradeFeed.ts`, `correlatedMarkets.ts`, `manifoldCopy.ts`, `manifoldPaper.ts`, `settlement.ts`, `store/executionArchive.ts`, `store/tradeLog.ts`. A recursive filename search returns NONE for six and only `_diag_settlements.cjs` for the seventh. Note that `strategies/polyPaper.ts` **does** exist  the audit's names look like garbled real filenames rather than pure invention, but the line counts and trade statistics attached to them cannot be verified and should not be acted on. Append a correction notice rather than editing the original.

---

## 9. THE NEW IDEA IN DEPTH  queue-preserving de-risk on the quoter

### 9.1 The measured problem

The quoter is **disabled** on a **1.93 markout over n = 1,083**. That is a real sample, not noise. On plain-`quadratic` series the maker fee is **0** (`kalshi.ts:1408`: `feeType === 'quadratic_with_maker_fees' ? COEFmult : 0`), and quotes are placed `postOnly: true` (`quoter.ts:1032`). So on those series the 1.93 contains **no fee component at all**. It is pure adverse selection.

The audit lists `decrease-order-v2` among unused endpoints and even quotes the right property  *"cuts exposure without losing queue position"*  but never connects it to the markout. That connection is the idea.

### 9.2 Why the markout is negative  and why it is not a latency bug

Kalshi's own amend documentation, confirmed against the live docs:

> *"Amending a resting order preserves queue position only when the amendment decreases size. All other amendments  like increasing size or changing price  forfeit queue position and place the order at the back of the queue."*

The codebase already knows this. `kalshi.ts:1135`, verbatim:

> *"Note: a price change loses queue position (only size decreases keep it)."*

Now look at what the quoter actually does. `quoter.ts:987-991`:

```ts
if (existing) {
  const crossed = outcome === 'YES' ? existing.yesPrice >= bestAsk : existing.yesPrice <= bestBid
  if (crossed || existing.count !== count || Math.abs(existing.yesPrice - yesPrice) >= 0.03) {
    const r = await adapter.amendOrder(existing.orderId, c.id, side, yesPrice, count)
```

`amendOrder` (`kalshi.ts:1137-1150`) always sends **both** `price` and `count` to `/amend`. So every reprice  3  and every size *increase*  **forfeits queue position**.

That produces a structural inversion, and this is the heart of the proposal:

- **When your price is correct**, you have just amended to it. You are at the **back** of the queue. You fill only after everyone ahead of you is exhausted  i.e. under heavy flow. Heavy flow into a correctly-priced quote usually means the taker knows something you don't.
- **When your price is stale**, you were resting there **first**. You are at the **front**. An informed taker hits you immediately.

**The amend-on-move policy guarantees you are at the front of the queue exactly when you are wrong, and at the back exactly when you are right.** That yields a negative markout with zero fees, zero latency, and perfect information about your own quotes. It is not a speed problem. Faster polling makes it *worse*, because you forfeit the queue more often.

This is why n = 1,083 came out at 1.93 and why no amount of re-tuning `quoterMinEdgeCents` fixed it: the gate changes *which* quotes are placed, not *where they sit in the queue when they get hit*.

### 9.3 The fix: shrink in place, reprice only when untenable

`POST /portfolio/events/orders/{order_id}/decrease` is **decrease-only**  it cannot change price, and per the docs it **preserves queue position**. Body: exactly one of `reduce_by` or `reduce_to`, plus `exchange_index`.

```
POST /portfolio/events/orders/{order_id}/decrease
{ "reduce_to": "3.00", "exchange_index": 0 }
```

Replace the binary amend with a **two-tier response to an adverse reference move**:

| Tier | Trigger | Action | Queue position |
|---|---|---|---|
| **1  shrink** | reference moved against this side by  `decreaseTriggerCents` (start 1) but the quote is not crossed | `decreaseOrder(reduce_to: smaller)` | **PRESERVED** |
| **2  reprice** | crossed, or move  `repriceTriggerCents` (start 3, i.e. today's threshold) | `amendOrder(price, count)` as now | forfeited  correctly, because the price is now wrong |

Tier 1 is the new behaviour. You keep the queue slot you paid for in time  so you still fill when you are right  but you cut the notional that gets picked off when you are wrong. Exposure becomes a **continuous function of staleness** instead of a step function.

### 9.4 Three refinements that make it materially better

**(a) Asymmetric.** The threat is one-sided: only the side the reference moved *against* can be picked off. Today the quoter amends both sides. Decrease **only the threatened side** and leave the other resting at full size  it is now the more likely winner, and it keeps its queue slot.

**(b) Proportional.** Scale the cut to the move rather than using a fixed fraction:

```
threat = clamp((adverseMoveCents - decreaseTriggerCents) / (repriceTriggerCents - decreaseTriggerCents), 0, 1)
reduceTo = filledSoFar + round(originalCount * (1 - threat * maxDecreaseFraction))
```

with `maxDecreaseFraction` starting at 0.75. A 1 move trims nothing; a 3 move has already cut 75% before Tier 2 fires.

**(c) Restrict to fee-free-maker series first.** `quoter.ts:358/519` already maintains a `makerFee` map of which series bill maker fees. Gate Tier 1 on `makerFee.get(ticker) === false`. On those series the markout is pure adverse selection, so the measurement is clean  there is no fee term moving underneath you. Extend later.

### 9.5 Implementation warnings  these will bite if missed

1. **Use `reduce_to`, never `reduce_by`.** `reduce_by` is not idempotent. The adapter has retry logic; a decrease that times out after succeeding server-side would double-shrink on retry. `reduce_to` is an absolute target and is safe to replay.
2. **`count` in Kalshi's V2 order shape is the TOTAL fillable count  already-filled plus desired-remaining.** The amend docs state this explicitly: *"The request `count` is the updated total/max fillable count, equal to already filled count plus desired resting remaining count."* **Verify whether `/decrease`'s `reduce_to` uses the same convention before shipping.** If it does, you must add `existing.filledSoFar` (tracked at `quoter.ts:1044`, updated at `:997`). If you pass the desired *remaining* count without adding fills, you will over-shrink  and at `reduce_to  filledSoFar` the order completes or cancels entirely, silently converting Tier 1 into a full cancel and destroying the very queue position the feature exists to protect.
3. **Handle the terminal case.** If the decrease completes the order, remove the quote from `state.quotes` and book the fill  mirror the `r.fillCount > filledSoFar + 0.005` check at `:995-998`.
4. **Shard routing is mandatory.** `/decrease` takes `exchange_index`. Reuse `this.shardOf.get(marketId) ?? this.orderRoute.get(orderId)?.shard` exactly as `amendOrder` does at `:1141`. An order on shard 2 is not found without it.
5. **Write budget.** A decrease is one write, same as an amend  no regression. It is strictly cheaper than the cancel+repost it replaces in Tier 2 edge cases, and `kalshi.ts:1133` notes amend was introduced to avoid the "zero book presence" gap of cancel/recreate; decrease has no gap at all.
6. **Interaction with the loss-lock guard.** `quoter.ts:960-985` cancels a quote when a complementary leg would lock a loss. Decrease does not change that logic, but a decreased quote has a smaller `existing.count`  confirm the guard reads live count, not the originally-placed count.

### 9.6 Shadow-test plan (do this before enabling)

1. Implement the adapter method and the Tier-1 decision, but **do not send**. Log one row per decision: `{ts, ticker, side, orderId, referenceMove, currentCount, proposedReduceTo, filledSoFar, makerFeeFree}`.
2. Run one full session with the quoter enabled in its current form.
3. Join the shadow log against realised fills and compute markout on two cohorts: quotes where Tier 1 *would* have fired before the fill, and quotes where it would not.
4. **Success criterion:** the would-have-decreased cohort carries a materially worse markout than the other. That confirms the trigger identifies genuinely threatened quotes rather than firing at random. If both cohorts look the same, the trigger is wrong and enabling it would only shrink good quotes.
5. Only then enable, at `maxDecreaseFraction = 0.5`, and re-measure aggregate markout against the 1.93 baseline.

**Expected effect, stated conservatively:** this does not create edge. It removes a structural penalty that is currently large enough to have disabled the whole arm. If the 1.93 is mostly queue-inversion adverse selection, Tier 1 should recover a substantial fraction of it and bring the quoter back toward break-even-plus-spread  at which point `quoterMinEdgeCents = 1.5` and the maker rebate on `quadratic_with_maker_fees` series become the things worth tuning, on an arm that is no longer fighting its own queue position.

### 9.7 Second, smaller idea from the same reading

`autoTrader.ts:3268` gates a fade sweep on `adapter.amendOrder && adapter.getOrderBook && p.strategy === 'fade'`. The same queue-inversion argument applies to that sweep: it amends price on a taker-ish arm. Once `/decrease` exists, check whether the fade sweep is also forfeiting queue position on every adjustment  and whether it should be decreasing rather than repricing when the sweep is defensive rather than aggressive. Lower priority; note it so the capability is not built for one call site only.

---

## 10. Do-NOT-do list

| Tempting | Why not |
|---|---|
| Apply the audit's D6 fix as written | It wraps only `getOpenOrders`. `getAccount` and `getPositions` at `engine.ts:473` are equally bare and equally able to kill the handler. |
| Implement the audit's S5 | Already implemented at `leadLag.ts:599-635`. The cited lines and variables do not exist. |
| "Drop the cent ceil entirely" (audit D1) | Right for the EV gate at `2557`, wrong for the accounting path at `4748`. Settle empirically first (6). |
| Fix `entryFeeDollars` instead of `netCentsOf` | `entryFeeDollars` is **correct**. It is the cash path. Changing it breaks money tracking to fix a metric. |
| "Fix" `kalshiOrderFeeCents` | It is correct. Its doc comment is confusing; improve the comment, leave the code. |
| Split into gate-fee and ledger-fee speculatively | Two functions that must agree is exactly how N1 happened. Only split on empirical evidence. |
| Backfill `netSum`/`netSq` by recomputing from them | They are cumulative aggregates; the per-trade inputs are gone from `openTrades` after settle. Use the episodes JSONL or epoch-cut. |
| Enable `/decrease` without the shadow test | You cannot distinguish "recovered adverse selection" from "shrank the good quotes too" without the cohort comparison. |
| Use `reduce_by` | Not idempotent under retry. |
| Chase the seven files the audit cites | They do not exist. |

---

## 11. Open questions for the operator

1. **Is `amountPerTrade` going back to 5?** If yes, Phase 2 moves from "important hygiene" to "blocking"  at C=5 the fade arm's recorded fee drops to 1/5 of real and every cheap-leg arm inflates by 5-16-scale errors.
2. **Do the episodes JSONL rows carry `feeRate` and `shares`?** Decides 4.2 option (A) vs (B).
3. **Is the exit path's bypass of the kill switch intentional?** (5.2)  a decision, not a discovery.
4. **Is the quoter worth reviving at all?** It is the only arm with a measured negative markout at scale. 9 makes the case that the cause is structural and fixable, but if the answer is "no, leave it off", Phase 5 drops to the bottom of the backlog.
5. **Which series have `mult = 1`?** If none are currently traded, 0.2's hardcoded-0.07 bug is latent rather than live, and Phase 1c/1d can be deferred behind the ceil fix.

---

## 12. Acceptance checklist

- [ ] Phase 0 evidence snapshot committed under `docs/evidence/2026-09-18-pre-fee-fix/`
- [ ] `src/main/util/kalshiFee.ts` exists; five call sites re-pointed; `fee.test.ts` green
- [ ] `autoTrader.ts:4753` `/ C` removed
- [ ] Invariant test (`entryFeeDollars*100/C === netCentsOf` fee term) green at C  {1,2,5,23,100}
- [ ] Migration v26 adds `netEpochTs`; `n`/`wins` preserved, netCents accumulators cleared
- [ ] `review-fixes.test.ts:293-296` updated to the canonical fee model, with a comment explaining why
- [ ] `engine.ts:473/486` wrapped in a single `withRetry`
- [ ] N8 resolved by explicit decision + comment
- [ ] D1 settled empirically or closed as moot
- [ ] `decreaseOrder` implemented, shadow-logged one session, cohort comparison recorded
- [ ] Correction notice appended to `AUDIT-CODE-API-STRATEGY-2026-09-18.md` (do not edit the original)
- [ ] `npm test` green and `npx tsc --noEmit` exit 0 after every phase

---

*End of plan. No source files were modified in producing it.*
