# Oracle Trader - Full Code, API and Strategy Audit

Written 2026-09-18. Read-only review: **no source file was modified.**

Scope: `G:\PROJECTS\oracle-trader` (~30k lines of TypeScript in `src/`, ~180 scripts in `scripts/`,
~60 docs), plus the live runtime state in `%APPDATA%\oracle-trader\` and live probes against the
Kalshi API.

Intended audience: a developer or a frontier model picking this project up cold. Every claim below is
cited to `file:line`, to a reproduced command output, or to a vendor spec. Anything I could not verify
is labelled **[unverified]**.

---

## 0. Executive summary

This is an unusually well-engineered prediction-market system. It compiles clean (`tsc --noEmit`
rc=0), every unit suite I sampled passes, and it is built around a correct instinct: **the fee model,
not the signal, is the product.** The promotion ladder, the clustered-t gate, the pre-registration
discipline and the "a signal is not a trade until the book can pay you" rule are better statistical
hygiene than most funds run.

It is also, on its own evidence, not yet profitable. Lifetime live results as of this audit: Kalshi
live engines net roughly **-$17**, Polymarket US live engines **-$16.25**, today's realised
**-$1.25**. That is not a bug. It is the honest answer to a hard question.

**But this audit's central finding is that the question has been asked against a wrong cost model.**
Nine concrete defects are documented in section 5 that are not in the project's own known-defect
list. Three of them all point the same way - the app systematically believes trading costs more than
it does:

**F1. The fee model's rounding rule is not Kalshi's rule.** `autoTrader.ts:4896` rounds each order's
fee **up to the nearest cent** (`ceil(x*100)/100`), justified by a comment asserting Kalshi rounds to
the cent. The vendor spec (`docs.kalshi.com/getting_started/fee_rounding`, fetched today) says
`trade_fee = ceil_6dp(model_fee)` - round up to **$0.000001** - and that a **rebate accumulator**
converges the total back to the true model fee. Measured effect at 1 contract and p=0.02: the code
charges **1.00c/contract against a true 0.137c - a 7.3x overstatement**. Because the error scales as
1/C it is invisible on large clips and dominant on the 1-16 contract sizes the x1/x2 ladder notches
and the `netN=1` ledger entries actually use. The fade engine's entire measured edge is **0.07
c/contract**; the model error in that regime is 0.05-0.86 c/contract. It sits in both the decision
path and the accounting path. See D1.

**F2. Kalshi has 14 zero-fee series and 19 half-fee series, and a bug makes the zero-fee ones
invisible.** `kalshi.ts:1389` coerces `fee_multiplier: 0` to `1`, so a fee-free market is priced as a
full-fee market. Verified live: `KXBTCY` (annual BTC strike ladder) carries `fee_multiplier = 0` and
turned over **125,278 contracts in 24h across 28 open markets**; `KXMLBGAME` carries `0.5` and turned
over **6,635,436 contracts across 98 open markets**. "Taker is dead because of the 0.07 quadratic
fee" does not hold on those series, and no scan window in the app ever looks at them. See D2, S2.

**F3. Kalshi pays makers up to $200 per period per market plus a 50% fee discount, and the app fetches
the data, logs one sample line, and throws it away.** `kalshi.ts:963`; the doc comment says so out
loud: *"Read only ... nothing trades on them."* In a project whose entire problem is fee drag, this is
the highest-value item here. See 3.1, D3, S1.

**F4. Kalshi moved to a sub-cent tick grid and the app cannot quote it.** Live `price_ranges` for a
`center_deci_edge_centi_cent` market: 0.01-0.99 in **0.0010 steps**, tails 0.00-0.01 / 0.99-1.00 in
**0.0001 steps**. Every order is `leg.toFixed(2)` (`kalshi.ts:1010, 1103, 1145`). Whole cents are
*legal*, so this is not a crash - it is a maker ladder quoting in a coarse grid on a fine book, in
exactly the 1-5c tail where the fade engine lives and where the tick is 100x finer than the app's.
See D4, S3.

And one quantitative reframe that reinterprets the whole strategy table. Kalshi's taker fee as a
fraction of a winning contract's payoff is exactly **0.07 x mult x P** - so **the fee is a tax on
buying expensive contracts, not on trading**. At 0.02 it is 0.14% of the win; at 0.50 it is 3.5%.
That is why `fade` (buys NO at 0.02-0.11) is the only consistently positive Kalshi engine and why
every mid-price taker engine is negative. It is also why pure maker flow on `quadratic` series - 13,991
of 14,154 - pays **no fee at all**: the fee problem there is already solved, and what remains is
adverse selection, which the app already measures. Section 8.0.

**Verdict:** keep the project, redirect it. The research machinery is excellent and pointed at the
wrong objective. Stop trying to earn a spread net of a fee the app is overestimating, in a universe
selected without looking at fee tier, on a tick grid 10x coarser than the venue's, while ignoring a
venue program that pays you to quote.

---

## 1. System architecture

### 1.1 Shape

Electron app. `src/main/` is the whole brain (Node); `src/preload/` exposes **51 IPC channels**;
`src/renderer/` is a React dashboard that only renders. Window config at `index.ts:114-118`:
`nodeIntegration: false`, `contextIsolation: true`, **`sandbox: false`**.

```
src/shared/          types.ts, venue.ts (VenueAdapter contract), polyPaper.ts, ibkr.ts
src/main/
  index.ts           Electron entry, IPC registration
  engine/            engine.ts (1399) - orchestration, portfolio, IPC backend
  venues/            kalshi.ts (1635) kalshiWs.ts (484) polymarketUs.ts (912) polymarket.ts (281)
                     manifold.ts (442) ibkr*.ts registry.ts usLedger.ts cullRecorder.ts
                     cfReferenceShadow.ts forecastexData.ts
  strategies/        autoTrader.ts (4859) + ~25 engines (section 4)
  intelligence/      LLM adjudication: engine.ts, gemini.ts, openRouterClient.ts,
                     externalEvidence.ts, adjudicator.ts, candidatePacket.ts, modelUsage.ts
  ladder/            ladder.ts (1278) - promotion/demotion state machine + statistics core
  store/             config.ts (safeStorage secrets), fillReconciler.ts, orderJournal.ts,
                     executionArchive.ts, tradeLog.ts
  services/          liveSpot.ts (Coinbase + Kraken WS), noaaMetar.ts
scripts/             ~180 .mjs: backtests/, shadow capture, tape recorders, sentinel,
                     plus one-off patch-*/fix-* source rewriters (6.2)
```

Largest files, which is where the logic actually lives: `autoTrader.ts` 4859, `kalshi.ts` 1533
(1635 on disk today), `polymarketUs.ts` 1380/912, `ladder.ts` 1278, `quoter.ts` 1245, `miniAuto.ts`
1300, `engine.ts` 1399.

### 1.2 The `VenueAdapter` contract (`src/shared/venue.ts`, 121 lines)

Capability-flagged. `capabilities()` declares what a venue supports; optional methods **must throw**
"Not supported" rather than return empty, and callers are expected to check the flag first. In
practice `polymarketUs.ts` throws on `getUserBets`/`getUserPortfolio` and the engine guards with
`adapter.X ? ... : ...`. The design is sound - a venue that cannot do something fails loudly rather
than looking like it did nothing.

### 1.3 HTTP layer (`src/main/util/http.ts`, 135 lines)

One `HttpClient` used by every adapter:

- sliding-window `RateLimiter` per instance (`rateLimit` + `rateLimitWindowMs`, default window 1000ms)
  with a **priority queue** (0 = scanner reads, 1 = account reads, 2 = writes), so a trading write
  never queues behind 1000 scanner reads;
- retry with backoff `300 * 3^n + jitter` on 429/5xx/network; **POSTs are never retried** - a retry
  can double-fill;
- `AbortSignal.timeout`; on a POST timeout it throws rather than resubmitting, and reconciliation
  finds the order by `client_order_id`. Correct, and the reasoning is in the comments.

Gaps: `Retry-After` ignored, no response-body validation, no priority aging (D9).

### 1.4 The decision core: the ladder (`src/main/ladder/ladder.ts`, 1278 lines)

Stages `disabled -> paper -> shadow -> tiny-live -> live x1 -> x2 -> x4 -> x8 -> x16`, ceiling
`MAX_NOTCH = 5`. The statistics core is the best-written part of the codebase:

- `clusterT(df)` (ladder.ts:298) - a real one-sided t table, no normal approximation at n=3;
- `clusteredMean` / `clusteredSe` (ladder.ts:310, 317) - day-clustered SE, so 200 correlated fills do
  not become 200 independent observations;
- `leadLagRowCounts` (ladder.ts:115) - counts **coin-days**, not fills, because one BTC move hits
  every 15m market;
- `decideStage` (ladder.ts:342) - promote only when the **80% one-sided lower bound of net is above
  zero**;
- cool-down after the k-th stop: 3 days, then 14 days doubling, capped at 90 (ladder.ts:264);
- `operatorHold` - a human "no" that survives restart and is never overwritten.

Live ladder state (`%APPDATA%\oracle-trader\ladder.json`, 20 strategies): `quoter`,
`polyus-micro-maker`, `polyus-fade`, `polyus-book-imbalance`, `polyus-weather-fair`,
`kalshi-momentum`, `kalshi-book-imbalance`, `kalshi-flow-follow`, `kalshi-weather-morning`,
`kalshi-dutch` are **disabled**; most others sit at `tiny-live` on x1; `settlement` is at `paper`.
Several carry `operatorHold: true`.

The `kalshi-fade` history entry is worth reading as evidence of the system's honesty
(`ladder.json`, `strategies.kalshi-fade.history`):

> `live -> tiny-live` "reverted (round 63): the checkpoint that promoted this measured 19 wins and 0
> settlement losses. Fade buys NO at 0.89-0.98, so the band described how much the winners won (sd
> 2.65c on a mean of 5.23c) and 20 straight wins is a 36% event at zero edge. Back to x1 until the
> sample has a downside in it."

A self-issued rejection of a false promotion. That behaviour is the reason this codebase's negative
results are trustworthy; preserve it through any rework.

---

## 2. API inventory - what is actually called

### 2.1 Kalshi (Trade API v2) - the deepest integration in the codebase

Base `https://api.elections.kalshi.com/trade-api/v2` (`kalshi.ts:31`); demo base `kalshi.ts:62`.
Auth is RSA-PSS over `timestamp + method + path` with the query string stripped; key from
`safeStorage`. Public paths are deliberately unsigned so a read-only rig works.

Endpoints in use (full grep of path literals across `src/`):

```
/account/limits   /account/endpoint_costs   /account/api_usage_level/upgrade   /account/api_keys
/api_keys/delete  /api_key/delete
/markets          /market/{ticker}          /markets/orderbooks (batch)
/markets/candlesticks   /markets/trades     /markets/structured_targets (payload field)
/events           /events?with_nested_markets    /portfolio/events/orders
/series           /series/{s}              /search/tags_by_categories
/portfolio/balance /portfolio/positions    /portfolio/fills
/portfolio/settlements /portfolio/orders   /portfolio/order_groups
/order            /order/amend             /cancel
/historical/orders /portfolio/intra_exchange_instance_transfer
/incentive_programs  /exchange/status      /exchange/schedule
/ws/market_feed   (orderbook_delta, ticker, public_trades)
```

This is close to a complete integration. Cursor pagination is centralised (`authPaged`, page size
capped at 200, cursor-repeat guard, `maxPages = ceil(limit/200)+2`). Shard routing is handled
(`exchange_index`, batch orderbooks, intra-shard transfer). Fees are per-series with a 6h cache and
a conservative 0.07 default on lookup failure. `fetchMarkets` pages `ending-soon` near-dated first
and caps 3 markets per series so a 500-rung crypto ladder cannot eat the scan budget.

### 2.2 Polymarket US

`polymarketUs.ts` (912 lines). Market data `https://gateway.polymarket.us/v1/markets` (public,
L28); trading through a separate gateway (L29); Ed25519 order signing via `node:crypto`
`createPrivateKey`/`sign` (L1). Order lifecycle with cancel-replace, `POSITION_RESOLUTION`
activities read as settlements (L521+), taker commission on the **exit** leg now subtracted
(L700+ - that was a real bug and is fixed). `getUserBets`/`getUserPortfolio` throw: the venue does
not offer them.

### 2.3 Polymarket global (paper only)

`polymarket.ts` (281 lines) uses **five** endpoints: `gamma-api.polymarket.com/markets`,
`gamma-api.polymarket.com/public-search`, `clob.polymarket.com/book`, `clob.polymarket.com/midpoint`,
plus `clobTokenIds` parsed out of the market payload. Declared capabilities:
`paperOnly: true`, `copyTrading: false`, `socialExposure: false` with the comment
"on-chain positions need wallet tracking (future work)".

### 2.4 Manifold (play money, real people)

`manifold.ts` (442 lines), base `https://api.manifold.markets`, `rateLimit: 450`
(`manifold.ts:121`) against the shared 1000ms window, i.e. 450 req/s. Endpoints:
`/v0/search-markets`, `/v0/markets/by-slug`, `/v0/market/{id}`, `/v0/market/{id}/shares`,
`/v0/bet`, `/v0/bet/cancel`, `/v0/sell-shares`, `/v0/get-user-portfolio/{id}`,
`/v0/get-user-contract-metrics-with-contracts`, `/v0/bets?userId=`, `/v0/user-by-id`, `/v0/me`.

The copy-trading chain `getTopHolders` -> `getPositions` -> `getUsername` -> `getRecentBets` is a
complete pipeline from "who holds this market" to "what did they just do", and `getRecentBets` is
deliberately **not** cached because a 60s cache would swallow the very flow the strategy follows.

### 2.5 Non-venue data providers

| Provider | Base | Used for | Auth |
|---|---|---|---|
| Interactive Brokers | `@stoqey/ib` TWS/Gateway socket | futures/FX/equity reference prices, IBKR paper lab | client id + port; paper vs live by host |
| SportsGameOdds | `https://api.sportsgameodds.com/v2` (`sportsGameOdds.ts:20`) | sportsbook consensus anchor | API key |
| NOAA NWS | `api.weather.gov` | forecast grids for temperature markets | requires a User-Agent |
| FAA | `https://aviationweather.gov/api/{metar,taf}` (`noaaMetar.ts:5,6`) | METAR/TAF station truth | none |
| ForecastEx | `https://api.forecastex.com/v1/stations/{id}/forecasts` (`forecastexData.ts:17`) | model consensus for weather | API key |
| Coinbase | `wss://ws-feed.exchange.coinbase.com` (`liveSpot.ts:11`) | spot tape | none |
| Kraken | `wss://ws.kraken.com/v2` (`liveSpot.ts:12`) | spot tape | none |
| OpenRouter | `https://openrouter.ai/api/v1` (`intelligence/engine.ts:130`, `externalEvidence.ts:84`) | LLM adjudication + evidence | API key |
| Gemini | `generativelanguage.googleapis.com` (`intelligence/gemini.ts:4`) | paid critic | API key |
| Discord webhook | `discord.com/api/webhooks/` (`util/alert.ts:14`) | operator alerts | webhook token |

### 2.6 Secrets handling

`store/config.ts` encrypts every value in `ENCRYPTED_KEYS` with Electron `safeStorage` (DPAPI on
Windows, bound to the user account) as `enc:v1:...`, decrypts on read, migrates plaintext in place.
`kalshiKeyPath`/`kalshiKeyId` are intentionally not encrypted (a file path and a public key id).
Sane for a single-user desktop app.

One caveat to state to whoever picks this up: the project's own docs flag an Anthropic key in
plaintext in `~/.claude/settings.json` and forwarded to OpenRouter. **[unverified by me]** - I did
not read that file. If true, rotate it and stop forwarding it; a third-party router is not a secret
store.

---

## 3. API surface that exists and is NOT used

### 3.1 KALSHI - the incentive programs (highest value; already half-wired)

`GET /incentive_programs` is implemented (`kalshi.ts:963`) and called once per session
(`autoTrader.ts:1136`). The result is **logged and discarded**. The comment is explicit: *"Read only
- the fee discount and reward terms are per-program and would need real parsing before they could
feed an EV; nothing trades on them."*

What is actually there. From the app's own log line today
(`%APPDATA%\oracle-trader\logs\main.log`, tag `[auto-trader] incentive programs: 200 returned`):

```json
{"end_date":"2026-10-06T23:59:00Z","incentive_description":"series_lip",
 "incentive_type":"liquidity","market_ticker":"KXMLBGAME-WAS-CIN-2026-09-29-GAME",
 "period_start_date":"2026-09-29","period_end_date":"2026-10-06",
 "period_reward":2000000,"program_id":"KXMLBGAME-...-LIP","start_date":"2026-09-29T00:00:00Z",
 "target_size_fp":"1000.00","max_spread_dollars":"0.1500","discount_factor_bps":5000,
 "paid_out":false,"max_reward_per_account":100000,"min_avg_volume_fp":"1000.00"}
```

The vendor schema
(`docs.kalshi.com/api-reference/incentive-programs/get-incentives.md`, `IncentiveProgram`) defines
the units: `period_reward` and `max_reward_per_account` are **centi-cents** (1/100 of a cent =
$0.0001); `target_size_fp`/`min_avg_volume_fp` are contracts; `max_spread_dollars` is dollars;
`discount_factor_bps` is basis points of fee discount.

So that single row reads: **$200.00 per period** for quoting **1000 contracts** both sides inside a
**$0.15 spread**, on an **MLB moneyline market that already carries fee_multiplier 0.5**, with a
**50% fee discount**, capped at **$10 per account per period**.

Four consequences the codebase has not taken:

1. **The maker ladder is subsidised and the app does not know it.** Kalshi's maker fee on
   `quadratic_with_maker_fees` series is already only `0.0175 * mult`; a 50% discount halves it
   again. Every maker EV the app computes on these markets is pessimistic.
2. **`discount_factor_bps` is a per-market fee multiplier the app never applies.**
   `kalshi.ts:1408` derives maker fee from `fee_type` string equality alone.
3. **The fetch is unpaginated.** `?limit=200` with no `next_cursor` follow, and the response schema
   *has* a `next_cursor`. "200 returned" is a page cap, not a count - the reward universe is
   unknown and under-counted. It is also wrapped in `catch { return [] }`: a silent zero.
4. **`paid_out` is free ground truth.** Polling it tells you whether *your* quoting actually earned,
   which is the one honest P&L signal a maker program has and the one this app lacks.

This is not a new API to learn. It is one already called, with a schema vendored into
`scripts/kalshi-docs/`, whose output is dropped on the floor. See strategy **S1**.

### 3.2 KALSHI - queue position (the missing half of maker trading)

`GET /orders/queue-position` and `GET /orders/{order_id}/queue-position` are **not implemented**.
A grep for `queue.?position` across `src/` hits only `kalshiWs.ts:14`, a comment. The code already
knows the concept matters: `kalshi.ts:1135` justifies `amendOrder` with *"a price change loses queue
position, and re-filling is the whole point"* - but it never asks where it actually sits.

For a maker strategy, queue position **is** the fill-rate variable. The project's recurring mystery -
"fill rate is 0.43%", "the ladder never fills" - is not answerable without this endpoint. Today the
app can only infer queue position from whether it got filled, which is the same circular reasoning
as inferring an outcome from a settlement.

Cheap to add, immediately useful: after each resting quote, poll queue position; record
`(price_level_size, our_size, our_position, time_to_fill)` into the existing shadow tables. That
turns "we never fill" into a measurable function of level, size and price. See **S4**.

### 3.3 KALSHI - the rest of the unused catalog

Kalshi's own index (`scripts/kalshi-docs/llms.txt`) lists **108 operations**. Diffed against the
paths in section 2.1, these are genuinely absent:

| Group | Unused operations | What it would unlock |
|---|---|---|
| `communications` (18) | block-trade proposals, RFQs, quotes, accept/decline | **Block trades / RFQ** - take size off-resting without crossing the public book. The only venue mechanism that moves more size than the visible book, which is exactly what the `MAX_NOTCH` ceiling says the app cannot do. |
| `market_drafts` | create a market draft | **List your own market.** Not a trading capability, but the only way to sit on the *other side* of the fee schedule. |
| `milestone` (2) | election milestones | A structured, dated truth feed for election markets - relevant to `kalshi-consensus` and to the fade's tail risk. |
| `events` | **`get-event-forecast-percentile-history`**, `get-event-candlesticks`, `get-event-metadata`, `get-event-count`, `get-event-fee-changes` | `forecast-percentile-history` is a first-party probabilistic forecast of the settlement value, published by Kalshi for weather-style markets. The weather engines (`weatherForecast`, `weatherDay`, `quoter`) are the app's biggest unresolved failure and this is not fetched. `get-event-fee-changes` tells you when a fee schedule moves under you. |
| `live-data` (5) | `get-live-data`, **`get-weather-index`**, `get-game-stats` | `get-weather-index` is Kalshi's **own settlement station reading** - the number that actually settles a temperature market. The weather chain reconstructs truth from NOAA/METAR/ForecastEx and loses to the fee. This is the authoritative source. |
| `historical` | `get-historical-fills`, `get-historical-positions`, `get-historical-trades`, **`get-historical-cutoff-timestamps`** | The app reads `/historical/orders` only. The cutoff endpoint matters because `/portfolio/fills` silently stops returning rows before a cutoff - a reconciliation blind spot that currently never announces itself. |
| `portfolio` | **`get-total-resting-order-value`**, deposits, withdrawals, sub-accounts (create/delete/transfer/positions), `get-netting-enabled` | `get-total-resting-order-value` is the exact number the collateral ratchet needs: `autoTrader.ts:1086-1096` hand-rolls a `collateralRef` estimate and comments that it is "the number the collateral ratchet reads". The venue will just tell you. Sub-accounts are the real fix for resting orders eating the sweep cap. |
| `orders` | **`batch-cancel-orders-v2`** (up to 10,000), `batch-create-orders-v2`, `decrease-order-v2` | The kill switch cancels one order at a time inside a 250ms budget (`autoTrader.ts:1197`); the "budget expired mid-cancel" failure mode disappears with batch cancel. `decrease-order` cuts exposure **without losing queue position**, which `amendOrder` cannot. |
| `account` | `get-account-api-limits` | The app derives its rate budget from `/account/limits`; the explicit endpoint is cleaner and states the tiers. |
| `multivariate` (3), `fcm` (2), `notifications`, `search/get-filters-for-sports` | - | Consciously out of scope: `kalshi.ts:428` sends `mve_filter=exclude` and re-filters three more times because the flag demonstrably leaks. A decision, not an oversight. |

### 3.4 Polymarket - the largest untapped surface in the codebase

**Global CLOB** (`clob.polymarket.com`) - only `/book` and `/midpoint` are used. Absent: `/books`
(batch - the app loops `/book` per market today), `/spread`, `/spreads`, `/midpoints`,
**`/prices-history`** (bucketed - there is **no** historical price series for Polymarket global at
all, which is why the `polyus-*` strategies cannot be backtested locally), `/last-price-pinned`,
`/auth/*` + `/api-keys` + `/allowance` + `/balance-allowance`, `/trades`, `/data/orders`,
`/notifications`, and `/sampling-markets` + `/endpoints` (the reward-eligible set).

**Gamma** (`gamma-api.polymarket.com`) - only `/markets` and `/public-search`. Absent: `/events`,
`/tags`, `/series`, `/holders`, `/profiles`, `/comments`, `/activity`, `/thread`. Also unread though
already present in the payload: `negRisk`, `enableOrderBook`, `acceptingOrders`, `spread`,
`oneDayPriceChange`, `openInterest`, `rewardsMinSize`, `rewardsMaxSpread`, `orderPriceMinTickSize`.

**Data-API** (`data-api.polymarket.com`) - **entirely unused**: `/positions`, `/trades`, `/holders`,
`/value`, `/activity`, `/leaderboard`, `/pnl`. This is the direct fix for the declared limitation
`socialExposure: false /* on-chain positions need wallet tracking (future work) */`. It needs no
wallet and no chain indexing - it is plain HTTP with the same shape as Manifold's `getTopHolders`,
which the codebase already implements for another venue.

**Polymarket liquidity rewards** are the same class of finding as Kalshi's LIP, and equally unused.
`rewardsMinSize`/`rewardsMaxSpread` are already in the Gamma payload; `/endpoints` and
`/sampling-markets` enumerate eligible markets. A maker ladder unprofitable on spread alone can be
profitable on spread plus rewards - and the app currently cannot see rewards at all.

### 3.5 Manifold - what is missing

Used well (section 2.4). Absent and directly useful:

- **`/v0/bets?marketId=`** - the complete trade tape for one market. The app built exactly this feed
  for Kalshi (`/markets/trades`, `tradeFeed.ts`) and it underpins the flow engines, but on Manifold
  it only ever fetches a *user's* bets, never a *market's*. Per-market flow is the signal; per-user
  flow is a proxy for it.
- `/v0/market-history/{id}` - probability time series, for backtesting copy-trading instead of
  replaying it live.
- `/v0/leaderboards`, `/v0/get-all-positions`, `/v0/markets` with sort params, `/v0/groups`,
  `/v0/comments` (discussion is an early-moving signal on Manifold specifically), `/v0/stats`.
- `/v0/create-market` - again, the "be the house" option.
- `limitProb` and bet-size strategy params on `/v0/bet` (MEP-aware sizing).

### 3.6 IBKR - unused capability

**[unverified in detail]** - I confirmed the connection shape (`@stoqey/ib`, TWS/Gateway socket,
paper-vs-live by host) but did not read `ibkr.ts`/`ibkrAdapter.ts` line by line. The lab's own report
(`docs/IBKR-PAPER-LAB-2026-09-16.md`) describes it as a reference-price consumer. Unused IBKR surface
that would matter here: scanner results, **option chains and implied volatility**, `what-if`/scenario
margin, tick-by-tick data, combo orders, SMART routing, the economic calendar, news. The single
highest-value item is **implied volatility**: an option IV surface *is* a distribution, and every one
of these markets settles against a distribution. A BTC annual high/low ladder (`KXBTCY`, zero fee -
see F2) can be priced from IV, which is a real fair value rather than a copy of the book.

---

## 4. Strategy inventory, by venue

Status is from the live `ladder.json`, `kalshi-auto.json`, `mini-auto-polymarket-us.json` and the
source's own header comments (which record backtest verdicts - good practice, keep it).

### 4.1 Kalshi - `autoTrader.ts` (4859 lines) and satellites

| Engine | File | Idea | Measured state (lifetime, live money) |
|---|---|---|---|
| **fade** | `autoTrader.ts` (~L240 block) | Buy NO against 1-5c longshots that gapped up on overnight news | 240 trades, **227W / 13L, +$7.99**, but **CLV sum -455c over 195** and **markout -241c over 195**. Ladder window: 187 trades, net $1.85, mean 0.07c/contract, band -1.94..2.07. Held at x1. |
| **mean-reversion** | `autoTrader.ts` | 10-minute dislocation reversion | 14 trades, **+$19.18**, very high variance (clvSq 26851 over 13). Ladder window: 8 trades, -$2.64. tiny-live. |
| **consensus** | `autoTrader.ts` | Follow the more-attended side of an event | 72 trades, +$1.39. tiny-live. |
| **crypto-15m / crypto-ladder** | `cryptoConvergence.ts` (446) | 15m/hourly crypto convergence to spot | 15 trades +$0.12; ladder 13 trades -$0.07. tiny-live. |
| **volume-spike** | `autoTrader.ts` | Trade unusual volume | 67 trades, -$4.73. tiny-live. |
| **news** | `news.ts` (500) + `intelligence/` | LLM-read headlines -> title-token match -> trade | 1 trade, -$0.11. tiny-live. |
| **settlement** | `settlement.ts` (151) | Post-settlement accounting plays | 2 trades, -$2.56. paper. |
| **sports-anchor** | `sportsAnchor.ts` (737) + `sportsGameOdds.ts` (379) | Sportsbook consensus as fair value vs Kalshi price | 11 trades, -$5.64. tiny-live. |
| **leadlag** | `leadLag.ts` (856) | Polymarket CLOB leads Kalshi on crypto | 13 trades, -$0.89. tiny-live. See 4.2. |
| **weather-forecast / -day / -morning** | `weatherForecast.ts` (483), `weatherDay.ts` (350) | NWS/METAR/ForecastEx fair value for temperature brackets | 37 trades, -$1.75. forecast variant tiny-live; morning disabled. |
| **book-imbalance** | `dutchBook.ts` + book stats | Quote toward the heavy side of the book | 37 trades, **-$12.42**. disabled. |
| **momentum** | `momentumCandidates.ts` (108) | Buy strength | 54 trades, **-$10.63**. disabled. Backtested FAIL 2026-08-28. |
| **flow-follow** | `flowMonitor.ts`, `tradeFeed.ts` (217) | Follow tape flow | 14 trades, -$3.20. disabled. |
| **quoter** | `quoter.ts` (1245) | Two-sided maker quotes on thin temperature markets | Shadow markout **-1.93c over n=1083**. disabled, operator hold. |
| **dutch** | `dutchBook.ts` (264) | Dutch-book / multi-outcome mispricing | 1,600 events scanned, 152 opportunities logged, **0 executed**. tiny-live but inert. |
| **correlated** | `correlatedMarkets.ts` (257) | Same-underlying pairs | 1 pair, 0 candidates. |
| **cross-venue** | `autoTrader.ts:2299` | Kalshi vs Polymarket global gap | 21,290 signals historically; currently **0 candidates**, all refused `below-similarity`. |

Aggregate Kalshi engine stats (`kalshi-auto.json`, `state.stats`): **27,872 scans, 4,180 approved
signals, 1,830,199 vetoed, 551 executed.** A 438:1 veto:approve ratio is the system working, not
failing - but it also means the binding constraint is the entry gate, not the detector.

### 4.2 The lead-lag gate is the bottleneck, not the signal

Live counters from `main.log` (last 60k lines): **42,076 dislocations detected, 2,558 sweeps
attempted, 13 trades ever taken.** `leadLag.ts:683` sweeps the *entire* visible book whenever
`edge >= minEdgeC` and `bookSide === 'ask'`.

The reason it is inert is structural. `minEdgeC` is a **flat cent threshold** and `edgeC` is computed
as `theirYesC - (ourYesAsk + FILL_SLIP_C)` (`leadLag.ts:700-704`). A flat-cent gate on a
percentage-fee venue is the wrong shape: the 0.07 quadratic fee is ~3.5c/contract at p=0.50 and
~0.07c at p=0.01. The same constant is therefore **far too tight at mid prices** (nothing clears 1c
net of a 3.5c fee - hence 2,558 refusals) and **far too loose in the tails** (a 1c "edge" at p=0.02
is inside the noise). The fix is not a bigger number, it is gating on net:
`edgeC - kalshiOrderFeeCents(feeRate, C, P) - expectedSlipC > 0`, evaluated per price level. See **S5**.

### 4.3 Polymarket US - `miniAuto.ts` (1300 lines) + `polymarketUs.ts`

Live state (`mini-auto-polymarket-us.json`): `enabled: true`, `liveArmed: true`, `dryRun: false`,
but `fadeEnabled: false`, `microMakerEnabled: false`, `bookEnabled: false` - the tape recorder runs
and the traders are off. Lifetime: **237 trades, 117W / 106L, realised -$16.25**.
`book-imbalance`: 40 trades, **1W / 39L, -$8.57** - the worst hit ratio in the system.
`micro-maker`: 108 trades, -$1.95.

### 4.4 Manifold - copy trading

`manifoldCopy.ts` (121) + `manifoldPaper.ts` (228) + `manifold.ts`. Play money, so this is a **signal
discovery engine, not a revenue engine**: real wallets, real conviction, zero fee, no execution risk
to measure. The API usage is the best of the three venues (section 2.4). The missing piece is
`/v0/bets?marketId=` (section 3.5): it follows people when it could follow markets.

### 4.5 What the strategy layer says taken as a whole

**Every engine that pays a taker fee at full multiplier is negative. The only positives are the ones
that earn the spread as maker, buy the tail, or revert a dislocation.** fade +$7.99, mean-reversion
+$19.18, consensus +$1.39, crypto-15m +$0.12 - versus book-imbalance -$12.42, momentum -$10.63,
sports-anchor -$5.64, volume-spike -$4.73, flow-follow -$3.20, polyus book-imbalance -$8.57.

That pattern is the most useful thing in this audit, and it is not what the project's own conclusion
says. The conclusion recorded in the docs is "the fee kills everything". The data says something
narrower and more actionable: **the fee kills taker strategies at mid prices on full-fee series.**
Both halves of that sentence are exploitable - the fee varies by series (section 5.1) and by price
level (section S5), and the app currently treats neither as a choice it can make.

### 4.6 The fade engine's positive P&L deserves a specific warning

`fade` is the flagship and it is net positive, but read the components: 227 wins, 13 losses, +$7.99,
**CLV sum -455c** and **markout -241c**. Negative CLV means the market moves *against* the fade
immediately after entry; negative markout means the same from the fill's perspective. The profit is
therefore not coming from being right about price - it is coming from settlement convergence, and it
is **short-convex**: 227 small wins fund 13 large losses.

The ladder's own revert note (section 1.4) already caught the upside-only-band version of this
error. The residual risk is that a 13-loss tail is not enough of a sample to know the loss
distribution. At $1 max loss per contract on a 0.89-0.98 NO entry, one adverse settlement cluster
(they are correlated: a news day gaps *many* longshots at once) can erase months.

Concrete recommendation, cheap to implement: because fade entries are correlated by news event, the
clustered SE should cluster by **event/date, not by trade** - which the ladder already supports
(`clusteredSe` takes an arbitrary key). Verify the fade gate clusters by date and by
`event_ticker`, and add a per-event cap on simultaneous fade entries. If it does not, the +$7.99 is
a smaller edge than it looks. **[unverified - I did not trace the fade gate's cluster key.]**

---

## 5. Defects found in this audit

Ranked by how much money they touch. **None of these appear in the project's own known-defect list**
(`docs/DEVELOPER-HANDBOOK.md` section 16, which I read in full). Each one is stated with the file:line,
the evidence, and the money direction.

| # | Defect | Severity | Direction of error |
|---|---|---|---|
| D1 | Fee rounding uses `ceil` to **$0.01**; Kalshi's spec is `ceil` to **$0.000001** plus a rebate accumulator | **High** | overstates cost on small orders, up to **7.3x** |
| D2 | `fee_multiplier: 0` coerced to `1` - zero-fee markets priced as full-fee | **High** | overstates cost 7x on 14 series |
| D3 | Maker-incentive program fetched, logged, discarded (incl. a 50% fee discount) | **High** (opportunity) | blind to subsidy |
| D4 | Cannot quote Kalshi's sub-cent tick grid | Medium-High | forfeits maker competitiveness |
| D5 | `getFills` infers buy/sell from `book_side`, which does not encode direction | Medium | mislabels half of all fills |
| D6 | `portfolio:get` dies on a display-only sub-call | Medium | live, recurring |
| D7 | Maker fee keyed on one exact `fee_type` string | Low today | understates cost on 3 series |
| D8 | `getEventCategories` reads one unpaginated page of 200 | Low | silent coverage gap |
| D9 | Fee-waiver path is dead code; `Retry-After` ignored; no body validation | Low | minor |

### D1 - the fee model's rounding rule does not match the venue's (highest impact)

`src/main/strategies/autoTrader.ts:4894-4898`:

```ts
export function kalshiOrderFeeCents(feeRate: number, yesPrice: number, contracts: number): number {
  if (contracts <= 0 || feeRate <= 0) return 0
  const feeDollars = Math.ceil(feeRate * contracts * yesPrice * (1 - yesPrice) * 100 - 1e-9) / 100
  return (feeDollars * 100) / contracts
}
```

`* 100 ... / 100` is **round up to the nearest cent**. The justification is the comment four lines
above the fade's gate (`autoTrader.ts:2552`):

> "Kalshi computes taker fees on the ORDER total, rounded UP to the next cent - at 5-contract clips
> the ceil is up to ~1c/order that a smooth per-contract rate understates."

That is not Kalshi's rule. The vendor spec (`docs.kalshi.com/getting_started/fee_rounding`, fetched
2026-09-18) says:

> "Fees are six-decimal dollar amounts (`$0.000001` granularity)... **`trade_fee = ceil_6dp(model_fee)`**"
> "The **fee accumulator** applies across all fills of an order so that the total fee **converges to
> what a single equivalent fill would cost**."
> "**Net fee** = trade fee + rounding fee - rebate"

So the venue rounds up to a **micro-dollar**, and where a cent-level balance adjustment is needed it
adds a rounding fee that a **rebate accumulator refunds** so the total converges to the true model
fee. The code rounds up to a **cent** and keeps the excess permanently. The comment describes a rule
that does not exist.

Measured consequence (computed, `feeRate = 0.07`):

| price | contracts | true fee (c/contract) | code fee (c/contract) | overstatement | ratio |
|---|---|---|---|---|---|
| 0.02 | 1 | 0.1372 | 1.0000 | **+0.8628** | **7.29x** |
| 0.02 | 2 | 0.1372 | 0.5000 | +0.3628 | 3.64x |
| 0.05 | 1 | 0.3325 | 1.0000 | +0.6675 | 3.01x |
| 0.10 | 2 | 0.6300 | 1.0000 | +0.3700 | 1.59x |
| 0.50 | 2 | 1.7500 | 2.0000 | +0.2500 | 1.14x |
| 0.02 | 750 | 0.1372 | 0.1373 | +0.0001 | 1.00x |

The error scales as **1/C**, so it is invisible on large clips and dominant on small ones. That
matters because the ladder's x1/x2 notches and the ledger's small trades *are* the small ones - the
code's own comment at `autoTrader.ts:4745` notes "Three keys in the live ledger sit at `netN=1` right
now", and at C=1 in the 2c tail the model charges **0.86c/contract against a true 0.14c**.

**Why this is the most important defect in the document:** the fade engine's entire measured edge is
**0.07 cents per contract** (`ladder.json`: "mean 0.07c/contract"). The D1 error at small sizes is
**0.05 to 0.86 cents per contract** - the same order as, and frequently an order of magnitude larger
than, the edge being measured. It sits in both the **decision** path (`fadeMinEdgeCents`,
`autoTrader.ts:2557-2562`) and the **accounting** path (`entryFeeDollars`, `netCentsOf`,
`autoTrader.ts:4744-4755`), so it simultaneously suppresses entries and distorts the reported net of
the ones that get through.

**Calibration, so this is not over-read:** the fade's $15 clips at 2c are ~750 contracts, where the
error is negligible - **the +$7.99 fade result is not invalidated.** The fix matters for (a) every
small-order decision at x1/x2 notches, (b) the `netN=1` ledger entries, (c) any future strategy that
trades round-lot-free tails, and (d) the fact that the codebase is reasoning about a venue rule that
does not exist.

**Fix:** implement the spec, not the approximation - `trade_fee = ceil(model_fee * 1e6)/1e6`, and
model the accumulator as converging the order's total fee to the model fee (i.e. for EV purposes,
**use the smooth per-contract rate and drop the cent ceil entirely**). Also worth noting from the
same page: **direct members have `$0.0001` balance precision vs `$0.01` for non-direct**, so direct
member status cuts rounding exposure by 100x. The app already calls
`/account/api_usage_level/upgrade` (`kalshi.ts`), so it is one step from asking about this.

### D2 - `fee_multiplier: 0` is silently coerced to `1`: zero-fee markets are priced as full-fee

`src/main/venues/kalshi.ts:1389`, in the per-series fee cache:

```ts
const mult = res.series?.fee_multiplier
this.seriesFeeCache.set(s, {
  mult: typeof mult === 'number' && mult > 0 ? mult : 1,   // <-- 0 fails `> 0` and becomes 1
  ...
```

`mult > 0` is a guard against garbage, but **`0` is a legal and meaningful value** - it means the
series pays no fee at all. The expression turns "free" into "full price". Downstream,
`kalshi.ts:1405` computes `m.feeRate = 0.07 * c.mult`, so a zero-fee market gets `feeRate = 0.07`.

Verified against live Kalshi (full `/series` pagination, 14,154 series):

| fee_multiplier | series | example |
|---|---|---|
| **0** (free) | **14** | `KXBTCY`, `KXETHY`, `KXGDPYEAR`, `KXTRUMPOUT`, `KXDOED`, `KXELECTIRAN`, `KXNEXTIRANLEADER`, `KXIRANDEMOCRACY`, `KXGREENLAND`, `KXGAMBLINGREPEAL`, `KXEXPAND`, `KXCITRINI`, `KXPAHLAVIHEAD`, `KXLAYOFFSYINFO` |
| **0.5** (half) | **19** | `KXMLBGAME` + 18 other MLB series |
| 1 (full) | 14,121 | everything else |

The 0.5 case is handled correctly (`0.5 > 0` passes) - **the MLB half-fee is applied properly.** The
bug is specific to `0`, and it is directionally *conservative*: it overstates cost, so it never loses
money. But it makes the **only zero-fee markets on the venue invisible to EV math**, which is a
strategic cost rather than a solvency one.

Live liquidity on the affected series (probed 2026-09-18, `status=open`):

| series | open markets | 24h volume (contracts) | fee_multiplier |
|---|---|---|---|
| **`KXMLBGAME`** | 98 | **6,635,436** | 0.5 (correctly applied) |
| **`KXBTCY`** (annual BTC ladder) | 28 | **125,278** | **0 (read as 1)** |
| `KXGDPYEAR` | 154 | 682 | 0 (read as 1) |

`KXBTCY` is the one that matters: a **liquid, zero-fee** market. The project's central conclusion -
"taker is dead because of the 0.07 quadratic fee" - is a statement about full-fee series. On
`KXBTCY` the taker fee is **exactly zero**, and it trades 125k contracts a day.

Two independent reasons the app cannot see it: D2 makes its fee look like 0.07, and every scan window
is short-dated (`maxCloseHorizonMs` 12h, `shortTermHorizonMs` 36h) so an annual market is never in the
universe. Fix D2 first; it is one character.

### D3 - the maker-incentive program is fetched, logged once, and thrown away

`kalshi.ts:963` implements `getIncentivePrograms()`; `autoTrader.ts:1136` calls it once per session.
The doc comment states the design: *"Read only - the fee discount and reward terms are per-program
and would need real parsing before they could feed an EV; nothing trades on them."* The log line
from today reads `incentive programs: 200 returned; sample {...}`, and then the array is dropped.

What is being dropped (decoded against the vendor schema, centi-cents = $0.0001):

- **`period_reward: 2000000` = $200.00 per period, per market**, for resting `target_size_fp` =
  **1,000 contracts** inside `max_spread_dollars` = **$0.15**.
- **`discount_factor_bps: 5000` = a 50% fee discount.**
- `max_reward_per_account: 100000` = $10.00 per account per period; `min_avg_volume_fp` = 1,000.
- `paid_out: false` - a boolean that tells you whether you actually earned.

Three separate defects ride on top of the non-use:

1. **Unpaginated.** `?limit=200` with no `next_cursor` follow, although the response schema carries
   `next_cursor`. "200 returned" is a page cap, so the reward universe is unknown and under-counted.
2. **Silently zero on failure.** Wrapped in `catch { return [] }` - an expired key or a 500 looks
   identical to "no programs exist".
3. **`discount_factor_bps` is a per-market fee multiplier that the EV math never sees**, while
   `kalshi.ts:1408` derives the maker fee from `fee_type` string equality alone (see D7).

For a project whose stated blocker is that maker spread does not clear fees, an unexamined venue
program that pays cash for exactly the quoting the ladder already does is the highest-value item
here. See strategy **S1**.

### D4 - the app cannot quote Kalshi's sub-cent tick grid

Live `/markets` payload carries two fields the adapter's `KalshiMarket` interface does not declare,
on **100%** of markets: `price_level_structure` and `price_ranges`. Sampled value:
`center_deci_edge_centi_cent`, whose `price_ranges` are

| band | step |
|---|---|
| 0.00 - 0.01 | **$0.0001** (0.01c) |
| 0.01 - 0.99 | **$0.0010** (0.1c) |
| 0.99 - 1.00 | **$0.0001** (0.01c) |

Every order the app sends quantises to whole cents: `price: leg.toFixed(2)` at `kalshi.ts:1010`
(place), `kalshi.ts:1103` (amend) and `kalshi.ts:1145` (ladder). The inline comment is accurate -
*"whole-cent prices are valid in every price-level structure"* - so **this is not a crash and not a
rejection risk.** It is a forfeited capability.

Why it costs money: a maker's entire product is price priority. On a book that allows 0.1c steps,
quoting in 1c steps means you are routinely 0.1-0.9c behind the best level and cannot improve into
it. That is most severe in the 0.01-0.05 region, where the app's fade and longshot engines live and
where a 1c grid is 10-100% of the price itself. The internal data path can already represent it -
`kalshiWs.ts` reads `price_dollars` as a float - so only the outbound serialisation quantises.

Related: `price_ranges` also means the app's cent-grid book statistics (`bookStats`, spread
measurements, the 1c/2c level buckets in the ladder) are measuring a book that is finer than the
ruler.

### D5 - `getFills` derives buy/sell from a field that does not encode direction

`kalshi.ts:877` maps fills as:

```ts
side: f.book_side === 'ask' ? 'sell' : 'buy',
outcome: f.outcome_side === 'no' ? 'NO' : 'YES',
```

Kalshi's own `order-direction` doc (`scripts/kalshi-docs/order-direction.md`) states that
`book_side` and `outcome_side` are **"the same bit in book-vocabulary"** - `bid` is equivalent to
`yes`, `ask` to `no` - and that `outcome_side` is set by *positioning*: "buy-yes **and sell-no**
produce `yes`; buy-no **and sell-yes** produce `no`". So `book_side` carries no information about
whether the trade was a buy or a sell:

| actual trade | book_side | code says | correct? |
|---|---|---|---|
| buy YES | bid | buy | yes |
| sell NO | bid | buy | **no** |
| buy NO | ask | sell | **no** |
| sell YES | ask | sell | yes |

**Half of all fills get the wrong verb.** The `action` field (`buy`/`sell`, deprecated but still
returned) is what encodes direction and is not read.

Blast radius is currently small - I traced the consumers and P&L does not use it: the engine's
realised P&L comes from `mapKalshiSettlement` (`engine.ts:550+`), and `fillReconciler` keys on
`fill_id`/`order_id`/`ticker`/`outcome`/`shares`/`price`/`fee`. But `side` is persisted into the
execution archive and shown in the trade log (`autoTrader.ts:3202`, `quoter.ts:606`,
`miniAuto.ts:993`), so any future analysis that reconstructs flow from the archive - which is exactly
what `tradeFeed.ts`, `flowMonitor.ts` and the sharp-tracker work will want to do - will be reading a
field that is wrong half the time. Fix it before the archive is trusted for flow research.

### D6 - `portfolio:get` fails entirely when a display-only sub-call fails

`engine.ts:486-487`, inside `computePortfolio`:

```ts
const openOrders = adapter.getOpenOrders ? await adapter.getOpenOrders() : []
```

`getAccount` is wrapped (`.catch` -> zero account) and `getPositions` is wrapped, but `getOpenOrders`
is not. It is used only to compute `openOrderReserve`, a display nicety. If it throws - a Kalshi 429,
a timeout, a shard hiccup - the whole `portfolio:get` IPC handler rejects and **the dashboard loses
the account balance, the positions table and the P&L together.**

This is not theoretical. From the live log (`%APPDATA%\oracle-trader\logs\main.log`, last 40k lines):

```
[error] Error occurred in handler for 'portfolio:get': {"status":N,"name":"HttpError"}
```

One venue's display-only read takes down the operator's view of everything, at exactly the moment
(venue distress) when the operator most needs to see positions. Wrap it, or degrade `openOrderReserve`
to `undefined` and let the UI say "unknown".

### D7 - maker fee keyed on one exact `fee_type` string

`kalshi.ts:1408`:

```ts
m.makerFeeRate = c.feeType === 'quadratic_with_maker_fees' ? KALSHI_MAKER_FEE_COEF * c.mult : 0
```

The vendor `FeeType` enum is wider than that one string. Live distribution over 14,154 series:

| fee_type | series | maker coefficient the code assumes | actual |
|---|---|---|---|
| `quadratic` | 13,991 | 0 | 0 - correct |
| `quadratic_with_maker_fees` | 160 | 0.0175 | 0.0175 - correct |
| **`quadratic_with_combo_maker_fees`** | **3** | **0** | **0.5 x 0.07 = 0.035** |

So maker EV is overstated on exactly 3 series, and they are `KXMVESPORTSMULTIGAMEEXTENDED`,
`KXMVECROSSCATEGORY`, `KXMVECROSSCATEGORY-SHARD1` - the multivariate exotics the app already excludes
via `mve_filter=exclude`. **Live impact today: zero.** It becomes live the day MVE is turned on. Fix
by mapping the enum to a coefficient rather than comparing to one literal.

### D8 - `getEventCategories` reads one unpaginated page

`kalshi.ts:1290` fetches `/events?limit=200&status=open` and returns, with no cursor follow, against
an event universe in the thousands. Markets whose event is not in that first page get
`category: undefined`. Mitigating: `kalshi.ts:1421` treats the **series** category as authoritative
and the event category only as a fallback, so the practical damage is small. Still, it is the only
unpaginated read left in the adapter, and the codebase paginates everything else carefully.

### D9 - smaller items

- **Fee-waiver path is dead.** `kalshi.ts:104` declares `fee_waiver_expiration_time?`, and
  `autoTrader.ts:2550` branches on `waived`. Field presence across 5,722 sampled open markets:
  **0.0%.** Harmless today, but it is a code path that can never be exercised and therefore never
  tested - if Kalshi starts emitting it, it goes live untested.
- **`Retry-After` is ignored on 429.** `http.ts` backs off `300 * 3^n + jitter` regardless of what
  the venue says. The comment justifies it for Kalshi ("429s carry no Retry-After"); it is the wrong
  default for the other four providers, which do send it.
- **No body validation.** `http.ts` returns `(await res.json()) as T`. A 200 with an HTML body
  (captive portal, CDN error page) throws a `SyntaxError` from outside the retry classifier, so it
  surfaces as a scan failure rather than a retryable one.
- **`sandbox: false`** in the BrowserWindow (`index.ts:116`) with 51 IPC channels including
  `placeOrder`. `contextIsolation: true` and `nodeIntegration: false` are set, so this is a
  hardening gap rather than an open door - but on an app that moves real money, a renderer XSS has a
  direct path to the trade IPCs. Consider `sandbox: true` and an allow-list of venues per session.
- **Priority starvation in the rate limiter.** `http.ts` sorts the queue by priority (0 scan, 1
  account, 2 write) with no aging, so under saturation priority-0 scanner reads can be starved
  indefinitely by a continuous stream of writes. Bounded in practice by scan cadence; worth a
  starvation counter.

---

## 6. Engineering and process observations

### 6.1 There is no version control

```
> git -C G:\PROJECTS\oracle-trader status
fatal: not a git repository (or any of the parent directories): .git
```

`.gitignore` **exists** (`node_modules/`, `out/`, `dist/`, `*.log`, `.env`) but `.git` does not. So
the intent was there and the repository is gone or was never initialised in this working copy. For a
system that moves real money, this is the highest-priority non-trading fix in the document: no
history, no blame, no bisect, no safe rollback, and no way to answer "what changed before the ladder
started losing?".

What has replaced it is worse than nothing:

```
81  .bak* files inside src/          e.g. kalshi.ts.bak_20260903_exact_contracts
                                     e.g. polymarketUs.ts.bak_20260905_order_lifecycle
```

They are named `<file>.ts.bak_<date>_<reason>`, so their extension is not `.ts`, so `tsc` and
electron-vite ignore them - **they cannot break the build, and I verified that** (typecheck rc=0).
The hazard is to *readers*. Any developer or LLM doing `grep -r` or a glob over `src/` will pull stale
copies of the exact logic under investigation and can easily "fix" a bug in a dead file, or reason
from a superseded fee model. I hit this myself while auditing. Two concrete guards, both cheap:

1. `git init` + first commit, and add `*.bak*` and `backups/` to `.gitignore` (they are not in it now).
2. Move the 81 files into `backups/` where they belong, or delete them once git exists.

### 6.2 Source is edited by throwaway patch scripts

`scripts/` contains `patch-10.js` ... `patch-21.js`, `patch-auto.js`, `patch-belt.js`,
`patch-strict.js`, `patch-ws.js`, `patch-ws2.js`, `fix-*.js`, `add-getquantstatus.js`, and root-level
`.patch_*.py` files, plus a `scripts/__pycache__/`. These are programs that rewrite the app's own
source with string replacement.

That is how a codebase with no git survives an LLM-driven build, and it explains the `.bak` files. But
it is a genuine risk now that the system is live-money: a patch script that mis-targets a string can
silently change trading logic, and there is no diff to catch it and no history to revert to. The
project's own docs record exactly this having happened once already (a bad patch that corrupted
comments across the tree).

**Recommendation:** retire the patch scripts as a mechanism once git exists. Edit files directly,
review the diff, commit. Keep the patch scripts in `scripts/` as an archaeological record.

### 6.3 Encoding: verified clean, with one inconsistency

I checked this properly because the docs mention a past mojibake incident and because the console
rendering of these files *looks* corrupted (the terminal's codepage mangles UTF-8, so `price: 0.7`
displays as garbage). Byte-level result:

- **Invalid UTF-8 files: 0.** **Mojibake marker sequences (C3 A2 / C3 83): 0.** The tree is clean; the
  apparent corruption is a display artifact. Worth knowing before anyone "fixes" it.
- **8 files carry a UTF-8 BOM**: `intelligence/{adjudicator,auditStore,openRouterClient,types}.ts`,
  `strategies/{sportsAnchor,sportsGameOdds}.ts`, `renderer/src/AutoTraderPanel.tsx`,
  `shared/ipc.ts`. Harmless to the compiler, but it breaks naive concatenation, confuses some diffs,
  and is inconsistent with the other ~200 files. Strip for consistency.

**Note for whoever picks this up:** read source through a UTF-8-correct tool, not a Windows console.
Several of my own early readings were misleading until I checked bytes.

### 6.4 Test entry points have drifted from the docs

`package.json` defines ~25 `test:*` scripts (`test:ladder`, `test:risk`, `test:remaining`,
`test:completion`, `test:settlement-accounting`, `test:adversarial`, `test:review`, ...) but **there is
no aggregate `test` script** - `npm test` fails with `Missing script: "test"`. The handbook tells a
newcomer to run `npm run test:unit`, which also does not exist.

I ran the sampled suites individually and all pass. The defect is the *entry point*: with no single
command there is no way to run everything, so nothing catches a regression across the whole set, and
the documented onboarding command is wrong.

**Recommendation:** add `"test": "node scripts/tests/run-all.cjs"` that runs every registered suite
and fails loudly, and fix the handbook line. This is the one item in section 6 that a newcomer will
trip over on day one.

### 6.5 Disk growth from shadow capture is outpacing the retention policy

`%APPDATA%\oracle-trader\` currently holds 154 `cf-reference-shadow-*.jsonl` files and daily
`main.log` rotation, with individual shadow files at 46-77 **MB per day** (`cf-reference-shadow.jsonl`
76MB, `.previous` 46MB). `main.log` is 31.9 MB. The 2026-09-17 report already flags ~731 MB/week.

At that rate the capture that makes the research possible will eventually fill the drive, and the
failure mode - a full disk during a live-money session - is an availability bug, not a disk
inconvenience. Needs a size-based rotation and a retention horizon decided *now*, while the data is
small enough to keep.

### 6.6 Runtime health, as observed

The app is live right now (4 Electron processes, started today). Sampling the last 30-60k log lines:

| Signal | Count | Read |
|---|---|---|
| `[ibkr-lab] Error: Gateway API not available yet` | 437 warns | IBKR Gateway is not running; the lab is idle |
| `[ibkr-lab] fill reconciler run failed: Error: Not connected` | 218 | Consequence of the above. The test suite says this is logged once per ten minutes, so 218 occurrences is ~36 hours of continuous failure - **the backoff is not working as documented, or two code paths log independently.** Worth a look. |
| `[consensus] ... refused {"fetch-budget":N}` | frequent | The consensus engine is chronically fetch-budget-bound |
| `[cross-venue] ... refused {"below-similarity":N}` | frequent | The cross-venue arm is starved at the matcher, not the fee gate |
| `Error occurred in handler for 'portfolio:get'` | recurring | D3, confirmed live |

The IBKR item is the one to fix first: it is pure log noise today, but a fill reconciler that cannot
run is a *safety* component being unavailable, and it should page rather than whisper.

### 6.7 What is genuinely good here (keep it through any rework)

Worth stating explicitly, because a new developer or model handed this will otherwise optimise the
wrong things:

- **The fee model is per-series and correct in structure** (taker `0.07 * mult * C * P * (1-P)`,
  maker `0.0175 * mult`, cached per series with a conservative default). D1/D2/D5 are bugs *inside* a
  design that is right.
- **Day-clustered statistics with a t-table and coin-day counting.** Most retail trading code does
  none of this.
- **Pre-registration and the ladder's refusal to promote on upside-only samples** (section 1.4).
- **`client_order_id` idempotency, no-POST-retry, and reconciliation-by-journal.** This is the correct
  answer to "did my order go in?" and it is easy to get wrong.
- **Capability-declared venue adapters that throw rather than lie.**
- **A priority queue that lets a write jump the scanner reads.**
- **Header comments recording backtest verdicts and failures** (`momentum (backtested 2026-08-28:
  FAIL...)`). This is institutional memory that normally lives in nobody's head.

---

## 7. Improvements - engineering

Ordered by (money affected) / (effort). Items 1-4 are one-day fixes.

1. **`kalshi.ts:1389`** - change `mult > 0 ? mult : 1` to `Number.isFinite(mult) && mult >= 0 ? mult : 1`. One character. Unblocks the zero-fee universe (D2).
2. **`autoTrader.ts:4894`** - replace the cent `ceil` with the vendor's `ceil_6dp`, or use the smooth per-contract rate for EV (D1). Then **re-run** the fade and mean-reversion gates: their measured nets are computed through this function.
3. **`engine.ts:486`** - wrap `getOpenOrders` in `.catch(() => [])` and mark the reserve unknown (D6). Kills a recurring live error.
4. **`kalshi.ts:963`** - paginate `getIncentivePrograms` with `next_cursor`, return `undefined` on failure instead of `[]`, and persist the raw rows so the reward universe is measurable before anything trades on it (D3).
5. **Add a fee-tier column to every shadow table.** The app records `feeRate` per market; nothing aggregates it. One derived number - `feeRate * price` - turns the research corpus from "by strategy" into "by fee tier", which is the axis that actually explains the P&L (section 8.0).
6. **`http.ts`** - honour `Retry-After` when present (every provider except Kalshi sends it); classify a JSON parse failure on a 200 as retryable; add a starvation counter to the priority queue.
7. **`kalshi.ts:877`** - read `action` for the fill verb, fall back to `book_side` only when absent, and add a test asserting the four-case table in D5.
8. **`kalshi.ts:1408`** - map `FeeType` through a table instead of one string comparison (D7).
9. **`index.ts:116`** - `sandbox: true`, and gate the 51 IPC channels with an explicit allow-list per execution mode. On an app that places real orders, the renderer should not reach `placeOrder` for a venue the ladder has disabled.
10. **Retention.** Age out or compact `cf-reference-shadow` (46-76 MB/day) and the tape files. The 09-17 report flags 731 MB/week; still unhandled.
11. **`git init`** before any further change (6.1), with `*.bak*` and `backups/` added to `.gitignore` (they are not currently ignored).
12. **Docs drift** - `DEVELOPER-HANDBOOK.md` tells a newcomer to run `npm run test:unit`, which does not exist; the root `README.md` is self-flagged as an obsolete scaffold. Both are the first files a new developer or model opens.

---

## 8. New strategies

### 8.0 The one formula that reframes the whole strategy table

Kalshi's taker fee per contract is `feeRate * P * (1 - P)` with `feeRate = 0.07 * mult`
(`autoTrader.ts:4896`). A buyer of YES at price `P` wins `(1 - P)` if correct. Therefore:

> **fee / potential win  =  0.07 x mult x P**

The fee is not a tax on trading. **It is a tax on buying expensive contracts.**

| you buy at | mult = 1 | mult = 0.5 | mult = 0 |
|---|---|---|---|
| 0.02 | 0.14% | 0.07% | **0%** |
| 0.05 | 0.35% | 0.175% | **0%** |
| 0.11 | 0.77% | 0.385% | **0%** |
| 0.50 | 3.5% | 1.75% | **0%** |
| 0.95 | 6.65% | 3.3% | **0%** |

Read against section 4.1 this explains the table without invoking luck. `fade` is the only
consistently positive Kalshi engine because it buys NO at 0.02-0.11, where the fee is 0.14-0.77% of
the win. `book-imbalance`, `momentum`, `flow-follow` and `volume-spike` are all negative, and they
are all **mid-price taker** engines - the one place the fee genuinely bites.

Two corollaries the codebase has not drawn:

- **Pure maker on `quadratic` series pays no fee at all.** `makerFeeRate` is 0 on 13,991 of 14,154
  series (`kalshi.ts:1408`). There the maker's only costs are adverse selection and inventory - both
  already measured by this app (markout, CLV). The fee problem is *already solved* for maker flow on
  98.8% of the venue; what remains is a selection problem, and the instrumentation for it exists.
- **The 1-5c tail is where fees are smallest and the tick is finest** (D4: 0.01c steps below 0.01).
  The app is working the cheapest part of the market with the coarsest tool in the market.

Every strategy below follows from that one line.

### S1 - Incentive-aware maker ladder (Kalshi LIP) - highest expected value

**Thesis.** Kalshi pays up to **$200 per period per market** for resting 1,000 contracts inside a
$0.15 spread, plus a **50% fee discount**, on at least 200 markets (a page cap, so probably more).
The app's maker ladder already does the quoting; it does it without looking at where the money is.

**Why credible.** The reward is denominated in exactly what the app cannot otherwise get: a reason
for resting quotes to be worth more than the adverse selection they attract. And
`discount_factor_bps` halves the fee on precisely the markets being quoted.

**Build.**
1. Paginate and persist `/incentive_programs` (fix D3); key by `market_ticker` + `program_id`;
   refresh daily rather than once per session.
2. Join onto the market universe; expose `incentiveReward`, `targetSize`, `maxSpread`, `discountBps`
   on `VenueMarket`.
3. Apply `discountBps` in the fee model - one multiplier at `kalshi.ts:1405/1408`.
4. Bias the ladder toward incentive markets, quoting at `target_size_fp` inside `max_spread_dollars`.
   `target_size_fp` = 1,000 contracts is far above `MAX_NOTCH` sizing, so the program is a reason to
   revisit the size ceiling *on these markets specifically*.
5. Poll `paid_out` daily - ground truth on whether the quoting earned, independent of trade P&L.

**Gate.** This is a cash-flow strategy with little directional risk, so it needs a different metric:
**reward dollars accrued per day of capital committed**, not net cents per contract. Pre-register the
target (`>= $X/day` on `>= N` markets at `<= $Y` average inventory) before sizing up.

**Kill.** `paid_out` stays false for two consecutive periods on markets where the ladder was
demonstrably inside `max_spread` and above `target_size` - provable only once S4 exists. That means
the program is not paying you and the quoting is pure cost.

### S2 - Fee-tier universe selection: trade where the fee is zero

**Thesis.** 14 series are fee-free, 19 half-fee (D2). `feeRate` is threaded through every EV as a
cost input but is **never used as a screening criterion**. Making it one changes the character of the
universe.

**The concrete target is `KXBTCY` / `KXETHY`** - annual BTC/ETH strike ladders, `fee_multiplier = 0`,
28 open markets, **125,278 contracts in 24h**. A taker strategy there pays nothing, so every
conclusion in this project that begins "taker is dead because of the fee" simply does not apply to
it. The app cannot see it for two independent reasons: D2, and the 12h/36h scan windows that exclude
annual maturities.

**Build.**
1. Fix D2.
2. Add a **long-dated, low-fee universe** as a separate scan path for `fee_multiplier < 1` series
   regardless of `close_time`, so it cannot blow the existing scan budget.
3. Add `feeTier` to every shadow row and **re-score the existing gate corpus conditioned on fee
   tier**: take the 4,180 approved signals and 551 executions already on disk and ask what they would
   have earned restricted to `mult < 1`. A backtest on data already captured - no new collection, and
   the cheapest high-information experiment available here.

**Risk, honestly.** Zero fee also means zero reward for market makers, so most fee-free series have
thin books (`KXGDPYEAR`: 154 markets, 682 contracts/day - effectively untradeable). `KXBTCY` is the
exception with real volume. Screen on `volume_24h_fp` **and** fee tier together, or the strategy will
fill into GDP-forecast markets it cannot exit.

### S3 - Sub-cent tail making

**Thesis.** Below 0.01 the tick is 0.01c; from 0.01-0.99 it is 0.1c (D4). The app quotes in 1c steps.
In the tail one tick *is* the spread, so being 0.1c better is the difference between first in the
queue and not in it.

**Build.** Read `price_ranges` per market; replace `leg.toFixed(2)` (`kalshi.ts:1010, 1103, 1145`)
with a snap-to-allowed-grid function; default to the cent grid and use the finer grid only where the
market's own `price_ranges` permits. Then re-measure fill rate. That is the whole experiment, and the
instrumentation already exists.

**Gate.** A mechanical improvement to an existing strategy: A/B it by market cohort on **fill rate at
equal quoted size**, rather than promoting it through the ladder.

### S4 - Queue-position instrumentation (prerequisite, not a strategy)

**Thesis.** "Why don't we fill?" is the project's central unanswered empirical question, and it is
unanswerable today because `/orders/queue-position` is never called (3.2). Every fill-rate model in
the codebase infers queue position from outcomes, which is circular.

**Build.** On each resting order, poll queue position on a slow cadence; record `(ticker, price,
our_size, level_size, our_rank, t_until_fill_or_cancel)`. Two weeks of that converts "we never fill"
into a fitted function of level, size and rank - and it is the missing input for S1 and S3, both of
which are judged on fill behaviour. **Highest-value research-infrastructure item here, and it is one
endpoint.**

### S5 - Replace the flat-cent edge gate with a net, price-aware gate

**Thesis.** `leadLag.ts:700-704` gates on `edgeC >= minEdgeC` - a **flat cent** threshold - against a
**price-proportional** fee. Wrong in both directions at once: at mid prices the real fee is
~1.75c/contract, so a 1c "edge" is a guaranteed loss (which is why the gate must be set high, hence
**42,076 dislocations detected, 2,558 sweeps attempted, 13 trades ever taken**); in the tails the
real fee is ~0.14c, so the same gate discards genuinely profitable trades.

**Build.** Gate on
`edgeC - kalshiOrderFeeCents(feeRate, theirPrice, C) - expectedSlipC(price, depth) > 0` - per
candidate, per price level, per venue. The function already exists; it is simply not on this path.
Then **re-score the 42,076 recorded dislocations with the new gate**: a free re-run over the engine's
entire history.

**Why it could be big.** If 1% of those 42,076 were net-positive trades a flat-cent gate discarded,
that is 420 trades - an order of magnitude more evidence than lead-lag has produced in its whole life.

**Also fix the pairing while in there.** `crossVenueSignals` (`autoTrader.ts:2299+`) matches Kalshi to
Polymarket on asset + title-token jaccard + a 35-minute close-time window, and **never compares
strikes**. On a venue where one event carries a 500-rung strike ladder with an identical title on
every rung, that can pair a Kalshi rung at one strike against a Polymarket market at another and call
the difference a dislocation. It is currently starved by the similarity gate (0 candidates in the
last 60k log lines), so no damage is being done today - but it will produce spurious gaps the moment
it starts firing. Add a strike-equality check before it is trusted.

### S6 - Use Kalshi's own truth feeds for weather

**Thesis.** Weather is the most-engineered, least-profitable domain (`quoter` disabled at **-1.93c
markout over n=1,083**; three weather engines at tiny-live/paper). The chain reconstructs the
settlement value from NOAA + METAR + ForecastEx and compares it to the market. But the market settles
against **Kalshi's own index**, and two endpoints give it directly:

- `GET /live-data/weather-index` - Kalshi's settlement station reading;
- `GET /events/forecast-percentile-history` - Kalshi's own probabilistic forecast of the settlement
  value, published for exactly these markets.

Comparing your NOAA-derived number to the market measures *your data pipeline's* error. Comparing
Kalshi's settlement index to Kalshi's forecast-percentile distribution measures **the settlement
distribution the price is actually a claim about**.

**Build.** Fetch both; register them as evidence sources in `intelligence/externalEvidence.ts`
alongside NOAA/METAR - strictly better inputs for the same adjudication - then re-score the existing
weather shadow data against them.

**Re-check the premise too.** "Weather is fee-dead" was reasoned at full multiplier. At 98c a YES-buy
pays 6.9% of its win, but the fade-style NO-buy at 0.02 pays 0.14%. The losing direction on weather is
*buying the favourite*, not *selling* it.

### S7 - Polymarket: close `socialExposure` with the Data-API, and make rewards visible

1. `polymarket.ts` declares `socialExposure: false /* on-chain positions need wallet tracking
   (future work) */`. `data-api.polymarket.com/{positions,holders,trades,leaderboard}` gives that over
   plain HTTP - no wallet, no chain indexing - and **`manifold.ts:327` already implements this exact
   pattern** (`getTopHolders` -> positions -> recent bets). Port it rather than inventing it.
2. Gamma already returns `rewardsMinSize` / `rewardsMaxSpread`, and CLOB has `/sampling-markets` and
   `/endpoints` for reward eligibility. The Polymarket maker ladder is unprofitable on spread alone;
   with rewards it may not be, and the app cannot see them at all.
3. `/prices-history` on the CLOB would give Polymarket global its first historical price series -
   which is what currently blocks local backtesting of every `polyus-*` strategy.
4. `/books` (batch) replaces the current per-market `/book` loop, cutting the request count that
   forces the 200-market search cap.

**Gate.** Reuse the Manifold copy-trading gates. A new *venue capability* must not skip
pre-registration just because the plumbing exists elsewhere.

### S8 - Implied-volatility fair value for the zero-fee crypto ladders

**Thesis.** The strongest genuine-edge idea here, because it composes two findings: `KXBTCY` /
`KXETHY` are **fee-free with real volume** (S2), and they are **option-shaped** - "will BTC exceed $X
by 1 Jan" is a digital payoff on BTC. IBKR is already connected and used for reference prices, and
**option chains and implied volatility are entirely unused** (3.6).

An IV surface *is* a distribution, and every one of these markets settles against a distribution.
Pricing a BTC annual strike ladder from the option IV surface yields a fair value that is **not a copy
of the market's own book** - exactly the property the project's evidence doctrine demands and none of
the current engines have (they anchor on another venue's price, a sportsbook line, or an LLM's
reading of a headline).

**Build.** Pull the BTC/ETH option chain from IBKR; read or fit implied vol per strike/expiry; convert
to digital probabilities (`N(d2)` for "expires above K"); compare against the Kalshi ladder on
`KXBTCY`; trade where the gap exceeds the (zero) fee plus slip. Run as a shadow engine first - the
probability conversion is where the risk lives, not the data.

**Kill.** If IV-implied probability and Kalshi price agree within slip more often than not, the
market is simply efficient. Useful, cheap, and an answer this project could actually publish.

### S9 - Block trades / RFQ as the size channel

`communications` (18 endpoints: RFQs, quotes, block-trade proposals, accept/decline) is untouched.
`MAX_NOTCH = 5` (x16) exists because the app cannot move more size than the visible book without
moving the book. RFQ is the venue's answer: negotiate size off-resting. Two consequences: (a) the
size ceiling stops being a hard ceiling for *this* flow, and (b) the incentive programs in S1 are
exactly where counterparties look for size once you are known to be there. Treat as a phase-2 item
after S1/S4 - it needs the reputation and the queue data first.

---

## 9. Suggested sequence

The project's constraint has never been engineering capacity; it is that every experiment costs weeks
of shadow capture. So order the work by information-per-day, not by difficulty.

**Week 1 - corrections, no new strategy.**
D1 (fee rounding), D2 (zero-fee coercion), D6 (portfolio handler), D3 (incentive pagination +
persistence), D5 (fill verb). Then re-run the existing gate corpus. Expect two results: the fade and
mean-reversion nets shift slightly, and some historical rejections become re-scorable.

**Week 2 - free re-analysis of data already on disk.**
S2 step 3 (re-score 4,180 approved signals by fee tier) and S5 (re-score 42,076 lead-lag
dislocations with a net gate). Both are re-runs over captured data, so they cost no calendar time
waiting for markets. This is the week that tells you whether the last three months of capture were
filtered wrongly.

**Week 3 - two endpoints.**
S4 (queue position) and S1 steps 1-3 (incentive join + discount in the fee model). Start recording
`paid_out`.

**Week 4+ - new markets, new models.**
S3 (sub-cent quoting, A/B by cohort), S2's low-fee long-dated universe (`KXBTCY`), S6 (Kalshi weather
truth feeds), S8 (IV fair value), S7 (Polymarket Data-API + rewards).

**Do not do first:** S9, and any new signal source. The evidence in section 4 is that the app's
problem is not a shortage of signals - it generates 42,076 dislocations and 21,290 cross-venue
signals it does not trade. It is cost model, price granularity, and venue economics.

---

## 10. Handoff notes for whoever picks this up

1. **Read `docs/DEVELOPER-HANDBOOK.md` sections 12-16 before writing code.** The evidence doctrine
   there is load-bearing: "a signal is not a trade until the book can pay you", "a 90% win rate is a
   null when the payoff is 1:10", "a backtest on the same data that invented a rule is an
   illustration, not evidence". Nine months of this project's value is those rules and the discipline
   to have followed them. Do not re-litigate them.
2. **The fee model is the product.** `kalshi.ts:1389`, `kalshi.ts:1405-1408`,
   `autoTrader.ts:4894` and `kalshi.ts:963` are the four most important lines in the codebase, and
   three of them are wrong or unused. Fix those before adding anything.
3. **Do not size up because a strategy looks good.** `MAX_NOTCH = 5`, one-sided 80% clustered-t lower
   bound, day-clustered SE, operator hold, cool-down doubling. All of it is correct and all of it is
   bypassable by a tired human at 2am, which is the only realistic failure mode left.
4. **Trust `ladder.json` and the shadow JSONL over any prose**, including this document. The docs
   drift (6.4); the state files do not.
5. **Read source through a UTF-8-correct tool.** A Windows console renders ``, `` and `>=` as junk
   and will tempt you into "fixing" encoding that is already clean (6.3).
6. **`git init` first.** Then make the D1/D2 changes, so the most important fee corrections in the
   project's history are attributable, reviewable and revertible.

---

## Appendix - how the live findings were reproduced

```powershell
# build + tests
npx tsc -p tsconfig.json --noEmit          # rc=0
foreach ($t in 'test:ladder','test:risk','test:remaining','test:completion',
                'test:settlement-accounting','test:adversarial','test:review') { npm run $t }

# fee tiers (14 free, 19 half, of 14,154 series)
Invoke-RestMethod 'https://api.elections.kalshi.com/trade-api/v2/series?limit=1000'   # paginate cursor
#   -> group on fee_multiplier ; group on fee_type

# zero-fee liquidity
'.../markets?series_ticker=KXBTCY&status=open&limit=500'      # 28 open, 125,278 contracts/24h
'.../markets?series_ticker=KXMLBGAME&status=open&limit=500'   # 98 open, 6,635,436 contracts/24h

# sub-cent tick grid
'.../markets?limit=1000'   # -> price_level_structure = center_deci_edge_centi_cent
                          # -> price_ranges: 0.00-0.01 step 0.0001 | 0.01-0.99 step 0.0010

# field presence audit (5,722 open markets)
floor_strike 31.6% | cap_strike 0.3% | fee_waiver_expiration_time 0.0%
mve_collection_ticker 23.4% | price_ranges 100% | price_level_structure 100%

# vendor specs fetched 2026-09-18
https://docs.kalshi.com/getting_started/fee_rounding.md      # ceil_6dp + rebate accumulator
https://docs.kalshi.com/api-reference/portfolio/get-fills.md # book_side == outcome_side
https://docs.kalshi.com/api-reference/incentive-programs/get-incentives.md  # centi-cent units

# live runtime state
%APPDATA%\oracle-trader\{ladder.json, kalshi-auto.json, mini-auto-polymarket-us.json, config.json}
%APPDATA%\oracle-trader\logs\main.log   # 31.9 MB; portfolio:get HttpError; 42,076 dislocations

# encoding audit: 0 invalid UTF-8 files, 0 mojibake markers, 8 files with a BOM
```

