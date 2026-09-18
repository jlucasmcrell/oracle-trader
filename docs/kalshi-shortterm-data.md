# Kalshi Trade API v2 — Short-Term Trading Data Reference

> Research report for the `oracle-trader` prediction-market auto-trader, focused on **short-term markets (15 min – 24 h expiry)**.
> Base URL: `https://api.elections.kalshi.com/trade-api/v2` (recommended: `https://external-api.kalshi.com/trade-api/v2`).
> Docs: https://docs.kalshi.com · OpenAPI: https://docs.kalshi.com/openapi.yaml · AsyncAPI (WebSocket): https://docs.kalshi.com/asyncapi.yaml
> **Every claim below was verified against live responses on 2026-08-28** (public endpoints, no auth) unless marked "documented only".

---

## 1. TL;DR — what matters for short-term signals

| Signal need | Available? | How |
|---|---|---|
| Last price / probability | ✅ | `last_price_dollars` on market; `yes_bid/yes_ask` midpoint |
| Trade tape (tick-by-tick) | ✅ | `GET /markets/trades` (public) + WS `trade` channel |
| OHLC candles | ⚠️ **1-min minimum** | `GET /markets/candlesticks` — **no 5s/15s/30s/5m/15m** |
| Volume | ✅ | `volume_fp`, `volume_24h_fp` (contracts), `dollar_volume` (WS) |
| Open interest | ⚠️ contracts only | `open_interest_fp` (contract count, **not dollars**) |
| Book depth / imbalance | ✅ | `GET /markets/{ticker}/orderbook` (public) + WS `orderbook_delta` |
| Real-time streaming | ⚠️ **auth required** | WebSocket (even public channels need API key) |
| Settlement timing | ✅ | `settlement_timer_seconds`, `settlement_ts`, `close_time` |
| Liquidity (dollars) | ❌ **deprecated** | `liquidity_dollars` always `"0.0000"` — compute from book |

**Biggest gotchas for short-term trading:** (1) candlesticks only go down to **1 minute**; (2) `liquidity_dollars` is dead; (3) open interest is in **contracts**, not dollars; (4) the WebSocket requires authentication even for public price/trade feeds.

---

## 2. Authentication

- **Public (no auth):** `GET /markets`, `GET /markets/{ticker}`, `GET /markets/trades`, `GET /markets/candlesticks`, `GET /markets/{ticker}/orderbook`, `GET /events`, `GET /events/{event_ticker}`, `GET /series`, `GET /series/{series_ticker}`, `GET /historical/cutoff`. All verified live with no headers.
- **Auth required:** portfolio/orders/positions/balance, and **the WebSocket connection itself**.
- **Signing** (RSA-PSS, SHA-256, salt length = digest length) — matches the existing `KalshiAdapter.authHeaders`:
  ```
  message = `${timestamp_ms}${METHOD}${/trade-api/v2 + path}`   // path WITHOUT query string
  signature = base64( RSA-PSS-SHA256( privateKey, message ) )
  headers: KALSHI-ACCESS-KEY, KALSHI-ACCESS-TIMESTAMP, KALSHI-ACCESS-SIGNATURE
  ```
- **Gotcha:** the OpenAPI spec marks `GET /markets/{ticker}/orderbook` and `GET /markets/orderbooks` with `security: kalshiAccessKey`, but **both work unauthenticated in practice** (verified 200 with no headers). Treat them as public.

---

## 3. Endpoints (path + params + verified response shape)

### 3.1 `GET /markets` — list/filter markets

**Params:** `limit` (1–1000, default 100), `cursor`, `event_ticker` (single), `series_ticker`, `tickers` (comma-separated), `min_created_ts`, `max_created_ts`, `min_updated_ts`, `min_close_ts`, `max_close_ts`, `min_settled_ts`, `max_settled_ts`, `status`, `mve_filter` (`only`|`exclude`).

**`status` filter values** (query param) vs the market object's own `status` field — **they differ**:

| Query `status=` | Matches market `status` |
|---|---|
| `unopened` | `initialized` |
| `open` | `active` |
| `paused` | `inactive` |
| `closed` | past `close_time`, not yet `finalized` |
| `settled` | `finalized` |

**Market object `status` enum:** `initialized`, `inactive`, `active`, `closed`, `determined`, `disputed`, `amended`, `finalized`.

**Gotcha (docs vs reality):** the docs' compatibility table says `max_close_ts` is only compatible with `status=closed` or empty. **Live test shows `status=open&max_close_ts=…` works fine** (returned 720 open markets). The existing adapter's `status=open&max_close_ts` approach is correct in practice.

**Response:** `{ "markets": [Market…], "cursor": "…" }`.

### 3.2 `GET /markets/{ticker}` — single market (full shape)

**Response:** `{ "market": { … } }`. Verified live sample (a 15-min XRP strike market):

```json
{
  "market": {
    "ticker": "KXXRPD-26AUG2721-T2.1399",
    "event_ticker": "KXXRPD-26AUG2721",
    "market_type": "binary",
    "yes_sub_title": "$2.13991 or above",
    "no_sub_title": "$2.13991 or above",
    "status": "active",
    "result": "",
    "open_time": "2026-08-28T00:00:00Z",
    "close_time": "2026-08-28T01:00:00Z",
    "expected_expiration_time": "2026-08-28T01:05:00Z",
    "latest_expiration_time": "2026-09-04T01:00:00Z",
    "expiration_time": "2026-09-04T01:00:00Z",
    "settlement_timer_seconds": 1800,
    "can_close_early": true,
    "notional_value_dollars": "1.0000",
    "yes_bid_dollars": "0.0000",
    "yes_ask_dollars": "0.0100",
    "no_bid_dollars": "0.9900",
    "no_ask_dollars": "1.0000",
    "yes_bid_size_fp": "0.00",
    "yes_ask_size_fp": "29000.00",
    "last_price_dollars": "0.0000",
    "previous_yes_bid_dollars": "0.0000",
    "previous_yes_ask_dollars": "0.0000",
    "previous_price_dollars": "0.0000",
    "volume_fp": "0.00",
    "volume_24h_fp": "0.00",
    "open_interest_fp": "0.00",
    "liquidity_dollars": "0.0000",
    "price_level_structure": "linear_cent",
    "price_ranges": [ { "start": "0.0000", "end": "1.0000", "step": "0.0100" } ],
    "strike_type": "greater",
    "floor_strike": 2.1399,
    "rules_primary": "If the simple average of the sixty seconds of CF Benchmarks' Ripple-Dollar Real Time Index (XRPUSD_RTI) before 9 PM EDT is above 2.1399 …",
    "rules_secondary": "…",
    "exchange_index": 2
  }
}
```

**Fields relevant to short-term trading:**

| Field | Type | Notes |
|---|---|---|
| `last_price_dollars` | string | Last traded YES price. `"0.0000"` when untraded. |
| `yes_bid_dollars` / `yes_ask_dollars` | string | Top-of-book YES. |
| `no_bid_dollars` / `no_ask_dollars` | string | Top-of-book NO. |
| `yes_bid_size_fp` / `yes_ask_size_fp` | string | Top-of-book size in **contracts** (fp). |
| `volume_fp` | string | Lifetime volume in **contracts**. |
| `volume_24h_fp` | string | 24h volume in **contracts**. |
| `open_interest_fp` | string | Open interest in **contracts** (no netting). **There is no `open_interest_dollars` field.** |
| `liquidity_dollars` | string | **DEPRECATED — always `"0.0000"`.** |
| `previous_price_dollars` | string | Last trade price **a day ago** (useful for 24h momentum). |
| `previous_yes_bid/ask_dollars` | string | Top-of-book a day ago. |
| `close_time` | date-time | Trading stops. May move earlier if `can_close_early`. |
| `expected_expiration_time` | date-time | When outcome is expected known. |
| `latest_expiration_time` | date-time | Latest possible expiry. |
| `settlement_timer_seconds` | int | Seconds after determination before settlement (e.g. 1800 = 30 min). |
| `settlement_ts` | date-time | Populated **only for settled (`finalized`) markets**. |
| `settlement_value_dollars` | string | YES settlement value, only after determination. |
| `result` | `yes`/`no`/`scalar`/`""` | Empty until determined. |
| `notional_value_dollars` | string | Value of one contract at settlement (usually `"1.0000"`). |
| `price_level_structure` / `price_ranges` | — | Tick-size structure (e.g. `linear_cent`, step `0.01`). |
| `exchange_index` | int | Exchange shard id. |

> **Note:** `title` and `subtitle` on the market are **deprecated** — use `yes_sub_title`/`no_sub_title` plus the event's `title`. `expiration_time` is deprecated — use `latest_expiration_time` (or `expected_expiration_time`).

### 3.3 `GET /markets/trades` — recent trades (public)

**Params:** `limit` (1–1000, default 100), `cursor`, `ticker` (single market), `min_ts`, `max_ts` (Unix seconds), `is_block_trade` (`true`/`false`).

**Auth:** none (verified 200 unauthenticated).

**Response:** `{ "trades": [Trade…], "cursor": "…" }`. Verified live sample:

```json
{
  "cursor": "EhIKEAchUtfc0aHBzwMxPZJUhh0aDAjArMPUBhCo8OKoAg",
  "trades": [
    {
      "trade_id": "072152d7-3829-a9cb-2e04-2c79b05b0ce8",
      "ticker": "KXMLBGAME-26AUG271910MILNYM-MIL",
      "count_fp": "5.24",
      "yes_price_dollars": "0.9500",
      "no_price_dollars": "0.0500",
      "taker_outcome_side": "yes",
      "taker_book_side": "bid",
      "taker_side": "yes",
      "created_time": "2026-08-28T00:28:48.625895Z",
      "is_block_trade": false
    }
  ]
}
```

**Trade fields:** `trade_id`, `ticker`, `count_fp` (contracts, string), `yes_price_dollars`, `no_price_dollars`, `taker_outcome_side` (`yes`/`no`), `taker_book_side` (`bid`/`ask`), `taker_side` (**deprecated**, still present), `created_time` (RFC3339), `is_block_trade`.

**Gotchas:**
- `taker_side` is deprecated in favor of `taker_outcome_side` / `taker_book_side`; it will be removed **no earlier than May 14, 2026** (still present in live responses as of 2026-08-28).
- `taker_outcome_side` = directional exposure: buy-yes & sell-no → `yes`; buy-no & sell-yes → `no`. `taker_book_side`: `bid` ≡ `yes`, `ask` ≡ `no`.
- `count_fp` is a **string** (fixed-point, 2 decimals). `yes_price_dollars`/`no_price_dollars` are **strings**.
- Trades older than the historical cutoff (~3 months) are **not** returned here — use `GET /historical/trades`.

### 3.4 `GET /markets/candlesticks` — batch OHLC (public) ⭐

**This is the endpoint you asked about — it exists.** It does **not** require a `series_ticker`.

**Params:** `market_tickers` (comma-separated, **max 100**), `start_ts` (Unix seconds, required), `end_ts` (required), `period_interval` (minutes, required), `include_latest_before_start` (bool).

**Auth:** none (verified 200 unauthenticated).

**Response:** `{ "markets": [ { "market_ticker": "…", "candlesticks": [Candle…] } ] }`. Verified live sample:

```json
{
  "markets": [
    {
      "market_ticker": "KXXRPD-26AUG2721-T2.1399",
      "candlesticks": [
        {
          "end_period_ts": 1787875260,
          "open_interest_fp": "0.00",
          "volume_fp": "0.00",
          "price": {},
          "yes_bid": { "open_dollars": "0.0000", "high_dollars": "0.0000", "low_dollars": "0.0000", "close_dollars": "0.0000" },
          "yes_ask": { "open_dollars": "0.0100", "high_dollars": "0.0100", "low_dollars": "0.0100", "close_dollars": "0.0100" }
        }
      ]
    }
  ]
}
```

**Candle fields:** `end_period_ts` (int, inclusive end), `yes_bid` (OHLC of YES bids), `yes_ask` (OHLC of YES asks), `price` (trade-price distribution), `volume_fp` (contracts traded in period), `open_interest_fp` (contracts at period end).

**`price` object** (trade prices, all nullable): `open_dollars`, `low_dollars`, `high_dollars`, `close_dollars`, `mean_dollars`, `previous_dollars`, `min_dollars`, `max_dollars`.

**Gotchas:**
- **`period_interval` only accepts `1`, `60`, `1440`** (1 min / 1 hr / 1 day). **There is no 5-minute or 15-minute candle.** Live test: `period_interval=5` returned `"candlesticks": []` (no error, just empty). For 15-min markets you must aggregate 1-min candles yourself.
- When a period has **no trades**, `price` is an **empty object `{}`** (not null fields) — guard against missing keys.
- `yes_bid`/`yes_ask` are always present (they reflect resting offers, which can exist without trades).
- Max 100 tickers and 10,000 candles total per request.

### 3.5 `GET /series/{series_ticker}/markets/{ticker}/candlesticks` — single-market OHLC

Same candle shape, but **requires `series_ticker` in the path** (you must know the series). Params: `start_ts`, `end_ts`, `period_interval` (1/60/1440), `include_latest_before_start`.

**Response:** `{ "ticker": "…", "candlesticks": [Candle…] }` (no `markets` wrapper). Verified live.

### 3.6 `GET /series/{series_ticker}/events/{ticker}/candlesticks` — event-aggregate OHLC

Aggregates candles across all markets in an event. **Response:** `{ "market_tickers": [str…], "market_candlesticks": [[Candle…]…], "adjusted_end_ts": int }`. Same `period_interval` restriction (1/60/1440).

### 3.7 `GET /markets/{ticker}/orderbook` — orderbook (public)

**Params:** `ticker` (path), `depth` (0 or negative = all levels; 1–100 for top-N).

**Auth:** none in practice (verified 200 unauthenticated; spec marks it as auth-required — discrepancy).

**Response:** `{ "orderbook_fp": { "yes_dollars": [[price, count]…], "no_dollars": [[price, count]…] } }`. Verified live:

```json
{
  "orderbook_fp": {
    "yes_dollars": [],
    "no_dollars": [
      ["0.0100", "1.00"],
      ["0.9900", "29000.00"]
    ]
  }
}
```

**Gotchas:**
- Only **bids** are returned (YES bids and NO bids). A NO bid at price `p` ≡ an ask (sell YES) at `1-p`. The existing adapter already converts this correctly.
- Each level is `[price_string, count_string]` — **both strings**; `count` is fixed-point contracts.
- **Not guaranteed sorted** best-to-worst (live sample returned `0.01` before `0.99` on the NO side). Sort yourself.
- `yes_dollars`/`no_dollars` may be **empty arrays** when no resting offers.

### 3.8 `GET /markets/orderbooks` — batch orderbook

**Params:** `tickers` (repeated query param or comma list, **1–100**). **Response:** `{ "orderbooks": [ { "ticker": "…", "orderbook_fp": {…} } ] }`. Same level shape. (Spec marks auth-required; likely public like the single endpoint — not live-verified.)

### 3.9 `GET /events` — events list (public)

**Params:** `limit` (1–200, default 200), `cursor`, `with_nested_markets` (bool), `with_milestones` (bool), `status` (`unopened`/`open`/`closed`/`settled`), `series_ticker`, `tickers` (comma-separated event tickers), `min_close_ts`, `min_updated_ts`.

**Response:** `{ "events": [EventData…], "milestones": […], "cursor": "…" }`. Verified live sample (trimmed):

```json
{
  "cursor": "CgYI8Mzn4AsSDEtYTkVXUE9QRS03MA",
  "events": [
    {
      "event_ticker": "KXELONMARS-99",
      "series_ticker": "KXELONMARS",
      "title": "Will Elon Musk visit Mars in his lifetime?",
      "sub_title": "Before 2099",
      "category": "World",
      "collateral_return_type": "",
      "mutually_exclusive": false,
      "strike_date": "",
      "strike_period": "",
      "settlement_sources": [ { "name": "The Guardian", "url": "https://www.theguardian.com" }, … ],
      "last_updated_ts": "2026-05-10T00:33:53.337123Z",
      "exchange_index": 0
    }
  ]
}
```

**EventData fields:** `event_ticker`, `series_ticker`, `title`, `sub_title`, `collateral_return_type` (e.g. `"MECNET"`, `"DIRECNET"`, or `""`), `mutually_exclusive`, `settlement_sources[]`, `strike_date`, `strike_period`, `last_updated_ts`, `exchange_index`, `category` (**deprecated** — use series-level category), `available_on_brokers` (**deprecated**, always false), `markets` (only with `with_nested_markets=true`).

**Gotchas:**
- `GET /events` **excludes multivariate (combo) events** — use `GET /events/multivariate`.
- The `status` filter matches on **child market** statuses, not an event-level status: an event appears if **any** of its markets matches. Use `with_nested_markets=true` to see individual market statuses.
- `min_updated_ts` is the efficient polling mechanism for change detection.

### 3.10 `GET /events/{event_ticker}` — single event

**Params:** `with_nested_markets` (bool). **Response:** `{ "event": EventData, "markets": [Market…] }` (the top-level `markets` is deprecated in favor of `event.markets` when `with_nested_markets=true`). Verified live — this is how you recover `series_ticker` from a market's `event_ticker`.

### 3.11 `GET /series` and `GET /series/{series_ticker}` — series

`GET /series` params: `category`, `tags`, `include_product_metadata`, `include_volume`, `min_updated_ts`. Response `{ "series": [Series…] }`.
`GET /series/{series_ticker}` params: `include_volume`. Response `{ "series": Series }`.

**Series fields:** `ticker`, `frequency` (human-readable, e.g. "hourly"/"daily"), `title`, `category`, `tags[]`, `settlement_sources[]`, `contract_url`, `contract_terms_url`, `fee_type` (`quadratic`/`quadratic_with_maker_fees`/`quadratic_with_combo_maker_fees`/`flat`), `fee_multiplier`, `volume_fp` (with `include_volume`), `last_updated_ts`, `exchange_index`.

> **Series ↔ event ↔ market relationship:** a **series** is a recurring template (e.g. `KXXRPD` = hourly XRP price). Each **event** is one instance (`KXXRPD-26AUG2721` = XRP at 9pm EDT Aug 27). Each **market** is one strike/outcome within the event (`KXXRPD-26AUG2721-T2.1399`). The market ticker embeds the event ticker as a prefix.

### 3.12 `GET /historical/cutoff` — live/historical boundary (public)

**Response (verified live):**
```json
{
  "market_positions_last_updated_ts": "2026-06-28T00:00:00Z",
  "market_settled_ts": "2026-06-28T00:00:00Z",
  "orders_updated_ts": "2026-06-28T00:00:00Z",
  "trades_created_ts": "2026-06-28T00:00:00Z"
}
```

Live window is ~3 months. Data older than the relevant cutoff must come from `GET /historical/*`:
- `GET /historical/markets`, `/historical/markets/{ticker}`, `/historical/markets/{ticker}/candlesticks`
- `GET /historical/trades`, `/historical/fills`, `/historical/orders`, `/historical/positions`

For short-term trading you'll almost always be inside the live window, but backtesting needs the historical endpoints.

---

## 4. Real-time / streaming (WebSocket)

**URLs:** `wss://external-api-ws.kalshi.com/trade-api/ws/v2` (recommended) · `wss://api.elections.kalshi.com/trade-api/ws/v2`.

**Auth: REQUIRED for the connection itself** — even for public channels. Verified: an unauthenticated connection is closed by the server (close code 1006). API key headers are sent during the WebSocket handshake.

**Channels relevant to short-term trading:**

| Channel | Auth | Payload highlights |
|---|---|---|
| `ticker` | connection only | `market_ticker`, `price_dollars`, `yes_bid_dollars`, `yes_ask_dollars`, `yes_bid_size_fp`, `yes_ask_size_fp`, `last_trade_size_fp`, `volume_fp`, `open_interest_fp`, `dollar_volume` (int), `dollar_open_interest` (int), `ts_ms` |
| `trade` | connection only | `trade_id`, `market_ticker`, `yes_price_dollars`, `no_price_dollars`, `count_fp`, `taker_outcome_side`, `taker_book_side`, `is_block_trade`, `ts_ms` |
| `orderbook_delta` | connection only | `orderbook_snapshot` (full `yes_dollars_fp`/`no_dollars_fp`) then incremental `orderbook_delta` (`price_dollars`, `delta_fp`, `side`) |
| `market_lifecycle_v2` | connection only | `created`, `activated`, `deactivated`, `close_date_updated`, `determined`, `settled`, `metadata_updated` |
| `user_fills`, `market_positions`, `user_orders` | **auth + private** | your fills/positions/orders |

**Notes:**
- `ticker` and `trade` channels: market specification is **optional** (omit to receive all markets).
- `orderbook_delta` channel: market specification is **required** (`market_ticker`/`market_tickers`); sends `orderbook_snapshot` first, then deltas with a `seq` number for consistency.
- `dollar_volume` and `dollar_open_interest` (integers) are the **dollar-denominated** volume/OI — the only place you get OI in dollars (REST only gives `open_interest_fp` in contracts).
- **No long-polling mechanism** is documented; the WebSocket is the real-time path. REST `min_updated_ts` filters are the polling fallback.

---

## 5. Settlement

- **Lifecycle:** `active` → `closed` (past `close_time`) → `determined` (result set, `result` = `yes`/`no`/`scalar`) → `finalized` (paid out). `disputed`/`amended` are intermediate dispute states.
- **Settlement timer:** `settlement_timer_seconds` = seconds after determination before settlement completes (e.g. 1800 = 30 min). During this window the market is `determined` and can be disputed.
- **Settlement timestamp:** `settlement_ts` (RFC3339) is populated **only for `finalized` markets**. `settlement_value_dollars` holds the YES settlement value after determination.
- **There is no public `GET /markets/settlements` endpoint.** The only "settlements" endpoint is `GET /portfolio/settlements` (auth-required, your own settlement history). Market-level settlement is read from the market object's `result` / `settlement_ts` / `settlement_value_dollars` fields, or via the `market_lifecycle_v2` WS `settled` event.
- **Timing:** markets "typically settle shortly after expiration, but timing can vary based on market type, data source availability, and manual review." For the 15-min crypto/commodity markets, `settlement_timer_seconds` is typically 1800 (30 min) after the strike time.
- **After `close_time`:** all order operations (including cancels) are rejected with `MARKET_INACTIVE`; resting orders are cancelled shortly after close.

---

## 6. Rate limits

Token-bucket model (not fixed windows). Default cost **10 tokens/request**; `GET /account/endpoint_costs` lists non-default costs. Separate **Read** and **Write** buckets.

| Tier | Read (tok/s) | Write (tok/s) |
|---|---|---|
| Basic | 200 | 100 |
| Advanced | 300 | 300 |
| Expert | 600 | 600 |
| Premier | 1,000 | 1,000 |
| Paragon | 2,000 | 2,000 |
| Prime | 4,000 | 4,000 |
| Prestige | 10,000 | 8,000 |

- Bucket capacity = 2× budget (above Basic); allows 2× burst after idle.
- On limit: `429` with body `{"error": "too many requests"}`. **No `Retry-After` or `X-RateLimit-*` headers.** Apply exponential backoff.
- Batch endpoints cost the same as individual calls (no token savings).
- The existing adapter's `rateLimit: 200` client-side throttle is a reasonable conservative default for the Basic tier.

---

## 7. Cross-venue comparison (Kalshi vs Polymarket Gamma)

Kalshi's short-term markets are dominated by **crypto and commodity 15-minute / hourly strikes** (verified live: "BTC price up in next 15 mins?", "ETH price up in next 15 mins?", "Gold price up in next 15 mins?", "WTI Oil price up in next 15 mins?", plus XRP/SOL/DOGE/BNB/NEAR/HYPE/Silver/Copper/Natural Gas). These settle on **CF Benchmarks Real-Time Indices** (e.g. `XRPUSD_RTI`), named in `settlement_sources` and `rules_primary`.

For cross-venue comparison against Polymarket Gamma:
- **Match key:** the underlying index (CF Benchmarks ticker) + strike time + direction. Kalshi exposes the exact index and 60-second averaging window in `rules_primary`/`rules_secondary` and `settlement_sources[].url`.
- **Price:** Kalshi `last_price_dollars` (YES) is directly comparable to a Polymarket YES price for the same event.
- **No direct "Gamma-equivalent" endpoint on Kalshi** — you must map by underlying asset + expiry yourself. Kalshi's `product_metadata` (e.g. `{"cadence":"hourly","competition":"XRP"}`) and `strike_date`/`strike_period` help automate the mapping.
- **Caveat:** Kalshi crypto markets are CFTC-regulated event contracts with `notional_value_dollars` = $1 and cent tick sizes (`linear_cent`); Polymarket uses a different (0.001) tick and different settlement sources. Prices are comparable as probabilities, but settlement timing and dispute windows differ.

---

## 8. Summary table — short-term signal data availability

| Data | REST (public) | WebSocket (auth) | Notes |
|---|---|---|---|
| Last price | ✅ `last_price_dollars` | ✅ `ticker.price_dollars` | string dollars |
| Bid/ask (top of book) | ✅ `yes_bid/ask_dollars` + sizes | ✅ `ticker` | |
| Full orderbook | ✅ `/markets/{ticker}/orderbook` | ✅ `orderbook_delta` | bids only; convert NO bid → YES ask |
| Trade tape | ✅ `/markets/trades` | ✅ `trade` | `taker_outcome_side` for direction |
| 1-min OHLC | ✅ `/markets/candlesticks` | ❌ | **coarsest granularity** |
| 5-min / 15-min OHLC | ❌ | ❌ | **not available — aggregate 1-min** |
| Sub-1-min OHLC | ❌ | ❌ | not available |
| Volume (contracts) | ✅ `volume_fp`, `volume_24h_fp` | ✅ `volume_fp` | |
| Volume (dollars) | ❌ | ✅ `dollar_volume` | WS only |
| Open interest (contracts) | ✅ `open_interest_fp` | ✅ `open_interest_fp` | |
| Open interest (dollars) | ❌ | ✅ `dollar_open_interest` | WS only |
| Liquidity (dollars) | ❌ `liquidity_dollars`=0 | ❌ | **deprecated — compute from book** |
| 24h price change | ✅ `previous_price_dollars` | ❌ | day-ago last price |
| Close/expiry time | ✅ `close_time`, `expected/latest_expiration_time` | ✅ lifecycle | |
| Settlement status | ✅ `status`, `result`, `settlement_ts` | ✅ `market_lifecycle_v2` | |
| Settlement timer | ✅ `settlement_timer_seconds` | ❌ | |
| Tick size | ✅ `price_level_structure`, `price_ranges` | ❌ | |

**Momentum** → 1-min candles + trade tape + `previous_price_dollars` (24h). **Volume** → `volume_fp`/`volume_24h_fp` (contracts) or WS `dollar_volume`. **Book imbalance** → orderbook `yes_dollars` vs `no_dollars` (REST or WS).

**Not available anywhere:** sub-1-minute candles, 5/15-minute candles, dollar-denominated OI via REST, `liquidity_dollars`, and unauthenticated streaming.

---

## 9. Gotchas checklist (for the adapter)

1. **`liquidity_dollars` is dead** — always `"0.0000"`. The existing adapter correctly computes liquidity from `yes_bid_size_fp`/`no_bid_size_fp` × prices.
2. **`open_interest` is `open_interest_fp` (contracts), not dollars.** No `open_interest_dollars` field exists.
3. **`volume_fp`/`volume_24h_fp` are contract counts**, not dollars.
4. **Candlesticks: 1/60/1440 min only.** `period_interval=5` silently returns `[]`. Aggregate 1-min candles for 15-min markets.
5. **Candle `price` is `{}` (empty object) when no trades** — not null fields.
6. **Single-market candles need `series_ticker` in the path**; the batch `/markets/candlesticks` endpoint does not.
7. **Market `status` field uses `active`**, but the query `status` filter uses `open`. The existing adapter's `m.status === 'active' || m.status === 'open'` handles both.
8. **`status=open&max_close_ts` works** despite the docs' compatibility table saying otherwise.
9. **Orderbook is public** despite the spec marking it auth-required.
10. **WebSocket requires auth** even for public channels (unauthenticated → close 1006).
11. **All prices and counts are strings** (fixed-point). `parseFloat` everything; counts have 2 decimals.
12. **Orderbook levels are `[price, count]` strings, not guaranteed sorted.**
13. **`taker_side` deprecated** → use `taker_outcome_side`/`taker_book_side` (removal ≥ May 14, 2026).
14. **`title`/`subtitle` deprecated** on market → use `yes_sub_title`/`no_sub_title` + event `title`.
15. **`category` deprecated** on event → use series-level `category`.
16. **Historical cutoff ~3 months** — backtests need `/historical/*` endpoints.
17. **429 has no `Retry-After`** — implement exponential backoff.
18. **`exchange_index`** (sharding) is present on markets/events/series; auto-routed writes bill every shard's Write bucket.

---

## 10. Source references

- Docs index: https://docs.kalshi.com/llms.txt
- Get Trades: https://docs.kalshi.com/api-reference/market/get-trades.md
- Get Market Candlesticks: https://docs.kalshi.com/api-reference/market/get-market-candlesticks.md
- Batch Get Market Candlesticks: https://docs.kalshi.com/api-reference/market/batch-get-market-candlesticks.md
- Get Event Candlesticks: https://docs.kalshi.com/api-reference/events/get-event-candlesticks.md
- Get Market: https://docs.kalshi.com/api-reference/market/get-market.md
- Get Markets: https://docs.kalshi.com/api-reference/market/get-markets.md
- Get Market Orderbook: https://docs.kalshi.com/api-reference/market/get-market-orderbook.md
- Get Multiple Market Orderbooks: https://docs.kalshi.com/api-reference/market/get-multiple-market-orderbooks.md
- Get Events: https://docs.kalshi.com/api-reference/events/get-events.md
- Get Event: https://docs.kalshi.com/api-reference/events/get-event.md
- Get Series / Series List: https://docs.kalshi.com/api-reference/market/get-series.md · get-series-list.md
- Rate Limits: https://docs.kalshi.com/getting_started/rate_limits.md
- Market Lifecycle: https://docs.kalshi.com/getting_started/market_lifecycle.md
- Market Settlement: https://docs.kalshi.com/getting_started/market_settlement.md
- Historical Data: https://docs.kalshi.com/getting_started/historical_data.md
- API Environments: https://docs.kalshi.com/getting_started/api_environments.md
- WebSocket API: https://docs.kalshi.com/websockets.md · websocket-connection.md · market-ticker.md · public-trades.md · orderbook-updates.md
