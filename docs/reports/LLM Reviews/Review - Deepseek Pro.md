I've read the repository (local tree at `G:\PROJECTS\oracle-trader`, confirmed it is the same tree as the GitHub repo via `git log`/`git remote`), the four ordered docs, the fee-model verification and D1 settlement docs, the gap-floor pre-registration, and the actual trading/statistical code (`autoTrader.ts`, `leadLag.ts`, `ladder.ts`, `engine.ts`, `kalshiFee.ts`). Here is the report.

---

# Oracle-Trader review — findings

## Orientation on calibration

The operator's own record is unusually honest — several of my strongest findings are *already written down* in the docs (backlog items 83, 85, 127, 1652; the trade history's own §4). Where that is the case I say so, and I only report the part that is **new, worse-than-stated, or wrongly closed**, per the brief. Three things matter up front:

1. The account is **net negative** over the measured period, and post-weather-retirement still net negative.
2. The one arm that made money (lead-lag) has a **forward edge that is a fifth** of the number the operator is anchoring on as "the target."
3. The fee model and the ladder's ranking metric were **both wrong, in opposite directions, until 2026-09-18** — which means essentially all pre-09-18 evidence is contaminated, and the evaluation machinery was frozen by the fix in a way the fix itself did not fully account for.

---

## Findings

### M-01 — The lead-lag "gap floor" pre-registration is post-hoc threshold mining, not a pre-registration
**Area:** methodology · **Severity:** high · **Confidence:** verified
**Location:** `docs/PREREGISTERED-leadlag-gap-floor.md` (whole file); rule cites `leadLag.ts:607, 613–625`

**Claim:** The change raising `leadLagMinDislocationCents` 4→6 is presented as pre-registered, but the 6c cut point was chosen by mining the same 3,883-contract sample that will now judge it.

**Evidence:** The file grades every executed sweep "since 2026-09-07 … keyed by the raw gap the engine recorded at decision time," builds a grid of buckets (4–6c, 6–8c, 8–10c, 10–12c, 12c+), finds that "the 4–6c bucket is the only one that is never positive," and sets the floor there. Then it also grids "minutes left in the window" and finds a second boundary ("gap < 6c with 3 or more minutes left" loses in every era). The two cut points — 6c and 3 minutes — are both chosen *from* the sample, not from first principles, and no Bonferroni/holdout is applied despite this being a grid search, which the operator's own evidence doctrine §12.4 says requires a correction. The counterfactual table then shows the rule turning a losing era into a winner (`B+C -$69.19 → -$10.11`), which is exactly what you get when you cut on in-sample losses.

**Failure:** The rule is judged by the same data that selected it, so its stop condition ("day-clustered 95% upper bound < 0 → revert") is biased toward passing. Even on its own numbers, the 6c+ bucket in the *honest-quote* era is **+0.45c/contract over 93 contracts** — i.e. the floor does **not** restore the edge in the regime that matters; it mostly just removes volume.

**Test:** Re-derive the floor from a cause (e.g. "gap must exceed 2× the taker fee plus the expected settlement-basis loss") rather than from the bucket table, or hold out era A entirely and require the 6c rule to be positive in era D alone. If the rule was chosen *before* looking at the 4–6c bucket's performance, the pre-registration should be re-dated and the choice justified independently.

---

### M-02 — "+8.94c/contract is the target" is the single most likely-wrong belief in the record
**Area:** methodology / profitability · **Severity:** high · **Confidence:** verified
**Location:** `docs/reports/TRADE-HISTORY-2026-09-18-what-won-what-lost.md` §3–§5; `docs/BACKLOG.md` item 1652

**Claim:** The operator's conclusion that era A's +8.94c is "the target, not a fluke to be explained away" does not survive the operator's own data: the forward edge on honest quotes is **+1.35c signal / +1.86c realized — a fifth of era A**.

**Evidence:** §4 states directly: era A's Kalshi price "came from a cached list endpoint. Gaps that looked like 10c were often 0c … the measurement and the trade shared the same wrong price." Era D (live orderbook quotes, 57 ms median latency) grades "+1.35c/contract, and realized fills +1.86c — both are a fifth of period A's +8.94c." Backlog 1652 concedes: "If the orderbook-graded net is not positive after fees, lead-lag's edge claim rests on period A's fills alone." Era A's boundary (09-07→09-12) is itself selected after the fact — §3 literally titles it "the winning streak."

**Failure:** Sizing and gate decisions made against a +8.94c target will be wrong by ~5×. Era B+C shows what happens when size and cadence are tuned to the stale-quote era: **-$57.34 on 2,853 contracts** (and BTC/ETH, "unchanged," went +8.94c → -1.83c on their own). Chasing the +8.94c number is precisely what produced the losing era.

**Test:** Treat +1.4–1.9c/contract as the null for forward planning; any sizing/cadence change should be judged against whether it survives at that number, not at +8.94c.

---

### S-01 — Lead-lag is not arbitrage: it is latency-alpha net of a settlement-basis tail, and the tail grows with size
**Area:** settlement mechanics / profitability · **Severity:** high · **Confidence:** verified (numbers), hypothesis (magnitude of the forward tail)
**Location:** `docs/BACKLOG.md` items 83, 1178, 1252; `docs/DEVELOPER-HANDBOOK.md` §10.1; `leadLag.ts:613–625` (no basis adjustment anywhere in the gate)

**Claim:** The strategy buys a Kalshi contract that settles on CF Benchmarks' 60s average, priced against a Polymarket mid that prices Chainlink's 60s TWAP. The two indices disagree on 2.1–2.4% of matched windows, and the strategy does not model this.

**Evidence:** Backlog 83 ("REAL, 2.1% of windows") and the rerun ("37 of 1,545 matched windows disagreed (2.4%); **13 of our fills sat in divergent windows**"). §10.1: the divergence happens "always with the index within about a basis point of the strike" — i.e. precisely the coin-flip regime where a 4–6c dislocation trade is live. `leadLag.ts` computes `netCents = gapCents - feeCents` against `poly.mid` with no settlement-source adjustment.

**Failure:** The edge is the *residual* of (latency alpha ~ a few cents) minus (a ~2% chance of losing the **entire** position). The second term is a full-position loss, so it scales linearly with contracts/sweep while the alpha term is capacity-limited. At the 8-contract sweep the operator wants (backlog 85, 881), each divergent fill costs ~$3–8 — many times a day's worth of 1.4c edges. This is the structural reason era B+C's losses were "mostly in the divergent windows," and it means scaling size **amplifies the risk term faster than the edge term**.

**Test:** Cheap and already partially done — the settlement-basis rerun (backlog 1252) should be extended to price the tail *per position size*: expected daily edge = α·N·P(win) − fullPos·P(divergent fill). That single number is the real risk-adjusted edge, and it is not in any doc.

---

### P-01 — The measured run-rate is negative and the realistic ceiling is single-digit dollars per week
**Area:** profitability · **Severity:** high · **Confidence:** verified
**Location:** `docs/reports/TRADE-HISTORY-2026-09-18-what-won-what-lost.md` (account totals); `docs/BACKLOG.md` items 35, 85, 1622

**Claim:** Net of everything, the system has not demonstrated a positive-expectation run-rate, and the arithmetic of $200 capital / $1 positions / a ~1.4–1.9c edge caps the ceiling at a few dollars a week before overhead.

**Evidence:** Account total **-$54.32**; weather maker -$45.97 retired 09-09. Post-09-09 days sum to about **-$14.83** (09-10→09-18: +5.66, +8.41, +33.39, -22.87, -3.69, -25.98, -10.10, -2.01, +3.36). The only positive-expectation process is lead-lag at +1.4–1.9c/contract, capacity-pinned at 8 contracts × ~1 sweep per 3 windows (backlog 85), with an edge that measured **+18c → -3c as sweep latency went 0.07s → 14s** (backlog 1622). Backlog 35 quantifies the structural tax: taker fee as a fraction of stake is **0.07·(1−P) = 6.3% at 10c, 3.5% at 50c, 0.7% at 90c** — lead-lag trades near 50c, where the fee (~1.75c) is the same order as the edge (~1.4–1.9c).

**Failure:** At +1.5c/contract on ~$1 contracts, ~250 contracts/day best case is ~$3–4/day *gross*, before basis losses and the occasional bad day (BTC -$33.51 in one window, per the history). Overhead (OpenRouter credits, operator time) is an order of magnitude larger. The system is a research program whose *measured* results do not yet support scaling, and the docs' "what won" framing overstates the going-forward expectation.

**Test:** Compute forward expected P&L/day at the honest-quote edge and current caps, *including* the settlement-basis tail and a latency-degradation term. If that number is < ~$3/day, the honest conclusion is that this is tuition, not a strategy.

---

### M-03 — The ladder has no family-wise error control across ~18 simultaneous arms
**Area:** methodology · **Severity:** medium · **Confidence:** verified
**Location:** `ladder.ts` (`decideStage` uses one-sided 80% bands, `CONFIDENCE_Z = 0.84`; the only `lbBonferroni` is `ladder.ts:540`, scoped to the BTC convergence gate, not to arm promotion)

**Claim:** With ~18 arms each evaluated at one-sided 80% confidence at repeated checkpoints, false scale-ups are expected and are not corrected for; the only Bonferroni in the codebase is in a different mechanism.

**Evidence:** `decideStage` scales up when `netDollars > 0 && lo > 0` (lower 80% band > 0), with no adjustment for the number of arms being tested. The operator's evidence doctrine §12.4 *requires* a Bonferroni "where a grid of rules was searched first," and it is applied in the BTC gate but not here. The -$5 hard stop bounds each arm's downside, but it does not bound the *aggregate* tuition across arms × notches, which at this bankroll is material.

**Failure:** Several "significant" arms will be noise; each gets scaled to x2/x4 and loses its -$5 stop before demotion. The trade history already shows this pattern in sports ("two single clusters, not a process," correctly labeled). The risk is that the same single-cluster effect reads as a real arm in a market the operator trusts.

**Test:** Cheap — count the arms, apply Holm/Bonferroni to the per-arm lower-bound test, and re-derive the promotion thresholds. Even a documented *decision* not to correct (because stops bound it) is a better state than the current implicit one.

---

### M-04 — The v27 fee-evidence clear froze the ladder for every arm promoted before 09-18, because the per-strategy baseline was not reset
**Area:** correctness / methodology · **Severity:** medium · **Confidence:** verified
**Location:** `autoTrader.ts:1000–1027` (v27 clear deletes `netN/netSum/netSq/byEvent/byDay`); `ladder.ts:1081` (`n = Math.max(0, (c?.netN ?? 0) - (b.netN ?? 0))`), `ladder.ts:715–721` (`captureBaseline` stores `netN`)

**Claim:** The v27 clear correctly removed fee-contaminated evidence from `state.calib`, but the ladder's per-strategy `baseline` (in `ladder.json`) was **not** cleared, so the delta `c.netN − b.netN` is clamped to 0 for every strategy that had accumulated trades before 09-18.

**Evidence:** `captureBaseline` records `netN: c?.netN ?? 0` at promotion/scale-up time. v27 then deletes `c.netN`. For any strategy promoted before 09-18 (fade, mean-reversion, consensus, etc.), the current accumulator reads 0 while the baseline holds the old count, so `n = max(0, 0 − baseline) = 0`. The scale-up path (`netDollars > 0 && lo > 0`) and `decideSettlement` (`calib.netN >= 40`) both go dead until the strategy re-earns its entire pre-v27 trade count. Only lead-lag was re-baselined (explicitly, in the gap-floor file's "Re-baseline" clause).

**Failure:** No data-driven promotion *or* grade is possible for the non-lead-lag arms until they re-accumulate; the paper→tiny-live pipeline is frozen across the board. The cash-based stop (`ladder.ts:389–390`, on `netDollars`) still works, so this does not accelerate losses, but it silently disables the evaluation machinery the operator relies on to "flip the switch."

**Test:** Re-capture baselines for all live/paper strategies after v27 (one-time), or add a migration that, when `c.netN` is absent but a baseline exists, re-baselines. Confirm by inspecting `ladder.json` baselines vs the current `state.calib` accumulators.

---

### C-01 — Until 09-18 the fee number was wrong in *both* directions: the EV gate overcharged (conservative) and the ranking metric undercharged (optimistic)
**Area:** correctness · **Severity:** medium · **Confidence:** verified
**Location:** `kalshiFee.ts:142–145` (current 4dp ceil); `docs/D1-EMPIRICAL-SETTLEMENT-2026-09-18.md` (1.42× overstatement); `autoTrader.ts:4858` ("the fee term used to divide an already per-contract fee … Cx too low")

**Claim:** Before the 09-18 fixes, the *entry gate* used a cent-ceil that overstated the real fee by 1.42× (rejecting trades that cleared), while the *ladder ranking metric* (`netCentsOf`) divided the fee by C again, understating it by up to C× (inflating edges).

**Evidence:** D1: old cent-ceil modelled $108.70 vs $76.68 actually charged (1.42×). The v27 comment: "`netCentsOf()` divided an already per-contract fee by exactly C× on every graded settlement." So two different consumers of "the fee" were wrong in opposite directions. Both are fixed now (4dp ceil + v27 clear), but the consequence is that **every pre-09-18 gate decision and every pre-09-18 ladder ranking was made on a contaminated number.** The docs treat these as two separate fixes; the synthesis — that no pre-09-18 evidence is trustworthy in either direction — is understated.

**Failure:** Retrospectively, the ladder's scale-up of lead-lag to x4, and every "this arm clears fees" verdict, was computed on a fee that was wrong by a factor that depends on the (unknown) order size. The D1 fix also means the *running process* still held the old cent-ceil until a restart (D1 §5).

**Test:** Already fixed in source; the remaining action is to mark all pre-09-18 ladder evidence as void (which v27 did for quality-signal, but not for the cash-P&L-baseline interaction in M-04).

---

### P-02 — The only arm with a backtested edge (mean-reversion) is structurally starved, and the veto accounting was a black box
**Area:** profitability / engineering · **Severity:** medium · **Confidence:** verified
**Location:** `docs/reports/TRADE-HISTORY-2026-09-18-what-won-what-lost.md` §6

**Claim:** Mean-reversion has the only real backtested edge outside lead-lag (+2.2 to +3.6c/contract over 53,346 signals) but executed 12 entries in 11 days because its signals are vetoed at ~99.8%, and the veto reason was not logged until 09-18.

**Evidence:** §6: "12 entries in 11 days … the momentum recorder … saw 154 qualifying setups on 42 tickers on 09-17 and 132 on 35 tickers on 09-18; the arm entered once." `stats.vetoed` recorded "1,987,623 against 4,235 approvals … neither which strategy nor why." The 0.2% approval rate is either an absurdly tight gate or a miscounting veto tally — and the operator could not tell which until the per-strategy tally was added.

**Failure:** The one genuinely backtested, non-latency-dependent edge is not being traded, and the operator could not see why. This is an observability defect that has real opportunity cost — it is the difference between "the system has no edge besides lead-lag" and "the system has an edge it never executes."

**Test:** The per-strategy gate tally (now printing every 50 scans) is the right fix. Read its first few outputs: if one strategy dominates the vetoes with a single reason, that reason is the defect. If the vetoes are distributed, the gate is just too strict for the universe.

---

## Top 5 findings by expected dollar impact

1. **M-02 + M-01 (the "+8.94c target" and the 6c floor built on it).** This is the belief that most directly controls sizing of the *only live arm*. Anchoring on +8.94c while the honest forward edge is +1.4–1.9c is exactly what produced era B+C's -$57.34. The gap-floor change is the concrete action the belief produces, and it is data-mined. *Highest dollar impact because it governs the live-money arm's size and gate.*

2. **S-01 (settlement-basis tail scales with size).** The operator wants to scale lead-lag to 8 contracts/sweep. The basis loss is a full-position loss that grows linearly with size, while the alpha term is capacity-limited. Scaling without pricing this tail risks recreating era B+C's losses at 8×.

3. **P-01 (negative run-rate + ~$1–3/day ceiling).** The framing decision: whether this is a strategy or tuition. Governs whether capital and operator time continue to be allocated, which dominates all other findings at $200 capital.

4. **M-04 (ladder frozen by v27 clear).** Not a loss-accelerator (the cash stop still works), but it silently disables the promotion/grade machinery for every pre-09-18 arm for weeks — meaning the research program is flying blind at the moment it most needs honest readouts.

5. **P-02 (mean-reversion starved + veto black box).** The only backtested non-latency edge is not executing. If the gate fix surfaces a real +2–3c edge, this is the largest *upside* of any finding; if it reveals the "edge" was never executable, it's the largest avoided waste.

---

## Strongest disagreement

**"Era A's +8.94c is the target, not a fluke" is most likely wrong.** The honest-quote forward edge is +1.35c signal / +1.86c realized — a fifth of era A — and era A's signal was measured against the same stale quote that generated the trade ("the measurement and the trade shared the same wrong price"). Era A's boundary was selected after the fact, it is literally titled "the winning streak," and the gap-floor pre-registration built on top of it chose its 6c cut from the same sample it will be judged against. The evidence is consistent with the following read: era A's +8.94c was a real but non-repeatable *regime* (60s poll, stale quotes, 1–4 contracts, 70ms latency, BTC/ETH only), and the repeatable forward edge is ~+1–2c/contract at best. I would commit to treating **+1.5c/contract as the planning number**, and to requiring the gap-floor rule to be positive on era-D data *alone* before it is allowed to change the live arm's behavior. The single most useful thing the operator could do is stop using +8.94c as the reference point in any forward sizing decision.

---

## Could not check

- **Runtime state** (balances, fills, credentials, the live config: `amountPerTrade`, which arms are live, exact caps) — outside the repo. Every profitability number above uses the repo's docs and default config, not the live ledger.
- **Whether the running process was restarted to pick up the D1 fee fix.** D1 §5 says the process "still holds the old model" at write time; I could not verify the restart.
- **The 71-fill fee anomaly** (venue `shares` and venue `fee` disagree by 4× on round-dollar orders) — the operator's own doc says its cause is "NOT DETERMINED" and needs a live API probe. I could not resolve it. It is immaterial now but is the exact order shape the app produces at scale.
- **Kalshi's current published fee schedule across `fee_multiplier` tiers** (sub-1× series, maker coefficient 0.0175 vs taker 0.07). I relied on the operator's empirical fill archive, which itself flags that sub-1× series are part of the residual mismatch.
- **The full fill archive** (`%AppData%\...\fill-reconciler-kalshi.json.fills.jsonl`) — not in the repo, so I could not independently recompute the 96.6% fee-model match rate or the settlement-basis divergence; I take those at the operator's word.
- **Polymarket US and IBKR/ForecastEx live books** — paper labs only; no live-fill archives in-repo to cross-check the paper/live ledger split for those venues.

One process note: there are 81 untracked `.bak` files inside `src/` (the operator's own fee-verification doc flags this as having "already cost accuracy"). I did not rely on any `.bak` content, but it is worth moving them out of the tree before the next recursive grep-based review, or future citations will keep drifting.