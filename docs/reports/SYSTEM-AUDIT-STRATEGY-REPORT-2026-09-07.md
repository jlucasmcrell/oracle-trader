# Comprehensive System, Code, Strategy, and API Review: Oracle Trader

**Date:** September 7, 2026  
**Target Codebase:** Production auto-trader desktop application (`G:\PROJECTS\oracle-trader`)  
**Stack:** Electron, TypeScript, Vite, React, Node.js  
**Venues Reviewed:** Kalshi (Trade API v2 / WebSocket), Polymarket US (CFTC Ed25519 Gateway), Polymarket Global (CLOB / Gamma), Manifold Markets  
**External Feeds Reviewed:** SportsGameOdds (SGO v2), The Odds API (v4), NOAA Weather / Aviation METAR, Coinbase Advanced Trade WebSocket, OpenRouter / LLM Cloud Engine  

---

## Executive Summary

The **Oracle Trader** application has evolved through intensive quantitative and software engineering into an institutional-grade prediction market trading terminal. The architectural discipline introduced across the enginemulti-shard routing, the statistical promotion ladder (`src/main/ladder/ladder.ts`), and the adversarial test suite (`scripts/tests/`)enforces critical invariants including point-in-time pricing, fee deduction, clustered standard errors, and automated drawdown circuit breakers.

However, an exhaustive audit of the code, execution loops, accounting pipelines, and venue API capabilities reveals:
1. **Critical Accounting and Execution Bugs**: Including fee omissions on settled Polymarket US markets, unhandled exceptions on post-only rejections that break the maker-to-taker fallback, UTC date boundary bugs in METAR peak tracking, and dropped partial fills in the fill reconciler.
2. **Substantial API Capability Gaps**: Key high-value features natively supported by the integrated exchanges (such as Kalshi **Order Groups** for automatic adverse-selection protection, **Private WebSocket Fill Feeds**, and **Subaccount Collateral Partitioning**) are currently unused, forcing the app into slower, rate-limited REST polling patterns.
3. **Alpha & Profitability Bottlenecks**: Taker fee drag on Kalshi remains the single greatest barrier to net profitability. Strategies that attempt taker crosses on thin edges are consistently stopped out by the ladder, whereas passive maker strategies are restricted by rigid pennying constraints rather than continuous inventory skewing (Avellaneda-Stoikov).

---

## Part 1: Code Defects, Logic Errors & Architectural Bugs

### 1.1 Polymarket US Fee Omission on Settled Markets (Accounting Distortion)
* **Location:** `src/main/engine/engine.ts` (lines 400415) & `src/main/venues/polymarketUs.ts` (line 411)
* **Severity:** **High (Financial Reporting Corruption)**
* **Root Cause:**
  In `polymarketUs.ts`, `getSettlements()` parses `ACTIVITY_TYPE_POSITION_RESOLUTION`. Commissions are not deducted at settlement time; they are incurred during earlier trade activities (`ACTIVITY_TYPE_TRADE`). As noted in the comments, `getSettlements()` returns `fee: 0`.
  In `engine.ts` (`getLivePnl`):
  ```typescript
  const settledMarkets = new Set(settlements.map((s) => s.marketId))
  let fillCount = 0
  if (adapter.getFills) {
    const fills = await adapter.getFills(5000).catch(() => [])
    fillCount = fills.length
    for (const f of fills) {
      if (settledMarkets.has(f.marketId)) continue // <-- BUG: Skips fills on settled markets
      fees += f.fee
      realizedPnl -= f.fee
    }
  }
  ```
  On Kalshi, settlements natively carry `fee_cost`, so skipping fills on settled markets avoids double-counting fees. But on Polymarket US, `settlement.fee` is `0`. By skipping `settledMarkets.has(f.marketId)`, **all commissions paid on trades that eventually settled are completely ignored**.
* **Impact:** Polymarket US reported realized P&L is overstated by the cumulative transaction fees paid on all settled contracts.
* **Recommended Solution:** Check the venue identity. If `venue === 'polymarket_us'`, do not skip `f.fee` for settled markets, or accumulate trade commissions directly from the trades feed rather than relying on settlement records to carry them.

---

### 1.2 Unhandled Post-Only Rejection Breaks Maker-to-Taker Fallback
* **Location:** `src/main/strategies/autoTrader.ts` (lines 22852310 and lines 24202450)
* **Severity:** **High (Execution Failure & False Alarms)**
* **Root Cause:**
  In `autoTrader.ts`, `executeSignal()` attempts a maker entry via `executeMakerEntry()`:
  ```typescript
  } else if (mode === 'live' && this.makerEntryFor(sig.strategy) && (await this.executeMakerEntry(sig, data, result))) {
    // Rested (or filled) inside the spread; managePendingOrders reconciles it.
  } else {
    // taker path
  ```
  The inline comment in `executeMakerEntry` states:
  > *"A post-only that would cross is rejected by the venue  expected occasionally... return false then let the taker path take the price that just came to us."*
  
  However, inside `executeMakerEntry`:
  ```typescript
  const res = await this.engine.placeOrder({ ... postOnly: true ... })
  if (!res.orderId) return false
  ```
  When Kalshi (or Polymarket US) rejects a `post_only` order that crosses the spread, the exchange HTTP endpoint returns an HTTP 400 error (e.g. `order_would_cross`). The HTTP client throws an `ApiError`. Because `executeMakerEntry` does **not** wrap `engine.placeOrder` in a `try/catch`, the exception bubbles straight out to `executeSignal`'s outer error handler:
  ```typescript
  } catch (err) {
    const msg = fmtErr(err)
    sig.error = msg
    result.errors.push(`execute ${sig.strategy} ${sig.marketId}: ${msg}`)
    if (mode === 'live') {
      this.liveErrorStreak++
      if (this.liveErrorStreak === 3) {
        this.alert('Oracle Trader  live order errors', `3 consecutive live order failures...`)
      }
    }
    return
  }
  ```
* **Impact:** 
  1. The taker fallback never executes; the trade opportunity is abandoned.
  2. Normal book movement rejections are treated as fatal execution errors, artificially incrementing `this.liveErrorStreak` and triggering false emergency alerts.
* **Recommended Solution:** Wrap `this.engine.placeOrder` inside `executeMakerEntry` in a `try/catch`. If the error indicates a post-only cross/rejection, log it defensively and return `false` so execution cleanly falls through to the taker path without incrementing `liveErrorStreak`.

---

### 1.3 METAR Service Running Peak Reset by UTC Date Rollover
* **Location:** `src/main/services/noaaMetar.ts` (lines 114, 177)
* **Severity:** **Medium-High (Signal Distortion for Weather Strategies)**
* **Root Cause:**
  In `noaaMetar.ts`:
  ```typescript
  const today = new Date().toISOString().slice(0, 10)
  const currentPeak = this.dailyPeak.get(item.icaoId)
  if (!currentPeak || currentPeak.date !== today) {
    this.dailyPeak.set(item.icaoId, {
      date: today,
      maxF: maxT24F ? Math.max(tempF, maxT24F) : tempF,
      minF: minT24F ? Math.min(tempF, minT24F) : tempF
    })
  }
  ```
  `new Date().toISOString().slice(0, 10)` generates the **UTC date**. At 8:00 PM Eastern Daylight Time (EDT) or 5:00 PM Pacific Daylight Time (PDT), the UTC date advances to tomorrow.
  At that exact moment, `currentPeak.date !== today` evaluates to `true`. The service discards the accumulated daytime peak (e.g., 95F at 2:00 PM EDT) and resets `maxF` to the current evening temperature (e.g., 74F at 8:00 PM EDT).
* **Impact:** Any weather settlement ratchet or peak monitoring strategy evaluating markets in the evening sees artificial drops in observed daily highs, causing severe mispricing or buying losing contracts right before Kalshi settles daily temperature contracts.
* **Recommended Solution:** Adopt the station timezone resolution implemented in `weatherDay.ts`:
  ```typescript
  const stationTz = STATION_TZ[station] ?? 'America/New_York'
  const localDate = toStationDate(station, Date.now())
  ```
  Never use UTC (`toISOString()`) to bound US local calendar day extremes.

---

### 1.4 Fill Reconciler Drops Subsequent Partial Fills
* **Location:** `src/main/store/fillReconciler.ts` (lines 8088)
* **Severity:** **Medium (Missing Trade Records & Position Drift)**
* **Root Cause:**
  `FillReconciler` reads fills from the venue and compares them to local trade history:
  ```typescript
  const placementOrderIds = new Set(existing.map((t) => t.id).filter(Boolean))
  ...
  if (f.orderId && placementOrderIds.has(f.orderId)) {
    skippedPlacement++
    continue
  }
  ```
  When an order is placed, `engine.ts` writes a `TradeRecord` with `id: res.orderId` recording whatever shares filled immediately at placement.
  If an order is partially filled at placement (e.g. 2 of 10 contracts) and the remaining 8 contracts fill moments later in one or more separate fills, every subsequent fill has the same `f.orderId`. Because `placementOrderIds.has(f.orderId)` is `true`, `FillReconciler` skips all subsequent fills.
* **Impact:** Subsequent fills on partially filled orders are never recorded in `history.json`, causing the local trade history to undercount filled contracts, distort realized P&L, and misstate open positions.
* **Recommended Solution:** Track fill uniqueness by venue **fill ID** (`f.id`), not order ID (`f.orderId`). Only skip placement records if the fill ID matches or if the sum of reconciled fill shares for that order ID equals the placement shares.

---

### 1.5 Kalshi Settlement Mapping Ignores Non-FP Count Fields
* **Location:** `src/main/venues/kalshi.ts` (lines 10451060)
* **Severity:** **Medium (Settlement Accounting Discrepancy)**
* **Root Cause:**
  In `mapKalshiSettlement`:
  ```typescript
  const yesShares = toNum(s.yes_count_fp)
  const noShares = toNum(s.no_count_fp)
  ...
  const pairedRevenue = Math.min(yesShares, noShares)
  ```
  Kalshi's API returns `yes_count_fp` and `no_count_fp` on newer markets, but returns integer `yes_count` and `no_count` on older series or standard markets (as recognized in `scripts/venue-pnl.py`: `y = f(s.get('yes_count_fp') or s.get('yes_count'))`).
  In `kalshi.ts`, if `yes_count_fp` is absent, `yesShares` and `noShares` evaluate to `0`. Consequently, `pairedRevenue` calculates as `0`, failing to credit netted pairs that were closed prior to expiration.
* **Recommended Solution:** Update mapping to fall back to integer count fields:
  ```typescript
  const yesShares = toNum(s.yes_count_fp ?? s.yes_count)
  const noShares = toNum(s.no_count_fp ?? s.no_count)
  ```

---

### 1.6 Permanent Stale Account Cache in Manifold Adapter
* **Location:** `src/main/venues/manifold.ts` (lines 195205)
* **Severity:** **Low-Medium (Stale Balance in Multi-Venue Engines)**
* **Root Cause:**
  ```typescript
  async getAccount(): Promise<AccountInfo> {
    const u = this.me ?? (await this.http.get<ManiUser>('/v0/me', this.authHeaders()))
    this.me = u
    ...
  ```
  `this.me` is populated during `init()`. Because of `this.me ?? ...`, subsequent calls to `getAccount()` never hit `/v0/me` again. While Kalshi and Polymarket US query fresh balances on every poll, Manifold's balance remains permanently frozen at its startup value.
* **Recommended Solution:** Invalidate `this.me` periodically or query `/v0/me` if more than 30 seconds have elapsed since the last fetch.

---

### 1.7 Rigid Pennying in `quoteAroundFair` Prevents Joining Book
* **Location:** `src/main/strategies/weatherForecast.ts` (lines 195205)
* **Severity:** **Medium (Quoter Opportunity Loss)**
* **Root Cause:**
  ```typescript
  if (inv >= maxInv || bid < bestBid + 0.01 - 1e-9) bid = null
  else bid = r2(Math.min(bid, bestAsk - 0.01))
  if (inv <= -maxInv || ask > bestAsk - 0.01 + 1e-9) ask = null
  else ask = r2(Math.max(ask, bestBid + 0.01))
  ```
  If `center - margin` calculates exactly equal to `bestBid`, `bid < bestBid + 0.01` evaluates to `true`, setting `bid = null`. The quoter is physically prevented from **joining the bid queue**; it can only ever post an order if it improves (pennies) the best bid. In tight 1-cent or 2-cent spread markets, this prevents resting quotes and leaves quotes unposted.
* **Recommended Solution:** Allow joining the queue (`bid < bestBid - 1e-9` sets `bid = null`), or parameterize `allowJoinBook: boolean`.

---

## Part 2: Venue & Data API Utilization vs. Available Capabilities

| Venue / Feed | Current Implementation | Available Capabilities in API (Unused) | Value / Impact of Unlocking |
| :--- | :--- | :--- | :--- |
| **Kalshi Trade API v2** | REST order placement, REST paged balances, REST orderbooks (50-chunked), basic delta WS in shadow. | 1. **Order Groups (`/portfolio/order-groups`)**<br>2. **Private WebSocket (`fill`, `order_group_updates`)**<br>3. **Subaccounts (`subaccount: 1..N`)**<br>4. `cancel_order_on_pause: true`<br>5. Live Data feeds (`/live_data/events/`, `/weather-index`) | **Transformative**: Instant exchange-side mass-cancel on adverse selection sweeps, sub-millisecond fill notifications, zero collateral starvation between strategies. |
| **Polymarket US Gateway** | REST orders, positions, balances, and activities with Ed25519 signing. `synchronousExecution: true`. | 1. Streaming WebSocket market feeds<br>2. Level-2 orderbook streaming<br>3. Fast multi-market batch cancellation | **High**: Eliminates REST polling latency; allows sub-50ms reaction to outside sports/crypto moves. |
| **Polymarket Global (CLOB/Gamma)** | Paper-only REST market search, top-of-book polling. | 1. Full CLOB WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/market`)<br>2. Live L2 book streaming<br>3. Order placement via EIP-712 / `@polymarket/clob-client` | **High**: Global Polymarket is the world's most liquid prediction venue. Streaming CLOB WS enables genuine cross-venue lead-lag arbitrage against Kalshi and PolyUS. |
| **Manifold Markets** | REST `/v0/bet`, `/v0/market`, `/v0/search-markets`. | 1. WebSocket stream (`wss://api.manifold.markets/ws`)<br>2. `GET /v0/bets?userId=...` (Open limit orders)<br>3. `/v0/market/[id]/add-liquidity` (AMM LP earning fees) | **Medium**: Enables proper open limit order management and real-time bet streaming without polling. |
| **The Odds API & SportsGameOdds** | Paid quota-managed polling of pre-game moneyline / spreads / totals. | 1. In-play live game odds updates<br>2. Event-targeted polling (T-60m windowing)<br>3. Alternate line mapping | **Very High**: Prediction markets lag live sports score changes by 5 to 30 seconds. In-play streaming odds provide immediate taker edge. |
| **NOAA / NWS Weather** | NWS 30-min cached hourly forecast grid + METAR observations. | 1. **HRRR (High-Resolution Rapid Refresh)** 3km numerical weather model (hourly updates)<br>2. NBM (National Blend of Models)<br>3. Real-time radar assimilation | **Very High**: NWS text forecast grids lag HRRR by 23 hours. Running direct HRRR model queries provides a 2-hour information edge over other weather traders. |
| **Crypto Spot Feeds** | Coinbase Advanced Trade WS (`BTC-USD`, `ETH-USD`). | 1. **CF Benchmarks BRTI / ETHUSD_RR constituent aggregation** (Kraken, Bitstamp, Gemini, Coinbase, LMAX)<br>2. Binance / Bybit perpetual futures funding & basis | **High**: Eliminates basis divergence between Coinbase spot and Kalshi's settlement index (BRTI). |
| **OpenRouter / LLM Cloud** | Sequential news and event analysis fallback chain (DeepSeek, GLM, Kimi). | 1. Structured JSON output schema enforcement<br>2. Batch asynchronous prompting<br>3. Semantic entity vector search over market titles | **Medium**: Eliminates JSON parsing errors and reduces nightly review runtime from 15 minutes to under 30 seconds. |

---

## Part 3: Deep Dive into Unleveraged Venue APIs

### 3.1 Kalshi Order Groups: The Native Adverse Selection Shield
One of the most persistent hazards for market-making strategies (`quoter.ts`, `miniAuto.ts`) is **toxic sweep risk**: an informed trader hits resting quotes across multiple brackets simultaneously upon news or a temperature surge.

Kalshi's API v2 natively provides **Order Groups** (`POST /portfolio/order-groups`):
```json
{
  "contracts_limit": 10,
  "rolling_window_milliseconds": 15000
}
```
* **How It Works:** Any order assigned `order_group_id: "grp_xxx"` is tracked by Kalshi's internal matching engine. If the number of contracts executed across all orders in the group exceeds `contracts_limit` (e.g. 10 contracts) within a rolling 15-second window:
  1. The exchange **automatically and instantly cancels all remaining open orders in the group**.
  2. No new orders can be placed in that group until reset.
* **Mass Cancellation:** Calling `DELETE /portfolio/order-groups/{id}` or `POST /portfolio/order-groups/{id}/trigger` cancels every order in the group in **a single round-trip**, eliminating the latency of canceling 10 to 20 quotes sequentially via REST.

### 3.2 Kalshi Subaccounts: Eliminating Strategy Collateral Starvation
Currently, all strategies (Quoter, Crypto Convergence, Sports Anchor, Dutch Book) trade on default `subaccount: 0`.
* In live trading runs, Quoter resting orders tied up collateral on Shard 0, preventing AutoTrader from placing orders on other markets.
* Furthermore, mixed trades in a single account cause cross-strategy P&L attribution contamination.
* **The Solution:** Kalshi supports integer subaccounts (`subaccount: 1, 2, 3...`). Assigning:
  * Subaccount 1 $\rightarrow$ Passive Weather Quoter
  * Subaccount 2 $\rightarrow$ Sports Anchor
  * Subaccount 3 $\rightarrow$ Crypto Convergence
  * Subaccount 4 $\rightarrow$ Dutch Book / Arbitrage  
  guarantees 100% collateral isolation, independent margin allocation, and clean, venue-authoritative P&L reporting.

### 3.3 Kalshi Private WebSocket (`fill` channel)
Currently, `fillReconciler.ts` queries the REST endpoint on a 3-minute timer to detect resting fills.
* By subscribing to Kalshi's authenticated WebSocket channel `fill`, the application receives an asynchronous push event within **5 to 15 milliseconds** of any fill.
* This allows instant inventory re-hedging, dynamic quote cancellation on opposing legs, and immediate stop-loss execution, eliminating 3 minutes of adverse market exposure.

---

## Part 4: Strategy Audit & Profitability Analysis

### 4.1 Taker Fee Hurdle vs. Expected Value
On Kalshi, taker orders incur a fee:
$$\text{Fee} = \lceil 0.07 \times \text{multiplier} \times C \times p(1-p) \times 100 \rceil / 100$$
For a contract trading at $0.50$, the taker fee is approximately **$0.0175 per contract** (nearly 3.5% of notional).
* **The Failure Mode:** Any strategy attempting to capture a 2 or 3 edge via taker orders (such as `leadLag`, `cryptoConvergence`, or `fade`) immediately gives up 1.75 to the exchange. If the trade slips by 1, net expectancy is negative.
* **The Rule for Profitability:** 
  * **Taker entries are only viable when the edge is $> 5$** (e.g., deterministic settlement ratchet or extreme late-game sports mispricings).
  * All small-edge strategies ($1 - 4$) **must execute as passive makers** (0% fee on standard Kalshi series).

### 4.2 Weather Quoting: From Rigid Pennying to Avellaneda-Stoikov
The current weather quoter places static quotes offset by `quoterFairMarginCents` and shuts off when inventory hits `quoterMaxInventory`.
* **The Problem:** It either quotes at full size or shuts down completely. If inventory accumulates on the long side (+5 contracts), the bot continues to quote bids at the same distance until the hard cap is reached.
* **Quantitative Upgrade:** Implement continuous **inventory-skewed reservation pricing** (Avellaneda-Stoikov):
  $$r(s, q, t) = s - q \cdot \gamma \cdot \sigma^2 \cdot (T - t)$$
  * Where $s$ is the forecast fair value, $q$ is current inventory, $\gamma$ is risk aversion, and $\sigma$ is forecast uncertainty.
  * As long inventory increases ($q > 0$), the reservation price $r$ smoothly shifts downward: the bid retreats deeper into the spread while the ask becomes more aggressive, naturally attracting sellers to rebalance inventory back to zero without taking toxic losses.

### 4.3 High-Alpha Strategy Pipeline

```
+----------------------------------------------------------------------------------------------------+
|                                    ORACLE TRADER ALPHA ROADMAP                                     |
+----------------------------------------------------------------------------------------------------+
|                                                                                                    |
|  1. HRRR Weather Model Ingestion        2. In-Play Sports Latency Arbitrage                        |
|  +-------------------------------+      +-----------------------------------+                      |
|  | NOAA HRRR Hourly 3km Run      |      | The Odds API / SGO Live Feed      |                      |
|  | (Updates 2h faster than NWS)  |      | (Real-time score & line shift)    |                      |
|  +---------------+---------------+      +-----------------+-----------------+                      |
|                  |                                        |                                        |
|                  v                                        v                                        |
|  +-------------------------------+      +-----------------------------------+                      |
|  | Weather Settlement Ratchet    |      | Kalshi / PolyUS Retail Lag        |                      |
|  | (Snipes un-updated strikes)   |      | (Snipes 10-30s stale books)       |                      |
|  +---------------+---------------+      +-----------------+-----------------+                      |
|                  |                                        |                                        |
|                  +--------------------+-------------------+                                        |
|                                       |                                                            |
|                                       v                                                            |
|                    +-------------------------------------+                                         |
|                    |      EXECUTION ROUTING ENGINE       |                                         |
|                    |  - Kalshi Order Groups (STP=maker)  |                                         |
|                    |  - Isolated Strategy Subaccounts    |                                         |
|                    |  - Private WS Instant Fill Feedback |                                         |
|                    +-------------------------------------+                                         |
+----------------------------------------------------------------------------------------------------+
```

#### Strategy 1: The HRRR Intraday Temperature Convergence
* **Mechanism:** The National Weather Service (NWS) point forecasts cached in `weatherForecast.ts` are generated from public blend models that update only a few times a day. In contrast, the **HRRR (High-Resolution Rapid Refresh)** model runs every single hour at 3km grid resolution, assimilating real-time Doppler radar and surface station observations.
* **Edge:** Between 11:00 AM and 3:00 PM local station time, HRRR knows whether solar heating or cloud cover will cause the daily maximum temperature to peak at 88F or 92F approximately **60 to 120 minutes before Kalshi market participants update their brackets**.
* **Execution:** Taker sweep of mispriced $>90$ NO contracts on brackets that HRRR proves are physically unreachable.

#### Strategy 2: In-Play Live Sports Score Arbitrage
* **Mechanism:** Prediction market retail traders on Kalshi and Polymarket US do not monitor live games with sub-second sports trading terminals. When a team scores in an MLB game or scores a touchdown in NFL/CFB, the win probability instantly jumps by 10% to 25%.
* **Edge:** Using live in-play feeds from SGO or The Odds API, detect the shift within 1 second and immediately execute marketable taker orders on Kalshi before retail quotes are pulled.
* **Fee Clearance:** A 15% probability jump easily clears the 1.75% Kalshi taker fee hurdle, producing an expected net return of $+10$ to $+13$ per contract.

#### Strategy 3: Multi-Outcome Dutch Book Arbitrage (Combinatorial Sweeps)
* **Mechanism:** Kalshi and Polymarket US list multiple-candidate or multiple-bracket events where exactly one outcome will resolve YES (e.g. Academy Awards, Division Winners, Weather Brackets).
* **Edge:** In thin markets, the sum of all best asks across all mutually exclusive outcomes frequently drops below $\$0.96$:
  $$\sum_{i=1}^{k} \text{Ask}_i < 1.00 - \text{Taker Fees}$$
* **Execution:** Using an atomic execution wrapper, place concurrent `fill_or_kill` (FOK) orders across all $k$ legs. If all fill, a guaranteed profit of $\$1.00 - \sum \text{Cost}$ is locked in with zero market risk. If any leg fails to fill, all are cancelled.

---

## Part 5: Comprehensive Action Plan

### Tier 1: Immediate Safety & Accounting Fixes
1. **Fix Polymarket US Settled Fees:** Update `engine.ts` so that trade commissions on settled markets are not bypassed during realized P&L calculation.
2. **Handle Post-Only Rejections in AutoTrader:** Wrap `engine.placeOrder` inside `executeMakerEntry` in a `try/catch` to allow clean fall-through to the taker path and prevent false alert streaks.
3. **Patch METAR Date Rollover:** Replace `toISOString().slice(0, 10)` in `noaaMetar.ts` with local station calendar dates using `Intl.DateTimeFormat`.
4. **Fix FillReconciler Uniqueness:** De-duplicate fills by `fill.id` instead of `order.id` to capture all partial fills.
5. **Support Integer Counts in `mapKalshiSettlement`:** Fall back to `yes_count` / `no_count` when `_fp` variants are undefined.

### Tier 2: Venue API Upgrades
1. **Implement Kalshi Order Groups:** Wrap Quoter and Maker orders into an Order Group with a 15-second contract limit to eliminate toxic adverse selection sweeps.
2. **Partition by Kalshi Subaccount:** Assign dedicated subaccount IDs to the Quoter (Subaccount 1), Sports Anchor (Subaccount 2), and Convergence (Subaccount 3) to prevent collateral locking and ensure clean ledger accounting.
3. **Promote Kalshi WebSocket to Live Execution:** Transition `autoTrader` and `quoter` orderbook lookups from polling REST to the live WebSocket book maintained in `kalshiWs.ts`.
4. **Enable `cancel_order_on_pause: true`:** Protect all resting limit orders from being picked off when exchange markets unpause following volatility halts.

### Tier 3: Strategy & Alpha Modernization
1. **Adopt Avellaneda-Stoikov Inventory Skewing:** Replace hard cutoffs in `quoter.ts` with continuous reservation price adjustments that shade bids down and asks down as inventory increases.
2. **Integrate Hourly HRRR Weather Models:** Query the NOAA HRRR numerical grid to predict maximum temperatures 12 hours before consensus market quotes adjust.
3. **Deploy In-Play Sports Arbitrage:** Use real-time live game feeds to sweep stale retail quotes following major in-game scoring events.
4. **Activate Atomic Multi-Outcome Dutch Books:** Scan mutually exclusive events for combined ask sums $< \$0.95$ and execute via concurrent FOK orders.

---

## Conclusion

The core architecture of Oracle Trader is exceptionally solid, with mature risk checks, multi-shard routing, and statistical validation. By eliminating the identified accounting and post-only handling bugs, unlocking native exchange capabilities like **Order Groups** and **Subaccounts**, and transitioning from passive fee-paying takers to inventory-skewed makers and high-edge event snipers, the platform will establish a robust, sustainable, and fee-clearing quantitative edge.
