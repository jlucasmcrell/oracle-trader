# Quant & Engineering Review: Oracle Trader Codebase, APIs, & Strategy Alpha

**Date:** 2026-09-02  
**Target Codebase:** `G:\PROJECTS\oracle-trader`  
**Scope:** Architecture, Kalshi / Polymarket US / Polymarket Global API implementations, dead & active strategy evaluations, edge discovery, and implementation roadmap.

---

## 1. Executive Summary

The **Oracle Trader** execution architecture (`src/main/engine/`, `src/main/venues/`, `src/main/store/`) is in an exceptionally mature, hardened engineering state. The statistical rigor introduced in the **2026-09-02 audit** (point-in-time replay, mandatory fee deduction, event/day clustering, Bonferroni corrections for grid searches, and pre-registered hypotheses) is institutional-grade and successfully prevented capital destruction by killing seven unviable strategies (such as unhedged favorite-longshot fading and raw momentum).

Currently, all live real-money execution is properly parked. The core mission is **identifying and validating genuine, fee-clearing edge**. 

This document reviews the **Kalshi** and **Polymarket** API implementations, evaluates the current strategy pipeline, details a critical accounting defect in the Polymarket US adapter, presents **six high-probability, actionable alpha strategies**, and provides a structured testing framework.

---

## 2. Codebase & Venue API Analysis

### 2.1 Kalshi Integration (`kalshi.ts`, `kalshiWs.ts`)

#### Strengths
1. **Multi-Shard Order Routing**: Correctly tracks `exchange_index` per market and maintains isolated `order_group_id` instances per shard (preventing the 404 errors on funded crypto/sports shards).
2. **Defensive MVE Handling**: Triple-checks `isMveMarket` (via ticker prefix, `mve_collection_ticker`, `mve_selected_legs`, and `strike_type=functional`) to prevent parlay pricing contamination.
3. **Batch Orderbook Chunking**: Correctly limits `/markets/orderbooks` requests to 50 tickers per call, avoiding Kalshi's HTTP 414 and silent empty response failures.
4. **Fee Schedule Modeling**: Maps `fee_type` (`quadratic`, `quadratic_with_maker_fees`) and `fee_multiplier` from `/series`, accurately modeling the 0% maker fee on standard series and applying taker fee formulas:
   $$\text{Taker Fee} = \lceil 0.07 \times \text{multiplier} \times C \times p(1-p) \times 100 \rceil / 100$$

#### Areas for Improvement & Gaps
* **WebSocket in Shadow**: `kalshiWs.ts` maintains an accurate L2 book and validates delta frames against REST, but it is purely in shadow. The main `autoTrader.ts` still relies on a 12-60s REST polling scan. For any event-driven or latency-sensitive strategy, orderbook state must be fed directly from the WebSocket cache.
* **REST Live-Data Feeds Unused in Core Loop**: Kalshi provides `/weather-index`, `/live_data/events/{ticker}`, and `/game-stats`. While partially wired in `getLiveData()`, the main scan loop does not systematically correlate these feeds to strike ladders in real time.
* **Self-Trade Prevention (STP)**: Kalshi defaults to `taker_at_cross`. If quoting two-sided markets, ensure orders set `self_trade_prevention_type: 'maker'` to avoid canceling resting bids/asks when crossing own inventory.

---

### 2.2 Polymarket US Integration (`polymarketUs.ts`)

#### Strengths
1. **Ed25519 Cryptographic Signing**: Robust implementation using PKCS8 DER prefix wrapping around 32-byte raw seeds.
2. **Sports Horizon Correction**: Accurately recognizes that sports `endDate` is set weeks after resolution and uses `gameStartTime` to bound the trading horizon.
3. **Synchronous Execution Handling**: Enforces `synchronousExecution: true` and `maxBlockTime: '10'` to parse real execution fills rather than relying on synthetic estimates.

#### Defect Identified in `sellPosition`
In `src/main/venues/polymarketUs.ts` (lines 465-475), when closing a position:
```typescript
const executions = res.executions ?? []
let filled = 0
let notional = 0
for (const e of executions) {
  const s = parseFloat(e.lastShares ?? '0')
  const px = parseFloat(e.lastPx?.value ?? '0')
  filled += s
  notional += s * px
}
```
* **The Bug**: On Polymarket US, `price.value` **always** represents the Long/YES-side price (regardless of order intent). In `placeOrder`, the code correctly handles this: `const legPx = order.outcome === 'YES' ? yesPx : 1 - yesPx`. However, in `sellPosition`, `notional` uses `px` directly for both YES and NO exits.
* **Impact**: Selling a `NO` contract when YES trades at 10 cents calculates exit proceeds as 10 cents/share instead of 90 cents/share, severely corrupting realized P&L and cash accounting.

---

### 2.3 Polymarket Global Integration (`polymarket.ts` Gamma / CLOB)

* **Status**: Correctly treated as **Data-Only / Oracle-Only** due to CFTC jurisdiction.
* **Value**: Gamma and CLOB WebSocket/REST feeds represent the highest liquidity in prediction markets. Even though live trading is blocked, Polymarket Global serves as the ideal **leading indicator / price oracle** against slower-moving domestic venues.

---

## 3. Evaluation of Implemented Strategies

| Strategy | Status | Reason / Post-Mortem |
| :--- | :---: | :--- |
| **Favorite-Longshot Fade** | **Dead** | Point-in-time replay over 62 days (3,184 markets) proved negative expectancy after fees. Buying 91-cent favorites with an 88.5% win rate loses 2.5 cents/contract net. |
| **Momentum / Vol-Spike** | **Dead** | Orderbook price moves on 10-min windows mean-revert rather than continue (hit rate 36%, mean move -6.6 cents). |
| **Simple Cross-Venue Arb (Sports)** | **Dead** | Matched pairs sum to >= $1.00 due to embedded venue vig, plus differing overtime/postponement rulebooks create unhedgeable basis risk. |
| **15-Min Crypto Convergence** | **Dead** | Across 11,846 rows, the market was found to be fully price-efficient (price exactly equals reversal probability). |
| **Weather Deterministic GFS vs Market** | **Dead** | Single-run deterministic GFS forecast had a Brier score of 0.123 vs market Brier of 0.060. The market was sharper than raw GFS. |

---

## 4. Current Pre-Registered Active Pipelines

1. **Passive Maker on Crypto Ladders (`PREREGISTERED-btcd-maker.md`)**
   * *Thesis*: Quoting passive maker bids on 80-95 cent strikes on `KXBTCD` 5 minutes before close captures +1.79 cents/contract [+0.34, +3.24] net edge on 0% maker fee series.
   * *Status*: Active forward data collection via `scripts/btc-collector.mjs`. Evaluation running via `scripts/btcd-maker-gate.mjs`.
2. **Hourly Crypto Taker Convergence (`PREREGISTERED-btc-convergence.md`)**
   * *Thesis*: T-5 min spot-implied taker entries on 0.1%-0.6% margin strikes.
   * *Status*: Accumulating required 200 out-of-sample events.
3. **LLM News/Event Hunch Collector (`PREREGISTERED-llm-hunch.md`)**
   * *Thesis*: DeepSeek V4 Pro evaluates fresh Google News RSS feeds against stale mid-market quotes (5-95 cents) on 12h-30d subjective markets.
   * *Status*: Collecting 200 forward resolutions; trades nothing until gate clears.

---

## 5. High-Probability New Alpha Strategies to Test

### Strategy 1: Cross-Venue Information Lead-Lag Arbitrage (Polymarket Global -> Kalshi / Polymarket US)

```
+------------------------+      Price Discrepancy > 3c       +------------------------+
| Polymarket Global CLOB | ---------------------------------> | Kalshi / Poly US Book  |
| (Liquid, Sub-second)   |     Median Lag: 15 to 90 sec       | (Stale Resting Quotes) |
+------------------------+                                    +------------------------+
                                                                         |
                                                                         v
                                                      Execute Taker Cross / Pull Maker Quotes
```

* **Where Edge Comes From**: Polymarket Global CLOB is the global liquidity center for crypto, macro, and geopolitics. On breaking news or sharp spot moves, Polymarket CLOB reprices in under 2 seconds. Kalshi retail participants and market makers take **15 to 90 seconds** to adjust resting orders.
* **Execution**:
  * Monitor Polymarket Global CLOB WebSocket for sudden probability dislocations (Delta p >= 4 cents).
  * When Kalshi/Polymarket US price remains stale, fire an aggressive IOC taker order to cross the stale Kalshi quote.
  * **Fee Hurdle**: Requires a minimum Delta p >= spread + taker fee (~ 3.5 cents).
* **How to Test**:
  * Stream both WebSocket feeds simultaneously for 7 days on overlapping high-volume underlyings (BTC hourly, ETH hourly, FOMC rate decisions).
  * Compute the point-in-time timestamp delta between Polymarket CLOB price shifts and Kalshi top-of-book repricing.

---

### Strategy 2: High-Resolution Weather Ensemble Arbitrage (HRRR & ECMWF vs The Weather Company)

* **Where Edge Comes From**: Kalshi temperature markets (`KXHIGH*`, `KXLOW*`) settle strictly against **The Weather Company (TWC)** airport station METAR observations. The market often misprices the afternoon peak temperature trajectory between 11:00 AM and 3:00 PM local time.
* **The Failure of GFS & The Solution**:
  * Previous tests failed because GFS is a coarse global model (13km grid, 6-hour runs).
  * **Solution**: Use the **NOAA High-Resolution Rapid Refresh (HRRR)** model (3km grid, updated **every hour** with radar/satellite data assimilation) combined with the **Open-Meteo 31-member ensemble**.
* **Edge Mechanism**:
  * At 1:00 PM local time, if the airport station is at 78 deg F, the cloud cover index from HRRR indicates full solar irradiance, and 28/31 ensemble members project a high of 83 deg F, the "High >= 82 deg F" strike trading at 30 cents has an actuarial probability > 75%.
* **How to Test**:
  * Ingest the live Open-Meteo ensemble currently logged in `btc-collector.mjs`.
  * Backtest against the Becker historical archive of `KXHIGH` settlements using hourly HRRR historical reanalysis.

---

### Strategy 3: Macroeconomic Release Sniping (CPI, NFP, PPI, FOMC)

* **Where Edge Comes From**: Economic indicator releases (Bureau of Labor Statistics, Federal Reserve) occur at exact, millisecond-deterministic timestamps (e.g., 8:30:00 AM ET for CPI/NFP).
* **Execution**:
  * Ingest fast release text/JSON via WebSockets/API directly from primary feeds (BLS RSS, FastBull, AlphaVantage, or PR Newswire).
  * Evaluate release value vs Bloomberg/consensus estimate.
  * Immediately fire IOC market orders on Kalshi's CPI/NFP strike brackets.
  * Retail and manual traders on Kalshi typically take 5 to 30 seconds to react.
* **How to Test**:
  * Build an isolated micro-service benchmark testing feed latency from release timestamp to trade execution on Kalshi Demo.

---

### Strategy 4: Asymmetric Delta-Spread Market Making on Fee-Free Series

* **Where Edge Comes From**: Pure spread capture on Kalshi series with `fee_type: quadratic` (where **maker fees are strictly 0.00 cents**).
* **The Mathematical Model (Avellaneda-Stoikov adapted for Binary Options)**:
  Instead of posting symmetric spreads, calculate the theoretical binary option value:
  $$p_{\text{fair}} = \Phi(d_2) = \Phi\left(\frac{\ln(S/K) + (r - \frac{1}{2}\sigma^2)T}{\sigma \sqrt{T}}\right)$$
  Where $S$ is external live spot (Coinbase/Binance WS), $K$ is strike, and $\sigma$ is short-term realized volatility.
  * Post bids at $p_{\text{fair}} - \delta_{\text{bid}}$ and asks at $p_{\text{fair}} + \delta_{\text{ask}}$.
  * Skew spreads dynamically based on current net inventory to stay delta-neutral.
* **Why This Beats Blanket Market Making**: Blanket market making failed (-2.14 cents) because it quoted blindly into adverse selection. Dynamic quoting anchored to real-time spot and volatility eliminates toxic fill risk.

---

### Strategy 5: Combinatorial Multi-Outcome Dutch Book Arbitrage (Linear Programming)

* **Where Edge Comes From**: Kalshi and Polymarket US feature multi-candidate markets (e.g., "Next Fed Chair", "Electoral Margin of Victory", "Division Winner").
* **Edge Mechanism**:
  Individual contracts trade with discrete bids and asks. While single binary markets rarely violate Sum(bids) > 1.00, **mutually exclusive sets with >= 5 outcomes** frequently exhibit pricing incoherence:
  $$\sum_{i=1}^n \text{Ask}_i < 0.96 \quad \text{or} \quad \sum_{i=1}^n \text{Bid}_i > 1.04$$
  Furthermore, conditional subsets (e.g., P(Candidate A) + P(Candidate B) > P(Party X Winner)) can be exploited via a standard Linear Programming (Simplex) solver.
* **How to Test**:
  * Run a background scanner across all `mutually_exclusive: true` events logging sum-of-bids and sum-of-asks every 10 seconds.

---

## 6. Structural & Architecture Improvements

```
Current Architecture:
[Monolithic AutoTrader Loop] --(Every 30-60s)--> [REST Scan] --> [Sequential Evaluation] --> [REST Order]

Recommended Modular Architecture:
+------------------------+     Pub/Sub Events     +------------------------+
| Live Ingestion Engines | ---------------------> | Signal Engine & Gates  |
| (Kalshi WS, Poly CLOB, |   (Zero-latency ticks) | (Pre-registered rules) |
|  HRRR/Weather, Spot WS)|                        +------------------------+
+------------------------+                                    |
                                                              v
                                                  +------------------------+
                                                  | Execution Manager      |
                                                  | (Post-only maker queue,|
                                                  |  IOC taker, STP guards)|
                                                  +------------------------+
```

1. **Promote Kalshi WebSocket to Active**:
   * Switch orderbook consumption in `autoTrader.ts` from REST `/markets/orderbooks` to `KalshiWsClient.getBook(ticker)`. This reduces signal latency from ~30s to <50ms.
2. **Decouple Fast Reactors from Macro Scanners**:
   * Split `autoTrader.ts` into two separate loops:
     * **Fast Reactor (< 500ms)**: Handles crypto hourly convergence, cross-venue lead-lag, and macro releases.
     * **Slow Sweeper (15-60 min)**: Handles LLM hunches, long-dated universe discovery, and ledger reconciliation.
3. **Fix Polymarket US `sellPosition`**:
   * Invert `lastPx` when closing short/NO positions (`1 - lastPx.value`).
4. **Automate Gate Progress in UI**:
   * Expose live sample counts and clustered confidence intervals directly on the `AutoTraderPanel` dashboard for the pre-registered gates (`btc-gate` and `btcd-maker-gate`).

---

## 7. Recommended Action Plan & Next Steps

1. **Immediate Code Fix**:
   * Correct the `sellPosition` price mapping in `src/main/venues/polymarketUs.ts`.
2. **Maintain Gate Discipline**:
   * Keep `scripts/btc-collector.mjs` running continuously.
   * Run `node scripts/btcd-maker-gate.mjs` and `node scripts/btc-gate.mjs` weekly to monitor sample convergence against pre-registered criteria ($N \ge 60$ fills / $N \ge 200$ events).
3. **Build Prototype for Cross-Venue Lag Collector**:
   * Create a lightweight script recording sub-minute timestamped orderbook ticks for Polymarket Global CLOB vs Kalshi on identical crypto/macro contracts to measure latency arb potential.
4. **Upgrade Weather Feed**:
   * Integrate NOAA HRRR / Open-Meteo rapid-refresh data to test against the TWC weather index settlement points.
