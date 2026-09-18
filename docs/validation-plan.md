# Validation Plan — Kalshi AutoTrader

**Purpose:** concrete, runnable experiment specs to prove or kill each signal strategy *before* it trades real money. Grounded in the live-verified facts in `autotrader-status.md` and the exact signal math in `src/main/strategies/autoTrader.ts`.

**How to read this doc.** Each experiment is self-contained: hypothesis → exact data pulls (endpoint + params) → the metric that proves/disproves it (with a numeric pass bar) → runtime/API-load estimate → confounds. §1 defines the shared cost model every pass bar is measured against. §2 is the data-availability matrix (what can be backtested vs. what must be forward-tested). §3 is the six experiments. §4 ranks them and says what to run first.

**Constraint honored:** this is a *plan only*. No app source files are modified.

---

## 1. The shared cost model (the hurdle every signal must clear)

Every signal is judged against the same break-even. Two cases:

| Case | Strategies | Cost per contract | Pass bar |
|------|-----------|-------------------|----------|
| **Hold-to-settlement** (no intraday exit) | `fade`, `dutch`, `settlement` | half-spread + 1 taker fee ≈ **2¢** | net edge > 2¢ |
| **Round-trip** (enter + exit before close) | `momentum`, `volume-spike`, `book-imbalance`, `cross-venue` | full spread + 2 taker fees ≈ **4¢** | forward move > 4¢ |

- **Spread** is capped at 4¢ by the `maxSpreadPct=0.04` universe filter, but the *realized* spread on any given fill is `ask − bid` at execution time. Backtests must use the **executable** price (ask for buys, bid for sells), never the mid or `last_price`.
- **Taker fee** is the Kalshi quadratic schedule, read from `fee_type`/`fee_multiplier` on `GET /series/{ticker}`. Use **1¢/contract** as the planning number; the implementing agent should read the actual fee for the series under test and substitute it.
- **The paper broker now fills at ask/bid** (per `autotrader-status.md`), so paper results are already spread-correct — but they still do **not** subtract the taker fee. Any paper P&L must be re-netted by 1¢/contract before it is believed.

**Consequence for pass bars:** a signal whose measured forward move is ≤ 4¢ (round-trip) or ≤ 2¢ (hold-to-settle) is *dead regardless of hit rate* — it cannot clear costs. Hit rate alone is never sufficient; the pass bar is always **net edge in cents/contract after costs**.

---

## 2. Data availability matrix (what can be backtested vs. forward-only)

This is the single most important planning fact. It determines *how* each experiment runs.

| Data | Historical (backtest) | Live (forward) | Implication |
|------|----------------------|----------------|-------------|
| Settled market outcomes (`result`, `last_price`) | ✅ `/historical/markets` | — | fade calibration, Dutch legs |
| 1-min / 60-min candles | ✅ `/historical/markets/{ticker}/candlesticks` | ✅ `/markets/candlesticks` (batch) | momentum, volume baseline, fade entry price, Dutch Σbids(t) |
| Trade tape (taker side, count, price) | ✅ `/historical/trades` | ✅ `/markets/trades` | volume-spike pressure |
| **Order book snapshots** | ❌ **none** | ✅ `/markets/orderbooks` (batch) | **book-imbalance is forward-only** |
| **Settlement index** (CF Benchmarks RTI) | ❌ **none** | ✅ `/live_data/events/{ticker}` | **settlement-convergence is forward-only** |
| `mutually_exclusive` flag | ⚠️ on `/events` (all events, even old) | ✅ `/events` | join by `event_ticker` |
| Polymarket price history | ✅ `clob /prices-history` | ✅ `clob /midpoint` | cross-venue lead-lag |

**Two hard constraints to internalize:**

1. **There is no historical order book.** Kalshi archives candles and trades, but not book snapshots. The book-imbalance strategy *cannot* be backtested; it can only be validated by **forward paper logging** (snapshot the book, then watch the next 5 minutes). This is why §3.4 is a "start logging now" experiment, not a "run a script" experiment.

2. **There is no historical settlement index.** `/live_data/events/{ticker}` returns the *current* CF Benchmarks series (15M candles), but Kalshi does not archive it. The settlement-convergence edge ("the index already moved but the market hasn't") can only be validated **forward**, by logging index + price + strike near close and checking settlement. A historical *proxy* is possible (see §3.5) but it measures a weaker claim.

Everything else (fade, momentum, volume-spike, Dutch frequency) is fully backtestable on `/historical/*`.

---

## 3. The experiments

### 3.1 (a) Fade entry-timing backtest — *does buying NO at T−1h on p<0.10 still pay after spread?*

**Hypothesis.** The calibration (`verify-kalshi-fade.mjs`) showed 0.0% YES resolution on 7,723 markets whose *last* price was < 10¢. But `last_price` is the price *at close*, not the entry price. The real question: if you buy NO at **T−1h** on markets priced < 10¢ *at that time*, does the edge survive the executable spread + fee?

**Data pulls.**
1. `GET /historical/markets?limit=1000&cursor=…` (paginate until exhausted, ~12k markets) → keep `binary` markets with `result ∈ {yes,no}` and `last_price_dollars ∈ (0,1)`. Record `ticker`, `event_ticker`, `result`, `last_price_dollars`, `close_time`.
2. For the subset with `last_price < 0.10` (≈7,700), pull `GET /historical/markets/{ticker}/candlesticks?start_ts={close−65m}&end_ts={close−55m}&period_interval=1` → take the candle whose `end_period_ts` is closest to `close_time − 60m`. Read `yes_bid.close_dollars` (the executable NO-ask is `1 − yes_bid`).
   - *Sampling option:* run the full population only if a 2,000-market sample is positive; a 2,000 sample is enough to bound the YES rate to ±0.5% at 95% confidence.

**Metric (proves/disproves).**
- For each market, `entry_cost = 1 − yes_bid_at_T−1h` (the NO ask), `payoff = 1 if result==no else 0`.
- `net_edge = mean(payoff − entry_cost) − fee` (fee = 1¢).
- **Pass bar:** `net_edge > 0` (ideally > 1¢) across ≥ 1,000 markets, **and** the empirical YES rate in the T−1h p<0.10 bucket is ≤ `(entry_price − 2¢)`.
- **Disprove:** the T−1h bucket's YES rate is materially higher than the close-time bucket (i.e., the "0% YES" was an artifact of measuring at close, when losers had already drifted to 0), or `net_edge ≤ 0` after the executable spread.

**Runtime / API load.** Step 1 ≈ 12 pages ≈ **6 min** (matches the existing fade script). Step 2 ≈ 7,700 requests (or 2,000 sampled) at ~10 req/s ≈ **13 min** (or ~3.5 min sampled). Total **~20 min** full, **~10 min** sampled. This is the heaviest experiment; run it overnight or throttle to 5 req/s.

**Confounds.** (a) The p<0.10 bucket is dominated by crypto/weather strike ladders — the edge may not generalize to politics/sports. Split the result by `series_ticker` prefix. (b) `yes_bid` can be 0 on dead markets (no resting bid) — those are *not executable* and must be excluded, not counted as "cheap NO". (c) Survivorship: `/historical/markets` may omit disputed/amended markets.

---

### 3.2 (b) Momentum + volume-spike hit-rate backtest — *does the signal's forward move clear 4¢?*

**Hypothesis.** The `momentum` (3¢ point move over 10 min) and `volume-spike` (2.5× baseline volume + |taker pressure| > 0.15) signals predict a continuation that exceeds the 4¢ round-trip cost. These are the strategies that are **enabled and firing today** (16 candidates in the live snapshot), so this is the highest-urgency backtest.

**Data pulls.**
1. `GET /historical/markets?limit=1000&cursor=…` → settled binaries with `close_time` and `result`.
2. Sample **500** markets (stratified: crypto, weather, sports, politics). For each, `GET /historical/markets/{ticker}/candlesticks?period_interval=1&start_ts={open}&end_ts={close}` → full 1-min series.
3. For volume-spike only: `GET /historical/trades?ticker={ticker}&min_ts={open}&max_ts={close}&limit=1000&cursor=…` → tape with `taker_outcome_side`, `taker_book_side`, `count_fp`, `is_block_trade`.

**Replay (mirror `autoTrader.ts` exactly).**
- *Momentum:* at each minute `t` with ≥5 prior candles, `move = close(t) − close(t−10m)`. If `|move| ≥ 3¢`, record a signal in `sign(move)`. Forward return = `close(min(t+30m, close)) − close(t)` in the signal direction.
- *Volume-spike:* compute per-minute baseline from the trailing 120 min of 60-min candles; at each minute, `multiple = vol_10m / 10 / perMin`. If `multiple ≥ 2.5` and `|pressure| > 0.15` (pressure from `taker_outcome_side`/`taker_book_side` as in the code), record a signal. Forward return as above.

**Metric (proves/disproves).**
- For each strategy, `mean_forward_move` (in signal direction, cents) and `hit_rate = P(forward_move > 0)`.
- **Pass bar:** `mean_forward_move > 4¢` **and** `hit_rate > 50%` (a strategy can have hit rate 60% but still lose if wins are 1¢ and losses are 5¢ — the *mean* is the binding constraint).
- **Disprove:** `mean_forward_move ≤ 4¢`, or the signal fires *after* the move is already done (forward move ≈ 0), or the signal fires so rarely (< 1/day across the universe) that it's not worth the code.

**Runtime / API load.** 500 candle requests + ~500 tape requests ≈ **1,000 requests ≈ 2–3 min** at 10 req/s. Cheap.

**Confounds.** (a) The momentum signal uses *point* move (not relative) — verify the replay uses the same convention or the result won't match production. (b) The 1-min candle `price` is `{}` when no trades — use `yes_bid/yes_ask` mid as the fallback (as the code does). (c) Forward return must be measured to *close*, not to a fixed 30 min, because the exit is pre-close (T−5min). (d) Volume-spike needs the tape; if `/historical/trades` does not support `ticker` filtering, fall back to candle `volume_fp` only (weaker, no pressure term).

---

### 3.3 (c) Dutch-book frequency + realized arb — *how often does Σbids > 1.03 occur, and does it persist to execution?*

**Hypothesis.** The live snapshot found **zero** in-horizon mutually-exclusive events with Σbids > 1.03. The question is whether that's a *timing* artifact (the arb exists but is rare/short-lived) or a *structural* non-event (Kalshi's mutually-exclusive events are efficiently priced). If the arb never occurs historically, the strategy should be disabled.

**Data pulls.**
1. `GET /historical/markets?limit=1000&cursor=…` → settled binaries, grouped by `event_ticker`.
2. For each `event_ticker` with 2–6 binary legs, fetch the flag: `GET /events?tickers={comma-separated event_tickers}` (batch, ≤200/page) → `mutually_exclusive`. Keep only `mutually_exclusive=true` events.
3. For each qualifying event, `GET /historical/markets/{ticker}/candlesticks?period_interval=1&start_ts={open}&end_ts={close}` for every leg → reconstruct `Σbids(t) = Σ yes_bid_close(t)` over legs at 1-min resolution.

**Metric (proves/disproves).**
- **Frequency:** count events where `Σbids(t) > 1.03` for ≥ 1 minute, and the *duration* of each excursion (minutes it stayed above 1.03). Report `qualifying_events / day` over the historical window.
- **Realized arb:** for each excursion, simulate "buy NO on all legs at the first minute Σbids > 1.03, at the executable NO-ask (`1 − yes_bid`), hold to settlement." Net P&L = `(n−1) − Σ(1 − yes_bid_i)` when exactly one leg resolves YES (the code's own formula), minus n × 1¢ fee.
- **Pass bar:** `qualifying_events/day ≥ 1` **and** realized arb > 0 on ≥ 80% of executions (the arb must *persist* long enough to execute — a 1-minute excursion that vanishes before you can place 2–6 legs is not tradeable).
- **Disprove:** `Σbids > 1.03` occurs < 1×/week, or the excursions are all < 1 minute (unexecutable), or the realized arb is ≤ 0 after fees (the "arb" was inside the spread).

**Runtime / API load.** Step 1 ≈ 6 min. Step 2 ≈ a few batched `/events` calls. Step 3: mutually-exclusive events are a small fraction — estimate 100–500 events × 2–6 legs = **200–3,000 candle requests ≈ 1–5 min**. Total **~15 min**.

**Confounds.** (a) The live strategy *approximates* bid as `prob − spread/2`; the historical test uses the *actual* `yes_bid` from candles — this is a *stricter, more correct* test, and it also quantifies how much the approximation overstates the arb. (b) `mutually_exclusive` events may be non-exhaustive (a "none of the above" outcome with no market) — the `S > 1` direction is still safe (see `autotrade-ideas.md` §3.2), but confirm exhaustiveness from `rules_primary` before trusting the `S < 1` direction. (c) Legs can be added/removed mid-event; the historical reconstruction assumes a fixed leg set.

---

### 3.4 (d) Book-imbalance short-horizon predictive power — *forward-only, start logging now*

**Hypothesis.** Top-3 bid-vs-ask dollar-depth ratio ≥ 1.6 (or ≤ 1/1.6), with ≥ $300 total and ≥ $50 per side, predicts a short-horizon move in the imbalance direction that clears 4¢.

**Why this cannot be backtested.** There is **no historical order book** (§2). The only way to validate it is to log live snapshots and their subsequent returns.

**Data pulls (forward, paper).**
1. Every 30–60 s, `GET /markets/orderbooks?tickers=…` (batch, ≤100) for the current universe (the ~36 tradable markets).
2. For each snapshot, record `bidDepth` (top-3 YES bids × price), `askDepth` (top-3 NO bids → 1−p), `ratio`, and the market's `last_price`.
3. At the next snapshot (or via `GET /markets/candlesticks?period_interval=1`), record the price 5 minutes later.

**Metric (proves/disproves).**
- Condition on `ratio ≥ 1.6` (predict YES) and `ratio ≤ 1/1.6` (predict NO), with the depth filters applied.
- `hit_rate = P(price moves in predicted direction over next 5 min)`, `mean_forward_move` (cents).
- **Pass bar:** `hit_rate > 55%` **and** `mean_forward_move > 4¢`, across ≥ 500 conditioned observations.
- **Disprove:** hit rate ≈ 50%, or the move is smaller than the spread (the imbalance is already priced in), or the signal is dominated by spoofed walls that vanish before they fill.

**Runtime / API load.** Forward, **1–2 weeks** of logging. API load is trivial: 1 batch orderbook call + 1 batch candle call per minute ≈ 2 req/min ≈ 2,880 req/day — well within Basic tier.

**Confounds.** (a) Spoofing: a wall that disappears before it's hit is a fake signal — log whether the wall *persisted* across 2 consecutive snapshots and condition on persistence. (b) The orderbook returns *bids only* (NO bid ≡ YES ask), so "imbalance" is a proxy; the code already handles this. (c) REST polling at 30–60 s may be too slow for a signal that decays in seconds — this experiment also measures *how fast* the edge decays, which tells you whether the WebSocket upgrade is required.

---

### 3.5 (e) Settlement-convergence edge — *forward-only (index not archived), with a historical proxy*

**Hypothesis.** Near close, the market price lags the observable settlement index (CF Benchmarks RTI via `/live_data/events/{ticker}`). When the index is already > 2% past the strike but the market is still priced < 0.93 (or the mirror case), buying the index-implied side yields a near-riskless edge.

**Why this cannot be fully backtested.** The settlement index is **not archived** (§2). Two validation paths:

**Path 1 — forward (authoritative).**
1. For each strike market with `close_time − now ≤ 30 min` (the `settleMaxMinutesToClose` window), `GET /live_data/events/{event_ticker}` → `latest` index value + `staleMinutes`.
2. Parse the strike from the question (the code's `parseStrike`), compute `distPct = |latest − strike| / strike`.
3. When `distPct ≥ 2%` and the market price is on the wrong side (index above strike but p < 0.93, or below but p > 0.07), log the signal.
4. At settlement, record whether the market resolved in the index-implied direction.

**Metric (proves/disproves).**
- `correct_rate = P(market resolves in the index-implied direction | signal fired)`.
- `mean_edge = mean(1 − entry_price)` for correct calls (the payoff of buying the near-certain side).
- **Pass bar:** `correct_rate > 90%` **and** `mean_edge > 2¢` (hold-to-settle hurdle), across ≥ 100 signals.
- **Disprove:** `correct_rate ≤ 90%` (the index can still reverse in the final minutes, or the settlement source differs from the index you read), or the "mispriced" markets are systematically the ones that reverse.

**Path 2 — historical proxy (weaker, but free and immediate).**
- Pull `/historical/markets` for settled strike markets. For each, the *settlement value* is the index at the strike time. Reconstruct the market price at T−30min from `/historical/markets/{ticker}/candlesticks`.
- **This measures a weaker claim:** "does the market price at T−30min already equal the settlement value?" (i.e., is the market *already converged* 30 min out?). It does **not** measure "does the index lead the price," because you don't have the index at T−30min.
- **Pass bar (proxy):** the *distribution* of `|price(T−30min) − settlement_value|` — if a meaningful fraction of markets are still > 5¢ from settlement at T−30min, there is *room* for the index-leads-price edge; if they're all already converged, the edge is already arbitraged away. This is a *screening* test, not a proof.

**Runtime / API load.** Forward: 2–4 weeks, but markets close in ≤ 30 min so **hundreds of observations in a few days**; API load ≈ 1 live_data + 1 market call per scan for ≤ 6 markets ≈ trivial. Proxy: ~6 min (markets) + ~500 candle requests ≈ **~10 min**.

**Confounds.** (a) `staleMinutes` must be < 20 (the code's own filter) or the index is too old to trust. (b) The settlement source may be a *different* index than `/live_data` returns (e.g. a specific 60-second average) — read `rules_primary`/`settlement_sources` before trusting the signal. (c) `can_close_early=true` markets close the instant the condition is met — you must be in *before* the condition, so the signal must fire on the *margin*, not after the index has already crossed.

---

### 3.6 (f) Cross-venue lead-lag + overlap discovery — *first prove overlap exists at all*

**Hypothesis.** (1) There exist Kalshi↔Polymarket event pairs with overlapping strike/time; (2) for those, Polymarket reprices first and Kalshi converges to it. The live snapshot found **zero** overlap (Gamma's ETH ladder ends at $2,000/16:00Z vs Kalshi's $2,280–2,640/21:00Z), so the *first* question is whether overlap exists at all.

**Data pulls.**
1. **Overlap discovery (the gating step).** Enumerate Kalshi short-term markets (`GET /markets?status=open&max_close_ts=…`) and Polymarket markets (`GET gamma /markets?active=true&closed=false&order=endDate&ascending=true`). For each Kalshi market, run the code's own matcher (`assetOf` + Jaccard ≥ 0.3 + close-time within 35 min) and record whether a Polymarket counterpart exists. Report **coverage = fraction of Kalshi markets with a match**, and *why* the misses fail (strike mismatch, time mismatch, no asset match).
2. **Lead-lag (only if coverage > 0).** For each matched pair, `GET clob /prices-history?market={poly_token}&interval=max&fidelity=60` and `GET /historical/markets/{kalshi_ticker}/candlesticks?period_interval=1` (or live batch candles). Align the two series on timestamps and compute the cross-correlation at lags −30…+30 min.

**Metric (proves/disproves).**
- **Coverage pass bar:** ≥ 5% of Kalshi short-term markets have a Polymarket counterpart. Below that, cross-venue is not a viable strategy and should be disabled (it will fire ~never, as the snapshot showed).
- **Lead-lag pass bar:** the peak cross-correlation occurs at a *positive* lag (Polymarket leads), and the Kalshi leg converges to Polymarket's price within the horizon in > 60% of pairs, with a net edge > 4¢ after the round-trip cost.
- **Disprove:** coverage ≈ 0 (structural strike/time mismatch), or no consistent lead, or the gap is explained by fees/spread.

**Runtime / API load.** Step 1: a few `/markets` + `/markets` (Gamma) calls ≈ **minutes**. Step 2: 1 prices-history + 1 candle call per matched pair ≈ **trivial** (there will be few pairs). Total **~10 min**.

**Confounds.** (a) The matcher's `assetOf` only recognizes a fixed asset list — a market about "Fed rate decision" won't match; the coverage number is a *lower bound* on true overlap. (b) Polymarket `outcomePrices` can be stale; use the CLOB midpoint, not Gamma's cached price. (c) Different settlement sources mean a "gap" may be *real* and never close — the lead-lag test must confirm convergence, not just correlation.

---

## 4. Priority ranking — what to run first, and why

Ranked by **(decisiveness × speed × value-at-risk)** — i.e., which experiment most quickly prevents a real-money mistake or unlocks a real edge.

| Rank | Experiment | Why this order |
|------|-----------|----------------|
| **1** | **3.1 Fade entry-timing** | The calibration already measured a *huge* signal (0% YES on 7,723 markets < 10¢). It is the single most promising edge in the whole system, it is **fully backtestable today**, and it directly decides whether to flip `fadeEnabled` from OFF to ON. Highest value, no forward wait, ~20 min of API time. |
| **2** | **3.2 Momentum + volume-spike hit-rate** | These are the strategies **enabled and firing right now** (16 candidates in the live snapshot). If their forward move is ≤ 4¢, the bot is currently trading a losing signal. Validating them is the highest *risk-reduction* action. Fully historical, ~3 min. |
| **3** | **3.3 Dutch frequency** | Cheap (~15 min) and decisive: if Σbids > 1.03 never occurs historically, `dutch` is dead code and should be disabled (it fired nothing live). If it *does* occur, this also calibrates how long the arb persists (the execution-feasibility question). |
| **4** | **3.6 Cross-venue overlap discovery** | The live snapshot strongly suggests coverage ≈ 0. This is a ~10-min check that either kills the strategy or finds the few pairs worth the lead-lag test. Run it in parallel with #1–#3 since it's independent and cheap. |
| **5** | **3.4 Book-imbalance (forward logging)** | Cannot be backtested (no historical book). It must be *started now* and left to accumulate for 1–2 weeks. Low urgency to *interpret*, high urgency to *begin logging* — kick it off in the background while #1–#4 run. |
| **6** | **3.5 Settlement-convergence (forward)** | Highest *potential* edge (deterministic convergence to an observable source) but forward-only and the most setup. Start the forward logger after #1–#4, and run the historical *proxy* (Path 2) immediately since it's ~10 min and screens whether there's any room for the edge at all. |

**Recommended execution order in one sentence:** run **#1 and #2 tonight** (they decide the two highest-stakes questions — is the fade real, and are the live strategies losing money), run **#3 and #4 in parallel** (cheap kill/keep decisions), and **start #5 and #6 logging immediately** so the forward-only experiments are accumulating data while the backtests finish.

---

## 5. Cross-cutting rules for every experiment

1. **Use executable prices, never mid/last.** Every backtest fills at the ask (buy) / bid (sell). The paper broker already does this; the historical scripts must too.
2. **Subtract the taker fee.** Read `fee_type`/`fee_multiplier` from `GET /series/{ticker}`; use 1¢/contract as the planning default.
3. **Exclude non-executable observations.** A market with no resting bid/ask at entry time is not a trade — it's a data point to drop, not a "cheap" fill.
4. **Split by series/category.** The fade and momentum edges may be concentrated in crypto/weather strike ladders; report per-category, not just the aggregate.
5. **Report n and confidence, not just the mean.** A 3¢ edge on n=30 is noise; a 3¢ edge on n=2,000 is real. Every pass bar is conditional on a minimum sample size.
6. **Throttle to ≤ 10 req/s** (Basic tier is 200 tokens/s ≈ 20 req/s; leave headroom). No `Retry-After` on 429 — use exponential backoff.
