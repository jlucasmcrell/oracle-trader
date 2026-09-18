# IBKR automated paper strategy lab

## Delivered

Oracle now runs an independent IBKR paper laboratory continuously against real ForecastEx quotes from the running Gateway. It starts with Oracle, persists positions and results, resumes after restarts, closes simulated positions automatically, and grades expired contracts using published exchange settlement files. The IBKR tab contains its controls, strategy scorecard, pending paper orders, positions, closed results, and funded-live activation controls.

This is **Oracle's local execution simulator using IBKR market data**, not a claim that orders were submitted to an IBKR paper brokerage account. No real IBKR order was submitted for this work. Kalshi's live/paper mode, strategy configuration and existing experiments are separate.

## Strategy inventory

All 23 implemented arms run automatically when their required inputs and signal conditions are present. A quiet arm is not forced to trade merely to populate a scorecard.

| Family | Arms |
|---|---|
| Probability / behavioral hypotheses | Longshot fade; favorite continuation; probability recalibration; political underconfidence |
| Price movement | Quote momentum; log-odds momentum; quote mean reversion; quote range breakout |
| Order-book hypotheses | Paired-book imbalance; depth-weighted pressure |
| Passive execution | Two-sided market making; passive longshot fade |
| Relative value / baskets | YES/NO parity; strike implication basket; neighbor-strike relative value |
| Crypto reference models | Crypto spot fair value; crypto near-expiry convergence |
| Model forecasts | News-assisted forecast; market-conditioned forecast |
| Weather forecasts | Station weather forecast; morning weather forecast; passive weather value |
| Experimental control | Deterministic market-entry control; never eligible for live promotion |

These are testable hypotheses, not established profitable strategies. Quote-based ports deliberately do not pretend to have trade-print information. The depth-weighted arm tests subsequent pressure; its weighted midpoint alone is not an executable arbitrage. Coinbase spot and measured five-minute return volatility are a proxy for CF reference settlement, with basis risk. The weather model uses NWS forecasts/observations and a wide error band; ForecastEx resolves those contracts from Weather Underground, so NWS cannot certify a certain outcome.

## Market coverage and operating limits

- Exact exchange contract IDs are joined to IBKR YES/NO instruments. Similar question titles are not sufficient.
- The full public catalog is fetched. Discovery samples up to 36 products, with category coverage and explicit crypto/economic/weather priorities, up to 12 contract pairs per product. Initial verification matched **271 markets across six categories**. The conditional product selected from the seventh category was not returned by Gateway.
- Discovery refreshes every six hours. Each non-overlapping 30-second cycle samples up to 30 pairs / 60 outcome quotes, rotating the universe and prioritizing held/pending contracts. This is not a simultaneous quote of every listed contract.
- Each strategy has its own $1,000 simulated balance, one-contract entries, four position/order slots, and a $10 daily realized-loss entry stop.
- New-entry pause leaves existing positions under automatic exit/settlement management.
- One entry opportunity per strategy/contract/outcome/UTC day prevents repeated sampling of one unchanged quote from masquerading as independent trades.
- Forecasts use the existing funded OpenRouter environment credential and `deepseek/deepseek-v4-pro`, with eight requests per UTC day. The direct DeepSeek account returned HTTP 402; its unsuccessful startup attempts remain recorded separately. Kalshi's provider configuration was not changed.

## Execution and accounting

Paper orders require a later quote than their signal. Frozen/delayed/error quotes, missing prices, absent size, and quotes over 30 seconds old cannot fill. Quantity is capped by displayed size. Each taker leg includes one cent of adverse slippage and one cent of exchange fee. Passive fills require a subsequent ask at least one cent below the resting limit; merely touching the limit does not fill the order. Queue position and fleeting liquidity can still make actual fills worse than this model.

ForecastEx exits buy the opposing outcome: estimated proceeds are $1 minus that outcome's executable ask and slippage, less the exit fee. Both entry and exit costs count. Default exits use +5c profit, -8c loss, a one-hour holding limit, or proximity to close, provided executable liquidity is available. Stops cannot promise an exit through missing liquidity. Baskets carry leg risk: independently executable legs can fill unevenly. Opposing positions on the same contract net at $1.

Expired positions are never assigned a result from an entry price or a missing quote. The settlement importer requires complementary YES/NO final values of 0 and 1, an elapsed expiry and a dated exchange CSV. Ordinary daily marks are not final settlement. It backfills seven days, extending to the oldest pending expiry up to 90 days. Missing final evidence stays unresolved and visible. Coupon/interest income is excluded.

The scorecard separates realized net, estimated open net and unpriced positions. Win count alone is not the profitability criterion. The control arm provides an indication of how much the execution model and market regime cost even without a proposed edge.

### First-run correction

The initial 47 closes were all losses, totaling $4.72 across the independent simulated accounts. Several entries already exceeded the 8c net-loss stop solely through their quoted round-trip costs. That mechanically triggered exits before the directional hypothesis had a useful opportunity to develop. The final implementation rejects non-basket signals and fills whose immediate opposing-ask exit, fees and slippage would already reach that stop. Complete exhaustive baskets remain together for settlement; an unpaired leg gets a two-minute completion window before ordinary risk management resumes. The depth-pressure trigger is 0.5c on tight books.

Initial results remain in the ledger. Do not present a before/after blend as clean evidence for the final entry rule: use the deployment time recorded in the change log when analyzing this launch correction. No arm has earned a profitability claim from this brief sample.

## Funded-live transition

The UI permits selecting evidence-qualified strategies and enabling IBKR live entries after funding. The gate requires at least 30 closed paper trades, 10 event groups, three closing days and a positive conservative lower confidence bound across daily mean net returns. The control cannot qualify. This is a screening threshold, not proof against overfitting or multiple-testing false positives.

Live orders use Oracle's existing engine caps, durable journal, broker preview, cash check and IOC execution path. The lab defaults to a $1.50 maximum order budget. It persists intent before submission, recovers unique journal references after uncertain acknowledgements, accumulates immutable execution/fee records, checks definitive completed-order quantities before retrying an unfilled remainder, and handles same-strategy YES/NO pairing before attempting exits. One strategy owns a given contract in the live lab to avoid cross-strategy netting. Turning off new live entries retains management of existing live positions.

The account currently has no funds. Actual funded fills and brokerage accounting cannot be certified without a real funded trade. The execution path is implemented and covered by simulated broker tests; the earlier broker `whatIf` preview passed after Read-Only API was disabled. Funding and deliberate live activation remain the operator's actions.

## Boundaries that software cannot manufacture

The UI explicitly lists strategies lacking necessary market data or matching instruments: trade-volume spikes, aggressor-flow following, public-wallet consensus, the existing 15-minute cross-venue lead-lag, sportsbook/player-prop anchors, mention-count models, venue-specific rewards and certain-outcome weather locks. Daily ForecastEx crypto contracts are not interchangeable with Kalshi's 15-minute windows. No missing input is replaced with invented data.

CME ECES discovery returned error 200. A second read-only probe successfully found the September ES underlying but its three returned option classes contained no EC event class. Those probes do not establish that IBKR can never support CME events; they establish that these instruments are not part of the verified, connected ForecastEx universe. This delivery is a prediction-market laboratory, not an exhaustive catalog of every possible equity, option or futures strategy available through IBKR.

## Verification and evidence

- Thirteen regression suites passed, including the dedicated lab suite. All 23 declared arms have tested signal paths.
- Tests cover future/stale/delayed quotes, next-quote fills, size-limited partial fills, passive trade-through, both fees, opposing-ask exits, authoritative settlement, corrupted-ledger refusal, restart persistence, paper/live separation, promotion gates, empty/partial IOC handling, execution deduplication, uncertain-order recovery, pairing and station/day weather boundaries.
- Removing the live-data guard caused the regression to fail; the source was restored byte-identically.
- Removing the entry-cost guard independently failed the regression as well.
- Typecheck and production build passed.
- A separate real-feed integration completed four cycles with 14 open paper positions and four closed paper trades. These are execution checks, not a profitability conclusion.
- The built renderer/preload passed Gateway account/contract reads and lab pause/resume checks using a cloned real-feed paper ledger. All 23 arms plus nine data/capability exclusions rendered; the live activation button remained disabled; no UI alerts occurred. The scorecard spans the window, and the unrelated global Live indicator is hidden on the IBKR tab.
- Production paper scans, fills, closes and persistence across restart were observed in `main.log` and `ibkr-lab.json`. Production records are separate from the integration-test ledger.
- Final check at 09:46:12 UTC: 32 scans, 21 open paper positions, 10 pending paper orders, 54 closed trades, no lab error, and zero real lab orders. Cash reconciled for every strategy. The corrected entry-cost rule was deployed at 09:44:50 UTC; preserve that boundary in performance analysis.

State: `%APPDATA%/oracle-trader/ibkr-lab.json`. Quote audit files: `ibkr-lab.json.quotes-YYYY-MM-DD.jsonl`. Dedicated research Gateway client: 17093; live execution client: 17091. The scheduled `OracleTrader-App` task continues to start Oracle at logon.

## Sources

- [IBKR TWS event-contract mechanics](https://www.interactivebrokers.com/campus/ibkr-api-page/event-trading/)
- [ForecastEx live contract catalog](https://forecastex.com/api/contracts?page=1&pageSize=1000)
- [ForecastEx published daily prices and settlement fields](https://data.forecastex.com/prices/daily_prices_20260915.csv)
- [ForecastEx daily temperature contract terms](https://data.forecastex.com/regulatory/DailyTemperatureTermsandConditions.pdf)
- [IBKR event-contract fee schedule](https://investors.interactivebrokers.com/en/pricing/commissions-events.php)
- [OpenRouter model catalog](https://openrouter.ai/api/v1/models)
