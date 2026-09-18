# Pre-registration — lead-lag beyond BTC/ETH (the round-91 coin expansion)

Written 2026-09-13 by the daily maintenance session, **after** the change went live (round 91 restarted the
app at 10:05:42Z), which is the reason it is written at all: the expansion shipped without a stop rule and
without a way for the ladder to see it. This document does not reverse it and does not change any setting.
It fixes the measurement, and names in advance the number that will decide it.

## What changed, and why the ladder cannot judge it

Round 91 widened `LEADLAG_COINS` (`src/main/strategies/leadLag.ts:112`) from `BTC, ETH` to
`BTC, ETH, SOL, XRP, DOGE, BNB, HYPE` and cut the poll interval to 10 s.

The ladder tracks the whole arm as **one** strategy — `{ id: 'kalshi-leadlag', ... }` in
`GENERIC_STRATEGIES` (`src/main/ladder/ladder.ts:129`) — and `leadLagEvidence()` joins every executed
sweep row regardless of coin. So:

- The five new coins settle into the same pooled verdict that promoted BTC/ETH to notch **x4**.
- A pool cannot stop a subset. If the new coins are negative and BTC/ETH carries the average, the arm
  keeps trading them and the ladder's stop rule never fires on the part that is losing.
- The stage baseline (`since` = 2026-09-11T12:10:35Z, next checkpoint at 100 settlements) was earned
  entirely by BTC/ETH, and will now be *completed* by a mixture.

That is an evidence-integrity gap, not an opinion about whether the expansion is good. The operator's standing rule
is that every strategy is stopped by its stop rule; this one has none of its own.

## First reading (information only — far below the bar)

`node scripts/leadlag-coins.mjs --check`, on the read-only dump `tmp/k-2026-09-13.json`, covering the
**first 55 minutes** after the expansion went live:

| cohort | mkts | contracts | net | c/contract |
|---|---|---|---|---|
| all seven (what the ladder sees) | 19 | 216 | -$9.90 | -4.58c |
| BTC/ETH (established) | 5 | 40 | +$2.00 | +5.01c |
| five new coins | 14 | 176 | **-$11.91** | **-6.76c** |

Per coin: XRP -24.5c (40 contracts), DOGE -13.8c (24), HYPE -3.9c (8), SOL -3.9c (56), BNB +7.7c (48),
BTC +13.5c (16), ETH -0.7c (24).

Over the **last 24 h** the same script reads BTC/ETH +$1.39 over 623 contracts (+0.22c, 2 day-clusters,
95% [-18.18, +18.63]) — that is, the established pair has been roughly flat for a day, and the whole
-$10.51 pooled loss over the window is the new coins.

**None of this is evidence yet.** One day-cluster, 55 minutes, 14 markets. The project's own bar refuses
verdicts under five day-clusters, and it is refused here too. The numbers are recorded so that the reading
is not re-derived later, and because the *volume* shift is already a fact and not a sample: the new coins
took 218 of 274 sweep fills (80%) in that first hour, so within a day this arm is mostly not the arm the
ladder promoted.

## Hypothesis

The Kalshi/Polymarket 15-minute lead-lag dislocation the arm trades on BTC and ETH also exists, net of
fees, on SOL, XRP, DOGE, BNB and HYPE.

The reason to doubt it is specific rather than general: these five have thinner Kalshi books and thinner
Polymarket CLOB books, and the arm's entry is a marketable IOC. A dislocation measured against a thin
book's mid is more likely to be the book's noise, and the IOC pays the wider spread to find out. The one
gate that already exists for this, `leadLagMaxSpreadCents` (default 5.0c), bounds the *Polymarket* book
only; nothing bounds the Kalshi side the IOC actually crosses.

## Decision rule (fixed now; no re-fitting later)

Measured by `node scripts/leadlag-coins.mjs --json` on a fresh read-only Kalshi dump, on the venue ledger,
netting exchange-netted pairs (`revenue/100 + min(yes,no) - costs - fees`, as `scripts/venue-pnl.py`
does), cohort = the five coins that are not BTC or ETH, `--since 2026-09-13T10:05:00Z`.

Judged only once **both** of these hold:

- at least **400 contracts** settled on the new-coin cohort, and
- at least **5 day-clusters**.

Then, on the day-clustered 95% interval (t on G-1 df, the round-73 correction):

- **upper bound < 0** → the expansion is losing. Narrow `LEADLAG_COINS` back to `BTC, ETH`.
- **lower bound > 0** → the expansion is earning. Leave it, and record that BTC/ETH-only is no longer
  the arm's definition.
- **neither** → undecided; keep collecting and re-read daily. If it is still undecided at
  **2026-10-04** (three weeks), narrow back to BTC/ETH by default: an arm that cannot be shown to earn
  after three weeks at ~200 contracts an hour is not being held back by sample size.

A per-coin narrowing (dropping only the worst coin) is deliberately **not** offered. Five cohorts read at
one interval each is five chances to find a winner by looking; the cohort was defined as a group when it
shipped and it is judged as a group.

## What this does NOT do

- It places no orders, changes no flag, and touches no size, limit or ladder setting. `leadLagCoins` is
  a source constant; changing it is a code change for the session that reaches the decision date, not a
  panel setting for the operator.
- It does not alter `leadLagMaxContractsPerWindow` (24, = 3 x the 8-contract clip) or
  `leadLagMaxSpendPerWindow` ($60). Those were checked on 2026-09-13 and are **binding and working**:
  the 07:00Z window filled to exactly 24 contracts on SOL and on XRP and spent ~$59 of the $60. They are
  doing their job; whether $60 a window is the right size for a $142 account is the operator's call, not the
  ladder's, and it is raised in the report rather than changed here.

## Stop on the arm as a whole

Unchanged. The ladder's existing `kalshi-leadlag` stage stop still applies to the pool and still fires
first if the pool goes badly enough. This document adds a stop for the *subset* the pool can hide.


## Addendum 2026-09-13 11:39Z (the interactive session, round 93)

Read the same morning and acted on: the five new coins now sweep at **2 contracts** (`leadLagNewCoinContracts`,
the ladder's entry size for this arm) instead of the 8 BTC/ETH earned, and their executed rows are **excluded
from the ladder's pooled evidence** (`leadLagRowCounts` keeps proven coins only; rows without a coin field
still count). The cohort stop above stands unchanged. Added, so the gate has both directions:

- **lower bound > 0** at the same bar (>= 400 contracts, >= 5 day-clusters) -> promote: add the coin(s) to
  `leadLagProvenCoins` in `kalshi-auto.json`; they take the ladder's size and join its pool from that point.
- At micro size the 400-contract bar is ~200 fills, so the 2026-10-04 default-narrowing date is unchanged.

The per-coin script and its daily reading are unaffected by the size change; contracts are contracts.


## Addendum 2026-09-13 ~11:50Z (round 94, after the daily kill switch)

The cohort's first 1.5 h at full size lost $31.6 across two correlated windows (six coins each way at
once). Round 94 caps coins per direction per window at 2 and the window spend at $15; with round 93's
micro size, the cohort's contracts per fill are a quarter of today's. The 400-contract bar and the
2026-10-04 date stand. Today's fills count toward the bar.

## Implementation addendum 2026-09-15 07:50Z

The repair/review deployment makes existing window spend, contract and direction reservations durable
across app restarts. Reservations are saved before submission; uncertain order responses keep their
budget until the window ends. The legacy-state upgrade holds new lead-lag entries until 08:00Z while
continuing observation. Shared sub-engine daily-loss enforcement now uses the persistent equity-based
check. Lead-lag ladder uncertainty now clusters settlements by UTC day instead of ticker.

This records an implementation boundary, not a new cohort or verdict. Existing fills, coin membership,
sizes, thresholds, hard stops and the October 4 deadline remain intact. No held-out experiment is graded
early. The descriptive live-account analysis and repair evidence are in the
[September 15 viability report](G:/PROJECTS/oracle-trader/docs/reports/ORACLE-TRADER-VIABILITY-REVIEW-2026-09-15.md).

## Operator amendment 2026-09-16 07:35Z — cohort collection paused

The operator directed Oracle to restore the winning-period BTC/ETH configuration while retaining one additional coin,
because he does not consider coin count or identity the likely cause. No cohort verdict was read. HYPE is the
single retained exploratory coin because it was positive in the latest six-hour venue ledger; SOL, XRP, DOGE and
BNB stop receiving new lead-lag entries. The original five-coin gate remains attached only to its already
collected cohort and cannot be satisfied with later HYPE-only trades. Existing positions and orders are untouched.

## Operator amendment 2026-09-17 08:16Z — cohort collection resumed, ZEC added

The operator asked to expand lead-lag beyond BTC/ETH/HYPE. Evidence read before the change, and descriptive only: every recorded
gap since 2026-09-13 10:05Z graded at the quoted Kalshi price (`scripts/backtests/leadlag_counterfactual.py`) earns
+6.8c to +7.9c per contract on each of SOL, XRP, DOGE, BNB and HYPE, the same as BTC (+6.9c) and ETH (+7.5c). The
cohort's live losses came in the slow-execution period (REVIEW-CHANGES §108-§109), not from a coin-specific signal.
No cohort verdict was read. From 08:16Z all eight coins trade: SOL, XRP, DOGE and BNB resume, and ZEC is added
(Kalshi KXZEC15M on CF Benchmarks ZECUSDRTI, Polymarket zec-updown-15m on Chainlink TWAP). Sizing is the ladder's micro
test: one contract per sweep for every coin, two coins per direction per window, $15 per window. Fills from 08:16Z
onward are a new collection period on a fixed execution path; report them separately from 09-13 to 09-16. ZEC is
reported on its own line and is not part of the original five-coin gate. The 400-contract bar and the 2026-10-04
deadline stand; at one contract per sweep the bar will take longer, which is a reason to extend the date when it is
reached, not to raise size early.

**Amendment 2026-09-17 09:56Z (REVIEW-CHANGES §111).** Dislocation rows before 09:40Z priced Kalshi from a cached
list endpoint, 20-40 s stale. Any per-coin graded-signal comparison in this registration uses only rows with
`kalshiSource == 'orderbook'`. Fill-based per-coin results are unaffected.
