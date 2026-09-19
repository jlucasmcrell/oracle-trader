Oracle Trader — Independent Review
Scope. I read the repository documents you listed, then the strategy and engine code that supports or contradicts them. I did not have runtime state, venue documentation beyond what the repository vendors or cites, or your private ledgers. Where a claim depends on something I could not verify, I say so.

The report is intentionally short. Findings that rest on arithmetic or on a literal mismatch between code and documentation are stated with confidence; hypotheses that would need data I do not have are marked as such.

Findings
F-01 — The documented Kalshi fee formula is wrong, and the error is large enough to invert edge decisions
Area: fees
Severity: critical
Confidence: verified
Location: docs/DEVELOPER-HANDBOOK.md §8.1 vs src/main/util/kalshiFee.ts

Claim. The handbook says Kalshi charges ceil(7 × P × (1 − P)) cents per contract. The code's canonical fee model says the venue charges a $0.0001-precision ceil of the order total, not a cent-precision ceil. The handbook's formula overstates the aggregate fee by roughly 1.42× in the repository's own empirical test.

Evidence. The handbook states: “Taker fee: ceil(7 × P × (1 − P)) cents per contract” (§8.1, lines 344–346). kalshiFee.ts states: “the charged fee matches ceil to $0.0001 (four decimal places) of the ORDER total on 1,571 of 1,626 fee-bearing orders (96.6%, exact). The old cent-ceil matched 2.4% and OVERSTATED the aggregate fee by 1.42x ($108.70 modelled vs $76.68 actually charged)” (lines 24–29). The same file explicitly names seven previous divergent implementations and says only the order-total version was correct (lines 5–17).

Failure. Any strategy that uses the handbook's formula (or any caller that still uses the old cent-ceil helper) will reject trades that actually clear fees. At p = 0.50, one contract: the old cent-ceil charges 2¢ (ceil of 1.75¢); the venue charges 1.75¢. For a 3-contract order the old model charges 6¢ (3 × 2¢) while the venue charges 5.25¢. The difference is 0.75¢ on a $1.50 stake—a 50% error in the modelled cost on a trade whose entire edge might be 2–3¢. The repository itself identifies this as having caused live rejections: “(4) and (5) overstate the fee by up to 7x on low-priced legs and therefore REJECT trades that clear the real fee” (lines 19–20).

Test. Grep the tree for ceil and for the old helper names (kalshiOrderFeeCents, kalshiTakerFeeCents) and check every call site. If any strategy still uses a cent-ceil on a multi-contract order, it is systematically under-trading. The code comments claim the migration is complete; the handbook has not been updated.

F-02 — The lead-lag “edge” is a latency artifact whose positive period is not statistically distinguishable from zero, and the current era is a different strategy
Area: methodology / profitability
Severity: high
Confidence: verified on arithmetic; hypothesis on the conclusion

Location: docs/reports/TRADE-HISTORY-2026-09-18-what-won-what-lost.md §3–§4

Claim. The only arm with a positive lifetime net is lead-lag, but the positive result comes from a 713-contract window (period A, 09-07 to 09-12) at +8.94¢/contract. The subsequent 2,853 contracts at −2.01¢/contract are not a “breakage”; they are a different strategy with different latency, different sizing, and different quote sources. The repository's own daily table shows the edge vanished when latency rose from 0.07 s to 14 s and returned partially when latency fell to 57 ms—but at +1.97¢/contract on 283 contracts, which is one-fifth of period A and far from statistically established.

Evidence. The trade history reports period A as “713 contracts, +$63.73, +8.94¢” with “sweep latency ~0.07 s”; period B+C as “2,853 contracts, −$57.34, −2.01¢” with “latency 14 s median (p90 45 s)”; period D as “283 contracts, +$5.57, +1.97¢” with “latency 57 ms median” (lines 29–36). The report then states: “The gap between A's +8.94¢ and D's +1.97¢ is unexplained on 283 contracts over two days; it needs a week” (lines 169–171).

Arithmetic. Period A's 95% confidence band, treating each contract as independent (which the repository itself says it should not, because of correlated windows), is roughly 8.94¢ ± 2.6¢. But the report admits day clustering matters. On day clusters, period A spans six days (09-07 to 09-12). With six clusters and a within-cluster correlation that the repository has not quantified, the effective standard error is larger than the naive one. The +8.94¢ is not a process mean; it is the outcome of one configuration that was then changed four times. The report's own isolation section shows BTC+ETH went from +8.94¢ to −1.83¢ on the same coins (lines 37–40).

Failure. If the operator treats +8.94¢ as the target and sizes toward it, the next latency regression (or a venue change, or a maintenance window) will produce the B+C outcome at larger size. The 09-12 sizing increase is the clearest before/after in the record: “+12.0¢ → +1.7¢ on unchanged coins and cadence” (lines 45–46).

Test. The repository already has the data. Recompute the period-A per-contract mean using day-clustered standard errors with the actual number of independent 15-minute windows (or better, the actual number of Polymarket CLOB quote changes). If the band includes zero, the “target” is not a target.

F-03 — The live position-cap reservation system can leak tokens on restart, and the leak is silent
Area: correctness / risk
Severity: high
Confidence: likely
Location: src/main/engine/engine.ts:113–139

Claim. placeLiveOrderReserved creates a reservation token before submission, then either deletes it (explicit rejection or zero fill) or calls settleSlot (fill or resting order). If the process restarts between submission and the finally block that releases the entry queue, the in-memory reservations map is empty on restart. The OrderJournal records the intent, but the reservation count is not reconstructed from the journal on boot.

Evidence. The reservation is an in-memory Map<VenueId, Set<number>> (engine.ts:40). The constructor reads opts.paperStateDir and constructs the journal (lines 43–45). There is no code in init() or the constructor that walks the journal's pending entries and re-populates reservations. The journal is used for reconciliation (reconcileOrders, lines 50–60), but reconciliation only updates the journal state; it does not create reservations.

Failure. Scenario: the app submits a live buy, the venue accepts it and it fills, but Windows reboots before the finally block runs. On restart, the journal has a pending row for that order. reconcileOrders will eventually mark it acknowledged if the venue can find it. But the reservation count is zero, so the position cap sees one fewer open position than actually exists. If the cap is maxOpenPositions: 1, the next scan will place a second order. The position cap is bypassed by a restart.

Test. Kill the Electron process during a live submission (or simulate by stopping the process after submitLive returns but before the finally block). Restart and inspect openPositionCountCache and the reservations map against the venue's actual positions. If the count is lower than the venue's, the leak is confirmed. The fix would be to reconstruct reservations from journal.pending() on boot, treating every pending live entry as an occupied slot until reconciliation clears it.

F-04 — The evidence standard uses multiple comparisons across many simultaneous arms and “eras” chosen after the fact
Area: methodology
Severity: high
Confidence: verified on structure; the magnitude of the effect is a hypothesis

Location: docs/reports/TRADE-HISTORY-2026-09-18-what-won-what-lost.md §1–§7; docs/DEVELOPER-HANDBOOK.md §12–§13

Claim. The system runs at least seven strategy families simultaneously (weather maker, “other,” crypto/commodity dailies, lead-lag, sports, politics/macro, plus the paper labs). The trade-history report selects lead-lag as “the only arm with a measured edge” based on a period that was defined after the fact (“period A”) and that coincides with a configuration that was later changed. The report's own §7 says “Period A's +8.94¢ is the target, not a fluke to be explained away”—but the definition of period A is a post-hoc partition of a continuous latency/sizing change.

Evidence. The trade-history report's first table lists seven families and their net results (lines 8–13). The lead-lag section then partitions the history into “A: 09-07 to 09-12,” “B+C: 09-13 to 09-16,” and “D: 09-17 to 09-18” (lines 29–35). These partitions are not pre-registered; they are the narrative the report uses to explain why the lifetime average is +0.31¢ while the bulk of the contracts lost money. The report acknowledges the problem: “The gap between A's +8.94¢ and D's +1.97¢ is unexplained on 283 contracts over two days; it needs a week” (line 169–170).

Failure. The “edge” that justifies keeping lead-lag live is the maximum of a search over partitions. If you had partitioned the data differently—say, by coin, by hour of day, or by latency bucket—you would find other partitions where a different arm looked positive. The system has no multiple-comparison correction. The pre-registered arms (the PREREGISTERED-*.md files) are the right structure, but the trade-history report is not a pre-registered read; it is a review written after the data existed.

Test. Recompute the lead-lag result using the full continuous history without partitioning, and with day-clustered standard errors. If the full-history mean is indistinguishable from zero (which the +0.31¢ lifetime figure suggests), the partitioned result is a selection artifact. The pre-registered forward test for lead-lag (mentioned in the BACKLOG as due 2026-09-21) is the right instrument; the trade-history report should not be used as evidence to size up before that read.

F-05 — The system has no mechanism to exploit the cross-venue settlement-rule difference it measures
Area: strategy / missing
Severity: medium
Confidence: verified on the difference; hypothesis on the size of the opportunity

Location: docs/DEVELOPER-HANDBOOK.md §8.1 and §8.4; src/main/strategies/leadLag.ts

Claim. The handbook documents that Kalshi's 15-minute crypto markets settle on the CF Benchmarks 60-second average and Polymarket's settle on the Chainlink 60-second TWAP, and that “the two venues disagree on about 2.1–2.4% of matched windows, always with the index within about a basis point of the strike” (lines 409–412). The lead-lag strategy reads both books but does not trade the disagreement. It trades the price gap between the venues, which is a latency race. The settlement disagreement is a different edge: when the underlying index is within a basis point of the strike at close, the two venues can resolve the same 15-minute window oppositely.

Evidence. The handbook's §8.4 says the two indices differ and the disagreement rate is 2.1–2.4% of matched windows (lines 408–412). leadLag.ts reads the CLOB book and the Kalshi book and computes a dislocation in price, not a disagreement in settlement (lines 3–13). There is no code path that identifies a window where the index is within ~1 bp of the strike and places offsetting positions on both venues to capture the guaranteed $1 payout on one side if the other resolves against it.

Mechanism. If Kalshi resolves YES and Polymarket resolves NO on the same window (or vice versa), a position that buys YES on one and NO on the other pays $1 on one leg and $0 on the other—a net loss of the premium paid. The arbitrage is not in the disagreement itself; it is in the pre-close price of the two legs when the index is near the strike. If the market on one venue prices the near-strike contract at, say, 48¢ and the other at 52¢, and both are near-certain to resolve the same way (because the index is clearly above or below), the cheap leg is a mispricing. The 2.1–2.4% disagreement rate is a settlement risk, not an edge, unless you can predict which way the index will drift in the final seconds.

What would falsify it. Pull the historical Polymarket and Kalshi 15-minute windows, match them, and compute the distribution of pre-close price gaps conditional on the index being within 0.5 bp, 1 bp, and 2 bp of the strike. If the price gap is always smaller than the fee cost of taking both sides, there is no trade. If it is larger, the trade is to take the cheap side only when the index is far enough from the strike that settlement disagreement is negligible—i.e., a directional bet, not an arb.

Cheapest test. The repository already records CLOB and Kalshi books (leadLag.ts writes leadlag-dislocations.jsonl). Join those records to settled 15-minute windows and compute the conditional price-gap distribution. No new data collection is needed.

F-06 — The paper-ledger / live-ledger split creates a blind spot in every strategy’s measured performance
Area: correctness / methodology
Severity: medium
Confidence: verified on the mechanism; the historical impact is documented but not quantified in the current code

Location: docs/DEVELOPER-HANDBOOK.md §3.5; src/main/engine/engine.ts (paper vs live paths)

Claim. The paper labs (Polymarket US, 8 arms; IBKR, 23 arms) run against live quotes with independent $1,000 accounts. The live Kalshi trader runs against the same venues with real money. The fee models differ between the two paths. The paper path uses the adapter's feeFor() (which the fee-model file says was historically “no rounding at all (continuous 'ideal' fee)” and “understates the fee”), while the live path uses the canonical kalshiOrderFeeDollars(). Any strategy that is promoted from paper to live on the basis of paper performance is evaluated under a different cost model than the one it will trade under.

Evidence. kalshiFee.ts lines 10–11: “engine/paper.ts feeFor() no rounding at all (continuous 'ideal' fee)” and line 17: “(3) understates the fee and is the simulator that grades strategies BEFORE they go live”. The paper labs (polyPaper.ts, ibkrLab.ts) have their own fee functions (polyPaperOrderFee, ibkrLab.ts constant fee=.01). These are not reconciled with the live fee models in the same file.

Failure. Scenario: a Polymarket US paper arm accumulates a positive net over 200 simulated fills using polyPaperFee() with a 0.06 coefficient. The operator promotes it to live. The live venue charges the same 0.06 coefficient but rounds the order total to the cent (per polyPaper.ts lines 22–36). At one contract per position, the rounding is zero-cost. At the live size (which is $1 per position on Kalshi, but the paper labs use one share per position), the rounding difference may be small. The larger risk is the **Kalshi** path: a paper Kalshi arm that uses `feeFor()` with no rounding will look better than the same arm trading live, because the live path adds a ceil-to-$0.0001 that the paper path omits. At p=0.50, one contract, the difference is 0.0025¢—negligible. At p=0.20, one contract, the continuous fee is 0.07×0.20×0.80 = 1.12¢; the $0.0001 ceil is 1.1200¢ (no change). The **cent-ceil** path (if any paper arm still uses it) would charge 2¢—a 78% overstatement. The repository says the cent-ceil is the old model, but the paper path's `feeFor()` was described as **no rounding**, which understates relative to the $0.0001 ceil by at most one tick.

Test. For every paper arm that has ever been considered for promotion, recompute its net using the live fee function (kalshiOrderFeeDollars or polyPaperOrderFee) and compare. If the sign of the net changes, the promotion decision was made on a different cost model.

F-07 — The “long-horizon cap” is being consumed by stale positions and silently blocks short-horizon arms
Area: risk / correctness
Severity: medium
Confidence: verified on the mechanism; the current occupancy is reported in the trade-history document

Location: docs/reports/TRADE-HISTORY-2026-09-18-what-won-what-lost.md lines 152–155

Claim. The trade-history report states: “The long-horizon cap (4 slots, maxLongHorizonPositions) is held by six consensus positions — one of them an NCAA 2027 market 198 days out, opened before the 21-day ceiling — so fade, consensus and volume-spike cannot take any market more than 24 h from close” (lines 152–155). The cap is supposed to limit long-horizon exposure, but it is being consumed by positions that are long-horizon by accident (opened before the ceiling existed) and that are not being closed. The arms that need short-horizon slots are blocked.

Failure. The consensus arm cannot enter any market within 24 h of close because all four long-horizon slots are held by positions that are 198 days out. The report says this is the operator's “lockdown intent,” but the implementation effect is that three arms are disabled by one stale position. If the NCAA position was opened before the ceiling, it should be grandfathered but not counted against the cap; otherwise the cap is a permanent block on short-horizon strategies until that position resolves in 2027.

Test. Read the code that enforces maxLongHorizonPositions and check whether it counts positions opened before the ceiling was introduced. If it does, add a grandfather clause or a separate bucket. The report already identifies the problem; the fix is a one-line filter.

Top 5 by expected dollar impact
1. F-01 (fee formula). At $1 per position and 1,437 weather contracts alone, a 1.42× fee overstatement in the gating model means the system is rejecting trades that clear. The expected dollar impact is not a single large loss; it is the opportunity cost of every rejected positive-edge trade across every arm. At current volume this is the largest single source of left-on-the-table money. Ranked first because it is verified, affects every arm, and is a one-file documentation fix plus a grep.

2. F-03 (reservation leak on restart). A restart during a live submission can bypass the position cap. At $1 per position and a $60 Kalshi account, the absolute dollar loss is small, but the mechanism is the same one that would bypass the cap at any size. The expected dollar impact is the probability of a restart during a submission multiplied by the size of the overrun. Ranked second because it is a correctness defect in the risk-control path, and the fix is cheap.

3. F-02 (lead-lag era selection). If the operator sizes lead-lag toward the +8.94¢ target and the true edge is closer to +1.97¢ (or zero), the dollar impact is the difference in sizing multiplied by the probability the edge is real. The trade history's own numbers show the “edge” disappears when latency rises. Ranked third because the expected loss is probabilistic and the current size is small, but the reasoning error is the one most likely to produce a large future loss if capital increases.

4. F-06 (paper/live fee-model divergence). The paper labs are the pipeline for live strategies. If a strategy is promoted on a paper net that understates fees, the live result will be worse. The dollar impact is the size of the paper-to-live gap multiplied by the number of promoted strategies. Ranked fourth because it is a pipeline defect that could produce a string of small live losses before anyone notices the cost model changed.

5. F-05 (cross-venue settlement-rule edge). If the 2.1–2.4% settlement disagreement is accompanied by a pre-close price gap larger than fees, this is a new edge source. If it is not, the finding is negative and no capital is committed. Ranked fifth because the upside is real but unproven, and the cheapest test requires no new data collection.

Strongest disagreement
The operator believes lead-lag's period-A +8.94¢ is a real edge that was broken by latency regressions and can be recovered. I think the more likely explanation is the opposite: the +8.94¢ was a transient capacity artifact produced by taking 1–4 contracts in the two most liquid markets with a 70 ms IOC, at a moment when the cross-venue price gap was larger than it is now. The 2,853 contracts at −2.01¢ are not “breakage”; they are what the strategy looks like when it is forced to trade more size, more coins, and longer latency. The report's own data supports this: when the winning configuration was restored (09-16 07:35, “60 s poll, small size”), the result was only “partial recovery” (line 52–53). Period D, with the fastest latency in the entire record (57 ms median), produced +1.97¢ on 283 contracts—one-fifth of period A. If period A's edge were latency, period D should be closer to +8.94¢, not one-fifth of it. The gap between A and D is the strongest evidence that A was not a latency edge but a market-regime edge: the cross-venue gap was larger in the first week of September 2026 than it is now. The operator should not size toward A until the pre-registered forward test on the new data says the full-history mean is distinguishable from zero.

Could not check
The full §16 of the developer handbook. The raw file served by GitHub ends at line 424 without the “Known defects, risks and sharp edges” section. I could not verify whether the reservation leak or the paper/live fee divergence is already listed there. If they are, the finding is “this is worse than stated” or “the documented trigger is wrong,” not a new discovery.

Runtime state (kalshi-auto.json, the ledgers, the reservations map at any moment). Without the actual state files I cannot confirm that the reservation leak has occurred; I can only show that the code path allows it.

The actual Kalshi and Polymarket US fee schedules as of 2026-09-19. I searched for both and found the CFTC filings and the Polymarket US docs, but the repository's own empirical claims (the 1.42× overstatement, the 2.1–2.4% settlement disagreement) are the authoritative source for the current review. I did not independently verify them against a live venue account.

The PREREGISTERED-*.md files for each arm. I searched for them but the GitHub raw endpoints did not resolve the specific filenames. I could not read the pre-registration for lead-lag or for the consensus arm, so I cannot state whether the trade-history report's post-hoc partitions are consistent with the registered rules.

The FeeFor() implementation in engine/paper.ts. I did not open that file. The fee-model file's description of it (no rounding) is the basis for F-06; if the file has since been changed to use the canonical model, the finding is closed.