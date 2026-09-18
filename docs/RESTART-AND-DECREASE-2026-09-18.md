# Restart, `/decrease` Requirements, and a Fee-Multiplier Audit

2026-09-18. Follow-up to `REPAIR-COMPLETE-2026-09-18-bug-audit.md` and the git/PII session.

Two things were asked: restart the app, and determine what `/decrease` needs in order to work.
A third thing fell out of verifying the restart, and it is the most interesting of the three.

---

# Part 1 - The restart

## What was picked up

The running instance was a **09:34:20 build**. The launcher (`Start Oracle Trader.bat`) runs
`npx electron-vite build` and then starts Electron, so the running code is frozen at the moment the
launcher last ran. Three fixes landed in `src` **after** that build and were therefore not live:

| Time | File | Fix that was not live |
|---|---|---|
| 09:38:47 | `polyPaper.ts` | Polymarket fee rounding to the cent (97.7% empirical match, n=87 charged fills) |
| 10:00:20 | `quoter.ts` | Q1 - removal of the queue-destroying restore amend |
| 10:00:20 | `fillReconciler.ts` | R2 - maker-rebate detection (`rebate` counter, negative-fee logging) |

The D1 fee-model fix (4-decimal settlement) *was* already live, having landed 09:07:03, before the
09:34 build.

## How the restart was done

1. `npx tsc --noEmit` -> rc 0.
2. `npx electron-vite build` -> rc 0, captured explicitly (`> log 2>&1; $rc=$LASTEXITCODE`). Note:
   piping a build into `Select-Object` and reading `$LASTEXITCODE` afterwards reports the exit code
   of `Select-Object`, not the build. That is a trap worth knowing.
3. Verified the bundle actually contains the new fee model **before** swapping instances (see
   Part 3 - the first attempt at this verification gave a false negative).
4. Killed the app: main pid 52192; all 4 Electron processes exited with it (verified count = 0).
5. Relaunched exactly as the launcher does -
   `Start-Process node_modules\electron\dist\electron.exe -ArgumentList '.' -WorkingDirectory <root>` -
   so the app is detached and not a child of this session.
6. Verified: 4 Electron processes up (main pid 45588), and still up on a second check 10s later.

Pre-restart state check: `state.openOrders` empty, `positions` 0, no tracked resting orders.
Nothing was orphaned at the venue by the restart.

## Verification the app came up healthy

Startup banner at 14:19:12Z, followed by every arm scanning normally within 40 seconds:

- `[kalshi] account-verified request pacing: 10 reads/s, 15 writes/s`
- `[kalshi] positions merged 28`
- `[quoter] 104 fee-free series in "Climate and Weather" matching ^KX(HIGH|LOW)` (series discovery OK)
- `[leadlag] scanned 8 15m crypto pairs (7 live CLOB books)`
- `[convergence]`, `[dutch]`, `[cull]`, `[ibkr-lab]`, `[poly-paper]` all cycling

No startup errors. The only `errors` counters in the log are routine per-scan counts
(`[poly-paper] ... 2 errors`), not exceptions. State files (`kalshi-auto.json`, `leadlag.json`,
`crypto-convergence.json`, `dutch-book.json`, quote archives) all began updating again.

---

# Part 2 - What `/decrease` actually needs to work

## The gate chain, with live values

The Tier-1 shrink branch is `quoter.ts:1006-1044`. Every condition below must hold simultaneously.

| # | Condition | Source | Live value | Status |
|---|---|---|---|---|
| 1 | A live resting quote exists (`existing` non-null) | `state.quotes` | `quotes: []` | **FAILS** |
| 2 | The quote has not crossed | `!crossed` (1007) | - | - |
| 3 | Fair value moved adversely | `adverseMove` (1009) | - | - |
| 4 | Move is >= 1c and < 3c | `microDeltaCents` (1008, 1012) | - | - |
| 5 | `remaining > 1` where `remaining = count - filledSoFar` | 1010, 1012 | `count = 1` | **FAILS** |
| 6 | `adapter.decreaseOrder` exists | 1012 | yes (`kalshi.ts`) | OK |
| 7 | 60s cooldown since last shrink | 1011, 1012 | - | - |
| 8 | `cfg.quoterDecreaseEnabled` true -> real API call | 1033 | `false` | **shadow-only** |

And the higher-level gates that decide whether the quoter is trading at all:

| Setting | Source | Live value |
|---|---|---|
| `executionMode` | `config.json` | `live` |
| `liveArmed` | `kalshi-auto.json` | `true` |
| `ladderEnabled` | `kalshi-auto.json` | `true` |
| **`quoterEnabled`** | `kalshi-auto.json` | **`false`** |
| **`quoterMaxContracts`** | `kalshi-auto.json` | **`1`** |
| `quoterShadowEnabled` | `kalshi-auto.json` | `true` |
| **`quoterDecreaseEnabled`** | `kalshi-auto.json` | **`false`** |
| `amountPerTrade` | `kalshi-auto.json` | `1` |
| quoter ladder entry | `ladder.json` | `stage: "disabled"`, `operatorHold: true`, `notch: 1` |

## So, to make it work, four things must change

1. **`quoterEnabled: true`** and **clear the ladder `operatorHold`** on the quoter (its stage is
   `disabled`). Without both, `canTrade` is false, the code takes the shadow branch, and no order
   ever rests - so `existing` is never populated and the branch is unreachable.
2. **`quoterMaxContracts >= 2`.** The branch requires `remaining > 1` and shrinks by exactly one:
   `reduceTo = remaining - 1` (1018). That guard is **correct and necessary** - at `remaining = 1`,
   `reduceTo` would be 0, which is a *cancel*, forfeiting the very queue position the feature exists
   to protect. But it means at `count = 1` the feature is arithmetically inert.
   `quoterMaxContracts` is ladder-set (`sizesFor('quoter', notch)` -> `notch`), and notch is 1.
3. **`quoterDecreaseEnabled: true`** to send the real call. Until then line 1032 logs
   `tier1 shrink ... (shadow)` and nothing is sent.
4. A resting quote that clears conditions 2-4 and 7.

## The structural blocker, and why my earlier advice was wrong

**At `amountPerTrade = 1` the quoter sizes one contract per side, so condition 2 can never be met.**
`/decrease` is not merely "unlikely to fire at $1 stakes" - it is **unreachable**. The feature only
becomes meaningful when size >= 2, i.e. when - or if - the stake goes to $5 with notch >= 2.
At `count = 2` it cuts 2->1 (50%); at `count = 4`, 4->3 (25%). A proportional rule would be more
sensible than a fixed one contract, but that is a behaviour change needing evidence.

**Correction to my own earlier recommendation.** I previously advised: keep it shadow-logging and
test whether the quotes it would have shrunk get picked off more often than those it would not.
**Shadow mode cannot produce that data.** Empirically: `tier1` appears **0 times in 7,401 lines**
of `quoter-kalshi-shadow.jsonl`, and `decreased` is absent from the quoter state entirely (the
counter is only incremented inside the `quoterDecreaseEnabled` branch). The reason is structural:
the shadow meter is a **separate simulation** that maintains `state.shadow`, never calls
`placeOrder`, and never populates `state.quotes`. Since `existing` (1006) comes only from
`state.quotes`, which is written only by a real `placeOrder` (line 1119), **the branch is
unreachable in shadow mode by construction**. A shadow experiment on Tier-1 is impossible; it can
only be measured live.

## Recommendation

**Do not force it on.** The correct path is: raise size (notch >= 2, i.e. the $5 decision) -> make
the quoter live again -> then enable `quoterDecreaseEnabled`. But note that step 2 is a separate
decision the evidence constrains, not an oversight: the quoter is `disabled` **with
`operatorHold: true`**, i.e. deliberately parked, on a record of `placed: 1632`, `amended: 861`,
`canceled: 873`, `filled: 43.11` contracts - a **53% amend rate**, which is exactly the
queue-position churn the Q1 fix and this feature both target. Enabling `/decrease` on a strategy
that is parked for cause, while its measurement basis is still being repaired, would be optimizing
the wrong thing.

The code is correct; the limitation is arithmetic. Nothing here needs fixing before the stake rises.

---

# Part 3 - New audit finding: the fee multiplier

This began as a suspected HIGH-severity defect and ended as a **withdrawn** suspicion plus a real,
narrower finding. Both halves are recorded, because the reasoning matters for whoever reads this next.

## 3.1 The withdrawn suspicion (do not re-litigate)

While verifying the restart I grepped the built bundle for the new fee constant and found a
**stale "rounded up per fill to $0.000001" comment**, no `KALSHI_BALANCE_PRECISION`, and - most
alarmingly - this in `out/main/index.js`:

```js
function kalshiNormaliseMultiplier(multiplier) {
  return 1;
}
function kalshiTakerRate(multiplier) {
  return KALSHI_TAKER_FEE_COEF * kalshiNormaliseMultiplier();
}
```

The source says `return multiplier`. Running the artifact confirmed it: `takerRate(0.5) = 0.07`
instead of `0.035`. That looked like a shipped 2x fee error on every 0.5x series.

I chased it down properly rather than reporting it:

- `tsc --noEmit` clean; `git status` clean; only ONE `kalshiFee.ts` on disk, correct.
- No duplicate definition anywhere: a search of **6,280 files** (including `node_modules`) found the
  identifier in exactly four places - the source, two backups, and the bundle.
- No path alias in `tsconfig.json`; all imports are relative; `electron.vite.config.ts` is clean.
- esbuild's transform alone (0.25.12, all non-minified modes) **preserves the body correctly**.
- Built with `--sourcemap` and read `sourcesContent`: the bundler **ingested the correct source**
  (lines 95-99 with the full guard, and `kalshiTakerRate(multiplier)` at 173 and 192).
- Then grepped every call site of the exported helpers.

**The emitted simplification is CORRECT.** Every call site in the entire program omits the
multiplier argument:

```
cryptoConvergence.ts:119  kalshiTakerOrderFeeDollars(price, count)
dutchBook.ts:93           kalshiTakerOrderFeeDollars(p, count)
leadLag.ts:44             kalshiTakerFeeCentsFor(p, 1)
leadLag.ts:613            kalshiTakerFeeCentsFor(kYesAsk, sweepSizeFor(pair.coin, cfg))
leadLag.ts:646            kalshiTakerFeeCentsFor(noCost, sweepSizeFor(pair.coin, cfg))
```

Rollup performed whole-program analysis, proved `multiplier` is `undefined` at every call site,
folded `kalshiNormaliseMultiplier(undefined)` to `1`, and dropped the now-unused argument. The
emitted code is **semantically identical** to the source. My initial read was a false positive -
the third time in this engagement that a too-fast read produced a wrong conclusion.

**Verification-method lesson:** grepping a bundle for a source literal is not a valid freshness
check. The D1 fix *was* present, written as `Math.ceil(raw * 1e4 - EPS) / 1e4` - esbuild had
inverted it to a multiply, so `0.0001` legitimately appears nowhere. A green check is not
automatically a trustworthy one; confirm the transform, not the string.

## 3.2 The real finding: the multiplier is bypassed in two strategies

The multiplier reaches the fee model **upstream**, by rate, in the paths that matter:

```
kalshi.ts:1397  feeRate: KALSHI_TAKER_FEE_COEF * (this.seriesFeeCache.get(seriesOf(m) ?? '')?.mult ?? 1)
kalshi.ts:1463  m.feeRate = KALSHI_TAKER_FEE_COEF * c.mult
```

and the cache population is correctly guarded (`kalshi.ts:1440`):

```ts
mult: typeof mult === 'number' && mult > 0 ? mult : 1
```

So `autoTrader` (via `t.feeRate`), `paper.ts` (via the passed `feeRate`), `candidatePacket` and
`dutchBook` all get the right rate. **No defect there.**

But the two strategy-local helpers never receive it:

- `leadLag.ts:43` - `kalshiTakerFeeCents(p)` -> `kalshiTakerFeeCentsFor(p, 1)`, documented as
  one-contract and deprecated for sizing. Its own doc comment says
  *"Multi-contract callers must use kalshiTakerFeeCentsFor(p, contracts, multiplier)"* - and then
  lines 613 and 646 call it with `(price, count)` and **no multiplier**.
- `cryptoConvergence.ts:118` - `calcTakerFee(price, count)` -> `kalshiTakerOrderFeeDollars(price, count)`.

Consequence: for any series whose `fee_multiplier != 1`, both arms **overstate the fee by exactly
`1/mult`** - 2x at mult 0.5, which is the S&P/Nasdaq index case. Both feed an EV/dislocation gate,
so the effect is to reject some genuinely profitable trades.

**Severity: LOW, and currently zero-impact.** `leadLag` trades 15m crypto pairs and
`cryptoConvergence` trades crypto ladders; both are mult 1.0 series, so today the bypass costs
nothing. It is a latent trap, and it errs **conservative** (overstating fees skips trades rather
than taking bad ones), so it is not a money-losing bug. Fix when convenient: thread the series
multiplier, or delete the vestigial `multiplier` parameters and rename these helpers so the API
stops advertising a capability no caller uses.

Not fixed in this session: touching both gates' fee inputs is a behaviour change on live-money
strategy code for a currently-zero-impact issue, and the current D1 fee-model basis is only just
settled. Recorded for the next session.

## 3.3 The stale comment

`kalshi.ts:1394` still reads *"rounded up per fill to $0.000001"*. That is the pre-D1 model. The
fee now settles to $0.0001 (four decimals), which the live-fill audit established (96.6% exact match
over 2,505 orders). The comment is wrong and appears in the built bundle, so it misleads anyone
reading shipped output. A one-line comment fix, not done here.

---

# Summary

| Item | State |
|---|---|
| App restarted | Done, clean, 10:19 local, 4 processes, all arms scanning |
| Live code | Now includes poly fee rounding, Q1 quoter fix, R2 rebate detection, D1 4dp fee model |
| `/decrease` | Correct, but unreachable at `count = 1`; needs `quoterEnabled` + ladder unhold + notch >= 2 + `quoterDecreaseEnabled`. Not enabled - quoter is parked for cause |
| Shadow test of `/decrease` | Impossible by construction; 0 `tier1` lines in 7,401 shadow-log entries |
| Fee multiplier | Applied correctly upstream in all accounting paths; bypassed in `leadLag` + `cryptoConvergence` (LOW, zero-impact today, conservative) |
| Bundler "stub" | Disproven - rollup's folding is semantically exact. Withdrawn |
| `kalshi.ts:1394` comment | Stale ($0.000001 -> $0.0001). Not fixed |
