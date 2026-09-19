# Oracle Trader

A desktop auto-trader for prediction markets, run for real money at small size by one operator, with every
strategy decision written down before and after it was made. Electron + React + TypeScript.

**Venues**
- **Kalshi** - live, the only funded venue with strategies trading (about $60 of cash, $1 per position).
- **Polymarket US** - live account funded, every arm on operator hold; an eight-account paper lab runs against
  live books.
- **IBKR / ForecastEx** - funded, no arm qualifies for live; a 23-arm paper lab runs against the live gateway.

Nothing here is investment advice, and most of the record is of things that did not work.

## Where to start

| Want | Read |
|---|---|
| Architecture, operations, rules, known defects | [docs/DEVELOPER-HANDBOOK.md](docs/DEVELOPER-HANDBOOK.md) |
| What changed and why, in order (numbered rounds) | [docs/REVIEW-CHANGES-2026-09-06.md](docs/REVIEW-CHANGES-2026-09-06.md) |
| What is deferred, each with a checkable trigger | [docs/BACKLOG.md](docs/BACKLOG.md) |
| What won, what lost, what changed between | [docs/reports/TRADE-HISTORY-2026-09-18-what-won-what-lost.md](docs/reports/TRADE-HISTORY-2026-09-18-what-won-what-lost.md) |
| The research program (shadows, recorders, reads) | [docs/RESEARCH-PROGRAM-2026-09-18.md](docs/RESEARCH-PROGRAM-2026-09-18.md) |
| Pre-registered strategy tests | `docs/PREREGISTERED-*.md` |
| Daily reports | `docs/reports/YYYY-MM-DD.md` |

## Layout

```
src/main/            Electron main: engine, venue adapters, strategies, IPC
  engine/            order routing, paper ledgers, position cap, portfolio snapshots
  venues/            kalshi, polymarketUs, ibkr (TWS API), forecastexData
  strategies/        autoTrader (Kalshi arms), leadLag, polyPaper (lab), ibkrLab, ibkrSignals
src/renderer/        React UI: one account layout per venue (paper view / real account)
src/shared/          IPC contract and shared types
scripts/             recorders (weather-books, sports-books), sentinel, backups, backtests (GET-only)
scripts/tests/       node test suites (`npm test`, 18 suites, ~10 s)
docs/                the record; nothing is deleted, corrections are appended
```

Runtime state (balances, fills, ledgers, credentials) lives in `%APPDATA%/oracle-trader` and is not in this
repository. `data/` and `tmp/` are ignored.

## Build and run

```
pnpm install
npm run typecheck
npm test
npm run build
npm start
```

Credentials are entered in the app and stored encrypted with Electron `safeStorage`; no key is read from the
environment or from this tree.

## Conventions worth knowing before reviewing

- Every strategy change is a numbered round in `docs/REVIEW-CHANGES-2026-09-06.md` with the evidence that
  motivated it and the read that will judge it. A pre-registration precedes each new arm.
- Results are judged on settled markets from venue records, after fees, never on the in-app ledger alone.
- Ad-hoc scripts against venues are GET-only. Orders are placed only by the engine.
- Sizes, loss limits, venue funding and the live/hold switches belong to the operator; the assistant that
  maintains the code decides everything else and reports it.

## For reviewers

Reports that help most name a file and line, state the concrete failure (inputs, state, wrong output or lost
money), and say what evidence would settle it. The trade history and the pre-registrations are the ground
truth for "is this strategy working"; the handbook's known-defects section lists what is already known.

MIT licensed. See [LICENSE](LICENSE).
