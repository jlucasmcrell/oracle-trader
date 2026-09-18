# Auto-Trading Methods for Short-Term Kalshi Markets

**A prioritized catalogue of candidate edges, grounded in the actual data the app can reach today.**

- Author: research/ideation agent (nudge task)
- Scope: Kalshi markets expiring in **15 minutes to 24 hours**
- Data budget: **free/public only** — Kalshi Trade API v2, Polymarket Gamma + CLOB (data-only, region-blocked for trading), Google News RSS, Manifold (play money)
- Companion doc: `docs/kalshi-shortterm-data.md` (written in parallel by another agent — may or may not exist yet)

---

## 0. Executive summary

The single most important finding of this review is that **Kalshi's public API is far richer than the current app uses it.** The `KalshiAdapter` in `src/main/venues/kalshi.ts` only wires up `searchMarkets`, `getOrderBook`, `getPrice`, `getMarket`, and order placement. Kalshi additionally exposes, for free and without auth:

- **1-minute candlesticks** per market (`GET /markets/{ticker}/candlesticks`, plus batch and event-level variants) — a real intraday price series on Kalshi itself, not just Polymarket.
- **The public trade tape** (`GET /markets/trades`, `GET /markets/{ticker}/trades`) with price, size, timestamp, and an `is_block_trade` flag.
- **Full order books** (`GET /markets/{ticker}/orderbook`, `GET /markets/orderbooks` for many at once).
- **Historical settled data** (`GET /historical/markets`, `/historical/trades`, `/historical/markets/{ticker}/candlesticks`) — the raw material for *out-of-sample backtesting* of every idea below.
- **Live settlement-source feeds** (`GET /live_data/...`, `GET /weather-index`, `GET /game-stats`) — including the *canonical minute-resolution temperature index that Kalshi itself uses to settle its weather markets*, and Sportradar play-by-play for sports.
- **Milestones** (`GET /milestones`) that map live events → their market tickers.
- **WebSocket streams** (orderbook, ticker, public trades, user fills) — auth required to connect, but public channels carry public data.

This changes the feasibility calculus dramatically. Several strategies that would be "buzzword-only" on a venue that gives you just `last_price` become **concretely testable** here, because the settlement source is directly observable and the historical archive lets you measure edge before risking a dollar.

### The top-5 shortlist (immediate implementation)

| # | Method | One-line reason | Edge | Feas. | Score |
|---|--------|-----------------|------|-------|-------|
| 1 | **Settlement-source convergence** (weather / scalar index) | The settlement source is *directly observable* via `/weather-index` and `/live_data`; near expiry the market must converge to a number you can already read. | 9 | 7 | 63 |
| 2 | **Within-Kalshi Dutch book** (mutually-exclusive sum) | Pure no-arbitrage on `mutually_exclusive` events; no cross-venue mapping, no news, just `Σ P(YES) ≠ 1`. | 8 | 8 | 64 |
| 3 | **Cross-venue lead-lag** (Polymarket leads Kalshi) | Polymarket reprices faster; buy the lagging Kalshi leg before it converges. Both feeds public. | 7 | 7 | 49 |
| 4 | **Favorite-longshot fade** | Longshots are systematically overpriced; buy NO on p<0.10, buy YES on p>0.90. Testable on `/historical/markets`. | 6 | 9 | 54 |
| 5 | **Order-book imbalance** | Top-of-book YES-vs-NO depth predicts short-horizon drift in thin markets; needs only the orderbook endpoint. | 5 | 8 | 40 |

*(Scores are edge-plausibility × feasibility on a 1–10 scale each; see §4 for the full ranked catalogue.)*

### Three caveats that apply to *every* method

1. **Fees are the hurdle, and they are not modeled anywhere in the app.** Kalshi uses a *quadratic* taker-fee schedule (plus maker-fee variants on some series — see `fee_type` on `GET /series`, values `quadratic`, `quadratic_with_maker_fees`, `quadratic_with_combo_maker_fees`, `flat`, and a `fee_multiplier`). The `PaperBroker` in `src/main/engine/paper.ts` fills at the quoted probability with **no fee and no spread**, so any paper backtest will *overstate* edge. Every signal below must clear `spread + taker fee` (roughly 1–3¢ per contract on a 0–100¢ scale, more on thin markets) before it is real. A market with `fee_waiver_expiration_time` in the future is fee-free until that time — a cheap filter that makes marginal strategies viable.
2. **The paper broker also ignores spread and slippage.** It fills at `quote.price` (last trade or mid). Real fills happen at the ask (buy) / bid (sell). Any backtest must be re-run against the *order book*, not the mid.
3. **REST polling latency is ~seconds, not milliseconds.** Without the WebSocket feed, a "react to the tape in 100ms" strategy is not possible. Strategies that need sub-second reaction are marked as such and are *not* in the shortlist.

---

## 1. Data inventory (what is actually reachable, endpoint by endpoint)

This is the ground truth the catalogue is built on. "✅ in adapter" means the current `KalshiAdapter` already calls it; "❌ not wired" means the endpoint exists but the app does not use it yet (and would need a small adapter addition before the strategy can run).

### Kalshi — public (no auth)

| Endpoint | Gives you | In adapter? |
|----------|-----------|-------------|
| `GET /markets` | list w/ `status`, `max_close_ts`, `min_close_ts`, `series_ticker`, `event_ticker`, `tickers`, `limit≤1000`, cursor. Per market: `yes_bid/ask_dollars`, `yes_bid/ask_size_fp`, `no_bid/ask`, `last_price_dollars`, `previous_*_dollars` (1 day ago), `volume_fp`, `volume_24h_fp`, `open_interest_fp`, `close_time`, `can_close_early`, `price_level_structure`, `price_ranges`, `fee_waiver_expiration_time` | ✅ (partial — only a few fields mapped) |
| `GET /markets/{ticker}/candlesticks` | OHLCV at **1 / 60 / 1440 min** | ❌ |
| `GET /markets/candlesticks` (batch) | candlesticks for many tickers | ❌ |
| `GET /events/{event_ticker}/candlesticks` | event-aggregated candles | ❌ |
| `GET /markets/trades` | **all** public trades (price, size, ts, `is_block_trade`) | ❌ |
| `GET /markets/{ticker}/trades` | per-market tape | ❌ |
| `GET /markets/{ticker}/orderbook` | YES bids + NO bids (sizes) — *no asks*; a NO bid at p ≡ ask-YES at 1−p | ✅ |
| `GET /markets/orderbooks` | many orderbooks in one call | ❌ |
| `GET /events` | events w/ `mutually_exclusive`, `with_nested_markets`, `with_milestones`, `series_ticker`, `min_close_ts` | ✅ (partial — category cache only) |
| `GET /series`, `GET /series/{ticker}` | recurring templates, `fee_type`, `fee_multiplier`, `category`, `tags`, `include_volume` | ✅ (partial — category search) |
| `GET /milestones` | structured targets w/ `related_event_tickers`, `start_date`, `end_date`, `type` (football_game, basketball_game, …) | ❌ |
| `GET /live_data/milestone/{id}` | live data for a milestone | ❌ |
| `GET /live_data/events/{event_ticker}` | crypto price charts, commodity, weather observations | ❌ |
| `GET /weather-index` | **canonical minute-resolution city temperature index** (the settlement source for hourly temp markets) | ❌ |
| `GET /game-stats` | Sportradar play-by-play for live sports | ❌ |
| `GET /events/{event_ticker}/forecast_percentile_history` | historical forecast percentiles | ❌ |
| `GET /search/filters_by_sport`, `GET /search/tags_by_categories` | sport/category taxonomy | ✅ (tags) |

### Kalshi — historical (public, for backtesting)

| Endpoint | Gives you | In adapter? |
|----------|-----------|-------------|
| `GET /historical/markets` | settled markets (filters mutually exclusive) | ❌ |
| `GET /historical/markets/{ticker}` | one settled market | ❌ |
| `GET /historical/markets/{ticker}/candlesticks` | 1/60/1440-min candles for a settled market | ❌ |
| `GET /historical/trades` | settled tape | ❌ |

### Kalshi — private (auth, for live execution)

| Endpoint | Gives you | In adapter? |
|----------|-----------|-------------|
| `POST /portfolio/events/orders` (V2) | place order: `side` (bid/ask on YES leg), `count`, `price`, `time_in_force` (GTC/IOC/FOK), `post_only`, `reduce_only`, `self_trade_prevention_type`, `expiration_time`, `order_group_id`, `subaccount` | ✅ (basic) |
| `POST /portfolio/events/orders/batch` | batch orders | ❌ |
| `DELETE /portfolio/events/orders/{id}` | cancel | ✅ |
| `POST /portfolio/events/orders/{id}/amend` / `decrease` | amend / reduce | ❌ |
| `GET /portfolio/positions` | positions w/ `realized_pnl_dollars`, `fees_paid_dollars` | ✅ (partial) |
| `GET /portfolio/fills` | your fills | ❌ |
| `GET /portfolio/settlements` | settlement history | ❌ |
| `GET /portfolio/balance` | balance | ✅ |
| `GET /account/endpoint_costs` | token costs per endpoint (rate-limit budget) | ❌ |
| `GET /exchange/status`, `GET /exchange/schedule` | maintenance windows / pauses | ❌ |
| `GET /user_data_timestamp` | approximate data-freshness indicator | ❌ |
| `GET /orders/{id}/queue_position` | price-time queue position (for maker orders) | ❌ |
| Order groups | rolling contract-limit auto-cancel | ❌ |

### Polymarket — public (data only; **cannot trade** — region block)

| Endpoint | Gives you | In adapter? |
|----------|-----------|-------------|
| `GET gamma-api.polymarket.com/markets` | `outcomePrices`, `volumeNum`, `volume24hr`, `liquidityNum`, `endDate`, `clobTokenIds`, `active`, `closed` | ✅ |
| `GET gamma-api.polymarket.com/public-search` | text search → events → markets | ✅ |
| `GET gamma-api.polymarket.com/markets?id=` | one market | ✅ |
| `GET clob.polymarket.com/midpoint?token_id=` | mid price | ✅ |
| `GET clob.polymarket.com/book?token_id=` | order book | ✅ |
| `GET clob.polymarket.com/prices-history?market=&interval=max&fidelity=60` | price history | ✅ |

### Other

- **Google News RSS** (`news.ts`): headline + source + pubDate, ~15 items/query. Free, no key, but **delayed by minutes** and no body text.
- **Manifold** (`manifold.ts`): play money; copy-trader source (leaderboard, user bets). Not a real-money edge source.

---

## 2. The failure-mode checklist (applied to every method)

Before the catalogue, the recurring ways a short-term prediction-market edge dies, so each entry can be read against them:

1. **Spread + fee > edge.** On a 0–100¢ binary, a 2¢ spread + 1¢ taker fee means you need >3¢ of genuine mispricing to break even. Most "signals" are smaller than this.
2. **Adverse selection.** When you buy into a move, the counterparty is often better-informed. The "volume spike" you're following may be the informed trader *you* are paying.
3. **False volume / spoofing.** `volume_fp` counts contracts, not unique traders; a single wash or a spoofed resting order can fake a signal. `is_block_trade` lets you separate negotiated blocks from organic flow.
4. **Last-minute reversal risk.** Near expiry, a 0.95 favorite can still lose; the "drift" you're harvesting is compensation for that tail, not free money.
5. **Thin-book exit risk.** You can enter a position you cannot exit; a market with 3 contracts of depth will not let you out at a fair price.
6. **Latency.** REST polling is seconds; the market reprices in milliseconds on real news.
7. **Settlement ambiguity.** "Will X happen" markets can settle on a technicality (a disputed source, a re-count). Read `rules_primary`/`rules_secondary` before betting on a "sure thing."

---

## 3. The ranked catalogue

Each entry: **thesis → signal (math/pseudocode) → why it might work → why it might fail → data + endpoints → risk controls → feasibility + verification difficulty → falsifiable test.**

---

### 3.1 Settlement-source convergence (weather / scalar index) — **#1 shortlist**

**Thesis.** For markets whose settlement value is an *already-observable* number (hourly temperature, crypto/commodity price, a running sports total), the market must converge to that number at expiry. If the market price lags the observable index, you can buy the near-certain side for a near-riskless edge.

**Signal (pseudocode).**
```
# hourly temperature market: "Will NYC high temp exceed 85°F today?"
index = GET /weather-index?city=NYC          # minute-resolution, canonical
running_high = max(index.values)             # the settlement input so far
strike = market.floor_strike                  # from scalar market, or parse binary title
time_to_close = close_time - now

if time_to_close < 30min:
    if running_high > strike and P(YES) < 0.90:  buy YES
    if running_high < strike - margin and P(YES) > 0.10:  buy NO
    # margin = max plausible remaining move (e.g. 2°F for temp)
```
The same template applies to crypto/commodity scalar markets via `GET /live_data/events/{event_ticker}` (which returns the price timeseries Kalshi uses), and to `can_close_early=true` markets where the condition is already met.

**Why it might work.** This is the closest thing to a *deterministic* edge available: the settlement source is not a future event but a number you can read right now. Kalshi publishes the exact index it settles on (`/weather-index` is described in the docs as "the canonical minute-resolution series behind hourly temperature markets"). Near expiry the remaining uncertainty is bounded (a temperature can only move so much in 20 minutes), so a market priced at 0.60 when the running high is already 3°F above the strike is mispriced by construction. Retail markets repricing slowly is a well-documented inefficiency.

**Why it might fail.** (a) The index can still move against you in the final minutes (a late heat spike). (b) Settlement rules may use a *different* source than the index you read (e.g. a specific NOAA station, a rounded value) — read `rules_primary` and `settlement_sources`. (c) The market may be thin and the "cheap" side has no depth. (d) `can_close_early` markets may close the instant the condition is met, so you must be *in before* the condition, not after. (e) Fees on a 0.90→1.00 trade are small in % but the absolute edge is also small.

**Data + endpoints.** `GET /weather-index` (city-keyed, minute resolution), `GET /live_data/events/{event_ticker}` (crypto/commodity), `GET /markets` (strike via `floor_strike`/`cap_strike` or title parse), `GET /events` (settlement sources). **None of these are wired in the adapter yet** — this is the main implementation cost.

**Risk controls.** Max stake = small % of bankroll (the edge is real but the tail is fat); only trade when `time_to_close < 30min` and the gap exceeds a 2× margin buffer; require top-of-book depth ≥ N contracts on the side you buy; never hold through a market that can still be re-determined; exit at expiry (no TP/SL needed — it's a hold-to-settlement trade).

**Feasibility: 7/10. Verification difficulty: LOW-MEDIUM.** The signal is deterministic and the historical archive (`/historical/markets` + `/historical/markets/{ticker}/candlesticks`) lets you reconstruct exactly what the index was at each minute and whether the market converged.

**Falsifiable test.** Pull 200 settled hourly-temperature markets from `/historical/markets`. For each, reconstruct the running index at T−30min and T−15min from `/weather-index` (or the settlement value + candles). Compute the P&L of "buy YES when running value already exceeds strike by >margin and P<0.90, hold to settlement," net of a 2¢ spread + 1¢ fee. **Prove:** the strategy's realized return per contract is > 0 after fees across ≥100 trades. **Disprove:** it's ≤ 0, or the "mispriced" markets are systematically the ones that reverse.

---

### 3.2 Within-Kalshi Dutch book (mutually-exclusive sum) — **#2 shortlist**

**Thesis.** In a `mutually_exclusive` event (exactly one market resolves YES), the YES prices must sum to ≤ 1 (or = 1 if exhaustive). When the sum deviates, you can buy the complement for a riskless profit — no cross-venue mapping, no news, no timing.

**Signal (pseudocode).**
```
event = GET /events?with_nested_markets=true&tickers={event_ticker}
if not event.mutually_exclusive: skip
legs = [m for m in event.markets if m.status == 'open']
S = Σ P_yes(m) over legs

if S > 1 + ε:   # overpriced partition → buy NO on every leg
    # cost = Σ (1 - P_yes(m)); payoff = (n-1) if exactly one YES
    # profit = (n-1) - Σ(1-P_yes) = S - 1  (before fees/spread)
    buy NO on all legs, size proportional to 1/leg_count
if S < 1 - ε:   # underpriced partition → buy YES on every leg
    buy YES on all legs
ε ≈ 0.03 (must clear spread + fee on every leg)
```

**Why it might work.** This is a *pure arbitrage*: the payoff is locked regardless of which leg wins. It requires no prediction, no news, no cross-venue mapping (the hardest part of §3.3), and no timing. Kalshi explicitly flags `mutually_exclusive` on events, so the partition is machine-readable. Deviations of 3–8¢ happen in thin or fast-moving events (e.g. a multi-candidate race where one candidate's market spikes on a rumor).

**Why it might fail.** (a) The deviation is usually *inside* the spread — you must buy NO at the ask on every leg, and the sum of asks is typically ≥ 1 even when the sum of mids is < 1. (b) Fees on n legs multiply the hurdle (n × 1¢). (c) `mutually_exclusive` events are often *not exhaustive* (a "none of the above" / "other" outcome exists but has no market), so `S < 1` is not automatically an arb — you must confirm exhaustiveness from `rules_primary`. (d) Legs can be added/removed mid-event. (e) You need simultaneous execution across legs or you carry one-sided risk.

**Why it's still top-2.** The `S > 1` direction (buy NO on all) is robust even when the partition is non-exhaustive: if exactly one leg resolves YES, buying NO on all n legs pays n−1 regardless of which leg, and costs Σ(1−P_yes) = n − S < n−1 when S > 1. The only requirement is *mutual exclusivity*, which Kalshi guarantees with the flag.

**Data + endpoints.** `GET /events?with_nested_markets=true` (gives `mutually_exclusive` + all leg markets with prices), `GET /markets/{ticker}/orderbook` per leg (for real ask prices). The adapter's `searchMarkets` does **not** currently surface `mutually_exclusive` — needs a small addition.

**Risk controls.** Only trade `S > 1 + ε` with ε ≥ 3× (spread + fee) per leg; cap legs at n ≤ 6 (fee multiplication); execute legs as a batch (`POST /portfolio/events/orders/batch`) or accept the one-sided risk window; size small (the arb is small); re-check `mutually_exclusive` and leg list immediately before firing.

**Feasibility: 8/10. Verification difficulty: LOW.** Fully backtestable on `/historical/markets` + `/historical/trades`: reconstruct the leg prices at any past instant and check whether the sum ever exceeded 1 by more than the fee hurdle.

**Falsifiable test.** Scan 500 historical `mutually_exclusive` events. For each, compute `S(t)` at 1-minute resolution from historical candles. Count how often `S(t) > 1 + 0.03` and, for those, compute the realized arb net of a 2¢ spread + 1¢ fee per leg. **Prove:** the arb is positive and occurs ≥ once/day on average. **Disprove:** `S > 1.03` essentially never happens, or the net arb is ≤ 0 after fees.

---

### 3.3 Cross-venue lead-lag (Polymarket leads Kalshi) — **#3 shortlist**

**Thesis.** Polymarket is crypto-native, global, and faster to reprice on news; Kalshi is US-regulated retail and lags. When the same event is priced differently, the Kalshi leg tends to converge *toward* Polymarket. Buy the lagging Kalshi side before convergence.

**Signal (pseudocode).**
```
# map Kalshi ticker ↔ Polymarket conditionId by fuzzy question match (jaccard ≥ 0.6)
p_poly = GET clob /midpoint?token_id={poly_yes_token}
p_kal  = GET /markets/{ticker} → last_price or mid
gap = p_poly - p_kal

if gap > +0.05 and time_to_close in [15min, 24h]:  buy Kalshi YES   # Kalshi cheap
if gap < -0.05 and time_to_close in [15min, 24h]:  buy Kalshi NO    # Kalshi rich
# exit when |gap| < 0.01, or at T-5min, whichever first
```

**Why it might work.** Lead-lag between a fast venue and a slow venue is one of the most robust cross-market effects in finance, and Polymarket→Kalshi is a textbook case: Polymarket has deeper liquidity, 24/7 global participation, and no KYC friction, so it incorporates information first. The app already has the machinery for this — `research.ts` computes a Jaccard similarity between venue questions and reports cross-venue probability spreads (`ArbOpportunity`). The gap is a *convergence* signal, not a pure arb (you only trade the Kalshi leg, so you're not exposed to the region block).

**Why it might fail.** (a) **Mapping is the hard part** — "Will X win?" on Kalshi vs "Will X win the 2026 election?" on Polymarket are the same event but different strings; a wrong mapping is a *fake* gap that never converges. (b) The gap may be *real* (different settlement rules, different strike, different resolution source) and never close. (c) Polymarket's `outcomePrices` can be stale or thin; the CLOB midpoint is better but still a snapshot. (d) Kalshi may be *right* and Polymarket *wrong* (Polymarket has its own biases, e.g. crypto-native skew). (e) Fees + spread on the Kalshi leg eat a 5¢ gap down to ~2¢ of real edge.

**Why it's top-3.** It's the only method that exploits a *second venue* without needing to trade it, and the lead-lag direction is well-documented. The main risk (mapping) is mitigated by the existing `research.ts` similarity code and by restricting to high-similarity (≥0.6) pairs.

**Data + endpoints.** Polymarket: `GET /markets` (search), `GET clob /midpoint`, `GET clob /prices-history` (to measure *who moved first*). Kalshi: `GET /markets`, `GET /markets/{ticker}/candlesticks` (to measure the lag). Both already partially wired; the Kalshi candlesticks call is the missing piece.

**Risk controls.** Only trade pairs with Jaccard ≥ 0.6 *and* matching `close_time` within a few minutes *and* matching settlement source; cap gap threshold at 5¢; exit at gap < 1¢ or T−5min (never hold a lagging leg into expiry); max stake small; require Kalshi depth ≥ N.

**Feasibility: 7/10. Verification difficulty: MEDIUM.** The mapping quality is the gating factor; the lead-lag itself is measurable with `prices-history` (Polymarket) vs `candlesticks` (Kalshi) on the same event.

**Falsifiable test.** Build the mapping for 100 shared events. For each, align the two price series and measure the cross-correlation at lags −30…+30 min. **Prove:** Polymarket leads Kalshi (peak correlation at a positive lag) and the Kalshi leg converges to Polymarket's price within the horizon in >60% of cases. **Disprove:** no consistent lead, or the gap is explained by fees/spread (net edge ≤ 0).

---

### 3.4 Favorite-longshot bias fade — **#4 shortlist**

**Thesis.** Prediction markets systematically overprice longshots (p < 0.10) and underprice favorites (p > 0.90). Fade the longshot (buy NO) and back the favorite (buy YES) — but only where the bias is large enough to clear fees.

**Signal (pseudocode).**
```
p = last_price (or mid)
t = time_to_close

if p < 0.10 and t in [1h, 24h]:  buy NO   # longshot overpriced → NO underpriced
if p > 0.90 and t in [1h, 24h]:  buy YES  # favorite underpriced
# hold to settlement; no intraday exit (the edge is the settlement payoff)
```

**Why it might work.** The favorite-longshot bias is one of the most replicated findings in prediction markets and sports betting: bettors overpay for the lottery-like payoff of a longshot and underpay for the boring near-certainty of a favorite. On a 0–100¢ binary, buying NO at 0.08 when the true probability is 0.05 yields +3¢ of EV per contract — enough to clear a 1¢ fee if the spread is tight. The effect is *strongest* at the extremes, which is exactly where short-term markets cluster near expiry.

**Why it might fail.** (a) The bias is *smaller* in short-horizon markets than long-horizon ones — near expiry, a 0.08 longshot is often correctly priced because the event is genuinely decided. (b) The favorite side (p>0.90) has almost no upside (max +10¢) and a fat tail (a late reversal costs 90¢), so a few reversals wipe out many small wins. (c) Fees are proportionally largest at the extremes (a 1¢ fee on a 0.08 contract is 12.5% of the stake). (d) The bias varies by category (stronger in sports/politics, weaker in weather/crypto where the "true" probability is more mechanical).

**Why it's top-4.** It's the *cheapest to test* of all the real-edge ideas: the signal is a single number (`last_price`), the data is already in the adapter, and `/historical/markets` gives thousands of settled outcomes to measure the calibration curve (does a 0.08 market actually resolve YES 8% of the time, or 5%?).

**Data + endpoints.** `GET /markets` (last_price, close_time), `GET /historical/markets` (settled outcomes for calibration). Already available; only the historical fetch is missing.

**Risk controls.** Only trade the NO side of longshots (the favorite side's tail is too fat for a small account); require p in [0.03, 0.12] (below 0.03 the fee dominates, above 0.12 the bias fades); require depth ≥ N; cap stake; never add to a losing longshot (no martingale).

**Feasibility: 9/10. Verification difficulty: LOW.** Pure calibration measurement on historical data.

**Falsifiable test.** Pull 5,000 settled binary markets from `/historical/markets`. Bucket by `last_price` at T−1h (0.00–0.05, 0.05–0.10, …). Compute the *empirical* resolution rate per bucket vs the price. **Prove:** the 0.05–0.10 bucket resolves YES at a rate meaningfully below its price (e.g. 0.06 vs 0.08), and buying NO there is net-positive after a 2¢ spread + 1¢ fee. **Disprove:** the calibration curve is the identity line (markets are already efficient at the extremes).

---

### 3.5 Order-book imbalance — **#5 shortlist**

**Thesis.** In thin short-term markets, the resting depth on the YES bid vs the NO bid predicts the next price move: a book heavy on one side gets pushed toward the other as takers hit it.

**Signal (pseudocode).**
```
ob = GET /markets/{ticker}/orderbook
yes_bid_depth = Σ size over top-3 yes bids
no_bid_depth  = Σ size over top-3 no bids   # no bid ≡ ask-YES at 1-p
imbalance = (yes_bid_depth - no_bid_depth) / (yes_bid_depth + no_bid_depth)

if imbalance > +0.5 and time_to_close in [15min, 4h]:  buy YES   # bids dominate → price up
if imbalance < -0.5 and time_to_close in [15min, 4h]:  buy NO
# exit at T-5min or when imbalance flips sign
```

**Why it might work.** Order-book imbalance is a standard short-horizon predictor in equities and crypto; in a thin prediction market the effect is amplified because a single large resting order is a large fraction of the book. A heavy YES bid wall signals demand that will lift the price as it gets filled. The orderbook endpoint is already wired in the adapter (`getOrderBook`), so this is nearly free to implement.

**Why it might fail.** (a) **Spoofing** — a resting order that is pulled before it fills is a fake signal, and thin markets are cheap to spoof. (b) **Adverse selection** — the resting bidder may be *informed* and you're joining the wrong side. (c) The orderbook only shows YES/NO *bids* (no asks), so the "imbalance" is a proxy, not the true book. (d) Imbalance is a *very* short-horizon signal (seconds–minutes); with REST polling you may be too late. (e) It predicts *direction*, not *magnitude* — the move may be smaller than the spread.

**Why it's top-5.** Highest feasibility of the microstructure ideas (endpoint already wired), and it composes with §3.6 (volume spike) into a single "flow" signal. The edge is modest but the cost to test is near zero.

**Data + endpoints.** `GET /markets/{ticker}/orderbook` (✅ wired), `GET /markets/{ticker}/candlesticks` (❌, for measuring the subsequent move). WebSocket orderbook updates would make this far stronger (sub-second), but REST polling at 5–10s is a viable v1.

**Risk controls.** Require a minimum total depth (filter out books with < 20 contracts total); require imbalance to persist across 2 consecutive polls (spoof filter); exit at T−5min; cap stake; never trade a book that just had a block trade (`is_block_trade`).

**Feasibility: 8/10. Verification difficulty: MEDIUM.** Needs a time series of orderbook snapshots, which the app does not currently record — you must log snapshots for a few days before you can test.

**Falsifiable test.** Log orderbook snapshots + subsequent 1-min candle returns for 200 short-term markets over a week. **Prove:** conditioning on `|imbalance| > 0.5`, the next 5-minute return is in the predicted direction with a hit rate > 55% and a net edge > spread+fee. **Disprove:** hit rate ≈ 50%, or the predicted move is smaller than the spread.

---

### 3.6 Volume spike + tape direction

**Thesis.** A sudden burst of volume with directional last-trades signals information arrival; follow the direction of the burst.

**Signal (pseudocode).**
```
trades = GET /markets/{ticker}/trades?limit=200
vol_10m = Σ size over trades in last 10min
baseline = median(vol_10m) over last 24h (from candles)
dir = sign(Σ (price_t - prev_price) * size_t) over last 10min

if vol_10m > 2 * baseline and |dir| strong and time_to_close in [15min, 6h]:
    buy in direction of dir
# exit at T-5min or when volume normalizes
```

**Why it might work.** Information arrival is the dominant driver of short-term repricing, and it shows up as a volume burst *before* the price fully adjusts. The tape (`/markets/trades`) gives you the raw flow, and `is_block_trade` lets you exclude negotiated blocks (which are not information).

**Why it might fail.** (a) **You are the late trader** — by the time the burst is visible in a REST poll, the informed flow has already moved the price; you're buying the *aftermath*. (b) Volume bursts are often *noise* (a whale rebalancing, a wash trade) with no information. (c) The direction of the burst is ambiguous when trades alternate sides. (d) This is the classic adverse-selection trap: the counterparty selling to you during a burst is often the informed one.

**Data + endpoints.** `GET /markets/{ticker}/trades` (❌ not wired), `GET /markets/{ticker}/candlesticks` (❌, for baseline). WebSocket public-trades would make this viable in real time.

**Risk controls.** Require `is_block_trade == false`; require the burst to be one-sided (≥70% of volume in one direction); exit at T−5min; cap stake; skip markets with < 24h of history (no baseline).

**Feasibility: 8/10 (data) but edge 4/10. Verification difficulty: MEDIUM-HIGH** (needs tape replay, which is available via `/historical/trades`).

**Falsifiable test.** Replay `/historical/trades` for 300 settled markets. Detect bursts (vol_10m > 2× baseline) and measure the return from burst-detection time to settlement, net of spread+fee. **Prove:** following the burst direction is net-positive. **Disprove:** the post-burst return is ≈ 0 or negative (you're too late).

---

### 3.7 Live-sports score-change (event-schedule-driven)

**Thesis.** Kalshi publishes Sportradar play-by-play (`GET /game-stats`). When a score changes, in-play markets ("will team X win", "total points over/under") must reprice; if you can read the score change before the market does, you have an edge.

**Signal (pseudocode).**
```
milestone = GET /milestones?type=football_game   # maps to related_event_tickers
stats = GET /game-stats?milestone_id={id}        # play-by-play
score_delta = stats.score_home - stats.score_away  # or a "win probability" field

# on a score change that flips win probability:
if win_prob crosses 0.5 upward and P(YES) < 0.55:  buy YES
if win_prob crosses 0.5 downward and P(YES) > 0.45:  buy NO
```

**Why it might work.** Sports in-play markets are less efficient than macro/political markets because the information (a score) is discrete, fast, and the market makers are not always co-located with the feed. A late-game score is a large, sudden repricing event. Kalshi *provides* the feed, which means the mapping (milestone → market) is already done for you.

**Why it might fail.** (a) **The feed is the same one the market makers use** — Kalshi's `game-stats` is Sportradar, and the professional market makers on Kalshi are almost certainly consuming the same or a faster feed; you have no latency advantage. (b) The market may reprice *before* your REST poll returns. (c) Score changes are rare and clustered; you'll sit idle most of the time. (d) "Win probability" is not directly in the feed — you'd have to model it from score + clock + down/distance, which is a real modeling project. (e) Sports markets have the strongest favorite-longshot bias, so the *direction* of the repricing is not always the "correct" one.

**Data + endpoints.** `GET /milestones` (❌), `GET /game-stats` (❌), `GET /markets` (✅). The milestone→market mapping is the key unlock and is not wired.

**Risk controls.** Only trade the *flip* (win-prob crossing 0.5), not every score; require the market to be liquid; exit at T−5min or on the next score; cap stake; never trade a market whose settlement source is ambiguous (overtime rules).

**Feasibility: 5/10. Verification difficulty: HIGH** (needs a win-probability model + live game replay, which is hard to reconstruct historically).

**Falsifiable test.** For 50 completed games, reconstruct score timeline from `game-stats` and market price from candles. **Prove:** the market price lags the score change by a measurable, exploitable window (seconds–minutes) that clears fees. **Disprove:** the market reprices within one poll interval (no exploitable lag).

---

### 3.8 Mean reversion on extremes

**Thesis.** Prices that spike to 0.95 or 0.05 on *noise* (not on a real event) revert toward the prior level; fade the spike.

**Signal (pseudocode).**
```
p_now = last_price
p_1h  = price 1h ago (from candles)
if p_now > 0.90 and p_1h < 0.80 and no news in last 1h:  buy NO   # fade the spike
if p_now < 0.10 and p_1h > 0.20 and no news in last 1h:  buy YES
# exit when price reverts to p_1h, or at T-5min
```

**Why it might work.** In the *middle* of a market's life, prices overreact to noise (a single whale, a rumor) and revert. The "no news" filter is the key: a spike *with* news is information, a spike *without* news is noise.

**Why it might fail.** (a) Near expiry, a spike to 0.95 is usually *correct* (the event is decided), not noise — mean reversion is a *mid-horizon* effect, and this project is short-horizon. (b) "No news" is hard to verify with only Google News RSS (which is delayed and incomplete). (c) Fading a spike means shorting a market that may be about to resolve against you — the tail is the entire stake. (d) The reversion magnitude is often smaller than the spread.

**Data + endpoints.** `GET /markets/{ticker}/candlesticks` (❌), Google News RSS (✅). 

**Risk controls.** Only trade when `time_to_close > 4h` (mid-horizon, where reversion lives); require a news check; exit on reversion to prior level or T−1h; cap stake; never fade a spike in a market with `can_close_early=true`.

**Feasibility: 8/10 (data) but edge 3/10. Verification difficulty: MEDIUM.**

**Falsifiable test.** On 300 settled markets, find all "spike" events (p moves >10¢ in <1h). Split by whether a correlated news headline appeared. **Prove:** no-news spikes revert with a net edge > spread+fee. **Disprove:** no-news spikes are as likely to continue as revert (the "spike" was information you couldn't see).

---

### 3.9 Momentum / trend

**Thesis.** Short-term price trends persist; buy the direction of the last 10 minutes.

**Signal (pseudocode).**
```
momentum = (p_now - p_10m_ago) / p_10m_ago
if momentum > +0.04 and time_to_close in [15min, 2h] and vol_10m > 2× baseline:
    buy YES
if momentum < -0.04 and ...:  buy NO
```

**Why it might work.** In fast-moving markets, a strong directional move can persist as momentum traders pile in. The 1-min candles make this trivially testable.

**Why it might fail.** Prediction-market momentum is *weak and often mean-reverting* — unlike equities, there's no earnings drift or index rebalancing to sustain a trend; the "trend" is usually a single information event that's already priced. The 4% threshold is likely to be crossed *after* the move is done. This is the weakest of the price-based ideas.

**Data + endpoints.** `GET /markets/{ticker}/candlesticks` (❌).

**Risk controls.** Exit at T−5min; require volume confirmation; cap stake; small position (the edge, if any, is thin).

**Feasibility: 8/10 (data) but edge 3/10. Verification difficulty: LOW** (pure candle backtest).

**Falsifiable test.** Backtest the momentum rule on 500 settled markets' 1-min candles. **Prove:** net-positive after spread+fee. **Disprove:** the 4% threshold is crossed only after the move completes (no forward edge).

---

### 3.10 News-headline driven (RSS → market mapping)

**Thesis.** A breaking headline moves a market; if you can map the headline to a Kalshi ticker and act before the market reprices, you capture the move.

**Signal (pseudocode).**
```
headlines = fetchNews(query, 15)   # Google News RSS, already in news.ts
for h in headlines where h.publishedAt within last 2min:
    market = map_headline_to_ticker(h.title)   # fuzzy match vs open markets
    if market and sentiment(h) == positive:  buy YES
    if market and sentiment(h) == negative:  buy NO
```

**Why it might work.** News is the *cause* of most short-term repricing, and a headline that maps cleanly to a market (e.g. "Fed raises rates" → "will the Fed raise rates this meeting?") is a direct signal.

**Why it might fail — and this is the decisive one.** (a) **Google News RSS is delayed by minutes** and aggregates *published* articles, not the underlying event; by the time a headline is in the RSS, the market has already moved. (b) **Mapping is hard and error-prone** — a headline about "the Fed" could map to a dozen markets, and a wrong mapping is a guaranteed loss. (c) **Sentiment is unreliable** without an LLM, and even with one, the *market's* interpretation (not yours) is what moves price. (d) The app has no LLM wired for this. This is the classic "looks great, loses money" idea for a solo retail bot.

**Data + endpoints.** Google News RSS (✅ in `news.ts`), `GET /markets` (✅). The mapping + sentiment layer is the missing (and hard) part.

**Risk controls.** Only trade headlines with a *unambiguous* single-market mapping; require the headline to be < 2min old; cap stake; exit at T−5min.

**Feasibility: 5/10. Verification difficulty: HIGH** (mapping + sentiment + latency all unproven).

**Falsifiable test.** Log headlines + market prices for 2 weeks. **Prove:** a headline's arrival *precedes* a market move by a measurable window you can act in. **Disprove:** the market has already moved by the time the RSS headline appears (latency kills it).

---

### 3.11 Time-of-day / calendar effects

**Thesis.** Liquidity, spread, and drift vary predictably by time of day and calendar (US market hours, overnight, weekends, macro-release days).

**Signal (pseudocode).**
```
# not a standalone trade — a *filter* on other strategies:
if hour in [9:30, 16:00] ET:  tighter spreads, more liquidity → allow tighter thresholds
if hour in [0:00, 6:00] ET:   wider spreads, thin books → require larger edge
if day is a macro-release day (CPI/FOMC/jobs):  expect volatility, widen stops
```

**Why it might work.** Spreads and depth are systematically better during US hours; overnight markets are thin and wide. Trading *only* during liquid windows reduces the spread+fee hurdle for every other strategy.

**Why it might fail.** As a *standalone* alpha source it's essentially zero — there's no reliable "buy at 10am, sell at 3pm" drift in prediction markets. It's a *risk/filter* tool, not an edge.

**Data + endpoints.** `GET /markets` (volume_24h, spread), `GET /exchange/schedule` (❌, maintenance windows), a static macro calendar.

**Feasibility: 9/10 (trivial). Edge: 2/10. Verification difficulty: LOW.**

**Falsifiable test.** Measure spread and depth by hour over a week. **Prove:** spreads are meaningfully tighter in US hours (justifying a time filter). **Disprove:** no systematic difference (then drop the filter).

---

### 3.12 Market-maker rest patterns / sweeps

**Thesis.** A large aggressive order that *sweeps* multiple price levels signals urgency/information; follow the sweep.

**Signal (pseudocode).**
```
trades = GET /markets/{ticker}/trades
sweep = a single side consuming ≥3 price levels within 5s, size > 5× median trade
if sweep is buy-side:  buy YES
if sweep is sell-side:  buy NO
```

**Why it might work.** Sweeps are the footprint of an informed/urgent trader; they're a cleaner signal than raw volume because they show *aggression* (paying through the book).

**Why it might fail.** (a) Requires the tape at sub-second resolution — REST polling cannot see a 5-second sweep reliably; this needs the WebSocket public-trades feed. (b) Same adverse-selection problem as §3.6. (c) Sweeps are rare in thin short-term markets.

**Data + endpoints.** `GET /markets/{ticker}/trades` (❌) or WebSocket public-trades (❌, requires auth to connect).

**Risk controls.** Exit at T−5min; cap stake; require the sweep to be one-sided.

**Feasibility: 4/10 (needs WebSocket). Edge: 4/10. Verification difficulty: HIGH.**

**Falsifiable test.** Replay `/historical/trades` to detect sweeps and measure post-sweep returns. **Prove:** net-positive. **Disprove:** post-sweep return ≈ 0.

---

### 3.13 Laddering / parlay-lite structures

**Thesis.** Structure entries/exits across price levels (ladder in, ladder out) to reduce cost basis and variance, or combine correlated legs into a "parlay-lite" to amplify a small edge.

**Why it might work.** Laddering reduces the impact of a single bad fill; a parlay of two *positively-correlated* legs (e.g. "X wins" and "X wins by >5") can concentrate a real edge.

**Why it might fail.** This is an *execution* technique, not an edge source — laddering a losing signal still loses, and parlays *multiply* fees and variance while adding no information. It's a footnote, not a strategy.

**Feasibility: 7/10. Edge: 1/10 (standalone). Verification difficulty: LOW.**

---

### 3.14 Hedging existing positions

**Thesis.** Use correlated markets to hedge an open position (e.g. buy NO on "X wins" to offset a YES on "X wins the popular vote").

**Why it might work.** Reduces variance and tail risk on a portfolio of correlated short-term bets.

**Why it might fail.** Not an alpha source — it *costs* edge to buy insurance. Include as a risk-management feature, not a strategy.

**Feasibility: 6/10. Edge: n/a (risk tool).**

---

## 4. Ranked summary table

| Rank | Method | Edge | Feas. | Score | Verif. difficulty | Needs new adapter code? |
|------|--------|------|-------|-------|-------------------|--------------------------|
| 1 | Settlement-source convergence (weather/scalar) | 9 | 7 | 63 | Low-Med | Yes (live-data, weather-index) |
| 2 | Within-Kalshi Dutch book | 8 | 8 | 64 | Low | Yes (mutually_exclusive flag) |
| 3 | Cross-venue lead-lag (Poly→Kalshi) | 7 | 7 | 49 | Med | Yes (Kalshi candles) |
| 4 | Favorite-longshot fade | 6 | 9 | 54 | Low | Yes (historical markets) |
| 5 | Order-book imbalance | 5 | 8 | 40 | Med | No (orderbook wired) |
| 6 | Volume spike + tape direction | 4 | 8 | 32 | Med-High | Yes (trades) |
| 7 | Live-sports score-change | 6 | 5 | 30 | High | Yes (milestones, game-stats) |
| 8 | Mean reversion on extremes | 3 | 8 | 24 | Med | Yes (candles) |
| 9 | Momentum / trend | 3 | 8 | 24 | Low | Yes (candles) |
| 10 | Market-maker sweeps | 4 | 4 | 16 | High | Yes (WebSocket) |
| 11 | News-headline driven | 3 | 5 | 15 | High | Yes (mapping+LLM) |
| 12 | Time-of-day / calendar | 2 | 9 | 18 | Low | No (filter only) |
| 13 | Laddering / parlay-lite | 1 | 7 | 7 | Low | No |
| 14 | Hedging | n/a | 6 | — | Low | No |

*(Score = edge × feasibility, normalized to a 1–100 feel. The top-5 shortlist is ranks 1–5; note rank 2 has the highest raw score but rank 1 is listed first because its edge is the most defensible and least dependent on execution timing.)*

---

## 5. DON'T DO (methods that look good but are provably bad here)

1. **Martingale / doubling-down.** Doubling stake after a loss to "recover" is a guaranteed blow-up on a bounded bankroll, and short-term markets resolve fast enough that a losing streak is *certain* over time. The variance is unbounded; the edge is zero. Never.

2. **Blind last-price chasing into wide spreads.** Buying whatever just moved, at the ask, in a thin market, is paying the spread + fee + adverse selection all at once. The `last_price` is a *lagging* indicator; the ask is where you actually transact. This is the single most common way retail loses on Kalshi.

3. **Cross-venue arbitrage that requires trading Polymarket.** Any "buy Kalshi cheap, sell Polymarket rich" arb is *unexecutable* — Polymarket is region-blocked for this user. The only valid cross-venue play is the *one-legged* lead-lag of §3.3 (trade Kalshi only, use Polymarket as a signal). Do not build a two-legged arb.

4. **High-frequency scalping without the WebSocket feed.** REST polling at seconds cannot compete with market makers at milliseconds. Any strategy whose edge depends on sub-second reaction is dead on arrival until the WebSocket feed is wired.

5. **Betting on markets with no exit liquidity.** A market with 2 contracts of depth lets you in but not out. Any strategy that doesn't check top-of-book depth before entry is gambling on settlement, not trading.

6. **"Buying the dip" on a market that's crashing because the event happened.** A price collapse from 0.80 to 0.20 is usually *information* (the event resolved against the YES side), not a discount. Mean-reversion logic (§3.8) must be gated on "no news / no event," or it's just catching a falling knife.

7. **Copy-trading Kalshi directly.** Kalshi does not expose other users' positions (`getTopHolders` returns `[]` in the adapter; there is no social endpoint). Copy-trading is only possible on Manifold (already implemented). Do not assume a Kalshi leaderboard exists.

8. **Parlays as an edge source.** Combining legs multiplies fees and variance without adding information. Parlays are a *product*, not an *edge*.

9. **Overfitting the backtester.** The current `backtester.ts` is a single threshold rule over Polymarket's `prices-history`, with no fee/spread model and no out-of-sample split. Any "edge" found by tuning thresholds on it is almost certainly curve-fit. Every strategy must be validated on Kalshi's `/historical/*` data with fees modeled.

---

## 6. What to build first (implementation roadmap)

The shortlist is gated on a handful of adapter additions. In priority order:

1. **Add Kalshi candlesticks + historical endpoints to `KalshiAdapter`.** `getCandlesticks(ticker, period)`, `getTrades(ticker)`, `getHistoricalMarkets()`, `getHistoricalCandlesticks(ticker)`. This unblocks §3.4, §3.5, §3.8, §3.9, and the *backtesting* of everything else. It's the highest-leverage single change.

2. **Add a fee + spread model to `PaperBroker`.** Fill at the ask (buy) / bid (sell) instead of the mid, and subtract a configurable taker fee (read `fee_type`/`fee_multiplier` from `GET /series`). Without this, every paper result is optimistic by 2–4¢/contract.

3. **Surface `mutually_exclusive` + `with_nested_markets` in the event/market mapping.** Unblocks §3.2 (the Dutch book), the cheapest real arb.

4. **Add `GET /weather-index` and `GET /live_data/events/{event_ticker}`.** Unblocks §3.1 (the strongest edge).

5. **Add `GET /milestones` + `GET /game-stats`.** Unblocks §3.7 (sports), the highest-upside but hardest-to-verify idea.

6. **Wire the WebSocket feed** (orderbook + public trades) as a longer-term upgrade — it converts §3.5/§3.6/§3.10 from "REST-polling approximations" into real-time strategies.

**Do not modify any app source files as part of this ideation task** — the above is a *plan* for the implementing agent, not a change to make now.

---

## 7. Bottom line

The realistic edges, in order of confidence: **(1)** convergence to an observable settlement source (weather/scalar), **(2)** the within-Kalshi Dutch book, **(3)** Polymarket→Kalshi lead-lag, **(4)** the favorite-longshot fade, **(5)** order-book imbalance. Everything else is either a filter, an execution technique, or a latency-limited idea that needs the WebSocket feed to be viable. The single most important enabler is **adding Kalshi's candlestick + historical endpoints to the adapter and modeling fees in the paper broker** — without those, none of the top-5 can be *verified* before risking real money.
