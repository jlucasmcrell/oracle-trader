# ORACLE TRADER - BUG FIX SESSION (AUDIT-BUGS-2026-09-18)

Date: 2026-09-18
Prepared by: RIFT Studio agent
Scope: fix the confirmed defects from `docs/AUDIT-BUGS-2026-09-18.md`, plus every
enhancement that could be completed safely in the same pass.
Status: **COMPLETE.** No outstanding permission requests.

---

## 0. TL;DR

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| A1 | Multi-outcome (MC) paper positions could never be SOLD - the stake was stranded | HIGH | FIXED (5 files) |
| A2 | MC paper positions could never be SETTLED - payout silently uncredited | HIGH | FIXED |
| A3 | Tier-1 shrink caused its own queue-forfeit cycle (timer-driven restore) | MEDIUM | FIXED |
| A4 | Tier-1 shadow mode was not API-free; branch re-fired every tick | MEDIUM | FIXED |
| A6 | `kalshiNetEdgeCents` - dead code whose name inverted its meaning | LOW | DELETED |
| A7 | `toNum` fabricated 0 for absent fields on the `/decrease` + queue paths | LOW | FIXED (scoped) |
| A9 | IBKR lab warning spam | - | **NOT A DEFECT** (already throttled) |
| A5 | `/decrease` request may need `side` | - | NOT verifiable offline; fails safe (see 6) |
| A8 | EV gate "inherits Kalshi fee shape" on Polymarket US | - | **NOT A DEFECT** (see 6) |
| NEW | Sentinel re-attempted a quota-blocked maintenance run forever | MEDIUM | FIXED |
| NEW | `poly-paper.test.ts` existed but was never wired into CI | MEDIUM | FIXED (wired) |

Verification: `npx tsc --noEmit` rc=0; **17/17 test suites pass, 0 failures**
(15 at baseline + `test:paper-mc` + `test:poly-paper`); `npm run quoter:gate` rc=0.

---

## 1. Backups and change set

Byte-exact pre-edit copies of every file touched in this session:

`G:\PROJECTS\oracle-trader\backups\_repair_20260918_audit2\`

11 files backed up, 10 changed, 1 (`autoTrader.ts`) backed up preemptively and
correctly left untouched. Every change was applied as an anchored string
replacement that asserts its own occurrence count (a drifted anchor aborts
instead of corrupting), then re-verified with a real diff against the backup.

| File | lines | sha256 (pre -> post) |
|------|-------|----------------------|
| `package.json` | 60 -> 62 | `01991292463dd087` -> `ee7c90e5d0f3324b` |
| `scripts/sentinel.mjs` | 623 -> 638 | `1f845281586c9a18` -> `7282c7ddb1341fe4` |
| `src/main/engine/engine.ts` | 828 -> 839 | `ce43ebd144922d86` -> `e45d460c9e17b06c` |
| `src/main/engine/paper.ts` | 249 -> 264 | `c3d6e0eaafeeb191` -> `6d77430fb5d19b63` |
| `src/main/strategies/quoter.ts` | 1283 -> 1320 | `200ed1d476a1878f` -> `d8fd373dcf838d46` |
| `src/main/util/kalshiFee.ts` | 203 -> 200 | `ff1fcd95a55b93d3` -> `bf71c62260208951` |
| `src/main/venues/kalshi.ts` | 1690 -> 1708 | `5a12ded06e52d82d` -> `44482fd4d5a585ba` |
| `src/renderer/src/App.tsx` | 755 -> 760 | `6a05e89a50aea305` -> `a826e03a1f4cb795` |
| `src/shared/types.ts` | 423 -> 426 | `d7e4951caba37700` -> `332640e61bf6f735` |
| `src/shared/venue.ts` | 129 -> 130 | `2f7abdbd989e37ea` -> `970d39b62c7940fb` |
| *(unchanged)* `src/main/strategies/autoTrader.ts` | 4029 | - |

New file: `scripts/tests/paper-mc.test.ts` (regression suite for A1/A2).

Reproducible tooling left in place under `tmp/`: `apply_audit_fixes.py` (the
anchored edit script), `fix_sentinel.py`, `tighten_sentinel.py`,
`add_engine_invariant2.py`, `wire_scripts.py`, `diff_check.py` (prints the whole
change set as a unified diff). Safe to delete at any time.

To revert everything: copy the backup tree back over `src/`, `scripts/` and
`package.json`. No state migration is required either way (see 2.6).

---

## 2. Fixes in detail

### 2.1 A1 + A2 - multi-outcome paper position identity (HIGH)

**Symptom.** Buying a specific answer on a multi-outcome market worked; there was
then no way to close it. `sell` failed with `No paper position to sell`, and on
resolution the position was never settled, so `balance += payout` never ran. The
stake disappeared from the ledger without appearing anywhere else.

**Root cause.** A paper position is keyed `marketId : outcome : answerId`
(`paper.ts`). All four legs of the identity were not consistent:

| leg | before | after |
|-----|--------|-------|
| `buy` (via `App.tsx` -> `engine`) | passed `answerId` - CORRECT | unchanged |
| `getPositionShares` | took `answerId` - CORRECT | unchanged |
| `sell` (`paper.ts`) | took `answerId` - CORRECT, **but the renderer never sent it** | renderer fixed |
| `getPositions` | **omitted `answerId`** so the UI could not even know it, and could not round-trip it | fixed |
| `settle` | **took no `answerId`** - looked up the binary key, missed, returned `null` | fixed |

So the credential existed in every signature except the two that mattered, and the
one caller that had it (`App.tsx`) dropped it. `Position.answerId` already existed
in the shared types - the field was there, the plumbing was not.

**Changes.**
1. `paper.ts getPositions()` - now returns `answerId: p.answerId`.
2. `paper.ts settle(marketId, outcome, winPrice, answerId?)` - keys the lookup on
   `answerId` and deletes that same key. `answerId` is optional, so every existing
   (binary) caller behaves exactly as before.
3. `engine.ts settlePaperPosition(..., answerId?)` - forwards it to the broker, and
   records it on the `TradeRecord`.
4. `engine.ts recordFill(..., answerId?)` - new optional 8th parameter, populated
   from `order.answerId` on the three buy paths and `req.answerId` on both sell
   paths.
5. `App.tsx` - the sell call now sends `answerId: pos.answerId`.
6. `types.ts` - `TradeRecord.answerId?: string`, with a comment noting that
   `outcome` holds readable answer TEXT, which is not a stable identity.

**Why HIGH, and why it matters to P&L.** No live strategy sets `answerId` today, so
no bot was losing money to this. It is rated HIGH because the *paper ledger is the
instrument that grades strategies before they receive real capital*. It contained a
class of position that could be opened and then never closed, which corrupts exactly
the measurements that decide where money goes. Separately, MC identity is what the
live Polymarket US path and the paper simulator must agree on; they did not.

**Verification.** `scripts/tests/paper-mc.test.ts` - 7 groups: answerId keying on
buy/settle/getPositions, a binary-key settle returning `null` (the old miss, kept as
a documented assertion), a losing answer being accounted (payout 0, full stake a
realized loss, position deleted), two sibling answers settling independently, sell
with `answerId`, persistence across a broker restart, plus two source invariants
(see 2.5).

**2.6 No migration needed.** The live paper state
(`%APPDATA%\oracle-trader\paper-kalshi.json`) contains **zero** `answerId` entries -
verified before editing. There are therefore no orphaned answer-keyed positions to
reconcile, and nothing to migrate.

### 2.2 A3 - the tier-1 shrink was causing its own queue forfeit (MEDIUM)

**Correcting my own audit first.** The audit described this as "restore is
timer-driven". The real mechanism is narrower and more clearly a bug: the old amend
condition was

```ts
if (crossed || (existing.count !== count && (shrunkAt === undefined || now - shrunkAt > cooldown)) || |delta| >= 0.03)
```

The reprice triggered on a **size mismatch**, and the shrink itself *created* that
mismatch. The amend then sent `count` (full target size) **and** `yesPrice`.
Amending a price on Kalshi forfeits queue position. So the sequence was:

1. fair value moves 1-3c adversely -> tier-1 shrinks (keeps the slot) - correct
2. `existing.count !== count` is now true forever
3. 60s later the cooldown lapses -> the amend restores **full size at a new price**
4. which forfeits the queue slot that step 1 existed to protect

Net effect: 60 seconds of protection, then status quo ante plus a forfeited slot. On
a slow drift this sawtoothed, paying a forfeit every 60s. The `shrunkAt` cooldown
masked it as intentional throttling. Note the important corollary: for a quote that
had *not* been shrunk, a 1-3c move already did not reprice - so the old code was not
"reprice on every small move". The shrink was the sole cause of the reprice.

**Change.** Replaced the size-mismatch trigger with an explicit price test:

```ts
const priceDelta = Math.abs(existing.yesPrice - yesPrice)
const restoreSize = existing.count !== count && priceDelta < 0.01
if (crossed || priceDelta >= 0.03 || restoreSize) {
  const amendPrice = restoreSize && !crossed ? existing.yesPrice : yesPrice
  ...
  existing.yesPrice = amendPrice
  existing.count = count
  existing.shrunkAt = undefined
}
```

Restore is now **revert-driven, not timer-driven** - which is the call you told me to
make (the option more likely to benefit trading). A size restore at an unchanged
price is a size-only amend, so it does not forfeit the slot. `>= 3c` still reprices:
at 3c the quote is genuinely wrong and forfeiting is correct. `crossed` still
cancels and reprices. `shrunkAt` is cleared on any amend so the tier-1 state cannot
leak into the next cycle.

**Expected effect.** The quoter stops paying a queue-forfeit toll on 1-3c round
trips, which is the mechanism behind the measured negative markout on an
adverse-selection-only cohort (maker fee is 0 on plain-`quadratic` series). It is
measurable: the shadow log holds `markout15` events by cohort.

### 2.3 A4 - tier-1 shadow mode was not free, and re-fired every tick (MEDIUM)

Two defects in the shadow branch:

1. The cooldown was armed only inside the `if (cfg.quoterDecreaseEnabled)` block. In
   shadow mode nothing was recorded, so `existing.shrunkAt` stayed `undefined`, the
   cooldown never armed, and the branch re-fired on **every tick for the same
   quote** - unbounded log growth for no order.
2. The queue-position probe ran **before** the enablement gate, so shadow mode
   issued one venue GET per candidate per tick.

This **corrects what I told you last session**: shadow mode was not API-free.

**Change.** `existing.shrunkAt = now` is now set in both modes (before the
enablement test), and the probe is throttled by a new
`QUEUE_PROBE_MIN_INTERVAL_MS = 15_000` using a `lastQueueProbeAt` instance field.
Combined with the cooldown, probes are now bounded to roughly one per quote per
minute instead of one per tick, while still generating the evidence the `/decrease`
go-live decision needs.

### 2.4 A6 - deleted `kalshiNetEdgeCents` (LOW)

It was exported, had **zero callers**, and its name promised a surviving net edge
while returning `-kalshiFeeCentsPerContract` - the negated fee. A caller adding it
to an edge would have double-counted the cost, i.e. double-charged itself at the
most sensitive gate in the system. Deleted rather than renamed, because
`kalshiFeeCentsPerContract` is the honest name for what it computed. A breadcrumb
comment remains in `kalshiFee.ts` explaining why it must not be reintroduced without
a sign test.

### 2.5 A7 - `toNum` fabricated 0 for absent fields (LOW, scoped fix)

`toNum(undefined) === 0` conflates "absent" with "zero". On most paths 0 is a benign
default, but on two it is a meaningful - and misleading - value:

* `getOrderQueuePosition` - 0 means "front of queue", the **best possible case**.
  Coercing an absent field to 0 therefore biased, in the optimistic direction, the
  very evidence that decides whether the `/decrease` policy goes live.
* `decreaseOrder` - `remaining_count` of 0 reads as "nothing left", so the caller
  would set `count = filledSoFar`, i.e. "fully filled", and stop managing a live
  order.

**Change.** Added `toNumOpt` (preserves absence) alongside `toNum`, and used it for
exactly those two fields. Signatures widened to `remainingCount: number | undefined`
and `Promise<number | undefined>` in `kalshi.ts` and in the `venue.ts` interface.
The quoter now treats an undefined `remainingCount` as "leave `count` unchanged and
log it", and an undefined queue position as `unknown` rather than `front`. `toNum`
itself is unchanged: on the other ~20 call sites 0 is the correct default, and
rewriting them all would have been churn.

**Two source invariants added to the test suite.** Because `answerId` on `settle` is
*optional*, TypeScript cannot catch its removal from a caller - passing fewer
arguments is legal. Both the renderer sell call and the engine forward are therefore
asserted statically in `paper-mc.test.ts`, naming A1/A2 in the failure message. This
is the leg that broke, and neither `tsc` nor 15 existing suites noticed.

### 2.7 NEW - sentinel re-attempted a quota-blocked maintenance run forever

**Finding.** `data/sentinel/incidents/2026-09-18T12-05-maintenance-failed.md` was
OPEN: the daily maintenance run exits 1 because the LLM behind it has hit a weekly
usage limit. `scripts/sentinel.mjs` responded by (a) restarting the task, and then
(b) dispatching an LLM repair session after 60 minutes - repeatedly.

**Why it can never work.** A usage limit is not a code fault, so neither remedy can
succeed: restarting the task changes nothing, and **the repair session needs the
same exhausted quota as the failure**. The loop also dilutes the sentinel's value,
because a repair slot is consumed by an unfixable condition (repairs are capped at 3
per day, so this burned a third of the day's self-repair budget).

**Change.** Before classifying as `maintenance-failed`, the sentinel now tests the
**tail** of the log for a usage-limit signature. Matched -> emit
`maintenance-quota` / `notify` **once per local day** and stand down (no restart, no
repair). Scoping to the tail is deliberate: an early quota hit must not mask a later
real fault, since the log is per-day. Non-quota failures take the original path
unchanged.

**Verification.** `node --check scripts/sentinel.mjs` rc=0; `node scripts/sentinel.mjs
--dry` now reports `key: "maintenance-quota"`, `dispatched: null`, and
`matched "hit your weekly limit"`, where it previously dispatched a repair session.

**Deliberately NOT done.** I did not add a "retry maintenance after the quota resets"
hook. It is technically easy (the message states the reset time) but it would spend
your freshly-reset weekly quota on a retroactive run without asking, and that
quota is a resource you may want elsewhere. Flagged in 6.4 as your call.

### 2.8 NEW - an entire test suite had never run

`scripts/tests/poly-paper.test.ts` exists on disk and **passes** when run, but it had
no `package.json` entry, so nothing ever invoked it. Wiring it in was one line.
This is a coverage bug rather than a code bug: a green test that never runs is
indistinguishable from no test, and the same mechanism is what let A1/A2 survive - a
feature whose *tests* were silent (`answerId` appeared in zero test files).

Also recorded: my earlier statement that the suite was "12/12" was wrong. The true
baseline was **15** suites; after this session it is **17**.

---

## 3. The change set, as a reviewer would read it

`tmp/diff_check.py` reproduces the complete unified diff of every file against its
backup. Highlights of what to look at first:

* `paper.ts` - `settle()` now computes `const key = this.key(marketId, outcome, answerId)`
  and uses it for both the get and the delete. If those two ever disagree, a position
  is looked up, mutated, and then deleted under a different key.
* `quoter.ts` - the amend block. Confirm the three triggers (`crossed`,
  `priceDelta >= 0.03`, `restoreSize`) and that `amendPrice` only falls back to
  `existing.yesPrice` when `restoreSize && !crossed`.
* `engine.ts` - `...(answerId ? { answerId } : {})` on both records. A conditional
  spread rather than `answerId: answerId`, so an absent value stays absent on the
  `TradeRecord` instead of serialising as an explicit `undefined`.

The edits were applied by script with per-edit occurrence assertions; all 22 anchors
matched their expected counts (3x for the three identical buy `recordFill` calls),
file encodings were preserved (no BOM introduced; per-file LF/CRLF style kept), and
non-ASCII character counts were asserted unchanged per file.

---

## 4. Verification summary

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | rc=0 |
| full `test:*` suite | **17/17 pass, 0 failures** |
| `npm run test:paper-mc` (new) | pass |
| `npm run test:poly-paper` (newly wired) | pass |
| `node --check scripts/sentinel.mjs` | rc=0 |
| `node scripts/sentinel.mjs --dry` | classifies `maintenance-quota`, `dispatched: null` |
| `npm run quoter:gate` | rc=0 |
| `tmp/diff_check.py` | 10/11 changed, `autoTrader.ts` untouched |

---

## 5. Restart

Source edits take effect on restart, so this restart picks up **both** today's bug
fixes and the earlier D1 fee-model change (fee settled at 4 decimals, verified
empirically against 2,505 real fills).

What to expect afterwards:
* The D1 fee model changes which trades clear the EV gates - specifically the
  cheap-contract arms that were being overcharged by 3-7x. More trades will now pass
  a gate they should have passed.
* The quoter is **still inert**: `quoterEnabled` is off, and even when armed,
  `quoterDecreaseEnabled` is off. All tier-1 activity remains log-only. A3/A4 change
  behaviour only when `quoterDecreaseEnabled` is turned on.
* Trades opened before the restart keep working: no migration was required.

---

## 6. Corrections and things I decided NOT to change

I would rather flag these than let you discover them later.

### 6.1 A5 - `/decrease` may need `side`: left as-is
`decreaseOrder` sends `{ ticker, reduce_to }` (plus `exchange_index` when known),
mirroring the working `amendOrder`. `reduce_to` semantics are verified from the
vendored index ("the remaining count"; 0 cancels) so the request cannot cancel an
order by accident. Whether the endpoint additionally needs `side` is not verifiable
offline: the endpoint's own page is not vendored, only the index entry. It **fails
safe** - a rejected body is caught and logged, never fatal - so I left it rather than
guess a field into a live order-management call. Add `side` only if the API starts
rejecting.

### 6.2 A8 - Polymarket US fee shape: NOT a defect
My audit claimed the EV gate "assumes a Kalshi-sized fee on a non-Kalshi market".
Checked properly, that is wrong on two counts:
* `polymarketUs.ts` already sets `feeRate: m.feeCoefficient` from the venue's own
  published coefficient, exactly as `kalshi.ts` does. The Kalshi fallback only
  applies when the venue omits a coefficient.
* The paper non-Kalshi branch is `feeRate * shares * p * (1 - p)` - which **is** the
  Polymarket US published model, not the Kalshi shape.

The real coefficient is also not what the public docs suggest. Polymarket US now
charges taker fees (`0.06` before, **`0.0695` effective 2026-09-17T03:59Z** - a date
the codebase already encodes in `polyPaperFee`), which is within 0.7% of Kalshi's
`0.07`. So the fallback's numeric error is immaterial and errs conservative (it
overstates cost, rejecting a few marginal trades rather than admitting bad ones).
Changing a live gate for a 0.7% conservative delta would have been churn, so I did
not. **The worthwhile finding is adjacent, see 6.4.**

### 6.3 A9 - IBKR warning spam: NOT a defect
`ibkrLab.ts` already throttles discovery to once per 10 minutes with a comment citing
the exact original incident, and `fillReconciler.ts` already dedupes gateway-down
errors to one line per 10 minutes ("209 lines in 3.5 h" is the incident it fixed).
The 275+ warnings I counted came from before that fix - they are historical log
lines, not current behaviour. Nothing to change.

### 6.4 Documented, not implemented - your call
1. **Maintenance retry after quota reset.** Easy to add (the message states the reset
   time); deliberately not done, because it spends your weekly quota without asking.
2. **Maker rebate on Polymarket US.** The venue's fee schedule pays a maker *rebate*
   (`-0.0125 x C x p x (1-p)`; -$0.31 per 100 contracts at p=0.50). Kalshi's maker fee
   on plain-`quadratic` series is 0, so the two venues are not equivalent for resting
   orders - and `microMakerEnabled` is forced ON for Polymarket US. `polyPaperFee`
   returns 0 for maker (a credit is modelled as free), so maker strategies are
   graded **pessimistically** by roughly that amount. That is a real, quantifiable
   income stream currently invisible to the strategy grader. Worth modelling.
3. **Polymarket US fee rounding - an open empirical question, exactly like D1.**
   `polyPaperFee` applies no rounding (`p=0.5`, 1 contract -> 0.017375), and the poly
   paper test pins that value. If the venue rounds to the cent, a sub-dollar paper
   trade differs by up to 17%. D1 was settled by reading real `/portfolio/fills`; the
   same archive can settle this one. Do not assume - measure.
4. **Tier-1 shrinks by exactly 1 contract** (`reduceTo = remaining - 1`) with a 60s
   cooldown. At your $1 stake that is 1-2 contracts, and the branch requires
   `remaining > 1`, so as implemented the protection will **rarely fire and barely
   reduce exposure** - the feature cannot deliver its purpose at this size. Fixing it
   means choosing a sizing rule (e.g. halve remaining, floor 1). I did not guess one:
   it changes fill rates, and there is no measurement yet to choose against. Decide
   it with the shadow data before enabling `quoterDecreaseEnabled`.
5. **MC automated settlement.** `Market.outcomes[]` carries no per-answer resolution
   field, so there is no honest way to settle an MC position automatically without
   guessing - which the codebase forbids. A2 makes per-answer settlement *callable*
   (and correct); automating the trigger needs a per-answer resolution field from the
   venue payload. `getPositionShares`/`settle`/`getPositions` are now consistent, so
   the manual path is sound in the meantime.
6. **Manifold** - untouched, as instructed. Note for a future cleanup: removing the
   venue would touch `types.ts` `VenueId`, the adapter registry, and paper state
   initialisation, and `miniAuto` carries Manifold-specific branches.

---

## 7. Value of this session, honestly

**Money-impacting.** A3 is the one that touches live quoting: it stops the quoter
forfeiting its queue position on 1-3c round trips, which is the mechanism behind the
negative markout on a cohort that pays no maker fee. It is inert until
`quoterDecreaseEnabled` is on, but it is the difference between Tier-1 working and
Tier-1 undoing itself.

**Instrument-correctness.** A1/A2/A4/A7 keep the paper ledger and the shadow
evidence trustworthy. The paper simulator is what votes on where real money goes; a
simulator that can strand a position, or shadow evidence that biases "front of queue"
in the optimistic direction, is worse than no measurement.

**Hygiene.** A6 (deleted a sign-inverted trap), the orphaned suite, the sentinel loop.

**Not found.** No defect in the money paths themselves. The fee model, the ladder, the
EV gates and the settlement accounting all survived the earlier D1 and fee-repair
sessions and are in good shape. Several candidates I chased did not survive contact
with the code (see 6.2, 6.3, and the earlier withdrawn list).

---

## 8. Open questions for you

1. `amountPerTrade` back to 5 - when? (Only relevant to N1-class scaling, already fixed.)
2. Enable `/decrease` shadow logging is already happening; **go live** only after 6.4
   item 4 (shrink sizing) is decided.
3. Quota re-run for maintenance after reset - yes or no (6.4 item 1).
4. Model the Polymarket US maker rebate (6.4 item 2)? This is the largest
   un-monetised item I found.

---

## 9. Repo status note

This project still has **no git repository** (`fatal: not a git repository`). Every
repair session has therefore been done with script-applied anchored edits plus
byte-exact directory backups. That works and is verifiable, but it is the hard way.
`git init` plus one commit before the next session would make changes reviewable as
diffs and revertible in one command.
