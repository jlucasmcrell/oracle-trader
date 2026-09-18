# Oracle Trader -- Complete Session Report
**Date:** 2026-09-18
**Repo:** G:\PROJECTS\oracle-trader
**Branch / HEAD:** main @ 7dce78f (7 commits, tree clean, no remote)
**Written for:** handoff to a developer or frontier LLM with no prior context.

---

## 0. How to read this document

Sections 1-2 are orientation. Section 3 is the audit trail of everything FIXED.
Section 4 lists things that look like bugs and are not -- **read this before
re-auditing anything.** Section 5 is a record of my own wrong conclusions and the
methodological lesson behind them (this matters: the same trap produced a false
positive in five separate places this session). Sections 6-7 are what remains.
Section 8 is measurement evidence you can reproduce.

Every number in this document was re-derived from disk at 11:08 local on
2026-09-18, not recalled. Where a figure came from an earlier snapshot, the
scope is stated.

---

## 1. Verified end state

All re-run at 11:08 local, 2026-09-18.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | **rc=0** |
| Full suite | `npm test` | **17/17 suites pass, 0 failures, 9.0s** |
| Git tree | `git status --short` | **clean** |
| Git history | `git rev-list --count HEAD` | **7 commits**, 304 tracked files |
| Git remote | `git remote -v` | **none** (nothing is published) |
| App process | `Get-Process electron` | **4 procs, main pid 45588**, started 10:19:11 |
| Scheduled tasks | maintenance triggers | **07:00 AND 11:30 daily, both live** |
| PII (HEAD + all commits) | fixed-string scans + positive control | **only placeholders; 0 emails** |
| Incident | `data/sentinel/incidents/` | **1 OPEN** (see 7.1) |

`npm test` now exists as a single command. Before this session there were 17
separate `test:*` scripts and **no aggregator** -- so "all suites pass" was not
reproducible, and a suite could sit unwired and unrun indefinitely.

---

## 2. Executive summary

### What was actually wrong

The headline defect was **a fee model wrong by the wrong amount, in the wrong
direction, on the input that grades strategies.** Kalshi's real fee -- measured
against 2,857 of this account's own fills -- ceils the ORDER TOTAL to four
decimal places. The code ceiled to the cent, which overstated fees by about
42% in aggregate and far more on small orders. A second, independent defect
(N1) divided an already-per-contract fee by contracts a second time, an error
of exactly C-times that is exactly zero at 1 contract -- so it was invisible at
the current $1 stake and would switch on precisely when the account scaled.

Both feed the promotion metric that decides which strategy arms get capital.
The system was grading candidates against a fictional cost basis.

Separately: **multi-outcome paper positions could be bought and could never be
closed or settled** (A1/A2) -- the position key included an `answerId` that one
code path sent and no other path ever read back.

### What is fixed

Fee model (canonical module, six divergent implementations collapsed, empirically
validated); N1; the fee-cache poisoning bug; the unguarded account/position reads;
the multi-outcome plumbing; the quoter's queue-position-losing restore; shadow-mode
gating and cooldown; a self-defeating sentinel retry loop; the maintenance task's
missing exit-code propagation; Polymarket fee rounding in the paper lab; and two
never-invoked test suites wired in.

### What is not

Manifold removal is **prepped but not started** (section 6.1 -- it is a 23-code-file
refactor with two shared branches that also serve Polymarket US). Per-arm stake
escalation is **blocked pending a loss-distribution analysis** (6.2). `/decrease`
is shipped, correct, and **arithmetically inert at the current stake size** (6.3).

### The strategic finding

The quoter amends **52.8%** of its quotes (861 of 1632). On Kalshi, amending a
resting order's PRICE forfeits queue position; shrinking SIZE preserves it. The
amended quote therefore forfeits its place in line on every price correction, and
the shadow meter shows all shadow quotes marking out **negative at roughly -2c**
whether the entry gates allowed or blocked them. The gates do not separate
cohorts. Re-tuning `quoterMinEdgeCents` cannot fix this because the dial is not
the mechanism. Detail in section 8.3 -- this is the single most actionable
finding in the session.

---

## 3. Defect ledger -- FIXED

IDs are carried from the source audits so they reconcile with those documents:
`docs/AUDIT-CODE-API-STRATEGY-2026-09-18.md` (N-series, D-series),
`docs/AUDIT-BUGS-2026-09-18.md` (A-series).

### 3.1 Fee model and accounting

| ID | Sev | Root cause | Fix | Verification |
|---|---|---|---|---|
| **D1** | HIGH | Fee ceiled to the cent ($0.01). Venue ceils the order total to **$0.0001**. | `KALSHI_BALANCE_PRECISION` 0.01 -> 0.0001; `kalshiOrderFeeDollars` ceils to 4dp. | 4dp matched **91.2%** of taker fills vs 1.9% for cent-ceil. |
| **N1** | HIGH* | `netCentsOf` divided an already per-contract fee by contracts again. Error exactly C-times; **exactly zero at C=1**. | One line. Removed the second division. | Invariant test: `entryFeeDollars(t)*100/C === netCentsOf` fee term. Fails at every C>1 pre-fix. |
| **N2** | HIGH | **Six** independent fee implementations, three of which divided by contracts before the ceil, one with **no rounding at all** (`paper.ts`), two hardcoding `0.07` where the venue applies `0.07 * mult`. | Collapsed into `src/main/util/kalshiFee.ts` (canonical). `kalshiOrderFeeCents` retained as a deprecated 1-contract shim (a test pins its values). | All call sites re-pointed; suite green. |
| **N3** | MED | A **failed** `/series` lookup cached `{mult: 1}` for the full 24h TTL. One transient 429 silently mispriced every fee on that series for a day (2x on the 0.5x S&P/Nasdaq series). | Failures are no longer cached. | Code read + retry path traced. |
| **N6** | LOW | `res.fee` invariant undocumented. | Documented. | -- |
| **Migration v27** | -- | `netSum`/`netSq` are running **sums**, so they cannot be filtered by timestamp -- only cleared. | v27 clears the net-cents accumulators. `n`/`wins`/`brierSum` preserved (the fee term never touched them). `perfByStrategy` untouched (cash ledger, already correct). | Note: my own plan said v26; v26 was already taken by `meanReversionMaxHoursToClose`. |

\* N1 severity is conditional: **dormant at `amountPerTrade = 1`**, live at 5. It is
differential -- it distorts cheap-leg arms more than expensive-leg arms, which
distorts the ranking the ladder promotes on. It switches on exactly when scaled.

### 3.2 Integrity and robustness

| ID | Sev | Root cause | Fix |
|---|---|---|---|
| **D6** | MED | **All three** reads at `engine.ts:473` (`getAccount`, `getPositions`, `getOpenOrders`) were unguarded -- not one, as first reported. A transient API failure fabricated a zero-equity view. | Single consolidated guard serving the last good snapshot. |
| **A1/A2** | HIGH | Multi-outcome paper positions: `getPositions` omitted `answerId` and `settle` took no parameter, so `sell` built a key that never matched -> `throw 'No paper position to sell'`, and settlement returned `null` -> payout never credited, position never deleted. | Fixed on all four legs: buy, sell, settle, getPositions, plus `TradeRecord.answerId`. **No migration needed** -- verified zero `answerId` entries existed on disk. |
| **A3** | MED | The quoter's size-restore fired on a **size mismatch**, and the shrink *created* that mismatch. Sequence: shrink -> 60s -> amend sends full size **and a new price** -> forfeits the very queue position Tier-1 exists to protect. | (The restore was later removed entirely -- see 3.3.) |
| **A4** | MED | Shadow mode was **not** API-free: `getOrderQueuePosition` ran before the enablement gate. And `shrunkAt` was only written in the enabled path, so the cooldown never armed and the branch re-fired **every tick per candidate**. | Probe moved behind the gate; cooldown state written on both paths. |
| **A6** | LOW | `kalshiNetEdgeCents()` -- zero callers, name promised a net edge, returned the **negated fee** (a sign trap at the most sensitive gate). | Deleted. |
| **A7** | LOW | `toNum()` maps a missing API field to a real `0`. For queue position, `0` means **front of queue** -- the best case. Coercion biased the evidence deciding the `/decrease` go-live. | Added `toNumOpt` for the two paths where a fabricated 0 is a lie. |
| **Sentinel loop** | MED | Maintenance exits 1 on an LLM weekly quota limit; the sentinel restarts the task and dispatches an LLM repair session. **The repair session needs the same exhausted quota as the failure** -- neither remedy can ever succeed, and it burned one of three daily repair slots on an unfixable condition. | Detects a usage limit, scopes the check to the log **tail** (so an early quota hit cannot mask a later real fault), notifies once per day, stands down. `--dry` returns `dispatched: null`. |
| **Maintenance** | MED | The 07:00 run can **only** fail on an exhausted week (quota resets 11am), and the task reported **success the whole time** because `maintenance.ps1` never propagated its exit code. | Per-day idempotence guard; **11:30 catch-up trigger** added; real exit-code propagation. Both triggers verified present, action untouched. |
| **poly-paper.test.ts** | MED | Suite existed, passed, and **had no `package.json` entry** -- so it never ran. Same mechanism that let A1/A2 survive: a green test nobody invokes is indistinguishable from no test. | Wired in, along with `paper-mc`. |
| **polyPaper fee** | MED | Polymarket paper lab billed the exact fractional fee. Measured against 432 real Poly fills: **round-to-nearest-cent matched 85 of 87 fee-paying fills (97.7%)**; the unrounded fraction matched 2. The lab that grades Poly strategies before real money was mispricing every order. | `Math.round(shares*...*100)/100`, order-level, matching Kalshi's shape. Documented in-file with the measured match rates. |
| **Rebate** | LOW | Maker rebates were being *modelled as income* without evidence. | Reconciler now **records** rebates (they arrive as negative fees) but never credits them. See 8.4. |

### 3.3 Quoter -- the queue-position fixes

Three separate changes, in order:

1. **A4** -- probe behind the gate, cooldown armed on both paths.
2. **A3** -- restore made revert-driven instead of timer-driven. (Superseded.)
3. **Restore removed entirely.** The prior reasoning rested on a premise the
   official docs contradict: *"preserves queue position only when the amendment
   decreases size; increasing size or changing price forfeit queue position."*
   A standalone restore **can never** preserve the slot -- it trades a
   front-of-queue slot for a back-of-queue one to gain size that, now at the
   back, will not fill. It also fired on *favourable* reversion. Removed.
   Full size now returns only via a genuine reprice.

**Deliberately NOT changed:** the 3c reprice threshold. Beyond 3c the quote is
genuinely wrong and repricing is correct; widening it would need evidence, not a
guess.

### 3.4 Enhancements shipped

- **`decreaseOrder`** + **`getOrderQueuePosition`** adapter methods (`kalshi.ts`,
  interface in `venue.ts`). Uses `reduce_to` (idempotent) on remaining count.
  Verified against the vendored changelog: `reduce_to` = "the remaining count";
  `reduce_to: 0` cancels. The `reduce_to <= filledSoFar` hazard that would
  silently convert a shrink into a full cancel is therefore structurally avoided.
- **Tier-1 queue-preserving shrink** in `quoter.ts` -- see 6.3 for why it is
  inert at current stake.
- **Config plumbing**: `quoterDecreaseEnabled` through interface, persisted-config
  type, defaults, `quoterCfg()`.
- **`npm test`** -- `scripts/tests/run-all.cjs` derives the suite list from
  `package.json`, so wiring a suite in is the only step needed. Verified it can
  go red: all 17 suites do set failure exit codes.

The new feature is **inert by default and triple-gated**: `quoterEnabled` (off)
-> armed -> `quoterDecreaseEnabled` (off).

---

## 4. Investigated and DISMISSED -- do not re-audit

These were reported as defects, chased, and disproven. Each is listed with the
evidence so nobody spends the tokens again.

| Claim | Verdict | Evidence |
|---|---|---|
| **D2**: `fee_multiplier: 0 -> 1` overcharges a fee-free market | **NOT A BUG** | Kalshi signals free/waived series via `fee_waiver_expiration_time`, not a zero multiplier. `fee_multiplier` is a plain multiplier. Coercing 0->1 errs **conservative** (overstates fees); preserving 0 would understate and lose money on trades that only look profitable. |
| **N7**: a $1.00 IOC is possible via `clamp01` | **NOT A BUG** | `clamp01` caps at 0.99 and **is** applied. While checking I suspected a NO-leg sign error and traced it: correct. `limitPrice` is documented as always the YES-leg price. |
| **A8**: non-Kalshi venues inherit Kalshi's fee shape | **WITHDRAWN** | `polymarketUs.ts` already sets `feeRate` from the venue's own `feeCoefficient`, and the paper non-Kalshi branch **is** Polymarket US's published model. The real coefficient is **0.0695 as of 2026-09-17** (already encoded), within 0.7% of Kalshi's 0.07. Changing a live gate for 0.7% conservative delta is churn. |
| **A9**: IBKR lab spams 275+ warnings | **NOT A DEFECT** | `ibkrLab.ts` and `fillReconciler.ts` already throttle exactly that, with comments citing the original incident. The 275 warnings were historical log lines. |
| **A5**: `/decrease` body may be missing `side` | **UNVERIFIED, fails safe** | The endpoint page is not vendored, so `side` cannot be confirmed. `reduce_to` semantics are verified. A wrong body is caught and logged, never fatal. |
| **`kalshiNormaliseMultiplier` returns `1` in the shipped bundle** | **ROLLUP FOLD, semantically exact** | Looked like a shipped 2x fee error. Chased to ground: clean tsc, clean tree, one `kalshiFee.ts` on disk, symbol found in 4 of 6,280 files, no aliases, esbuild alone preserves it, `--sourcemap` build ingested the correct source. **Not one caller ever passes a multiplier** (verified at `cryptoConvergence.ts:119`, `leadLag.ts:613`, `leadLag.ts:646`, `dutchBook.ts:93`), so Rollup proved the parameter always `undefined` and folded it. Auspicious false positive, correctly retired. |
| **"fee TTL=0 re-fetch storm"** | **DOES NOT EXIST** | No `ttl = 0` anywhere. The real bug was the opposite (N3). |
| **`settlement.ts`** (a phantom file cited by the original audit) | **EXPLAINED** | `ladder.ts:1234` reads `byStrategy['settlement']` -- `settlement` is a **strategy key**, not a module. Skimming strategy keys reasonably produces that citation. |
| **N8: exit path bypasses the kill switch** | **DELIBERATE** | Operator confirmed: flattening after a trip is usually what you want, and testing cannot happen while killed. Comment updated to say so explicitly, so nobody "fixes" it. |

---

## 5. Corrections to my own prior claims

Recorded because the pattern matters more than the individual errors.

| I claimed | Reality |
|---|---|
| "the app isn't running live" | **It was.** Live Kalshi arm, 2,826 fills archived. |
| "the quoter records no markout / it is unmeasurable" | **Wrong.** `markWatch` is populated; markout events are in the shadow log. I then measured it (8.3). |
| "-1.93c markout over n=1,083 for the quoter" | **Unsubstantiated.** Those values are a leadLag cohort and a weather backtest. Struck from all docs. |
| "shadow mode is API-free" | **Wrong.** Probe ran before the gate (A4). Corrected. |
| "A3 is timer-driven" | **Imprecise.** It was size-mismatch-driven, and the shrink created the mismatch. |
| "12/12 suites pass" | Baseline was **15**. Now 17. |
| "Manifold: 177 files / 49 refs" | **23 code files** (+27 docs) = 50 tracked refs. The 177 came from counting gitignored `.bak_*` clutter. |
| "cent-ceil overstates fees +23%" | **+42%** aggregate ($108.70 modelled vs $76.68 charged). The +2.37% is the *shipping 4dp model's* residual error. Two different things; I conflated them. |
| "verified `amount = shares x price` on all 2,857 rows as a consistency check" | **Vacuous.** `fillReconciler.ts:79` *computes* `amount` that way. An identity by construction can never fail. |
| "no personal paths in the docs" | **Wrong.** Real PII found -- see 7.2. I had scanned the filesystem, not the committed index. |
| "D1 needs `/series` + `/portfolio/balance`" | Better: **`/series` + `/portfolio/fills`**. Fills report `fee_cost` directly. |
| "the maker rebate is the largest un-monetised item" | **Overstated.** The formula is real but matched **1 fill in 432**. See 8.4. |

### The standing lesson

**A check that cannot go red reads exactly like a check that passed.** Five
separate false conclusions this session traced to the same root: a scan whose
pattern could never match, a consistency check over a computed identity, a grep
over stale duplicates, a ratio between mismatched units (`filled` counts
CONTRACTS, `placed` counts QUOTES -- never divide them), and a build-freshness
test via a string literal that the bundler had legitimately transformed
(esbuild inverted `0.0001` into `* 1e4`, so the constant appears nowhere).

Useful trap: piping a build into `Select-Object` then reading `$LASTEXITCODE`
reports *Select-Object's* exit code, not the build's. And in PowerShell,
`-E`/`-Pattern` with a variable proved unreliable; the fixed-string `-F` form
worked. **Every scan needs a positive control.**

---

## 6. Remaining work -- specced and ranked

### 6.1 Manifold removal (NEXT -- prepped, not started)

**Status:** inventoried, backed up, baseline recorded. Nothing changed.

**Scope: 23 code files** (+27 docs that mention it). Manifold is not merely a
sibling venue -- it is baked into **shared strategy logic as a special case**.
Two behavioural risks:

1. `miniAuto.ts:1255` -- a resolution branch **shared with Polymarket US**:
   `if ((this.venue === 'manifold' || this.venue === 'polymarket-us') && (resUpper === 'CANCEL' || resUpper === 'MKT'))`.
   The Poly half must remain **byte-identical**.
2. `miniAuto.ts:321` -- `this.config.fadeExitEnabled = this.venue === 'manifold'`.
   Removing Manifold makes this `false`, which is provably identical for Poly.

**Money-safety:** Manifold is **play money** (2 mana against a 900-mana balance).
No financial state to preserve.

**Two outright deletions:** `scripts/smoke-manifold.mjs`,
`scripts/verify-manifold.mjs`.

**Method:** drop `'manifold'` from the `VenueId` union in `src/shared/types.ts`
first -- `tsc` then surfaces every one of the ~50 edit sites as a compile error,
so nothing can be silently missed. There are also `// Never enable on Manifold`
comments and a `// 0 disables, which is where Manifold (play money) stays`
comment to clean up.

**Design question that must be answered, not mechanically edited:**
`App.tsx:502` is `<MiniAutoPanel venue={venue === 'kalshi' ? 'manifold' : venue}>`
-- on the **Kalshi tab, the Mini AutoTrader panel is bound to the Manifold
play-money venue.** Dormant (no `mini-auto-manifold.json` armed) but it means
"what should this panel target after Manifold is gone" is a real decision.

**Baseline for attribution:** tsc rc=0, 17/17 green. Backups in
`backups/_repair_20260918_manifold/`.

### 6.2 Per-arm stake escalation (BLOCKED pending analysis)

The plan: keep stakes at $1, but earn upward **per strategy arm** -- $1 until an
arm is positive over 50 trades, then $2, then $5. Arm-by-arm, not account-wide,
so winners are not promoted alongside losers.

**Blocker -- do this first.** The obvious candidate is Kalshi `fade`
(+$8.11, 242 trades, ~94% wins). **A 94% win rate is the signature of negative
skew**: many small wins, rare large losses. On 242 trades, one tail event can
erase the whole result. **Analyse the loss distribution before sizing up** --
that is the difference between scaling a winner and scaling a trap. Do not
implement escalation until the loss side is characterised.

### 6.3 `/decrease` at $5 (SHIPPED, INERT)

Code is complete and correct. It is **arithmetically unreachable at the current
stake**: the branch requires `remaining > 1` and shrinks by exactly one
(`reduceTo = remaining - 1`). The guard is right -- at `remaining = 1` you would
get `reduceTo = 0`, a cancel that forfeits the queue position the feature exists
to protect. But `amountPerTrade = 1` sizes one contract, so it never fires.

Live config as of 11:08: `quoterMaxContracts = 1`, `quoterDecreaseEnabled = false`,
quoter **parked** (`quotes[] = 0`).

**Correction to my own earlier advice:** I said to keep it shadow-logging and
compare picked-off rates. **Shadow cannot produce that data.** `tier1` appears
**0 times in 7,426** shadow-log lines, and `decreased` is absent from state
entirely -- the shadow meter is a separate simulation holding `state.shadow` and
never calls `placeOrder`, so `state.quotes` stays empty and the branch is
unreachable by construction.

**Recommendation: do not force it on.** The quoter is parked *with*
`operatorHold: true` on a 52.8% amend rate -- exactly the churn this feature
targets. Enabling a defensive feature on a strategy parked for cause, while its
measurement basis is unsettled, optimises the wrong thing. At count 2 it cuts
2 -> 1 (50%); a proportional rule would be more sensible than a fixed one.
Revisit at $5.

### 6.4 Polymarket scan-slice bug (blocks the only positive Poly arm)

`polyus-fade` is the only positive Poly arm (+$0.18) and **cannot fire**: the
scan sees a fixed 1,000-row slice of a 60,000+ catalogue, with `volume` null on
every row. Already in `docs/BACKLOG.md`. Real EV, but gated behind the parked
Poly strategies.

### 6.5 Fee-multiplier gap in two strategy-local helpers (LOW, zero impact today)

`leadLag.ts:613,646` and `cryptoConvergence.ts:119` call strategy-local fee
helpers **without passing a multiplier**, so on a non-unit-multiplier series
they would overstate fees 2x. The multiplier does reach the fee model correctly
by rate upstream (`kalshi.ts:1397,1463` -- `0.07 * mult`, cache correctly guarded
at `1440`), so **all accounting paths are right**.

**Currently zero-impact:** both arms trade mult-1.0 crypto, and it errs
conservative (skips trades rather than taking bad ones). Not fixed -- it is a
live-money gate change for a zero-impact issue. Also: the comment at
`kalshi.ts:1394` still claims `$0.000001` and is stale.

### 6.6 Smaller items

- **`flat` fee-type modelling** -- requires Kalshi's Specific Trading Fees Table,
  which is not vendored. Spec only.
- **MC auto-settlement** -- `Market.outcomes[]` has no per-answer resolution
  field, so automating it means guessing, which the codebase forbids. A2 makes
  it *correctly callable*; the trigger needs a venue field.
- **71 anomalous taker fills** (see 8.2) -- one API probe settles the cause.
- **`.bak` clutter** -- **73 `.bak_*` files inside `src/`** (gitignored, untracked).
  These are why the Manifold count was wrong. Now that git exists they are
  redundant. Recommend deleting; would be a one-liner, but it is a delete.
- **`docs/` records real balances and P&L in prose.** Normal for a private repo;
  scrub before any remote is made public.

### 6.7 Recommended order

1. `git init` -- **DONE** (7 commits, clean).
2. Verify the idle Polymarket arm -- **DONE** (parked with cause, 6.4).
3. Quoter queue discipline -- see 8.3 for the evidence; **this is the highest-EV
   remaining action.**
4. Rebate capture instrument -- **DONE** (records, never credits).
5. Maintenance retry after quota reset -- **DONE** (11:30 catch-up).
6. Manifold removal -- **next.**
7. Per-arm escalation at $5 -- after 6.2's loss-distribution analysis.
8. `/decrease` at $5.

Only the quoter change touches anything that trades.

---

## 7. Risk register

### 7.1 Open incident -- maintenance

`data/sentinel/incidents/2026-09-18T12-05-maintenance-failed.md` is **still OPEN**
(no Outcome written). Cause: LLM weekly quota exhausted. The 07:00 run cannot
succeed before the 11am reset, so the **11:30 catch-up is the first run that can
succeed** -- it had not yet fired at the time of writing (11:08). **Verified at 11:12: the task is Ready, both triggers are Enabled, and the per-day guard keys on SUCCESS -- it skips only when the log shows `] exit 0`, not on "already attempted" -- so the 07:00 failure does NOT suppress the 11:30 catch-up. Today's log contains no `exit 0`, so the catch-up will run.**

Note: `data/` is gitignored, so **the sentinel's incident record is not under
version control at all.**

### 7.2 Git and the backup that still holds PII

Git is initialised on `main`, **7 commits, no remote. Nothing is published.**

The original `.gitignore` was 7 lines and insufficient. Four categories were
excluded, and the `.gitignore` now carries an explanatory comment per rule:

| Excluded | What is actually in it |
|---|---|
| `data/` (1.88 GB measured) | real balances, fills, settlement history, a polymarket-consensus wallet address list |
| `tmp/` (0.36 GB measured) | Chromium **UI profiles** with cookies and session tokens |
| `backups/` | `config.json` + `kalshi-auto.json` with **encrypted credentials incl. a full RSA private key** |
| `.audit/` | real balance snapshot **and `Local State` -- the `os_crypt` key that decrypts Electron's saved cookies** |

`0.36 GB` and `1.88 GB` are measured, not estimated. The `.audit/` `Local State`
is the most dangerous file in the tree.

**PII was already committed** (a Windows username in home paths, a personal email
address, the hostname, and a first name). Because it was in history, scrubbing
the working tree was not sufficient -- it stayed readable via `git log -p`. With
no remote and no clones, history was rebuilt: orphan from root, scrub, re-commit,
cherry-pick the three fixes back so structure and messages survive, then
`reflog expire` + `gc --prune=now`.

**Independently re-verified this session across HEAD and all 7 commits:** every
`C:\Users\` occurrence is a placeholder (`<you>` / `<user>`), the email pattern
returns **zero** matches, and the scans were validated with a positive control
that returns 44 hits. Old objects are pruned and unreachable.

**OUTSTANDING -- requires operator action:** the pre-scrub `.git` is backed up
**outside the repo** at
`G:\PROJECTS\oracle-trader-backups\git-prePII-20260918-095819`. **That archive
still contains the old PII** (including the email and hostname). Delete it once
satisfied. It is the largest remaining exposure.

Left alone deliberately: `192.168.50.1` -- RFC1918, not routable, a common router
default, cannot identify anyone, and `dns-fallback.mjs` depends on its meaning.

### 7.3 The structural gap git does NOT close

Git protects **source and docs. It protects no state.** The source of truth for
this application lives in `%APPDATA%\oracle-trader` -- `ladder.json`,
`kalshi-auto.json`, `quoter-kalshi.json`, `fill-reconciler-*.json.fills.jsonl`,
`history.json`, `ibkr-lab.json` -- which is **outside the repo entirely**, plus
the repo's `data/` shadow logs, which are gitignored.

So `git init` did not make this application recoverable. There is currently **no
backup strategy for the state that the trading logic reads and writes.** This
should be the next infrastructure item after Manifold removal: a scheduled copy
of `%APPDATA%\oracle-trader` and `data/` to a separate volume.

### 7.4 Restart status

The app was **restarted at 10:19:11** (main pid 45588) and is healthy -- 4
processes, all arms scanning (`auto-trader scan 11.9s`, consensus, cull,
ibkr-lab, cross-venue). The restarted build carries: `polyPaper` cent rounding,
the quoter restore-removal, `fillReconciler` rebate detection, and the D1 4dp fee
model. Pre-restart check confirmed `openOrders` empty and 0 positions, so nothing
was orphaned at the venue.

**Any further source change requires another restart to take effect.**

---

## 8. Measurement evidence (reproducible)

### 8.1 Fee model -- the empirical basis

Two independent analyses, different populations, agreeing.

**Analysis 1 -- historical orders (2,505 orders, `fill-reconciler-kalshi.json.fills.jsonl`):**

| Fee model | Exact match |
|---|---|
| ceil to $0.0001 (4dp) | **96.6%** |
| ceil to $0.000001 (6dp -- the original audit's claim) | 10.9% |
| ceil to $0.01 (cent -- what the old code did) | 2.4% |

**Analysis 2 -- live verification (2,857 fills: 1,867 taker / 990 maker):**

| Metric | Value |
|---|---|
| 4dp exact match, taker fills | **91.2%** |
| 6dp exact match, taker fills | 10.1% |
| cent-ceil exact match, taker fills | 1.9% |
| 4dp exact match, clean single-row fills | **96.7%** |
| Aggregate overstatement, **shipping 4dp model** | **+2.37% ($1.83 on $77.12)** |
| Aggregate overstatement, **old cent-ceil** | **~+42% ($108.70 modelled vs $76.68 charged)** |

The fix cut the fee overstatement from roughly 42% to roughly 2.4%. The gap
between 96.6% and 91.2% is **population, not disagreement** (orders vs fills,
all vs taker-only).

**The number that matters most** is the inverse case: applying the taker model
to a maker fill would invent **$16.04 of phantom fees -- 21% of the entire fee
base**, quadruple the real residual. The code correctly uses `maker ? 0`, so
this is a guard-rail to keep, not a bug.

### 8.2 The 71-fill residual anomaly (cause UNKNOWN -- do not guess)

71 taker fills (3.8%) have round-dollar notionals ($1.00 / $3.00) where the
venue's own `fee` implies a count **one-quarter or one-half** of the venue's own
`shares`. Example: 60 contracts at 0.05, `amount` $3.00, but a fee equal to
exactly what 15 contracts would cost. Both fields are reported by the venue, so
**the cause is genuinely not known.** A sweep-concavity theory does not survive
the magnitude (one-quarter is far too large). Immaterial in dollars and errs
conservative, so **no code was changed for it.** One API probe settles it.

### 8.3 Quoter markout -- the key strategic evidence

**Live quoter state** (`%APPDATA%\oracle-trader\quoter-kalshi.json`, 11:08:17):

| Counter | Value |
|---|---|
| placed | **1632** |
| amended | **861 (52.8%)** |
| canceled | 873 |
| filled | **43.11 CONTRACTS** |
| `quotes[]` (resting) | **0** -- quoter parked |
| `lastError` | empty |

`filled` counts **contracts**; `placed` counts **quotes**. **These must never be
divided** -- the resulting "2.6% fill rate" is meaningless. (I made this error
and corrected it in three places.)

**Shadow meter** (`quoter-kalshi-shadow.jsonl`, 7,426 lines, span
2026-09-06T09:39 -> 2026-09-18T14:55; events: quote 3160, expired 1454,
proxy-fill 1144, markout15 1115, pulled 553):

| Cohort | n | clusters | mean markout | clustered SE | t |
|---|---|---|---|---|---|
| **allowed** (`gated=false`) | 42 | 26 | **-2.14c** | 1.24 | -1.73 |
| **blocked** (`gated=true`) | 1073 | 299 | **-1.99c** | 0.42 | -4.76 |

**Gap: -0.15c. The gates do not separate the cohorts.**

Maker fee is **0** on plain-`quadratic` series (`kalshi.ts:1430`; only
`quadratic_with_maker_fees` gets 0.0175 x mult), so **there is no fee component
in these numbers -- this is pure adverse selection.**

Caveat, stated plainly: the allowed cohort is **underpowered** (42 marked,
26 clusters), so treat its t as indicative only. The blocked side is solid.

**Interpretation.** A working gate set would show a large positive gap between
allowed and blocked. It shows none, and both cohorts are negative. That is
direct evidence that re-tuning `quoterMinEdgeCents` never moved the needle
**because it cannot** -- the dial is not the mechanism.

**The mechanism (hypothesis, well-supported):** Kalshi preserves queue position
when an amendment **decreases size**, and forfeits it when **price changes**.
`quoter.ts:989` amends on `Math.abs(existing.yesPrice - yesPrice) >= 0.03`, and
`amendOrder` always sends price **and** count. Therefore:

- When the price is **correct**, you just amended to it -> **back of the queue**.
  You fill only after everyone ahead is exhausted, i.e. under heavy flow -- and
  heavy flow into a correctly-priced quote usually means the taker knows
  something.
- When the price is **stale**, you were resting there first -> **front of the
  queue**. An informed taker hits you immediately.

**The policy places you at the front exactly when you are wrong and at the back
exactly when you are right.** That produces a negative markout with zero fees,
zero latency, and perfect knowledge of your own quotes. It is **not a speed
problem** -- faster polling makes it worse, because you forfeit the queue more
often.

**The proposed change:** two tiers. Shrink **in place** on a 1c adverse move
(preserving the slot, cutting the notional that gets picked off); reprice only
at 3c or crossed, where forfeiting is correct because the price is genuinely
wrong. Decrease **only the threatened side** -- the other leg is now the more
likely winner and should keep its slot. Exposure becomes continuous in staleness
instead of a step function.

**Use `reduce_to`, never `reduce_by`** -- the adapter retries, and `reduce_by` is
not idempotent.

### 8.4 Fee economics -- actionable at the stake level

Per-contract taker fee is `0.07 * p * (1-p)`; the order-level 4dp ceil adds at
most $0.0001 per order.

| Price | Fee per contract, per side | Round trip |
|---|---|---|
| 0.02 | 0.137c | 0.27c |
| 0.05 | 0.333c | 0.67c |
| 0.10 | 0.630c | 1.26c |
| 0.20 | 1.120c | 2.24c |
| **0.50** | **1.750c** | **3.50c** |
| 0.80 | 1.120c | 2.24c |
| 0.90 | 0.630c | 1.26c |
| 0.98 | 0.137c | 0.27c |

**Cheap contracts are nearly fee-free in tick terms; mid-priced contracts are
the worst** -- 12.8x the per-contract cost at p=0.50 vs p=0.02, because the fee
peaks at maximum uncertainty.

A taker strategy on a 50-80c contract needs **>3.5c of mispricing just to break
even**; one on a 5c contract needs 0.67c. This single fact explains which arms
can and cannot work. **Maker flow is structurally advantaged** -- maker fee is
exactly 0 on plain-quadratic series.

**Recommendation:** route taker flow to the cheap and >=0.90 bands; reserve the
mid band (0.20-0.80) for resting orders.

**Maker rebate** (`-0.0125 x C x p x (1-p)`): the formula is real -- one fill
matches it exactly -- but that is **1 fill in 432**. The other 345 zero-fee fills
are charged exactly zero, not credited. **Capture it, do not credit it**; a week
of logging will tell us whether it is 0.2% of maker fills or 40%.

---

## 9. Operational state and artifacts

### 9.1 Where state actually lives

| Path | Contents | In git? | Backed up? |
|---|---|---|---|
| `src/`, `scripts/`, `docs/` | source, tests, docs | **yes** | yes (git) |
| `%APPDATA%\oracle-trader` | ladder.json, kalshi-auto.json, quoter-kalshi.json, fill-reconciler-* | **no** (outside repo) | **no** |
| `data/` (1.88 GB) | shadow logs, sentinel incidents, cull-gate | **no** (gitignored) | **no** |
| `tmp/` (0.36 GB) | Chromium profiles, scratch | **no** (gitignored) | **no** |
| `backups/` | prior-session snapshots, credential-bearing configs | **no** (gitignored) | no |
| `.audit/` | balance snapshot, Electron `Local State` | **no** (gitignored) | no |

### 9.2 Commit history

```
d094e18  Initial commit: Oracle Trader prediction-market auto-trader
e725342  quoter: drop the standalone size restore (it forfeits queue position)
d81c9c4  reconciler: record maker-rebate credits instead of modelling them as income
e73ced0  maintenance: propagate exit code, add 11:30 catch-up, per-day guard
1727e78  docs: git setup + PII scrub
62db145  docs: restart + /decrease readiness
7dce78f  test: single-command suite runner (npm test); docs: live fee-model verification
```

### 9.3 Backups created this session

| Path | Contents |
|---|---|
| `backups/_repair_20260918/` | 12 files, pre-edit, first repair pass |
| `backups/_repair_20260918_enhance/` | 5 files, pre-edit, enhancement pass |
| `backups/_repair_20260918_d1/` | 4 files, pre-edit, D1 fee-precision fix |
| `backups/_repair_20260918_audit2/` | 11 files, pre-edit, bug-audit repairs |
| `backups/_repair_20260918_polyfee/` | pre-edit, Polymarket fee rounding |
| `backups/_repair_20260918_manifold/` | all 23 code files, pre-refactor (not yet edited) |
| `backups/_gitinit_20260918/` | pre-git snapshot |
| `G:\PROJECTS\oracle-trader-backups\git-prePII-20260918-095819` | **pre-scrub .git -- STILL HOLDS PII, delete when satisfied** |

### 9.4 Session documents

| Document | Contents |
|---|---|
| `docs/AUDIT-CODE-API-STRATEGY-2026-09-18.md` | original third-party audit |
| `docs/AUDIT-REVIEW-VERIFICATION-2026-09-18.md` | verification of that audit |
| `docs/AUDIT-BUGS-2026-09-18.md` | the A-series bug audit |
| `docs/REPAIR-PLAN-2026-09-18.md` | phased repair plan |
| `docs/REPAIR-COMPLETE-2026-09-18.md` | fee-module/N1 repairs |
| `docs/REPAIR-COMPLETE-2026-09-18-bug-audit.md` | A-series repairs |
| `docs/ENHANCEMENT-COMPLETE-2026-09-18.md` | `/decrease` + Tier-1 shrink |
| `docs/D1-EMPIRICAL-SETTLEMENT-2026-09-18.md` | the 4dp finding |
| `docs/FEE-MODEL-VERIFICATION-LIVE-2026-09-18.md` | live validation on 2,857 fills |
| `docs/GIT-SETUP-AND-REPAIRS-2026-09-18.md` | git + PII scrub |
| `docs/RESTART-AND-DECREASE-2026-09-18.md` | restart + `/decrease` readiness |
| `docs/DECISIONS-PLAIN-ENGLISH-2026-09-18.md` | plain-English decisions |
| `docs/SESSION-REPORT-2026-09-18.md` | **this document** |

### 9.5 Verification recipes

```powershell
cd G:\PROJECTS\oracle-trader

# Build + full suite (the one command that did not exist before today)
npx tsc --noEmit; npm test

# Git state
git status --short; git log --oneline --reverse; git remote -v

# PII scan ACROSS ALL HISTORY -- always run the positive control
git log -p --all | Select-String -SimpleMatch "C:\Users"   # expect only placeholders
git grep -o -h -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- .   # expect 0
git grep -c -F -e "APPDATA" -- .                          # POSITIVE CONTROL: expect 44

# Live quoter counters
$j = Get-Content "$env:APPDATA\oracle-trader\quoter-kalshi.json" -Raw | ConvertFrom-Json
"placed=$($j.placed) amended=$($j.amended) filled=$($j.filled)"

# Fee model: 4dp, not cent, not 6dp
Select-String -Path src\main\util\kalshiFee.ts -Pattern "0\.0001"
```

---

## 10. Bottom line

The money paths were in better shape than the audits implied, and most of the
day's value came from three things: **fixing the fee model against real fills**
(42% error -> 2.4%), **catching N1 before it was switched on by scaling**, and
**identifying that the quoter's problem is queue position, not gate tuning** --
supported by 1,115 shadow markouts showing the gates do not separate winners
from losers.

The largest unaddressed risks are not in the code. They are: **no backup exists
for the state files the trading logic reads** (7.3), **a pre-scrub git archive
still holds real PII** (7.2), and **a 94% win-rate arm is a candidate for
scaling without its loss distribution having been examined** (6.2).

Next action: Manifold removal (6.1), starting by dropping `'manifold'` from the
`VenueId` union so the compiler enumerates the work.
