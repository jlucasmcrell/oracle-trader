# Kalshi AutoTrader — build & live-verification status

Built 2026-08-28 (overnight autonomous session). Companion research: `kalshi-shortterm-data.md`, `autotrade-ideas.md`.

## What was built

**Kalshi AutoTrader** — a full autonomous trading pipeline in the app (Kalshi AutoTrader panel):

- **8 signal strategies**, each with its own toggle + thresholds:
  1. `momentum` — 1-min candle point-move over N minutes (point-based, not relative — a 4.5¢→5¢ tick is one cent of info, not 11%).
  2. `volume-spike` — recent tape volume vs 1-hour-candle baseline + aggressive taker-flow direction (uses `taker_outcome_side`/`taker_book_side`).
  3. `book-imbalance` — top-3 bid vs ask dollar depth; requires real depth on **both** sides (kills empty-side ratio explosions).
  4. `cross-venue` — Polymarket Gamma leads Kalshi; one-legged convergence (Polymarket is data-only; no region issue).
  5. `news` — Google News RSS topics matched to markets, keyword polarity.
  6. `dutch` — within-Kalshi arbitrage on `mutually_exclusive` events: buy NO on all legs when Σ(YES bids) > 1 + ε; payoff locked (n−1 or n); live books re-checked at execution; unwinds legs if any fill fails.
  7. `fade` — longshot fade (buy NO at p<0.10). **See calibration below.**
  8. `settlement` — (experimental) live underlying index (`/live_data/events/{ticker}`, verified: 15M candles of the CF Benchmarks series) vs strike, near close.

- **AI vetting layer** (`vetting.ts`): OpenAI-compatible chat-completions gate (OpenAI/DeepSeek/Ollama…), strict-JSON verdict `{approve, direction, confidence, reason}`, 20s timeout, **fails closed** (LLM error ⇒ veto). Rules gate (min score 55) always runs first. No key configured by default ⇒ rules-only.
- **Hard risk gates**: price band, spread ≤ 4¢, min top-of-book liquidity ($150), min volume, per-market uniqueness, max open positions (6), daily cap (20), balance check, no entries within 7 min of close.
- **Automatic exits**: take-profit, stop-loss, pre-close exit (T−5min), max-hold, reversal exit, and hold-to-settlement handling (paper positions settle at resolution via market result; Dutch legs settle per leg).
- **Execution**: V2 orders with `immediate_or_cancel`, limit 1¢ through the spread, unfilled orders cancelled; `ref: auto:<strategy>:<id>` in history; state persists to `kalshi-auto.json` (survives restart; daily counters roll).
- **Paper realism fix**: `PaperBroker` + engine now fill paper buys at the live ask / sells at the live bid (was: mid) — backtests no longer overstate edge by the spread.
- **Adapter additions**: `getRecentTrades`, batch `getCandles` (1/60-min), batch `getOrderBooks`, `searchEvents` (paginated, nested markets, `mutually_exclusive`), `getLiveData`, `spread` + `eventTicker` + `resolution` on mapped markets.
- **Safety model**: dry-run ⇒ nothing; otherwise engine Paper/Live mode; **LIVE requires the separate "Arm LIVE" switch** (plus `dutchLiveEnabled` for multi-leg Dutch). Defaults: enabled=OFF, armed=OFF — the app trades nothing until you turn it on.

## Live verification (scripts/verify-kalshi-auto.mjs, run against real API)

- Universe: 5,810 raw open markets → 36 tradable after filters (binary, horizon, liquidity, spread ≤4¢, volume).
- Snapshot @ 00:50 UTC produced 16 candidates, e.g.:
  - book-imbalance NO @ 100 on `KXHIGHNY-26AUG27-T80` (ratio 0.15)
  - book-imbalance YES @ 100 on `KXETHD-26AUG2817-T2559.99` (ratio 3.2)
  - momentum NO @ 85 on `KXSOLD-...-T106.9999` (−3.5¢ in 10 min)
- Cross-venue fired **nothing** in this snapshot — mapping is genuinely sparse: Gamma's ETH Aug-28 ladder ends at ~$2,000 / 16:00Z while Kalshi's 5pm-EDT ladder runs $2,280–2,640. The strategy is correct but will only fire when strike/time coverage overlaps (mostly up/down 5-min vs 15-min mismatch too). Keep enabled; expect low frequency.
- Dutch: no in-horizon mutually-exclusive events with Σbids>1.03 at snapshot time (2028 election events were correctly filtered by horizon).

## Favorite-longshot calibration (scripts/verify-kalshi-fade.mjs, /historical/markets)

11,988 settled binary markets bucketed by **last traded price** (validated: winners' last prices are pre-close trading prices, not settlement values):

| price | n | empirical P(YES) | implied |
|---|---|---|---|
| 0.02–0.05 | 5,212 | **0.0%** | 3.5% |
| 0.05–0.10 | 2,511 | **0.0%** | 7.5% |
| 0.10–0.20 | 1,842 | 0.5% | 15.0% |
| 0.20–0.35 | 1,273 | 1.4% | 27.5% |
| 0.35–0.50 | 671 | 6.3% | 42.5% |
| 0.50–0.65 | 253 | 22.9% | 57.5% |
| 0.80–0.90 | 45 | 84.4% | 85.0% |
| 0.90–0.95 | 31 | 90.3% | 92.5% |

Strong longshot overpricing: 7,723 markets traded under 10¢ and **zero** resolved YES. Buying NO at ~94–97¢ shows a gross edge of several cents/contract before spread/fee. **Caveats**: the bucket is the *last* traded price (≈ at close), not the entry price at T−1h; realized edge at entry is smaller, spread+time cost eat most of it at the extremes; the sample is dominated by crypto/weather strike ladders. `fade` is therefore **disabled by default** pending an entry-timing backtest on `/historical/*/candlesticks`.

## Not built / next steps

- **WebSocket feed** (auth-required even for public channels; verified 1006 unauth) — converts book/tape signals to real-time; needs `ws` dependency and creds. REST polling is the v1 design.
- **Sports milestones/game-stats** — hard win-prob modeling; deferred.
- **/weather-index returned 404** (does not exist at that path) — settlement-source strategy covers crypto/commodity via `/live_data` instead.
- **Historical backtests with fees/spread** for momentum/volume/book (using `/historical/markets/{ticker}/candlesticks`) and the fade entry-timing study — the calibration pipeline above is the template.
- LLM gate is wired but untested end-to-end (no key configured). Test with a cheap model before relying on it.
