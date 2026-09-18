# Oracle Trader: repairs and profitability review

September 15, 2026. Financial snapshots: 07:29 UTC (03:29 Eastern). September 15 results are partial. Times below are UTC unless explicitly marked Eastern.

## Assessment

**Oracle Trader is a functioning automated research and execution platform, but the current record does not establish a sustainably profitable trading business.** Lead-lag has produced the strongest historical earnings. Its recent losses, correlated exposure and fee burden make further size increases difficult to justify from this review alone. Fade produces small gains. Several other strategies consume those gains or lack enough clean evidence to judge.

The highest-value work is improving execution and measurement on the existing strategies. Adding more strategy names would not resolve the observed problems. Keep the registered experiments running, distinguish strategy versions, and require prospective evidence before adopting filters discovered in this analysis.

This review repaired the identified risk-control and reporting defects, built and deployed the application, and preserved the independent experiment recorders. It did not change deposits, subscriptions, operator holds, order sizes, loss limits or experiment deadlines. No review script placed or canceled an exchange order.

## 1. What the accounts actually earned

| Measure | Gross before fees | Venue fees | Net |
|---|---:|---:|---:|
| Kalshi: all 981 available settlements | $24.49 | $64.30 | **-$39.81** |
| Kalshi: 794 settlements since September 6, 21:00 | $63.06 | $59.98 | **+$3.08** |
| Attributed lead-lag: 488 settled markets | $78.12 | $48.14 | **+$29.97** |

The redesigned Kalshi system retained only about 5% of its gross profit after fees. Its net return was **0.053 cents per contract**, across 5,782.96 contracts. A descriptive bootstrap that resamples whole UTC settlement days gives a 95% interval of **-1.79 to +2.35 cents per contract**. This is substantial uncertainty around essentially break-even performance. These are exploratory intervals, not formal experiment verdicts or protection against repeated strategy selection.

Kalshi held **$82.38 cash plus $26.88 of marked positions: $109.26 equity**. Its 28 held positions cost $28.48, so their mark was about **$1.60 below cost**. Six orders were resting. Open-position marks are excluded from the settled P&L table.

### Polymarket US: cash balance masks the loss

The account had **$39.85 cash, no positions and no open orders**. Its activity history includes $25 deposited, a $20 referral bonus, and $15.71 of other credits: **$60.71 total external funding/credits**. The resulting account delta is **-$20.86**. This is the useful economic account result; having more than the original $25 deposit does not mean the trading earned money.

There were 432 fills, including 345 classified as maker fills, and $6.69 in net collected commissions. Only one fill carried a negative commission in this export. Do not assume every maker fill earned a meaningful rebate: small-fill rounding can matter, and actual credited amounts must be checked.

The 182 resolution activities sum to **-$4.04** in resolution deltas. That is not total trading profit: it excludes sales and does not reconcile the account. Raw trade `realizedPnl` values sum to +$135.96, also inconsistent when treated as additive profits. The completed account replay now reconciles actual trades, fees, opposite-side netting and settlements to cash exactly; it does not rely on those ambiguous fields. See section 10. All US arms remain held.

## 2. Where the system wins and loses

The following is a partition of Kalshi's post-redesign settled-market P&L. Attribution uses recorded strategy references, executed lead-lag records and matching entry episodes. Markets with more than one identified strategy remain mixed; missing provenance remains unattributed. **These are attributed market totals, not complete strategy-level execution accounts.**

| Attributed strategy | Markets | Net after fees |
|---|---:|---:|
| Lead-lag | 488 | +$29.97 |
| Fade | 80 | +$5.48 |
| Convergence | 1 | +$0.05 |
| Book imbalance | 29 | -$11.59 |
| Mean reversion | 9 | -$10.73 |
| Momentum | 43 | -$10.31 |
| Sports anchor | 7 | -$4.71 |
| Volume spike | 30 | -$3.21 |
| Consensus | 14 | -$2.97 |
| Flow follow | 12 | -$2.66 |
| Settlement | 2 | -$2.55 |
| News | 1 | -$0.10 |
| Mixed strategies | 5 | +$20.48 |
| Unattributed | 73 | -$4.05 |

**Mean reversion needs particular care:** its app counter is positive because an older large winner dominates, while that winner's market falls into the mixed bucket here. Neither the negative single-strategy bucket nor the positive lifetime app counter describes the current version by itself. Consensus likewise includes trades preceding its recent hold-to-settlement correction. Current cohorts must be evaluated separately.

### Lead-lag changed materially between winning and losing periods

Grouping by actual fill time around documented deployment boundaries gives:

| Entry regime | Fills | Contracts | Gross | Fees | Net | Net cents/contract |
|---|---:|---:|---:|---:|---:|---:|
| Redesign to seven-coin expansion, Sep 13 10:05:42 | 322 | 980.02 | $81.51 | $14.65 | **+$66.86** | +6.82 |
| Expanded, before micro sizing around 11:39 | 64 | 410.00 | -$12.30 | $5.92 | **-$18.22** | -4.44 |
| After direction/spend cap around 11:50 | 616 | 1,864.09 | $8.91 | $27.58 | **-$18.67** | -1.00 |

There were no matched fills in the short micro-size-before-direction-cap interval. Deployment timestamps around 11:39 and 11:50 are approximate. Different market conditions, coin composition, sizing and downtime confound these comparisons; they do not prove which change caused the result.

The earlier period earned money before and after costs. The later capped period earned a little before fees and lost after fees. **An approximately one-cent-per-contract execution improvement would have offset that later loss arithmetically.** It is a useful engineering target, not an expected return from a proposed change.

### Recent coin results: a diagnostic, not a trading filter

After the September 13 direction cap, only two entry-day clusters contributed settled fills:

| Coin | Net | Net cents/contract |
|---|---:|---:|
| SOL | +$17.84 | +13.31 |
| ETH | +$11.34 | +1.83 |
| XRP | +$7.98 | +5.02 |
| BNB | +$7.80 | +4.69 |
| HYPE | -$3.80 | -2.62 |
| DOGE | -$23.38 | -17.32 |
| BTC | -$36.44 | -7.22 |

BTC's recent loss shows that historical “proven” status does not prevent regime deterioration. SOL's recent gain does not establish a durable advantage. Do not promote SOL or remove DOGE solely from this table. Preserve the new-coin cohort's registered minimums and deadline.

## 3. The winning and losing streaks

![Daily and cumulative Kalshi performance](G:/PROJECTS/oracle-trader/docs/reports/oracle-trader-review-2026-09-15-assets/kalshi-performance.png)

Daily settlement totals show the reversal clearly:

| UTC date | All Kalshi | Attributed lead-lag |
|---|---:|---:|
| Sep 7 | +$15.26 | +$4.97 |
| Sep 8 | -$16.67 | +$1.18 |
| Sep 9 | +$3.17 | +$1.13 |
| Sep 10 | +$5.66 | +$11.05 |
| Sep 11 | +$8.41 | +$9.19 |
| Sep 12 | +$33.39 | +$36.21 |
| Sep 13 | -$22.87 | -$15.09 |
| Sep 14 | -$3.69 | +$1.86 |
| Sep 15, partial | -$20.22 | -$20.52 |

Grouping lead-lag fills into their actual 15-minute entry windows avoids treating seven related coin bets as seven independent successes:

- **Eight consecutive winning traded windows:** September 12, 07:45–11:00, **+$19.89**.
- **Four consecutive losing traded windows:** September 13, 10:30–11:15, **-$47.84**.
- **Five consecutive losing traded windows:** September 14, 05:00–06:00, **-$25.60**.

“Consecutive” means consecutive windows with attributed trades; untraded windows can occur between them. These are realized outcomes associated with entry windows, not intrawindow cash balances.

The worst individual entry window was September 13 at 10:45: **-$20.38**, six coins, 104 contracts and $58.86 of entry cost. The 11:15 window lost another **$18.65** across six coins. Conversely, September 12 at 05:00 earned **$16.70** on 24 BTC contracts costing $6.96.

Attributed lead-lag suffered a **$59.07 peak-to-trough settled drawdown**, from September 13 10:45 to September 15 06:45. All Kalshi's corresponding maximum drawdown was **$63.52**. These exclude unrealized fluctuations and can be affected by ordering settlements that arrive close together.

**Interpretation:** concentration and changing position size amplify dollar streaks. Existing direction and spend caps address part of that exposure, but losses continued after their introduction. A rule such as “stop after three losses” is not justified by retrospective streaks alone. Test any such rule prospectively against the unchanged strategy, including profitable trades it would miss.

## 4. Defects repaired and deployed

| File | Defect and repair |
|---|---|
| `src/main/engine/engine.ts` | Concurrent orders could inspect the same final free position slot. A per-venue queue now keeps the fresh risk check and submission together. |
| `src/main/strategies/leadLag.ts` | Restarts erased window exposure. Window contracts, spend and direction reservations now persist before submission and restore on restart. |
| `src/main/strategies/leadLag.ts` | A timeout could release risk budget despite an unknown fill. Unknown outcomes retain their reservation; only explicit rejection or confirmed unfilled quantity releases it. |
| `src/main/strategies/autoTrader.ts` | Sub-engines used a separate daily-loss check based on free cash. They now use the shared persistent daily kill logic and observed equity, and wait for startup equity. |
| `src/main/ladder/ladder.ts` | Lead-lag uncertainty treated each market as an independent cluster. Its evidence now groups settlements by UTC day. |
| `scripts/venue-pnl.py` | Arbitrarily named US exports could be reported as empty Kalshi accounts. Venue detection now uses response structure, failed exports fail explicitly, and US resolution-only totals are labeled. |

The first deployment of the durable window ledger cannot reconstruct old in-memory reservations. It therefore held new lead-lag entries until **08:00 UTC**, the next window; observation continued. This is an upgrade safety behavior, not a reset or cancellation of the experiment. Existing loss controls can still independently hold entries afterward.

### Verification

- Type checking and production build passed.
- Existing suites passed: review-fixes **475 assertions**, ladder **126**, adversarial **89**.
- New risk-control suite passed **11 scenarios**; reporting suite passed **2 scenarios**; settlement-accounting regression passed.
- Five deliberate regressions introduced through an isolated test loader were each caught, including restoring the timeout-budget-release bug. Working source files were not reverted during this check.
- `tsx` was unavailable locally/offline. Tests ran through the installed TypeScript compiler's transpilation hook; no dependency was silently installed.
- The rebuilt app started at **07:50:06.884 UTC**, after the bundle timestamp **07:45:33.835 UTC**. The restart preserved all **six** independent recorder process IDs and start times. Selected protected configuration values matched afterward. Startup logs confirmed the new ledger guard and continuing scans.
- At **08:01 UTC**, the new window had automatically cleared the migration hold and persisted $2.24 of reservations across XRP and DOGE. The log refused an additional ETH entry because both NO-direction seats were occupied. These are reservations, not a claim that all requested contracts filled. Protected settings and all US holds still matched.

These checks establish the covered engineering behavior, not future trading profitability or a full exchange-outage simulation. Source backup: `G:\PROJECTS\oracle-trader-backups\codex-review-pre-20260915-0730.zip`, verified readable.

The position-cap queue serializes submissions within a venue and can add dispatch delay during bursts. Measure that delay before further execution changes. It removes the local concurrent-check race; it does not guarantee immediate consistency in venue position/order responses. General pending-order reconciliation remains listed below.

## 5. Highest-value improvements

### Priority 1: measure and reduce lost execution edge

The broad AutoTrader scan takes **103 seconds median and 203 seconds at the 95th percentile** across 678 recorded scans since September 9, against a 30-second target. Lead-lag has its own roughly 10-second loop, so the broad-scan number must not be presented as lead-lag latency. Both paths need stage-level timing.

Record source timestamp, local arrival time, executable depth, signal time, dispatch time, acknowledgement and fill time. Join every order to its strategy version and client order ID. Calculate signed price movement after 5 seconds, 30 seconds and 5 minutes, as well as settlement P&L. A profitable signal that cannot survive the actual execution delay is not a tradable edge.

Use the existing socket work to maintain the seven relevant books, with sequence checks, a proposed two-second freshness requirement and bounded REST fallback. Promote this execution path only after paired observations show reliable executable prices. Kalshi publishes book snapshots/deltas and private order updates suitable for this architecture. [Order-book stream](https://docs.kalshi.com/websockets/orderbook-updates), [private order updates](https://docs.kalshi.com/websockets/user-orders).

Recompute entry economics at the actual limit and available depth immediately before dispatch. Charge actual quantity-aware fees and a measured slippage allowance. One cent of aggressive price padding can erase the entire recent break-even gap. Do not replace the current gates with a threshold selected from these same losing days.

### Priority 2: compare against the settlement reference itself

Kalshi now documents an authenticated **CF Benchmarks value stream**, including trailing-minute and quarter-hour final-minute averages. It also documents a faster raw stream for BTC, ETH, SOL, XRP and DOGE. This provides a concrete research path beyond treating Coinbase spot or a different venue's probability as ground truth. [Value feed](https://docs.kalshi.com/websockets/cfbenchmarks-value), [5 Hz feed](https://docs.kalshi.com/websockets/cfbenchmarks-value-5hz).

Proposed separate shadow comparison: current Polymarket signal, existing Coinbase model, and a CF-reference model, all evaluated on identical windows and executable Kalshi quotes. Verify each contract's strike, reference, averaging interval and tie rule first. A cross-venue price gap can reflect different settlement definitions rather than a stale quote. REST reference access can require additional entitlement; account access and any cost have **not** been verified. [CF REST entitlement documentation](https://docs.kalshi.com/cfbenchmarks/rest-passthrough).

This should be a new, dated experiment. Do not replace or retroactively grade the spot-first test already running.

### Priority 3: make the risk budget match correlated exposure

The persisted window limits are now more reliable. Continue reporting total capital at risk per window and direction across strategies, including unresolved submissions. Add an account-level equity and drawdown view spanning stage resets; a fresh ladder stage should not visually erase older losses.

Before any future size increase, stress the candidate size against the observed worst window, consecutive losing windows, unfilled exits and a day of unavailable data. Keep the operator's current numeric limits unchanged. Larger order sizes might improve fee rounding but also worsen depth consumption and correlated loss; rounding savings alone are insufficient justification.

### Priority 4: improve each strategy within its evidence constraints

| Strategy | Recommendation |
|---|---|
| Lead-lag | First investigate quote freshness, settlement-reference mismatch and fee-adjusted execution. Preserve coin cohorts and existing stops; require a separately registered forward comparison before new coin/time filters. |
| Fade | Continue the micro test. Its small realized gains coexist with approximately **-0.88c average five-minute markout** over 129 app observations. Understand holding-period and settlement effects before scaling; a high win rate does not offset bad entry prices. |
| Mean reversion | Report current-version outcomes separately from the older windfall. Reconcile mixed-market fills before deciding whether it is a persistent earner. |
| Consensus | Preserve the corrected hold-to-settlement cohort and its deadline. Measure source freshness, match quality, executable gap and slot starvation. Historical results preceding the correction are not the new strategy's verdict. |
| Momentum / book imbalance | Preserve existing cooldowns. Use the scheduled momentum analysis to justify a new version; do not reactivate the same losing rule based on a general market rebound. |
| Volume, flow, sports, other micro arms | Let their registered limits resolve the tests. Reconcile net P&L and capital occupied; absent fills are a feasibility result, not evidence of profitability. |
| US maker / simulator | Keep operator holds and the October simulator deadline. Before future activation, reconcile cash and fees, and evaluate queue position, fill selection and inventory losses. |

For a new execution experiment, a reasonable proposal is at least seven prospective days and 200 distinct traded or paired eligible windows, with day-level uncertainty, outage reporting and sensitivity to the best day being removed. Final sample size should follow measured variance and a preselected minimum useful improvement. These are proposed rules for **new** tests, not amendments to the existing ones.

### Priority 5: include operating costs

The +$3.08 Kalshi post-redesign result is before paid data, model calls, electricity and maintenance. Existing project notes describe roughly $25/day of recent model spending; this review did not independently reconcile those bills. Even a much smaller recurring cost could exceed the observed trading margin.

Maintain separate venue P&L and business P&L. Attribute model/data spend to the experiment that uses it. Preserve the active challenger trial, then use its scheduled paired result to decide whether those calls earn their cost. Do not call a positive venue day profitable operations without this calculation.

Forward model-cost attribution is now implemented; see section 11. Historical model bills and other operating costs remain outside the measured totals.

## 6. API and outside-research findings

### Kalshi

The current order documentation uses `/portfolio/events/orders`, bid/ask on the YES book and fixed-point quantities/prices. The inspected adapter already follows this model. Older examples using different order shapes should not be copied into it. Durable client IDs and reconciliation are the next improvement for unknown submission outcomes; generating a fresh ID when retrying an uncertain order can defeat duplicate protection. [Current order endpoint](https://docs.kalshi.com/api-reference/orders/create-order-v2), [client-order-ID guidance](https://docs.kalshi.com/getting_started/quick_start_create_order).

Current rate limits are token buckets, including separate read/write accounting and endpoint weights. A token allowance is not the same as requests per second. Read the account's actual limits, prioritize order/reconciliation work over universe discovery, and retain backoff. Do not simply raise the project's shared limiter to a public headline number. [Rate limits](https://docs.kalshi.com/getting_started/rate_limits).

### Polymarket US: imminent fee change

**At 11:59 p.m. Eastern on September 16, 2026**, the published standard taker coefficient increases from **0.06 to 0.0695**. At a 50c price, the unrounded one-contract fee rises from **1.50c to 1.7375c**. Maker rebates are unchanged; per-fill rounding matters. Confirm metadata, fee estimates and actual fills before any future US reactivation. The adapter exposes the market fee coefficient, but that alone does not validate every strategy's cost calculation. [Official US fee schedule](https://docs.polymarket.us/fees).

US and global Polymarket are separate API integrations. US private and market sockets have their own authentication and payloads; global CLOB examples do not establish US order behavior. [US API introduction](https://docs.polymarket.us/api-reference/introduction), [US WebSocket documentation](https://docs.polymarket.us/api-reference/websocket/overview).

### Other traders and research

A trader describing roughly 40 automated experiments reports failures from costs, adverse selection and copying apparently obvious signals. An arbitrage discussion similarly emphasizes execution and settlement-definition problems. These are **unverified self-reports**, useful for generating tests rather than adopting their performance claims or universal exit rules. They support checking why a fill occurred and whether two contracts truly pay identically. [Kalshi experiment discussion](https://www.reddit.com/r/Kalshi/comments/1vobcrl/i_ran_about_40_automated_trading_experiments_on/), [automated arbitrage discussion](https://www.reddit.com/r/algotrading/comments/1qebxud/i_built_a_bot_to_automate_riskfree_arbitrage/).

Prediction-market market-making research also provides a framework for inventory-sensitive quotes. It is theoretical context, not evidence that this account can earn a spread after costs. The existing simulator should decide whether a specific implementation survives realistic execution. [Optimal Market Making in Prediction Markets](https://arxiv.org/abs/2607.17991).

## 7. Follow-up repairs and remaining limits

Updated after the September 15 follow-up deployment. The financial tables above retain their original snapshot.

| Previous defect | Repair and present status |
|---|---|
| Duplicate recorders | One original writer remains for each of crypto15, ladder15 and mmsim. Only redundant copies were stopped at 08:22 UTC. New launches acquire a lock and detect older Windows writers. Actual launch attempts correctly skipped the three running originals. Raw observations were preserved. |
| Unknown order outcomes | An append-only journal saves a client ID and strategy version before submission. Uncertain buy or sell responses block another submission on the same venue and market. Kalshi can recover accepted orders by client ID from current and historical order pages. Missing orders remain held; an empty search is not proof of rejection. |
| US account profit | Complete execution/inventory/cash replay reproduces **-$20.86065**, including **$33 of opposite-side netting payouts**. Cash is the venue's current balance minus margin requirement. Historical snapshots with 27 and 18 open positions reconcile too. Missing data, unsupported events or a cash/inventory mismatch make the result unavailable. |
| Future attribution | Journal entries and reconciled fills carry order ID, client ID, strategy reference and implementation version. Buy and sell routes preserve strategy references. This does not reconstruct missing historical provenance or produce a complete US strategy profit ledger. |
| Order export truncated at 8,000 | Pagination follows the final cursor, includes historical orders, and reports completeness; repeated cursors and malformed pages fail explicitly. The first complete follow-up export recovered **12,648 orders** across current and historical endpoints. |
| Rate-limit bursts and slow exits | Kalshi quotes use batches of up to 50 tickers; other venues retain batches of four. Account-verified pacing removes minute-long burst stalls and preserves order/account priority. Tape/flow reads overlap four at a time. Portfolio/profit requests coalesce, and expired flow is unavailable after a failed refresh. |
| Price protection discarded on rejection | US order creation no longer retries a rejected slippage instruction as an unprotected market order. Closing limit prices are passed to the order endpoint. Existing market buys retain their documented slippage tolerance; this is not a new strict-limit buy strategy. |
| Restart overwrites position limits | Migration version 26 is now saved after older migrations. A regression test changes the position limit and reloads the trader, proving the operator's later setting survives. Production remains at its existing 60-position cap. |

### Limits still requiring work or evidence

1. **US order recovery:** the retail create-order documentation does not expose a client-supplied order ID. The local journal holds uncertainty safely, but an order accepted without a returned exchange ID cannot yet be matched automatically with certainty. Do not release that hold using a time/price guess. [Retail create-order schema](https://docs.polymarket.us/api-reference/orders/create-order).
2. **Historical experiment integrity:** exact duplicate observations count once; conflicting observations with the same identity make the scheduled crypto15/mmsim grade inconclusive. This prevents a false pass but does not repair divergent historical simulator paths. The original files and simulator deadline remain intact. No early outcome grading was performed.
3. **Historical strategy attribution:** account profit and open inventory now reconcile, position pagination is complete, and immutable execution IDs replace timestamp deduplication. However, only **1,165 of 2,248** archived Kalshi executions and **52 of 432** US executions had recoverable strategy labels at 09:19 UTC. Future journaled orders carry provenance. The 5,000-row app history and its estimated closed-trade counters are not lifetime financial accounts; use the append-only execution archive plus full settlements/funding. Maker rebates and pooled/manual holdings still need explicit strategy allocation before treating a US arm's counters as exact profit.
4. **Evidence and performance:** production observations remain short and interrupted by deployment. See section 10 for timings. Unknown-order recovery was tested with simulated failures, not by inducing a real exchange failure. No new profitability claim or strategy promotion is supported by this repair session. The September 16 US fee change still requires actual-fill validation before US reactivation.

## 8. Existing experiment calendar preserved

| Experiment | Existing decision point |
|---|---|
| LLM challenger paired comparison | September 18 |
| Cull gate | September 19 |
| Spot-first and momentum log-odds | September 21 |
| New lead-lag coins | At least 400 settled contracts and five day clusters; October 4 default deadline |
| Corrected consensus | Registered minimums, including 40 settled and five clusters; October 13 deadline |
| Market-making simulator | October 17, 23:04 UTC |

No held-out shadow outcome dataset was opened for an early verdict in this review. Historical live account results were analyzed descriptively. The risk repairs and day-cluster correction should be treated as a dated implementation boundary in subsequent analysis, not as a new experiment start or erased history.

## 9. Additional improvement: settlement-reference observations

A separate authenticated Kalshi CF Benchmarks collector now records BTC, ETH, SOL, XRP, DOGE, BNB and HYPE reference observations, including the supplied averages. The first valid live observation arrived at **08:31:05 UTC**. It checks source timestamps and finite positive prices, throttles each index to at most one stored observation per two seconds, and reconnects with backoff. Its files live under `%APPDATA%/oracle-trader/cf-reference-shadow/`.

This is measurement only. It supplies no trading decision, changes no existing experiment rule and makes no profitability claim. The useful next comparison is settlement-reference distance versus the existing spot/CLOB signals, with a prospective rule fixed before any new strategy evaluation. [Kalshi reference feed and averaging definitions](https://docs.kalshi.com/websockets/cfbenchmarks-value).

### Follow-up verification

- Review suite: 475 passed; adversarial: 89 passed; ladder: 126 passed; risk controls: 11 scenarios passed.
- Remaining-defect suite: 11 scenarios passed; collection integrity: six synthetic scenarios passed; configuration migration and settlement accounting regressions passed.
- Type checking and production build passed. Final app PID **38088** started **08:36:31 UTC**, after the bundle was written at **08:36:16 UTC**.
- Original recorder PIDs **21864, 21560 and 20688** remained alive through deployment. Simulator run ID `33249be26379` and its October 17 deadline were unchanged. Protected trading settings and the complete US mini-trader configuration were compared before/after deployment and matched.
- By 08:40 UTC, three naturally submitted lead-lag orders had acknowledged journal records with strategy/version metadata, which survived the final restart. Reference storage contained 1,889 observations covering all seven requested indices. Crypto15 and ladder15 heartbeats reported healthy; the simulator continued writing under its original identity.
- A final complete export at 08:37 UTC included **12,707 orders**, 2,247 fills and 987 settlements; these later records are outside the original financial tables. Event-position pages are now paginated too. [Runtime verification](G:/PROJECTS/oracle-trader/tmp/testout/remaining-runtime-verification.json).
- Follow-up evidence: [deployment](G:/PROJECTS/oracle-trader/tmp/testout/deployment-r2-final-after.json), [duplicate repair](G:/PROJECTS/oracle-trader/tmp/testout/recorder-duplicate-repair.json), [US cash verification](G:/PROJECTS/oracle-trader/tmp/testout/us-cash-r2.json).

## 10. Completion pass: accounting, execution and recovery

The final application build was deployed at **09:23:45 UTC**, after its bundle was written at **09:23:32 UTC**. The main app PID was **23880**. All three independent recorders retained their original PIDs and start times. Protected risk settings, the complete US mini configuration, simulator identity and deadline were unchanged. Journal version `2026-09-15-r3` marks future submissions; existing records retain their original version.

### US account reconciliation

The adapter follows every position/activity page and replays partial sales, entry/exit commissions, paired YES/NO cash returns and settlement payouts. It verifies both final quantities and cash before reporting realized profit. Position `avgPx` already describes the held leg; execution prices use the YES book. A short entry at a 7.5c YES execution has a 92.5c position basis, which must not be complemented a second time. The account's `currentBalance` includes margin collateral; subtract the returned `marginRequirement`, rather than subtracting position cost. These interpretations are verified against the actual historical snapshots; the documentation supplies the field schema. [Balances](https://docs.polymarket.us/api-reference/account/get-account-balances), [positions](https://docs.polymarket.us/api-reference/portfolio/get-user-positions).

| Snapshot | Open positions | Cash after collateral | Open cost basis | Realized trading profit |
|---|---:|---:|---:|---:|
| September 10 | 27 | $15.78565 | $21.93150 | -$22.99285 |
| September 11 | 18 | $24.83775 | $14.85240 | -$21.01985 |
| September 15 | 0 | $39.84935 | $0 | -$20.86065 |

All three cash differences are below $0.00000001. A September 8 export has a $20 discrepancy and correctly returns **unavailable**, demonstrating that unreconciled history is not silently treated as zero profit. A fresh authenticated, GET-only check at **09:15:55 UTC** also reproduced the September 15 result. [Historical verification](G:/PROJECTS/oracle-trader/tmp/testout/us-ledger-historical-verification.json), [live verification](G:/PROJECTS/oracle-trader/tmp/testout/us-live-ledger.json).

### Repairs completed

- **Actual execution economics:** US order results expose commissions. Future immediate mini entries include paid entry fees in owned cost, and partial/full exits use actual execution prices and exit fees. Paper results retain the paper broker's complete accounting. Partial-exit research rows describe the sold quantity.
- **Execution completeness:** every unique fill is archived durably before ingestion. A schema migration backfills fills previously discarded by the five-second rule. Covered placement summaries are hidden without discarding their historical profit records. Restart/close-partial tests pass. A recent page without overlap forces full pagination on the next run; malformed/torn archives stop appends explicitly.
- **Account availability:** simultaneous portfolio requests share one computation, paper/live caches are separate, and failed exposure reads surface as errors. US collateral is adjusted once at the adapter boundary. Missing or incomplete open-order payloads fail explicitly.
- **Missing quotes and settlement:** an absent batch quote still triggers a throttled settlement probe, including when the cached close is incorrectly in the future. This does not fabricate a trading price or infer a result; an explicit venue resolution is required.
- **Latency:** Kalshi batches 50 ticker quotes per request and uses valid two-sided prices rather than stale last trades. The account reports 300 read and write tokens/second, with endpoint costs up to 50; the app conservatively allows one request per 334ms, retaining retry/backoff and priority. This is derived from the actual account, not a headline requests-per-second allowance. Flow/tape reads overlap four at a time, and irrelevant future weather days are skipped before fetching. [Account limits](https://docs.kalshi.com/api-reference/account/get-account-api-limits), [endpoint costs](https://docs.kalshi.com/api-reference/account/list-non-default-endpoint-costs), [batched markets](https://docs.kalshi.com/api-reference/market/get-markets).
- **Persistence and classification:** settings, nightly reviews and hunch state files use flushed temporary-file replacement. An injected failure before replacement leaves the old file intact. Four football market families now classify as Sports rather than matching political substrings; a mayor-election control remains Politics. No historical outcomes were regraded.

Seven completed scans on the initial 09:00 batch/pacing build had a **74.9-second median**, with **18.6 seconds for exits**. Its cold first scan took 187.8 seconds. This is encouraging operational evidence, but not a controlled comparison or proof that the configured 30-second cadence is achieved. Final-build scan timings and reconciliation status are captured in [completion runtime verification](G:/PROJECTS/oracle-trader/tmp/testout/completion-runtime-verification.json).

At **09:30 UTC**, the final build had completed three scans: **127.0, 63.2 and 73.5 seconds**, a **73.5-second median** with **18.8 seconds for exits**. The ten completed scans before the 09:00 batching deployment had medians of **184.2 seconds overall and 60.3 seconds for exits**. Cache warmth, workload and repeated restarts limit this comparison. The separate lead-lag loop continued its existing cadence. Both execution archives completed further reconciliations after the final restart, retained their exact unique counts (2,248 Kalshi, 432 US), and reported complete coverage with no reconciliation error. Nineteen acknowledged journal entries survived the restarts; no new r3 submission had occurred in this observation window.

### Verification and remaining operational boundaries

All nine project test suites passed: review 475, adversarial 89, ladder 126, risk 11 scenarios, remaining repairs 11, completion 14, collection integrity six, plus migration and settlement accounting regressions. Type checking and the production build passed. The documented intermittent adversarial failure did not recur in 20 consecutive runs; its original cause is not claimed fixed.

The obsolete standalone watchdog was not revived: its lead-lag/Dutch collectors have active in-app replacements, and current process recovery belongs to the scheduled sentinel. Windows reboot gaps, missing historical provenance, disputed historical experiment identities, finite disk capacity and the absence of version control remain operational constraints. No raw experiment data was deleted, no trial deadline was moved, and no held-out outcome was graded early. [Deployment](G:/PROJECTS/oracle-trader/tmp/testout/deployment-verified-after.json), [changed files](G:/PROJECTS/oracle-trader/tmp/testout/completion-changed-files.json).

The sentinel reported **$1.83 of OpenRouter credit** at 09:20 UTC. Exhausted credit could interrupt the paid challenger/critic observations. No credits were purchased and no model or experiment rule was changed to mask that limit. The existing far-dated Kalshi-position notification remains visible; this review did not liquidate that holding.

## 11. Improvement pass: model costs and execution diagnostics

The next improvement build started **09:44:21 UTC (PID 17844)**, after the bundle was written at **09:43:58 UTC**. Protected settings and the complete US mini configuration matched before/after deployment; the three original recorder processes retained their identities. No model, prompt, token limit, fallback order, trial rule or trading gate was changed.

### Forward operating-cost ledger

Every existing non-streaming model-call path now records the caller, requested/returned model, provider hostname, generation ID, HTTP status, elapsed time, reported token counts and known account charge. The incumbent, challenger and nightly review are separate callers. Critic charges also carry venue, strategy and critic mode; signal-vetting charges carry strategy. Every fallback attempt is recorded, including failed responses and paid responses later rejected as unusable.

OpenRouter's `usage.cost` is used once. Its upstream-cost breakdown is not added again. Missing prices, network failures and direct-provider calls remain **unknown cost**, including calls to a potentially free endpoint. This follows the provider's documented account-charge field and makes no extra provider request. Prompts, answers, authorization headers and keys are excluded. A logging failure warns without causing another model call. [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).

Files are written to `%APPDATA%/oracle-trader/model-usage/YYYY-MM-DD.jsonl`. Run `npm run costs:report -- --since 2026-09-15 --until 2026-09-16` for a UTC-day summary; the end date is exclusive. The report groups charges by caller/model/provider and explicitly counts unpriced calls. Exact duplicate request IDs count once; conflicting records fail. An empty ledger reports **no observations**, not free operation. This covers observed future app calls only, not historical invoices, other programs, paid data, electricity or subscriptions.

Verification passed for unchanged request bodies, readable original responses, one request per attempt, unknown versus explicit-zero prices, excluded secrets/content, network errors, logger failures, duplicate/conflicting identities and UTC date filtering. An isolated Electron run verified real file persistence using clearly marked synthetic responses, with **zero provider requests**. No paid request was triggered just to test this feature. [Runtime storage verification](G:/PROJECTS/oracle-trader/tmp/testout/model-usage-runtime.json), [deployment](G:/PROJECTS/oracle-trader/tmp/testout/deployment-costs-final-after.json).

### Execution diagnostics from actual orders

`npm run execution:report` reads the durable journal and execution archives without placing orders or grading trials. It reports strategy/version cohorts, outstanding states, matched partial executions, filled quantities and two available timing intervals. Negative clock intervals are flagged and excluded; missing timestamps remain unmeasured.

The **09:46 UTC snapshot** contains 19 acknowledged lead-lag orders from version r2. Intent creation to submission request had a **1ms median / 40ms p95**; submission request to acknowledgement or recovery had a **75ms median / 5,432ms p95**. These are not signal-to-fill or network-only timings: submission is recorded before the HTTP queue, and a recovered order can be acknowledged late. Signal/source and actual dispatch timestamps are not present in that cohort.

Only **one of those 19 orders** has a matched archived execution, for **eight contracts**. The remaining orders are not automatically labeled canceled or failed. The next execution investigation is to distinguish expected unfilled orders from stale quotes or incomplete outcome reporting before changing execution rules. This is a much more specific target than the broad scan duration alone. [Live execution diagnostics](G:/PROJECTS/oracle-trader/tmp/testout/execution-quality-live.json).

The new cost and execution-diagnostic tests passed, together with the 475-check review and 89-check adversarial suites, type checking and the production build. These changes improve measurement; no cost saving or profitability increase is claimed yet. The registered challenger comparison remains the decision point for changing its paid-model usage.

## Evidence and reproducibility

The analysis reconciled actual Kalshi fill quantities and fee-adjusted outcomes against all **981** available settled markets, with no mismatch above 1.5 cents or 0.015 contracts. The settlement calculation includes paired YES/NO payouts. The report separates settlement-time daily results from entry-time regime/window analysis.

US activity coverage contained 618 activities. Account profit uses cash less all observed deposits/credits because no positions remained. No raw account identifiers or credentials are needed in the report assets.

Supporting files:

- [Sanitized metrics and source hashes](G:/PROJECTS/oracle-trader/docs/reports/oracle-trader-review-2026-09-15-assets/metrics.json)
- [Attributed settlements](G:/PROJECTS/oracle-trader/docs/reports/oracle-trader-review-2026-09-15-assets/settlements.json)
- [Lead-lag entry windows](G:/PROJECTS/oracle-trader/docs/reports/oracle-trader-review-2026-09-15-assets/leadlag-windows.json)
- [Analysis script](G:/PROJECTS/oracle-trader/tmp/viability-review.py)
- [Deployment verification](G:/PROJECTS/oracle-trader/tmp/testout/deployment-after.json)
- [First-window runtime verification](G:/PROJECTS/oracle-trader/tmp/testout/runtime-window-verification.json)

The financial snapshot is fixed at 07:29 UTC even though the app continued operating during the review. Later trades are intentionally outside these totals. Supplemental app counters and scan timings were captured at 07:51 UTC and are secondary evidence.
