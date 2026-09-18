> **Out of date.** This README describes the original August 2026 scaffold. The current, complete developer
> handbook (architecture, operations, strategy record, rules, known defects) is
> [docs/DEVELOPER-HANDBOOK.md](docs/DEVELOPER-HANDBOOK.md). Start there.

# Oracle Trader

A desktop auto-trader for prediction markets. Manifold-first, with a swappable
multi-venue adapter layer, a paper-trading simulator, event scanning, and
high-earner copy-trading.

> **Status:** early scaffold — the Manifold adapter, paper broker, scanner, and
> copy-trader are wired end to end. Polymarket and Kalshi adapters are next.

## Why a desktop app?

Prediction markets are **not** HFT: markets resolve over days/months and order
flow is modest. Strategy quality and risk management dominate raw speed, so a
desktop app is entirely sufficient (and keeps keys/funds local).

## Architecture

```
src/
  shared/        framework-agnostic domain types + the VenueAdapter contract + IPC surface
  main/          Electron main process (Node): the trading engine lives here
    venues/      one adapter per venue (manifold.ts, then polymarket/kalshi)
    engine/      TradingEngine + PaperBroker (simulated fills on live prices)
    strategies/  Scanner (discovery) + CopyTrader (mirror top users)
    store/       ConfigStore (persists settings; encrypts API keys)
  preload/       contextBridge -> window.api
  renderer/      React UI (dashboard, scanner, copy-trader, activity log)
```

### Key design decisions

- **Swappable venues** — everything (engine, strategies, UI) talks to the
  `VenueAdapter` interface in `src/shared/venue.ts`. Add a market by implementing
  it and registering in `src/main/venues/registry.ts`.
- **Execution mode toggle** — `paper` (default) simulates every fill against
  live prices with zero risk; `live` sends real orders. Manifold is play money
  (M$), so even "live" there is zero real-money risk.
- **Copy-trading is possible on Manifold** because other users' positions and
  bet history are public API endpoints (no auth).

## Getting started

```bash
pnpm install
pnpm smoke:manifold   # verify live Manifold connectivity (no key needed)
pnpm dev              # launch the desktop app in dev mode
```

### Trading live on Manifold (optional, play money)

1. Create a key at manifold.markets → your profile → edit → refresh API key.
2. The app reads it from `config.json` in the Electron `userData` directory
   (encrypted via `safeStorage`). A settings UI for this is coming.

## Roadmap

- [x] Electron + TypeScript + React scaffold
- [x] `VenueAdapter` contract + registry
- [x] Manifold adapter (search, market, price, account, positions, orders, social)
- [x] Paper broker + paper/live toggle
- [x] Event scanner (search + "what's hot")
- [x] High-earner copy-trader (mirror recent master bets)
- [x] Buy YES / Buy NO + sell/close position controls
- [x] Venue switcher (multi-venue UI)
- [x] Polymarket adapter (Gamma + CLOB market data, paper trading)
- [x] Copy-trader: leaderboard discovery + sizing + take-profit/stop-loss + mirror exits + auto-poll
- [x] Kalshi adapter (market data + paper trading)
- [x] Scanner: sort (liquidity/volume/probability/ending-soon/newest) + category filter
- [x] Paper trade history + performance stats + backtesting (Polymarket price history)
- [x] Research & vetting: news scanning (Google News RSS) + cross-venue consensus + arbitrage candidates
- [x] Settings UI (Manifold API key + Kalshi credentials + risk limits)
- [x] Scanner polish: series grouping, price correctness, close times, signal score
- [x] Unrealized P&L on positions (mark-to-market) + backtest max drawdown
- [ ] Live trading auth (Polymarket API-key trading — blocked on Polymarket region/API status)
- [ ] AI verdict layer (question + news -> likelihood; needs an LLM key)
