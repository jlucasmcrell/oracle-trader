# D1  Fee-Rounding Question: Empirically Settled and Fixed (2026-09-18)

Status: **CLOSED and APPLIED.** The live fill archive settled the one question
the audit's D1 left open, and the fee model now matches the venue exactly.

---

## 1. What was open

The audit's D1 asked which rounding Kalshi actually applies to its quadratic
taker fee, because the in-repo documentation contradicted itself:

- `src/main/venues/kalshi.ts:1352` claimed "rounded up per fill to $0.000001" (6dp)
- `src/main/strategies/autoTrader.ts:4737` claimed "rounded up to the next cent" (2dp)
- the vendored `fixed-point.md` described a "rounding fee to restore balance
  precision" plus a rebate accumulator, without stating the precision.

The canonical fee module had been written conservatively to **snap to the cent**
(2dp), on the theory that the balance is cent-aligned and that overstating a
fee is the safe direction to be wrong in. That theory is now disproven.

## 2. The evidence

The app is live and its fill reconciler archives Kalshi's authoritative
`fee_cost` per fill to
`<userData>/fill-reconciler-kalshi.json.fills.jsonl` (`getFills()` copies
`fee_cost` verbatim  `kalshi.ts`; the reconciler persists it every few minutes).

Snapshot analysed: **2,826 fills / 2,505 distinct orders**, fees charged
through 2026-09-18 06:53 local.

For each order I compared the venue's charged fee against three candidate
models, each computed on the ORDER total (as the code already does):

| model | fee-bearing orders it matches exactly | share |
|---|---|---|
| **ceil to $0.0001 (4dp)** | 1,571 / 1,626 | **96.6%** |
| ceil to $0.000001 (6dp) | 178 / 1,626 | 10.9% |
| ceil to $0.01 (cent, old code) | 39 / 1,626 | 2.4% |

The 4dp rule matched 96.6% of orders *exactly*. The residual ~3.4% is the
expected tail: orders on sub-1x `fee_multiplier` series (ratio buckets 0.5 and
0.25  the latter is the maker-fee coefficient 0.0175 vs the taker 0.07) and
sub-$0.0001 notional dust. No rebate-accumulator behaviour is visible at the
sizes this account trades: the charged fee **is** the 4dp ceil.

Aggregate overstatement of the old cent-ceil: **1.42x** ($108.70 modelled vs
$76.68 actually charged). The audit's D1 direction was right; its specific
"ceil to 6dp" reading of the vendor doc is wrong in practice  the venue
settles at four decimals, not six.

## 3. What changed

Three source edits + two test files (all backed up byte-exact to
`backups\_repair_20260918_d1\` before editing):

1. **`src/main/util/kalshiFee.ts`**
   - `KALSHI_BALANCE_PRECISION = 0.01`  `0.0001`.
   - `kalshiOrderFeeDollars`: `Math.ceil(raw * 100 - EPS) / 100` 
     `Math.ceil(raw * 10000 - EPS) / 10000`.
   - Header rewritten: the "cent-snapped is cash-accurate" narrative is
     replaced with the empirical 4dp settlement.
   - `kalshiFeeCentsPerContract` doc comment corrected (at C=1 it is now
     1.75c at p=0.5, not the old whole-cent 2c).

2. **`src/main/strategies/leadLag.ts`**
   - The deprecated `kalshiTakerFeeCents(p)` no longer does its own
     `Math.ceil(7 * p * (1 - p) - 1e-9)`; it delegates to
     `kalshiTakerFeeCentsFor(p, 1)`, removing the last divergent cent-ceil in
     the codebase. (There were no live call sites  it existed only because
     tests pinned it.)

3. **`scripts/tests/kalshi-fee.test.ts`**  all pinned cent values moved to
   their 4dp equivalents; the "legacy overstated 7.1x" assertion now checks the
   order-level 4dp ceil amortises to ~1.02x; float-dust guard updated to 4dp.

4. **`scripts/tests/review-fixes.test.ts`**  the deprecated-helper pins and
   the `morningForecastVerdict` edge assertion updated (see below).

### The one test that legitimately moved

`morningForecastVerdict`'s edge is `(fair - ask)` net of the taker fee. The
test's own comment said the fee at ask=0.20 is "2c", pinning edge=13c. The
true fee at ask=0.20 is `0.07 * 0.20 * 0.80 = 0.0112 = 1.12c`, so the correct
edge is 15c  1.12c = **13.88c**. The pinned value moved 13  13.88 and the
comment was corrected.

## 4. Verification

- `npm run typecheck`  exit 0.
- Full test suite  **15/15 suites pass, 0 failures** (same 15 as the prior
  repair baseline; `test:fee` now 14 checks, `test:review` 512 checks,
  `test:migration` confirms v27 still clears net-cents evidence only).

## 5. Effect on behaviour (and the restart note)

The fee estimate is now **accurate** where it was pessimistic. Concretely, at
the $1-stake sizes the app currently trades:

- p=0.02, 1 contract: was 1c charged  now 0.14c
- p=0.05, 1 contract: was 1c  now 0.33c
- p=0.20, 1 contract: was 2c  now 1.12c
- p=0.50, 1 contract: was 2c  now 1.75c

The cheap-contract bands (the fade/weather domain) were being overcharged
37x. EV gates that read `kalshiFeeCentsPerContract` will now admit trades
that genuinely clear the real fee  this is the audit's F1 correction, and it
is the direction of "more accurate", not "more reckless": every gate now
compares against the fee the venue actually charges.

**The running process still holds the old model.** This is a source edit; it
takes effect on the app's next restart. No state migration is required (the
fee change does not touch persisted ledgers), but the app must be restarted to
pick it up. The fill archive already on disk is unaffected and remains the
ground truth this settlement was derived from.

## 6. Scratch artefacts (receipts, not code)

- `tmp/d1-fee-settle.mjs`  the reverse-engineering analysis (read-only).
- `tmp/apply-d1-fee-fix.mjs`, `tmp/apply-morning-test.mjs`  the exact-anchor
  patch scripts (each validates every anchor occurs exactly once before
  writing; they aborted on any mismatch).
- `backups\_repair_20260918_d1\`  byte-exact pre-edit copies of all four
  changed files.
