# Broker API gap audit — 2026-08-28

A manual audit (the three parallel research agents failed, so this was done directly
against the live APIs + OpenAPI specs). Covers what each broker exposes that the app
does NOT yet use, ranked by value to the auto-trader. Implemented items are marked ✅.

## Polymarket US (docs.polymarket.us)

### ✅ IMPLEMENTED this session
1. **Order book was broken** — `/v1/markets/{slug}/book` returns
   `{marketData: {bids: [{px:{value}, qty}], offers: [{px:{value}, qty}]}}`. The adapter
   parsed the wrong shape (`book.bids`/`price.value`) so it always returned empty. Fixed.
2. **Taker fee model** — `feeCoefficient = 0.06` on every market. Formula:
   `Fee = Θ × C × p × (1-p)` (Θ taker = 0.06, maker rebate = −0.0125; rebate tiers by
   trailing-month volume). Now mapped to `VenueMarket.feeRate` and modeled in paper fills
   (buy + sell + settle), netted into realized P&L, and shown in the scanner as "fee 6%".

### NOT yet implemented (ranked)
1. **Tick size + min qty** — `orderPriceMinTickSize` (0.001) and `minimumTradeQty` (1).
   Use to round limit prices and enforce minimum order sizes. (Low effort, do next.)
2. **Fills / order history — ✅ IMPLEMENTED** — `GET /v1/portfolio/activities?types=ACTIVITY_TYPE_TRADE` returns cleared trades with venue-reported `realizedPnl` (net of fees). Wired into `getFills`; the Account tile's "Live" line now sums it (the retail feed doesn't break out fees separately, so fees show 0 and realizedPnl is authoritative).
3. **WebSocket** — an AsyncAPI spec exists (`connect-wss.json`); channels likely
   ticker/book/trades/fills. Polling is the current design; WS is the latency upgrade.
4. **Settlement endpoint** — GET `/v1/markets/{slug}/settlement` (public) — use for
   exact resolution instead of the market's `settlement` field.
5. **marketSides / marketType** — `marketSides` is an array (multi-outcome possible),
   `marketType` ∈ {election, futures, game, …}. We assume binary everywhere; some
   non-binary markets may be silently mishandled.
6. **Combos / portfolio margin** — "Mutually Exclusive Collateral Return" + a
   combos-schema suggest multi-leg combos and margin optimization. Potential for a
   within-venue no-arbitrage check (like the Kalshi Dutch book), unverified.
7. **Batch market fetch by slugs/ids** — the `slug`/`id` query params may accept lists;
   would replace N getMarket calls with one.

## Kalshi (docs.kalshi.com, openapi.yaml)

Already covered deeply in `docs/kalshi-shortterm-data.md`. Remaining gaps:

1. **Fee schedule — ✅ IMPLEMENTED** — Kalshi quadratic taker fee `roundup(0.07 × multiplier × C × P × (1−P))`, standard multiplier 1 (verified on all crypto/weather fade-target series; S&P/Nasdaq = 0.5). Now mapped to `feeRate=0.07` on every Kalshi market and modeled in paper fills (netted into realized P&L). Premium-series multiplier variation is not yet per-series.
2. **Fills & settlements history — ✅ IMPLEMENTED** — `GET /portfolio/fills` and `GET /portfolio/settlements` (with `fee_cost` + realized P&L per item) are now wired into the adapter; the Account tile shows a "Live (venue fills/settlements)" line with net P&L, fees, and settled count when in live mode. This is now the authoritative source of live Kalshi P&L instead of our estimate.
3. **WebSocket** — auth-required; channels ticker/trade/orderbook_delta/
   market_lifecycle_v2. Polling is fine for now; WS is the real-time upgrade.
4. **Open orders** — GET `/portfolio/orders` for resting-order management/cancellation.
5. **Milestones** (`/milestones`) and **game-stats** — live-event→ticker mapping and
   sports play-by-play; could power an event/schedule-driven signal. Unverified shapes.
6. **Tick size** — `price_ranges` / `price_level_structure` per market; use to round
   order prices correctly.

## Manifold (api.manifold.markets/v0)

1. **Non-binary markets — ✅ MULTIPLE_CHOICE done** — `answers` (id/text/probability) are now mapped into `VenueMarket.outcomes`, MC markets are enriched from their full records (search-markets omits them), and the scanner shows an "Outcomes (N)" button that opens a modal with per-answer buy buttons. `placeOrder`/`sellPosition`/`getPrice` accept an `answerId`. NUMERIC / FREE_RESPONSE / POLL remain unsupported (rare, low value).
2. **Limit orders** — Manifold has an order-book beta with limit orders; verify the
   public endpoint to place/cancel them.
3. **Mana economics** — mana is purchasable (~1¢/M$) and sellable at a discount; the
   app labels it "real value" which is directionally right but the cashout rate matters
   for real-money framing.
4. **Portfolio history** — `/v0/portfolio/history` for realized P&L/trades.
5. **Richer copy-trading** — `/v0/bets` filters (userId, contractId, kinds), user bets,
   groups, comments (sentiment). The CopyTrader uses a subset.

## Bottom line

The two things that most improve honesty of results are now done: the Polymarket US
order book (was silently empty) and its fee model (was silently zero). Next highest-value:
**(a)** Kalshi fee verification + `/portfolio/fills` for true live P&L, **(b)** tick-size
rounding, **(c)** Manifold multiple-choice support. WebSocket is a latency upgrade, not
a correctness one, and can wait.
