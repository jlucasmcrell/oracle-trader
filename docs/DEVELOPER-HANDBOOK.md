# Oracle Trader — Developer Handbook

Written 2026-09-15 for anyone, human or AI, who has to pick this project up cold. It describes the system as it
is on that date: the code, the machine it runs on, the money it trades, the evidence rules it trades under, what
is running, what is measuring, what is dead and why, and how to change anything without breaking it.

Where this document and the code disagree, the code wins; fix this document. Where this document and a dated
doc disagree about *history*, the dated doc wins (see [§18 Document map](#18-document-map)).

---

## Contents

1. [Read this first](#1-read-this-first)
2. [What the project is](#2-what-the-project-is)
3. [State of play on 2026-09-15](#3-state-of-play-on-2026-09-15)
4. [Rules of engagement](#4-rules-of-engagement)
5. [Machine, toolchain and paths](#5-machine-toolchain-and-paths)
6. [Build, test, restart, verify: the change protocol](#6-build-test-restart-verify-the-change-protocol)
7. [Architecture](#7-architecture)
8. [Venues and venue facts](#8-venues-and-venue-facts)
9. [The Kalshi AutoTrader core](#9-the-kalshi-autotrader-core)
10. [Sub-engines and satellites](#10-sub-engines-and-satellites)
11. [The ladder](#11-the-ladder)
12. [Evidence doctrine](#12-evidence-doctrine)
13. [Strategy record](#13-strategy-record)
14. [Pre-registered experiments and the dated queue](#14-pre-registered-experiments-and-the-dated-queue)
15. [Operations](#15-operations)
16. [Known defects, risks and sharp edges](#16-known-defects-risks-and-sharp-edges)
17. [History in one page](#17-history-in-one-page)
18. [Document map](#18-document-map)
19. [Continuing with an AI assistant](#19-continuing-with-an-ai-assistant)
20. [Glossary](#20-glossary)
- [Appendix A: source file map](#appendix-a-source-file-map)
- [Appendix B: log prefixes worth grepping](#appendix-b-log-prefixes-worth-grepping)

---

## 1. Read this first

Ten facts that cost real money or days of work when someone did not know them.

1. **This trades real money, unattended, 24 hours a day.** Kalshi and Polymarket US are real-dollar accounts.
   The app starts itself at Windows logon and places orders without a human. Any change you ship is live on
   the next restart.
2. **There is no git.** `G:\PROJECTS\oracle-trader` is not a repository. History lives in zip backups
   (`G:\PROJECTS\oracle-trader-backups\`, made by `python scripts/backup.py <label>`), in `*.bak_*` files beside
   sources, and in the change log `docs/REVIEW-CHANGES-2026-09-06.md`. Back up before you touch anything.
3. **The venue ledger is the truth; the app's own P&L counters are not.** Settlements pulled from Kalshi and
   netted with the formula in [§12](#12-evidence-doctrine) are the only P&L number anyone should quote. The naive
   `revenue − cost` formula once reported −$31.56 for a night that was +$0.72.
4. **Win rate means nothing here.** A 90c favourite wins 90% of the time and still loses money after fees.
   Everything is judged in net cents per contract after fees, with day-clustered confidence bands.
5. **Correlated bets are one bet.** Seven crypto coins swept the same direction in one 15-minute window is one
   bet on crypto direction taken seven times. It tripped the daily kill switch on 2026-09-13.
6. **Money decisions reserved to the operator are not yours.** Deposits, subscriptions, API keys, the global
   live arm, `amountPerTrade`, loss limits, `ladderMode`, the shard top-up cap and operator holds belong to the operator.
   See [§4](#4-rules-of-engagement).
7. **Never write a script that places, cancels or amends an order.** Ad-hoc scripts are GET-only. The app is the
   only thing that trades.
8. **Restarting is not the same as being restarted.** After a build, verify the Electron process start time is
   later than the bundle's write time before believing your change is live ([§6](#6-build-test-restart-verify-the-change-protocol)).
9. **Pre-registered experiments must not be read early.** Graders refuse before their read date on purpose.
   Reading early, or changing a rule after seeing data, voids the experiment.
10. **Windows Update restarts this machine.** Twice so far (2026-09-09 and 2026-09-15) it took everything down for
    about five hours. Everything restarts at logon; data in that gap is gone.

---

## 2. What the project is

**Oracle Trader** is an Electron + React + TypeScript desktop application that auto-trades binary prediction
markets. Owner and operator: the operator.

| Venue | Money | Role today |
|---|---|---|
| Kalshi | Real USD | Primary venue. Every live strategy trades here. |
| Polymarket US | Real USD | Account funded; every arm is on operator hold. |
| Manifold | Play money (mana) | Testbed for the smaller `MiniAuto` trader. |
| Interactive Brokers / ForecastEx | Independent Oracle paper lab on live Gateway quotes; funded-live route available | 23 automated paper strategy arms, individual balances, realistic fills/fees/exits, published settlement, scorecard and evidence-gated live activation. Account/order tools, engine journal and fill reconciliation remain available. See [IBKR lab report](IBKR-PAPER-LAB-2026-09-16.md) and REVIEW-CHANGES §103. |
| Polymarket.com (global) | — | Not available to US persons. Used only as a read-only price signal (Gamma API, CLOB book, wallet data). |

**The operating model, in the operator's standing rules** (the maintenance prompt carries them verbatim):

- Every strategy is tested with **real money at micro size**, scaled when its checkpoint shows **net profit after
  fees**, stopped by its stop rule, and retried after a cool-down. Nothing stays off without a verdict.
- Judge by net profit after fees, never by win rate. A small net win is a win.
- **Free tiers only** until the app is profitable. The one paid exception is The Odds API (20,000 credits/month).
- Everything is automated and reports must reach the operator: a daily headless maintenance session, a 15-minute defect
  sentinel, on-call repair sessions and a nightly LLM review ([§15](#15-operations)).
- the operator has delegated routine engineering decisions. A question from the operator is a request for an assessment, not an
  instruction to change something. Decisions he reserved are listed in [§4](#4-rules-of-engagement).

**Updated profitability assessment, 2026-09-15 07:29 UTC.** Cross-venue **lead-lag** has the strongest historical
earnings, but recent concentrated losses make its profitability regime-dependent. Kalshi is only +$3.08
after fees since the September 6 redesign, and Polymarket US is -$20.86 after excluding deposits and credits.
The favourite-longshot **fade** earns small amounts. Sustainable profitability remains unproven. See the
[repair and viability review](G:/PROJECTS/oracle-trader/docs/reports/ORACLE-TRADER-VIABILITY-REVIEW-2026-09-15.md)
for reconciled results, streaks, implementation repairs deployed at 07:50 UTC, and proposed improvements.
The older account snapshot below retains its original timestamp.

---

## 3. State of play on 2026-09-15

Snapshot taken 06:30–06:45 UTC from read-only venue dumps, `ladder.json` and `main.log`.

### 3.1 Accounts

| Venue | Cash | Open positions | Equity |
|---|---|---|---|
| Kalshi | $87.63 | $24.01 at market ($25.34 at cost) | **$111.64** |
| Polymarket US | $39.85 | none | $39.85 |
| Manifold | 699.88 mana | — | play money |

Kalshi venue-true net, from `python scripts/venue-pnl.py tmp/k-2026-09-15.json`:

| Window | Settlements | Net after fees | Fees paid |
|---|---|---|---|
| Lifetime | 978 | **−$37.68** | $64.11 |
| Since the strategy redesign (2026-09-06 21:00 UTC) | 791 | **+$5.21** | $59.79 |

Recent days, by UTC settlement day (venue-true):

| Day | All Kalshi | Lead-lag |
|---|---|---|
| 09-12 | +$33.39 | +$36.21 |
| 09-13 | −$22.87 | −$15.09 (kill switch tripped) |
| 09-14 | −$3.69 | +$1.86 |
| 09-15 to 06:30 | −$18.09 | −$18.40 |

The daily kill switch trips at a venue-day loss of 20% of equity, about **$22.33** at today's equity.

### 3.2 What trades with money right now

From the ladder snapshot (`%APPDATA%\oracle-trader\ladder.json`, last run 06:39 UTC):

| Strategy (ladder id) | Stage | Size | Evidence since stage start |
|---|---|---|---|
| `kalshi-leadlag` | **live** | notch 4 (8 contracts per sweep on BTC/ETH; 2 on the other five coins) | 182 settled, +$14.80; next checkpoint at 200 |
| `kalshi-fade` | tiny-live | notch 1 | 120-trade checkpoint net +$2.59; scale-up held because its 5-min markout band is wholly negative |
| `kalshi-consensus` | tiny-live | notch 1 | 13 settled, −$1.92 (grading restarted at the round-97 fix, see §10.5) |
| `kalshi-mean-reversion` | tiny-live | notch 1 | 5 settled, −$3.49 |
| `kalshi-volume-spike` | tiny-live | notch 1 | 14 settled, −$1.10 (one prior demotion) |
| `kalshi-sports-anchor` | tiny-live | notch 1 | 2 settled, −$0.22 (one prior demotion) |
| `kalshi-news` | tiny-live | notch 1 | 1 settled, −$0.11 |
| `kalshi-cross-venue` | tiny-live | notch 1 | 0 settled |
| `kalshi-dutch` | tiny-live | notch 1 | 0 settled |
| `convergence` | tiny-live | 1 contract | 1 settled, +$0.05 |

Disabled by evidence, waiting on cool-down: `kalshi-momentum` (to 2026-09-27, two stops), `kalshi-book-imbalance`
(to 2026-09-25, two stops). Operator holds (the operator switched them off in the panel; automation never lifts these):
`quoter`, `settlement`, `polyus-micro-maker`, `polyus-fade`, `polyus-book-imbalance`, `polyus-weather-fair`,
`kalshi-flow-follow`, `kalshi-weather-morning`.

### 3.3 What is measuring without money

| Instrument | Question | Read date |
|---|---|---|
| Spot-first shadow (`scripts/spot-shadow.mjs`) | Does Coinbase spot lead Kalshi 15M books by more than fees? | 2026-09-21 |
| Momentum log-odds recorder (`momentumCandidates.ts`) | Does a log-odds move bar beat the flat 3c bar? | 2026-09-21 |
| Lead-lag coin cohort (`scripts/leadlag-coins.mjs`) | Do SOL/XRP/DOGE/BNB/HYPE earn like BTC/ETH? | ≥5 day-clusters; default narrow on 2026-10-04 |
| Lead-lag cadence shadow (`scripts/leadlag-cadence-gate.mjs`) | Does a 10-second first entry beat the former 60-second cadence on the same markets? | 2026-09-21 and ≥300 paired settlements across ≥5 days |
| Consensus arm (live, micro) | Does the Polymarket smart-money shadow's +6.4c survive our fills? | ≥40 settled; deadline 2026-10-13 |
| LLM hunch + challenger | Do LLM forecasts beat the market mid? | challenger paired read 2026-09-18 |
| Cull gate (`scripts/cull-gate.mjs`) | Does the anti-flood cap cost or protect money? | 2026-09-19 |
| Mention shadow | Base rates vs mention-market prices | ≥100 graded, about 2026-09-25 |
| Market-making simulator (`scripts/mmsim.mjs`) | Would a two-sided maker make money after adverse selection? | 2026-10-17 23:04 UTC |
| Metaculus, HRRR, crypto15, ladder15, BTC collector | See [§15.3](#153-recorders-and-shadows) | various |

### 3.4 Things that were wrong this morning

- The Windows Update outage (01:29–06:20 UTC) stopped trading and collection for about five hours.
- **Duplicate recorders since the 06:20 reboot**: two copies each of `crypto15-shadow.mjs`, `ladder15-shadow.mjs`
  and `mmsim.mjs` are running and writing duplicate rows ([§16](#16-known-defects-risks-and-sharp-edges), item 1).
- The consensus arm's hold-to-settlement rule was missing from code; fixed in round 97 at 06:37 UTC.

---

### 3.5 Paper labs (added 2026-09-16/17)

Two paper-only labs run inside the app on real quotes with independent $1,000 accounts per arm: the Polymarket US
lab (8 arms, `src/main/strategies/polyPaper.ts`, state `poly-paper.json`) and the IBKR ForecastEx lab (23 arms,
`src/main/strategies/ibkrLab.ts` and `ibkrSignals.ts`, state `ibkr-lab.json`, needs IB Gateway running on port 4001).
Settlement hypotheses hold to the exchange result; quote-dynamics arms use timed exits measured from the fill-time
mark. Neither lab promotes anything to live on its own. Rules, costs and history: `docs/IBKR-PAPER-LAB-2026-09-16.md`,
`docs/POLYMARKET-PAPER-REASSESSMENT-2026-09-16.md`, `docs/reports/2026-09-17-strategy-testing-fixes.md`.

## 4. Rules of engagement

These bind every session, human or AI. They come from the operator and are carried in `docs/MAINTENANCE-PROMPT.md` and
`docs/REPAIR-PROMPT.md`.

### 4.1 Never

- Print, copy, move or log API keys, private keys or tokens, including their encrypted `enc:` form. Keys are
  entered by the operator in the app's Settings panel and stored encrypted.
- Paste raw environment listings. The Windows user environment holds credentials.
- Place, cancel or amend an order from a script or by hand. The app is the only order path. Ad-hoc scripts are
  GET-only (`scripts/readonly-kalshi-dump.cjs`, `scripts/readonly-polyus-dump.cjs`).
- Change `liveArmed`, the execution mode (paper/live), `amountPerTrade`, any loss limit (`maxDailyLossPct`,
  `maxDailyLossDollars`), `ladderMode`, the shard top-up cap, or any **operator hold**.
- Change a ladder stage or notch by hand. The ladder decides.
- Re-arm momentum or lift any cool-down early.
- Read a pre-registered experiment before its read date, or change its rule after data exists without a dated
  amendment in its `PREREGISTERED-*.md` file.
- Scrape the operator's logged-in Kalshi web session. Use the API.
- Trade Polymarket global. It is signal-only for a US person.
- Add paid services (other than The Odds API) or create new scheduled tasks or Claude sessions from a maintenance
  or repair session.

### 4.2 Reserved to the operator

Deposits and withdrawals; subscriptions and credit top-ups (OpenRouter, The Odds API); keys; the global live arm;
sizes and loss limits; operator holds; Windows Update active hours. Say so once when one is actually due; do not
nag. Examples currently open: a deposit to $250 would earn Kalshi's 3.25–4% APY on the whole portfolio
(backlog 82); OpenRouter credit runs down at roughly $25/day ([§16](#16-known-defects-risks-and-sharp-edges)).

### 4.3 Always

- Prove a defect before fixing it: read the implementation, cite lines, reproduce from evidence.
- Smallest diff, one behavioural change per change set, a test that fails without the fix.
- Back up, test, typecheck, build, take the lock, restart, verify in `main.log`, record it
  ([§6](#6-build-test-restart-verify-the-change-protocol)).
- Put every deferred item in `docs/BACKLOG.md` with a **checkable trigger** (a date and/or a data condition). The operator's
  words: expecting him to remember things guarantees they never get done.
- Report outcomes plainly, including failures.

---

## 5. Machine, toolchain and paths

### 5.1 The machine

One Windows 11 Pro desktop (hostname <machine>), time zone **Eastern**. Windows Task Scheduler times are local;
every log timestamp, venue day, kill-switch day and read date is **UTC**.

| Tool | Version |
|---|---|
| Node.js | 24.11.0 |
| pnpm / npm | 10.32.1 / 11.6.1 |
| Electron | 33.4.11 |
| electron-vite | 3.1.0 |
| TypeScript | 5.9.3 |
| React | 18.3.1 |
| ws | 8.21.3 |
| tsx | 4.23.13 |
| Python | 3.13 (miniconda3, `C:\Users\<you>\miniconda3\python.exe`) |
| duckdb / pyarrow (Python) | 1.5.5 / 25.0.1 |
| Claude Code CLI | `%APPDATA%\npm\claude.cmd` (used by the headless maintenance and repair runners) |

Runtime dependencies of the app are only `react`, `react-dom` and `ws`. There is no test framework: tests are
hand-rolled assertion files run with `tsx`.

### 5.2 Paths

| Path | What |
|---|---|
| `G:\PROJECTS\oracle-trader` | Repository (no git). `src/`, `scripts/`, `docs/`, `data/`, `tmp/`, `out/` (build output), `logs/` (maintenance/repair logs). |
| `%APPDATA%\oracle-trader` = `C:\Users\<you>\AppData\Roaming\oracle-trader` | Electron userData: config, all trader state, ledgers, episodes, reviews, `logs\main.log`. |
| `G:\PROJECTS\oracle-trader-backups` | Zip backups from `scripts/backup.py` (about 19 GB). |
| `G:\DATA\prediction-market-analysis\data\kalshi` | Becker historical archive (parquet) used by `scripts/backtests/*.py`. |
| `G:\DATA\becker\data` | A second extraction of the same archive (84 GB with the tarball); same Kalshi market set. |
| `C:\Users\<you>\.claude\projects\F--\memory\oracle-trader-project.md` | The AI assistant's long-running project memory (about 250 KB, newest entries at the bottom). |

### 5.3 Key files in app data

| File | Owner | Contents |
|---|---|---|
| `config.json` | `src/main/store/config.ts` | Execution mode, venue credentials (each secret encrypted with Electron `safeStorage`, `enc:` prefix), paper balances, global risk limits. |
| `kalshi-auto.json` | `AutoTrader` | The Kalshi trader's full config (about 150 keys, `configVersion` 25) and state: open trades, pending orders, calibration and veto ledgers, per-strategy perf, venue day. LLM and data-provider keys also live in this config. |
| `ladder.json` | `Ladder` | Stage, notch, history, demotions, cool-downs, operator holds per strategy. |
| `history.json` | `HistoryStore` | Shared fill history, capped at 5,000 rows. |
| `leadlag.json`, `leadlag-dislocations.jsonl` | `LeadLagEngine` | Counters and every recorded dislocation and executed sweep (the ladder's lead-lag evidence). |
| `crypto-convergence.json`, `dutch-book.json`, `quoter-kalshi*.json*` | Sub-engines | State and sidecar logs. |
| `mini-auto-manifold.json`, `mini-auto-polymarket-us.json` (+ `-research.jsonl`) | `MiniAuto` | The small trader's state and Polymarket US research log. |
| `fill-reconciler-*.json` | `FillReconciler` | Venue fill cursor per venue. |
| `episodes\kalshi-<date>.jsonl` | `EpisodeRecorder` | Books, entries, exits, rests, amends, scan timings, anchors (about 65 MB/day). |
| `reviews\<date>.md` / `.json` | `NightlyReview` | Nightly LLM review. |
| `hunches\`, `hunches-challenger\` | `hunch.ts` | LLM forecast ledgers. |
| `intelligence\decisions.jsonl` | Intelligence engine | Pre-trade critic verdicts (shadow). |
| `momentum-candidates\`, `mmsim\`, `universe-culled\` | Recorders | Pre-registered measurement data. |
| `anchor-grades.jsonl` | `AutoTrader` | Sports sharp-anchor grades. |
| `logs\main.log` | `index.ts` | The app log; primary source for liveness and defect detection. |

---

## 6. Build, test, restart, verify: the change protocol

### 6.1 Commands

```bash
pnpm install
npm run typecheck                                  # tsc --noEmit
npm run build                                      # electron-vite build -> out/
npx tsx scripts/tests/review-fixes.test.ts         # broadest suite (475 assertions on 2026-09-15)
npx tsx scripts/tests/ladder.test.ts               # ladder decisions (126)
npx tsx scripts/tests/adversarial.test.ts          # stateful scenarios with fake adapters (89)
python scripts/backup.py <label>                   # zip repo + userData to G:\PROJECTS\oracle-trader-backups
```

`npm run dev` runs electron-vite in dev mode, but production runs the built bundle through the
`OracleTrader-App` scheduled task (`node_modules\electron\dist\electron.exe .`). `Start Oracle Trader.bat`
builds and launches the same binary by hand. A single-instance lock in `src/main/index.ts` refuses a second copy,
because two instances would share state files and could place duplicate orders.

### 6.2 The protocol every change follows

1. **Prove it.** Read the code, cite lines, reproduce the defect from `main.log`, state files or a read-only dump.
2. **Back up**: `python scripts/backup.py round<N>-pre`. A "lockfile permission denied" skip in its output is
   normal.
3. **Patch.** Past rounds used a small Python patch script with exact anchors: CRLF-aware, and asserting each
   anchor matches exactly once. Some sources are LF, some CRLF; preserve what you find.
4. **Test that the test bites.** Add assertions to `scripts/tests/review-fixes.test.ts` (or the right suite), run
   them green, then remove the fix in a scratch copy (or temporarily in place, restoring byte-identically) and show
   the new assertion fails.
5. **Run all three suites, typecheck and build.** Save suite output to `tmp/testout/<suite>-<round>.txt` *before*
   reading it; a flake that was not captured is a regression that was not seen.
6. **Take the lock**: write `data/sentinel/agent.lock`. The maintenance and repair runners honour it; an
   interactive session must take it by hand so the sentinel does not start a repair mid-change.
7. **Restart**: stop the Electron processes, then `Start-ScheduledTask -TaskName OracleTrader-App`.
8. **Verify it is live**: the earliest Electron process `StartTime` must be later than `out\main\index.js`
   `LastWriteTime`. Then find the behaviour in `main.log`: the relevant log prefix after the restart timestamp, and
   no new errors.
9. **Release the lock.**
10. **Record**: a `## §N` section in `docs/REVIEW-CHANGES-2026-09-06.md`, a line in `docs/BACKLOG.md`, a dated
    amendment in the matching `PREREGISTERED-*.md` if a registered arm is affected, and a note in the assistant
    memory file if something non-obvious was learned.

### 6.3 Reviewing large changes

Changes to money paths (sizing, caps, order placement, exits) have been reviewed adversarially: independent
reviewers look for defects, a separate refuter tries to disprove each finding, a runtime harness with a mocked
`globalThis.fetch` and fake adapter exercises the real engine, and then a from-scratch re-review reads the
corrected code. Round 91 needed three passes. Each pass found something real, including a duplicate-order race
and a check-then-act race past a spend cap.

---

## 7. Architecture

### 7.1 Process model

A single Electron main process owns everything that trades. The renderer is a React control panel that talks to
it over IPC. Long-running measurement lives *outside* the app as separate Node and Python processes
([§15](#15-operations)).

Boot sequence (`src/main/index.ts`, inside `app.whenReady()`):

1. Single-instance lock (at module load).
2. `installSafeLogging()` redirects `console.*` to `userData\logs\main.log`.
3. `ConfigStore` loads `config.json` and decrypts secrets.
4. `setCullDir()` and `setMomentumCandidateDir()` point the observation recorders at userData.
5. `HistoryStore` opens `history.json`.
6. `VenueRegistry` registers the Manifold, Polymarket US and Kalshi adapters.
7. `TradingEngine` is constructed and `engine.init()` initialises every adapter (a `PaperBroker` per venue).
8. Execution mode and risk limits are applied from config.
9. `AutoTrader` (Kalshi) is constructed on `kalshi-auto.json` and started, which starts its timers ([§9.1](#91-the-scan-loop)).
10. Two `MiniAuto` instances start (Manifold and Polymarket US).
11. `FillReconciler`s start: Kalshi at 40 s then every 5 min; Polymarket US at 70 s then every 5 min.
12. `Ladder` runs at 2 min, then hourly.
13. `NightlyReview` checks at 10 min, then hourly; it runs once per UTC day after 06:00 UTC.
14. IPC handlers register (about 32 channels) and the window opens.

### 7.2 The order path and its gates

Every strategy and sub-engine places orders through `TradingEngine.placeOrder` / `sellPosition`. Sub-engines get
a *routed adapter* from `TradingEngine.routedAdapter()` so their orders pass the same risk checks and land in the
same history. Before that routing existed, four engines called adapters directly and were invisible to the
ledger.

For a real order to reach Kalshi, all of these must hold:

| Gate | Where | Owner |
|---|---|---|
| Engine execution mode is `live` | `engine.ts`; switching is refused while positions or orders are held | the operator |
| `liveArmed` on the trader | `AutoTrader.executeSignal`, `MiniAuto` | the operator |
| `dryRun` is false | same | the operator |
| Strategy-level live flag on (e.g. `leadLagLiveEnabled`, `consensusEnabled`) | trader config, set by the ladder | Ladder |
| Not blocked by `entryBlocked()` (kill switch, caps, stale venue ledger, etc.) | [§9.4](#94-entry-gating) | Code |
| Per-venue stake cap and open-position cap | `TradingEngine.placeOrder` | the operator (risk limits) |

The live open-position count is cached for three seconds inside the existing per-venue entry queue. Each accepted
fill or resting order increments the cached count before the next queued order; a submission error invalidates it.
This preserves the cap while avoiding positions plus open-orders GETs before every order in one strategy burst.

In paper mode the engine walks the live order book for a depth-aware VWAP fill (`paperBuyPlan` /
`paperSellPlan`) and `PaperBroker` persists per-venue paper balances.

### 7.3 Persistence

`src/main/store/json.ts` (`JsonStore`) is the atomic JSON primitive: write to `.tmp`, rename, and quarantine a
corrupt file to `<path>.corrupt-<ts>` instead of overwriting it with defaults. Most engines use the same
tmp-and-rename pattern. **Exceptions that write in place** (a crash mid-write can truncate them): `config.json`
(`store/config.ts`), the nightly review files, and two hunch state files. JSONL ledgers are append-only.

Config decryption failures deliberately keep the ciphertext instead of blanking the field. Blanking was once
persisted by the next save and destroyed a credential.

### 7.4 IPC and UI

Channels are declared in `src/shared/ipc.ts` (`IPC` const) and exposed through `src/preload/index.ts`. Groups:
engine (state, mode, manual order, sell), markets (search, order book), portfolio, autoTrader (config, scan,
status, reset, test vet), autoMini (the same for MiniAuto, plus order preview), history, categories, backtest,
research, settings (keys, demo toggle, risk limits, paper reset), quant (ladder and review status), scanner, and
a main-to-renderer event channel.

Panels (`src/renderer/src`): `App.tsx` (shell, paper/live toggle, manual orders, portfolio, activity log),
`AutoTraderPanel.tsx` (Kalshi trader config and the **live arm**, behind a confirm dialog), `MiniAutoPanel.tsx`
(the same for the mini traders), `QuantPanel.tsx` (ladder and nightly review), `ResearchPanel.tsx`,
`BacktestPanel.tsx`, `SettingsPanel.tsx` (credentials and risk limits).

---

## 8. Venues and venue facts

### 8.1 Kalshi (`src/main/venues/kalshi.ts`, `kalshiWs.ts`)

- **Auth**: RSA-PSS SHA-256 over `timestamp + METHOD + path` (query string excluded), headers
  `KALSHI-ACCESS-KEY/-TIMESTAMP/-SIGNATURE`, minted per attempt so retries never reuse a stale signature. Separate
  demo and production credentials; demo host is `external-api.demo.kalshi.co`.
- **Rate limit**: 120 requests/minute in `HttpClient`. Public market data needs no auth
  (`https://api.elections.kalshi.com/trade-api/v2`).
- **Prices**: dollar strings (`yes_bid_dollars`); sizes are fixed-point strings (`_fp`). **Orders are priced on the
  YES leg** even for NO orders. Getting this wrong made NO entries that never filled and exits that swept the book
  (fixed 2026-08-28).
- **Taker fee**: `ceil(7 × P × (1 − P))` cents per contract (0.07 × series multiplier × C × P × (1−P), rounded up).
  Maker fee applies only on maker-fee series, coefficient 0.0175. Both are implemented in code
  (`kalshiOrderFeeCents` in `autoTrader.ts`, `kalshiTakerFeeCents` in `leadLag.ts`).
- **Shards**: Kalshi runs several matching-engine shards (`exchange_index`). Collateral is held **per shard**; an
  order on an unfunded shard is rejected even when the aggregate balance covers it. Weather markets settle on
  shard 0. Order groups (circuit breakers) are per shard. Cancel and amend must be routed to the order's shard.
- **Settlement netting**: a settlement record lists every contract ever bought on each side. Contracts netted
  before settlement (YES bought back via NO) were paid $1 per pair at netting time and do not appear in `revenue`.
  Use the formula in [§12](#12-evidence-doctrine).
- **Universe fetch**: `/markets` is not ordered by close time, so the adapter pages per close-time window (up to 25
  pages). The anti-flood "top-3-per-series" cap discards tail strikes; `cullRecorder.ts` records what was dropped.
  Thursday evening to Friday evening the 48–72 h window hits the 25-page bound (backlog 71 watches it).
- **15-minute crypto series** (`KX<COIN>15M`, coins BTC ETH SOL XRP DOGE BNB HYPE; NEAR exists but has no
  Polymarket twin): one up/down market per 15-minute window. It resolves YES if the 60-second simple average of the
  CF Benchmarks real-time index before close is at least the 60-second average before the window opened
  (`floor_strike`). Hourly/daily ladders (`KXBTCD` etc.) close at 14:00 and 21:00 UTC.
- **Weather** (`KXHIGH*`, `KXLOW*`): settles on station readings, not a metro blend. The ticker suffix does not
  encode direction; parse `strike_type`, `floor_strike`, `cap_strike`.
- **Websocket** (`kalshiWs.ts`): `orderbook_delta` channel, **shadow only**. Books are maintained and compared
  against REST, but nothing trades from them yet (`getBook()` has no caller outside the file). It subscribes to the
  first **50** tickers of the universe. It resubscribes when ≥30% of the universe changes and ≥5 min have passed
  ("universe drift" in the logs, counted as reconnects; not flakiness). A sequence gap forces a full re-snapshot. A
  25 s missing-heartbeat timeout cycles the socket. The NO-price convention is voted from ≥10 REST comparisons
  (9/10 majority) before the socket is trusted.
- **Programmes**: public `GET /incentive_programs` lists liquidity-incentive programmes. All require 300–1,000
  contracts resting on *both* sides; not reachable at current equity (backlog 78, closed). Kalshi pays 3.25–4% APY on
  the portfolio above a $250 balance.
- **Maintenance**: Kalshi has a weekly exchange pause; the trader holds entries while `exchangePausedNow()` is true.

### 8.2 Polymarket US (`src/main/venues/polymarketUs.ts`)

- **Auth**: Ed25519 over `timestamp + METHOD + path`, headers `X-PM-Access-Key/-Timestamp/-Signature`. The private key
  is a base64 32-byte seed wrapped in a PKCS8 DER prefix. Public data host `gateway.polymarket.us`; trading host
  `api.polymarket.us`.
- **Prices are always the YES-leg price** regardless of order side, a repeatedly bitten convention. Tick is 0.001.
- **Fees**: taker fee (about 6% coefficient); makers receive a rebate. The micro-maker test found one rebate in 457
  fills, so the rebate thesis failed in practice.
- **Close times**: `endDate` is not the trading close for sports (median 55 days after the game); the adapter
  derives close from `gameStartTime` heuristics (`deriveUsCloseTime`). `outcomePrices` drops nulls; read
  `marketSides[].long`.
- **Activities feed** (fills and settlements) must be paged at about 700 ms per page; unpaced bursts caused 5 h 50 min
  of 429s on 2026-09-12.
- **Orders**: market orders are IOC with synchronous execution (blocks up to 10 s); maker orders are post-only,
  GTC or GTD. Cancel requires a non-empty body. A fresh maker order id can be unreadable for up to 5 minutes.

### 8.3 Manifold (`src/main/venues/manifold.ts`)

Play money (mana is not cashable since 2025-03-28). Static `Authorization: Key` header, 450 requests/minute. AMM,
so there is no order book. Multiple-choice bets need `answerId`; `limitProb` is 0.01–0.99 in whole-percent steps.

### 8.4 Polymarket.com global (signal only)

- `src/main/venues/polymarket.ts` (`PolymarketAdapter`) is **not registered** as a venue and cannot trade. It is still
  used by `AutoTrader` for Gamma API data in the cross-venue arm.
- **Gamma API** (`gamma-api.polymarket.com`): `outcomePrices` lag by minutes. Comparing Kalshi to Gamma produced
  16,373 false dislocations and a 1,716-attempt sweep storm on 2026-09-03. Use the CLOB book. **Closed markets are
  hidden from `?slug=` queries unless `closed=true` is passed.**
- **CLOB** (`clob.polymarket.com/book?token_id=`) is the live price. The public market websocket is
  `wss://ws-subscriptions-clob.polymarket.com/ws/market`.
- 15-minute up/down slugs are `<coin>-updown-15m-<window start epoch seconds>`. They resolve on the **Chainlink
  60-second TWAP** stream, a different index from Kalshi's CF Benchmarks average. The two venues disagree on about
  **2.1–2.4%** of matched windows, always with the index within about a basis point of the strike
  ([§10.1](#101-lead-lag-srcmainstrategiesleadlagts)).
- Matching engines are reported to be in London (Polymarket) and Ohio, AWS us-east-2 (Kalshi). This came from outside
  research and has not been measured from this machine.

### 8.5 External data sources in use

| Source | Used by | Tier |
|---|---|---|
| Coinbase Advanced Trade websocket + REST candles | `liveSpot.ts`, convergence, spot shadow, BTC collector | Free, no auth |
| NWS `api.weather.gov` | weather forecast fair value, hunch rain markets | Free |
| Open-Meteo (HRRR, NBM, ensemble) | `hrrr-shadow.mjs`, BTC collector | Free |
| The Odds API | sports sharp-anchor | **Paid**, 20,000 credits/month |
| SportsGameOdds | supplemental sports anchor (shadow) | Free, 2,400 objects/month |
| Google News RSS, GDELT, Fed/BLS/SEC RSS | `news.ts` | Free |
| Gemini (OpenAI-compatible endpoint) | hunch, critic, nightly review (first choice) | Free tier |
| OpenRouter | challenger, paid critic fallback, nightly review | Paid credit |
| Bright Data (Reddit) | external evidence for the critic | Budgeted 4,000 records/month |
| Metaculus | `metaculus-shadow.cjs` (token in panel config) | Free |
| Fed press-conference PDFs, YouTube auto-captions (`yt-dlp`) | `mention_shadow.py` | Free |

Provider keys for Gemini, OpenRouter, The Odds API, SportsGameOdds and Bright Data are read from the AutoTrader
config (entered in the panel) or the Windows user environment. `grep -rn "process.env" src/main` shows the exact
reads; do not dump the environment to find them.

---

## 9. The Kalshi AutoTrader core

`src/main/strategies/autoTrader.ts` (about 4,950 lines) runs the Kalshi pipeline: build a universe, compute signals,
gate, execute, manage exits and settlement, and drive four sub-engines on their own timers.

### 9.1 The scan loop

`tick()` is re-entrancy guarded and records 11 phase marks. `phaseDurations()` turns them into per-phase
milliseconds, written as a `scan` row to the episodes ledger (`{ms, phases, scanned, candidates, approved,
executed}`). A console summary prints only when a scan exceeds 150 s or every 20th scan.

| Phase | Work |
|---|---|
| vetoes | `gradeVetoes()` resolves due counterfactual watch rows |
| pending | `managePendingOrders()` reconciles resting maker orders, amends fades, cancels orders of switched-off strategies |
| orphans | `orphanSweep()` (live, every 5 min) cancels untracked `ot-` orders, alerts on untracked positions |
| exits | `manageExits()` |
| universe | `buildUniverse()` |
| data | `gatherData()`: candles, order books, trades, headlines, index data, weather reads, portfolio |
| sports | sharp-anchor polls (read-only, failures never break the scan) |
| signals | `computeSignals()` |
| gate | deterministic gates and score threshold; optional LLM final gate when `vetMode === 'llm'` |
| review | intelligence engine shadow/veto pass (only when not in LLM vet mode) |
| execute | `executeSignal()` per approved signal |

Measured scans take **108–315 s** against a 30 s poll. The time goes to fetching (data, universe, exits), not to
LLM stages. Execution therefore acts on books that can be minutes old, which is why lead-lag runs on its own
10-second timer.

**Timers** (`restartTimer()`): scan every `max(10, pollIntervalSeconds)` s (default 30); reconcile and venue-day
refresh every 5 min; quoter 60 s; Dutch 60 s; convergence 30 s; **lead-lag every 10 s** (floor 5 s); hunch pass at
90 s then every 8 h; book lab every 60 s (runs even when the trader is disabled). A one-time log of Kalshi incentive
programmes runs at 60 s.

### 9.2 Universe and data

`buildUniverse()` pulls up to 1,000 open markets ending soonest within the horizon, then layers four slices with
separate budgets so thin-book strategies are not starved: the volume-ranked main slice, extra fade-band markets
sorted by soonest close, temperature ladders (up to 8 per event, 6 events), and sports markets (7-day window,
liquidity-ranked top 30 plus the other side of each matchup). In-play sports markets are excluded from the
momentum, volume-spike and book-imbalance calm set.

### 9.3 Signal generators

| Key | Flag | Entry rule (short) | Entry | Exit |
|---|---|---|---|---|
| `fade` | `fadeEnabled` | Longshot NO band; calibrated EV edge ≥ `fadeMinEdgeCents` net of fee at a padded bound (`calibratedYesRate`); category filter | maker (resting, amended each scan) | hold to settlement |
| `momentum` | `momentumEnabled` (off) | ≥3c move over the window, ≥3 traded candles, direction held | taker | hold |
| `mean-reversion` | `meanReversionEnabled` | `meanReversionVerdict()`: ≥ min move, horizon within bounds (≤24 h), minimum entry price | maker in live config | hold |
| `weather-morning` | `weatherMorningEnabled` (hold) | `morningForecastVerdict()`: NWS fair value vs book in the station-local morning | taker | hold |
| `consensus` | `consensusEnabled` | Polymarket smart-money signal, priced at Kalshi ask, `consensusRefusal()` gates | taker | hold (since round 97) |
| `volume-spike` | `volumeSpikeEnabled` | recent volume ≥ multiple × baseline with directional taker pressure | maker | TP/SL/pre-close/max-hold |
| `book-imbalance` | `bookEnabled` (off) | top-3 depth ratio; gated by the book lab's pass bar | maker | TP/SL |
| `cross-venue` | `crossVenueEnabled` | Gamma probability gap vs Kalshi with title similarity | maker | TP/SL |
| `news` | `newsEnabled` | headline/market similarity with keyword polarity | maker | TP/SL |
| `dutch` | `dutchEnabled` / `dutchLiveEnabled` | Σ YES bids over a mutually exclusive, exhaustive event > 1 + margin | multi-leg IOC, unwinds partials | hold |
| `settlement` | `settleEnabled` / `settleLiveEnabled` (hold) | live index vs strike margin; weather ratchet (retired) | taker | hold |
| `sports-anchor` | `sportsAnchorLiveEnabled` | sharp-book devigged fair value gap ≥ 3c vs Kalshi mid | maker | TP/SL |
| `flow-follow` | `flowFollowEnabled` (hold) | `flowVerdict()`: large or one-sided taker prints in 15 min | maker | TP/SL |

Which strategies hold to settlement is decided by the exported pure function `holdsToSettlement()`: dutch,
settlement, momentum, mean-reversion, weather-morning, consensus, and fade unless `fadeExitEnabled`. Everything else
uses take-profit 5% / stop-loss 10% / pre-close / max-hold / reversal from config.

### 9.4 Entry gating

`passesGates()` checks too-close-to-close, price band and the book lab, then `entryBlocked()` returns the first
reason in this order:

1. stop-entry engaged
2. exchange trading paused
3. venue ledger stale (no settlement refresh for 45 min, live)
4. awaiting venue reconcile (live, before the first clean orphan sweep)
5. kill switch
6. weather seat guard (generic arms may not trade weather ladders)
7. churn guard: re-entry lockout, per-market cap (2/day), momentum one entry per market per day
8. max open positions (live config 60)
9. unsettled backlog too large
10. daily trade cap
11. market already open / order already resting
12. event already exposed / resting
13. underlying full (`maxPerUnderlying`, live 8)
14. long-horizon slots full: markets closing more than 24 h out share `maxLongHorizonPositions` (4); the consensus arm
    gets `consensusExtraLongSlots` (2) more via `longHorizonCapFor()`
15. stake below $1 / insufficient balance
16. shard unfunded

Every call goes through `entryBlockedWatched()`. Capacity vetoes (keys from `capacityKey()`) with a two-sided book are
enrolled in `calib.vetoWatch` and graded after close into `calib.vetoesByReason`, so the cost of each cap is measured
in cents. Capacity rows and LLM/category rows have separate ceilings (60 and 120).

### 9.5 Sizing

`stakeFor()`: `min(amountPerTrade × strategySizeMult[strategy], maxBalancePct% × equity)`. Equity is cash plus
positions, so deploying capital does not shrink later bets. Live values: `amountPerTrade` 1, `maxBalancePct` 25. The
ladder writes `strategySizeMult` (its notch). Contract counts are derived from stake ÷ leg cost. Lead-lag is sized in
contracts instead ([§10.1](#101-lead-lag-srcmainstrategiesleadlagts)).

### 9.6 Exits and settlement

`manageExits()` quotes every open trade each pass, which records the last side mid, a 5-minute markout and a
pre-settlement freeze (CLV). Trades that hold to settlement, or are past close plus a 30-minute grace, skip exit
rules. `trySettle()` books only an explicit `yes`/`no` resolution. A pinned quote (0 or 1) triggers an early probe,
at most once per 10 min per trade, because cached close times go stale for sports and esports. Dutch waits for every
leg. A live trade is dropped as stale only 3 h past close *and* after the venue confirms it is not held.
`closeTrade()` sells only that trade's own shares, escalating the cross 1c per retry up to 5c.

`recordExit()` updates `perf`, `perfByStrategy` (with CLV and markout sums), `dailyPnl`, and on a full close the
calibration ledger via `gradeEntry()`.

### 9.7 Risk controls

- **Kill switch** (`killSwitchCheck`): trips when the day's realized loss ≤ −`maxDailyLossPct`% (20) × equity. The
  day's loss is the **worse** of the local `dailyPnl` and `venueDay`, which is refreshed from venue settlements and
  includes sub-engines that never touch `dailyPnl`. Once tripped it is **sticky for the UTC day**, persisted, and
  halts every engine (sub-engines check `subEngineKilled()`). Entries resume automatically on the next UTC day. The
  doc comment on `maxDailyLossPct` in `src/shared/ipc.ts` says it drops the live arm; the code does not.
- `stopEntry` halts entries and keeps managing exits. `dryRun` halts everything, including exits.
- A stale venue ledger (>45 min) fails entries closed.
- Orphan sweep alerts on positions the ledger does not know about and never auto-manages them.
- Alerts go to the webhook configured in the AutoTrader panel (`alertWebhookUrl`; Discord or ntfy-style).

### 9.8 Config versions

The constructor migrates `kalshi-auto.json` through numbered blocks (v2 to v26), each gated on
`persisted.configVersion < N`, with a one-line reason in code. Live file: `configVersion` 25. The v26 block (mean-
reversion 24 h ceiling; `maxOpenPositions` floor 18) never persists its version, so it re-runs on every boot
([§16](#16-known-defects-risks-and-sharp-edges)).

### 9.9 Exported pure helpers (what tests import)

`phaseDurations`, `holdsToSettlement`, `longHorizonCapFor`, `capacityKey`, `calibratedYesRate`, `entryFeeDollars`,
`netCentsOf`, `dayKeyOf`, `clusterDayOf`, `clusteredNet`, `kalshiOrderFeeCents`, `ratchetEntryBlock`,
`ratchetVerdict`, `ratchetBracketVerdict`, `strikeOf`, `parseStrike`, `meanReversionVerdict`,
`morningForecastVerdict`, and the `RATCHET_*` constants.

---

## 10. Sub-engines and satellites

### 10.1 Lead-lag (`src/main/strategies/leadLag.ts`)

The only consistent earner. Polymarket's 15-minute up/down book reprices first; Kalshi's ask on the same window stays
stale for seconds; sweep Kalshi when the gap clears the fee.

**Mechanics per 10-second poll, all seven coins concurrently** (`Promise.allSettled`, each pair in its own try/catch
so one bad response cannot abort the batch or release the running guard):

1. Window start = `floor(now / 900 000) × 900` (epoch seconds). Pairs from `leadLagPairs(epoch)`:
   `<coin>-updown-15m-<epoch>` ↔ `KX<COIN>15M`, matched to the Kalshi market whose `close_time` equals window end.
2. Resolve the Polymarket up-token once per window (`SlugTokenCache`), read the CLOB `/book`.
3. `polyBookTradeable()`: only a real CLOB book (never the midpoint fallback) with both sides and spread ≤
   `leadLagMaxSpreadCents` (5). Poly mid must be inside (0.05, 0.95).
4. Read Kalshi quotes (public REST list per series).
5. Dislocation: `poly mid − Kalshi YES ask ≥ 4c` → buy YES at the ask; `Kalshi YES bid − poly mid ≥ 4c` → buy NO at
   1 − bid. `netCents = gap − ceil(7P(1−P))`. `worthNoting()` throttles *logging* to once a minute per
   (ticker, action); sweeps are not throttled.
6. `sweep()`: IOC at the price, `ref: 'leadlag'`.

**Caps** (all in `leadLagCfg()` in `autoTrader.ts`, clamped by hard ceilings 24 contracts and $120):

| Cap | Live value | Why |
|---|---|---|
| Contracts per sweep, proven coins (BTC, ETH) | 8 (ladder notch 4 × 2) | ladder-sized |
| Contracts per sweep, new coins (SOL XRP DOGE BNB HYPE) | 2 (`leadLagNewCoinContracts`) | unproven coins at micro size (round 93) |
| Contracts per ticker per window | 3 × that coin's sweep size | a frozen dislocation could otherwise be re-swept hundreds of times |
| Spend per window, all tickers | $15 (`leadLagMaxSpendPerWindow`) | correlated windows are one bet (round 94) |
| Coins per direction per window | 2 (`leadLagMaxCoinsPerDirectionPerWindow`) | 2026-09-13: six coins, one direction, −$20.94 |
| Poll interval | 10 s (`leadLagPollIntervalMs`, floor 5 s) | round 91 |

**Reserve before await.** `adjustWindow()` debits the full requested contracts and spend *before* awaiting
`placeOrder`, releases on throw, and reconciles to the actual fill (`filled × avgPrice`) afterwards. A zero-fill IOC
increments `sweepsNoFill`, is not counted as executed, and frees its direction seat. Without this, seven concurrent
pairs each read the untouched total and one review run placed seven orders past a $6 cap.

**Evidence.** Executed rows in `leadlag-dislocations.jsonl` carry `filledContracts` and `underlying`. The ladder counts
only rows with `filledContracts > 0` and, for pooled evidence, only proven coins (`leadLagRowCounts()` in `ladder.ts`).
New coins are judged by `docs/PREREGISTERED-leadlag-coins.md` with `scripts/leadlag-coins.mjs`. Positions hold to
settlement; there is no exit logic.

`leadlag-cadence-shadow.jsonl` is a signal-only paired experiment: every clearing 10-second observation is recorded,
and one scan per UTC minute is marked for the 60-second arm. `scripts/leadlag-cadence-gate.mjs` compares their first
entries on the same settled markets under `docs/PREREGISTERED-leadlag-cadence.md`; outcome reads are locked until
2026-09-21. It places no orders and does not alter the live cadence.

**What we know about its money** (09-14 to 09-15 reads, `data/leadlag-basis/`):

- About two thirds of recent matched-window losses sat in the roughly 2% of windows where Kalshi and Polymarket settled
  differently. That divergence is decided by where the index lands, so it cannot be known at fill time.
- Fills 2–5 minutes before close have been the consistent earners in both reads; which other cell loses has moved
  between reads, so no time or distance gate is supported yet (weekly reading, backlog 86).
- BTC at ladder size lost $33.51 between 09-14 and 09-15 on a coin-flip held-side win rate. Size meets variance there.

**Stale comment**: the file's header still calls itself a shadow recorder with live trading off. It is live.

**Queued next**: read the Kalshi quote from the websocket when fresher than 2 s with REST fallback (backlog 61; the
websocket must pin the seven 15M tickers into its 50-ticker set), then a Polymarket socket trigger (62).

### 10.2 BTC convergence (`cryptoConvergence.ts`)

At T−5 minutes before an hourly crypto strike closes (window 4.25–5.75 min), buy the side spot already favours when a
shrunk normal model (1-minute Coinbase realized vol, 2.5 bp basis reserve, capped at 0.97) clears fee plus 1c. Spot from
`liveSpot.ts` when ≤5 s old, else Coinbase REST. One filled position per event, 1 contract. State
`crypto-convergence.json` (58 trades, 9 W / 1 L settled, −27c). Pre-registered in `PREREGISTERED-btc-convergence.md`;
`scripts/btc-gate.mjs` read FAIL / not yet at 194 of 200 events on 09-14.

### 10.3 Dutch book (`dutchBook.ts`)

Recorder engine. Scans mutually exclusive Kalshi events with 3–6 legs, requires an exhaustive "Other/None" leg, and
flags basket arbitrage net of per-leg fees (buy-all-YES if Σ asks < 0.98 − edge; buy-all-NO if Σ bids > 1.02 + edge).
The engine instance hard-codes `dutchLiveEnabled: false`; live Dutch trading runs through the main pipeline's `dutch`
signal under the ladder. 152 opportunities found, 0 baskets executed. Executable arbitrage has not appeared at size
(backlog 70), and the ladder-implication version of the question was closed at 0 of 137,379 pairs after fees (backlog 76).

### 10.4 Weather quoter (`quoter.ts`) — operator hold

Rested one post-only contract 1c inside thin temperature-bracket books on fee-free series. It lost money: 653 maker
fills at −2.6c average, informed flow late in the day while the running extreme forms. Its defences (ratchet gate on the
banked extreme, index requirement, station-local blackout windows, flow gate, fill attribution by order id, failed-
cancel tracking, shard-0 collateral check, loss-lock guard) and its shadow meter still run and are well documented in
the file. Blocked cohort −4.13c (the gates refuse losers); allowed cohort 23 fills, CI lower −17.6c.

### 10.5 Polymarket smart-money consensus (`consensus.ts` + `scripts/polymarket_consensus.py`)

The hourly Python shadow polls top Polymarket wallets. When at least 3 top wallets buy the same outcome within 48 h, it
appends a signal with the matched Kalshi market to `data/polymarket-consensus/signals.jsonl`. The app's
`ConsensusFeed` re-reads the file on size or mtime change and keeps the newest row per Kalshi market.
`consensusRefusal()` applies the pre-registered rule: age ≤24 h, 6 h ≤ time to close ≤ 21 days (`too-far`, round 96),
Kalshi ask 10–90c, and no more than 10c drift past the Polymarket price. Entry is taker at the ask; one entry per market
and per Polymarket source market; **hold to settlement**.

History that matters: until round 97 (2026-09-15 06:37 UTC) the arm was missing from the hold-to-settle list, so default
take-profit/stop-loss sold nine positions minutes after entry. Only positions entered on the round-97 bundle count toward
its 40-contract judgment; the −$8 hard money stop counts everything (see the amendment in
`PREREGISTERED-polymarket-consensus.md`). Shadow evidence: +6.39c per contract at the Kalshi ask, 95% band
[+3.14, +10.19], 692 rows over 7 days.

### 10.6 Momentum candidate recorder (`momentumCandidates.ts`)

Observation only. Logs every momentum-candidate window regardless of whether it clears the live flat 3c bar, sharing
`midOf` with the live arm so the two cannot drift. It records log-odds move, whether the mid held, and capacity facts
(`priorEntriesToday`, `minutesSinceExit`, `eventExposed`). Floor 1c; one row per (ticker, slot) unless the move grows;
40,000 rows/day cap; it writes first and marks after, so failed writes retry. Hourly `[momentum-rec]` health line.
Graded by `scripts/momentum-candidates-gate.mjs`, which refuses `--verdict` before 2026-09-21 00:00 UTC.

### 10.7 MiniAuto (`miniAuto.ts`) — Polymarket US and Manifold

A smaller trader, one instance per venue, with its own `CONFIG_VERSION` migrations (20). Strategies: fade, micro-maker
(Polymarket US only, one-contract two-sided post-only quotes assigned by a stable hash), weather-fair (Polymarket US),
book-imbalance. Sizing `min(amountPerTrade, maxBalancePct% × equity)` (10% on Polymarket US). Polymarket US has a
$10 daily loss brake. Fades hold to settlement on Polymarket US and exit on Manifold (creator-resolved markets).
A zombie guard only drops a position as delisted when the whole venue is confirmed serving a fresh catalog. Research
log `mini-auto-polymarket-us.json-research.jsonl` is the ladder's evidence. **All Polymarket US arms are on operator
hold**: fade lost $0.48 over 45 settled (structural: no longshot population), micro-maker lost $1.67 over 97, book-
imbalance 0 for 30 (−$7.10).

### 10.8 Sports anchors (`sportsAnchor.ts`, `sportsGameOdds.ts`)

Devig sharp sportsbook lines (Pinnacle weighted 3, low-vig books 2) from The Odds API, credit-paced through the UTC day,
matched to Kalshi sports tickers by team codes and dates. Graded from the Odds API scores feed, or from Kalshi
settlement for leagues whose feed never reports finals (NPB, KBO). SportsGameOdds is a second, shadow-only anchor on its
free plan. Observations feed the live `sports-anchor` signal when the ladder enables it. Out-of-sample rule record
+$12.11 over 253 graded; live record −$5.14 over 8 trades. Those two disagree, and the ladder is judging the live record.

### 10.9 LLM forecasting and review

- **Hunch** (`hunch.ts`): every 8 h, asks an LLM for P(YES) on news-driven Kalshi markets 12 h–30 d out, mid 5–95c, no
  numeric strikes, filtered by series category (cached lookups). Trades nothing. Model order: OpenRouter models when
  configured, then Gemini. **Challenger**: the identical prompt to `openai/gpt-5.6-sol` via OpenRouter, capped at 40 per
  *day* (a per-pass cap once overspent $198). Graded by `scripts/hunch-gate.mjs` and, paired, by
  `scripts/hunch-paired.mjs` (read 2026-09-18).
- **Intelligence engine** (`src/main/intelligence/engine.ts`): pre-trade critic in **shadow** mode by default
  (`intelligenceMode`; only `veto` can block, and it can never flip direction or resize). Gemini first, then a daily-
  budgeted OpenRouter chain; the budget counter persists to disk because in-memory counters reset on each of the app's
  many boots. `scripts/critic-skill.py` found no skill in its verdicts (2026-09-07).
- **LLM vet gate** (`vetting.ts`): exists, fails closed, off by default (`vetMode: 'rules'`).
- **Nightly review** (`nightlyReview.ts`): once per UTC day after 06:00 UTC, builds an evidence packet (venue P&L by
  family, ladder stages, error signatures, secrets-stripped config) and asks a model chain (OpenRouter → Gemini → direct
  endpoint → free OpenRouter models). It may auto-apply numeric parameter proposals only from a bounded allow-list
  (`PARAM_BOUNDS`) and never touches arms, sizes, limits or keys. Output `reviews\<date>.md` and `.json`.

### 10.10 Supporting modules

`flowMonitor.ts` (toxic-flow verdicts, used by the quoter defensively and flow-follow offensively), `classify.ts`
(category, underlying and weather-seat classification for venues without categories), `ledgerAudit.ts` (stuck-settlement
detection, pinned quotes, probe throttling, defensive stats bands), `news.ts` (headline aggregator), `weatherForecast.ts`
and `weatherDay.ts` (NWS fair value and station-local day binding), `liveSpot.ts` (Coinbase ticker socket for BTC, ETH,
SOL, XRP only; its header mentions Kraken but only Coinbase is implemented), `kelly.ts` (quarter-Kelly; used only if
`useKellySizing`, which is off), `research.ts` and `backtester.ts` (manual UI tools). **Dead code**: `macroSniper.ts` and
`src/main/services/noaaMetar.ts` have no importers.

---

## 11. The ladder

`src/main/ladder/ladder.ts` runs hourly and decides every strategy's stage and size from evidence.

### 11.1 Stages

| Stage | Money | Meaning |
|---|---|---|
| `shadow` | none | recording only (quoter, convergence before promotion) |
| `paper` | none | simulated fills (settlement) |
| `tiny-live` | real, notch 1 | micro test after a gate pass or trade-small entry |
| `live` | real, notch 2–4 | reached only by a checkpoint win |
| `disabled` | none | demoted by evidence or switched off |
| `blocked` | none | a promotion passed but a precondition failed (shard 0 underfunded) |

`ladderMode: 'trade-small'` (live setting) re-enters any disabled or shadow strategy at micro size once its cool-down
expires, unless it is under an operator hold. Nothing is dead forever. In `prove-first` mode only pre-registered gate
functions can promote.

### 11.2 Sizing

`notch` starts at 1 and doubles on each checkpoint win up to `MAX_NOTCH = 4`. Generic Kalshi strategies get
`strategySizeMult[key] = notch`. Lead-lag is sized in contracts: `leadLagMaxContractsPerOrder = notch ×
contractsPerNotch (2)`. `SIZES_VERSION` re-applies a changed size table once to already-live strategies.

### 11.3 Decisions (`decideStage()`)

1. **Hard stop, every run**: net ≤ −max($5 × notch, 3 × stake) → stop.
2. **Checkpoints** every 20 settled trades (`CHECKPOINT_TRADES`). Between checkpoints only the hard stop acts.
3. At a checkpoint, an 80% band (z 0.84; Student-t on day-clusters when there are ≥2).
4. **Making money** (net > 0 and lower band > 0) → scale up, unless vetoed into a hold by the one-sided-sample guard
   (every trade landed the same way, n < 100) or the **markout veto** (5-minute markout band wholly negative over ≥15
   trades with ≥80% coverage). Fade is held by the markout veto today.
5. **Losing** (upper band < 0) → stop, but only with ≥4 day-clusters (`MIN_STOP_CLUSTERS`) or ≥100 trades. A single-day
   band is not evidence.
6. **100+ trades**: net positive scales up (markout veto still applies), otherwise stop.
7. Otherwise hold.

### 11.4 Stops, demotions, cool-downs

A stop moves the strategy to its off stage and increments `demotions`. Cool-down is 3 days below the demotion cap
(`ladderMaxDemotionsBeforeGate`, 2), then 14 days doubling per further stop, capped at 56 days. Promotions (and scale-
ups) require `liveAllowed()` (ladder enabled, engine live, armed, kill switch not tripped, exchange not paused) and at
most one promotion per hour across the ladder (`PROMOTION_STAGGER_MS`). Demotions always run. `operatorHold` is written
only when the operator flips a strategy off in the panel; automation reads it and never sets or clears it.

### 11.5 Evidence sources

| Strategy | Evidence |
|---|---|
| Kalshi generic arms, settlement | the trader's calibration ledger, deltas since the stage baseline, day-clustered, with a markout band |
| `kalshi-leadlag` | venue ledger joined to executed rows in `leadlag-dislocations.jsonl` (proven coins only) |
| `quoter` | venue ledger, weather rows, clustered by city-day |
| `convergence` | `crypto-convergence.json` settled trades |
| Polymarket US arms | `mini-auto-polymarket-us.json-research.jsonl` closed rows |

Registry: 16 `GENERIC_STRATEGIES` plus 4 core strategies = 20 tracked (asserted by the adversarial suite).

---

## 12. Evidence doctrine

These rules came from specific incidents. Breaking one has cost money or produced a false verdict.

1. **Venue-true P&L.** Per Kalshi settlement:
   `net = revenue/100 + min(yes_count, no_count) − yes_cost − no_cost − fees`
   (`scripts/venue-pnl.py`, regression-tested by `scripts/settlement-accounting-regression.mjs`).
2. **Net cents per contract after fees**, never win rate. A 34-0 paper record in August was the favourite base rate.
3. **Day-clustered bands.** Trades on the same day and underlying are not independent. Bands are clustered by day (the
   ladder's stop needs ≥4 clusters; pre-registrations usually need ≥5). A one-cluster band is never a verdict, in any
   tool.
4. **Pre-register before data exists.** Each `docs/PREREGISTERED-*.md` fixes the hypothesis, decision unit, thresholds,
   read date and what PASS earns (usually only a shadow-to-tiny-live proposal). Graders refuse `--verdict` before
   `READ_AT`. Changes are dated amendments and may restart scoring. Where a grid of rules was searched first, a
   Bonferroni correction applies.
5. **Correlated exposure is one bet.** Size caps per window, direction, event and underlying, not per order.
6. **A pool cannot stop a subset.** Anything newly added to an arm (coins, series, bands) is sized and judged
   separately until it proves itself.
7. **Reserve before await** for any shared cap touched by concurrent async work.
8. **Check a gate with the gate's own function.** Reading `close_time` said 142 mention strikes were overdue; the
   grader's `max(expiration_time, close_time)` correctly said zero.
9. **A check that cannot fail is not a check.** A grep that never matched pretty-printed JSON reported "no findings"
   three times. Prove every monitor can fire.
10. **Self-healing must prove it healed.** A detached spawn returned a pid while running nothing for a day and a half.
11. **Rules written in a document must exist in code.** Hold-to-settlement was prose for the consensus arm until round 97.
12. **A test must be shown to fail without its fix** (mutation check), and a reviewer's empty result is not a pass until
    its own probes are explained.
13. **Every deferred decision gets a checkable trigger** in `docs/BACKLOG.md`.

---

## 13. Strategy record

Status on 2026-09-15. Sources: `docs/STRATEGY-TAXONOMY-2026-09-14.md` (full family-by-family treatment with worth-it
verdicts), `ladder.json`, the change log and backlog.

### 13.1 Running with money

| Strategy | Record |
|---|---|
| Lead-lag BTC/ETH (live ×4) | +$36 on 09-12 at 60 s and two coins; −$15 on 09-13; the only lifetime earner by family |
| Lead-lag new coins (micro) | since 09-14: SOL +$18.43, BNB +$7.80, XRP +$6.59, HYPE −$3.80, DOGE −$23.38; pooled five +$5.63, band [−4.31, +5.95], 2 of 5 clusters |
| Fade (Kalshi, maker, ≥6 h) | +$10.80 on 152 settled with 146 wins (09-14); +1.18c per contract, CI [−2.52, +4.88]; markout negative |
| Mean reversion v3 (maker) | 5 settled, −$3.49; lifetime of earlier versions 10 trades +$18.28 |
| Volume spike | 34 trades lifetime −$5.12; 14 since re-entry −$1.10 |
| Sports anchor | live −$5.14 over 8; rule out-of-sample +$12.11 over 253 |
| Consensus | shadow +6.39c [+3.14, +10.19]; live record restarted 09-15 |
| News, cross-venue, Dutch, convergence | too few trades to say anything |

### 13.2 Measured dead (by us)

| Strategy | Evidence |
|---|---|
| Momentum (flat 3c) | 54 trades, −$10.63, CLV −2.9c; two hard stops; Becker move audit −4.8c to −17.8c per contract |
| Book imbalance (taker) | Kalshi 37 trades −$12.42; Polymarket US 0/30 −$7.10 |
| Flow following | 14 trades 2/12, −$3.20, CLV −8.2c |
| Favourite leg of fade | maker −8.42c over 142 events |
| Near-settlement convergence, 15-minute | 11,846 rows, every cell's band spans zero |
| Mean reversion, 15-minute | −2.56c over 11,846 rows |
| Weather quoter | −$33.8 over 35 days |
| Weather ratchet | banked "low" was a metro blend, not the station; seat −1.70c |
| Weather forecasts vs market (GFS) | market Brier 0.060 vs forecast 0.123; 9 of 9 cells negative |
| Sports lag, Kalshi vs Polymarket.com | Bonferroni bands span zero; gap closes in a minute |
| Cross-venue arbitrage, Kalshi vs Polymarket US | 38 of 39 matched pairs sum ≥ $1.00 |
| Same-event Dutch book | never executable at size |
| Ladder implication arbitrage | 0 of 137,379 strike pairs positive after fees |
| Polymarket US fade / micro-maker | structural: no longshots; 1 rebate in 457 fills |
| Blanket political favourites | −9 to −13c per market every quarter (one entry per market); closed 09-14 |
| Kalshi liquidity incentives | 300–1,000 contracts a side needed; closed at this equity |
| Copy trading (Manifold) | removed 2026-08-31 |

### 13.3 Not tried, and the verdict

The taxonomy's shortlist, ranked by evidence times feasibility at this bankroll:

1. **Spot-first fair value on 15-minute crypto**: the documented large winner elsewhere (edges of seconds on Kalshi).
   Shadow running; sockets queued.
2. Domain calibration slopes: read 09-14; Politics looks compressed contract-weighted but the per-market replay
   loses (closed).
3. Kalshi liquidity incentives: closed at this size.
4. Maker on Polymarket US: bound to the market-making simulator's 10-17 read.
5. Market-conditioned prompting for the challenger: after the 09-18 paired read.
6. Awards season with guild precursors: pre-register 2027-01-05.
7. Settlement basis under lead-lag: measured, 2.1–2.4%; weekly.
8. Interest on balance: the operator's deposit decision.
9. Midterm-night election-call favourites: pre-register by 2026-10-15 for 2026-11-03.

Not worth trying at this size (reasons in the taxonomy): cross-venue arbitrage, late-expiry "sure things", parlays
and sportsbook-account strategies, paid sentiment feeds, reward farming on Polymarket global, and anything involving
insider information, manipulation or multi-accounting.

---

## 14. Pre-registered experiments and the dated queue

### 14.1 Pre-registrations

| Document | Rule in one line | Grader | Status |
|---|---|---|---|
| `PREREGISTERED-btc-convergence.md` | T−5 taker on hourly BTC strikes; ≥200 events, Bonferroni lower bound > +1c | `scripts/btc-gate.mjs` | 194/200, not yet |
| `PREREGISTERED-btcd-maker.md` | maker bids 80–95c on KXBTCD; ≥60 fills, CI > 0 | `scripts/btcd-maker-gate.mjs` | collecting |
| `PREREGISTERED-btcd-fairvalue-maker.md` | rest where the bid is ≥3c under lognormal fair value | `scripts/btcd-fv-gate.mjs` | collecting |
| `PREREGISTERED-fade-v2.md` | maker seat, ≥6 h horizon; throughput fallback | ladder | running |
| `PREREGISTERED-leadlag-coins.md` | ≥400 contracts and ≥5 day-clusters; upper < 0 narrows to BTC/ETH, lower > 0 promotes; default narrow 2026-10-04 | `scripts/leadlag-coins.mjs --check` | 684 contracts, 2 clusters |
| `PREREGISTERED-llm-hunch.md` | ≥200 settled; model Brier beats mid; Bonferroni cells | `scripts/hunch-gate.mjs` | collecting |
| `PREREGISTERED-mean-reversion.md` | first 20 trades mean positive, 80% lower > −3c (three addenda) | ladder | v3, 5/20 |
| `PREREGISTERED-polymarket-consensus.md` | ≥40 settled and ≥5 clusters; −$8 hard stop; deadline 2026-10-13; round-96 and round-97 amendments | venue ledger | restarted 09-15 |
| `PREREGISTERED-spot-first-shadow.md` | first qualifying 2 s poll per (coin, window, side); PASS at 3c: n ≥ 300, ≥5 clusters, lower > 0 | `scripts/spot-shadow-gate.mjs` | read 2026-09-21 |
| `PREREGISTERED-weather-morning.md` | first 20 trades mean positive | ladder | operator hold |
| Momentum log-odds (prereg JSON in `%APPDATA%\oracle-trader\momentum-candidates\`) | largest move per (ticker, slot), day-clustered; PASS earns a shadow only | `scripts/momentum-candidates-gate.mjs` | read 2026-09-21 |
| Market-making simulator (prereg JSON in `mmsim\`) | 35-day run, runId `33249be26379` | `scripts/mmsim-grade.mjs` | read 2026-10-17 23:04 UTC |

### 14.2 Dated queue

The daily maintenance run checks every trigger and builds the first one that is due (`docs/BACKLOG.md`, "Build queue,
dated milestones" and later sections; item numbers restart in places, so read by date and title).

| When (UTC) | Item |
|---|---|
| Daily | Lead-lag coin cohort reading; consensus arm settled count and refusal mix; spot-shadow `--interim` and task liveness; anti-flood cap check (trigger: 60 open trades three days running) |
| 2026-09-15 | Lead-lag day-one cadence read (keep 10 s unless the proven pair's band is below zero *and* markout negative); momentum blocked-vs-taken comparison |
| After the day-one read | Kalshi websocket quotes for lead-lag with REST fallback; then the Polymarket socket trigger |
| 2026-09-18 | Challenger paired read, then the market-conditioned prompting variant |
| 2026-09-19 | Cull gate read (Friday report in `data/cull-gate/`) |
| 2026-09-21 | Momentum log-odds verdict; spot-first verdict; first weekly settlement-basis reading (then Mondays) |
| 2026-09-25 | Mention shadow at ≥100 graded; book-imbalance cool-down ends (ladder must hold it at the demotion gate) |
| 2026-09-27 | Momentum cool-down ends (same check; never re-arm by hand) |
| 2026-10-04 | Coin cohort narrows to BTC/ETH by default if undecided |
| 2026-10-13 | Consensus arm deadline for 40 settled contracts (check slot starvation before concluding lack of flow) |
| 2026-10-15 | Pre-register midterm-night election-call favourites |
| 2026-10-17 23:04 | Market-making simulator verdict; join with incentive programmes; maker on Polymarket US if it passes |
| 2027-01-05 | Awards-season pre-registration |
| Data triggers | News arm at 20 settled trades → decide on Mentions series; weekly universe page-bound check |
| Any day | OpenRouter per-caller spend line; adversarial suite section F non-determinism (reproduce in a loop) |

---

## 15. Operations

### 15.1 Windows scheduled tasks

All ten use `MultipleInstancesPolicy: IgnoreNew` and run from the repo root. Times are local (Eastern).

| Task | Runs | Trigger | Purpose |
|---|---|---|---|
| `OracleTrader-App` | `node_modules\electron\dist\electron.exe .` | logon + 30 s; restarts up to 10× | the trader |
| `OracleTrader-BtcCollector` | `node scripts\btc-collector.mjs` | logon + 1 min; restarts 3× | crypto ladders, books, settlements, spot every minute |
| `OracleTrader-SpotShadow` | `node scripts\spot-shadow.mjs` | logon + 1 min; restarts 3× | spot-first shadow |
| `OracleTrader-HrrrShadow` | `node scripts\hrrr-shadow.mjs` | hourly at :20 | HRRR vs NBM daily-high forecasts |
| `OracleTrader-MentionShadow` | `python scripts\mention_shadow.py` | hourly at :50 | mention-market base rates |
| `OracleTrader-MetaculusShadow` | electron `scripts\metaculus-shadow.cjs` | hourly at :35 | Metaculus community forecast vs Kalshi |
| `OracleTrader-PolyConsensus` | `python scripts\polymarket_consensus.py` | hourly at :55 | smart-money consensus signals |
| `OracleTrader-Sentinel` | `node scripts\sentinel.mjs` | every 15 min | deterministic defect sentinel |
| `OracleTrader-Maintenance` | `powershell -File scripts\maintenance.ps1` | daily 07:00 | headless maintenance session |
| `OracleTrader-CullGate` | `node scripts/cull-gate.mjs` to `data/cull-gate/report-<ts>.txt` | weekly, Friday 08:00 | anti-flood cap report |

**Not in Task Scheduler**: three recorders start from the Windows **Startup folder**
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`: `crypto15-shadow.cmd`, `mmsim.cmd`,
`OracleTrader-Ladder15Shadow.cmd`). Each uses `start "" /min node.exe <script>`, because `spawn(detached)` returns a pid
without running anything on this machine. The sentinel also relaunches crypto15 and ladder15 when their heartbeat goes
stale. Together these started duplicates on 2026-09-15 ([§16](#16-known-defects-risks-and-sharp-edges), item 1).
A separate Claude **desktop** schedule (08:30 local, described in the maintenance prompt, not in Task Scheduler) delivers
the daily report to the operator.

### 15.2 The automation loop

- **Maintenance** (`scripts/maintenance.ps1` + `docs/MAINTENANCE-PROMPT.md`): runs `claude -p` headless with up to 400
  turns. It clears Anthropic API key variables from its own process environment so the CLI uses the claude.ai login; an
  unscoped key once made every request fail with 400. Steps: liveness; read reviews, ladder, errors and gates; confirm
  ladder verdicts against the venue ledger; reproduce-then-fix one defect; write `docs/MAINTENANCE-LOG.md` and
  `docs/reports/<date>.md`; keep the backlog; check every build-queue trigger and build the first one that is due. It waits
  up to 60 min for `data/sentinel/agent.lock`. Log: `logs/maintenance-<date>.log`.
- **Sentinel** (`scripts/sentinel.mjs`): deterministic, no LLM, no venue writes. Every 15 minutes it runs liveness checks,
  then defect detection from `main.log` signatures and file ages, then action. It revives a dead app (stop Electron, start
  the App task) or stale recorders. It writes `data/sentinel/status.json`, `digest.md` and `incidents/<ts>.md`
  (`Status: OPEN/CLOSED` on line 1). For a new incident it dispatches a repair session: at most 3 per UTC day, 90 min
  apart, one per signature per 12 h, never while the lock is under 3 h old. Suppressions are regex, expiry (≤7 days) and
  reason entries in `data/sentinel/suppressions.json`. Alerts go to the app's alert webhook.
- **Repair** (`scripts/repair.ps1` + `docs/REPAIR-PROMPT.md`): one incident, up to 250 turns; exits immediately if the lock
  is held. Outcome words: FIXED, MITIGATED, NOT-A-DEFECT, NEEDS-OPERATOR. Same absolute rules as maintenance. Log:
  `logs/repair-<ts>.log`.
- **Watchdog** (`scripts/watchdog.mjs`): older liveness process. **Dead since 2026-09-03 08:03 UTC**, and with it the
  standalone `leadlag-recorder.mjs` and `dutchbook-scanner.mjs` it restarted. Their in-app successors write
  `leadlag-dislocations.jsonl` and `dutch-book.json-opps.jsonl`.

### 15.3 Recorders and shadows

| Script | Records | Output |
|---|---|---|
| `btc-collector.mjs` | every minute: crypto ladders, 15M series, weather ladders, books at capture windows, settlements and index, Coinbase and Kraken spot | `data/btc-collector/<date>.jsonl` (~48 MB/day) |
| `spot-shadow.mjs` | Coinbase ticks, Kalshi books every 2 s with lognormal fair value, Polymarket CLOB book, results | `data/spot-shadow/<date>.jsonl` (~45 MB/day) |
| `crypto15-shadow.mjs` | momentum signals the 15-minute close floor hides | `data/crypto15-shadow/observations-<month>.jsonl` |
| `ladder15-shadow.mjs` | 15-minute commodity ladders at T−180/T−60 s | `data/ladder15-shadow/observations.jsonl` |
| `mmsim.mjs` | zero-money two-sided maker simulation, 35 days | `%APPDATA%\oracle-trader\mmsim\<runId>-<date>.jsonl` |
| `hrrr-shadow.mjs` | HRRR vs NBM daily highs, graded next day | `data/hrrr-shadow/` |
| `metaculus-shadow.cjs` | community forecasts matched to Kalshi | `data/metaculus-shadow/pairs.jsonl` |
| `mention_shadow.py` | corpus base rates vs mention prices | `data/mention-shadow/` |
| `polymarket_consensus.py` | top-wallet trades and signals | `data/polymarket-consensus/` (`trades.jsonl` 394 MB, `state.json` 156 MB, growing) |

### 15.4 Graders, backtests, dumps

- **Graders** (read local data; print PASS/FAIL; several refuse before a read date): `btc-gate`, `btcd-maker-gate`,
  `btcd-fv-gate`, `crypto15-gate`, `cull-gate`, `hunch-gate`, `hunch-paired`, `momentum-candidates-gate`, `mmsim-grade`
  (`--interim` never loads P&L fields), `spot-shadow-gate`, `quoter-gate`, `quoter-shadow-gate`, `poly-maker-gate`,
  `leadlag-coins`, `leadlag-cadence-gate`.
- **Offline backtests** (`scripts/backtests/`, DuckDB over the Becker archive, split at 2025-07-01 into selection and
  evaluation halves): `calibration_slopes.py`, `fade_audit.py`, `favorites_weather_audit.py`, `move_audit.py`;
  `kalshi_categories.py` is the vendored category map. Local-data studies: `leadlag_settlement_basis.py`,
  `leadlag_basis_cells.py`, `politics_favourite_live.py`, `scripts/ladder_implication_scan.py`. Older Node experiments:
  `scripts/backtest-*.mjs`.
- **Venue dumps** (GET-only, run with the project's Electron so they can decrypt keys):

  ```bash
  node_modules/electron/dist/electron.exe scripts/readonly-kalshi-dump.cjs tmp/k-2026-09-15.json
  node_modules/electron/dist/electron.exe scripts/readonly-polyus-dump.cjs tmp/p-2026-09-15.json
  python scripts/venue-pnl.py tmp/k-2026-09-15.json tmp/p-2026-09-15.json [--since ISO]
  ```

  Several scripts pick the newest `tmp/k-*.json` automatically. Nothing prunes `tmp/`.
- **Diagnostics**: `smoke-*`, `verify-*`, `diag-*`, `trade-quality.mjs`, `sgo-anchor-report.mjs`, `intelligence-report.mjs`,
  `critic-skill.py`.
- **Historical one-off patchers, do not re-run**: `scripts/add-getquantstatus.js`, `fix-*.mjs|js`, `patch-*.js`,
  `patch_visibility_capacity.py`, `update-quoter-metar.mjs`, and the dot-prefixed `.fix_*`/`.patch_*` files at the repo
  root. They apply literal string replacements to code that has since moved.

### 15.5 Logs

| Log | Where |
|---|---|
| App | `%APPDATA%\oracle-trader\logs\main.log` (UTC timestamps; about 23 MB) |
| Maintenance / repair | `G:\PROJECTS\oracle-trader\logs\maintenance-<date>.log`, `repair-<ts>.log` |
| Recorders | beside their data (`collector.log`, `recorder.log`, `run.log`) |
| Sentinel | `data/sentinel/digest.md`, `status.json`, `incidents/` |
| Nightly review | `%APPDATA%\oracle-trader\reviews\<date>.md` |
| Daily report to the operator | `docs/reports/<date>.md` |

---

## 16. Known defects, risks and sharp edges

Verified on 2026-09-15 unless marked otherwise.

1. **Duplicate recorders repaired at 08:22 UTC September 15; historical integrity remains open.** One original writer
   remains for crypto15, ladder15 and mmsim. Only the extra copies were stopped. New startup locks detect the existing
   Windows writers; run IDs, raw files and deadlines were preserved. Crypto15/mmsim graders deduplicate exact observations
   and refuse a verdict on conflicting identities. They do not silently repair diverging simulator histories.
2. **Windows Update restarts.** 2026-09-09 (5 h 26 min) and 2026-09-15 (4 h 51 min). Everything recovers at logon; the
   collector's gap cannot be rebuilt. Active hours are the operator's setting.
3. ~~**No git.**~~ Closed 2026-09-18: the tree is a git repository, public at
   `https://github.com/jlucasmcrell/oracle-trader`. Runtime state and credentials are excluded by `.gitignore`;
   hourly zip backups and `.bak_*` files continue for the state git does not carry.
4. **Interrupted-write repair, September 15 09:18 UTC:** settings, nightly review files and both hunch state files now
   use flushed same-directory temporary-file replacement. A simulated replacement failure preserves the previous file.
5. **v26 migration repaired, deployed 08:36 UTC September 15.** The migration now persists version 26 after older
   migrations. A temporary-directory regression confirms later operator position limits survive a reload.
6. **Kill switch doc/behaviour mismatch.** `ipc.ts` says a trip drops the live arm; the code halts entries for the UTC day and
   resumes automatically.
7. **Kalshi websocket is shadow-only** and subscribes only the first 50 universe tickers; the 15M tickers are not
   guaranteed to be in that set.
8. **Settlement basis**: 2.1–2.4% of matched 15-minute windows settle differently on the two venues; a large share of
   lead-lag's recent losses sat there.
9. **Stale comments**: `leadLag.ts` header (says shadow and live-off); `liveSpot.ts` header (claims Kraken).
10. **Dead code**: `macroSniper.ts`, `noaaMetar.ts`.
11. **Category map repaired September 15:** DIMAYOR, SERIEC, SLGREECE and ECULP now precede generic political substring
    matches in the shared map. Four Sports checks and a mayor-election control pass. Historical outcomes were not regraded.
12. **Old watchdog superseded** (see §15.2). Its in-app collector replacements are active; the scheduled sentinel owns
    current recovery. Reviving the old process would add redundant collectors.
13. **Adversarial suite non-determinism**: one run in five on 2026-09-14 failed three section-F checkpoint assertions; cause
    not identified (backlog 80). Twenty consecutive September 15 runs passed; the original failure was not reproduced.
14. **`scripts/venue-pnl.py` venue detection repaired September 15.** It detects response shape instead of filenames.
    Its US resolution-only total is explicitly labeled incomplete account accounting. The app's complete execution replay
    now reconciles cash, fees, netting and open inventory on September 10/11/15 snapshots. Strategy allocation remains incomplete.
15. **OpenRouter spend** ran about $25/day (09-13 to 09-14) with no per-caller measurement; the nightly review, challenger and
    paid critic all draw on it. Top-ups are the operator's.
16. **Scan latency:** the September 15 batching/pacing build recorded seven scans with a 74.9 s median (18.6 s exits),
    including a 187.8 s cold first scan. This remains slower than the 30 s polling setting. Final timings are in the report.
17. **Only maintenance and repair honour `agent.lock` automatically.** An interactive session must take it by hand, or the
    sentinel can start a repair mid-change.
18. **Pre-registration hashes**: the momentum-candidates prereg file's grader hash was computed before later grader edits;
    the spot-shadow grader hash changed after registration (amendment recorded).
19. **README.md is the August scaffold** and describes a Manifold-first copy trader that no longer exists.
20. **Unbounded growth**: `data/polymarket-consensus/trades.jsonl` and `state.json` (550 MB together), episodes at about
    65 MB/day, `tmp/` dumps never pruned.

### September 15 follow-up deployment

The 08:36 UTC build adds a durable order-intent journal (`%APPDATA%/oracle-trader/order-journal.jsonl`),
Kalshi client-ID recovery, forward fill attribution, honest US cash accounting, priority rate limiting, batches
of four exit-quote requests and a CF Benchmarks observation-only collector. Order journal corruption/write failure
blocks new submissions; unknown submitted orders remain reserved until positively identified. US retail orders
cannot currently be recovered by a client-supplied exchange identifier. Do not manually discard unknown rows.

The independent recorders stayed at their original PIDs through deployment. US holds, trading sizes, loss limits,
experiment run IDs and deadlines were preserved. Reference collection does not alter the spot-first trial. Detailed
verification and remaining limitations are in [the review report](reports/ORACLE-TRADER-VIABILITY-REVIEW-2026-09-15.md).

The completion build started **09:23:45 UTC (PID 23880)**. It adds an append-only execution archive per venue
(`fill-reconciler-<venue>.json.fills.jsonl`), exact fill-ID deduplication, full backfill after a reconciliation gap,
complete US position pagination and cash/inventory accounting. US `currentBalance - marginRequirement` is account cash;
position `avgPx` is already the owned-leg price. September 10/11 snapshots with open holdings reconcile exactly.
Mini exits use actual prices and commissions; expired flow is unavailable after a failed refresh. Orders created after
this boundary carry journal version `2026-09-15-r3`. Old records and all experiment identities remain intact.

Kalshi now derives smooth pacing from authenticated account limits/costs (334ms here) and quotes up to 50 tickers per
request. Other read work overlaps in bounded groups; portfolio requests coalesce across callers but keep paper/live
caches separate. Missing quotes still trigger throttled settlement probes when the cached close is wrong.
All nine test suites, type checking and production build passed; completion tests cover 14 scenarios.
By 09:30 UTC, the final build completed scans in 127.0, 63.2 and 73.5 seconds. Both execution archives completed
another reconciliation without duplicate IDs or errors. This short sample does not establish a sustained 30-second cycle.

### September 15 improvement measurements

The **09:44:21 UTC build (PID 17844)** adds model-usage telemetry under `model-usage/YYYY-MM-DD.jsonl` in userData.
All five call paths are covered: incumbent, challenger, nightly review, strategy vetting and critic (including
venue/strategy/mode). It records provider-reported OpenRouter account charges and explicit unknowns elsewhere;
prompts, responses and credentials are excluded. Call payloads, limits and fallback ordering remain unchanged.
`npm run costs:report -- --since YYYY-MM-DD --until YYYY-MM-DD` groups observed costs; the end date is exclusive.
These are prospective partial operating costs, not invoices or complete business P&L.

`npm run execution:report` joins the existing order journal to execution archives by immutable order ID. It reports
pre-submission preparation and submission-request-to-acknowledgement/recovery times, state counts and matched fills.
Neither interval measures source-to-fill latency; actual dispatch/source timestamps are unavailable in the old cohort.
Tests: `npm run test:model-usage` and `npm run test:execution-quality`. See section 11 of the viability report for evidence.

---

## 17. History in one page

Full detail: `docs/REVIEW-CHANGES-2026-09-06.md` (§1–§94), `docs/HANDOFF-2026-09-02.md`, `docs/MAINTENANCE-LOG.md`.

- **Late August 2026.** Scaffold (Manifold-first). Kalshi and Polymarket US adapters added. 2026-08-28 review fixed the
  foundational execution bugs: YES-leg order pricing, signing without the query string, verified exits, depth-aware paper
  fills, fade as a maker with a calibrated EV gate. Copy trading removed 08-31.
- **2026-09-02 handoff.** Evidence discipline adopted after a 34-0 paper streak turned out to be the favourite base rate.
  Becker archive analyses, first pre-registrations, collectors, Dutch-book scanner, lead-lag recorder.
- **09-06 to 09-08.** The ladder, trade-small mode, automated maintenance, sentinel and repair sessions. Venue ledger made the
  truth. Weather quoter parked after measured losses; weather ratchet retired. Lead-lag moved from Gamma prices to the CLOB
  book and went live.
- **09-09 to 09-12 (rounds 61–89).** Repair pipeline found to be a silent no-op and fixed. Telemetry and variance bugs fixed.
  Polymarket US throughput and close-time fixes. Capacity vetoes priced in cents. Challenger model, market-making simulator,
  paired grader. An adversarial review of rounds 78–88 found 36 issues, including a markout metric that would have produced
  a false 35-day kill. Three arms parked on operator approval.
- **09-13 (rounds 90–94).** Momentum hard-stopped again. Log-odds candidate recorder. Lead-lag to 10 s polling and seven coins,
  then contained after the correlated-window loss tripped the kill switch: micro size for new coins, $15 per window, two coins
  per direction.
- **09-14 (rounds 95–96 and research).** Consensus arm built. Implication arbitrage closed. Full strategy taxonomy. Shortlist
  tested the same day: incentive programmes closed, calibration slopes read, political favourites closed, settlement basis
  measured, spot-first shadow started. Consensus arm given reserved long-horizon slots and a 21-day ceiling.
- **09-15 (round 97).** Windows Update outage. Losing streak attributed to lead-lag BTC concentration and venue settlement
  basis. Consensus arm made to hold to settlement.

---

## 18. Document map

| Document | Authoritative for |
|---|---|
| `docs/DEVELOPER-HANDBOOK.md` (this) | orientation; how the system works today |
| `docs/BACKLOG.md` | open work with triggers; "Recently done"; dated build queue |
| `docs/REVIEW-CHANGES-2026-09-06.md` | every change and investigation, §1–§94, with evidence |
| `docs/MAINTENANCE-LOG.md` | each maintenance and repair run |
| `docs/reports/<date>.md` | the daily report the operator reads |
| `docs/MAINTENANCE-PROMPT.md`, `docs/REPAIR-PROMPT.md` | contracts for automated sessions (read by the runners; edit carefully) |
| `docs/STRATEGY-TAXONOMY-2026-09-14.md` | every strategy family with our record and a worth-it verdict |
| `docs/PREREGISTERED-*.md` | experiment rules and dated amendments |
| `docs/HANDOFF-2026-09-02.md` | the 09-02 evidence table and venue facts (partly superseded) |
| `docs/STRATEGY-REVIEW-2026-09-02.md`, `validation-plan.md`, `validation-results.md` | early evidence (historical) |
| `docs/autotrade-ideas.md`, `INSTITUTIONAL-STRATEGY-BLUEPRINT.md`, `EXTERNAL-DATA-PLAN-2026-09-05.md`, `ORACLE-INTELLIGENCE.md`, `SPORTSGAMEODDS-*.md`, `kalshi-shortterm-data.md`, `broker-gaps.md`, `autotrader-status.md`, `AUDIT-PATCH-2026-09-05.md` | historical design notes; check against code before relying on them |
| `scripts/kalshi-docs/` | mirrored Kalshi API reference pages |
| `README.md` | stale scaffold description |

---

## 19. Continuing with an AI assistant

- **Load first**: this handbook, then the bottom of `docs/BACKLOG.md`, the newest `docs/reports/<date>.md`, and the last
  sections of `docs/REVIEW-CHANGES-2026-09-06.md`. Claude Code sessions also have the project memory file
  (`C:\Users\<you>\.claude\projects\F--\memory\oracle-trader-project.md`); newest entries are at the bottom.
- **Give the assistant §4 verbatim.** Most damage comes from an assistant "helpfully" touching a size, an arm or an order.
- **Use cheap models for reading and scanning**, the strongest model for judgement and code changes. The operator asked for this
  explicitly after costs rose.
- **Keep sessions short and write state down.** Anything not in `BACKLOG.md` with a trigger will be forgotten when context
  runs out.
- **Environment quirks that trip assistants on this machine**:
  - In the Bash tool, heredocs collapse doubled backslashes even when quoted. Write scripts containing regex or Windows
    paths with a file-write tool, not a heredoc.
  - `tsx` treats `.ts` files as CommonJS, so top-level `await` fails with `ERR_REQUIRE_ASYNC_MODULE`. Use `.mts` for probes.
  - Python printing non-ASCII to this console needs `PYTHONIOENCODING=utf-8`.
  - The command guard blocks a PowerShell line that combines `Remove-Item` with a regex such as `\d+`; delete with
    `[System.IO.File]::Delete(path)` instead.
  - Foreground `sleep` is blocked in some harnesses; wait with a background loop on a condition.
  - Windows Task Scheduler info objects print local times even when formatted with a trailing `Z`.
- **Verify, do not assume**: restart time vs bundle time; a grader's own gate function; that a monitor can fire; that a
  new test fails without its fix.

---

## 20. Glossary

| Term | Meaning |
|---|---|
| Arm | a strategy that can place orders |
| Basis (settlement) | two venues settling the "same" window on different indices |
| Becker archive | historical Kalshi and Polymarket trades and markets in parquet (Jon Becker's prediction-market-analysis dataset) |
| Checkpoint | a ladder verdict every 20 settled trades |
| CLV | closing-line value: entry price vs the last pre-settlement price |
| Cool-down | time a demoted strategy must wait before re-entry |
| Day-cluster | all trades realized on one UTC day, treated as one observation for uncertainty |
| Dislocation | a Polymarket-vs-Kalshi price gap on the same 15-minute window |
| Episodes | the JSONL event ledger in `%APPDATA%\oracle-trader\episodes` |
| Fade | buying the favourite side of a longshot (NO on 3–10c YES), earning the favourite-longshot bias |
| IOC | immediate-or-cancel order |
| Kill switch | daily halt at a venue-day loss of 20% of equity |
| Ladder | the evidence engine that stages and sizes strategies |
| Markout | price movement 5 minutes after entry, in the position's favour or against it |
| Notch | ladder size step, 1–4 |
| Operator hold | a strategy the operator switched off; automation never lifts it |
| Pre-registration | a rule fixed in writing before its data exists |
| Proven coins | lead-lag coins pooled into ladder evidence (BTC, ETH) |
| READ_AT | a grader's earliest verdict time |
| Shadow | measurement with no money |
| Shard | a Kalshi matching engine with its own collateral |
| Sweep | a lead-lag IOC order |
| Tiny-live | real money at micro size |
| Trade-small mode | the ladder mode that re-enters strategies at micro size after cool-down |
| Universe cull | markets the anti-flood cap discarded before signals |
| Venue day | realized venue P&L since 00:00 UTC |
| Venue-true | P&L computed from venue settlements with the netting formula |

---

## Appendix A: source file map

Line counts on 2026-09-15.

| File | Lines | Purpose |
|---|---|---|
| `src/main/index.ts` | 460 | boot, logging, IPC, window |
| `src/main/engine/engine.ts` | 614 | order routing, risk checks, portfolio, routed adapters |
| `src/main/engine/paper.ts` | 234 | paper broker |
| `src/main/venues/kalshi.ts` | 1,536 | Kalshi adapter |
| `src/main/venues/kalshiWs.ts` | 524 | Kalshi order-book websocket (shadow) |
| `src/main/venues/polymarketUs.ts` | 895 | Polymarket US adapter |
| `src/main/venues/polymarket.ts` | 281 | Polymarket.com data (Gamma/CLOB), not registered |
| `src/main/venues/manifold.ts` | 482 | Manifold adapter |
| `src/main/venues/registry.ts` | 33 | venue registration |
| `src/main/venues/cullRecorder.ts` | 118 | records culled markets |
| `src/main/strategies/autoTrader.ts` | 4,942 | Kalshi trader core |
| `src/main/strategies/leadLag.ts` | 669 | lead-lag engine |
| `src/main/strategies/cryptoConvergence.ts` | 482 | T−5 convergence |
| `src/main/strategies/dutchBook.ts` | 381 | Dutch-book recorder |
| `src/main/strategies/quoter.ts` | 1,245 | weather quoter (held) |
| `src/main/strategies/consensus.ts` | 192 | consensus rule and feed |
| `src/main/strategies/momentumCandidates.ts` | 293 | momentum candidate recorder |
| `src/main/strategies/miniAuto.ts` | 1,420 | Polymarket US / Manifold trader |
| `src/main/strategies/sportsAnchor.ts` | 950 | Odds API sharp anchor |
| `src/main/strategies/sportsGameOdds.ts` | 494 | SportsGameOdds anchor (shadow) |
| `src/main/strategies/hunch.ts` | 493 | LLM hunch and challenger |
| `src/main/strategies/vetting.ts` | 242 | LLM vet gate (off) |
| `src/main/strategies/weatherForecast.ts` | 225 | NWS fair value |
| `src/main/strategies/weatherDay.ts` | 113 | station-local day binding |
| `src/main/strategies/classify.ts` | 176 | categories, underlyings, weather seats |
| `src/main/strategies/ledgerAudit.ts` | 176 | settlement invariants, stats bands |
| `src/main/strategies/news.ts` | 173 | headlines |
| `src/main/strategies/flowMonitor.ts` | 105 | toxic flow |
| `src/main/strategies/research.ts`, `backtester.ts` | 85, 72 | manual tools |
| `src/main/strategies/macroSniper.ts` | 100 | dead code |
| `src/main/ladder/ladder.ts` | 1,278 | the ladder |
| `src/main/intelligence/nightlyReview.ts` | 481 | nightly review |
| `src/main/intelligence/engine.ts`, `externalEvidence.ts`, `gemini.ts`, `types.ts` | 138, 161, 37, 33 | critic |
| `src/main/services/liveSpot.ts` | 174 | Coinbase ticker socket |
| `src/main/services/noaaMetar.ts` | 228 | dead code |
| `src/main/store/*.ts` | — | config, history, episodes, fill reconciler, JSON store |
| `src/main/util/*.ts` | — | HTTP client with rate limiting, alerts, Kelly |
| `src/shared/ipc.ts` | 1,171 | IPC names and all config types (field docs live here) |
| `src/shared/types.ts`, `venue.ts` | 406, 113 | domain types, `VenueAdapter` contract |
| `src/preload/index.ts` | 78 | context bridge |
| `src/renderer/src/*.tsx` | — | React panels |
| `scripts/tests/*.test.ts` | 1,141 / 263 / 578 | review-fixes, ladder, adversarial suites |

## Appendix B: log prefixes worth grepping

In `%APPDATA%\oracle-trader\logs\main.log`:

| Prefix | Emitted by |
|---|---|
| `[auto-trader] scan` | scan timing and counts (slow scans, every 20th) |
| `[auto-trader]` | kill switch, orphan alerts, hunch pass done, incentive programmes, venue-day refresh |
| `[leadlag] scanned` / `DISLOCATION` / `SWEEP EXECUTED` / `sweep held` / `sweep skipped` | lead-lag |
| `[consensus]` | fresh signals, candidates, refusal counters |
| `[convergence]` | convergence scans, qualified, executed, settled |
| `[dutch]` | Dutch-book scans and baskets |
| `[quoter]` | quoter and its shadow meter |
| `[ladder]` | stage line for every strategy and every transition |
| `[reconciler]` | venue fill reconciliation |
| `[momentum-rec]` | hourly momentum recorder health |
| `[hunch]` | hunch passes and challenger errors |
| `[anchor]` | sports anchor grading |
| `[mini manifold]`, `[mini polymarket-us]` | MiniAuto |
| `KILL SWITCH` | a kill-switch trip |
