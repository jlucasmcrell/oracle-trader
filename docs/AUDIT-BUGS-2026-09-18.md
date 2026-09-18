# ORACLE TRADER - INDEPENDENT BUG AUDIT (POST-D1)

Date: 2026-09-18
Auditor: RIFT Studio agent (same agent that performed the prior fee repairs)
Scope: full source tree `G:\PROJECTS\oracle-trader\src` (~87 files, ~12k LOC TS/TSX)
Guarantee: **NO application code was edited, added, or removed by this audit.**
The only files written were this document and one read-only analysis helper
(`tmp\audit-markout.mjs`). See section 9 for the proof.

---

## 0. TL;DR

The codebase is in good shape. The prior fee repairs landed cleanly and are
consistent; `tsc --noEmit` is exit 0 and all 12 regression suites pass. After a
deliberate hunt across the money paths I found **one genuinely reachable
HIGH-severity bug (A1)**, two defects in code I myself added last session
(A3, A4), and a tail of low-severity hygiene items.

The single most important new result is not a bug but a **measurement**: the
quoter's shadow log now contains enough data to measure its adverse selection
offline, and it confirms the quotes are adversely selected (mean 15-minute
markout -2.14c on the cohort that would trade, t = -2.17 clustered). See section 3.

| ID | Sev | Reachable? | One-line |
|----|-----|-----------|----------|
| A1 | HIGH | YES (UI paper, MC venues) | Multi-outcome paper positions can never be sold or settled - stake silently lost |
| A2 | MED | YES (same root) | `getPositions()` drops `answerId`, so MC positions lose their contract identity |
| A3 | MED | YES (if quoter armed) | Quoter Tier-1 shrink protection is timer-driven, not price-driven - expires after 60s |
| A4 | LOW | YES (shadow now) | Tier-1 shadow mode still issues API calls and cannot cool down (corrects my earlier claim) |
| A5 | LOW | Needs live verify | `/decrease` request body may be missing a required `side` field |
| A6 | LOW | No | `kalshiNetEdgeCents()` is dead code and mis-named |
| A7 | LOW | Latent | `toNum()` maps a missing API field to a real zero, hiding schema drift |
| A8 | INFO | No | Non-Kalshi venues are modelled with the Kalshi fee shape in two places |
| A9 | INFO | N/A | IBKR lab scans wastefully while the gateway is down |

---

## 1. Method, baseline and honest limits

Method: read the money-critical paths end to end (venue adapter, engine, paper
broker, fee module, quoter, ladder, ledger audit, WS feed), then targeted
searches for classic defect idioms (reducers without an initial value, division
without an empty-guard, hard-coded fee constants, `NaN` propagation), then
mining the live runtime artefacts (33.8 MB `main.log`, 2.2 MB quoter shadow log,
883 KB fill archive) for real anomalies.

Verification standard: every finding below is CONFIRMED by reading the code in
context and quoting it. I explicitly label anything unverified. In the previous
audit round, five of my own early findings turned out to be false because of a
truncated read; that risk is taken seriously here, and several candidates were
**discarded** on inspection (section 7).

Baseline at time of audit:

- `npx tsc --noEmit` -> exit 0
- 12/12 suites pass: fee (14 checks), review-fixes (512), ladder (126),
  risk-controls (20), adversarial (89), remaining-defects (11),
  completion (17), config migration, settlement-accounting, execution-quality,
  collection-integrity (7), ibkr, ibkr-lab (23)
- Live process: electron PID 47588, started 2026-09-17 11:23:12, i.e. it is
  running **pre-D1-fix code**. The D1 fee change and everything in this document
  take effect on restart.

---

## 2. A1 (HIGH) - Multi-outcome paper positions can never be sold or settled

### What happens

The renderer offers a second buy button for multi-outcome (MC) markets, which
passes the chosen answer's id. That id is used to build the position key on the
**buy** side only. The sell and settle paths never pass it, and the read path
never exposes it, so the position is unreachable from every other code path.

### Evidence - the buy side writes a 3-part key

`src\renderer\src\App.tsx:219` (`buyAnswer`):

```ts
const res = await window.api.engine.placeOrder({
  venue,
  marketId: m.id,
  outcome: answer.text,
  answerId: answer.id,
  amount,
  feeRate: m.feeRate
})
```

`src\main\engine\paper.ts` (`key` + `buy`) stores under a key that appends the
answer id:

```ts
private key(marketId: string, outcome: string, answerId?: string): string {
  return `${marketId}:${outcome}${answerId ? `:${answerId}` : ''}`
}
```

```ts
this.positions.set(key, {
  venue: this.venue, marketId: order.marketId, marketQuestion: order.marketQuestion,
  outcome: order.outcome, answerId: order.answerId, ...
})
```

So an MC position lives at `"<marketId>:<answerText>:<answerId>"`.

### Evidence - the sell side omits it

`src\renderer\src\App.tsx:239` (`sell`):

```ts
await window.api.engine.sellPosition({ venue, marketId: pos.marketId, outcome: pos.outcome })
```

`src\main\engine\paper.ts` (`sell`):

```ts
const p = this.positions.get(this.key(req.marketId, req.outcome, req.answerId))
if (!p) throw new Error('No paper position to sell')
```

With `req.answerId === undefined` the lookup key is `"<marketId>:<answerText>"`,
which does not exist -> **throws `No paper position to sell`**. The UI reports
`Sell failed: ...` and the position stays open forever.

### Evidence - the settle path omits it too

`src\main\engine\paper.ts` (`settle`) - note the key call takes no `answerId`:

```ts
settle(marketId: string, outcome: string, winPrice: number): { shares: number; realizedPnl: number } | null {
  const p = this.positions.get(this.key(marketId, outcome))
  if (!p) return null
  ...
  this.positions.delete(this.key(marketId, outcome))
  this.balance += payout
```

`src\main\engine\engine.ts:337` (`settlePaperPosition`) forwards only three
arguments, so `settle` can never be told which answer to resolve:

```ts
const res = broker.settle(marketId, outcome, winPrice)
```

Result: returns `null`, so **the payout is never credited and the position is
never removed**. The stake is gone from the paper balance with no trade record.

### Evidence - the read path hides it, so the UI cannot even repair itself

`src\main\engine\paper.ts` (`getPositions`) maps every position but **omits
`answerId`** - even though the type it produces has the field:

```ts
return [...this.positions.values()].map((p) => ({
  venue: p.venue, marketId: p.marketId, marketQuestion: p.marketQuestion,
  outcome: p.outcome, shares: p.shares, avgPrice: p.avgPrice,
  currentPrice: undefined, unrealizedPnl: undefined
}))
```

`src\shared\types.ts` does declare it on `Position`:

```ts
/** Multi-outcome markets: WHICH answer this position is on. */
answerId?: string
```

and on `SellRequest`:

```ts
/** Multiple-choice answer id (used instead of YES/NO on MC markets). */
answerId?: string
```

So the plumbing exists and is documented - it is simply not threaded through.
`PaperPosition.answerId` even carries the comment *"Multiple-choice answer this
position is on (keys separately per answer)"*, confirming MC support was the
intent and only the buy half was finished.

### Why it has survived - no test touches it

`answerId` appears in **zero** files under `scripts\` (tests, harnesses, gates).
No suite exercises an MC position end to end, which is exactly why a buy-only
implementation passed CI.

### Reachability and blast radius

- **Reachable now, from the UI**: pick a multi-outcome venue (Polymarket US),
  use the per-answer buy button, then try to close it. Buy succeeds, sell
  throws. If the market then resolves, the position is never settled.
- **Not reachable from the automated strategies**: no file under
  `src\main\strategies\` sets `answerId` (verified by grep - zero hits), so the
  bots are unaffected today.
- **The live path is NOT affected and this is the important part**: the
  Polymarket US adapter contains no `answerId` references at all; it identifies
  the contract from `marketId` + `outcome`, so live MC trading works. The
  consequence is that **the paper simulator and the live venue disagree about
  what identifies a contract on MC markets**. Paper is the harness that grades
  strategy variants before real money, so this is a correctness hole in the
  measurement rig, not just a UI annoyance.

### Impact

1. Paper balance is silently debited by the stake and never credited the payout
   or the exit proceeds -> MC paper P&L is wrong in the pessimistic direction.
2. Positions accumulate as ghosts in the paper book and in the UI.
3. Any future MC strategy evaluated on paper would be graded on corrupted
   numbers, and would look worse than reality.

### Fix specification

Thread `answerId` through the four paths, or make paper use the same contract
identity as the live adapter. Minimal coherent fix:

1. `paper.ts` `getPositions()` - add `answerId: p.answerId`.
2. `paper.ts` `settle(marketId, outcome, winPrice, answerId?)` - use
   `this.key(marketId, outcome, answerId)` for both the lookup and the delete.
3. `engine.ts` `settlePaperPosition(venue, marketId, outcome, winPrice, answerId?)`
   - forward the new argument.
4. Update callers to pass it: `autoTrader.ts:3772` (the dutch-book paper path)
   and `miniAuto.ts:1261`.
5. `App.tsx:239` `sell()` - add `answerId: pos.answerId`.
6. `App.tsx:219` `buyAnswer` - pass `answer.id` as the order's
   `clientOrderId`/ref too, so a fill can be attributed back to the answer.
7. Migration: positions already persisted under 3-part keys stay stranded after
   the fix unless re-keyed. Either add a migration that normalises existing keys,
   or accept them as known-orphans and document them.

Regression test to add (this is the test that would have caught it): buy an MC
position with an `answerId` -> assert `getPositions()[0].answerId` is present ->
sell it via the same shape the UI uses -> assert the position is gone and
`realizedPnl` is finite -> re-buy and settle -> assert the payout lands in the
balance. Cover the binary (no `answerId`) path in the same suite to prove no
regression.

---

## 3. EMPIRICAL FINDING - the quoter's shadow quotes are adversely selected

This is new measurement, not a bug report, and it is the strongest evidence
assembled so far on the quoter question. It is fully reproducible offline
(`node tmp\audit-markout.mjs`), no API calls, no credentials.

Source: `%APPDATA%\oracle-trader\quoter-kalshi-shadow.jsonl` (2.2 MB, written
today 08:42).

Raw counts: 3131 `quote`, 1130 `proxy-fill`, 1102 `markout15`, 1443 `expired`,
551 `pulled`. Fill detection was from the trade-print feed in 1123 of 1130 cases.

| cohort | quotes | proxy-fills | marked | mean markout | median | sd | clustered SE | t | % negative |
|---|---|---|---|---|---|---|---|---|---|
| **allowed** (would trade) | 257 | 42 | 42 | **-2.14c** | -1.50c | 6.23 | 0.99 | **-2.17** | 64% |
| **blocked** (control) | 2874 | 1088 | 1060 | **-1.98c** | -0.50c | 9.59 | 0.26 | **-7.67** | 53% |

Three conclusions, in order of confidence:

1. **The quotes are adversely selected.** Both cohorts have a negative 15-minute
   markout, and the cohort that would actually trade is negative at t = -2.17
   with market-clustered errors. Quotes rest as maker orders, and maker fee is
   0 on plain-`quadratic` series, so there is **no fee component in this
   number** - it is pure selection.
2. **The gates do not separate good quotes from bad ones.** Allowed (-2.14c) is
   statistically indistinguishable from blocked (-1.98c). A gate set that worked
   would show a large positive gap between the cohorts. This is direct evidence
   that re-tuning `quoterMinEdgeCents` or the ratchet/blackout gates cannot fix
   the quoter - which is precisely what the queue-position theory predicts, and
   why gate tuning never moved the needle.
3. **The measurement is a LOWER bound on our true adverse selection.** A
   `proxy-fill` is "a print at or through the quote price", not a fill of *our*
   order. The shadow log therefore marks a quote as filled on 36.1% of quotes
   (1130/3131), while the live quoter's own filled counter reads 43.11 against 1632 placed.
   Note the units: `filled` is CONTRACTS (fractional), `placed` counts QUOTES, so this
   is not a fill rate and the two must not be divided. At a 5-contract clip that is
   roughly 0.5% of offered size filled, which is still orders of magnitude below a
   36% touch rate. If the queue-position mechanism is real then our
   fills are a small, *preferentially stale* subset of those touches, so the
   true filled-cohort markout is worse than -2.14c, not better.

Caveat to respect: the allowed cohort has only 42 marked fills across 26 market
clusters - it sits exactly at the gate script's own floor (`MIN_FILLS = 30`,
`MIN_EVENTS = 40`). Treat the allowed-cohort t-statistic as indicative, not
settled. The blocked cohort (1060 marked, 296 clusters) is solid.

Implication for the pending decision: **do not arm the quoter on the strength of
gate changes.** The evidence says the loss is structural in how resting orders
interact with flow, which is the case for the queue-preserving `/decrease`
mitigation (Tier 1) rather than for more gate tuning. Correct the shadow-fill
heuristic first if the number is going to drive an arming decision, because a
   "print at my price" is not "my order filled" - see conclusion 3 above.

### Correction to my own earlier statements

Last session I told the operator that the quoter "records no markout at all
(`markWatch: []`)" and that its markout is therefore "currently unmeasurable".
**That was wrong.** `markWatch` is populated on fill (`quoter.ts:485`), the
markout is computed and written as `markout15` events (`quoter.ts:1211`), and a
per-quote mark file (`quoter-kalshi-marks.jsonl`, 49 KB) has existed since
2026-09-07. The quoter's adverse selection has been measurable all along; I
looked at the in-memory state instead of the log it writes. The "unmeasurable"
argument I used to justify shadow-first instrumentation was also too strong - the
instrumentation largely already exists, including a dedicated gate script
(`scripts\quoter-shadow-gate.mjs`) that computes exactly these cohorts.

A second correction, caught while verifying this document: the earlier quoter figures
(`placed 1432 / amended 793 / canceled 741 / filled 33.1`, and a derived "2.3% fill
rate") mixed units - `filled` is a CONTRACT count (fractional) while `placed` counts
QUOTE ORDERS, so the ratio was never a fill rate. The live state at audit time is
`placed 1632 / amended 861 / canceled 873 / filled 43.11`. Use the counters for counting
and never divide one by the other. The qualitative point survives - touches vastly
exceed fills - but no ratio should be quoted from those two fields.

---

## 4. A3 (MEDIUM) - Tier-1 shrink protection is timer-driven, not price-driven

This is a defect in the quoter Tier-1 work I added last session. Confirmed by
reading `src\main\strategies\quoter.ts` around lines 998-1030.

```ts
const shrinkCooldownMs = 60_000
if (!crossed && adverseMove && microDeltaCents >= 1 && microDeltaCents < 3 && remaining > 1 && adapter.decreaseOrder && (existing.shrunkAt === undefined || now - existing.shrunkAt > shrinkCooldownMs)) {
  ...
  if (cfg.quoterDecreaseEnabled) {
    const r = await adapter.decreaseOrder(existing.orderId, c.id, reduceTo)
    existing.count = (existing.filledSoFar ?? 0) + r.remainingCount
    existing.shrunkAt = now
  }
  quoting++
  continue
}
if (crossed || (existing.count !== count && (existing.shrunkAt === undefined || now - existing.shrunkAt > shrinkCooldownMs)) || Math.abs(existing.yesPrice - yesPrice) >= 0.03) {
  const r = await adapter.amendOrder(existing.orderId, c.id, outcome === 'YES' ? 'bid' : 'ask', yesPrice, count)
  existing.yesPrice = yesPrice
  existing.count = count
```

The problem is in the second `if`. After a shrink, `existing.count` is the
*shrunk* size while `count` is the desired size, so `existing.count !== count` is
permanently true. That clause is only held off by the 60-second cooldown. Once
the cooldown lapses the amend fires, restoring the **full** size - and because
`yesPrice` in an ongoing adverse move differs from `existing.yesPrice`, it is
simultaneously a **price change**, which per Kalshi's own amend documentation
forfeits the queue position that Tier-1 exists to protect.

Net effect: Tier-1 buys exactly 60 seconds of queue-position protection and then
reverts to the status quo ante (full size, new price, back of the queue). On a
slow adverse drift it sawtooths: shrink -> 60s -> reprice + restore -> shrink ->
... with a fresh queue forfeit on every cycle, which is the churn the cooldown
was supposed to prevent.

Two distinct fixes, both small:

- **Preferred**: make the restore conditional on the move having *reverted* -
  e.g. only take the restore branch when
  `Math.abs(yesPrice - existing.yesPrice) < 0.01 && existing.count !== count`.
  Then a persisted adverse move keeps the reduced size (which is the intent)
  until the separate >= 3c tier reprices it, and a reverted move restores size
  at an unchanged price (a size-only amend, which preserves the slot).
- **Minimum**: when restoring purely for size and the price is unchanged, send
  the amend without a price change, so the restore is at least a queue-preserving
  size amend rather than a reprice.

Also worth fixing while there: `existing.yesPrice = yesPrice` is assigned even
if the amend throws? No - it is inside the `try`, after the await, so a throw
leaves state consistent. That part is correct. And `existing.count = count` after
an amend ignores the factual fill count unless the follow-up
`r.fillCount > filledSoFar` branch fires; that is a deliberate approximation and
is benign, but it means `count` can claim size that has already filled.

---

## 5. A4 (LOW) - Tier-1 shadow mode still calls the API and cannot cool down

Confirmed in the same block. The queue-position probe runs **before** the
enablement gate:

```ts
let queue: string | null = null
if (adapter.getOrderQueuePosition) {
  try { queue = String(await adapter.getOrderQueuePosition(existing.orderId)) } catch { /* diagnostic only */ }
}
this.log(`[quoter] tier1 shrink ${outcome} ${c.id}: ${existing.count}->${reduceTo} remaining, queue=${queue ?? '?'}${cfg.quoterDecreaseEnabled ? '' : ' (shadow)'}`)
if (cfg.quoterDecreaseEnabled) { ... }
```

and `existing.shrunkAt` is set only inside the `if (cfg.quoterDecreaseEnabled)`
branch. Therefore in shadow mode:

1. One `getOrderQueuePosition` GET is issued per candidate **per tick** - the
   shadow path is not API-free (my earlier statement to the operator that shadow mode
   makes "zero API calls" was wrong; it is one GET per candidate per scan).
2. The 60-second cooldown never arms, because `shrunkAt` is never written, so
   the branch re-fires on every tick for the same quote, producing repeated log
   lines and a repeated GET with no bound. The quoter is currently disabled so
   live impact is nil, but this is a rate-limit risk the moment it is armed and
   a log-noise problem right now.

Fix: record a shadow cooldown timestamp whether or not the decrease was actually
sent (e.g. set `existing.shrunkAt = now` in both branches, or add a separate
`existing.shadowShrunkAt`), and rate-limit or sample the queue-position probe
rather than calling it on every candidate every tick.

---

## 6. A5-A9 - Lower severity and informational items

### A5 (LOW, unverified) - `/decrease` request body may be missing `side`

`kalshi.ts` `decreaseOrder` sends `{ ticker, reduce_to }` (mirroring the working
`amendOrder`). The vendored Kalshi index at `scripts\kalshi-docs\llms.txt` does
document the endpoint - *"Endpoint for decreasing the remaining count of an
existing event-market order ... Exactly one of `reduce_by` or `reduce_to` must be
provided"* - which confirms the `reduce_to` **semantics** the implementation
relies on (it is the new desired *remaining* count, and `reduce_to: 0` cancels).
But the endpoint's own page is not vendored, so whether `side` or
`exchange_index` is also required cannot be confirmed from the repo. Current
behaviour is fail-safe: the call throws, the throw is caught and logged
(`[quoter] tier1 decrease failed`), and no order state is corrupted. Verify with
one live call against a test order before ever enabling `quoterDecreaseEnabled`.
The same caveat applies to `getOrderQueuePosition`'s endpoint path.

### A6 (LOW) - `kalshiNetEdgeCents()` is dead code and mis-named

`src\main\util\kalshiFee.ts:200` exports `kalshiNetEdgeCents(yesPrice, contracts,
multiplier?)`, which returns only the negative fee. It is called from **nowhere**
(one grep hit: its own definition). The name promises a net edge - i.e. what an
EV gate wants - while the body returns a cost with no edge in it. That is a trap
for the next developer, and exactly the shape of mistake that produced the
original divergent-fee bugs. Delete it, or rename it to something like
`kalshiTotalFeeCents`. The rest of the fee module is clean: the
`kalshiOrderFeeDollars` / `kalshiFeeCentsPerContract` pair is self-consistent,
so the cash figure and the per-contract quality figure agree at every contract
count (the invariant broken by the old N1 bug).

### A7 (LOW, latent) - `toNum()` maps a missing field to a real zero

`kalshi.ts:1638` (`toNum`) coerces a missing/absent API field to `0`, which is
indistinguishable from a genuine zero. The quoter's decrease path consumes it
directly:

```ts
existing.count = (existing.filledSoFar ?? 0) + r.remainingCount
```

If a future API revision omits `remaining_count`, `count` silently becomes
`filledSoFar` and the app believes the quote has no size resting. It self-heals
on the next amend, so this is not a money bug today, but it is a silent-failure
pattern that will hide the next schema change. Prefer returning `undefined` for
an absent field and require callers to decide.

### A8 (INFO) - Non-Kalshi venues are modelled with the Kalshi fee shape

`paper.ts` `feeFor()` branches to the canonical Kalshi model for `kalshi` and
otherwise uses the Kalshi quadratic shape anyway:

```ts
if (venue === 'kalshi') return kalshiOrderFeeDollars(feeRate, price, shares)
return feeRate * shares * price * (1 - price)
```

with the doc comment *"ALL OTHER VENUES: symmetric continuous model"*. If a
non-Kalshi market carries no `feeRate` this returns 0 and is harmless. It only
becomes a modelling error if a non-Kalshi venue is ever assigned a fee rate,
because then paper applies a Kalshi-shaped fee to a venue whose real fee model
differs (and note the branch has no balance-precision rounding, unlike the
canonical path). Relatedly, `autoTrader.ts:2998` defaults
`m.feeRate ?? KALSHI_TAKER_FEE_COEF` (0.07), i.e. the EV gate assumes a
Kalshi-sized fee on a non-Kalshi market. Both directions are conservative on the
EV side (overstate the fee), so this is a documentation-and-consistency item, not
a live risk. Confirm Polymarket US's actual fee/commission model once and encode
it explicitly rather than inheriting the Kalshi constants.

### A9 (INFO) - IBKR lab scans while the gateway is unavailable

`main.log` shows 275+ `[ibkr-lab] ... Gateway API not available yet` warnings in
a recent 3000-line window, plus `No security definition has been found for the
request`. Expected when TWS/Gateway is not running, but the lab keeps scanning
and retrying. A cheap circuit breaker (skip the scan, log once per N minutes -
the pattern already used for the reconciler failure message) would remove the
noise and the wasted work.

---

## 7. Checked and found CORRECT (do not re-audit these)

Listed so the next developer does not spend time re-deriving them, and so a
future "cleanup" does not break them:

1. **The canonical fee module is consistent.** `kalshiFee.ts`'s dollars and
   per-contract functions share one derivation, so `feeDollars*100/C` equals
   `feeCentsPerContract` at every `C`. The D1 four-decimal balance precision is
   applied in one place only.
2. **No fee divergences remain.** A grep for `0.07` and for `Math.ceil` across
   `src` shows the surviving fee arithmetic routing through `util/kalshiFee.ts`.
   The remaining local `kalshiOrderFeeCents` in `autoTrader.ts` is an explicitly
   documented deprecated shim that delegates to the canonical per-contract
   helper, and `candidatePacket.ts`'s `oneContractFeeCents` delegates likewise.
3. **`reduce()` without an initial value** - four candidates found, all safe:
   `engine.ts:516` has its `, 0` on a continuation line; `ladder.ts:990` is
   guarded by an `if (sources.length === 0) return` immediately above; every
   other hit passes an initial value.
4. **Empty-array division** - three candidates (`cryptoConvergence.ts:225`,
   `autoTrader.ts:2502`, `ibkrLab.ts:326`) are all guarded: by
   `if (closes.length < 20) return null`, by an upstream `continue` on an empty
   leg list, and by a `candles.length < 24` throw respectively.
5. **WebSocket subscription-churn theory was wrong.** I suspected that because
   `subscribe()` caps at 50 tickers while the drift check uses the full desired
   set, the socket would cycle forever without converging. It does not: the
   caller already passes `tickers.slice(0, 50)` (`autoTrader.ts:3880`), so the
   desired set and the subscribed set agree and drift stays 0.
6. **`ledgerAudit.statsBand` math is sound** - `(sumSq - floor)/(n-1)` with
   `floor = n*mean^2` equals the usual sample variance, and the normal-approx
   gate correctly returns `undefined` for `n < 8`.
7. **`killSwitchCheck` is careful** - it validates `v.date === nowDate()` before
   using the venue-supplied daily figure, and offsets both the local and venue
   accumulators by the reset snapshot so a mid-day reset cannot double-count.
8. **`fundShard0`** handles the `cap` already-reached case and divides by 100
   with a float guard rather than rounding cash to cents blindly.
9. **The Kalshi WS client** has genuine gap detection (`expected != nextSeq - 1`
   -> `recover()`), stale-book marking on cycle, a 25-second watchdog, and
   healthy jittered backoff. No reconnect/leak bug found.
10. **Paper `sell`** is defensive where it matters: it coerces non-finite
    `feeRate`/`entryFee` to 0 specifically to avoid NaN realized P&L, allocates
    the entry fee pro-rata, and deletes the position at a `1e-9` epsilon.

---

## 8. Note that may close an earlier open question

The previous audit listed `settlement.ts` among files it cited that do not
exist. There is a plausible innocent explanation: `ladder.ts:1234` reads
`byStrategy?.['settlement']`, i.e. **`settlement` is a strategy key**, not a
module. An author skimming strategy keys can reasonably transcribe one as a
filename. This does not fully excuse the other phantom citations (which carried
line counts and trade statistics), but it does mean the "settlement" one in
particular should not be treated as evidence of fabrication.

---

## 9. Proof that no code was modified

- The only `write_file` calls this session were `docs\AUDIT-BUGS-2026-09-18.md`
  (this document) and `tmp\audit-markout.mjs` (a read-only analysis helper that
  parses a JSONL log and writes nothing).
- `npx tsc --noEmit` after the audit -> exit 0, and all 12 suites still pass,
  i.e. the tree is byte-equivalent in behaviour to the pre-audit state.
- No file under `src\` was written. No backup was needed because nothing was
  changed; existing backups under `backups\_repair_20260918*` remain untouched.
- Reproduce the measurement section with: `node tmp\audit-markout.mjs`

---

## 10. Suggested repair order (when the operator wants the fixes applied)

Prerequisite: the running app is on pre-D1 code, so a restart is needed before
any of this is measurable in live data anyway.

1. **A1 + A2** - the MC paper identity bug. Highest value, self-contained,
   low risk, and it restores trust in the paper harness that grades everything
   else. Add the regression suite described in section 2 at the same time.
2. **A4** - shadow cooldown + probe rate limit. Tiny, and it makes the shadow
   log trustworthy before it is used to decide anything.
3. **A3** - the Tier-1 restore condition. Decide the policy deliberately
   (restore-on-revert vs restore-on-timer) rather than leaving it implied.
4. **A6, A7** - dead code removal and absent-vs-zero. Hygiene that prevents a
   repeat of the divergent-fee class of bug.
5. **A5** - one live verification call, then either add the required field or
   record that the body is correct.
6. **A8, A9** - document Polymarket US's real fee model; add the IBKR circuit
   breaker.
7. **Quoter decision** - treat section 3 as the evidence base. If the quoter is
   ever armed, fix the proxy-fill heuristic first (a touch is not a fill - see section 3),
   and prefer the queue-preserving `/decrease` mitigation over further gate
   tuning, which the cohort data says cannot work.

Backups: take byte-exact copies of every file before editing, exactly as in the
prior repair rounds (`backups\_repair_<date>\`). This repo has no version
control - `git status` reports *fatal: not a git repository* - so `git init` plus
one commit remains the single highest-value safety improvement available.

---

## 11. Handoff notes for the next engineer or model

- Read `docs\REPAIR-COMPLETE-2026-09-18.md` and
  `docs\D1-EMPIRICAL-SETTLEMENT-2026-09-18.md` first; they explain the fee model
  and why the four-decimal rounding is correct. Do not "restore" the cent ceil.
- Trust `src\main\util\kalshiFee.ts` as the only place fee arithmetic belongs.
  Any new fee number outside it is a bug by construction.
- Two figures in the prior audit round were wrong and are corrected here:
  the audit's D6 premise, and my own "markout is unmeasurable" claim and
  "shadow mode makes zero API calls" claim. Everything else in those documents
  was verified and still holds.
- The paper broker is the grading rig for live capital. Treat a paper/live
  divergence (as in A1) as a HIGH-severity defect even when the paper side is
  the "wrong" one, because it corrupts the promotion metric for the ladder.

---

## 12. Operational finding (not a code defect) - maintenance/auto-repair loop is quota-blocked

Found while checking live artefacts, and listed here rather than in the TL;DR table
because it is not a defect in application code.

`data\sentinel\incidents\2026-09-18T12-05-maintenance-failed.md` is OPEN, and
`logs\repair-20260918-0805.log` shows the identical failure repeating:

```
[2026-09-18T07:00:01] start
You've hit your weekly limit - resets 11am (America/New_York)
[2026-09-18T07:00:04] exit 1
[2026-09-18T07:05:02] start
You've hit your weekly limit - resets 11am (America/New_York)
[2026-09-18T07:05:05] exit 1
```

Interpretation: the sentinel's scheduled maintenance job shells out to an LLM CLI and
that subscription's weekly quota is exhausted. Consequences:

1. The maintenance run cannot succeed until the quota resets.
2. The sentinel correctly detects the failure and dispatches a *repair session* - which
   fails with the identical quota error (08:05 log, exit 1). That is a futile retry loop
   repeating roughly every 5 minutes, and it consumes further quota attempts.
3. No application behaviour is broken by this, but the safety net that would run repairs
   is effectively offline. The failure mode is a *silent degradation* of that net for the
   remainder of the quota week - the only signal is an incident file.

Not something to patch in code today. It is a resilience gap to decide on:

- Classify quota/limit responses as a distinct terminal state (NEEDS-OPERATOR / DEFERRED)
  instead of an ordinary exit-1 failure, and back off to hourly - or until the reset time
  parsed out of the message - rather than retrying every five minutes.
- Surface it in the sentinel digest / UI as "maintenance unavailable: quota" so it is
  visible rather than buried.
- Decide whether nightly maintenance should depend on a metered LLM subscription at all,
  or whether the deterministic checks should run independently of it.

The incident template already carries an `## Outcome` section awaiting
FIXED / MITIGATED / NOT-A-DEFECT / NEEDS-OPERATOR from a repair session - and that repair
session is precisely what the quota is blocking. Recommend recording it as NEEDS-OPERATOR with
the options above.
