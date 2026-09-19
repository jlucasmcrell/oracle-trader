Oracle Trader independent review — 2026-09-19
Scope

I read the repository in the requested order, then traced the relevant implementation paths in the ladder, lead-lag engine, Polymarket US paper lab, IBKR lab, Kalshi adapter, and fee helpers. I also checked the current Kalshi fee/fractional-contract documentation and IBKR/ForecastEx published fees.

A few checks survived scrutiny before getting to the findings. The repository's general Kalshi coefficients of 0.07 taker / 0.0175 maker match Kalshi's July 2026 fee schedule, and Kalshi says there is no settlement fee. The IBKR lab's $0.01 ForecastEx exchange-fee assumption also matches IBKR's currently published direct-client schedule.

The trade-history report is also appropriately skeptical about several tempting false positives: it rejects fade's 95% win rate as calibration rather than edge, treats the sports singleton as variance, and reports consensus's clustered interval as crossing zero. I agree with those reads.

F-01 — The live ladder can make a verdict from one day despite the project's explicit rule forbidding that

ID: F-01
Area: methodology | docs
Severity: high
Confidence: verified
Location: src/main/ladder/ladder.ts:350-453; docs/DEVELOPER-HANDBOOK.md:845-859

Claim: The live ladder permits both scale-up and the 100-trade sign verdict without the minimum number of independent day clusters that the handbook says every verdict requires.

Evidence: The handbook states: “A one-cluster band is never a verdict, in any tool.” It says trades on the same day are correlated and ordinarily requires four or five clusters.

But decideStage() only applies MIN_STOP_CLUSTERS = 4 to a negative confidence-band stop below 100 trades. The positive branch at lines 407-425 has no cluster-count floor at all. Then at 100 trades lines 444-453 bypass statistical significance entirely: a positive net scales, a non-positive net stops. The code itself calls this “a small win is a win.”

This isn't just a documentation wording difference. The implementation explicitly says the 100-trade backstop “is not clustered.”

Failure: Suppose an arm settles 100 correlated contracts on one event day and finishes +$0.01, with an interval spanning materially negative to positive values. Provided the adverse-selection veto does not fire, decideStage() can scale it anyway. Change the same result to -$0.01 and it stops. One day's noise has become a real-money stage verdict.

There is also an earlier version of the same problem: at 20/40/60/80 trades, a positive lower band can scale with one or two clusters because the four-cluster guard exists only on the negative-stop branch.

Test: Unit-test decideStage() with n=20 and n=100, clusters=1, and otherwise favorable positive evidence. The current implementation will demonstrate the contradiction directly. No venue data is needed.

Recommendation: Either the handbook's “never” rule is wrong or the ladder is wrong; they cannot both be authoritative. I would make the evidence standard symmetric: an evidence-based promotion should not occur on fewer independent clusters than an evidence-based stop. The hard-dollar emergency stop can remain a separate risk rule.

F-02 — The ladder uses an 80% test repeatedly across many arms without family-wise or sequential error control

ID: F-02
Area: methodology | missing
Severity: high
Confidence: verified
Location: src/main/ladder/ladder.ts:261-280, 372-455; docs/DEVELOPER-HANDBOOK.md:834-859

Claim: An 80% one-sided confidence threshold is being used as a repeated promotion criterion across a large strategy family, so false discoveries are much more likely than “80% confidence” sounds.

Evidence: The ladder fixes CONFIDENCE_Z = 0.84 and labels it “One-sided 80% confidence.” It evaluates at 20-trade checkpoints and promotes when the positive band clears zero.

The handbook says the registry contains 16 generic strategies plus four core strategies, and separately says Bonferroni correction is used where a grid of rules was searched. I found no equivalent family-wise or sequential correction in decideStage().

At a single fixed look, under an ideal normal zero-edge null, an 80% one-sided criterion has a 20% false-positive probability. As an illustration—not an estimate of Oracle's actual false-promotion rate—if 16 independent zero-edge arms each received one such test, the chance that at least one clears it would be:

1 - 0.8^16 = 97.2%

The arms are not independent, not all receive simultaneous tests, and the clustered t adjustment changes the exact behavior. So 97.2% is not Oracle's measured false-discovery rate. But it shows why 80% is a screening threshold, not strong evidence when many hypotheses are running.

Repeated looks at 20, 40, 60, 80 trades introduce another selection path. The dependence between those looks means a simple closed-form adjustment would be misleading.

Failure: A collection of genuinely zero-edge arms will periodically generate a strong-looking positive streak. The ladder selects those arms precisely because they happened to be positive. Their post-selection performance then tends to regress. That can create a recurring pattern of “promote → disappoint → demote” even if the machinery and fee accounting are flawless.

The system's own history already contains the sort of phenomenon this framework is vulnerable to: a highly profitable short regime can dominate how an arm is subsequently interpreted.

Test: Cheapest useful test: simulate the existing ladder unchanged under a zero-edge null using block-resampled historical day clusters. Run all arms and all checkpoint rules exactly as production does. Record how often at least one null arm reaches each live notch. That produces Oracle's actual empirical false-promotion rate without requiring an analytic independence assumption.

Recommendation: Treat the 80% ladder as an operational exploration mechanism, not confirmation that an edge exists. A claim of persistent edge should require a separately locked, clustered confirmatory test or an explicit multi-arm/sequential error budget.

This distinction alone would clean up a large fraction of the ambiguity in the record.

F-03 — The expanded lead-lag coin experiment is no longer confirmatory; coin selection has used observed outcomes

ID: F-03
Area: methodology | docs
Severity: high
Confidence: verified
Location: docs/PREREGISTERED-leadlag-coins.md:2-66, 130-149; docs/BACKLOG.md:1551-1554

Claim: Evidence from the expanded lead-lag coin set must now be treated as exploratory because the registration occurred after deployment and subsequent coin membership/decision rules were changed after reading outcomes.

Evidence: The file named a pre-registration explicitly says it was written “after the change went live” because the expansion had shipped without a stop rule.

That document then established a sensible prospective cohort rule: at least 400 contracts and five day clusters before judgment. It also correctly warned that the first day's result was not evidence.

The later amendments break the clean interpretation. On September 16, HYPE was specifically retained because it was positive in a recent six-hour venue ledger; on September 17 the broader cohort was resumed after descriptive per-coin results had been inspected.

More importantly, the current backlog creates a new ETH/HYPE decision after observing that those are the two coins negative on both graded signal and fills: at 100 rows per coin or September 21, whichever comes first, a still-negative coin can be dropped. That is materially different from the original five-day pooled rule.

Failure: Imagine eight equal zero-edge coins. Random variation makes two look worst after two days. Selecting those two, gathering more observations quickly, then removing whichever remains negative will improve the surviving cohort's historical P&L even though no coin has any true edge difference. The future portfolio can therefore appear increasingly “validated” simply because losers were iteratively selected out.

That doesn't mean removing ETH or HYPE is economically wrong. It means the resulting data cannot then be used as clean proof that the surviving coin universe was intrinsically better.

Test: Freeze today's entire coin set and rules, label every result seen so far exploratory, and start one genuinely forward evaluation from a timestamp after the freeze with a fixed coin-level or cohort-level decision rule. Five UTC days is already the project's own sensible minimum.

Recommendation: Keep operational experimentation if useful, but maintain two labels in the record: adaptive/exploratory and preregistered/confirmatory. Don't allow an adaptive sequence to regain “preregistered” status merely because each change is documented afterward.

This also makes the README's broad claim that a pre-registration precedes each new arm too strong for this particular expansion.

F-04 — The Poly and IBKR lab confidence calculations estimate an average day, not net cents per contract

ID: F-04
Area: methodology | correctness
Severity: medium
Confidence: verified
Location: src/main/strategies/polyPaper.ts:77-85; src/main/strategies/ibkrLab.ts:56-80

Claim: Both research labs give every day equal weight when estimating mean profitability, allowing a strategy with negative aggregate per-contract P&L to receive a positive statistical assessment.

Evidence: In the Polymarket lab, trades are grouped by UTC day, a mean is computed within each day, and then those daily means are averaged equally. That value—not aggregate trade-weighted P&L—is used for the confidence interval and "Promising; paper only" assessment. The separately reported net is trade-summed but is not the assessment statistic.

IBKR does the same thing with t.net/t.quantity: it creates daily means and averages the daily means equally. Critically, that confidenceLow feeds liveEligible, and live configuration explicitly requires liveEligible.

This conflicts with the handbook's primary performance unit, net cents per contract after fees.

Here's a concrete Polymarket counterexample using its actual minimum sample size:

Six days: one trade/day at +$0.10 each.
Seventh day: 94 trades at -$0.01 each.
Total: -$0.34 across 100 trades = -0.34c/trade.
Equal-weight daily mean: +8.43c/day-observation.
Standard error of those seven daily means: about 1.57c.
Using the code's 2.8 multiplier gives a lower bound around +4.03c.

With ten represented markets, the implementation can therefore display “Promising; paper only” while the strategy has actually lost money per contract.

The IBKR construction is similarly possible. Twenty-nine +1c single-trade days followed by one day containing 100 trades at -0.5c each produces -$0.21 aggregate P&L, but an equal-day mean of +0.95c and a lower bound still substantially above zero under the code's 30-day critical value. If ten events are represented, that statistic can satisfy liveEligible.

Failure: Volume is often endogenous in an auto-trader: a strategy trades more precisely on days when its signal fires strongly. If its bad regimes generate much more volume than its good regimes, equal-day weighting systematically understates the economic damage of those regimes.

Test: Add a research-only diagnostic that reports both:

contract-weighted mean net/contract with day-clustered standard errors, and
the current equal-day estimand.

Run it on existing paper ledgers. If their signs or eligibility verdicts differ, this is already consequential.

Recommendation: Clustering should change the uncertainty estimate, not silently change the estimand. If the question is “does one contract have positive expected net?”, preserve contract weighting while clustering the variance by day. If the intended question is genuinely “is the average trading day profitable?”, document that as a different statistic and don't use it as a substitute for per-contract edge.

F-05 — Kalshi fee accounting still assumes whole contracts even though Kalshi now supports fractional contracts universally

ID: F-05
Area: fees | correctness
Severity: medium
Confidence: verified
Location: src/main/util/kalshiFee.ts:106-164; src/main/strategies/autoTrader.ts:4678-4701; src/main/venues/kalshi.ts:957-968

Claim: Generic Kalshi fee/P&L calculations can misstate fees because they round fractional quantities to whole contracts before applying Kalshi's fee formula.

Evidence: The fee helper says “Kalshi trades in whole contracts” and normalizes every quantity with Math.round(). Both entryFeeDollars() and netCentsOf() repeat whole-contract rounding before calculating strategy performance.

But the live adapter does not enforce whole contracts. When sizing from dollar amount, it computes amount / legCost and sends the V2 count with two decimal places.

And Kalshi's April 17, 2026 API change says active markets support fractional trading unconditionally and clients should treat every active market as fractional.

The underlying fee coefficient itself is correct: Kalshi's current general taker formula is 0.07 × C × P × (1-P) before venue rounding.

Failure: A roughly $1 YES order at 67c becomes about 1.49 contracts.

At the default multiplier:

fee on 1.49 contracts ≈ 0.07 × 1.49 × .67 × .33 = 2.31c;
current helper rounds 1.49 to 1 and calculates about 1.55c.

That's an understatement of roughly 0.76c on a $1-size order.

At the tiny edges Oracle is trying to distinguish, 0.76c is not accounting dust.

This should not corrupt Kalshi's own settlement records—the venue charges the real fee—so your venue-authoritative historical report remains the stronger source. The damage is to local fee gates, live/paper metrics, and any evidence derived from the app's rounded quantity.

Test: Use a known fractional V2 fill such as 1.49 contracts, compare kalshiOrderFeeDollars() with the venue's recorded fee, and add official-formula fixtures at 0.01, 0.50, 1.49 and 3.25 contracts.

Recommendation: Fee helpers should accept the actual executed fractional quantity. This is also a good example of why venue-semantics tests should be based on dated official fixtures rather than assumptions embedded in comments.

F-06 — “The edge is latency” is stronger than the evidence supports

ID: F-06
Area: methodology | profitability
Severity: high
Confidence: likely
Location: docs/reports/TRADE-HISTORY-2026-09-18-what-won-what-lost.md:79-109, 195-209; docs/PREREGISTERED-leadlag-cadence.md:2-27

Claim: The record strongly supports latency as an important execution variable, but it does not isolate latency sufficiently to establish that latency explains the profitable regime or that Period A's +8.94c is the strategy's underlying expectancy.

Evidence: The report concludes that “the edge is latency” and says Period A's +8.94c is “the target, not a fluke.”

There is good evidence that bad latency hurts. The report documents a jump to roughly 14 seconds during the losing regime and later about 57 ms median / 101 ms p90 with fresh books. It also documents that the earlier recorded signal itself was contaminated by stale Kalshi list quotes: apparent 10c gaps were sometimes zero, even though the IOC always executed on the real book.

But the eras changed more than latency: coin universe, poll cadence, per-sweep size, request path, quote source, correlated-window behavior and risk plumbing changed across the break.

The resulting realized performance is:

lifetime lead-lag: 3,849 contracts, +$11.96, +0.31c/contract;
clean recent quote regime: roughly +1.86c realized / +1.35c graded;
Period A: +8.94c/contract.

Most importantly, the repository already contains a much cleaner causal design: the cadence pre-registration holds market, outcome, coin mix, threshold and sizing constant and asks 10s versus 60s on paired markets. It requires 300 pairs and five days. That experiment was then paused before its locked read.

Failure: If +8.94c is treated as the expected “healthy” value, every future deviation below it looks like a defect to diagnose. That creates pressure to tune the system until historical Period A behavior is reproduced, even if Period A contained favorable sampling variance or another unidentified regime variable.

You can end up optimizing toward a historical peak rather than estimating the forward edge.

Test: Finish a clean prospective paired timing experiment—or restart one from scratch if the current design has become operationally obsolete—and separately hold the live strategy configuration fixed for at least the project's normal five-day cluster bar. Judge actual settled net/contract, not a counterfactual quote-fill assumption.

Recommendation: The supported statement today is narrower: low execution latency appears necessary for lead-lag to work well. The evidence does not yet establish that latency is sufficient to recover +8.94c or that +8.94c is the correct forward target.

F-07 — The lead-lag trigger is still based on Polymarket midpoint, so the reported “signal edge” is not an executable-price edge

ID: F-07
Area: methodology | profitability
Severity: medium
Confidence: likely
Location: src/main/strategies/leadLag.ts:559-610; docs/PREREGISTERED-leadlag-coins.md:48-55

Claim: A small positive midpoint-relative signal can be produced by spread geometry on a thin Polymarket book rather than by a tradeable cross-venue discrepancy.

Evidence: For a Kalshi YES buy, the live condition is:

poly.mid - kYesAsk >= threshold

and both recorded gap and after-fee signal are calculated from poly.mid. The reverse direction likewise compares Kalshi's bid with poly.mid.

The coin preregistration already recognizes exactly this risk: thinner CLOB books make a dislocation measured against the mid more likely to be book noise, while the default Polymarket spread limit is 5c.

The current honest-quote graded edge is only +1.35c/contract. A several-cent spread can therefore move the midpoint by more than the average reported signal without any comparable movement in the executable side of the book.

This does not prove the signal is fake. Kalshi's realized +1.86c over the same recent period is evidence in its favor. It means midpoint grading is not sufficient to demonstrate why it works.

Failure: A 4c-wide Polymarket book can move its ask upward while the bid stays fixed, raising midpoint by 2c. Oracle can interpret that as Polymarket leading Kalshi even though the price somebody will actually pay for YES has not moved.

Test: Re-grade existing orderbook rows using a conservative adverse-side Polymarket bound and stratify settled P&L by Polymarket spread width. If the edge persists in 0-1c spreads and under the bid/ask bound, the midpoint concern largely dies. If almost all apparent edge resides in wide spreads, the trigger is partly a microstructure artifact.

Profitability read

The trade history does not yet establish that Oracle as a whole is profitable: the venue-authoritative period is -$54.32, with weather responsible for most of the damage and several other arms also negative.

Lead-lag is the only arm for which I see a plausible current real edge worth serious measurement. That is weaker than saying the edge has been statistically established. Its lifetime +0.31c/contract is small, its recent clean regime is encouraging at roughly +1.9c realized, and its strongest historical regime is heavily confounded. The next several independent days matter far more than another retrospective explanation of Period A.

The repository's own interpretation of fade looks right: the 95% win rate is not edge when you're buying ~95c outcomes; its calibration statistic says essentially that. Consensus is still inconclusive at +0.12c with a clustered 95% interval of roughly -6.35c to +6.59c. The spectacular sports result is mostly one LALIGA contract cluster, not a demonstrated sports process.

At the current operating style, I'd think of the economic scale in dollars per day, not percentage returns on $200. The clean September 17-18 lead-lag period produced roughly $5½ over two days, or around $2-3/day observed, while Period A produced on the order of $10/day but subsequently gave much of that back. Those are useful empirical throughput numbers, not forecasts. Getting this materially larger requires more genuinely independent profitable opportunities—not merely more capital or more contracts in the same correlated signal.

That distinction is important because the system already showed that increasing throughput during a bad execution regime can magnify losses much faster than capital itself constrains them.

Strategies I deliberately did not recommend

I checked the backlog before inventing “new” prediction-market ideas. Several obvious recommendations are already there or have already been tested: implication/arbitrage relationships, market-maker/liquidity incentives, time-of-day effects, resting-order behavior and related structural work.

I don't see a brand-new strategy idea in this review that has stronger expected value than simply getting the lead-lag experiment and evidence machinery statistically clean. Adding another dozen arms right now would worsen F-02.

The one cheap structural experiment I would add is really a diagnostic for the existing strategy, not a new strategy: executable-bound lead-lag grading from F-07. It uses data you're already collecting, costs nothing, and directly tells you whether the Polymarket signal survives the spread.

Top 5 findings by expected dollar impact
F-06 — Treating Period A as the target / attributing the edge to latency. Lead-lag is by far the highest-volume potentially profitable real-money arm, so an erroneous estimate of its expected edge has the largest dollar consequence. The difference between +8.94c and +1-2c across thousands of contracts dwarfs the smaller accounting defects.
F-01 — Live ladder verdicts without sufficient independent clusters. This can alter real-money scaling decisions for every arm and directly contradicts the project's central lesson from the September 7 one-day false verdict.
F-02 — Repeated 80% screening without multiplicity control. This is a system-wide edge-discovery problem. It can continually feed false positives into the live ladder even after every individual strategy bug is fixed.
F-03 — Adaptive lead-lag coin selection being mixed with confirmatory evidence. Lead-lag is the one strategy doing meaningful real volume, so selection bias in its universe can distort both profitability estimates and what gets retained.
F-05 — Fractional Kalshi fee mismatch. The per-order discrepancy can approach the same scale as the edges you're trying to detect. It is narrower than F-01/F-02 because venue-authoritative settlements eventually correct the ground truth, but it can contaminate intermediate gates and app-ledger measurements.

F-04 could become more important than F-05 if an IBKR paper arm approaches liveEligible; today it is primarily a future-selection defect rather than a current cash-loss mechanism.

Strongest disagreement

I disagree with this sentence in the trade-history report:

“Period A's +8.94c is the target, not a fluke.”

+8.94c should not currently be treated as the target edge estimate.

I would label it the observed return of a favorable historical regime.

There is convincing evidence that execution latency became terrible and damaged the strategy. There is also convincing evidence that the old quote measurement itself was contaminated by stale prices. Multiple other variables changed at the same time, and the genuinely cleaner configuration has so far produced something closer to +1-2c, not +9c, over only two days.

So I do not think the correct conclusion is “lead-lag has no edge.” The evidence currently supports:

lead-lag may have a real, small execution-sensitive edge; +8.94c has not been established as its forward expectancy.

That's the distinction I would protect most aggressively in the record.

Could not check
Venue-authoritative raw trade reproduction. The report references tmp/k-2026-09-18.json, but runtime state/dumps are outside the repository. I therefore could not independently reproduce the 1,420-market settlement totals, individual fills, exact cluster intervals or per-coin P&L. I treated those numbers as documented claims rather than independently verified exchange records.
Actual live Kalshi fractional fees. The code/API disagreement is verified, and Kalshi's published formula supports the arithmetic, but the strongest final confirmation would be one real fractional fill joined to the venue's recorded fee.
Every individual market's settlement wording/source. I did not exhaustively retrieve the contract rules for every historical Kalshi, Polymarket US and ForecastEx ticker. The repository already documents settlement-basis risk, so I did not repackage it as a new finding.
Polymarket US fee settlement behavior. I could inspect the implementation and public references, but I could not independently reconcile it to your private US account's actual charged/rebated fee ledger. That needs real fills.
Restart/outage reconciliation under production state. The repository contains substantial defensive handling, including IBKR's “submitting → uncertain” restart treatment, but without the persistent runtime ledger, order IDs and venue responses I cannot prove there is no remaining double-submit or orphan-position path.
True capacity. Code and settlement history can show realized throughput, but they cannot establish how many additional contracts the current lead-lag edge can absorb before fill quality deteriorates. That needs forward execution data at a fixed configuration.

Bottom line: I would spend the next unit of effort on the measurement system, not another strategy. The repository has become unusually good at documenting its own mistakes, but the live ladder and recent lead-lag decision record still allow exactly the kinds of post-selection and low-cluster conclusions that the handbook says the project learned not to make.