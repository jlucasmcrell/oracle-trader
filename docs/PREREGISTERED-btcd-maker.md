# Pre-registered test: passive (maker) fills on Kalshi crypto ladders at 80-95c

Registered 2026-09-02 14:35Z. Applies to events closing after this timestamp. Nothing below
changes after that; amendments are dated and restart scoring.

## Where this rule comes from (and why its bar is set the way it is)

The Jon-Becker Kalshi trade archive (67.8M settled trades, 193,341 events, through 2025-11-25)
was cut by category x hour x price band x time-to-close, event-clustered, with cells selected on
pre-2025 data and evaluated on 2025. The maker side of KXBTCD trades where the MAKER's own price
was 80-95c earned **+1.79c/contract [+1.14, +2.45]**, Bonferroni-corrected **[+0.34, +3.24]**,
N_eff 786 events, and KXBTCD carries no maker fee today (`fee_type: quadratic`, verified
2026-09-02). Two independent samples of our own point the same way: the hourly-ladder T-5
convergence replay (out-of-sample +2.4/+3.2c on 216 events, grid-selected) and the 15-minute
screen's 0.2-0.5% margin cells (positive, underpowered).

Because the selection burden was already paid on the Becker data (that is what the corrected
interval is), the forward test here is of ONE pre-specified rule and uses a plain 95% interval.
This is not a relaxation after seeing forward data; the forward data does not exist yet.

The Becker analysis is explicit that this is NOT spread capture: the touch is 1c wide. It is a
calibration mispricing (the resting price was wrong) that a taker also captures minus fees;
being the maker adds roughly the saved fee. The weather cell (KXHIGH*, +1.03c, N_eff 1,120) is
recorded as secondary because its capacity is tens of contracts at the touch.

## The rule (fixed)

Universe: Kalshi hourly ladders KXBTCD (primary); KXETHD, KXSOLD, KXXRPD (secondary, reported
separately and pooled). Events: every ladder close after registration.

Signal time: T = 5 minutes before close (the collector's existing capture window).

Side selection: for each strike in the T-5 book snapshot, if the YES side's best bid is in
[0.80, 0.95], rest a bid to buy YES at that best bid (join the queue); if the NO side's best bid
(= 1 - best yes ask) is in [0.80, 0.95], rest a bid to buy NO at that best bid. One resting
order per strike-side; a strike may qualify on at most one side.

Fill proxy (fixed, conservative): the order is filled if, in any later per-minute ladder record
for that strike before close, the opposite side's ask trades at or below our price (for YES:
yes_ask <= our bid; for NO: 1 - yes_bid <= our bid). Unfilled orders are dropped (no P&L).
The fill rate is reported alongside.

Cost: our resting price. Fee: zero on KXBTCD (quadratic); for the secondary coins the series
fee_type is checked and any maker fee applied.

Grading: settlement result. Net cents per contract = payout - cost - fee.

Clustering: by close timestamp (all coins close together; all strikes on one ladder share one
BTC path). Day-clustered interval reported alongside.

## The gate (fixed)

Pass requires ALL of:

1. At least 60 filled trades across at least 40 distinct close timestamps for KXBTCD alone
   (the secondary coins may not substitute).
2. Mean net cents per contract with a close-clustered 95% interval whose lower bound exceeds
   zero, AND a point estimate of at least +0.34c (the Becker corrected lower bound).
3. Day-clustered interval excludes zero.
4. Baseline: the opposite side at its own price over the same rows must be reported; if the
   opposite side is also positive, the result is a spread artifact of the fill proxy and the
   test fails.
5. Fill rate reported; if fewer than 30% of resting orders fill under the proxy, the rule is
   reported as non-executable regardless of P&L.

Passing authorizes: a maker executor for KXBTCD only (post-only, size <= 2% of touch depth,
one order per strike-side, cancel at T-1), a demo round-trip check, then tiny-live ($1-2 per
contract, cap 5 contracts per ladder) for 30 closes with a positive close-clustered interval
before any size. Never money directly from a pass.

## Amendments

(none)
