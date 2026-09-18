# Oracle Trader Audit Patch - 2026-09-05

## Purpose

Repair research-accounting defects, reduce quote churn and API pressure, improve live-test throughput, and separate the original convergence test from a safer v2 live rule.

## Changes

### Weather quoter

- Fixed the state-path regex that created `quoter-kalshi.json-fills.jsonl` instead of the canonical `quoter-kalshi-fills.jsonl`.
- Fixed literal `\\n` text being written instead of newline bytes.
- Added an idempotent ledger migration script.
- Merged and deduplicated 33 records into the canonical ledger.
- Added tolerant parsing to `quoter-gate.mjs` and support for either `result` or `resolution` from Kalshi.
- Added a 20-minute eligibility grace period to preserve queue priority through transient book changes.
- Increased the amend deadband from 2 cents to 3 cents.
- Limited new selection to one weather bracket per city/day event.

Current reconstructed weather result after migration:

- 33 fill records / 32.9 contracts
- 28 settled fill records
- 32 settled whole-contract observations
- +7.66 cents per contract
- Event-clustered 95% interval: [-7.79, +23.10] cents
- Two independent days only; not proven

### BTC convergence v2 live rule

- Original 0.10%-0.60% collector and `btc-gate.mjs` remain unchanged.
- Live execution is restricted to the strongest descriptive 0.20%-0.40% band.
- Replaced the universal 97% execution assumption with a point-in-time model using:
  - Recent Coinbase one-minute realized volatility
  - Current strike distance
  - Time remaining
  - 2.5bp Coinbase/BRTI basis reserve
  - Probability shrinkage toward 50%
  - 97% hard cap
- Missing volatility data fails closed.
- New trades record model probability and strategy version.
- One-contract sizing remains unchanged.

### Polymarket US micro-maker

- Increased independent one-contract slots from two to four.
- No increase in per-order size.
- Failed fade and book-imbalance strategies remain disabled.
- Config migrated to version 16.

### API and noisy research load

- Reduced the shared authenticated Kalshi adapter limit from 200 to 120 requests/minute.
- Reduced in-app lead-lag polling from every 15 seconds to every 60 seconds.
- Lead-lag remains shadow-only.
- Fixed literal newline logging in the lead-lag ledger.
- No recent 429, fatal, or persistence errors were observed after restart.

### Hunch collector

- Routes through OpenRouter when `OPENROUTER_API_KEY` is available.
- Fallback chain: Gemini Flash, DeepSeek Pro, GLM Flash.
- Records the model that actually produced each forecast.
- Direct DeepSeek remains available if OpenRouter is unavailable/not configured.

## Verification

- `npx tsc --noEmit`: PASS
- `npm run build`: PASS
- `node --check scripts/migrate-quoter-ledger.mjs`: PASS
- `node --check scripts/quoter-gate.mjs`: PASS
- Oracle Trader restarted and reconciled 53 Kalshi positions.
- Polymarket US migrated to four maker slots.
- Existing venue orders survived restart.
- No recent 429/fatal/persist errors after restart.

## Current evidence

- BTC convergence collector: +1.95 cents/contract, 50 independent events; formal gate not passed.
- BTC 80-95 cent maker collector: +4.30 cents/contract; confidence intervals cross zero.
- Weather canonical ledger: +7.66 cents/contract; only two days.
- Polymarket US maker: one fill, +$0.34; 1.2% fill rate before slot increase.

## Still intentionally not live

- Dutch-book execution
- Lead-lag execution
- Fair-value BTC maker
- Sports book imbalance
- Momentum and volume-spike entries
- Favorite/longshot fades

These remain disabled because their evidence or execution safety is inadequate.
