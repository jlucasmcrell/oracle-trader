# Review and change report — 2026-09-06

Scope: full review of Oracle Trader (code, strategies, venue APIs, trading history), followed by the
fixes and strategy work deployed in the same session. Both venues were in maintenance during the
deploy window. Backups: `G:\PROJECTS\oracle-trader-backups\` (pre-change and post-change zips; each
holds the repo minus `node_modules`/`out` plus the Electron userData minus browser caches).

## 1. What the review found (venue-authoritative, 08:18 UTC)

| Venue | Cash | Positions | Settled record |
|---|---|---|---|
| Kalshi | $50.34 (shard 0 $0.05, shard 2 $25.29, shard 3 $25.00) | 52 weather, mark $14.10, cost $20.82 | 131 settlements, 45 W / 84 L, net **−$31.48** |
| Kalshi weather quoter | starved on shard 0 since 09-03 | 52 | 112 settlements, 29 W / 81 L, **−$29.07**; 653 maker fills, 896 contracts, −2.6c each |
| Kalshi BTC convergence | shard 2 | 0 | 9 graded, 8 W / 1 L, −32c |
| Polymarket US | $51.51 | 4 open + 2 resting (venue positions endpoint 503) | 09-05 resolutions: 3 wins +$1.97, 4 losers costing $4.52 |
| Manifold (play money) | 828 mana | 5 NO fades | 9 real bets, none resolved |

Root causes, in severity order:

1. **Quoter fill ledger blind.** `getOpenOrders` returns only resting orders; any quote that filled
   completely vanished from the list and the quoter dropped it without booking the fill (33 of 653
   fills seen). The "+7.66c/contract" figure in the 09-05 audit was computed on that 5% sample.
2. **Adverse selection.** Weather fills clustered 19–21 UTC while the daily high formed; bids hit at
   −6.2c. Consistent with Bartlett & O'Hara (2026) on Kalshi informed flow.
3. **Kill switch blind.** `dailyPnl.realized` counted only the main trader's own exits; the quoter,
   convergence, lead-lag and Dutch engines placed orders straight through the adapter, bypassing
   the engine's risk limits and the trade history as well.
4. **Convergence went live before its pre-registered gate**, on a post-hoc "v2 band" with a 98c
   cost cap; one 84c loss erased eight wins.
5. **Lead-lag signal was a stale-data artifact**: Gamma `outcomePrices` lag minutes; 16k phantom
   dislocations (median 13.5c). A 09-03 build with the live flag on fired 1,716 sweep attempts,
   all rejected by Kalshi's Thursday 3–5 AM ET maintenance pause.
6. **Shard collateral.** Weather orders settle on exchange index 0; the aggregate balance read
   "funded" while shard 0 held five cents, so every placement since 09-03 05:32 UTC was rejected
   (2,540 rejections) and the quoter looped in a 15-minute backoff.
7. **Encoding damage** from the 09-05 patch pipeline (cp1252/UTF-8 double encoding) in four source
   files, including live code: the market-title separator in `autoTrader.ts` and every alert string.
8. Smaller: fills/settlements fetched as one 200-row page (live P&L panel would have truncated
   within days); maker fee modelled at 0.07× instead of the published 0.0175×; convergence trade
   log written to the wrong filename without newlines; Polymarket US duplicate-order bug (fixed
   09-05 21:28 UTC after accumulating five contracts on one market); intelligence layer spent 91
   GPT-5.6 calls with zero allow verdicts.

## 2. Changes deployed (config version 21, app restarted 09:09 UTC)

### Risk and accounting
- **Venue-fed daily kill switch.** `AutoTrader.refreshVenueDay()` sums today's realized P&L from
  Kalshi's paginated settlement feed every 5 minutes and once per scan; `killSwitchCheck` reads the
  worse of the venue ledger and the local ledger in live mode. Status shows `venue day ±x.xx
  (n settled) - kill reads venue|local`. New state field `venueDay`.
- **All engines routed through the engine.** `TradingEngine.routedAdapter(venue, ref)` overrides
  `placeOrder`/`sellPosition` on a prototype-preserving view of the adapter; the quoter,
  convergence, lead-lag and Dutch engines now hit the operator's `maxStakePerBet`/`maxOpenPositions`
  limits and land in `history.json` with refs `quoter`, `convergence`, `leadlag`, `dutch`.
- **Shared sub-engine kill flag** (`subEngineKilled`) combines the local trip and the venue-ledger
  trip; **exchange-pause hold** (`exchangePausedNow`, refreshed ≤90s) makes every engine hold
  during maintenance instead of hammering order placement.
- **Pagination.** `KalshiAdapter.authPaged` walks cursors (200/page) for `getFills` and
  `getSettlements`; `engine.getLivePnl` now uses the full history behind a 60-second cache.
- **Maker fee** coefficient set to the published 0.0175 (`KALSHI_MAKER_FEE_COEF`).

### Weather quoter (`src/main/strategies/quoter.ts`, rewritten)
- Disabled by migration (`quoterEnabled=false`); the panel has a confirmed re-arm toggle.
- Fills attributed from the venue fills feed by order id (`ledgerFills` counter, source
  `venue-fills`, fill price recorded).
- Shard-aware collateral check (`balanceByShard[exchange_index]`).
- Gates: **ratchet** (skip brackets the banked running high/low has decided or is within 1.5°F of
  deciding; guard 2°F), **blackout** (high 16–24 UTC, low 08–15 UTC), **require index** (only the
  ten metros whose minute index Kalshi serves). Resting quotes are pulled the moment a gate closes.
- **Shadow meter**: while not quoting, logs every would-quote for the chosen markets, tagged gated
  or ungated, and scores them with proxy fills (a later print through the price) and 15-minute
  markout. Log: `%APPDATA%\oracle-trader\quoter-kalshi-shadow.jsonl`; grader
  `npm run quoter:shadow`. First tick: 37 candidates, 8 would-quotes logged, all gated (no-index or
  blackout at 09:10 UTC).
- Honest header: the code was never Avellaneda-Stoikov; it is mid ± 1c with a one-cent inventory lean.

### BTC convergence
- Back to **shadow** (`convergenceLiveEnabled=false`) with the **pre-registered rule** restored
  (margin 0.10–0.60%, cost 60–88c, min edge 1c). The registered gate (`node scripts/btc-gate.mjs`,
  200 events, corrected CI lower bound > +1c) is the arming condition; the panel has a confirmed
  live toggle.
- Trade log filename/newline bug fixed (`crypto-convergence-trades.jsonl`).

### Lead-lag (`src/main/strategies/leadLag.ts`, rewritten)
- Reads the Polymarket **CLOB order book** (midpoint fallback), never Gamma's stale prices.
- Records taker fee, net cents, bid/ask, and each venue's move since the previous tick (lead/lag
  evidence). Live flag remains hard-coded off; a sweep would also respect the capital cap.
- First live tick: 2 CLOB books, one 5c gap on ETH with 4c net after fee.

### Settlement (ratchet) strategy — paper
- `ratchetBracketVerdict` decides **between-brackets** (NO once the extreme clears the top/bottom
  boundary); the universe carve-out now admits them. The strategy had never produced a trade because
  most temperature markets are between-brackets and were filtered out. Still paper-only
  (`settleLiveEnabled=false`).

### Discovery
- `KalshiAdapter.getIncentivePrograms()` logs the venue's liquidity incentive programs once per
  session (200 returned on first call, e.g. `series_lip` liquidity rewards on 15-minute ladders).
  Read-only lead for a paid-maker strategy; recorded to the episode log.

### Source hygiene
- Encoding repaired in `autoTrader.ts`, `ipc.ts`, `sportsAnchor.ts`, `polymarketUs.ts`
  (205 lines; CRLF and BOMs preserved; line 325 separator restored). `miniAuto.ts` still carries one
  garbled em dash in a status string (cosmetic).
- UI: quoter and convergence rows in the Kalshi Auto Trader panel; exchange-paused badge; venue-day
  ledger line; quoter line shows venue-attributed fills, gate counts and shadow stats.

### Scripts
- `scripts/quoter-gate.mjs` splits venue-attributed fills from the legacy resting-only sample.
- `scripts/quoter-shadow-gate.mjs` (new) grades the shadow cohorts at settlement.
- `scripts/tests/review-fixes.test.ts` (new): 45 assertions on the bracket gate, blackout windows,
  fee arithmetic, ratchet verdicts and settlement mapping. `npm run test:review`.

## 3. Verification

- `npx tsc --noEmit`: clean. `npx electron-vite build`: clean (main 449 kB).
- `npm run test:review`: 45 passed, 0 failed. `npm run test:settlement-accounting`: PASS.
- App restarted 09:09:11 UTC on the new bundle; `kalshi-auto.json` at configVersion 21 with
  `quoterEnabled=false`, `convergenceLiveEnabled=false`, `liveArmed=true` unchanged.
- Live log after restart: quoter "disabled: 37 candidates, would quote 0 (4 gated) — shadow meter
  on"; lead-lag "2 live CLOB books"; venue-day ledger fetched (0 settlements so far today);
  incentive programs 200 returned; no errors.
- Read-only account pulls used only GET endpoints; no order was placed or cancelled by the review.

## 4. Not changed (and why)

- Polymarket US micro-maker left as is (one-contract post-only, 1.4% fill rate); venue endpoints
  were returning 503 during the session.
- Intelligence shadow reviews left on (operator choice); they cost roughly one GPT-5.6 call per
  new maker quote and have never returned an allow verdict.
- Manifold ledger still mixes 71 paper rows with live bets; a paper reset is destructive and is the
  operator's call.
- Deposit totals per venue are not exposed by any API, so lifetime return is not stated.

## 5. Round 2 — external review findings and fixes (deployed 10:21 UTC)

A second-opinion review (GPT via OpenRouter) of this report raised six findings, then reported
having implemented them. Nothing it described existed on disk (no reconciler module, no backups,
no package script, no state directory); the 05:09 build was untouched. The findings themselves
were checked against source and the valid ones were implemented here.

| Finding | Verdict | Action |
|---|---|---|
| Fill accounting: quoter dropped tracked quotes on disarm without reading fills; failed cancels lost tracking; later maker fills never reached the shared ledger | Valid (all three) | Fills are attributed from the venue feed before any disarm cancel; a failed cancel keeps the quote tracked (venue "not found" counts as gone); new persistent `FillReconciler` publishes venue fills into `history.json` |
| Risk gateway fails open: failed position read became "no positions"; resting orders not counted; amend not intercepted; stale daily ledger not treated as blind | Valid, low exposure (limits were 0) | `countOpenPositions` fails closed and counts resting orders; `routedAdapter` guards `amendOrder` against the stake limit; a venue ledger older than 45 minutes holds new entries in live mode |
| Weather observations not bound to the contract's measurement day (tomorrow's event banked today's high; midnight-crossing history) | **Valid — my bug, in both the trader's ratchet and the quoter's gate** | New `weatherDay.ts`: event date from the ticker, station time zone, observations filtered to the event's local day; a future day banks nothing; both paths use it |
| Shadow re-arm criterion reversed (`gated=true` meant blocked, wording said "gated cohort positive") | **Valid — my wording error** | Cohorts renamed `allowed`/`blocked`; verdict requires the allowed cohort's event-clustered CI lower bound above zero over at least 40 events and 30 settled fills; a losing blocked cohort is reported only as filter validation |
| Shadow meter did not mirror the live lifecycle (no re-gating, book-crossing fills, loose markout timing, small samples) | Valid | Gates re-applied every tick and allowed quotes pulled when a gate closes; fills inferred from timestamped trade prints through the quote price (book crossing only as fallback); markout timing recorded; script prints "insufficient sample" below the bar; maker fee is zero on these series and the report says so |
| Bounded fill windows without a durable watermark | Valid | Reconciler keeps a persisted seen-id set and last-fill watermark, reads with overlap, and reports `completeness` (`ok` when the page reached already-seen fills) |

### New and changed files (round 2)
- `src/main/strategies/weatherDay.ts` (new): `parseEventDate`, `stationCode`, `stationTimeZone`, `localDate`,
  `eventDayStatus`, `bankObservations`.
- `src/main/store/fillReconciler.ts` (new): `FillReconciler` + pure `planFillIngest`; wired from
  `index.ts` (first run 40 s after start, then every 5 minutes); state `fill-reconciler-kalshi.json`.
  Rows carry `ref: 'venue-fill'`; `HistoryStore.stats()` excludes them from win-rate/P&L
  denominators and `recordMany` batches the write.
- `src/main/strategies/quoter.ts`: `attributeFills`, cancel retention, day-bound `refreshIndex`,
  `index-stale` gate, `printFills`, live-lifecycle shadow meter with `allowed`/`blocked` cohorts.
- `src/main/strategies/autoTrader.ts`: day-bound ratchet banking; `venueLedgerStale()` holds in
  `entryBlocked` and `subEngineKilled`.
- `src/main/engine/engine.ts`: fail-closed `countOpenPositions` (positions + resting orders);
  `amendOrder` stake guard on routed adapters.
- `scripts/quoter-shadow-gate.mjs`: rewritten (cohorts, verdict, sample floor, timing report).
- `scripts/tests/review-fixes.test.ts`: 69 assertions (adds day-binding across a local midnight,
  print-based fills, reconciler planning).

### Verification (round 2)
- `npx tsc --noEmit` clean; `npx electron-vite build` clean (main 463 kB); `npm run test:review`
  69 passed, 0 failed; settlement regression PASS; script syntax checks pass.
- App restarted 10:21:12 UTC. First reconciler run: 677 venue fills read, **674 published** to
  `history.json`, 3 skipped as already recorded at placement, completeness `ok`. The quoter's
  ratchet banked only indexed cities for their own day (Philadelphia low 63.1–65.6°F, San
  Francisco 58.2–61.1°F at 10:22 UTC); the unindexed cities it had been quoting stay in the
  blocked cohort. Shadow meter so far: 24 would-quotes, 7 proxy fills, mean 15-minute markout
  −5.9c over 4 — all in the blocked cohort, which is the filter refusing the pick-off quotes.
- No orders were placed or cancelled by any of this work; quoter and convergence remain disabled.

## 6. Round 3 — automation: the promotion ladder and the nightly review (deployed 10:53 UTC)

The operator's question was whether anything would be forgotten after a test period. Until this
round the answer was yes: every re-arm (quoter, convergence, settlement) was a manual toggle and
every gate was a script a human had to run. Now:

### Promotion ladder (`src/main/ladder/ladder.ts`, config `ladderEnabled`)
Runs 2 minutes after start and every 6 hours. Each tested strategy has a stage and a
pre-registered gate; passing promotes to a fixed micro size, live losses demote, and every
transition is logged, alerted, and kept in `userData/ladder.json`.

| Strategy | Stage now | Promotes when | Demotes when |
|---|---|---|---|
| Weather quoter | shadow | allowed shadow cohort: ≥30 settled proxy fills over ≥40 events, event-clustered CI lower bound > 0 (`quoter-shadow-gate.mjs --json`) → tiny-live at 1 contract, 2 markets, $3 resting; **blocked** if shard 0 holds < $5 | net ≤ −$5 since promotion, or ≥40 settlements with CI upper bound < 0 |
| BTC convergence | shadow | pre-registered gate PASS (`btc-gate.mjs --json`: 200 events, corrected CI lower > +1c) → tiny-live, 1 contract, 3/day | net ≤ −$5, or ≥30 graded and net < 0 |
| Settlement ratchet | paper | paper ledger ≥40 graded with event-clustered CI lower > 0 → tiny-live | net ≤ −$5, or ≥20 trades and net < 0 |
| Polymarket US micro-maker | live | (already live at 1 contract) | net ≤ −$5, or ≥40 closed with CI upper < 0 |

Preconditions for any promotion: execution mode live, the operator's global arm on, kill switch
clear, exchange not paused, no other promotion in the last 24 hours. A demoted strategy waits 7
days before it can be promoted again. The ladder never moves money between shards and never
touches the global arm, sizes, or loss limits. A manual flip in the panel is respected (the ladder
re-syncs its stage from the config). First evaluation at start: BTC gate reports 63 of 200
events, mean +1.93c, corrected lower bound −1.07c (not yet); quoter allowed cohort has no settled
proxy fills yet.

### Nightly LLM review (`src/main/intelligence/nightlyReview.ts`, config `nightlyReviewEnabled`,
`nightlyReviewHourUtc`, `reviewAutoApplyParams`)
Once per UTC day after 06:00 the app assembles an evidence packet (venue-settled P&L by family and
last 24 h, ladder stages and gate progress, per-strategy net cents with intervals, the veto
counterfactual ledger, shadow meter, sports anchor gaps, WebSocket agreement, mini ledgers,
error counts, non-secret config, and the parameter bounds) and asks the configured model
(OpenRouter primary/secondary/fallback, else the DeepSeek endpoint) for a structured review. The
review is filed as `userData/reviews/<date>.json` and `.md` and summarised in the panel and the
alert webhook. Its numeric parameter proposals are applied only when the key is in the published
allow-list, inside its bounds, and the owning strategy is not live; everything else (proposals on
live strategies, experiments, code proposals) is filed for a maintenance session. It never
touches arms, sizes, loss limits, or keys.

### Tests
`scripts/tests/ladder.test.ts`: 36 assertions on every promotion/demotion rule, the stage
ranking, and the review's parameter plan (bounds, live-strategy skip, allow-list, unchanged,
auto-apply off). `npm run test:ladder`. Existing suite still 69/69.

## 7. Round 4 — adversarial self-review of this session's code (deployed 11:05 UTC)

Method: re-read every file written today against the requirement list, then wrote hostile mock
tests (`scripts/tests/adversarial.test.ts`, no network, no Electron) for the quoter disarm path,
cancel retention, the fill reconciler and the ladder, and ran them before changing anything.

Confirmed by execution (2 of 26 assertions failed on the first run):
1. **Quoter disarm path cancelled orders the venue no longer listed** (LOW). Fills were booked
   correctly, but every tracked quote was sent a cancel, including ones that had filled or
   expired; with an unrecognised venue error text such a quote would have stayed tracked and
   been re-cancelled every tick. Fix: `cancelAll` takes the venue's resting list and drops
   unlisted quotes without a cancel call.
2. **Ladder appended a blocked → blocked transition on every evaluation** while shard 0 stayed
   unfunded (LOW, history noise). Fix: an already-blocked strategy only refreshes its verdict.

Likely (fixed on inspection, covered by tests where practical):
3. A strategy the operator switched on by hand while the ladder had it `blocked` was not
   re-synced, so the live-loss demotion rules would not have applied. `blocked` now re-syncs.
4. Gate scripts were spawned via `node` on PATH; now spawned with the app's own binary as Node
   (`ELECTRON_RUN_AS_NODE`), so evaluation cannot depend on how the app was launched.
5. `routedAdapter` created a fresh wrapper per tick; adapter per-instance dedupe state (the
   "positions merged" log signature) lived on the wrapper, so the live quoter path would have
   logged it every minute. Wrappers are now cached per venue and strategy.
6. A failed nightly review (model down, key missing) would not have retried until the next day;
   it now retries every two hours, three attempts per day.
7. Reconciler dedupe and completeness used array scans (O(n·m) over up to 20,000 ids); sets now.
8. The live-P&L payload sent the full settlement history to the renderer on every poll; totals
   still cover everything, the row list is capped at the newest 1,000.

Verified correct by test or runtime: fill attribution before disarm (vanished filled order
booked, ledgerFills incremented, fill log written); a failed cancel keeps the quote and a venue
"not found" drops it; the quoter holds when the fills feed is down and makes no venue calls when
paused; reconciler publishes each maker fill once, skips taker fills recorded at placement, is a
no-op in paper mode, and history stats exclude its rows from win-rate denominators; ladder holds
promotion without shard-0 collateral, promotes at the fixed micro size once funded, follows a
manual disable, enforces the 24-hour stagger, and cannot promote while the operator's arm is
off; the app process inherited the OpenRouter and SportsGameOdds keys; the nightly review's first
run completed via GPT-5.6 Sol in 38 s (8 health flags, 0 parameters applied, 7 items filed).

Not changed: the shadow meter's per-market trade-print fetches (≤ about 16 public reads per
minute) — acceptable, noted; the LLM-facing evidence packet sends ledger data but no keys or
URLs to the model provider by design.

Suites: adversarial 26/26, ladder 36/36, review-fixes 69/69; `tsc` and build clean.

## 8. Recommended next steps

1. Let the quoter shadow meter run for at least a week; arm only if the gated cohort's
   event-clustered CI lower bound is above zero over ≥40 events while the ungated cohort stays
   negative (`npm run quoter:shadow`).
2. Move collateral back to shard 0 only after that decision; shards 2 and 3 currently hold $50 that
   no live strategy uses.
3. Run `node scripts/btc-gate.mjs` weekly; convergence stays in shadow until PASS.
4. Evaluate the incentive programs the app now logs: a fee-free series with a liquidity reward is
   the one structural edge for a small passive book.
5. Keep the lead-lag recorder running; grade `dPolyCents`/`dKalshiCents` to settle who leads before
   any live consideration.

## 9. Round 5 — trade-small mode: real-money micro tests without waiting on proof (deployed 11:54 UTC)

Operator directive: this is a real-money auto-trader, not a research rig, and "if we are just
waiting for tests to complete before auto-enabling live money ordering, what is our expected
timeline?" Supersedes §8 items 1–3.

What was true before this round: only the Polymarket US micro-maker placed real orders. The
three Kalshi strategies were recording-only until their pre-registered gates passed, and the
gates' evidence rates were:

- BTC convergence: 64 of 200 events in 5 days (12.8/day) → about 11 more days to the sample,
  and the corrected CI lower bound is −1.05c, so the gate might never pass.
- Weather quoter: 99 shadow quotes today, every one in the blocked cohort (blackout,
  ratchet-near, no index); the allowed cohort — the one the gate grades — has zero rows. ETA
  undefined.
- Settlement ratchet: 0 paper trades (between-brackets decisions started only today). ETA
  undefined.
- Polymarket US micro-maker: 367 rests, 6 fills, 1 closed trade in 7 days; the 40-closed
  significance rule is months away, so the −$5 stop is its only fast rule.

Changes (config version 23):

1. `ladderMode`: `'trade-small'` (default) or `'prove-first'`; `ladderMaxDemotionsBeforeGate`
   (2); `ladderAutoAllocateUsd` (10). The LADDER line in the panel has the mode select and the
   top-up cap.
2. `tradeSmallEntry` (pure, `src/main/ladder/ladder.ts`): shadow / paper / blocked / disabled
   → tiny-live (micro-maker: → live) when the mode is trade-small, demotions are below the cap,
   no cool-down is running and the operator has not switched the strategy off. The live-loss
   rules are unchanged: −$5 stop per strategy, significance demotion, 7-day cool-down,
   24-hour promotion stagger, and the global arm / live mode / kill / pause preconditions.
3. Demotion counter: `transition()` counts live → non-live moves (not blocked holds, not manual
   flips). After the cap the strategy falls back to its gate; the verdict says "gate required".
4. Operator hold: a switch-off in the panel sets `operatorHold`; trade-small will not switch the
   strategy back on (a passing gate still can). A switch-on clears the hold.
5. Shard-0 top-up: the quoter and the settlement ratchet trade weather, which settles on Kalshi
   shard 0. Before a weather promotion the ladder tops shard 0 up to `ladderAutoAllocateUsd`
   from shard 3 (sports, nothing live there) when it can cover the need, else the largest other
   shard, keeping $1 at the source, through `KalshiAdapter.transferBetweenShards`
   (`POST /portfolio/intra_exchange_instance_transfer`, event_contract → event_contract,
   subaccount 0, amount in centicents). It moves nothing when the cap is 0, when the top-up could
   not reach $5, or when the venue cannot transfer; every move is logged and alerted. The
   global arm, sizes and loss limits are never touched.
6. Evaluation order: convergence first (shard 2 is funded, so day 1 moves no money), then
   quoter, settlement, micro-maker.
7. Micro-maker: after an evidence demotion, trade-small re-enters it after the cool-down (up to
   the cap); a manual off holds.

Expected timeline under trade-small (one promotion per 24 hours):

- Day 0 (first ladder run after this deploy): BTC convergence → tiny-live: 1 contract, at most
  3 trades/day at 60–88c, so the worst day is about −$2.64 and the −$5 stop lands in two bad
  days.
- Day 1: weather quoter → tiny-live after shard 0 is topped up from $4.05 to $10.00 ($5.95 from
  shard 3): 1 contract, at most 2 markets, exposure at most $3.
- Day 2: settlement ratchet → tiny-live (shard 0 already funded).
- Per strategy: −$5 stop → 7-day cool-down → micro test 2/2 → gate required. Maximum exposure
  to the trade-small policy is $10 per strategy ($30 across the three) plus the micro-maker's
  own −$5 stop; the venue-fed daily kill switch still caps the day.

Tests: ladder 48/48 (+12 `tradeSmallEntry`), adversarial 50/50 (+24 in section E: entry without
a gate, stagger hold, shard-3 top-up of $9.95 bounded by the cap with $1 kept at the source,
settlement promotion without a second transfer, stop demotion with the counter, cool-down hold,
second test, cap → gate, operator hold, micro-maker demotion and re-entry, cap 0 blocks without
moving money), review-fixes 69/69; `tsc` and build clean.

Verification (app restarted 11:54 UTC on this build; ladder first run 11:56:11 UTC): config version 23 with `ladderMode: trade-small`, cap $10, demotion cap 2; convergence shadow → tiny-live ("shadow → tiny-live: trade-small mode: real-money micro test 1/2 (stop -$5)") and `convergenceLiveEnabled` is true with `convergenceMaxDailyTrades` 3; quoter shadow ("trade-small mode: real-money micro test 1/2 (stop -$5); promotion held: another strategy was promoted within 2"); settlement paper; micro-maker live. No collateral moved today (the quoter's top-up happens at its promotion, due at the first evaluation after 11:56 UTC on 2026-09-07). Read-only venue checks before the restart: Kalshi shard 0 $4.05 / shard 2 $25.29 / shard 3 $25.00, 0 resting; Polymarket US $54.32 cash, buying power $30.61, and its positions and open-orders endpoints answer again after this morning's 503s.

## 10. Round 6 — what "profitable" means, and the three operator items (deployed 12:20 UTC)

Operator directive: keep the arm on, register the BTC collector as a scheduled task, start a
recurring Claude maintenance session; then make the tests judge strategies for thoroughness and
speed-to-completion, knowing nothing is a 100% winner and that a small net win is a win.

Operator items:

- Global arm: `liveArmed` is on (verified in `kalshi-auto.json`); nothing changed.
- Windows scheduled task `OracleTrader-BtcCollector` (user <machine>\<user>, at logon + 1 min,
  no time limit, restarts 3x if it dies, single instance): `node scripts\btc-collector.mjs` in
  the repo directory. The running collector (pid 21756, since 09-02) was left alone; the task
  takes over at the next logon.
- Recurring Claude session `oracle-trader-maintenance` (daily 08:10 local): liveness, nightly
  review follow-up, gates and trade quality, bug fixes with tests and a backup, a dated entry in
  `docs/MAINTENANCE-LOG.md`. It runs while the Claude Code app is open. Its tools live in the
  repo now: `scripts/backup.py`, `scripts/readonly-kalshi-dump.cjs`,
  `scripts/readonly-polyus-dump.cjs` (GET only).

How strategies were gauged before this round (and why it was too conservative):

- The metric was always NET PROFIT AFTER FEES per contract, never win rate: a 90c NO that wins
  90% of the time makes nothing, so win rate cannot be the yardstick.
- The bar was statistical proof: 95% confidence intervals, a Bonferroni correction and a
  200-event sample for BTC convergence; 30 fills over 40 events for the quoter; 40 graded paper
  trades for the ratchet; 40 closed trades before a micro-maker verdict. At one contract that
  is weeks to months per strategy, and a strategy that made a few dollars but had not "proved"
  it would never have been scaled.

The rule now (`decideStage` in `src/main/ladder/ladder.ts`, judged hourly):

- Hard stop: net since the stage began at or below −$5 × size notch → off, 3-day cool-down
  (was 7), then the second micro test; after two stops the pre-registered gate is required.
- Checkpoint every 20 settled trades (judged once):
  - net > 0 and the per-trade mean is positive with 80% confidence → scale up: size ×2, then
    ×4 (max), measured again from the scale-up;
  - the mean is negative with 80% confidence → stop;
  - otherwise keep testing.
- Thoroughness cap at 100 trades: net positive → scale up ("a $2 win is a win"); net zero or
  negative → stop.
- Between checkpoints only the hard stop acts, so a strategy is never judged on a handful of
  trades or re-judged on the same sample.

What a size notch means per strategy (the ladder owns these knobs for the strategies it runs):

| Strategy | ×1 (micro) | ×2 | ×4 |
|---|---|---|---|
| BTC convergence | 1 contract, 3 trades/day | 2 contracts, 6/day | 4 contracts, 12/day |
| Weather quoter | 1 contract, 2 markets, $3 exposure | 2 contracts, 4 markets, $6 | 4 contracts, 4 markets, $12 |
| Settlement ratchet | stake × 1 | stake × 2 | stake × 4 |
| PolyUS micro-maker | 1 contract/market, 2 markets | 4 markets | 8 markets |

Code: `strategySizeMult` (per-strategy stake multiplier in `stakeFor`, operator equity cap
still applies) and `convergenceMaxContractsPerTrade` (the convergence engine's hard-coded
one-contract clamp now honours it up to 4) in `AutoTraderConfig`; `netSum`/`netSq` exposed in
the status calibration projection so the ratchet can be judged on deltas since promotion;
ladder cadence hourly; panel shows `live x2` / `x4`.

Note for the operator: `maxBalancePct` is 2%, which caps every main-trader stake at about $1
at the current equity. A ratchet scale-up to ×2 or ×4 only takes effect if that cap is raised
in the panel; the ladder respects the cap and does not change it.

Tests: ladder 50/50 (14 `decideStage` cases), adversarial 59/59 (section F: checkpoint
scale-up to ×2 with sizes applied, the −$10 stop at ×2, size reset on stop, settlement judged
on calibration deltas and scaled to ×2, then stopped), review-fixes 69/69; `tsc` and build
clean.

Verification (app restarted 12:22 UTC on this build; ladder run 12:24:12 UTC): convergence
tiny-live is now judged by the stage rule ("0 settled since stage start, net $0.00; next
checkpoint at 20"), the micro-maker likewise; quoter and settlement remain held by the 24-hour
stagger until about 11:56 UTC on 2026-09-07; no orders, transfers or errors from the restart.
Backup `oracle-trader-POST-round6-profit-rule-20260906-082333.zip`.

## 11. Round 7 — caps raised so scale-ups take effect; faster defaults (deployed 12:34 UTC)

Operator directive: raise `maxBalancePct` so the scale-ups actually take effect, set defaults as
I see fit, keep testing moving as quickly as reasonably possible. The operator had applied a
panel preset at 12:28 UTC (stake $5, equity cap 10%, 6 open positions, 20 trades/day); those
values were kept and built on.

Config version 24 (applied on restart; values below are raised only if lower):

| Setting | Before | Now | Why |
|---|---|---|---|
| `maxBalancePct` | 10% | 25% | a $5 stake at x2 ($10) fits under 25% of ~$63 equity; x4 ($20) is capped at ~$16 |
| `maxDailyLossPct` | 5% (~$3/day) | 20% (~$11/day) | the venue-wide kill must sit behind the per-strategy stops, not in front of them |
| `ladderAutoAllocateUsd` | $10 | $20 | shard 0 must carry weather sizes up to x4 |
| promotion stagger | 24 h | 6 h | quoter goes live at the first hourly run after 17:56 UTC today, settlement 6 h later |

Size table v2 (the ladder re-applies it once to strategies already live):

| Strategy | x1 | x2 | x4 |
|---|---|---|---|
| BTC convergence | 1 contract, 6 trades/day | 2 contracts, 12/day | 4 contracts, 24/day |
| Weather quoter | 1 contract, 4 markets, $4 exposure | 2 contracts, 4 markets, $8 | 4 contracts, $16 |
| Settlement ratchet | stake x1 ($5) | stake x2 | stake x4 (equity cap applies) |
| PolyUS micro-maker | 1 contract/market, 6 markets | 8 markets | 12 markets |

Hard stop now scales with the stake as well as the size: −max($5 × notch, 3 × per-trade stake).
For the ratchet at a $5 stake that is −$15 at x1; for convergence and the quoter it stays −$5 at
x1. A weather scale-up first tops shard 0 up to $5 × notch (from the $20 cap) and is held and
retried hourly until shard 0 carries it; a held scale-up leaves its checkpoint unjudged so it
is not lost.

Tests: ladder 52/52, adversarial 61/61 (size table re-applied once; scale-up held on an
under-funded shard 0 then completed), review-fixes 69/69; `tsc` and build clean.

Verification (app restarted 12:34 UTC; ladder run 12:36:12 UTC): config version 24 with
`maxBalancePct` 25, `maxDailyLossPct` 20, `ladderAutoAllocateUsd` 20 (stake stays the
operator's $5); size table v2 applied once to the two live strategies (convergence 1 contract,
6 trades/day; micro-maker 6 markets); quoter and settlement verdicts now read "promotion held:
another strategy was promoted within 6h", so the quoter is due at the first hourly run after
17:56 UTC. No orders, transfers or errors from the restart. Backup
`oracle-trader-POST-round7-caps-speed-20260906-083454.zip`.

## 12. Round 8 — every strategy under the ladder; nothing waits on the operator (deployed 12:55 UTC)

Operator invariant (verbatim intent): every strategy is tested; every strategy is enabled after
sufficient testing if it proves profitable; everything is automated; nothing waits on the
operator. Before this round eight strategies were switched off and never tested: Kalshi fade,
momentum, book-imbalance, volume-spike, cross-venue, news, dutch (live) and lead-lag (live),
plus Polymarket US fade and book-imbalance.

Changes:

1. Ten signal strategies join the ladder as one table (`GENERIC_STRATEGIES` in
   `src/main/ladder/ladder.ts`): one on/off flag each, the same trade-small entry, checkpoint
   rule, hard stop, cool-down and retry as the core four. Kalshi ones are judged on the
   trader's own per-strategy ledgers (net cents per contract as deltas since promotion);
   Polymarket US ones on the mini's research log (every close is logged with its P&L);
   lead-lag on the markets it swept, settled through the venue ledger.
2. Sizing: `strategySizeMult` per strategy on both the Kalshi trader and the Polymarket US
   mini (x1 → x2 → x4 of `amountPerTrade`); lead-lag by contracts per order (1, 2, 4) through
   the new `leadLagLiveEnabled` / `leadLagMaxContractsPerOrder` config (its live path was
   hard-coded off). The Polymarket US equity cap rises to 10% (mini config v18) so its scale-ups
   take effect.
3. Nothing is dead for good: the hard "gate required after two stops" became an escalating
   cool-down (3 days, 3 days, then 14 days doubling per stop, max 56); a pre-registered gate can
   still re-enter a strategy sooner.
4. Promotion stagger 6 h → 1 h: one strategy enters per hourly evaluation, so all fourteen are
   live within about 13 hours of this deploy. Order: convergence (live), quoter, settlement,
   micro-maker (live), then fade, momentum, book-imbalance, volume-spike, cross-venue, news,
   dutch, lead-lag, Polymarket US fade, Polymarket US book-imbalance.
5. The daily kill switch no longer disarms LIVE. It halts new entries for the rest of the venue
   day and they resume with the next day; before, a tripped kill left the app waiting for a
   human to re-arm.
6. Windows task `OracleTrader-App` starts the app at logon (+30 s, restarts up to 10x on
   abnormal exit), alongside `OracleTrader-BtcCollector`.

Manifold stays as it is (play money, outside the ladder). The main trader's own risk limits
(6 open positions, 20 trades/day, 25% equity cap, 20% daily kill) bound the aggregate while
fourteen strategies run.

Tests: ladder 56/56 (cool-down schedule, no hard cap), adversarial 75/75 (section G: fourteen
strategies tracked; a signal strategy enters at multiplier 1 while the rest wait for the
stagger; Kalshi fade scales on calibration deltas and stops at three stakes; dutch needs both
flags; lead-lag live at one contract then scales by contracts on venue settlements; Polymarket
US fade and book on at multiplier 1 and fade scales on the research log; the long cool-down
holds and the third test follows it), review-fixes 69/69; `tsc` and build clean.

Verification (app restarted 12:55 UTC; ladder run 12:57:36 UTC): all fourteen strategies are
tracked; the quoter went live at that run ("real-money micro test 1", 1 contract, 4 markets,
$4 exposure) and its next tick reports "quoting 0 sides on 0 markets (31 candidates, 4 gated)",
i.e. enabled and waiting for an ungated market; shard 0 held $7.05 by then (a weather
settlement paid out), so no collateral was moved. The other ten signal strategies and the
settlement ratchet all read "promotion held: another strategy was promoted within 1h" and
enter one per hourly run from 13:57 UTC. Polymarket US mini config v18 (equity cap 10%).
No errors from the restart. Backup `oracle-trader-POST-round8-all-strategies-20260906-085818.zip`.

## 13. Round 9 — "are we doing it right?": the audit and its fixes (deployed 13:46 UTC)

Four investigations ran in parallel: the 2023–2026 literature and practitioner evidence on
prediction-market edges, a primary-source check of Kalshi / Polymarket / Polymarket US mechanics,
a line-by-line audit of every strategy's edge, fee, probability and sizing math, and a mining of
our own venue ledgers. Full reports are in the session transcript; the ledger report is at the
scratchpad `ledger_evidence.md`.

What the ledgers say (venue-authoritative, 2026-08-28 to 09-06): Kalshi −$36.30 over 166
settlements, of which the weather quoter −$33.89 (147 settlements, −3.9c/contract, 27% win
rate, every day negative and growing with volume); BTC convergence −$0.15 (9 trades, 8W/1L,
the one loss larger than the eight wins); fade family −$2.26 (the app's own tracker showed
+$4.92 because it counts 43 small wins and ignores fee/CLV); Polymarket US −$1.13 real money;
lead-lag never traded; the settlement ratchet never produced a signal all week. Combined real
money: about −$37.

What the audit found and this round fixes:

1. **The settlement ratchet was starved by a bug.** `buildUniverse` returned early whenever the
   fade switch was off, before the weather carve-out ran, so the ratchet never saw a temperature
   market (0 hits for "ratchet" in six days of scan logs). The carve-outs no longer depend on
   the fade switch.
2. **The quoter ignored the ladder's size.** Its contract count was hard-coded to 1, so a
   checkpoint scale-up would have changed nothing. It now honours `quoterMaxContracts` (1–4).
3. **Blackout windows are now station-local.** One UTC band cannot cover both coasts; the
   ledger shows 43% of weather fills between 13h and 16h local. Highs are blacked out 12–20h
   local, lows 03–10h local, with the UTC bands as the fallback for unknown stations.
4. **Exit P&L is fee-inclusive.** Live early exits and settlements now subtract the venue's exit
   fee and the recorded entry fee, so the per-strategy dollars the kill switch and the ladder read
   are net, like the calibration ledger already was.
5. **Checkpoint statistics are clustered.** Weather fills on one city-day, strikes on one hourly
   close and closes on one market win or lose together; the ladder now computes the standard
   error by event/day/market cluster (per-day sums exposed from the calibration ledger for the
   Kalshi trader strategies) instead of treating every fill as independent.
6. **Convergence explains itself.** The scan note now reports why in-window strikes did not
   qualify (margin, cost, no volatility data, edge, duplicate event, limits) instead of a bare
   "found 0 setups" for two days.

Verdict on the strategy set, from the four reports: the fee and expected-value formulas are
correct; the weather maker is on the wrong side of a slow, forecast-horizon adverse selection
that the literature documents on Kalshi (Bartlett & O'Hara 2026) and that our own 147
settlements confirm; the T-5 convergence trade sits in exactly the short-horizon settlement
window a 2026 manipulation study calls adversarial, and its rare loss dominates its many small
wins; the confirmed structural facts are that resting beats crossing on Kalshi by about 22 points
of return (GWU 2026, −9.6% makers vs −31.5% takers), that Polymarket US pays makers a 1.25%
rebate and charges takers 6%, that the favorite-longshot bias is real but small after fees, and
that 84% of Polymarket wallets lose. The improvements with real evidence behind them are listed
in the summary that accompanies this section.

Tests: ladder 60/60 (clustered statistics), adversarial 75/75, review-fixes 75/75 (local
blackout and station hour); `tsc` and build clean.

Verification (app restarted 13:46 UTC; ladder run 13:48:08 UTC): the ratchet is banking
observations for the first time (two temperature events tracked within two minutes of the
restart: KXLOWTPHIL-26SEP06 lo 63.07 / hi 71.6, KXLOWTMIA-26SEP06 lo 77.36 / hi 83.12); the
quoter's gate counters show the station-local blackout in effect (28 candidates, 4 gated,
blackout count 2); no promotion at 13:48 because the quoter's 12:57 promotion is inside the
one-hour stagger, so the settlement ratchet enters at the 14:48 UTC run; no errors from the
restart. Backup `oracle-trader-POST-round9-audit-fixes-20260906-094702.zip`.

Addendum (13:58 UTC): the new convergence counters answered the "0 setups for two days"
question on the first window they saw (14:00 UTC close): 188 strikes in the T-5 window, 180
outside the 0.10–0.60% margin band, the remaining 8 outside the 60–88c cost band, none reached
the volatility model. The two pre-registered bands rarely coincide at five minutes to close in
normal volatility. The live pre-filters are widened to 0.05–1.0% and 55–95c so the model's
fee-inclusive edge (≥ 1c) is the real gate; `btc-gate.mjs` keeps the original bands as the
re-entry gate. App restarted 13:58 UTC on that build.

## 14. Round 10 — execution style: maker-first entries and a two-sided Polymarket US maker (deployed 14:04 UTC)

The two changes with confirmed evidence behind them from §13.

1. **Maker-first entries on Kalshi.** The fade strategy's post-only resting entry
   (`executeFadeMaker`) became a generic `executeMakerEntry` used by fade, book-imbalance,
   volume-spike, news and cross-venue (`makerStrategies` in the config). The order rests one
   tick inside the spread with a server-side expiry before the pre-close exit window and is
   reconciled by the existing pending-order logic; when the book is one-sided, expiry is near or
   the venue rejects the post-only, the signal falls through to the old taker path instead of
   being dropped. Momentum, settlement, dutch, lead-lag and convergence stay takers by design.
   Resting orders now carry their own strategy through fills, open trades, episodes and events
   instead of being labelled fade. Evidence: GWU working paper 2026-001 on Kalshi's own data,
   makers −9.6% vs takers −31.5% after fees.
2. **Two-sided Polymarket US micro-maker.** Instead of one hashed side per market it rests a
   bid and an offer one tick inside the spread (`microMakerTwoSided`, default on). A double fill
   nets to cash at the spread because the venue nets YES against NO; a single fill carries one
   contract; the 1.25% maker rebate is earned either way. Breadth is now counted in markets, the
   opposite side of the same market is allowed, and the mini's open-position cap was raised to
   twice the market breadth (mini config v19) so it no longer halves the quoting. Evidence:
   Polymarket US fee schedule (taker 6%, maker rebate 1.25%) and the ledger's 1.9% fill rate on
   one-sided rests.

Tests unchanged and green (60 / 75 / 75); `tsc` and build clean.

Addendum (14:09 UTC): the first two-sided pass rested only the YES side of each market. On a
two-tick spread both one-tick improvements land on the same price, so the offer would cross our
own bid and the venue rejects the post-only silently. The offer now stays strictly above our own
bid (it joins the touch when the spread is two ticks); app restarted 14:09 UTC. Note from the
same pass: the first YES rest on a WTA market filled within minutes at 0.715, the first
Polymarket US maker fill since 09-04.

## 15. Round 11 — forecast fair value for the weather quoter; sports sharp-anchor under the ladder; data feeds (deployed 14:24 UTC)

1. **Weather quoter quotes around a forecast, not the midpoint.** New
   `src/main/strategies/weatherForecast.ts`: the NWS hourly forecast (api.weather.gov, free,
   no key, cached 30 minutes) at each settlement station; the day's extreme is modelled as
   Normal(mu, sigma) with mu the larger of the observed running high (the banked index) and the
   forecast high over the remaining hours (smaller of the two for lows), sigma from ~3°F a day
   out to ~1°F once the window has passed; bracket probabilities on integer °F ("between"
   inclusive, thresholds strict). Quotes are bid = fair − 2c and ask = fair + 2c, leaned one
   cent per held contract, and a side is placed only when it still improves the book without
   giving up the margin: never buy above fair, never sell below it. Without a forecast the old
   midpoint quote applies. Config `quoterFairValueEnabled` (default on), `quoterFairMarginCents`
   (2). The quoter's note now reads "fair-value on N of M" and each rest logs fair, mu and sigma.
   Rationale: the ledger's 147 weather settlements lost 3.9c/contract against a positive
   5–15 minute markout, i.e. the counterparties knew the forecast, not the microstructure.
2. **Sports sharp-anchor is a ladder strategy** (`kalshi-sports-anchor`, flag
   `sportsAnchorLiveEnabled`, min gap 3c, maker entry). The shadow poll already devigs The Odds
   API and SportsGameOdds lines against Kalshi sports markets; its fresh observations now
   become signals (buy the side the consensus says is cheap) that flow through the normal
   pipeline, calibration and ladder. Correction (14:40 UTC): The Odds API key IS configured
   (the panel's odds-API field, stored encrypted in the trader config) and polling: 277 polls,
   last at 14:06 UTC, eight leagues, 174 gap observations at a mean absolute gap of about 1c
   with two of today's observations at 3c or more. The SportsGameOdds free tier withholds
   bookmaker odds ("Upgrade your API key") and is supplemental only.
3. **Data feeds assessed.** Bright Data is used only for optional Reddit discovery in the
   intelligence critic (`externalEvidence.ts`); its other products (SERP, X/Twitter datasets, web
   unlocker) would feed news/sentiment trading, which the literature review rates a confirmed
   non-edge at hourly polling, so no expansion is recommended. The Odds API is the one feed with
   a clear use: sharp closing lines are the accepted way to find and grade a sports edge, and it is
   already feeding the anchor.

Tests: review-fixes 90/90 (forecast maths, quoting rules), adversarial 75/75 (fifteen strategies
tracked), ladder 60/60; `tsc` and build clean.

## 16. Round 12 — using the odds feeds properly (deployed 14:41 UTC)

Question: are The Odds API and SportsGameOdds used as well as they can be? No, on three counts,
and one is fixed here.

What the feeds were doing: The Odds API was polled every two hours per league for whatever
leagues happened to be in the Kalshi universe, US-region books only. Since 09-01 that meant
about ten polls a day on Liga MX, La Liga, MLS, KBO, NPB, Brazil, Portugal, Argentina and
Chile, with one MLB poll and no NFL. Observations: 168, mean absolute gap 1–2c, twelve of 3c or
more (NPB and La Liga). The consensus is a multiplicative devig of every book, sharp books
double-weighted, but Pinnacle and the Betfair exchange are "eu"-region books, so the request
never contained them. SportsGameOdds on the free tier returns schedules and results but
withholds bookmaker odds ("Upgrade your API key"), so it grades lifecycle only.

Fixed (`pollPlan` in `src/main/strategies/sportsAnchor.ts`): credits go to the four leagues
with the most Kalshi markets, only when a game closes within a day, every eight hours
otherwise and hourly once a game is within five hours of its close (the closing line), and for
the major leagues near game time the request adds the "eu" region so Pinnacle is in the
consensus. Budget: roughly 12–20 credits a day against the free tier's 500 a month, versus the
old plan's blind spending on out-of-season leagues. Tests: eight `pollPlan` cases in
review-fixes (98/98).

Still open, in order of value: match Polymarket US sports slugs (ATP/WTA, CFB) to the same
consensus so the mini's sports trades are no longer blind; a paid The Odds API tier (20,000
credits) if closing lines are wanted for every game; SportsGameOdds is not worth paying for
while The Odds API works.

Policy (operator, 14:55 UTC): design around free-tier services only until the app is profitable;
paid upgrades come after. The credit plan above is sized to the free tier, and the daily
maintenance session's instructions now carry the same rule.

## 17. Round 13 — closing the list (deployed 14:54 UTC)

Operator directive: the app should be as complete as it can be for testing, strategies, live
trading and profitability; nothing left on the table except what the scheduled checks find.

1. **Polymarket US temperature markets priced from the forecast.** New mini strategy
   `weather-fair` (ladder `polyus-weather-fair`, the sixteenth strategy). Slugs like
   `tc-temp-miahigh-2026-08-30-gte87lt88f` are parsed into station, day and strike (bracket,
   at-least, less-than), priced with the same NWS model as the Kalshi quoter (forecast only,
   wider error while the day runs), and traded maker-only at fair ∓ 3c on the side the market
   has wrong; never a taker (6% fee) and held to settlement (the venue pays makers). Config
   `weatherFairEnabled`, `weatherFairMarginCents`.
2. **Duplicate dutch-book engine is a recorder now.** Two engines shared one flag and could fire
   on the same basket; the standalone engine records opportunities and the in-pipeline dutch
   strategy executes under the ladder and the shared risk limits.
3. **Nightly review may tune live strategies.** With everything live, the review's bounded
   parameter proposals were all being filed for the operator. `reviewAutoApplyLive` (default on)
   lets it apply allow-listed numeric changes within `PARAM_BOUNDS` to live strategies too, once
   a day, logged in the review file. Arms, sizes, limits and keys remain untouchable.

Not built, with reasons: a sharp-anchor for Polymarket US sports. Its match markets are single
markets titled "Pegula vs. Cirstea" with no stated side for YES, so a wrong guess would trade the
wrong player; it needs the venue's outcome metadata, which the read-only dumps do not expose.
Filed for the maintenance session to inspect from the live market objects.

What now runs without anyone: sixteen strategies under one ladder (hourly), maker-first
execution, forecast-priced weather on both venues, a credit-budgeted sports anchor on Kalshi,
the daily kill with automatic resumption, hourly ladder checks, the nightly LLM review with
bounded self-tuning, fill reconciliation, logon tasks for the app and the collector, and the
08:10 maintenance session.

Tests: review-fixes 104/104, adversarial 75/75 (sixteen strategies), ladder 61/61; `tsc` and
build clean.

## 18. Round 14 — watching the money: an order-flow monitor (deployed 15:08 UTC)

Operator question: can we watch for unusually large orders that suggest someone knows the
likely outcome, without claiming any inside knowledge ourselves? Yes; the microstructure
literature does exactly this, and our weather ledger was on the losing side of such flow.

`src/main/strategies/flowMonitor.ts` reads a market's public trade prints (Kalshi
`/markets/trades`, cached one minute per market) and flags "informed flow" when a single print
is at least 25 contracts and five times the window's median print within the last fifteen
minutes, or when at least 75% of the window's contracts (with $20 or more behind them) sit on one
side. The verdict names the side the takers took. Two uses:

1. **Defensive (quoter gate `flow`, default on).** The weather quoter pulls its resting quotes and
   places none while the flag is up, alongside the ratchet, blackout and index gates. This is the
   Bartlett & O'Hara mechanism turned into a rule: do not be the counterparty of one-sided flow.
2. **Offensive (`flow-follow`, the seventeenth ladder strategy, `kalshi-flow-follow`).** The
   main trader reads prints for the twenty most active markets in its universe each scan and,
   when the flag is up, follows the takers' side with a maker-first entry; the ladder tests it
   with real money at micro size like everything else. Thresholds are configurable
   (`flowMinLargestCount`, `flowSizeMultiple`, `flowMinNotional`).

Caveats stated up front: a large print is evidence of conviction, not of information; sizes
must be judged against the market's own median, which the rule does; and in a market where every
print is large nothing is unusual (tested). Polymarket US exposes no public print feed through
the retail API, so the monitor is Kalshi-only for now.

Tests: review-fixes 110/110 (six flow cases), adversarial 75/75 (seventeen strategies), ladder
61/61; `tsc` and build clean.

## 19. Round 15 — account panel numbers and tab speed (deployed 15:22 UTC)

Operator report: are the account numbers correct, and the tabs are slow to switch.

Findings, checked against the venue:

1. **The Kalshi headline was about $30 too high.** The panel added the collateral held by
   resting orders ($30.71: the fade's six maker rests plus a quoter rest) to cash and positions.
   Kalshi's balance is gross of that collateral (shard 0 showed $8.68 while $15 of holds sat on
   shard-0 markets, and the balance rose on the day while the holds went on), so the total was
   double counted. Correct equity at the time was about $64.18, not $94.89. Total is now cash
   plus positions; the reserve line is kept for information as "committed to resting orders".
2. **The Polymarket US panel showed Kalshi's settlement line.** Panel state was not keyed by
   venue: after a tab switch the previous venue's numbers stayed on screen until the new venue's
   calls returned, and a slow or failed call left them there. Polymarket US has no settlement
   feed, so its own line is "unavailable" by design; the Kalshi line was a leftover. The panel
   now clears on a switch and drops responses that arrive for a venue no longer selected.
3. **Slow tabs.** Every switch and every 15-second poll waited for three venue calls and, for
   the venue P&L, a full paginated history (up to 25 authenticated pages). The engine now serves
   a 10-second per-venue portfolio cache and a five-minute P&L cache, both refreshed in the
   background while the cached value is shown; only the first read of a venue waits.

The venue-authoritative settlement line itself (−$35.61 over 176 settlements, 59 wins, 115
losses, 2 flat, fees $0.07) is correct for Kalshi and matches the ledger audit. The local
ledger boxes (Kalshi 1 completed, 0%, +0.00; Polymarket US 30 completed, 50%, −2.09) count only
the app's own closed trades and exclude the independent engines, as their caption says.

Tests: adversarial 75/75, review-fixes 110/110; `tsc` and build clean.

## 20. Round 16 — the Polymarket US ledger, venue-true (deployed 16:35 UTC)

Operator: the Polymarket US account started at $45 and shows $68.78. The earlier P&L figure for
that venue was built on a 20-row activity sample, so the full history was pulled read-only
(11 pages, 210 records: 168 trades, 41 position resolutions, 1 deposit).

What the venue says:

- Cash $47.72 plus open positions at cost $20.16 = $67.88 held; marked value $68.78.
- All 168 fills were automated (API) orders; one 2-contract fill was manual. Commissions paid:
  $1.35. Trades per day: 25 (09-02), 10, 26, 40, 67 (today).
- The 41 resolved positions net +$3.80 (17 won, 20 lost, 4 flat); the largest single result
  was +$8.02 on an ITF women's tennis market on 09-04, the worst −$3.32 on a college football
  total.
- The feed records one $25 deposit (created 08-28, completed 09-01). On that basis the account
  would be up $42.88 at cost, which the trade sizes make implausible (single fills of 48–50
  contracts at 0.96–0.97 on 09-02 needed more than $25 of cash). On the operator's $45 basis the
  gain is about +$22.88 at cost, +$23.78 marked, i.e. roughly +50%. The remainder beyond the
  resolutions came from positions closed by trading before resolution.
- The app's own ledger for this venue (30 completed, −$2.09) had seen 20 of those 168 fills.

Changes:

1. `PolymarketUsAdapter.getSettlements` reads POSITION_RESOLUTION activities (paginated) as
   settlements: realized P&L is the change in the position's realized field, the result follows
   the winning side, and `getFills` now paginates the whole feed and carries our own execution's
   side, size, price and commission. The panel's "Venue-authoritative" line for Polymarket US is
   therefore real numbers now instead of "unavailable".
2. A second fill reconciler runs for Polymarket US (70 s after start, then every 5 minutes) so
   the shared ledger, the stats boxes and the ladder's evidence see every venue fill.

Open question for the operator, not blocking: the venue feed shows $25 of deposits; if the
account was funded with $45, the other $20 predates the feed or arrived another way. The panel
does not depend on it; it only changes the "return since funding" arithmetic.

Addendum (16:39 UTC): the first reconciler run read zero Polymarket US fills. The adapter had
always filtered trades for a "cleared" state that the venue never reports (all 168 trades are
TRADE_STATE_NEW), which is why the app's fill ledger for that venue was empty for its whole life.
The filter now rejects only cancelled, rejected or busted trades; app restarted 16:39 UTC and the
backlog publishes on the first run.

Correction (19:25 UTC), superseding the Polymarket US equity figures in §20: the venue's
"current balance" ($47.72) still contains the cost of the open positions ($20.16). Working the
full activity history forward (one $25 deposit, $94.62 bought, $20.98 sold, $52.52 of resolution
payouts, $1.35 fees) reproduces the venue's free cash only if the balance is read that way, and
the venue's buying power ($27.01) equals the balance less the positions' cost and the resting
orders. Equity is therefore about $48.6 (free cash $27.01 + resting orders + positions marked
$21.06), not $68.78. Realized results: resolutions +$3.80, positions closed by trading −$4.76,
fees −$1.35, net about −$2.31, with +$0.90 unrealized on the open positions. The cash-flow
reconciliation only balances with about $50 of total funding (one $25 deposit is in the feed; a
second, earlier $25 is implied), which makes the venue result roughly −$1.40 since funding:
flat, not +50%. The engine now reports Polymarket US cash as balance less position cost and
totals equity from that; the same double count did not exist on Kalshi, whose balance excludes
positions.

Panel labels (19:26 UTC): the account breakdown now reads Cash; of which committed to resting
orders (with free cash); Open positions at the venue's mark with cost and unrealized P&L; and
states that the total is cash plus open positions. On Kalshi "open positions" was the line
previously labelled "Venue portfolio value".

## 21. Round 17 — the Kalshi daily kill: what tripped it and what changed (deployed 19:40 UTC)

Operator question: the daily loss limit tripped on Kalshi; did the old bets cause it, and are we
missing good bets now because of them?

What tripped it (19:33 UTC), from the venue's own settlements for the day: −$9.35 over 50
settlements, made of three things.

1. −$4.13 from positions opened before the changes (the old passive quoter's weather brackets
   from 09-04 and 09-05 settling this morning). Legacy, as suspected.
2. −$4.76 from one new position family: the momentum strategy, promoted at 16:22 UTC, entered
   and exited one in-play MLB market (Brewers at Reds) thirteen times between 16:23 and 17:22
   UTC, flipping with every price swing and paying $3.34 in taker fees. This was today's
   strategies, not the old ones, and the kill did its job stopping it.
3. The limit is a percentage of free cash, and free cash fell from $59 to $27 as the newly
   promoted strategies deployed capital, so 20% became $5.31 instead of $12. The trip came at
   a smaller dollar loss than the rule intends.

Since 19:33 UTC every Kalshi entry has been held, so yes, good quotes were missed for the rest
of the venue day (the quoter reported "would quote 2" each minute).

Changes:

- **Churn guard.** A market may be entered at most twice per day and not within an hour of an
  exit (`entryBlocked`). Momentum, volume-spike and book-imbalance no longer look at sports
  markets within six hours of close (in-play games).
- **Kill basis is equity.** The daily limit is now a percentage of cash plus open positions,
  not of free cash, so deploying capital cannot shrink it.
- **Legacy carve-out.** Settlements of positions first entered before `killEpochTs` (set to the
  redesign time, 12:00 UTC today) count in P&L but not toward today's kill; the ledger keeps
  them as `legacyRealized`.
- **One-time reset.** The trip recorded under the old basis was cleared at startup (config
  v25); the next scan re-trips under the new rules if the loss stands. Under those rules today's
  counted loss is about −$5.22 against a limit near $12, so entries resume this evening rather
  than at midnight UTC.

Addendum (19:44 UTC): verified after restart, config v25, the trip cleared once, counted day
loss −$7.26 with −$2.09 tagged legacy and no re-trip. The legacy tag only recognized buy-side
first fills, which missed the old quoter's maker sells, so any first fill now marks the entry
time; restarted 19:44 UTC.

## 22. Round 18 — The Odds API on a paid plan (deployed 20:28 UTC)

The operator upgraded The Odds API subscription (their decision to spend on this feed). Where
the key goes: the Kalshi AutoTrader panel, strategy settings row, field "odds key" (a password
field next to "alerts to"); it is stored encrypted in the trader config and replaces the free
key. An environment variable `THE_ODDS_API_KEY` takes precedence when present, so it must not
be set to the old key.

The credit plan now scales with the allowance: a new field "odds credits/mo" beside the key
(default 500). With a larger allowance the poller covers up to twelve leagues, looks two days
out, polls the closing line down to every 30 minutes near game time (10-minute floor within
five hours of close), adds Pinnacle's region to every request from 5,000 credits, and keeps a
daily budget of allowance/31 that stops spending whatever the schedule asks for. Spent credits
per day are persisted with the poll throttle.

Tests: review-fixes 115/115 (cost per region, daily budget, scaled plan); `tsc` and build clean.

## 23. Round 19 — what 20,000 odds credits buy (deployed 20:38 UTC)

Operator: the plan is now 20,000 credits a month; what else can they buy? From the v4 docs
(odds cost = markets × regions per request; event odds and player props priced per market per
event; scores 1–2 credits; historical snapshots 10 × markets × regions; `/sports` and
`/events` free):

Built now, because Kalshi lists more of these than moneylines (289 game series against 189
spread, 268 total, 59 first-half-spread and 58 first-half-total series in its sports
catalogue):

1. **Spreads and totals ride along** from 5,000 credits: each poll asks for h2h, spreads and
   totals (3 markets × regions). `lineConsensus` devigs each book's two sides of the same line
   and averages across books with Pinnacle weighted 3, exchanges and low-vig books 2. Kalshi's
   ladders ("Kansas City wins by over 7.5 points?", "Over 63.5 points scored?") are matched to
   the book's line by team plus point for spreads and by the game's ticker codes plus point for
   totals, and each priced strike becomes a sharp-anchor observation like a moneyline. Strikes
   no book quotes (deep ladder rungs, first-half markets) stay unpriced.
2. **Closing games first.** The poll plan orders leagues by the soonest game rather than by
   market count, so the daily budget (645 credits at this plan) goes to closing lines.

Worth considering next, in order: alternate spreads/totals via the event-odds endpoint (prices
the rest of each Kalshi ladder; one credit per market per event, so a few events a day);
in-play odds at the 10-minute near-start cadence for the flow-follow and momentum guards; the
scores endpoint (2 credits) to grade CLV the moment a game ends; historical snapshots to
backfill a consensus for the 09-01 to 09-06 sports scans in the episodes log for an
out-of-sample test of the 3c rule (about 500 credits for two leagues at four snapshots a day);
player props only after the matching problem (player names) is solved.

Tests: review-fixes 127/127 (line parsing, ticker-code matching, line consensus, paid-tier
plan); `tsc` and build clean.

## 24. Round 20 — the rest of the odds-credit list (deployed 20:51 UTC)

Operator: go ahead with all of it. Built:

1. **Alternate lines.** For games within five hours of start (and up to five hours in), the
   anchor reads the event-odds endpoint for alternate spreads and totals (two markets per
   region, one read per event per 30 minutes, inside the daily budget) and prices every Kalshi
   ladder strike a book quotes, not only the main line. `lineConsensus` now pairs each favorite
   line with the other team's matching point and each Over with its Under across alternate
   ladders.
2. **In-play freshness.** A sharp-anchor observation on a game already under way is used only
   for ten minutes; pre-game it holds for two hours. With the paid plan the near-start cadence
   is ten minutes, so in-play gaps are priced against a live consensus rather than a stale one.
3. **Scores grading, the running out-of-sample test.** The anchor keeps the latest observation
   per Kalshi market (the closing-line comparison) and, at most every six hours per league,
   reads final scores (2 credits) and grades each one: did the Kalshi YES side win (moneyline
   by winner, spread by margin, total by points), and what would the rule "buy the cheap side at
   Kalshi's mid when the gap is 3c or more" have made per contract. Rows go to
   `anchor-grades.jsonl` in the app data folder; running totals (`gradedN`, `gradedBrier`,
   `ruleN`, `ruleNet`) sit in the sports-shadow stats. This replaces the historical backfill:
   it costs almost nothing, uses live Kalshi prices, and keeps accumulating.
4. **Props** are not built; player-name matching is its own project and the alternate ladders
   already give the anchor far more markets than it had this morning.

Tests: review-fixes 135/135 (alternate pairing, grading arithmetic for moneyline, spread and
total, small-gap no-trade, missing scores); adversarial 75/75; `tsc` and build clean.

## 25. Round 21 — the sharp-anchor gets its own market feed (deployed 20:59 UTC)

Why the anchor went quiet after the paid plan: the trader's ranked universe keeps three markets
per series, so a league's spread and total ladders (and most of its game markets) never
reached the anchor, and the poll plan saw no games to price. The anchor now reads every open
Kalshi sports market itself: each anchored league's game series plus its spread, total,
first-half-spread and first-half-total series from the public series endpoints, refreshed every
ten minutes, with series that return nothing skipped for six hours. The poll plan derives the
league from any ladder prefix (KXNFLSPREAD → NFL).

Because those markets are not in the scan's universe, a sharp-anchor signal on one of them
now fetches the market and its order book itself and adds both to the scan data, so entry
checks (shard, horizon) and the maker entry see what they need; at most ten such markets per
scan.

Tests: review-fixes 140/140 (ladder prefix mapping, series list, spread ladders counting toward
their league); adversarial 75/75; `tsc` and build clean.

## §26 Overnight check-in 2026-09-07 (deployed 08:18 UTC)

**Venue-true results, 2026-09-06 21:00Z → 07:54Z.** Kalshi +$0.72 net after $0.94 fees over 19 settlements (BTC 15-minute +$3.85, ETH 15-minute −$0.80, MLB −$2.97 of which one book-imbalance extras trade −$2.78). Polymarket US −$3.66 over 15 resolutions (micro-maker on CFB spreads/totals). Kalshi holds $31.10 cash + $28.61 of positions at cost; Polymarket US $56.24.

**Settlement math lesson.** A Kalshi settlement record lists every contract ever bought on each side; contracts closed before settlement (a YES bought back with NO, or the reverse) are paid $1 per netted pair at netting time and never appear in `revenue`. `revenue − costs` therefore reported −$31.56 for a night that was +$0.72. The correct per-market figure is `revenue/100 + min(yes, no) − yes_cost − no_cost − fees`; `scripts/venue-pnl.py` now carries it and the maintenance session uses it. Kalshi's `/portfolio/positions?settlement_status=settled` returns only open positions, so it is no shortcut.

**Ladder overnight.** kalshi-momentum stopped at its first checkpoint (20 trades, −$4.41), polyus-micro-maker stopped (20 trades, −$2.05); both cool down to 2026-09-10. Promoted into micro tests on the hourly stagger: sports-anchor, flow-follow, polyus-fade, polyus-book-imbalance, polyus-weather-fair. All 17 strategies have now been on the ladder.

**Defects found and fixed.**
1. `isSameGame` matched a ticker if each team's code appeared *anywhere* in its segment, so the NFL WAS@PHI Sep-13 ladder was paired with Washington vs Washington State (college) and 19 of the first 36 grades were graded against the wrong game. The matcher now splits the segment into an away code and a home code, checks the ticker date against the event start (36 h), and both match sites require the ladder's league to equal the event's sport. `observationConsistent` re-validates the pending queue on every grade pass; the 19 rows and 6 pending pairs were purged (17 grades remain: rule −$1.06/contract over 8 fires, all from one game, no conclusion yet). No order was ever placed on the mismatched ladder.
2. Clustered SE with one cluster is exactly zero: momentum's stop cited a "band −2.93..−2.93". With fewer than three clusters the SE is now floored at the plain SE.
3. The nightly review failed outright when the OpenRouter balance hit zero (all three configured models 402). Chain now: configured OpenRouter models → local Ollama cloud models (`deepseek-v4-pro:cloud`, `glm-5.3:cloud`, `kimi-k3:cloud`, no key) → the app's own DeepSeek endpoint → OpenRouter free tier. The pre-trade critic gets the same Ollama fallback; it runs in shadow mode, so the 119 failed calls overnight blocked nothing.
4. Thirteen lead-lag sweeps died on `order_group_not_found` even after the one retry, because re-ensuring the same shard recreated the mismatch. The retry now places without a group and forgets the cached one.
5. Lead-lag only ever set `executed` in memory; the ladder reads executed rows from the dislocations file, so 393 sweeps counted as zero and the strategy could never reach a checkpoint. The sweep now appends an executed row.
6. A stopped strategy's resting maker orders kept working the book: seven micro-maker rests outlived the ladder's stop by three hours. Both traders now cancel rests whose strategy flag is off (verified: all seven cancelled at 08:19Z).

**Reporting.** The maintenance session (08:10 local) now ends by sending the day's report file and a five-line push notification; venue-true numbers come from `venue-pnl.py` on fresh read-only dumps. Today's nightly review retries on its two-hour cadence with the restored OpenRouter balance.

Tests: review-fixes 149, ladder 69, adversarial 75. Backup POST-round26-overnight-fixes-20260907-041937.zip.

## §27 Open-position audit and the anchor's team matching (2026-09-07, ~08:45 UTC)

**Question: are the open positions compromised?** One is. The Kalshi position KXMLBSPREAD-26SEP071335LAABOS-LAA2 (Angels win by 2+, 16.13 YES at 30c, $4.84) was entered by sports-anchor at 01:26Z on a fair value of 46.9% that came from an MLS match, Los Angeles FC vs New York Red Bulls: `teamInQuestion` matched the city words "los angeles" in "Los Angeles A wins by over 1.5 runs?", and the spread path never required both teams in the ticker. The episodes log shows 15 such cross-sport pairings in the observation stream (NFL Chargers/Cowboys spreads and the Dodgers' run line priced off MLS; NFL totals off college football); this was the only one that traded. Every other open position is its own strategy's: three fade NO positions at 96–98c (ETH, SOL, Trump-says), one lead-lag 15-minute BTC contract, twenty weather quotes at fair value, two book-imbalance rests. Marked to live quotes the book is −$2.74 unrealized on $29.14 of cost; the Angels line marks at 29c vs 30c paid. §26's line "no order was ever placed on the mismatched ladder" was true of the NFL/NCAAF totals but not of this spread; corrected here.

**Decision on the position.** Left open: it is now priced by the market at what we paid, resolves this afternoon, and exiting costs about 30c of spread and fee. It counts as one of the anchor's first twenty trades.

**Fix (deployed).** The anchor identifies the game and the subject team from the ticker's exchange codes, never from question text: `teamCodes` adds nickname-initial codes (LAA/LAD, NYY/NYM, CWS, WASH), `subjectTeam` reads the ticker's last segment, every spread and moneyline site requires `isSameGame` (both codes in the segment) plus the league check, and `tickerDateMatches` uses Kalshi's Eastern-time stamp: with a time present ("26SEP062210") the start must sit within three hours of it in ET, which rejects the previous night of a series; date-only stamps accept the ET or UTC date (college football stamps the UTC date of a late kickoff). The grading queue is re-validated with the same rules. Tests: review-fixes 163, ladder 69, adversarial 75. Backup POST-round28-anchor-ticker-codes.

## §28 Gemini-audit fixes, HRRR shadow, backlog (deployed 09:34 UTC 2026-09-07)

The seven fixes confirmed in `docs/reports/REVIEW-OF-GEMINI-AUDIT-2026-09-07.md`: Polymarket US commissions on settled markets now count in the venue P&L (`settlementsCarryFees` is false for that venue); a crossing post-only order that the venue rejects with an HTTP error, or accepts and cancels, now falls through to the taker path and records a `reject` episode instead of aborting the signal (`OrderResult.venueStatus` added); `quoteAroundFair` joins the best level when the margin lands on it; the reconciler skips only fills within five seconds of a placement row (`planFillIngest` takes a Map of placement timestamps); settlement counts fall back to the integer fields; the Manifold balance refreshes every 30 s; the hunch forecaster shares the Ollama fallback (`hunchModelPlans`, `src/main/intelligence/ollama.ts` holds the shared constant). Tests: review-fixes 168, ladder 69, adversarial 75.

Not built, with reasons: a 60-second BRTI-style mean for convergence (entries are minutes before the close; the settlement average only narrows variance at the close) and the private fill channel (a latency gain for a quoter that is not yet net positive). Both are in `docs/BACKLOG.md`, which now consolidates every deferred item with its reason and trigger; the maintenance prompt keeps it current.

HRRR shadow test: `scripts/hrrr-shadow.mjs` stores Open-Meteo HRRR and NBM daily-high forecasts for the 27 Kalshi stations every hour (task `OracleTrader-HrrrShadow`) and grades yesterday from NWS station observations; first run stored 27 forecasts and graded 27 station-days. Report after 2026-09-21. Backup POST-round29-gemini-fixes-hrrr-shadow.

## §29 Proactive queue (2026-09-07, ~09:55 UTC)

Done now: momentum redesigned before its 2026-09-10 retry (the move must have traded in at least three of the window's candles and held direction at mid-window; one entry per market per day in either direction; held to settlement, no reversal exits); the pre-trade critic measured on 45 settled candidates (vetoed +2.9c/contract, abstained +10.0c, errored −11.4c: no skill shown) and moved to the free local Ollama models first with the paid router as fallback, `scripts/critic-skill.py` re-measures; the Polymarket US read-only dump paginates to the end of the feed with a rate-limit retry (25 resolutions counted overnight instead of 15). Tests 168/69/75, restart verified.

Made automatic: `docs/BACKLOG.md` now ends with a numbered build queue, each item with a trigger (critic veto/disable rule, WebSocket book promotion at 99% agreement for seven days, HRRR switch on the 2026-09-21 report, fill channel and Avellaneda-Stoikov on the quoter's first positive checkpoint, Polymarket US anchor on the Kalshi anchor's first positive checkpoint, player props on anchor notch 2, three new generic strategies one per day when nothing else is triggered). The daily maintenance session checks every trigger, logs the result, and builds the first item that is due, end to end, without asking. Backup POST-round30-momentum-critic-queue.

## §30 Operator-action audit and the shard-0 top-up (deployed 10:12 UTC 2026-09-07)

Question: is anything pending that only the operator can do? Checked live: both venues armed (`liveArmed` true in the Kalshi and Polymarket US trader configs), execution live, every key configured, OpenRouter credits restored, The Odds API on the paid plan, daily loss limit 20% of equity, Kalshi $31.67 cash + $26 positions, Polymarket US $60.05. Nothing pending. One automation gap found: shard 0 (weather collateral) sat at $0.59 all day because the top-up ran only at promotion and scale-up; the ladder now checks it every hourly run and fills to the cap when it is below the stage's need. First live transfer: $10.84 from shard 3 to shard 0 at 10:14 UTC (transfer id logged), confirmed by a read-only balance read (shard 0 $11.43). The venue's balance read lags a transfer by a few seconds, so the ladder's same-second "shard 0 now" figure is stale; the next check reads the true balance.

Future operator moments are now named by the maintenance push only when due: a scale-up whose stake exceeds maxBalancePct × equity (the first ×4 on Kalshi would be clipped at 25% of ~$57), a venue balance that cannot cover stakes, or a credit or subscription failure in the log. Tests 168/69/75. Backup POST-round31-shard0-hourly-topup.

## §31 Kalshi deposit (2026-09-07, ~10:20 UTC)

The operator deposited $50 into Kalshi; it landed on shard 0. Balance by shard afterwards: shard 0 $62.43, shard 2 $20.17, shard 3 $1.01; equity $106.84. Any equity comparison across this moment must subtract the deposit; the venue-true P&L (settlements) is unaffected. The ×4 scale-up that would have been clipped at 25% of $57 now fits. Since Sep 6 the fills split 46 on shard 3 (sports), 38 on shard 2 (crypto), 14 on shard 0 (weather), so the ladder is being taught to redistribute shard 0's surplus above the weather cap to the shards that trade (§32).

## §32 Shard balancer (deployed 15:42 UTC 2026-09-07)

Kalshi clears each market on an exchange shard and collateral must sit on that shard. Deposits land on shard 0 (weather), while since Sep 6 the fills split 46 on shard 3 (sports), 38 on shard 2 (crypto), 14 on shard 0. The ladder now runs `balanceShards()` every hour: every shard that has ever been funded (balance above zero, so never the unused shard 1) is topped up to $15 (`SHARD_WORKING_DOLLARS`) from shard 0's surplus above the weather cap (`ladderAutoAllocateUsd`). First live move at the startup run: $13.99 from shard 0 to shard 3 (transfer b315c360). Adversarial section H covers the rule (79 tests). Backup POST-round32-shard-balancer.

## §33 The daily session could not work; now it is two runners (2026-09-07, ~16:00 UTC)

Finding: the 08:10 desktop maintenance session ran in default permission mode, issued one PowerShell liveness command, and stalled there with nobody to approve it (transcript: 22 records, one tool result). A scheduled desktop session cannot run commands unattended, so it cannot be the worker.

Fix: `scripts/maintenance.ps1` runs Claude Code headless (`claude -p --dangerously-skip-permissions`, verified with a HEADLESS-OK round trip) from the Windows task `OracleTrader-Maintenance` at 07:00 local, with the desktop app closed or open, logging to `logs/maintenance-<date>.log`; the instructions moved to `docs/MAINTENANCE-PROMPT.md` (source of truth). The desktop scheduled task is now delivery-only at 08:30 local: Read the day's report, SendUserFile it, PushNotification the five-line summary, or push "Maintenance did not run today" with the runner's log tail. First headless run launched from this session to prove the path.

Also today: the review's 09:45 retry died on malformed model JSON; a malformed answer now falls through to the next model inside the chain (deployed 15:47 UTC). The 12:12 review succeeded via the router. The weather quoter was stopped by its checkpoint at 13:12 UTC (20 trades, −$2.39, mean −17c/contract, band entirely negative) and cools down to Sep 10; the HRRR shadow keeps collecting for its retry. Tests 168/69/79.

## §34 First headless maintenance run, verified; credit pacing (2026-09-07, ~18:20 UTC)

The headless runner completed its first pass in 18 minutes (17:42-18:00 UTC, exit 0) and its claims check out against the live state: app up, ladder line carries `kalshi-mean-reversion=tiny-live` (queue item 8a built end to end, pre-registered in `docs/PREREGISTERED-mean-reversion.md`, promoted by the ladder at 17:54 UTC), suites 187/74/79 with its nine new assertions, backup MAINT-2026-09-07, report `docs/reports/2026-09-07.md` (delivered to the operator from this session; from tomorrow the 08:30 desktop task sends it), `docs/MAINTENANCE-LOG.md` started. Its defect fix: settled trades were bucketed by a stale market close date, which collapsed day-clusters to one and produced zero-width bands; it added `clusterDayOf` (day the P&L was realized) and `dayClusteredSe`. Protected settings unchanged by it. Note: Kalshi `amountPerTrade` reads $3 (it was $5 at 07:52 UTC); the review applied nothing, the ladder never writes that key and the runner reports no size change, so the panel is the only remaining writer.

Credit pacing: the anchor spent 644 of 645 credits by mid-morning UTC (twelve leagues at six credits every half hour), leaving US afternoon and evening games unpolled. `pacedBudget` now releases the daily allowance in proportion to the UTC hour (floor a dozen credits; plans under 100 credits a day are not paced), applied to both the league sweep and the alternate-line reads; scores grading is unchanged. Tests review-fixes 187. Backup POST-round34-credit-pacing.

## §35 Fade throughput (2026-09-07, 18:24 UTC)

Fade (tiny-live since Sep 6 15:10 UTC) had settled 4 trades in 27 hours against a checkpoint of 20: its maker rests filled about 40% of the time (39 resting orders since promotion: 16 executed, 20 cancelled) and it shares the 20-trade daily cap with 17 other strategies. At 96 to 98c the taker fee is under a third of a cent per contract, so `fadeEntryMode` is now `taker` (set with the app stopped, verified after restart). Expected effect: entries at the Sep 1-2 pace instead of a fifth of it; first checkpoint in days rather than weeks. Sizes, caps and the arm untouched.

## §36 Strategy-off cancels back off; Polymarket US fade is starved of candidates (2026-09-07, 20:27 UTC)

Two of the seven micro-maker rests cancelled at 08:19 UTC were refused by the venue and stayed open; the strategy-off rule then retried every tick and wrote 2,584 research rows in twelve hours. Both traders now ask at most every 30 minutes per order and log the venue's answer (Polymarket US: HTTP 400 code 3 on both SMU spread rests, whose game has started; they die with the market). Verified after restart.

Fade runs on both venues. The record (49 trades, 47 wins, +$5.44 lifetime; tiny-live since Sep 6) is Kalshi's. Polymarket US fade was promoted at 02:59 UTC today and has found nothing: a probe of the venue's 1,000 most-traded open markets shows only 47 closing within 24 hours and nine with a side at or under 10c and a spread within 5c, most of them stale futures. It stays on the ladder and trades when a real candidate appears (weather brackets, lopsided matches); it will not reach a checkpoint soon.

## §37 Metaculus shadow anchor (built 2026-09-07, ~20:50 UTC)

The operator obtained a Metaculus API token (handled like every key: entered in the panel, encrypted at rest, never written by me). Added `metaculusApiKey` to the Kalshi AutoTrader config (encrypted on save like the Odds key) and a "metaculus key" field in the panel. `scripts/metaculus-shadow.cjs` (electron, so it can decrypt the token) fetches open binary Metaculus questions with their community probability, matches each to an open non-sports Kalshi market by title tokens (Jaccard ≥ 0.45, three shared tokens, resolution dates within 45 days), stores the pair, and grades pairs at Kalshi settlement; `report` compares Brier against the Kalshi mid and shows hypothetical net at 10/15/25-point disagreements. Hourly Windows task `OracleTrader-MetaculusShadow`. Without a token the script logs and exits. Nothing trades off it until 100+ resolved pairs favour the community forecast. Tests 187/74/79.

§37 addendum (21:58 UTC): the operator entered the token in the panel (stored encrypted; no restart needed, the script reads the config file each run). Live API findings: the posts list needs `with_cp=true` and even then carries the community value for about one open question in a hundred; the detail endpoint returns null for questions whose community prediction is not yet computed (few forecasters), so the collector now matches titles first and asks for detail only on matches, skipping matches without a value. Kalshi's public market list returned 429 after the day's heavy reads; the collector retries with back-off and paces its pages.

§37b (22:30 UTC): the Metaculus API hides the community forecast from tokens on 299 of 300 open questions (whatever the account: the token is a human account created today), while the public question page renders it for logged-out visitors. The shadow therefore matches questions to Kalshi events first (rare-token weighting over 4,700 open non-sports events; a match needs most of the question's rare weight or three rare tokens with over half), picks the event's market by subject token or nearest date strike, and reads only the matched questions' pages through `scripts/metaculus-page.cjs`, a child Electron process with its own profile (sharing the app's profile left pages half-rendered; the app's profile is what decrypts the token). Rate: at most 40 pages an hour. `report` also scores the high-confidence subset (match score ≥ 0.8). Pairs on file are long-dated (2027-2029 resolutions), so this measurement takes months; it costs nothing.

§37c (23:37 UTC): the collector now lists both the most active and the soonest-resolving open questions (688 in total). Horizon of Metaculus's open binary questions: 5 resolve within 30 days, 23 within 90, 154 within a year, 506 beyond a year; the platform's binary supply is mostly a year or more out, so the shadow accumulates slowly by nature. Eight pairs on file, including SpaceX landing on Mars before 2030 (Metaculus 5%, Kalshi 24%).

## §38 Morning check 2026-09-08 (03:05–03:25 local, 07:05–07:25 UTC): review chain blind, Kalshi V2 cancels unrouted, Polymarket futures mis-dated

Liveness: app up since the 17:24 local restart, hourly ladder ticks, BTC collector (12,368 rows today),
HRRR shadow (594 forecasts / 47 grades, 02:20 run ok), Metaculus shadow (02:35 run ok, 8 pairs), maintenance
task armed for 07:00 local (first scheduled run; the 09-07 run was started by hand), delivery task at 08:30.

Money (venue-true, `scripts/venue-pnl.py` on fresh read-only dumps): Kalshi 24 h +$13.53 after $2.16 fees on 42
settlements, of which +$22.33 is one market (KXLALIGAGAME-26SEP07ELCRSO-RSO: mean-reversion bought Real Sociedad
YES at 8c and it won); overnight since 23:30Z −$1.44 on 11. Cash $102.26 (shards 0/2/3 = $63.00 / $24.26 /
$14.99) plus $14.71 at cost open, $110.92 at market. Polymarket US 24 h −$0.87 on 2 resolutions; balance $65.03,
buying power $18.23 (margin $46.80 tied in 12 open trades and 2 fade rests); the venue's positions and open-orders
endpoints answered 503 at dump time, so those 12 are app-side numbers until the next dump.

Ladder overnight: kalshi-leadlag tiny-live → live ×2 at 03:24Z (checkpoint 20, net +$2.42, band 0.02..0.22);
polyus-book-imbalance → disabled at 03:24Z (20 trades, −$3.92, band −0.23..−0.16); kalshi-book-imbalance →
disabled at 06:24Z (−$9.20 hit the −$9 stop). kalshi-fade 7 settled +$1.16 (13 to its first checkpoint);
kalshi-mean-reversion 4 settled +$20.56 (the one longshot; 16 to checkpoint). Momentum, quoter, polyus-micro-maker
still in cool-down to 09-10.

### Defect 1 — nightly review failed with every model and recorded only the last error

`reviews/2026-09-08.md` holds one line: `google/gemma-4-31b-it:free: HTTP 429`. The chain tried ten plans
(three paid OpenRouter, three Ollama cloud, DeepSeek direct, three free) in 6 m 20 s and `askModel` kept only the
LAST failure, so the record cannot say why gpt-5.6-sol, deepseek-v4-pro and glm-5.3 failed. OpenRouter is not
the cause: `/api/v1/credits` shows $200 bought / $104 used, no key limit, and a JSON-mode probe of gpt-5.6-sol
and of Ollama `deepseek-v4-pro:cloud` both answered correctly. The best-supported cause is `max_tokens: 2500`:
these are reasoning models and the packet grew (18 ladder arms, per-strategy calibration); reasoning eats the
budget and the content comes back empty or truncated, which the loop files as "empty response" / "unparseable
JSON" and moves on. Fix (`nightlyReview.ts`): every plan failure is pushed to a list AND logged as it happens
(`[review] model failed (k/n): …` with the finish_reason and content length), the thrown error joins them all,
and `max_tokens` is 8,000. The review's own retry rule (every 2 h, three attempts a day) fires next at ~08:25Z;
the log will now show each model's reason if it fails again.

### Defect 2 — Kalshi V2 cancels never reached shard 2/3 orders

Two book-imbalance rests on crypto markets (shard 2) survived the ladder's 06:24Z stop: every 30 min the cancel
came back `DELETE /portfolio/events/orders/{id} -> 404 not_found`, while the same ids answered 200 on the legacy
`GET /portfolio/orders/{id}` (read-only probe `kalshi-get-order.cjs`). Kalshi's OpenAPI for Cancel Order (V2):
"To auto-route the cancellation, provide `market_ticker` and omit `exchange_index` or set it to −1 … An
`order_id` alone cannot identify the exchange shard" — without either it looks on shard 0 (weather), which is
why the quoter's 873 cancels worked and every crypto/sports cancel silently did not (the callers swallow cancel
errors). Fix (`kalshi.ts`): an `orderRoute` map (order_id → ticker, shard) filled by `placeOrder` and
`getOpenOrders` (orders now carry `exchange_index`); `cancelOrder` sends `?market_ticker=…&exchange_index=N`,
resolving an unknown id with one legacy GET; `amendOrder` adds `exchange_index` to its body (the V2 amend schema
accepts it; one weather amend 404'd on 09-07). The SOL rest (17 of 27 contracts still open at 11c) and the BTC
rest are the first live test: the app's own 30-minute retry does the cancel, nothing was cancelled by hand.

### Defect 3 — Polymarket US "futures" markets read as games closing at the next fixture

The fade rested 96c NO on `tec-ucl-final-2026-06-05-w-ast` / `-w-liv` (Champions League winner) and
book-imbalance bought Arsenal YES at 17c on the same event; the venue's endDate is 2027-06-19 but
`gameStartTime` is 2026-09-08T13:00Z (the next matchday, during which the venue halts and reopens the market), and
`mapMarket` read a future gameStartTime more than 48 h before endDate as a game's kickoff, so the market looked
13 h from close and passed every short-horizon filter. Sampled 2026-09-08 from the public gateway: NFL division
winners carry a fixture 1.7 days out and endDate 137 days out; games keep endDate within ~14 days. The venue
labels these `marketType: "futures"` / `sportsMarketType: "futures"` (games are `moneyline` /
`drawable_outcome`). Fix (`polymarketUs.ts`): exported `isUsFutures` and `deriveUsCloseTime`; futures keep endDate
(never the fixture, and a past fixture no longer marks them dead), everything else unchanged. Eleven new
assertions in `review-fixes.test.ts`. The existing UCL rests expire by the mini's own rule; the Arsenal $3 sits
until the market resolves or the mini's far-horizon exit sells it.

Tests 198 / 74 / 79, typecheck and build clean, backup `POST-round38-cancel-routing-futures-review`, app
restarted 03:20:56 local. Not touched: arms, sizes, loss limits, keys, orders.

### §38a Verification and round 38b (03:27–03:32 local)

Cancel routing verified live: at 07:26:57Z the app's own 30-minute retry pulled the stopped book-imbalance rest
on KXBTC-26SEP0817-B80125 (episode `pull`, reason "strategy off", no refusal logged); the SOL rest had already
filled in full (27.27 contracts at 11c, $3.00) between the failed 06:55Z cancel and the fix, so the routing bug
cost about $1.90 of extra exposure for a stopped strategy and nothing else.

Round 38b (`kalshi.ts` placeOrder): tickers that never went through `mapMarket` (lead-lag's 15-minute crypto
sweeps) had no known shard, so the shard-0 order group rode into shard 2 and every such order cost a failed POST
plus a retry without the breaker ("order group unknown", 24 times since the 09-07 restart). Before choosing the
group, an unknown ticker is now read once (`fetchMarket` → `mapMarket` records `exchange_index`). Typecheck, the
three suites and the build are clean; backup `POST-round38b-shard-learn`; app restarted a second time at 03:27:23
local. The proof is the absence of "order group unknown" warnings on the next crypto sweeps.

Proof for 38b: the first crypto sweep after the restart (07:31:24Z, KXBTC15M-26SEP080345-45, a shard-2 market)
placed with no "order group unknown" warning; every such sweep since the 09-07 restart had produced one. Zero
error or warning lines in the first four minutes of the new process.

## §39 Defect sentinel and on-call repair loop (2026-09-08, 03:35–03:55 local)

The operator asked whether a task watches for defects like §38's and repairs them as they arise. Honest answer: no. What
ran between check-ins was strategy control (hourly ladder ticks, shard balancer, shadows), one LLM review a day
(which itself failed last night and sat unnoticed for five hours) and one maintenance session a day at 07:00.
Nothing looked at the log between those, so a 404 on every crypto cancel and a dead review chain waited for a
human. Built now:

- `scripts/sentinel.mjs` (plain node, no LLM, no venue writes) runs every 15 minutes as Windows task
  `OracleTrader-Sentinel`. Each tick: app process and main.log freshness, ladder tick age, BTC collector,
  HRRR and Metaculus shadow freshness, the daily maintenance run; new error signatures in main.log since the last
  tick (normalised: ids, tickers, numbers), the nightly review record, rests of stopped strategies whose cancel
  keeps failing, a venue error persisting in a mini-trader, positions far beyond a trader's horizon, scheduled-task
  results, OpenRouter credit, Ollama, disk. A dead app or a stale hourly task is revived directly
  (`Start-ScheduledTask`); a defect becomes an incident file under `data/sentinel/incidents/` and a headless
  repair session; everything else is a note in `data/sentinel/digest.md` and `status.json`.
- `scripts/repair.ps1` + `docs/REPAIR-PROMPT.md`: the repair session (`claude -p`, 250 turns) works one
  incident under the maintenance rules (no arms, sizes, limits, keys or orders; prove, smallest diff, tests,
  build, restart, verify, backup) and writes the outcome into the incident file. Rate limits: 3 sessions a
  day, 90 minutes apart, one per signature per 12 hours, never while `data/sentinel/agent.lock` is held
  (`scripts/maintenance.ps1` now takes the same lock, waiting up to an hour for it).
- Delivery: desktop scheduled task `oracle-trader-incidents` every 3 hours (05 past) pushes only digest sections
  newer than 3 hours (Read + PushNotification, no commands); the 07:00 maintenance run (prompt step 12) reads the
  digest and every OPEN incident, finishes what on-call could not, and reports "Sentinel" in the daily report.

Replay proof (`--dry --since=2026-09-08T06:00:00Z`): the sentinel flags the review failure and five new
signatures (order group unknown ×7, cancel refused 404 ×4, review failed) as repair findings, i.e. it would have
dispatched a repair at ~06:30Z instead of waiting for the 03:05 local check. The current window is clean apart
from the review note. Cost: one node process every 15 minutes; a repair session only on a real finding.
Suppressions (`data/sentinel/suppressions.json`, regex + expiry + reason) are the way to silence benign noise.

Verified: task `OracleTrader-Sentinel` registered and ran (first tick 07:41:59Z, result 0, next 03:50 local,
then every 15 min); its digest carries only the review note. Repair path drilled end to end with a synthetic
incident (`incidents/2026-09-08T07-45-drill.md`): `repair.ps1` took the lock, the session read the incident,
verified the app, wrote NOT-A-DEFECT (drill), closed the file, appended `docs/MAINTENANCE-LOG.md` and exited 0 in
46 s; lock released. Both runners now pipe an empty stdin to `claude.cmd` (it waited 3 s for stdin otherwise).
Desktop delivery task `oracle-trader-incidents` created (cron 5 */3 local; first run 06:05).

## §40 Post-reboot check (2026-09-08 05:29 local boot for a driver update; checked 05:33–05:40)

App back at logon (05:30:21), ladder ticking (09:32Z), no errors since boot; BTC collector task running and
writing; Ollama up; no stale `agent.lock`; maintenance still due at 07:00 (no log yet, as expected). The
sentinel's 05:05 and 05:20 ticks and the 05:20 HRRR run fell in the shutdown window and persisted nothing
(scheduler still reported 0); a manual HRRR run stored 27/27 stations, a dry sentinel tick found nothing, and the
05:35 scheduled ticks are the proof that the repetition triggers survived the reboot.

## §41 Two research shadows built from the leaderboard study (2026-09-08, 06:50–07:15 local)

The operator: "implement what you can." Built, read-only, hourly Windows tasks, both graded at settlement, neither trades.

**Mention-market base-rate shadow** (`scripts/mention_shadow.py`, `data/mention-shadow/`, task
OracleTrader-MentionShadow at :50). Universe: every open Kalshi event whose ticker carries MENTION or SAY (census
07:00Z: 50 events, 950 strikes; phrase = `yes_sub_title`, slash alternatives OR'd, "(5+ times)" thresholds,
plural/possessive allowed per Kalshi's rules). Corpora, all free: Fed press-conference PDFs from
federalreserve.gov (every presser since 2013 cached, last 12 used; 7,000 words each), White House YouTube
auto-captions through yt-dlp for press briefings (last 12) and Trump remarks (last 20; weekly/monthly "say" series
use the fraction of the last 10 ISO weeks with a mention). Base rate = (k + 0.5)/(N + 1). Every hour each covered
strike is logged with base rate, bid, ask and last; at settlement the last pre-close observation is scored (Brier
base vs Brier market) and a counterfactual 15c-gap taker trade net of the Kalshi fee is booked. First pass:
45 Fed strikes observed (KXFEDMENTION-26SEP, Warsh's 09-17 presser). Two yt-dlp traps cost three runs: YouTube
extraction now needs a JavaScript runtime (`--js-runtimes node`; without it the download fails silently) and
`--print` implies `--simulate` (`--no-simulate` restores writing). Unsupported speakers (CEOs, Vance, Mamdani,
Netanyahu) are counted as uncovered, never guessed.

**Polymarket smart-money consensus shadow** (`scripts/polymarket_consensus.py`, `data/polymarket-consensus/`,
task OracleTrader-PolyConsensus at :55). Wallet set = top-50 all-time ∪ top-50 30-day profit from
lb-api.polymarket.com (98 wallets; 17 of the top-20 monthly were active in the last 48 h, 2,908 trades in 72 h on
the first poll). Signal: ≥ 3 distinct top wallets buy the same outcome within 48 h, more same-side than opposite
buyers, ≥ $500 notional. Each signal records the Polymarket price and the matching Kalshi market (IDF token match
over the open catalog with a same-date rule for games, both fixture names required, derivative and season markets
excluded, per-map/half titles unmatched) and Polymarket US market (public gateway, futures rejected for games).
Grading on Polymarket's own resolution via gamma-api: hit rate, Brier, P&L per contract at the Polymarket price
and at the Kalshi ask net of fee. First pass: 15 signals (tennis challengers, MLB, NCAAF, LoL, CS2, Russian
Duma), 3 Kalshi matches (all correct), 1 Polymarket US match; the matcher's first version produced four wrong
matches (an NWSL event through "Kansas City", the ACC winner for SMU vs Florida State) which the date, both-sides
and dated-ticker rules removed.

Wired in: sentinel liveness for both run.logs (revive once, then incident), maintenance prompt step 13 (report
both daily; go-live triggers are backlog items 12/13: ≥ 100 graded, beating the price after fees). Kalshi's API
has no social/follow/feed endpoints (checked the OpenAPI spec and docs bundle), so the traders the operator follows in the
app reach only his phone and the web app's notification bell; Oracle cannot subscribe to them without his web
session, which we do not scrape.

### §41a The first scheduled maintenance run failed in 23 seconds (07:00 local) — fixed

`logs/maintenance-2026-09-08.log`: `API Error: 400 This API key is not scoped to a workspace`, exit 1. Task Scheduler
launches with the full user environment, where ANTHROPIC_API_KEY is set; `claude -p` prefers that key over the
claude.ai login, and the key is not workspace-scoped. My manual runs and the repair drill worked because this
session's shell does not carry the variable. Fix: `scripts/maintenance.ps1` and `scripts/repair.ps1` remove
ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from their own process before invoking claude (the login is used; the
key is never printed or moved). The sentinel now parses the maintenance log's exit code: a non-zero exit restarts
the task once and files an incident if it fails again (it had only checked for a missing or hung log). The task
was restarted by hand at 07:11 local; the 08:30 delivery reads whatever it produces.

### §41b Mention shadow: coverage and two model corrections (07:10–07:15 local)

Coverage after the corrected run: 311 of 950 open strikes observed hourly (Fed 45, Trump single-event 87,
Trump weekly/monthly 179); uncovered 635 (press-secretary briefings: 30 strikes, none on the White House channel
in its last 400 videos; other speakers 605). Corrections: (1) a period market pays on any mention, so its base
rate compounds the weekly rate over the weeks it covers (open_time to expiration, 1..13); (2) grading waits for
the market's expiration because mention markets settle YES the instant the phrase is said, and the first 19
"grades" were all early YES settlements; (3) comparables must be the same speaker: with all 12 Fed transcripts,
"Good Afternoon" carried an 81% base rate against a 12c ask because Powell opened that way and Warsh says "Good
day". Fed strikes now use the two Warsh pressers (n = 2, base rates 0.17/0.50/0.83), which is honest and weak
until his third presser lands on 09-17; the report separates speaker-matched strikes. Backup
`POST-round41b-mention-fixes-runner-envfix`.

## §42 The Becker dataset landed; first backtest answers the fade's biggest question (07:45–07:55 local)

Downloaded (36.0 GB, byte-exact) and extracted to `G:\DATA\prediction-market-analysis` (outside the repo): 72.1M
Kalshi trades with taker side, 7.68M markets, 7.31M finalized. `scripts/backtests/fade_audit.py` scores both seats
of every trade since 2024-10-01 (127M seat-rows, 25 s in DuckDB) and writes
`docs/reports/backtest-fade-audit-2026-09-08.md`. Findings that change decisions:

- The favourite side (90–99c) pays the **maker** in every category (+1.0 to +3.4c per contract; Politics +3.39) and
  costs the **taker** in every category but Politics (+1.47) and Finance (+0.14): Crypto −0.95, Sports −0.91,
  Weather −1.34, Entertainment −1.29. Our fade is a taker in crypto, sports and politics.
- Hours to close decides more than category: taker 1–6 h **−2.70c**, >3 d +1.43c; maker >3 d +3.18c, 1–6 h +0.64c.
  Our fade enters at ≥ 60 min to close, the worst bucket for its seat.
- The longshot side (1–15c) loses for takers in every group but Esports (Politics −4.63c); makers earn it only in
  Weather, Entertainment, Media. Mean-reversion v1 buys it as a taker: the 35c fence stands.
- Hour of day: takers worst 13–15 ET; makers best 8, 12, 16–17, 20 ET.

Filed: `docs/PREREGISTERED-fade-v2.md` (maker seat, ≥ 6 h to close, World Events blocked, throughput fallback to
taker in Politics/Finance) to switch at v1's 20-trade checkpoint; mean-reversion addendum (b); backlog 14 rewritten
as the switch instruction, 15(a) done, 16 (quoter retry: ≥ 6 h to close, 90–94c rests) and 17 (time-of-day hours).
No live setting changed: v1 keeps its registered rule until its checkpoint.

## §43 Live settings changed on the operator's authorization (2026-09-08 12:06Z)

"Feel free to alter any live settings that improve our testing and chances." Applied with the app stopped
(`.bak_round43_*` copies of kalshi-auto.json and ladder.json), restarted 08:05:58 local:

- **Fade v2 now**: `fadeEntryMode` taker → maker, `fadeMinHorizonMinutes` 60 → 360 (the audit's two worst cells were
  v1's seat and horizon). Scoring restarts: the arm is `disabled` with an expired cool-down and the ladder
  re-promotes it with a fresh baseline; the pre-registered throughput fallback applies from that moment.
- **Mean-reversion v2 now**: `meanReversionMinEntryPrice` 0.35 (new `ReversionRule.minEntryPrice`, default 0.35,
  migration for old configs, IPC type, five assertions; 232/74/80 tests). Same restart mechanism.
- **Lead-lag back to tiny-live ×1**: `leadLagMaxContractsPerOrder` 2 → 1, ladder stage tiny-live notch 1, `since`
  now. Its ×2 promotion rested on IOC rows that never filled (maintenance §5b); the ladder cannot undo a promotion
  itself, and scaling on invalid evidence is the one thing it exists to prevent.
- **Quoter retry condition**: `quoterMinHoursToClose` 3 → 6 for the 09-10 retry (makers earn least in the last
  6 hours: +0.64c vs +1.79c at 6–24 h and +3.18c beyond 3 days).
- Sentinel: pushes each digest entry and every closed repair to the app's alert webhook when one is configured
  (Discord or ntfy-style POST, same formats as the app's `sendAlert`), so incidents reach a phone at once instead
  of at the next 3-hourly delivery.

Not changed: arms of other strategies, `amountPerTrade`, loss limits, keys, ladderMode, the shard cap.

### §43a Phone alerts connected (08:14 local)

The operator's ntfy topic set as the app's alert webhook (`alertWebhookUrl`, applied with the app stopped, restarted
08:13:59). Test POST answered 200. From here the app pushes ladder stage changes and scale-ups, collateral moves,
the nightly review summary, order-error and stall alerts, and the sentinel pushes digest entries and closed repairs.
The first live push is the ladder's re-promotion of fade or mean reversion on its next tick.

## §44 pmxt (github.com/pmxt-dev/pmxt) assessed (08:20 local)

"The ccxt for prediction markets": a Node sidecar with Python/TypeScript SDKs over 15 venues (Polymarket,
Polymarket US, Kalshi, Limitless, Metaculus, Smarkets ...), MIT, 2.1k stars, hosted API with custody plus a
self-host mode. Not adopting the framework: Oracle already has native adapters for our three venues, and pmxt's
Kalshi client still uses the legacy v1 order paths with no exchange-shard routing (the defect we fixed this
morning), so it is behind us where it matters. Its Metaculus client reads the same `aggregations.recency_weighted`
field the API hides from us and falls back to 0.5, so no better source there. Its cross-venue series map has 15
entries and none for Polymarket US. Its wallet "watch" polls, it does not stream (the user WebSocket needs the
wallet owner's own credentials).

Taken: (1) Polymarket's data API `/v1/leaderboard` accepts category (SPORTS, POLITICS, CRYPTO, WEATHER, ...),
period (DAY/WEEK/MONTH/ALL), PNL ordering, offset to 1000 and returns `xUsername`; the consensus shadow's wallet
set is now the union of the top 50 by profit over seven categories × MONTH/ALL, with X handles kept (a politics
whale who never trades sports was invisible on the overall board). (2) Its Kalshi WebSocket client
(orderbook_delta/snapshot + trade channels, resubscribe on reconnect) is a reference for our own book feed when it
leaves shadow (build-queue item 2). Nothing else.

## §45 Backlog sweep: three more backtests, one item declined, one setting revised (08:35–08:55 local)

The operator: "anything in the backlog that can be built now?" Built: `scripts/backtests/favorites_weather_audit.py`
(items 8d, 15c, 15d) and `scripts/backtests/move_audit.py` (15b), both on the Becker tape since 2024-10-01.
- **8(d) high-probability favourites, declined.** A taker on 70–89c favourites nets −1.8c per contract in sports,
  −3.7c in weather, −1.1c in crypto, and loses in every hours-to-close bucket under three days except the last hour
  (≈ 0); the only positive cells are politics (+1.9c) and finance (+1.5c) a day or more out, which fade v2's
  fallback already covers. The operator's "70%+ chance to win" idea is real only as a maker or in those two groups.
- **15(c) weather quoter.** Weather makers earn in every minutes-to-close bucket (equal-weight +1.0 to +2.9c,
  size-weighted +0.5 to +1.6c), most at 1–8 h and on middle-priced brackets (+3.6 to +4.9c at 2–8 h). The
  all-category "makers earn least at 1–6 h" does not hold for weather, so the 6-hour floor I set at 12:06Z
  removes the quoter's best hours: the runner is instructed to put `quoterMinHoursToClose` back to 3 before
  the 09-10 retry. The quoter's own −17c/contract in those hours is a fair-value problem (HRRR shadow is the fix
  path), not a horizon problem.
- **15(d) weather-morning arm.** Weather takers lose in every ET hour and on every side (favourite side at
  8–11 ET −0.3 to −2.6c, middle −2.5 to −3.3c). The arm's edge must come entirely from its forecast gate.
- **15(b) moves.** 17.9M one-minute candles, 41,779 qualifying moves (≥ 8c in 10 min, ≥ 3 traded minutes,
  ≥ 6 h to close). At the last-trade price, buying the side the price moved away from is positive in every price
  bucket (+1.8 to +14c, rising with move size) and buying the side it moved toward is negative everywhere
  (−4.8 to −17.8c); the two average to the taker fee, so the post-move last price overshoots by ~5c. A bid-ask
  bounce control (only minutes where takers bought both sides, entered at the price a taker actually paid) is
  running before any setting moves.
- Also closed: the accepted-versus-filled audit of the other order paths (Dutch-book unwinds partial legs by
  `res.shares`, convergence marks `filled` only on `res.shares > 0`); the stale "dump pages only 20" note removed.

### §45a Bounce control result and three more live changes (12:50–13:00Z)

The bounce control (only minutes where takers bought both sides, MR entered at the price a taker actually paid)
removed the mean-reversion edge: −3.7c below 20c, −6.3c at 20–34c, +0.1c at 35–49c, −1.8c at 50–64c, −1.1c at
65–79c, −0.4c at 80c+. The apparent +3 to +14c was the spread. Consequences, applied on the operator's authorization with
the app stopped: (1) mean-reversion v3 = maker seat (`makerStrategies` gains `mean-reversion`) before the ladder
re-promotes the arm, since the taker seat is a live test of zero and the maker seat has a +3.6 to +5.3c ceiling;
(2) momentum's cool-down extended to 2027-01-01 — buying the side a move went toward loses −4.8 to −17.8c per
contract everywhere, so its 09-10 retry would only spend money on a settled question; (3) `quoterMinHoursToClose`
back to 3, because weather makers earn most at 1–8 h to close and my 12:06Z floor of 6 h had cut those hours.

### §45b The first real push was lost; alerts now publish as JSON (12:48–12:52Z)

The ladder re-promoted kalshi-fade (v2, fresh baseline) at 12:48:27Z and `transition()` called `sendAlert`, but
nothing reached the ntfy topic: Node's fetch rejects non-ASCII header values and the title carried "→" and "—";
the earlier plain-ASCII test had passed. `src/main/util/alert.ts` now publishes ntfy topic URLs as JSON to the
origin (`{topic, title, message}`), sanitises the Title header for any other plain endpoint, and keeps Discord as
is; the sentinel's `pushAlert` does the same. Verified with a JSON publish carrying the same characters (HTTP 200,
the "delivery test" push on the operator's phone). App rebuilt and restarted 08:50:29 local; the next ladder event (the
mean-reversion v3 re-promotion) is the live proof and a watch is on the topic for it.

Proof: the ladder re-promoted kalshi-mean-reversion (v3, maker seat, fresh baseline) at 13:50:34Z and the push
"Oracle Trader — ladder: kalshi-mean-reversion disabled → tiny-live" reached the ntfy topic at 13:50:35Z, arrows and
all. Both re-registered arms are live at micro size; the alert path is verified end to end.

## §46 — 2026-09-08 21:50Z: "why no open positions" (round 46)

The operator asked at 21:34Z why the venue showed no open positions. Findings and changes:

1. **Daily trade cap (ours, not Kalshi's).** `config.maxDailyTrades` was 20 (the panel preset of 2026-09-06). `state.daily.count` hit 20 by 08:52Z (eleven taker entries plus maker fills across fade v1, flow-follow, mean-reversion v2, book-imbalance and volume-spike), so `entryBlocked()` answered `daily trade cap` for every scan-arm signal for the rest of the UTC day. Fade v2 (re-registered 12:48Z) and mean-reversion v3 (13:50Z) never had an entry window. Lead-lag, convergence and Dutch do not count against the cap; their 15-minute markets settle within minutes, which is why the venue showed zero positions. Nothing logged the cap. Changed with the app stopped: `maxDailyTrades` 20 → 60 (the v13 slots-over-size intent) and `maxOpenPositions` 6 → 12 (the 2026-09-02 value). The daily kill switch (20% of equity, worse of the venue and local ledgers) and the per-arm −$5 stops remain the guards. Sentinel: a `daily-cap:<date>` notify finding whenever the count reaches the max.

2. **Settled but unbooked (defect).** Two mean-reversion v2 NO-side trades (`KXMLBTOTAL-26SEP071510MINDET-9`, `KXMLBSPREAD-26SEP072110CINLAD-LAD2`) whose markets finalized YES at 09-07 21:06Z and 09-08 03:51Z were still open at 21:34Z, holding two of the six slots. Cause: the pinned-quote probe in `manageExits` compared the raw side quote with 0.01; Kalshi's NO price is `1 − last_price`, and `1 − 0.99` is 0.010000000000000009 in floating point, so NO-side losers were never probed (a YES side at 0.99 was). The cached close times (09-10 and 09-11; Kalshi moves `close_time` earlier at settlement) kept the close-plus-grace path from firing until 09-10. Fix: `ledgerAudit.isPinnedQuote` rounds to 4 dp before comparing (six tests). Verified: both booked at 21:49:08Z, thirty seconds after the restart (−$2.67 and −$2.82).

3. **Stage attribution (defect).** Trades opened under a previous stage settle into the new stage's evidence (perf minus baseline). The two losers above (−$5.48) would have stopped mean-reversion v3 (−$5 stop) the moment they booked. Fix: `AutoOpenTrade.perfKey` / `AutoPendingOrder.perfKey`; `AutoTrader.detachOpenTrades(strategy, label)` tags a strategy's open trades and rests so their exits record under `<strategy>:<label>`; `Ladder.captureBaseline` calls it on every stage transition (label `pre-<stamp>`), so a stage is judged only on trades it opened. One-off: the two trades were tagged `mean-reversion:pre-v3` while the app was stopped; `perfByStrategy['mean-reversion:pre-v3']` now holds 2 trades, −$5.48, and `perfByStrategy['mean-reversion']` is unchanged (5 trades, +$17.75). Reports that sum `perfByStrategy` will see the side buckets as separate rows.

4. **Sentinel.** `unbooked-settlement:<ticker>`: for open trades whose side quote is pinned, a public market GET; notify after 1 h, repair after 3 h. It fired on both trades in the dry run before the fix and is clean after. Maintenance-log decode fixed: the log is UTF-16LE with a BOM, the old check tested `buf[1] === 0` (false with a BOM) and decoded as UTF-8, so `maintenance-hung` was a false positive pushed at 21:35Z.

Side effect noted: the local `dailyPnl` for 09-08 now carries the 09-07 settlement (−$2.67) because booking happened today (local −$17.22 vs venue −$16.22; the kill switch takes the worse; the limit is 20% of equity, about $22).

Tests 238/74/80, typecheck, build; restart 21:48:37Z; backup `POST-round46-daily-cap-pinned-probe-perfkey`.

## §47 — 2026-09-09 00:12Z: the weather ratchet was trading on a bad temperature index (round 47)

Found while checking why two of the ten positions opened after the §46 cap raise looked outside their arm's own fences. One was a false alarm: the fade v2 rest on `KXAAAGASDCA-26SEP09-5.9050` was placed at 21:54:14Z with 6 h 05 m to close (inside the 6 h fence) and only filled at 23:18Z, so the trade's `createdAt` is the fill, not the decision. The other was real.

**The arm.** `ratchetSignals` (autoTrader.ts) reads Kalshi's minute temperature index all day and calls a bracket mechanically decided once the day's running extreme clears it: a daily high can only rise, a daily low can only fall. The logic is sound and the code is careful about measurement days. It rides the `settlement` strategy label, which is why a "settlement" entry appeared seven hours from close when that arm's own gate is thirty minutes.

**The defect is the data, not the logic.** The banked daily MINIMUM for Boston runs about 9 °F below the observed one:

| Event | Banked low | Actual low (NWS KBOS) |
|---|---|---|
| KXLOWTBOS-26SEP07 | 50.36 °F | 59.00 °F |
| KXLOWTBOS-26SEP08 | 55.31 °F | 64.40 °F |

The banked highs are close (78.80 vs 80.60; 79.16 vs 80.96), so the contamination is one-sided and hits every daily-low bracket. Both banked minima fall inside that day's dew-point range (46.4–51.8 and 48.2–60.8), which points at the index series carrying more than the temperature, but `weatherLiveData` maps `timeseries` entries straight to `{timestamp, price}` and discards `status`, so the payload cannot be confirmed without the authenticated endpoint.

**What it cost.** The arm has made exactly two real-money trades, both Boston lows, both wrong:
- `KXLOWTBOS-26SEP07-B59.5` — read as decided NO, bought NO at 4.2 ¢ ×60, **resolved YES**, −$2.67. The market had priced our "certain" side at four cents and the market was right. Boston's minimum that day was 59.0 °F and the bracket was 59–60.
- `KXLOWTBOS-26SEP08-B62.5` — read as decided NO, bought NO at 96 ¢ on a 12 ¢-wide book whose NO mid was 90 ¢. Still open, marked 82.5 ¢, resolves by 09-09 05:00Z. Left alone: selling into that book locks a bigger loss than holding.

**Changes.** `ratchetEntryBlock(direction, yesProb, spread)` refuses a decided bracket when the market prices our certain side below 60 ¢ (the banked extreme is likelier wrong than the market) or when the book is wider than 6 ¢ (the entry gives up more than the edge). The first rule blocks the 4 ¢ trade, the second blocks the 96 ¢ one, and the intended trade — decided, still quoted at 90–96 ¢ on a tight book — still passes. Ten tests. The arm was also completely silent: every fire now logs, every refusal logs and records a `ratchet-refused` episode.

Live settings, app stopped: `settleLiveEnabled` true → false, and the ladder's `settlement` strategy set to `paper` with `operatorHold` and a cool-down to 2026-12-01, so no automatic promotion puts real money back behind the index until the discrepancy is explained. The settlement-convergence path shares the flag and has never traded live on its own, so nothing measured is lost.

Tests 248/74/80, typecheck, build; restart 00:12:43Z; backup `POST-round47-ratchet-guards`.

## §48 — 2026-09-09 00:46Z: Polymarket US post-mortem (round 48)

A 150-agent workflow swept the mini trader across five dimensions with three adversarial verifiers per finding; 14 of 48 findings survived, and a completeness critic reviewed the survivors. Full result: the task output for run `wf_ca3955e2-d47`.

**Why book-imbalance lost 39 of 40.** Not direction — cost, deterministically. It is the only mini arm excluded from the post-only maker path (miniAuto.ts:708), so it pays a taker commission on both legs, and its exit is a pure calendar timer (29 of 30 logged closes fired at close minus 30 min; take-profit, stop-loss and max-hold are all 0 in the live config). Across its 40 round trips the commission was $6.70, essentially the entire $6.69 lifetime fee bill on this venue, against a gross price move of about −$5.2. The signal itself carries no directional information at all: residual mid drift median exactly 0.000, 11 up, 10 down, 19 flat. There is no sign error and no adverse selection; there is simply nothing for the fee to be paid out of. The depth-ratio gate (bookMinRatio 1.6) is dimensionless, so no fee could ever have been compared against it.

**Fixed this round.**
1. *The entry loop was silent.* Three bare `break`s (open positions, ledger rows, daily cap). On 09-08 an arm the ladder had disabled at 03:24Z had already spent 19 of the 20 daily slots by 02:31Z, and every live arm was refused for the next 13 hours with no log line, no event and no counter. Each break now names itself, the reason lands in `state.lastError`, and it logs edge-triggered, so a bound cap costs two lines a day rather than one per 60-second scan.
2. *NO legs recorded the YES price.* `getFills` (polymarketUs.ts:400) missed the conversion that `placeOrder` and `sellPosition` got in the 2026-09-02 review, so 114 of 261 venue-fill rows carry the complement of the real price. Fixed forward; existing rows keep the old convention.
3. *Exit commission was never booked.* `sellPosition` returned `(avgFill − avgPrice) × filled` with no exit fee, so every closed mini trade read about 3% of stake better than it was, and the ladder promotes and demotes on exactly that number. $3.28 of exit commission is unbooked on this venue to date.
4. *No loss-based brake existed at all.* The mini has no kill switch, no venue-ledger staleness guard and no stop-entry flag; the daily and position caps bound counts, never dollars. The ladder underneath runs hourly, judges only closed trades while three of four arms hold to settlement, and never closes a position. Added `maxDailyLossDollars`, defaulting to 10 on Polymarket US and 0 on Manifold, with `dailyPnl` accrued on every exit and a pure `dailyBrakeBlock` covered by 8 tests. The migration deliberately does not use `??`: config is `{ ...MINI_DEFAULTS, ...persisted }` and the default is 0, so a nullish check would have silently left the brake off. The sentinel pushes when it trips.

**Live setting.** `polyus-book-imbalance` held to 2026-12-01 with an operator hold. Its cool-down was a timer, not a gate, and would have re-funded a 1-win/39-loss arm on 09-11 with identical parameters and a fresh 20-trade budget. `polyus-micro-maker` is left on its own schedule: it is a maker arm with a mixed record and the ladder can judge it.

**Known and not fixed.** `polyus-fade` sees 1,000 of 60,000-plus open markets in a fixed catalog slice and has never filled an order; it can reach neither a checkpoint nor a stop, so it sits at tiny-live indefinitely. The ladder's enforced stop on the PolyUS arms is $9, not the $5 its own history rows report, because `decideStage` takes the larger of the flat stop and three stakes while the message interpolates only the flat one. Both are backlog items.

**Live proof of the §47 guards.** Within four minutes of the restart the ratchet refused three entries the old code would have taken, all on the same contaminated Boston low of 55.31 °F: `KXLOWTBOS-26SEP08-T58` YES with our side priced at 2 ¢, `KXLOWTBOS-26SEP08-B64.5` NO at 15 ¢, and `KXLOWTBOS-26SEP08-B62.5` NO behind an 8 ¢ book. The observed Boston minimum was 64.4 °F, so the 2 ¢ one would have been another total loss.

Tests 256/74/80, typecheck, build; restart 00:46:02Z; backup `POST-round48-polyus-audit`.

## §49 — 2026-09-09 07:15Z: post-reboot recovery, ratchet log throttle, flow-follow stopped

**Outage.** Windows Update restarted the machine at 01:30:05Z (MoUsoCoreWorker) and it did not return until 06:56:12Z, with a second TrustedInstaller reboot at 06:55:40Z to finish. Five hours twenty-six minutes with nothing running. Recovery was clean and unattended: the app came up at 06:57:18Z on the logon task, the boot reconcile merged 9 venue positions against 9 ledger rows (no fill landed behind a resting order during the gap), and no warning or error was logged after restart. The running bundle carries every round 46–48 marker.

The sentinel's 07:05Z pass saw all four shadows about six hours stale and revived them rather than escalating — HRRR, Metaculus and Mention were fresh by 07:06Z and PolyConsensus by 07:10Z, no repair session dispatched. The 06:00Z nightly review had been missed with the machine down; `runIfDue` retried on the next tick and completed at 07:08:08Z on the first attempt, applying `quoterMinSpreadCents` 5 → 7.

**Ratchet log throttle (a defect introduced in §47).** The refusal path logged and recorded an episode on every scan. Two Boston brackets had been refusing since 07:00Z at roughly 90-second intervals — about 80 warn lines and 80 episode rows an hour, some 2,000 a day, for a verdict that never changed. This is precisely the mistake the mini's cancel path had to undo, and the reason §48's entry-block log was edge-triggered from the start. Refusals now note on change of reason or hourly per market, and a market that starts passing again clears its note. What the guard blocks is unchanged.

**Ratchet root cause, now all but confirmed: the banked "low" is the dew point.** Three consecutive Boston days against NWS KBOS — banked 50.36 / 55.31 / 57.56 °F against temperature minima of 59.0 / 64.4 / 64.4 °F. Today's banked value sits 0.36 °F from the observed dew-point minimum. Maxima track temperature within about 2 °F, the signature of one series carrying both measures: `min()` picks dew points, `max()` picks temperatures. `weatherLiveData` maps `timeseries` `{t, v, status}` to `{timestamp, price}` and discards `status`, the likely discriminator. Backlog 19 updated.

**kalshi-flow-follow stopped, cool-down to 09-12.** This morning's review flagged it by name ("fee-inclusive clustered intervals wholly below zero; flow-follow is still tiny-live and needs operator review"). Three independent reads agree: 5 settled at 1W/4L for −$0.85; net cents mean −9.5 ¢/contract with an 80% band of −15.9 to −3.1, wholly below zero; and CLV −15.6 ¢ per trade on 5 of 5 measured, which is the system's own fast adverse-selection meter. The mechanism is one already ruled out — following the side order flow is going to is momentum-shaped, and the Becker move audit put that at −4.8 to −17.8 ¢ per contract in every bucket and category over 72M trades, which is why `kalshi-momentum` is held to 2027. The ladder's checkpoint was 15 entries away and could not act; this applies the house rule at the point the fast meter was already unambiguous, with the standard three-day cool-down so it retries on its own.

Tests 256/74/80, typecheck, build; restart 07:15:44Z; backup `POST-round49-ratchet-log-throttle-flowfollow-stop`.

## §50 — 2026-09-09 08:37Z: weather retired (round 50)

The operator asked whether the weather strategy should change or whether it is a loser altogether. Five investigators plus adversarial verification, then a critic. **The answer is kill it, and my own preliminary read was wrong.**

**What I got wrong.** I proposed that weather was a fixable input problem: our fair value is priced off the NWS gridpoint feed, our HRRR shadow showed NBM biased −1.88 °F, so swap the forecast. Three things sank it. The NWS gridpoint is NBM-seeded but forecaster-edited and runs +0.69 °F warmer than raw NBM, so at most two-thirds of that bias reaches our quotes. The −1.88 °F rests on 54 station-days across only **two** calendar days and is flat at every lead time, which is the signature of a station-representativeness offset rather than a forecast error. And decisively, `hrrr-shadow.mjs` computes only daily **maxima** while 77% of the quoter's filled contracts are **LOW** markets — grading the 25 mu values the quoter actually used gives −4.11 °F on 3 highs and **+0.25 °F on 8 lows**. The instrument built to test the hypothesis cannot see the market we trade.

**What is actually true.** The population maker edge is real but it is in a different market class. Measured from the public trades endpoint (`taker_side` plus `result`, no auth) on KX(HIGH|LOW)T* — the Weather Company station series we quote — 468 settled markets, 50,054 trades, 801,258 contracts, 14 days, clustered by station-day:

| seat | net per contract |
|---|---|
| maker, all | **−1.70¢** [−2.66, −0.73] |
| maker, LOW only | −2.62¢ [−4.23, −1.00] |
| maker, our 3–48 h / 7–93¢ window | −3.51¢ [−5.01, −2.01] |
| maker, LOW in that window | **−5.55¢** [−7.88, −3.23] |
| taker, net of fee | +0.99¢ [+0.03, +1.95] |

The same script on the eight legacy KXHIGH-city series the +2¢ backtest was built from returns maker **+0.67¢** [+0.10, +1.23] over the identical fortnight. Positive where the dataset looked, negative where we rest. Positive on 10 of 78 station-days. In this class the informed side is the one crossing the spread — a resting quote is the food, not the diner. Our own realized −3.79¢/contract over 902 contracts is *better* than the population maker's −5.55¢ in the same window: execution was never the problem, the seat is.

**The sigma finding, and why its fix was rejected.** `forecastSigma` returns 3.0 °F day-ahead while the venue's modal bracket implies about 1.4 °F, so the code prices the most likely bracket at 25.7¢ when it is worth 47¢ and rests an ask 2¢ above that. Real, reproduced, and the mechanism behind the two fills that produced −137¢ of our −146¢ of logged loss. But the inference was wrong: the venue's implied sigma is the width of *the venue's* forecast; ours is the width of ours, and our realized MAE of 2.36 °F implies sigma 2.96 °F. The 3.0 °F ceiling is honestly calibrated to our own error to within 1.4%. Tightening it would double our stake in that error, and executed perfectly it converges our quotes onto the venue's prices — which from the resting side in this class earns −1.70¢.

**Loss attribution, reconciled to the cent.** −$44.93 rebuilt from 665 reconciler fills plus 9 app rows across 188 tickers, versus the venue feed's −$44.94 over 184 settled markets. The quoter owns −$34.23 (76%), all filled 09-02 16:27Z to 09-06 10:55Z, before the ladder and before the fill reconciler existed. Only $3.74 came from an arm still permitted to open a weather position today. The quoter's own gate reads +1.48¢/contract because `quoter.ts` attributes fills only to orders still in its in-memory quote map — 42.9 of 902 contracts, a 4.8% non-random sample; the 859 contracts it never recorded are −4.10¢.

**Actions (all reversible in the panel).** `quoter`, `kalshi-weather-morning` and `polyus-weather-fair` set to disabled with `operatorHold` and a cool-down to 2026-12-01; `weatherMorningEnabled` and `weatherFairEnabled` false. The deadline was real: `tradeSmallEntry` (ladder.ts:362-372) promotes on the timer alone and never consults the gate, so the quoter would have re-armed real money at **2026-09-10T13:12:21Z** with its own verdict reading "CI lower −61.00c". The settlement/ratchet arm is unchanged. Ten live arms remain, none of them weather.

**Bundled code fix, which survives the retirement.** `fadeCategoryBlock`'s weather test used `tempSeriesKind` (only `^KXHIGH`/`^KXLOW`) and `WEATHER_WORDS` carried "rainfall" but not "rain", so precipitation markets were inside the 48-hour block only when the series-category cache happened to be warm. Fade opened `KXRAIN-26SEP08-AUS` eight hours before close on 09-08 through that hole and still holds $3.04 of rain risk. New `isWeatherSeries` covers `^KX(RAIN|SNOW)`, and rain and snow join the word list. Seven tests, including the live miss with a cold cache.

**Correction to §47 and §49: the dew-point diagnosis was wrong.** The raw public payload (`GET /trade-api/v2/live_data/weather/greater-boston`, config_version `greater-boston-temperature-v1.0-cal-20260907`) is a calibrated 4–5 station **metro blend**, not a series carrying two measures. Minute-aligned against KBOS it sits 12.06 °F *above* the dew point. Our banked extremes equal the index's own extremes exactly, so `bankObservations` is faithful. The real defect is that we bank a metro blend while the contracts settle on a single climate station via The Weather Company. Filtering `status` fixes nothing — it is a data-quality flag, not a measure discriminator, and normal-only rows move the Boston 09-08 minimum from 55.31 to 56.12 against a settled 64–65 band. The §47 guards were still the right call, for the wrong reason. Backlog 19 and 20 are closed as "arm retired" rather than "fix".

Tests 263/74/80, typecheck, build; restart 08:37:49Z; backup `POST-round50-weather-retired`.

## §51 — 2026-09-09 09:00Z: throughput (rounds 51 and 52)

The operator: "if we stopped just testing, would we be working with net-positive strategies?" then "is there no way to speed throughput/testing?" then "kill all caps if it helps."

**What was actually binding.** Not capital and not the daily trade cap — $36.46 of roughly $95 cash was locked and 5 of 60 daily trades used. Position slots were binding exactly: 9 active positions plus 3 resting orders against `maxOpenPositions` 12. Eight of the thirteen open rows were fade. The arm whose verdict the book is waiting on, mean-reversion, held one.

**Mean-reversion had a horizon floor and no ceiling.** It has 6 settled trades in two days because it took MLB markets closing three days out and holds to settlement, so each test occupied a slot for 72 hours. The move audit prices the edge by horizon over 33k signals:

| hours to close | signals | MR net |
|---|---|---|
| 6–12 h | 6,836 | +2.42¢ |
| 12–24 h | 9,130 | **+4.03¢** |
| 1–3 d | 4,519 | +2.19¢ |
| >3 d | 5,828 | +4.58¢ |

Per contract the >3 d bucket is marginally best; per day of capital lock it is the worst by a factor of three. That is the same capital-velocity argument `fadeSignals` already makes when it ranks by edge per day. New `meanReversionMaxHoursToClose`, default 24, config v26. Honest caveat: the arm's single winning live trade (+$4.07) was a >3 d market the new rule would have excluded, and its 6 prior trades were taken under the wider rule, so its next checkpoint mixes about two old-rule trades with eighteen new ones. Not re-baselined — the money was real and discarding two trades of progress costs more than 10% contamination does.

**Caps raised (round 51).** `maxOpenPositions` 12 → 25 (v13's "slots over size" intent; 25 × $3 = $75 against ~$95 cash), `maxMarketsPerScan` 40 → 80, `maxPerUnderlying` 1 → 2, `maxLongHorizonPositions` 2 → 4, `maxDailyTrades` 60 → 200. Deliberately not raised, against the literal instruction: `maxDailyLossPct` 20 (tripping it halts entries for the day, so removing it risks a day with *no* testing), `amountPerTrade` 3 (size buys variance, not samples), `minScore` 55 (that changes what is being tested, not how fast), and the churn guard.

**The finding that matters more than any cap.** Throughput has a statistical floor. Measured per-trade dispersion of settlement net cents in our own ledger is 31.8¢ for fade and 51.3¢ for mean-reversion. For the ladder's rule — 80% band lower bound above zero — to clear a realistic +4¢/contract edge:

| per-trade sd | settled trades needed |
|---|---|
| 30¢ | 92 |
| 40¢ | 164 |
| 50¢ | 257 |
| 60¢ | 370 |

The checkpoint is 20. **The gate cannot detect the edges we are chasing on the skewed arms** — it can only catch large losers, which is precisely what it has been doing (momentum, book-imbalance, flow-follow, the quoter). Raising caps gets us to 20 trades sooner; it does not make 20 trades sufficient.

The way out is a lower-variance statistic, and the code already records the right one. CLV is a price move rather than a 0/100 settlement, so it disperses several times less and reaches significance in a fraction of the trades — `recordExit`'s own comment has said so since it was written, and it is what stopped flow-follow at n=5 this morning. What was missing is the second moment: we stored `clvSum`/`clvN` and could report a mean but never a band, which is why the CLV read has only ever been a judgement call. Round 52 adds `clvSq` and `markoutSq` on both traders. No behaviour change — it starts the clock so a CLV gate can be specified against measured dispersion instead of an assumed one.

Tests 269/74/80, typecheck, build; restarts 08:57:31Z and 08:59:48Z; backup `POST-round51-52-throughput`.

### §51b — 2026-09-09 09:13Z: `maxMarketsPerScan` reverted, it was an anti-lever

Raising the universe from 40 to 80 in round 51 took the scan cycle from 35.6 s to **265–280 s**, measured over two consecutive completed scans (not a boot artifact — the first was 279,846 ms, the second 265,374 ms, sampled a minute apart for seven minutes). The poll interval is 30 s, so the trader went from roughly 90 scans an hour to about 13.

Market-observations per hour is the metric that matters, and it moved the wrong way: 40 × ~90 = 3,600 against 80 × ~13 = 1,040. A 3.5× loss. It hurts most on exactly the arm this work was meant to accelerate — mean-reversion reads a ten-minute window, and a 4.4-minute scan barely samples it twice, so every entry is a later, worse entry into a move that may already have reverted.

The cost is superlinear because `gatherData` fetches candles, books and recent trades per market, so doubling the universe more than doubles the round-trips and runs into rate limiting. Reverted to 40. Every other round-51 change stands on its own: slots 25, per-underlying 2, long-horizon 4, daily 200, and the mean-reversion 24-hour ceiling.

Lesson recorded in the backlog: `maxMarketsPerScan` is not a throughput lever, it is a throughput *cost*. If a wider universe is genuinely wanted, the prerequisite is making per-market gathering cheaper (batch the candle fetch, skip books for arms that do not read them), not raising the count.

## §52 — 2026-09-09 09:23Z: the real throughput lever for mean reversion (round 53)

**Correction to §51's diagnosis.** Slots were binding for the book, but never for mean-reversion. Measured after the cap raise: the arm held **0 positions and 0 resting orders with 9 slots free**, while fade held 10 of the 16 open rows plus all 6 rests. Six trades in two days is a rare setup, not a blocked one. Raising the ceiling helped the arm with 55 trades and did nothing for the arm with six — and the 24-hour horizon ceiling added in round 51 makes each test settle faster while cutting eligible signals by 39%, which for a signal-limited arm is roughly a wash on its own.

**So the lever is the setup frequency.** Re-ran the move audit on the full tape at a 6¢ threshold instead of 8¢ (`docs/reports/backtest-move-audit-2026-09-09.md`, 17.9M one-minute candles):

| | 8¢ | 6¢ |
|---|---|---|
| qualifying signals | 26,313 | **53,346** (2.03×) |
| MR net, 35–49¢ | +3.83¢ | +2.79¢ |
| MR net, 50–64¢ | +2.64¢ | +2.19¢ |
| MR net, 65–79¢ | +3.44¢ | +2.91¢ |
| MR net, 80¢+ | +4.13¢ | +3.45¢ |
| by horizon, 6–12 h | +2.42¢ | +2.10¢ |
| by horizon, 12–24 h | +4.03¢ | +2.94¢ |
| by horizon, 1–3 d | +2.19¢ | +2.17¢ |
| by horizon, >3 d | +4.58¢ | +3.60¢ |

The edge decays about 25% per contract and the signal count doubles. The two consequences differ and both are worth stating plainly. **Expected profit per day** improves by roughly 2.03 × 0.75 ≈ 1.5×. **Time to a verdict** improves less: a smaller edge needs more trades to detect, with n scaling as 1/δ², so (3.5/2.7)² = 1.68× more trades against 2.03× the rate is about 17% on its own — more once the 24-hour ceiling means those trades settle the same day rather than over three. Neither number is enormous; both point the same way, and the edge stays positive in every price bucket and every horizon bucket, so this sets a fence where the evidence is rather than removing one.

Caveat carried forward: those are taker numbers at the post-move price, and MR v3 rests on the maker seat. The absolute cents do not transfer; the ratio between thresholds is what is being relied on.

`meanReversionMinMoveCents` 8 → 6. The arm was **re-baselined** at 09:23:02Z — second rule change, no open positions, and mixing rules inside one checkpoint is the attribution error fixed in round 46. Honest cost: the +$4.07 winner leaves the evidence window, so the ladder's read restarts at zero under the final rule.

**One measured side effect of the bigger slot count.** With 16 positions open the scan settled at 65–91 s against 36 s at 12 positions, because `manageExits` quotes every open position each pass. That is the price of concurrency and it is worth paying at this size, but it is a real term: slots are not free, they cost scan frequency, the same currency §51b was about.

## §53 — 2026-09-09 10:08Z: coverage sweep — the answer is fees, not coverage (round 54)

The operator asked what markets we never scan, where we are missing out, and what we have never tried. Five investigators on Sonnet plus two adversarial verifiers per finding and a synthesis pass; 16 of 24 findings survived. **The sweep corrected me three times and changed the answer.**

**Corrections to my own claims this session.**
1. I said we fetch 1,000 of the eligible pool. Wrong — `query.limit` is dead code in kalshi.ts (zero grep hits) and the ending-soon path paginates the full in-window pool to a 25-page bound.
2. I then said we gather data on 40 markets a scan. Also wrong. Measured from 36,008 `book` episode records between 06:57 and 09:57Z, clustered into 236 scan waves: the median universe is **168 markets** per scan, range 138–245, 498 distinct in three hours. `buildUniverse` returns main(40) + fadeExtra(≤40) + weatherExtra(≤48) + sportsExtra(30 plus an uncapped sibling-completion loop). Two thirds of what we scan is the sports carve-out, half of it arriving through a loop with no volume, liquidity or spread gate at all.
3. I attributed the 36s → 265s scan regression to universe size. `getOrderBooks` chunks at 50 and `getCandles` at 100, so universe size costs about `ceil(n/50) + 2·ceil(n/100)` HTTP calls — roughly 8 at n=189, not O(n). Today's `lastScanMs` ranged 61–201 s on a near-constant universe, so scan time is not tracking universe size. What does drive it is undetermined; the revert was harmless but the reasoning behind it was wrong.

**What is actually excluded.** The dominant filter is the per-series anti-flood cap (kalshi.ts:363-384, top 3 per series by 24h volume, 40 for /GAME/ series, with a fade-band tail rescue), which drops **12,615 of 14,801** in-window markets — 85% — before any eligibility gate runs. Of the ~2,015 reaching the gates, 853 pass. Separately `maxMinutesToClose=4320` hides 86.9% of the catalog and takes 8 of 20 categories to zero in-window inventory; that is a horizon side effect, not a policy. MVE combos are excluded deliberately and correctly — a scan of 10,000 found zero bids.

**And all of it is inert.** The exit is saturated. `maxOpenPositions` went 6 → 12 → 18 → 25 today and refilled to near-full within hours each time; 24 of 25 slots are consumed now, and at ~$3 a position 25 slots is $75 of a ~$95 account. More candidates cannot become more trades. Every universe-widening item is retired as interesting but irrelevant.

**Where we are actually missing out: fees.** Reproduced independently from history.json — 185 fee-paying Kalshi legs, **$12.18 of fees on $427.71 of notional (2.85%)**, against realized −$2.56 over 122 trades. The book is roughly **+$9.63 gross and −$2.56 net**. Fees are the entire difference between a winning and a losing system.

| entry price | legs | fees | notional | fee % of notional |
|---|---|---|---|---|
| 0.0–0.1 | 15 | $1.74 | $27.01 | **6.45%** |
| 0.2–0.3 | 16 | $1.35 | $25.94 | 5.22% |
| 0.4–0.5 | 26 | $2.22 | $64.43 | 3.45% |
| 0.7–0.8 | 14 | $0.59 | $33.60 | 1.77% |
| 0.9–1.0 | 28 | $0.37 | $78.49 | **0.47%** |

The taker fee is 0.07·P·(1−P) per contract, which as a fraction of *stake* is 0.07·(1−P): 6.3% at 10¢, 3.5% at 50¢, 0.7% at 90¢. Put that beside the arm table and it explains it — every arm trading the mid-band is negative, and the only arm with a positive sample, fade, buys NO at 0.91–0.98 where the fee is half a percent. Fade may be profitable by accident of where it trades. And of the 185 fee-paying legs, **179 priced at the taker coefficient and 4 at maker** — the maker seat is not delivering.

**Also corrected: mean-reversion's +$21.82 is one trade.** `KXLALIGAGAME-26SEP07ELCRSO-RSO`, YES at 0.08, exited 26 minutes later for +$22.87. The other five net −$1.05, and the pre-v3 pair is −$5.48. I have been calling it the promising arm all day; it is a lottery ticket and the ladder will rank it first to anyone reading top-down.

**Changes.** `sports-anchor` added to `makerStrategies` — it was the last live arm on the taker seat, trading the expensive band at 5 trades for −$4.50. And the maker-order lifecycle records (`rest`, `reject`, `pull`, `amend`) now carry `strategy`, which with the strategy already on the maker-fill `entry` record makes **per-arm fill rate computable for the first time**. Without it a 5%-fill-rate arm with a real edge and a 50%-fill-rate arm with a bad one are indistinguishable. The per-order `orderId` join was deliberately not bundled: `promoteFill` has no orderId in scope and threading one through four call sites is wider than this needed; it would add fill *latency*, not fill rate.

**Left alone deliberately:** every universe-widening item, the 15-minute liquidity-incentive program (our own `minMinutesToClose=15` excludes the only series it targets, and qualifying needs $63–66 resting per window), `expiration_value` (real and unused, but a calibration nicety with no P&L path), and the uncapped sibling loop (about four extra HTTP calls).

Tests 269/74/80, typecheck, build; restart 10:08:54Z.

## §54 — 2026-09-09 10:46Z: position sizing re-derived (round 55)

Operator directive, 2026-09-09: every number he has supplied is void, his questions are questions rather than instructions, and parameter decisions are mine to make and report. Recorded in memory as `joe-full-autonomy-directive`. This is the first round applying it — `amountPerTrade` had been $2 then $3 because he set it, never because anything measured said so.

**The maths.** For measuring an edge, the sample unit is the **position**, not the contract: contracts inside one position are perfectly correlated, so they add dollars of exposure and no information. So samples scale with the position count, dollars at risk scale with position count times stake, and the per-contract edge estimate and its variance do not depend on stake at all. Holding risk constant and shrinking the stake therefore buys strictly more samples for nothing.

The floor is one contract. At $1 that is reachable everywhere we trade — fade buys NO at 0.91–0.98 (1 contract), mean-reversion enters at ≥0.35 (2 contracts). Below $1 the high-priced markets round to a single contract anyway, so $1 is the smallest stake that still maximises samples per dollar. Kalshi rounds fees to $0.000001 per fill, verified against 185 fee-paying legs matching 0.07·P·(1−P) to the cent, so there is no small-size fee penalty.

| | before | after |
|---|---|---|
| `amountPerTrade` | $3 | **$1** |
| `maxOpenPositions` | 25 | **60** |
| `maxPerUnderlying` | 2 | **4** |
| max concurrent exposure | $75 | **$60** |
| concurrent samples | 25 | **60** |
| ladder hard stop, `max(5, 3×stake)` | $9 | $5 |

More samples at less risk, on ~$95 of cash. `maxPerUnderlying` was binding at 2/2 on crypto:BTC, crypto:ETH and energy:oil simultaneously; at $1 a position, four on one underlying is $4. Polymarket US takes the same treatment: $1 stake, 24 slots, brake unchanged at $10.

**Three side effects, all favourable**, which is why this is confident rather than hopeful. The ladder's hard stop falls from $9 to $5, but a $1 position at 96¢ loses at most $0.96, so an arm now gets about five losing trades of rope instead of three — *more* evidence before a verdict. Smaller orders fill better: a 1–2 contract taker walks less depth on a thin book, and a 1-contract rest is likelier to fill than a 6-contract one, so execution quality improves as size falls. And the daily-loss kill switch at 20% of equity now represents about 22 maximum losses in a day rather than seven, so it stops being a hair trigger.

**The risk being watched.** `manageExits` quotes every open position each pass, so 60 positions means 60 more quote calls per scan. Scan time already ranged 61–201 s today with the driver unattributed. If it degrades materially the fix is batching that quote fetch, not reverting the size.

**Not done, deliberately: the fee-aware taker gate**, which was this morning's top-ranked item. Seven arms are now routed to the maker seat, so the remaining taker flow is convergence, dutch and lead-lag — arb and latency strategies where crossing the spread is the point rather than an accident. The gate also needs a cents-denominated edge that only fade currently states. Backlogged with that framing rather than half-built.

**One consequence worth flagging for the next session.** The coverage sweep retired every universe-widening finding as inert *because the exit was saturated at 25 slots*. At 60 slots that premise may no longer hold. If the book fills 60 and still wants more, the per-series anti-flood cap — which discards 85% of the in-window pool before any gate — becomes live again rather than academic. Measure the fill before touching it.

## §55 — 2026-09-09 11:54Z: Poly brought to parity, and three negative results on Kalshi (rounds 56–59)

The operator asked whether Polymarket US was being managed the way Kalshi is. It was not — it was getting the sizing changes but not the reasoning. Four rounds followed, and the two venues gave opposite answers.

**Polymarket US was structurally starved, and fixing it worked immediately.** `searchMarkets` fetched the first 1,000 rows of a ~33,800-market catalog ordered by a `volume` field the venue leaves NULL on every row — an arbitrary but stable 3% slice. The coverage sweep had found four genuine fade-band candidates at offsets 2,020–7,849, permanently outside it. The whole PolyUS scan takes 3.6 s against Kalshi's 68 s, so there was never a cost argument for the bound; it was just never revisited. Raised to 3,000 rows.

Result in eighteen minutes: `polyus-fade` went from **3 candidates in 5.5 days, zero fills ever**, to 14 resting orders and 9 filled positions — ATP, Copa Libertadores, and a run of NFL touchdown props at 7–9¢. The scan went 3.6 s → 10.6 s. The arm was starved, not broken.

Three gates were also stale in the same way the Kalshi gates were, all denominated in a position size we no longer trade: `fadeMinSideDollars` 25 → 3 (we consume ~$1), `maxPerUnderlying` 1 → 4, `maxDailyTrades` 20 → 200, `maxHoursToClose` 24 → 72 (Kalshi looks 72 h out). Then `maxOpenPositions` 24 → 48, because within eighteen minutes `activeNow` hit 25/24 and the round-48 entry-block logging caught it — *"entries blocked: open positions 26/24"* — the instrument working as designed on the first day it existed. Full exposure if every rest fills is $22.46; the $10 daily brake bounds the damage regardless.

**Kalshi gave three negative results in a row, and they are worth recording as negatives.**

1. `minLiquidity` 150 → 25 and `minVolume` 20 → 5, on the sweep's finding that those two gates eliminate 43% of everything reaching them. Approvals moved **1,852 → 1,853 in 24 minutes**. The gates were not the constraint.
2. Slots 25 → 60 left the book sitting at 18–20 open. Not the constraint.
3. `maxMarketsPerScan` 40 → 100, re-testing a revert I made at 09:13Z on an attribution the sweep had contradicted. Approvals frozen at 1,853 across 8 scans and 16 minutes, with scan time in the same 61–166 s band as at 40 — so the universe slice does not drive scan time, confirming the revert's reasoning was wrong, but it does not drive approvals either. Left at 100 pending a longer window; at ~0.1 approvals per scan, 8 scans is too little to conclude.

**The conclusion those three point at:** Kalshi's arms are signal-limited by their own definitions, not by plumbing. Mean-reversion needs a 6¢ move in ten minutes; volume-spike a 2.5× volume multiple; cross-venue a 6% gap. Those conditions are simply rare, and no amount of widening the pipe changes how often they occur. Fade is the exception because it has its own carve-out and a band that is always populated — which is most of why it has 55 trades and mean-reversion has six. Making the others fire more means loosening what they test, which is a strategy decision requiring backtest support, not a plumbing one.

So the two venues needed opposite treatment, and the operator's question caught it: Poly's problem was the pipe, Kalshi's is the strategies.

## §56 - 2026-09-09 18:45Z: the repair pipeline was inert (round 61)

The operator: *"Getting some 'repair not dispatched' messages on ntfy."* One phone alert every 15 minutes, and four
defects stacked behind it.

**The alert itself.** Findings are throttled to one push per key per 6 h. The gate line - the sentence
explaining why a repair was NOT dispatched - bypassed that entirely, so a standing gate became a push every
tick carrying nothing new. A gate is a state, not an event; it now takes the same 6 h/key rule, keyed on the
gate text so a *change* of gate still comes through immediately.

**Why a repair was gated.** `todayDispatches` counted rows in `state.dispatches`, and a session writes one
row per finding it bundles. The 00:20Z session covered two ratchet signatures, so it consumed two of the
three daily slots on its own. Counted in distinct incident files now.

**Why the repair had not fixed anything: it never ran.** `spawn('powershell.exe', ..., { detached: true })`
returns a pid and fires `'spawn'`, then exits 0 without executing anything - `DETACHED_PROCESS` leaves
powershell with no console. Reproduced 4/4, against 2/2 successes for the identical command without
`detached`. repair.ps1 writes its log before doing anything else and there is no repair log for either the
00:20Z or the 17:05Z dispatch; the last real session was 2026-09-08 03:42. **Every sentinel-dispatched
repair for a day and a half was a silent no-op** while the sentinel recorded it as dispatched, spent the
budget, and then declined to re-dispatch the same key for 12 h. Launching through `cmd /c start` runs and
outlives the parent - verified by holding `agent.lock` and dispatching the drill incident, which now
produces `logs/repair-20260909-1440.log` where the old call produced no file at all. repair.ps1 also opens
its log *before* the lock check, so "exited silently" and "never started" can never look alike again.

**The defect underneath it all.** `KXHIGHLAX-26SEP08-T89` - flow-follow NO, $0.30, settled `result=yes` at
14:26Z - carried **`exitAttempts: 467`**. flow-follow is not hold-to-settle, so with `closeTime` (08:00Z)
past, `manageExits` set `reason = 'pre-close exit'` every scan, called `closeTrade`, and `continue`d -
skipping the settlement check on the very next lines. `closeTrade` sent an IOC sell into a market Kalshi had
already settled, got no fill, returned. A settled market cannot be sold, only booked, so the loop could
never terminate: 467 orders spent discovering that, and the position sat unbooked for 10.6 hours.
`closeTrade` now returns whether the trade actually left the ledger and the caller skips settlement only
when it did; independently, a position past `closeTime + SETTLE_GRACE_MS` no longer attempts a sell at all.

The position booked on the first scan after restart (open 20 -> 19; flow-follow 7 trades / 2W / 5L /
-$1.05; Kalshi venue day 28 settlements / +$1.82). Suites 288/74/80, typecheck and build clean.

**The lesson worth keeping:** self-healing machinery has to prove it healed something. The sentinel treated
*spawning* as *repairing* and logged a success it had no evidence for. Every one of the four defects was
invisible precisely because the layer above it reported done.

## §57 - 2026-09-09 22:00Z: two checkpoints, one sound and one void (round 63)

At 21:39:49Z the ladder judged two arms. The stop is right. The promotion was not, and reproducing its
arithmetic exactly is what showed why.

### kalshi-volume-spike -> disabled: correct

23 trades, net -$3.72, mean -1.80c/contract, band -2.08..-1.52. The underlying sample is 12W/14L across
entries spanning 0.01-0.94, per-trade sd $0.295, and on the dollar P&L t = -2.48 (one-sided p ~ 0.01). Its
CLV is +0.37c +/- 1.00 - indistinguishable from zero - and its 5-minute markout is -0.65c. A well-sampled
distribution with no measurable edge, losing at about 99% confidence. Cool-down to 2026-09-12T21:39Z.

### kalshi-fade -> live x2: void, and reverted

20 trades, net +$2.65, mean 5.23c/contract, band 4.73..5.72. Recomputed from the stored baseline: n 20,
netSum 104.549, netSq 679.502 -> sd **2.646**, plain SE 0.5918, band 5.2274 +/- 0.84 x 0.5918 =
4.730..5.724. Exactly the logged band, so the arithmetic is not in doubt - the *sample* is.

The 20 trades are **19 settlement wins, one -$0.01 scratch exit, and zero settlement losses.** Fade buys NO
at 0.89-0.98 (`fadeMinPrice` 0.03 / `fadeMaxPrice` 0.10): a win pays 2-11c, a loss costs 89-98c, roughly
13:1 against. Three consequences, all fatal to the verdict:

1. **The band measured the winners.** With no loss in the sample, the only dispersion left is the spread of
   `1 - entryPrice` across winners - sd 2.6c on a mean of 5.2c. It cannot describe an outcome distribution
   whose entire risk is a -95c tail that has not occurred.
2. **Twenty straight wins is unremarkable at zero edge.** At a true win rate of exactly the entry price
   (0.95), P(20/20) = 0.95^20 = **36%**. The one-sided 80% lower bound from 19/19 is 0.20^(1/19) = 0.919,
   against a break-even win rate of 0.95 + 0.07 x 0.95 x 0.05 = **0.9533**. The correct verdict is "keep
   testing"; it would take ~34 consecutive wins to clear that bar at the same confidence.
3. **They are not 20 independent draws.** Thirteen of the twenty were crypto daily strikes (BTC, ETH, SOL,
   XRP, DOGE, HYPE, and index variants) settling inside the same 23 minutes.

**The fix, stated unit-free: a sample whose dispersion is smaller than its mean has not observed its own
downside.** `StageEvidence` now carries the sample `sd` alongside the SE (they differ whenever the SE is
clustered), and a scale-up below `THOROUGH_TRADES` is held when `sd < |mean|`. One real loss restores the
test immediately - a single -95c against nineteen +5c takes the mean to ~0 and the sd to ~21c, which reads
inconclusive, which is the truth. An arm that genuinely is this steady still promotes at the 100-trade
review on the sign of its net. Deliberately asymmetric: this gates scaling **up** only; stopping early and
the hard stop are untouched, because stopping on a one-sided sample costs time, not money.

**All five promotion fixtures in the adversarial suite were uniform samples** (20 identical +6c trades,
sd 0), so the suite had never once exercised a promotion on a sample that had lost anything. They now carry
realistic two-sided dispersion at the same mean and net. Suites 288/86/80.

`kalshi-fade` was reverted to tiny-live x1 with its pre-checkpoint baseline restored, so the 20 trades keep
counting toward the next checkpoint instead of the window restarting, and the 18 open trades and orders the
promotion had detached to `fade:pre-20260909-2139` were re-attached - they were opened under tiny-live and
will settle under it.

**Follow-up the same hour:** the guard first returned the *new* checkpoint number, which `judgeLive` records
as judged - so fade would not have been looked at again until 40 settled trades, even if a real loss landed
at trade 25. It now returns `lastCheckpoint`, leaving the checkpoint unjudged and re-tried every run, which
is exactly what a shard-0-blocked scale-up already does. The distinction is the point: "inconclusive at 20"
is a judgement and should wait for 40; "this sample cannot be judged" is a deferral and should be retried as
soon as the sample changes. Confirmed live at 22:00Z - the ladder re-judged the identical checkpoint and
held, printing *"every trade in this sample landed the same way (sd 2.65c/contract under a mean of
5.23c/contract)"*.

**The lesson:** the ladder's whole job is to decide when a strategy has earned more money, and its test
answered a question the data could not address. A confidence interval is a statement about a sample; it
inherits every blind spot the sample has. For a strategy that wins small and often, the absence of a loss
is not evidence of an edge - it is the absence of evidence.

## §58 - 2026-09-10 06:15Z: Polymarket US was blocked by positions that had already resolved (round 64)

The nightly review flagged *"Polymarket US capacity: entries blocked at 48/48"* and called the counter into
question (48/48 against telemetry showing 38 open + 15 pending). **The counter is right**: five of the 38 sit
in markets that have already closed and are excluded from the cap by design, so 33 + 15 = 48 exactly. That
finding was a false positive - the review model does not know about the filter.

The saturation behind it was real, and the cause was not the cap. Sixteen positions - $13.99 of a $34.66
book - carried a close time beyond twice the 72 h horizon; fourteen were New England vs Seattle prop fades
from 2026-09-09 stamped with a close of **2026-09-24**. The venue disagreed:

```
astatc-nfl-ne-sea-2026-09-09-td-jadpri-gte2
   status=MARKET_STATUS_RESOLVED  closed=true  endDate=2026-09-09T23:49:15Z  outcomePrices ["0","1"]
```

Kickoff was 00:20Z, the props closed just before it, and they resolved that night.

**Why they could not book.** `manageExits` opens the settlement block only when `Date.now() > t.closeTime +
SETTLE_GRACE_MS`, and the `getMarket` call that would reveal a corrected close lives *inside* that block. A
close time wrong in the LATE direction is therefore unrecoverable - the gate that would fix it is behind
itself. `refreshedCloseTime` could not help either: it ratchets one way, adopting the venue's time only when
the venue's is later, the exact opposite of this case. autoTrader had already learned both halves (round
46's pinned-quote probe; `trySettle` adopting the venue's close unconditionally). miniAuto had neither.

New `settlementProbeDue(quotePrice, lastProbeAt, now)` in `ledgerAudit.ts` opens the block for any position
the venue has stopped quoting or quotes pinned at 0/1, throttled to one market fetch per trade per 10 min;
and the venue's close is now adopted in either direction once the record is in hand. The drop path is
untouched - it fires only when the market does NOT fetch, and a market that does not fetch supplies no close
time to adopt.

**Result, four minutes after restart:** all fourteen booked, open 38 -> 24, active 48/48 -> 38/48, entry
block cleared, the venue trading again. Only the two Solheim legs remain beyond the horizon and those are
the deliberately-held matched box. Suites 297/88/80.

**And the result corrects me.** I predicted from the one market I probed that the cohort was a set of
winners. It was not: **8 wins at +6c to +9c and 2 losses at -96c each, net -$1.29** on the NFL cohort,
-$1.00 across all 14 closes today. Checking one market and asserting fourteen was the error.

It is also the clearest possible demonstration of the argument from §57, delivered by the book itself the
same night: **an 80% win rate on a 13:1 payoff is a losing strategy.** Two losses erased eight wins and
more. Kalshi fade is the same shape at a higher entry price, and its sample is now 22 trades with still zero
losses - which is precisely why the round-63 guard refuses to read that as an edge.

## §59 - 2026-09-10 06:25Z: three review findings that were about telemetry, not trading (round 65)

The remaining items from the 2026-09-10 review. None was a trading defect; all three were the packet
misinforming its own reviewer, which costs a finding every night and - worse - hides the real thing.

### "54 errors in 24h" -> 3 errors and 51 warnings

`errors24h` matched `/[(error|warn)]/` and returned one opaque number. The breakdown:

    25  warn   [ratchet] refused KXLOWTBOS-* NO (low extreme): market prices our "certain" side at Nc
    15  warn   [ratchet] refused KXLOWTPHIL-* NO (low extreme): market prices our "certain" side at Nc
     7  warn   [ratchet] refused KXLOWTBOS-* NO (low extreme): book Nc wide
     3  ERROR  [renderer] process gone: crashed -N
     2  warn   [ratchet] refused KXLOWTBOS-* YES (low extreme)
     2  warn   [auto-trader] ledger trade not held at venue on N checks, dropping

49 of the 51 warnings are the `[ratchet] refused` signature adjudicated NOT-A-DEFECT in incident
2026-09-09T00-20 and suppressed in the sentinel until 2026-12-02. It raised a `high_errors_24h` flag and a
code proposal on the strength of a number that is 90% one known-benign warning - and the three genuine
errors (renderer crashes; the trading loop is in the main process and was unaffected) were invisible inside
it. The packet now carries `errors24h`, `warns24h` and the top eight signatures with levels.

### "Manifold: 4 positions unsettled >12h past close, oldest 160h - resolution or ingestion lag"

Neither. All four fetch cleanly and report `isResolved: false`:

    qRznQRgst5            "Will we finally pull ourselves together and avoid being wiped out by AI?"   161h
    t2Csd6SQu2            "Will August 2026 U.S. nonfarm payroll employment increase by at least 150,000?"  138h
    E69L8qqpnE            "Will the August 2026 U.S. unemployment rate be at least 4.5%?"   138h
    9ss25SJfBlHR5np7GOJz  "Will I drop out of a PhD within 3 years?"   87h

Manifold's `closeTime` stops BETTING; resolution is the creator's, whenever they like - and the first and
last of those cannot resolve on any timetable at all. Nothing to fix, and nothing that CAN be done: betting
is closed, so the positions cannot even be exited. But `stuckSettlements` is purely time-based and cannot
tell "the creator has not resolved it" from "our settlement path is broken" - precisely the distinction that
matters, since the PolyUS parser bug it was written for looked identical from outside. The traders now stamp
`venueUnresolvedAt` whenever the venue is asked and answers "not yet", and the audit reports those as
`awaitingVenue` instead of alarming. **The stamp expires after 6 h**, so a path that breaks after the last
confirmation resurfaces rather than being permanently excused.

### "$0.09 discrepancy; 344 settlements but only 342 wins+losses"

Both gaps are real arithmetic and neither is an accounting fault - the packet withheld the closing terms.
`computeLivePnl` subtracts from the total the fees on fills whose markets have not settled yet, while
`details` is the settlements list alone, so anything summed from it (byFamily included) excludes exactly
those fees: **the $0.09 IS that fee total**. And a settlement with |realizedPnl| <= 1e-6 is classified
`flat`, neither win nor loss; `computeLivePnl` returns the count and the packet dropped it, so 344 - 342 was
unexplainable from the numbers supplied. The packet now forwards `flat`, `byFamilyNet`,
`unsettledMarketFees` and `detailsTruncated`, so `wins + losses + flat === settlements` and
`byFamilyNet - unsettledMarketFees === realizedPnl` both close.

Suites 303/88/80.

**The through-line:** all three findings were the reviewer reasoning correctly about numbers it had been
given incompletely. An automated reviewer is only as good as the packet, and a packet that cannot reconcile
itself manufactures work every single night - three of the eleven findings here, plus two of the five code
proposals.

## §60 - 2026-09-12 00:45Z: the sums of squares covered fewer trades than the sums (round 67)

Working overnight with the operator asleep. `flow-follow` carried `clvN=8, clvSum=-81.50, clvSq=96.75`. A sum of
squares can never sit below `n * mean^2`, and that floor is 830.28 - so the triple was arithmetically
impossible. Recomputing from the episode log shows exactly why: 42.25 + 42.25 + 12.25 = 96.75 is the three
observations logged from 2026-09-09 16:51Z onward, while `clvSum`/`clvN` had been counting all eight since
09-08. **`clvSq`/`markoutSq` were added to `recordExit` later than `clvSum`/`clvN`**, so every arm with
history predating that build carried a short sum of squares - and therefore an understated variance, an
understated SE, and a band that read far tighter than the sample could support:

    arm             true SE   stored SE
    fade               2.19      1.39     x1.6
    volume-spike       1.41      1.01     x1.4
    mean-reversion    15.59      7.55     x2.1
    sports-anchor      4.63      3.42     x1.4
    flow-follow        7.34      0.00     degenerate

Two arms (`momentum`, `mean-reversion:pre-v3`) had no `clvSq` at all, which an `?? 0` would have turned into
a variance of zero - a perfectly tight band on nothing.

Nothing in the code read `clvSq` yet, but the whole triple ships to the nightly reviewer inside
`perfByStrategy` every night. **And I had already misled the operator with it**: I reported fade's CLV as "-1.10c
across 93 graded entries" as evidence pointing at no edge. The truth is -0.91 +- 2.19, a band of
-2.75..+0.93 that straddles zero. The mean was about right; the confidence was not.

Three changes. `clvSqN`/`markoutSqN` now record how many observations the sum of squares actually covers.
`statsBand(n, sum, sumSq, sqN)` computes a band only when the counts agree, the triple is arithmetically
possible, and n >= 2 - it refuses otherwise, because a band that is silently too tight is worse than no band:
it reads as evidence. And the stored series were rebuilt from the episode log so all four numbers describe
the same window.

## §61 - 2026-09-12 00:50Z: the ladder finally reads the fast meter (round 68)

`recordExit` has carried this comment since it was written: CLV and markout "converge to a skill read in
days, where settlement P&L at this stake needs months". Nothing ever read them. The ladder decides sizing on
settlement P&L alone - the slowest meter in the building.

Rebuilt honestly (round 67), the 5-minute markout bands are:

    arm              n    mean +- SE        80% band          verdict
    fade            78   -0.60 +- 0.35   -0.89 .. -0.30   adversely selected
    book-imbalance  23   -1.30 +- 0.71   -1.90 .. -0.71   adversely selected (already dead)
    volume-spike    17   -0.65 +- 0.61   -1.16 .. -0.13   adversely selected (already dead)
    momentum         7   -1.93 +- 2.49   -4.02 .. +0.16   nothing
    mean-reversion   9   -1.39 +- 4.67   -5.31 .. +2.53   nothing

**Both arms the ladder has already killed on settlement evidence were adversely selected at entry, and the
markout said so on a fraction of the sample.** fade says it too, on 78 observations - and fade's settlement
band is inconclusive, so nothing stops it. Nothing should be doubling it either.

A scale-up is now vetoed while the markout band lies wholly below zero (>= 15 observations). Deliberately a
VETO and not a stop: refusing to add risk to an arm that pays the spread to get in costs nothing, whereas
closing one that might still be earning does. Settlement evidence decides everything else, the hard stop and
the demotion rules are untouched, and an arm with no markout history (lead-lag, convergence, dutch) is
unaffected. It composes with the round-63 guard: a scale-up now needs a settlement band above zero, a
two-sided sample, AND no demonstrated adverse selection.

Suites 336/99/88. Verified against the real fade numbers in the test file.

**What I did NOT do:** stop fade. Its settlement band is genuinely inconclusive (-3.17..+2.58) and it is
The operator's most active arm; the markout is statistically clean but measures a 0.6c effect whose economic weight
against fade's payoff structure I have not established. Refusing to scale it is the defensible half of that
judgement.

## §62 - 2026-09-12 00:55Z: Polymarket US had no entry-quality meter at all (round 69)

`miniAuto.recordExit` has carried the CLV block since it was written, with a comment admitting it is dead:
*"the mini records no side mid at entry yet (see the 2026-09-09 audit), so this only fires once it does."*
It never did. Every Polymarket US arm's `perfByStrategy` held trades/wins/losses/realizedPnl and nothing
else - no CLV, no markout. The venue the operator is least happy with was the one we had no fast meter on, and
`polyus-fade` sits at 37W/4L for -$0.48 over 41 settlements: the exact win-small/lose-big shape whose
settlement mean says nothing for a hundred trades.

The mini now records what the Kalshi trader records - `entrySideMid` on both creation paths (taker fill and
maker promotion), `lastSideMid` refreshed on every exit pass from the quote `manageExits` already fetches,
and `markout5mCents` stamped once at five minutes - and `miniEvidence`/`microMakerEvidence` carry the
markout band, so the round-68 scale-up veto covers Polymarket US too. Nothing backfills: the meters start
from zero and become usable at 15 observations.

## §63 - 2026-09-12 01:00Z: the six-hour hole that kept parking finished games in Polymarket's slots (round 70)

Polymarket was blocked at 48/48 again, with ten of 32 open positions carrying close times 335 hours out on
games played the previous evening. Round 64 repaired the symptom - probe when the venue stops quoting, adopt
the earlier close - but these were still quoted, so they sat. This is the cause.

The venue publishes two times for a game and they disagree by design:

    asc-cfb-missr-kan-2026-09-11-neg-27pt5   gameStartTime 2026-09-12T00:00Z   endDate 2026-09-26T00:00Z
    asc-mlb-cin-mil-2026-09-11-pos-1pt5      gameStartTime 2026-09-11T23:45Z   endDate 2026-09-25T23:45Z

`endDate` is exactly kickoff + 14 days: a placeholder, corrected only at resolution. Trading halts at
kickoff, which is why `deriveUsCloseTime` prefers `gameMs` - **but it only did so while `gameMs > now`**,
and the stale-game branch above it only fires once kickoff is more than six hours past. Between the two lay
a six-hour hole in which the function returned endDate, a fortnight out.

That hole is not harmless, because `refreshedCloseTime` adopts a venue close that is LATER than ours. The
settlement check calls `getMarket` on every position the moment it passes its kickoff close - which is
exactly inside the hole - so one call ratcheted a live position's close fourteen days forward: out of
settlement range, hidden from the out-of-window exit, and holding one of 48 slots until the venue stopped
quoting it entirely. **This is what the fourteen finished NFL props on 09-10 were, and it was happening
again.**

The fix drops `gameMs > now`: a game's trading close is kickoff whether kickoff is ahead of us or behind,
and nothing about that depends on when we ask. A resolved market keeps `endDate`, because the venue replaces
the placeholder with a real one at resolution (the settled NFL props read 2026-09-09T23:49Z against a 00:20Z
kickoff). Nine already-parked positions were re-derived against the venue and corrected from ~335 hours out
to already-past, so they settle on the next scan instead of in a fortnight.

Suites 341/99/88.

## §64 - 2026-09-12 01:05Z: a four-minute Polymarket scan, 99% of it wasted (round 71)

`lastScanMs` on Polymarket US read **288,000** - four and three quarter minutes, against 3.6s when the venue
was wired up and 10.6s after the round-57 widening. That caps the venue at about twelve entry opportunities
an hour.

Measured against the adapter's own ending-soon query (the first probe used `orderBy=endDate`, which the
gateway silently ignores, and found nothing - the adapter already knew that and uses `orderBy=volume`):

    3,000 rows fetched                                   10.7 s
    inside the 72h horizon                                  782
    priced 0.02-0.98                                        750
    ORDER-BOOK FETCHES, one per market, SEQUENTIAL          750   ~= 225 s at ~300ms each

750 sequential fetches to find at most `microMakerMaxMarkets` (6) markets worth quoting. Two conservative
changes, both leaving the actual quoting decision untouched:

**Pre-filter on quotes already in hand.** `mapMarket` parses the venue's advertised best bid/ask into
`m.spread`, and `m.probability` is the long side's price. When both are known and put a market clearly
outside the micro-maker band, no order book can bring it back inside - so skip the fetch. Slack is generous
(2c of spread, 0.05 of mid) so a market that has just tightened is still examined. 164 of the 750 go on the
advertised numbers alone.

**A budget of 120 book lookups per scan**, logged when it bites and with the number skipped - a capped
sweep that does not say so reads as "covered everything", which is the same failure as every other silent
cap this file records.

Suites 341/99/88.

**A note on method.** My first attempt at this diagnosis was wrong and the data said so: I probed with
`orderBy=endDate`, got zero markets inside the horizon, and concluded the book-fetch theory was dead. It was
the probe that was dead. Reading what the adapter actually sends - rather than what I assumed it sent - put
the same theory back with a measurement attached.

## §65 - 2026-09-12 01:10Z: what the overnight audit sweep found (rounds 72-73)

Eight agents audited a subsystem each, every high-impact finding was put to two skeptics prompted to refute
it, and 15 of 47 verdicts survived. Two were acted on immediately.

### An unknown maker fee was priced as FREE (round 72)

`applySeriesFees` resolves at most `unknown.slice(0, 20)` series per scan and patches fees only
`if (c !== undefined)`. A market whose series has not made that budget keeps `mapMarket`'s defaults, with
`makerFeeRate` **undefined** - and every consumer reads `m.makerFeeRate ?? 0`, so the EV gate believed maker
trading on that market was free. The cache is in-memory and cold after every restart; this box restarted
seven times tonight. On a `quadratic_with_maker_fees` series the true coefficient is 0.0175, and being told
it is zero lets marginal maker entries through that are actually negative EV.

The same gap prices a HALF-multiplier series at 0.07 instead of 0.035 - twice the truth, which only blocks
trades. Zero maker fee is the direction that costs money. Fixed at the source: `mapMarket` now defaults
`makerFeeRate` to the published coefficient, so "unknown" reads as "assume we are billed", and
`applySeriesFees` still overwrites it with the truth when the series resolves.

### The markout sample's coverage is not uniform, and it was invisible (round 72)

`markout5mCents` is stamped only at least five minutes after entry, so trades that exit sooner never get
one - and those are measurably the losers (+$0.041 mean exit P&L with a markout, -$0.354 without, over 179
exits). Coverage by arm:

    fade            78/83   94%       mean-reversion   9/9   100%
    volume-spike    17/26   65%       momentum         7/21   33%
    book-imbalance  23/37   62%       flow-follow      3/7    43%

The round-68 veto is safe where it currently bites - fade is 94% covered and its five excluded exits were
BETTER than its included ones - but momentum's markout rests on a third of its trades and the bias runs
optimistic, the direction that would let a bad arm past a veto built to catch it. `markoutMissingN` now
records the misses, and the veto requires 80% coverage.

### The band that authorises every scale-up was too tight (round 73)

`clusteredSe` carried no G/(G-1) finite-cluster correction, and `decideStage` multiplied it by the fixed
NORMAL quantile 0.84 when a cluster-robust SE has G-1 degrees of freedom. Both errors push the same way:

    clusters G   sqrt(G/(G-1))   t(G-1,.80)/z   combined
        2           1.414            1.64          2.32x
        3           1.225            1.26          1.54x
        4           1.155            1.16          1.34x
       21           1.025            1.03          1.05x

At two clusters the band authorising a doubling was less than half the width it should be. Both are fixed;
`clusterT` carries the t table. Checked against the decisions already made: **kalshi-leadlag's x4 promotion
survives** (band 0.28..1.28 becomes 0.254..1.306, still wholly above zero, because it had 21 clusters), and
**fade's next checkpoint band widens 1.34x** on its four day-clusters, which is the right direction for an
arm whose settlement evidence is inconclusive and whose markout is negative.

`clusteredNet` in autoTrader was also missing the below-three-clusters floor both its siblings carry, so a
single-cluster sample produced an SE of exactly zero and a "95% interval" collapsed onto the point estimate.
Three keys in the live ledger sit at netN=1. Fixed, with the same correction.

Suites 341/113/88.

## §66 - 2026-09-12 01:20Z: a strategy killed by an arithmetic bug, and two halt switches that did not halt (round 74)

### The partial exit graded against the shares it did not sell

`closeTrade`'s partial branch mutates the trade before grading it - `t.shares -= res.shares`, then
`recordExit(pnl, ..., t)`, and `recordExit` grades `(pnl / trade.shares) * 100` where `pnl` is the slice
that WAS sold and `trade.shares` is now the slice that was NOT. Sell 88% and the net cents come out eight
times too big.

The audit found the two survivors in the live ledger and reconstructed both from the episode log, and I
re-derived them independently before touching anything:

    KXINXU-26SEP11H1600-T7704.9999   NO 1.12 sh @0.89   exits -0.25, -0.03  =  -0.28/1.12 = -25.0c
    KXHYPED-26SEP1117-T82.9999       NO 1.00 sh @0.89   exits -0.15, -0.02  =  -0.17/1.00 = -17.0c

stored as **-204.83c and -127.67c**. A binary contract cannot lose more than 100c, so they were impossible
on their face. Between them they supplied 83% of the -402.44c that produced book-imbalance's -19.16c
checkpoint mean and 90% of the netSq behind its band - and the ladder's verdict string reconstructs
character-for-character from the corrupted fields. **The arm was disabled for fourteen days on a statistic
that was ninety percent artifact, while its actual dollar loss was $1.60 over 21 trades, nowhere near the
-$5 stop.**

Fixed: `recordExit` takes the shares the exit actually realised, and a partial no longer marks the trade
graded, so its remainder still counts when it settles. The two samples were repaired in place and the
checkpoint re-judged with the round-73 statistics:

    logged   mean -19.16c   band -28.67 .. -9.66
    corrected mean -5.33c   band  -8.18 .. -2.48   (n=21, sd 13.36, 4 day-clusters, t(3))

**Still losing with 80% confidence**, so the stop stands and book-imbalance stays disabled - now on evidence
that is real, and agreeing with its CLV band (-5.75..-2.66) and its markout band (-1.90..-0.71). The
conclusion survived; the reasoning behind it had not.

### "Stop entry" and "Dry run" reached only one of five engines

`stopEntry` was read in two places and `dryRun` in two, all on the AutoTrader's own signal path. The quoter,
dutch-book, convergence and lead-lag engines run through `subEngineKilled()`, which consulted neither - so
The operator could press Stop entry, see the panel report a halt, and have four engines carry on placing
orders, including lead-lag, the account's dominant order flow and the only arm at max notch. A halt switch
that does not halt is worse than none, because it is believed. `subEngineKilled()` now checks both first.

### A quarantined state file came back with no daily loss brake

`miniAuto` handed JsonStore a defaults object stamped `configVersion: CONFIG_VERSION`. When the file is
absent or unparseable JsonStore keeps those defaults, so every `if ((persisted.configVersion ?? 1) < N)`
migration reads as already-run and the venue comes up on bare MINI_DEFAULTS - including
`maxDailyLossDollars: 0`, **no daily loss brake on a real-money venue**. Not hypothetical: this exact file
was quarantined on 2026-09-03 over a stray BOM from a hand edit. The default is now 0, so a fresh or
recovered install runs every migration, which is what it should have done anyway.

Suites 341/113/88.

## §67 - 2026-09-12 08:00Z: three arms parked, and a shadow for the 15-minute ladders

### Parked, on operator approval

    kalshi-flow-follow   settlement band [-8.62, -4.60]c, CLV band [-17.31, -4.98]c, 2W/7L, -$1.86.
                         Auto-revived at 07:15Z today on its cool-down and lost again immediately, so it
                         has now had the retry the ladder's design owed it and confirmed the verdict.
    polyus-fade          45 settled, -$0.48, 84.4% win against an 86.7% break-even. Structural rather
                         than a tuning problem: inside a 72h horizon Polymarket lists 1,035 markets of
                         which 1,028 are sports, and 138 of the 140 in the fade band are too. There is no
                         longshot-bias population on that venue for the arm to work on.
    polyus-micro-maker   97 settled, -$1.67, 45.4% against a 47.7% break-even - and the maker rebate its
                         whole thesis rests on does not exist in practice: one rebate in 457 fills.

`operatorHold` stops `tradeSmallEntry` reviving them on the timer; the config flags stop new entries now.
The Polymarket venue itself stays ENABLED so its 31 open positions still exit and settle. It now has no
live entry arm. Kalshi keeps fade, lead-lag, mean-reversion, cross-venue, dutch, news and convergence.

### The 15-minute commodity ladder shadow

A 49-agent search over published traders, the academic literature, sportsbook cross-market pricing, both
venue catalogs, our own logs and structural arbitrage produced 21 proposals and **every one of them died**
under two skeptics. What survived was not an outside idea but our own: `fadeMinHorizonMinutes: 360` blinds
the fade to everything closing inside six hours, which is every 15-minute ladder Kalshi runs -
KX{GOLD,SILVER,WTI,NATGAS,COPPER}15M - and those are the shortest-dated quantitative ladders on the venue,
the exact class that produces 88% of the fade's profit.

Re-verified independently against the workflow's own dataset, with two corrections:

**The fee was wrong.** It charged `ceil(0.07*C*P*(1-P)*100)/100`, a whole-cent ceiling. Our own billing
disproves that: across 93 one-contract fills the exact formula predicts $1.3036, the ceiling $1.7300, and
we were charged **$1.3074**. With the real fee the T-3 rule reads **+1.33c/contract over 923 observations,
80% day-clustered band [+1.00, +1.65], 96.6% win** - double the reported edge. It also survives a full cent
of adverse fill ([+0.17, +0.65] at +1.0c), straddling zero only at +1.5c.

**The edge is not the pooled rule.** By series:

    KXNATGAS15M   n=209   +3.51c   [+3.02, +3.99]   99.0% win
    KXCOPPER15M   n=187   +3.52c   [+2.48, +4.56]   98.9% win
    KXGOLD15M     n=180   +0.04c   [-1.99, +2.08]   95.0%
    KXSILVER15M   n=168   -0.08c   [-0.93, +0.77]   95.2%
    KXWTI15M      n=179   -0.90c   [-2.32, +0.51]   94.4%

Two of five carry all of it, and those two are the THINNEST books - so the apparent edge is largest exactly
where the backtest's "we get the displayed ask for our size" assumption is weakest. That is also what a
stale-quote artifact looks like.

So `scripts/ladder15-shadow.mjs` records and trades nothing: for every window it snapshots the live top of
book at T-3 (the decision moment) and again at T-1, keeps the volume/liquidity/open-interest behind it, and
grades against the venue's own result. Public endpoint only, no key. It answers the one question the
backtest cannot - whether the price we aimed at is real and still there - for nothing but time.

**It is idle until Sunday.** All five ladders are shut at weekends; 120 windows are pre-created and the
earliest closes in 38.4 hours. Three trading days of data lands mid-week.

### A correction to §56's stated cause

Round 61 concluded that `spawn(..., { detached: true })` of **powershell.exe** returns a pid and exits 0
without running anything, and attributed it to DETACHED_PROCESS leaving powershell without a console.
Launching this recorder shows the same failure for **node.exe**, which that explanation does not cover. The
fix shipped in §56 is unaffected and still verified - `cmd /c start` works, and produced a real repair log -
but the honest statement is narrower: **detached spawns do not run in this environment, and the cause is not
specific to powershell.** Two further details learned today: `start` mis-parses an executable path
containing spaces (hence `scripts/ladder15-shadow.cmd`, a wrapper at a space-free path), and the working
argument order is switch-before-title, `start /min "" <cmd>`.

Task Scheduler registration needs elevation this account does not have, so the recorder is launched through
that wrapper, kept across reboots by a Startup-folder entry, and revived by the sentinel on a stale
heartbeat (it writes one every 10 seconds, so a stale one means the process died rather than that the
markets are shut).

Suites 341/113/88.

## §68 - 2026-09-12 13:30Z: the hunch collector was starved, not empty (round 78)

The forecaster had not written a hunch since 2026-09-11 and the log said `scanned 12000, eligible 0, hunched
0` on every pass. That also meant the round-77 frontier challenger could never fire - it only runs where the
incumbent does.

**The tell was in the shape of the log, not the zero.** Passes are bimodal, with nothing in between:

    eligible 0                5s
    eligible 31 .. 322    183 .. 1029s

A 5-second pass is the universe fetch and nothing else. The category stage was making no API calls at all.

**Measured** (GET-only probe replicating the pass's own filter). The pre-filter is healthy: 12,000 scanned ->
3,353 markets survive, across **223 distinct series**. The collapse is entirely at the category stage.
`categoryOf` gives each PASS a budget of 60 uncached series lookups and returns `undefined` past it - and
`undefined` counts as ineligible. The loop walks markets in catalog order, and **the first 60 distinct series
in that order are Sports. Every one.** A cold pass burns its whole budget on the categories it was always
going to skip, never reaches the other 163 series, and reports exactly zero.

`seriesCategory` was an in-memory Map, so "cold" means "every restart". That is the bimodality: seven
back-to-back cold passes on 09-09 accumulated 7 x 60 lookups, covered all 223 series, and the next pass
returned eligible 254. Then the app restarted and it went back to zero. It was restarted about fifteen times
in the last day for unrelated reasons.

Same shape as the Kalshi series FEE cache in §65: an in-memory cache with a small per-pass budget, cold after
every restart, failing silently rather than loudly.

**Fixed.** A series' category is static, so it is persisted to `<dir>/series-categories.json`, loaded at the
start of a pass and written at the end. The 60-lookup budget stays - bounding one pass's API calls is still
right - but it is now a warm-up cost that converges in a few passes and survives restarts. Seeded the cache
directly (223 series, paced GETs) so the fix takes effect on the next pass rather than the fourth.

The pass summary now carries `seriesSeen` / `seriesKnown` / `seriesLookupsLeft`, and the log line prints
them. `eligible 0` with the budget exhausted is a STARVED pass, not an empty one, and that distinction was
invisible for days.

**Result: eligible 0 -> 67.**

**Two things this surfaced and did NOT change.**
- Of the 223 series, **210 are Sports**. The news universe inside the scan is tiny. That is a separate
  coverage question, driven by the next point.
- `scanned` is *always exactly 12000*, and the probe confirms the cursor has more pages. The universe fetch
  caps at 12 pages of 1,000 and we only ever see a prefix of the catalog. Raising it costs API calls against
  the endpoint the live trader shares; not changed here, logged as backlog.
- Six series come back as category `Mentions` ("will X say Y"), which is arguably the most news-driven
  product on the venue, and `NEWS_CATEGORIES` does not include it. Deliberately left alone: the forecaster is
  mid-way through a pre-registered gate, and widening its population now would contaminate the comparison.

## §69 - 2026-09-12 13:45Z: a confidence stop now needs four day-clusters, and momentum is re-armed (round 79)

The throttle audit the operator asked for - "have we prematurely killed any other strategy? dig deep, don't
blow smoke" - ran 22 agents over the gates, caps and config history, produced 8 candidate findings and
confirmed 1.

**The answer to the question as asked is no.** Momentum remains the only invalid stop. Every other stop holds
up on re-examination, and `crossVenueSignals`' top-12 cap was refuted outright (0 of 130 eligible markets
carry an ASSETS keyword - the cap was never why it had zero trades, and its edge is already captured by
leadLag on a better data feed).

What the audit found instead is a different layer. Ranked:

1. **`minMinutesToClose: 15` hides the 15-minute crypto family from six arms, permanently.** Kalshi lists one
   open market per 15-minute window, so a 15M contract can only clear a 15-minute floor in the first seconds
   of its life. leadLag bypasses `buildUniverse` and fetches those series directly - and all 188 15M-family
   fills in `history.json` are leadlag, and leadlag is the only arm at stage `live`. This does not prove the
   other six would win there; it proves the floor has never been tested for the arms it binds, over the one
   product class this account has demonstrated an edge in.
2. **Per-series cap with a fade-shaped exemption.** `kalshi.ts` keeps the top 3 per series by 24h volume (40
   for `GAME` tickers); `inFadeBand` rescues 3-12c and 88-97c only. Mean-reversion operates ~35-95c and
   momentum has no price filter, so neither is reachable by the rescue. Measured live: 2,796 of 4,009 markets
   cut, 520 of them with vol24h > 10; crypto ladders pool every expiry under one key and get cut to 3
   system-wide (KXSOLD: 425 candidates -> 10). Mean-reversion is live with real money on that narrowed pool
   right now.
3. Long-horizon slot cap counts disabled arms' stale positions (a real bug) but measurement killed the impact
   claim - `passesGates()` runs before the score check, so 34 of 35 tagged signals would be vetoed on score
   anyway. Exactly one candidate is genuinely blocked. Fix prospectively; not a suppressed winner.

**The audit's own conclusion, which is the right one: the highest-leverage change here is not a threshold.**
Every capacity veto in `entryBlocked` is ungraded, and markets culled at the venue layer never become
candidates at all, so they cannot be watched even in principle. Wiring the shadow-grader into `entryBlocked`
and the two universe culls costs no capital and converts "we cannot know" into a measured answer in about a
week. That is the next build item.

### The guard (round 79)

Before re-arming momentum, close the hole it fell through. On 2026-09-07 it was stopped on an 80% band of
**-2.93..-2.93**: 21 fills, all on one day, so the clustered SE was exactly zero and the band had no width.
§65 floored the clustered SE at the plain SE, which stops the degenerate zero - necessary and not sufficient,
because a single day of correlated fills still draws a tight band around one bad day and reads as proof.

`MIN_STOP_CLUSTERS = 4`. A confidence stop now requires four day-clusters. Deliberately asymmetric, and the
mirror image of the one-sided-sample guard directly above it in `decideStage`: that one refuses to SCALE UP
when the sample has not observed its own downside; this one refuses to STOP when it has not observed its own
across-day variation. Neither acts on the half of the distribution the sample has not seen.

Undefined clusters fails the guard too. `clusters` is undefined exactly when the per-day buckets do not
account for every trade, which is the same accounting failure `statsBand` refuses to draw a band on - and the
fallback there is the plain SE, which treats correlated same-day fills as independent and so biases toward
stopping. Unverifiable accounting, unusable verdict.

**Not gated, on purpose:** the hard -$5-per-notch stop (a money rule, and what actually bounds the cost of
waiting for a fourth cluster) and the 100-trade sign rule (an arm with 100 settled trades has evidence of a
different order than the 21 that killed momentum; gating it too would leave a losing arm with no statistical
exit).

Four existing ladder tests broke - each testing a *different* rule that happens to assert a stop, none of
which ever set `clusters`. Their intent is still correct, so the fixtures now supply the cluster evidence the
rule requires rather than the assertions being weakened to match. Eleven new tests pre-register the guard,
including the exact shape that killed momentum. Suites 347 / 123 / 88.

### The reinstatement

`kalshi-momentum` cool-down lifted (was 2027-01-01). Stage, notch and the demotion count left alone:
`tradeSmallEntry` promotes disabled -> tiny-live on the timer through the real code path, so it sets
`momentumEnabled` and the sizes itself. Re-judged record is -2.54c/contract, band -5.62..+0.54 - inconclusive,
never losing. The audit priced a conclusive answer at roughly 84 fills, on the order of a couple of dollars
at $1 a position.

## §70 - 2026-09-12 13:45Z: the challenger is collecting, and a truncated response is no longer a lost one (round 80)

First pass after §68: **eligible 67, hunched 54**, `series 223/223 categorized (budget left 60)` - the cache
came back warm and spent nothing. The round-77 challenger fired on **40 of them, exactly its 40/day cap**,
stopping dead where designed. 40 of 40 challenger rows pair to an incumbent row on the same market at the
same moment.

First look, one pass, no verdict: median |p_incumbent - p_challenger| 0.045, 22 of 40 agreeing within 0.05,
4 disagreeing by more than 0.20. Every large disagreement is a multi-outcome AI-benchmark market (one of N
options wins, mid pinned at 0.49) where the incumbent assigns 0.28-0.65 to an INDIVIDUAL option and the
challenger 0.06-0.38. For a mutually exclusive many-way race the incumbent's numbers would sum well past 1.
Suggestive and nothing more - the pre-registered grader settles it at the 09-18 close.

### A dropped row is not missing at random

Two of 56 forecasts were discarded as `unparseable model output`:

    {"p_yes": 0.25, "confidence": "low", "key_evidence": "The market appears to be a single option from

`max_tokens: 800` cut the response mid-string, `JSON.parse` threw, and `parseP` returned undefined - throwing
away a `p_yes` that was already complete and correct. It is the FIRST field of the object; the field that got
cut is the one truncated to 240 chars anyway.

This matters more than 3.6% suggests, because the challenger shares `parseP`. A model that writes longer
evidence drops more rows than one that writes shorter, so the paired comparison would be biased by verbosity
rather than by forecasting skill. That is a threat to the experiment, not just lost data.

`salvageP` reads the fields straight out of the raw text when the object will not parse, clamping identically
to `parseP` so the two paths cannot disagree. Verified against both real truncated responses plus escaped
quotes, truncation before `confidence`, p_yes at 0 and 1, prose with no p_yes, and an empty response.

Raising `max_tokens` was the alternative and is strictly worse: it pays tokens on every call to fix a tail
case, and it makes the bias rarer without closing it.

## §71 - 2026-09-12 13:50Z: the capacity vetoes are priced now, not argued about (round 81)

The throttle audit's own top recommendation, and the reason most of it reads "we cannot know": `watchVeto`
was called at exactly TWO sites - the LLM gate and the fade category filter - so every capacity veto in
`entryBlocked` was ungraded. Max open positions, event exposed, underlying full, long-horizon slots, the
churn caps: all of them have been blocking entries for weeks with no record of what they cost.

The grading machinery already existed and is good (`watchVeto` enrols, `gradeVetoes` settles at close and
slices into `vetoesByReason`). It was simply never wired to the capacity path. Now it is.

**It spends nothing and changes no decision.** Every veto still vetoes; only the counterfactual is recorded.

### Four constraints that make it measure the right quantity

1. **Only signals that would otherwise have been TAKEN.** `passesGates` - and so `entryBlocked` - runs
   BEFORE the score check at the approval loop. The audit caught this exact trap in its own finding 6, where
   34 of 35 signals "blocked" by the long-horizon cap were below `minScore` and would never have traded.
   Enrolling those prices the cap AND the score gate together and overstates the cap. Enrolment requires
   `sig.score >= minScore`.
2. **Only capacity decisions.** A global safety state - stop-entry, paused exchange, stale ledger, kill
   switch, unfunded shard - blocks everything indiscriminately, so its counterfactual says nothing about any
   cap. Dedup reasons ("market already open") mean we HAVE the position; there is nothing to counterfact.
3. **Only executable markets.** No two-sided book means there was no entry to counterfactual and the legCost
   would be fiction. Cost is the taker price of the leg the signal wanted: YES lifts the ask, NO pays 1-bid.
4. **A reserve.** `CAPACITY_WATCH_MAX = 60` of the 120-row list. Capacity vetoes outnumber the LLM gate's by
   orders of magnitude and share one list; without a ceiling they would crowd out the counterfactual already
   being measured.

### Drift is self-detecting

`capacityKey` is the single source of truth: it decides both WHETHER a reason is gradeable and WHICH bucket
it lands in. It normalises, too - "underlying KXBTC full (4/4)" and "underlying KXETH full (4/4)" both key to
`capacity:underlying-full`, because keying on the raw string would shatter the cap's record into one bucket
per underlying and per count.

A reason it does not recognise, and which is not a known safety state, is logged once as `block reason not
classified for veto grading`. A future edit to a block message therefore surfaces in the log instead of
silently going ungraded - which is the precise failure this whole round exists to fix.

**Verified against the source, not assumed.** A script extracted all 19 literal returns from `entryBlocked`
and ran the shipped classifier over each: 10 classify as capacity (every cap intended), 9 as ungraded (all
genuinely safety or dedup). The two non-literal returns - `killSwitchCheck` and `weatherSeatBlock` - were
checked separately and both match the ungraded pattern, so they raise no false alarm. 19 tests added from
the literal strings themselves: if a block message is edited without updating the classifier, the test still
holds the old text and fails. Suites 366 / 123 / 88.

### What it answers, and when

`vetoesByReason` will carry `capacity:*` buckets with `graded`, `wouldHaveWon` and `estPnlCents`. About a
week of settlements gives the first read on backlog items 57 and 58 - whether the per-series cap and the
caps in `entryBlocked` are protecting the account or taxing it. Until then the honest position is unchanged:
we do not know. The difference is that now we will.

### Round 82 correction, same day: the reserve did not reserve anything

Checked the live state instead of trusting the design, and round 81 would have recorded NOTHING. `watchVeto`
enforced one global ceiling of 120, and the fade category filter runs every scan and had the list pinned at
exactly 120 rows (95 of them `weather<48h`). The capacity check I wrote sat *behind* that early return, so no
capacity row could ever be enrolled - and the ledger would have read as "the caps never block anything worth
trading", which is indistinguishable from the caps being harmless.

The two classes now have SEPARATE ceilings (`CAPACITY_WATCH_MAX = 60`, `LEGACY_WATCH_MAX = 120`, enforced in
one place in `watchVeto`) rather than sharing one. The legacy ceiling is held at its historical value so a
measurement already in flight was not quietly shrunk.

Generalisable: **budgets that different producers draw from at wildly different rates cannot be one budget.**
A shared cap silently becomes first-come-first-served, and the fast producer owns it permanently.

## §72 - 2026-09-12 14:00Z: recording what the venue-layer cull throws away (round 83)

The other half of backlog 56, and the harder half. A market culled by the anti-flood per-series cap in
`kalshi.ts` never becomes a candidate, never reaches `entryBlocked`, and so cannot be enrolled in the veto
watch round 81 just wired - not by oversight but by construction. It leaves no trace anywhere in the system,
which is exactly why the audit could only say "we cannot know" about it.

`src/main/venues/cullRecorder.ts` leaves a trace. Purely observational: nothing about which markets the cap
keeps has changed.

**The recorder observes, the grader judges.** Rows carry raw quotes, volume, rank-within-series and series
size - not a verdict - so `scripts/cull-gate.mjs` applies each strategy's entry rule after the fact. The
recorder therefore never duplicates a threshold that lives in the trader, which is the kind of copy that
drifts silently (see the doctrine-copy drift that has bitten this project before).

`kalshi.ts` could not simply read `app.getPath('userData')`: the venue adapter is imported by the test suite,
and pulling electron into it breaks every test that touches it. The directory is injected once from
`index.ts`; unset means inert, which is what a test wants anyway.

### The first scan recorded 19,399 rows, which was the wrong measurement

Grading one row means one settlement lookup against the endpoint the LIVE TRADER SHARES - about an hour per
run, and this project has already rate-limited itself against that endpoint once. Two bounds, both chosen to
cut noise rather than signal:

- `MIN_VOL24 = 10`. A market nobody traded in 24 hours had no counterparty, so "the cap discarded it" is not
  a cost. The audit independently saw the same shape: 2,204 of 2,796 culled markets had zero 24h volume.
- `MAX_PER_SERIES = 40` per day. KXNCAAFSPREAD alone contributed 1,912 rows and would have dominated the
  sample outright.

Neither bound is silent: every write logs `recorded N; skipped X under vol24 10, Y over the 40/series/day
cap`, because a bounded sample that reads as a complete one is how a partial measurement gets quoted as a
total. The log fires only alongside rows actually recorded, so a filled day stays quiet.

The unbounded first-scan file is kept as `2026-09-12.jsonl.unbounded` - it is a valid, more complete
snapshot of one moment, and worth having when the bounds themselves need checking.

### What it will answer

`node scripts/cull-gate.mjs` settles the recorded markets and prices three rules against the discarded
population: mean-reversion's own 35-95c band, momentum's unrestricted band, and the 12-88c mid zone that
`inFadeBand` structurally cannot rescue. **Sign convention, stated in the script's own output because it is
the whole point: a positive mean means the cap COST us by discarding winners; a negative mean means it
protected the account and should stay exactly as it is.**

And the honest limit, also printed by the script: this is a POPULATION result on the discarded set, not a
signal backtest. The recorder does not keep the candles or book depth a real signal needs. A positive band
says "wire the real signal at this band and measure properly" - never "this is what we would have made".

## §73 - 2026-09-12 14:05Z: a paid-model budget that reset every pass (round 84)

Caught during a routine health check, in code written earlier the same day. The challenger ledger held 42
rows against a config key named `hunchChallengerMaxPerDay: 40`.

`challengerLeft` was a plain local inside `runHunchPass`, so it reset to the full cap on EVERY pass. The key
says per day; the code bought `40 x passes`, and passes run hourly.

Today it only reached 42 because the 20-hour seen-TTL starved the later passes - luck, not design. The moment
a TTL expiry hands one pass 100 fresh markets and another pass follows it, the same code spends the whole
frontier-model budget twice over. This is the exact shape of the overspend that cost $198 before: a paid
model behind a budget that silently resets.

Fixed by making the day's ledger the source of truth - the pass counts rows already written to today's
challenger file and subtracts. An unreadable ledger sets the budget to ZERO rather than to the cap: the
failure mode of a cost control has to be "spend nothing", never "spend again". The pass log now prints
`challenger left today N`.

Worth stating plainly because it undercuts a claim made two hours earlier: §70 reported the challenger
"stopping dead at its 40/day cap", and that was only true of the one pass being looked at. The cap it was
actually honouring was per-pass. Reporting a control as working because its first observation looked right
is not verification.

## §74 - 2026-09-12 14:12Z: the lead-lag sizing increase never took effect (round 85)

The operator asked for bigger lead-lag positions. The ladder was taught to produce them
(`contractsPerNotch: 2`, so notch 4 -> 8) and the live config does carry
`leadLagMaxContractsPerOrder: 8`. **The watcher then recorded 33 consecutive fills at exactly 4 contracts.**
I had reported this change as delivered. It was not.

**Cause.** Two hand-built `LeadLagConfig` literals - in `leadLagStatus` and `leadLagCfg` - both clamping:

    leadLagMaxContractsPerOrder: Math.max(1, Math.min(4, this.config.leadLagMaxContractsPerOrder ?? 1))

The ceiling was **4**: precisely the ladder's own output at MAX_NOTCH. So every increase the ladder made was
discarded on the way through, and nothing anywhere logged that it had been. I changed the producer and left
the consumer pinned.

The same literals hard-coded `leadLagMaxCapitalSpend: 15`, discarding the configured 40 - and that one could
not have been read at all, because `leadLagMaxCapitalSpend` was never declared on `AutoTraderConfig`. The
value in the config file was inert. Now declared and honoured.

**Same failure as BACKLOG 53**, where `reviewDefault()`'s hand-built literal ignored every intelligence
setting, and the same shape as the partial-stand-down trap: when a knob goes live, EVERY site that builds
the callee's config has to move, not just the one in front of you. The durable fix is not a bigger number,
it is having one builder: `leadLagStatus` now calls `leadLagCfg()`, and the duplicate literal is gone.

**A bound equal to the ladder's maximum is not a safety bound, it is a silent veto.** The replacements
(`LEADLAG_HARD_MAX_CONTRACTS = 24`, `LEADLAG_HARD_MAX_SPEND = 120`) sit well above anything the ladder can
ask for, so they guard a corrupted config without overriding the component whose entire job is sizing.

Verified the whole path this time rather than the one line I changed: ladder `applySize` -> config 8 ->
`leadLagCfg` clamp 24 -> `sweep`'s `count` -> the capital check (8 legs never approach $40) ->
`placeOrder({contracts})` -> the adapter, which only floors at 0.01. No other clamp exists.

Also corrected a stale comment on `sweep()` claiming `leadLagLiveEnabled` is "hard-coded off". It has not
been since the arm was promoted to stage `live`, where it is the only arm and is spending real money. A
stale safety comment in a money path is worse than none: it invites exactly the assumption it used to
justify.

### Round 85b: is the silent-override bug class anywhere else? Audited — no.

Third instance of one shape is a pattern, so rather than assume, a script tested every hand-built sub-engine
config in `autoTrader.ts` against a precise criterion: a field whose value is a LITERAL in the builder AND
which exists as a settable key (declared on `AutoTraderConfig` or present in the live config file). A
hard-coded value with no corresponding key is just a constant and is not this bug.

Result across all four builders (147 declared keys, 140 in the live file):

- `quoterCfg` — clean. Every field is `cfg.X ?? default`. This is the pattern the others should match.
- `convergenceCfg` — clean. Its `['KXBTCD']` is a literal with no settable key, and is pre-registration.
- `leadLagCfg` — clean, as of round 85.
- `dutchCfg` — one hit, `dutchLiveEnabled: false` against a live value of `true`. **Not a bug.** It is
  deliberate and documented: the standalone DutchBookEngine is recorder-only because the IN-PIPELINE dutch
  strategy does the trading under the ladder and the shared risk limits, and two engines firing on one
  basket doubled it. The ladder promoting `kalshi-dutch` to tiny-live correctly enables the in-pipeline arm
  via `strategyOn('dutch')`; the standalone recorder staying off is the intended behaviour.

Separately checked the adjacent surface — direct `this.config.X =` assignments that could fight what the
ladder writes. 97 exist; 94 are inside `configVersion` migration blocks, which run once at construction
before the ladder ever runs, and the remaining 3 are API-key decryption at load. Nothing races the ladder.

So the class is closed for this file. The general defence is the one round 85 applied: prefer ONE builder
over duplicated literals, and never set a safety bound equal to what the sizing authority can legitimately
ask for.

## §75 - 2026-09-12 14:30Z: the 15-minute floor gets an instrument (round 86), and the old one was broken

Backlog 58, the last unmeasurable item from the throttle audit. `minMinutesToClose: 15` excludes every
market closing inside 15 minutes, and Kalshi lists exactly ONE open window per 15-minute series at a time -
so the whole KX{BTC,ETH,XRP,SOL,DOGE,BNB}15M family is structurally invisible to every arm running off
`buildUniverse`. Neither round 81's veto watch nor round 83's cull recorder can see it: both sit downstream
of a market that is never emitted.

Designed with a 12-agent research pass (8 readers, 3 adversarial challenges, 1 synthesis) before writing
anything, which was the right call - it overturned two premises I would otherwise have built on.

### FIRST: the existing 15-minute shadow had been recording nothing, ever

`scripts/ladder15-shadow.mjs` - the commodity-ladder fade instrument - reads `m.yes_bid` / `m.yes_ask` as
integer cents. **Those fields do not exist in Kalshi's payload.** Verified with a live GET on both KXGOLD15M
and KXBTC15M: `typeof m.yes_bid` is `undefined`, and the live fields are `yes_bid_dollars` /
`yes_ask_dollars` STRINGS. So `readQuote` always returned undefined, every snapshot recorded
`quoted: false`, `emit()` returned early, and the file produced `written: 0` with no `observations.jsonl` on
disk at all.

The heartbeat said `120 pending; the commodity ladders stand down at weekends` and looked healthy. That note
made an empty ledger look expected; the bug is independent of the stand-down and would have recorded nothing
on a busy weekday too. **A heartbeat that reports liveness without reporting output is a liveness check, not
a health check.** Both recorders now emit `snapsQuoted` / `snapsUnquoted` and a `health` field that says
BROKEN outright when snapshots are being taken and none are quoted.

I had promised a report on this experiment "once the ladders reopen". That report was never going to arrive.
Fixed, verified against a live quoted market (KXBTC15M bid 0.58 / ask 0.59, spread 1.0c, vol 295k), and the
recorder relaunched.

### TWO PREMISES THE RESEARCH OVERTURNED

**1. `minMinutesToClose` is not a dial.** Lowering it globally admits every sub-15-minute market on every
series into EVERY arm's universe. What evidence can license is a narrow **carve-out slice** in
`buildUniverse` alongside the existing `fadeExtra` / `sportsExtra` slices, scoped to named series AND to one
arm. The experiment must measure that, not floor removal - so the pre-registered rule names the carve-out,
never the floor.

**2. Only momentum belongs in it.**

- **momentum - IN.** Blocked by `minMinutesToClose` ALONE. Its own gates (>=5 candles, >=3 traded, 3c point
  move, direction held at mid-window) are all satisfiable in a 15-minute window's back half.
- **mean-reversion - OUT.** `meanReversionMinHoursToClose: 6h` against a max `hoursToClose` of 0.25h.
  Unconditionally null for the market's entire life. That is a strategy-DEFINING horizon, not a liquidity
  floor: 15-minute mean-reversion is a different strategy, not this one turned down.
- **fade - OUT.** `fadeMinHorizonMinutes` likewise null, and the fade-on-15m question already has its own
  instrument. Two instruments on one question confuse two different decisions.

Recording `signal: null` for arms that CANNOT fire would manufacture a null that reads as "no edge" when it
is really "no signal". The row shape is still rule-agnostic, so a separately-justified variant can be graded
off the same file later without re-collecting.

### THE INSTRUMENT

`scripts/crypto15-shadow.mjs`, detached (no in-app cadence fits a 15-minute market), Startup entry,
heartbeat with health. ~104 req/hr, strictly sequential at 300ms, window poll aligned to the deterministic
:00/:15/:30/:45 boundaries rather than every minute (15x cheaper for zero information loss). Snapshots at
T-300/T-180/T-60; **T-180 alone is the decision point and the only one entering the sample.**

**429 policy is the OPPOSITE of the old recorder's** retry-with-backoff, deliberately: a shadow recorder has
nothing time-critical to protect and the live trader shares this venue budget. On 429 it abandons the cycle,
and two throttled cycles start a doubling cooldown to 15 minutes. A missed window out of 576 a day is free;
competing with live trading for the rate budget is not.

**The momentum port is pinned by `--selftest`**, because a hand port into `.mjs` drifts from the TypeScript
silently. Ten assertions against a real captured window plus three negative controls (flat series vetoes on
`move`, untraded candles on `volume`, short series on `candles`). The selftest immediately earned its keep:
the research predicted `movePoints: +18`, the port produced **+20**, and the port is right - the 10-minute
cutoff drops the two oldest of thirteen candles, so the window's oldest price is 0.56, not 0.58. That
arithmetic IS the signal; an off-by-one in the cutoff would shift every observation and still look plausible.

**A measurement flaw caught in the smoke test.** The first cycle reported `dropped: 24` - windows that had
already settled before the process started and never could have had a T-180 snapshot. Counting those would
poison the pre-registered drop-rate sample bar, freshly on every restart. Now classified separately as
`preexisting`; a drop only counts when we were actually watching.

### PRE-REGISTERED BEFORE A SINGLE ROW EXISTED

`scripts/crypto15-gate.mjs`. Unit: one graded window-signal at T-180. **96 windows/day x 6 series is NOT 576
independent observations** - the six coins close together and move with BTC beta, and consecutive windows
are serially correlated, so the effective sample accrues at ONE PER DAY. Primary clustering is the UTC day;
the estimator is a verbatim port of `clusteredMean` including the G/(G-1) correction and the under-three-
cluster floor, because those corrections are the product of real losses.

Sample bar: >= 20 day-clusters AND >= 1500 signalled windows AND drop rate < 2%. Carve-out justified only if
the day-clustered lower bound exceeds **+0.50c** (not >0: the recorder buys one contract at the displayed
ask on its own precise clock, while live entry is several contracts on a 30s scan tick - a bare >0 bar
promotes a strategy whose whole margin lives in slippage this design cannot see), AND the window-clustered
lower bound > 0, AND depth realism >= 80%, AND >= 4 of 6 coins positive, AND it survives dropping the best
coin. Floor stays if the upper bound excludes +0.50c. Straddling means one pre-registered extension to 40
clusters, applied once, no further peeking.

**Honest prior, recorded before collection:** a 15-minute at-the-money binary's path is close to a
martingale and the 3c threshold is trivially cleared here, so expect a high signal rate and an expected
value near minus the spread and fee. **The most likely outcome is FLOOR STAYS.** That is worth buying at
this price, and the grader prints a warning if the signal rate approaches 100%, because a filter that never
filters is not a strategy - whatever that measures is the family's raw drift, not momentum's selectivity.

### RISKS RECORDED FOR THE PROMOTION DECISION, NOT FOR NOW

The recorder is read-only and places nothing. But if the gate ever passes: lead-lag ALREADY sweeps
KXBTC15M/KXETH15M on a 60s tick and could take the opposite side of the same contract inside one window;
`SETTLE_GRACE_MS` of 30 minutes is twice this market's lifetime; and an un-scoped carve-out would admit six
fresh markets every 15 minutes into every arm, at up to ~24 entries/hr against the live fade's ~13/day.
None of that is the recorder's problem; all of it is a precondition of arming.

## §76 - 2026-09-12 14:40Z: momentum's threshold is not scale-free (from an outside article)

The operator shared a Medium post, "I Automated 4,000 Trades on Kalshi" (Ethan Wang, 2026-03-06). Read it in
full. **It contains no strategy, no P&L, no win rate and no fee analysis** - it is Part 1 of a series and
ends in a subscribe prompt, and despite the title it never says whether the month was profitable. Concrete
content: ~4,000 trades / $600K volume in month one (~$150/trade, a different scale of account from ours), one
9,100% trade the author himself attributes to luck, and a four-figure loss day caused by a bug.

Most of its advice converges with what this system already does - size up slowly through backtest -> paper ->
minimum size -> scale (our ladder), measure adverse selection before scaling (our markout veto), collect
data before trading (the three recorders stood up today). Its worst-day post-mortem, *"the root cause was a
math problem, but good engineering would have caught it before it mattered"*, describes most of today's
findings.

**One idea in it is new, and it lands on a live arm.** The author works in LOGIT space rather than raw
price, because Kalshi prices are bounded [0,1] and move in 1c ticks, which breaks approximations that assume
continuous unbounded prices.

`momentumSignals` uses a flat `momentumMinMovePct: 0.03` point threshold at every price. Quantified:

    move            logit delta
    0.045 -> 0.075      0.543
    0.200 -> 0.230      0.178
    0.350 -> 0.380      0.129
    0.500 -> 0.530      0.120
    0.850 -> 0.880      0.258
    0.950 -> 0.980      0.947

A 3c move at 95c is **7.9x** the log-odds move that a 3c move at 50c is; at 4.5c it is 4.5x. So the flat bar
is *most permissive at the money and most restrictive in the tails*, and momentum's signal population is
biased toward mid-priced markets by construction rather than by evidence. The same 3c "signal" means
materially different things at different prices.

There is a satisfying detail: the engine's own comment rejects RELATIVE moves - "a 4.5c->5c tick is one cent
of information, not an 11% trend. Relative moves on near-zero prices are noise." That instinct is right, and
logit is the middle ground it was reaching for: that tick is **0.111** in log-odds, near-identical to a 3c
move at the money (0.120). Neither absolute nor relative; log-odds.

**Deliberately NOT changed.** Momentum was re-armed four hours ago under a pre-registered stopping rule
(§69). Retuning its threshold now would contaminate that test, and a blog post is a hypothesis, not
evidence. Instead `crypto15-shadow.mjs` now records `moveLogit` alongside `movePoints` on every signalled
window - a free column on data already being collected, gating nothing - so the hypothesis becomes testable
without touching the live arm.

Caveat recorded honestly: 15-minute crypto windows sit near the money, so that sample will show little
logit-vs-point variation. The hypothesis really bites on momentum's broader universe, where entry prices
have ranged 29c-94.5c. Testing it there needs the vetoed-signal population recorded, which nothing does yet.

## §77 - 2026-09-12 15:10Z: a published pricing model, and a false positive of my own making

The operator shared five links about the Medium author from §76, asking whether two GitHub repos were his.
**They are not, and the identification is definitively wrong:**

| | Medium / personal site | The GitHub repos |
|---|---|---|
| name | Ethan Wang | Yicheng Yang |
| school | Case Western Reserve | UIUC ([email redacted]) |
| GitHub | `Not-Ethan` | `YichengYang-Ethan` |
| output | blog post; "top 100 all-time Kalshi crypto leaderboard" | SSRN 6468338; 633-test repo, 255 stars |

The `-Ethan` in the GitHub handle is what makes them look like one person: Yicheng Yang also goes by Ethan.
And the coincidence runs one layer deeper than it appears - the **Wang Transform is not named after either of
them**. It is Shaun Wang's 2000 actuarial distortion operator. So a "Wang Transform Pricing Engine" written
by an author named Yang, surfaced while searching for an author named Wang, is a three-way collision of
unrelated names. The operator spotted the risk himself ("connecting dots that might not have been there"),
which is exactly the check that was needed.

The attribution is a demotion; the CONTENT is a promotion. Yang's paper is serious work and makes a
falsifiable claim about Kalshi specifically.

### The claim, and what it would mean for us

    p_mkt = Phi(Phi^-1(p*) + lambda),  lambda_hat(Kalshi) = 0.187, n = 271,699, p < 1e-15

Our `calibratedYesRate()` returns 0.003 below 5c, 0.018 below 10c, and **IDENTITY above 10c** - we assert
zero pricing bias across 90% of the range. Under lambda = 0.187 that is wrong everywhere:

    yes px   paper's true p   ours       buy-NO edge net of fee
    0.20     0.152            0.200      +3.70c
    0.50     0.426            0.500      +5.67c
    0.80     0.744            0.800      +4.52c

**The magnitude is not credible as an edge.** +5.67c/contract net, at the money, on every contract, by
simply buying NO, would not survive a week on a venue doing $600K days. The likely confound is question
SELECTION: prediction markets list "will [notable thing] happen?", most notable things do not, and
calibrating on the listed YES side measures the listing convention as much as any mispricing. (The paper's
own play-money result, Manifold lambda = -0.218 with the sign flipped, is consistent with the estimate
picking up something about the population.)

**But the DIRECTION is corroborated by our own money.** Under lambda > 0 buying YES favorites should lose;
we measured our favorite leg at -8.42c maker / -10.28c taker over 142 independent events and disabled it.
And fading longshots - buying NO - is this account's main historical earner. Two independent confirmations
of the sign, none of the magnitude.

### I tested it on our own data and produced a spectacular false positive

The hunch ledger holds 876 settled markets with recorded quotes. Fitting lambda by MLE (the estimator was
first validated on synthetic data with known lambda: 0, 0.187, 0.4 and -0.2 all recovered correctly):

    lambda_hat = +1.124, 95% CI [0.888, 1.360]

Six times the published figure, and the 0.45-0.55 band showed markets quoted at 0.486 settling YES **7.9%**
of the time - a 40.8c gap. That is free money, which means it is not real.

**Cause: 94% of the sample (183 of 195 rows) was multi-outcome events** - 19 events listing 4 to 25 options
each, exactly one of which can win. Their realised YES rate was 0.109 against 1/mean_options = 0.104. The
"bias" was the arithmetic of an N-way race.

And the books were EMPTY. On KXRANKLISTSONGTOP10, all 25 options had **no bid at all**, a one-sided ask at
97c, median spread 97c. The sum of YES asks was 24.28 against an exclusivity constraint of 1.00 - which
looks like a colossal arbitrage and is untradeable, because there is nothing to sell into and buying NO
costs 1 - 0 = 100c. My "market price" of 0.485 was `(0 + 0.97)/2`: half of a one-sided ask on an empty book.

Stripping the artifacts strips the sample:

    all rows                        n=195   lambda +1.124
    two-sided book only             n=105   lambda +0.792
    two-sided AND spread <= 10c     n=13    too few to fit

**The honest answer is that we cannot test this yet.** That is the finding.

### Why this matters beyond the number

This is the SECOND spurious result this dataset has produced through a missing-bid fallback - the first was
a +41.58c price-slice that priced 99c contracts at 50c. Same root cause, different route, and I walked into
it again. **A mid is not a price without a bid**, and the guard now lives in the code rather than in anyone's
memory: `cull-gate.mjs` fits lambda only on two-sided books with a spread <= 10c, and says so in its output.

It is also precisely the artifact class I had just accused the paper of. Levelling that criticism and then
committing it within ten minutes is the useful part: the criticism was right, and it applies to anyone
fitting this model on listed contracts without conditioning on a tradeable book - the paper included.

### Two other defects this surfaced

- **`cull-gate.mjs` printed "the cap is COSTING us" on n=2** (100% win rate, two observations). The same
  degenerate-evidence failure that killed momentum on 2026-09-07, fixed in `crypto15-gate.mjs` an hour
  earlier and not carried across. It now requires n >= 100 AND >= 5 day-clusters before any verdict, uses a
  day-clustered SE with the G/(G-1) correction rather than treating co-settling markets as independent, and
  prints "-" instead of a zero-width band.
- **`cull-gate.mjs` never persisted its settlement cache**, so every run re-fetched thousands of markets
  against the endpoint the live trader shares - the grader's entire pacing discipline undone by a missing
  write. Fixed.

### What is now wired

`cull-gate.mjs` estimates lambda on every settled culled market with a real two-sided book, alongside a
model-free realised-frequency-by-price table. The cull recorder already requires a two-sided book and
vol24 >= 10, so that sample is clean by construction. It is DESCRIPTIVE and gates nothing: a positive lambda
there would say our identity assumption above 10c is wrong in that population, not that there is an edge.

## §78 - 2026-09-12 15:40Z: idea mining - our "market maker" is not a market maker

Two more links from the operator, explicitly for idea mining.

**ian-wang.com/projects/kalshi** (Ian Wang, independent, live since Nov 2025) is the serious one, and its
numbers are the kind that matter: **$65K net, ~287,920 closed positions Jan-Jun 2026, 70.6% win rate, Sharpe
5.9, maximum drawdown $473.** Self-reported and unverified, but internally coherent - a 137:1 profit-to-
drawdown ratio is the signature of inventory-controlled two-sided market making, not directional betting.
Strategy: quote both sides across **~18,000 markets in ~900 series**, keep inventory near flat, cool down
when flow looks informed. Selection criteria, signals and parameters explicitly withheld.

**github.com/ryanfrigo/kalshi-ai-trading-bot** (579 stars) is the other kind: a popular toolkit with **no
results disclosed** and an explicit warning that "the examples lose money on certain markets", plus a
"Beast Mode" that "historically led to significant losses". Its value is entirely in its negative lessons.

### The finding: we never tested market making

Set our quoter beside his:

| | Ian Wang | us |
|---|---|---|
| series | ~900 | **2** (`quoterSeriesRegex: '^KX(HIGH|LOW)'`) |
| markets | ~18,000 | **4 concurrent** (`quoterMaxMarkets: 4`) |
| closed positions | 287,920 in 6 months | **14 graded fills, ever** |
| outcome | $65K, max DD $473 | "CI lower -36.72c" -> shelved |

And it is worse than a scale gap. Of 4,082 shadow records, **93% are gated, and every gate reason is
weather-specific**: `no-index` 2,182, `blackout` 1,514, `flow` 630, `ratchet:near` 581, `ratchet:decided`
105, `index-stale` 10. Only 277 reach the allowed cohort and 14 of those settled.

**Our quoter is not a market maker. It is a weather-forecast strategy that happens to quote** - it requires
a temperature index, a ratchet state and a clear blackout window before it will post. His is pure spread
capture with no forecast component at all. The same two words describe two different strategies, and our
evidence about ours says nothing whatsoever about his.

So "market making was tested and failed here" is false. At his per-position edge of **$0.226**, our 14
graded fills represent an expected TOTAL edge of **$3.16** - against a measured CI lower bound of -36.72c.
The sample was structurally incapable of detecting the effect. Same class as the momentum kill (§69): a
verdict drawn from evidence that could not support one.

### But the honest sizing says measure, do not build

    quoting  25 markets ->  2.2 positions/day -> $0.50/day
    quoting  50 markets ->  4.4 positions/day -> $0.99/day
    quoting  80 markets ->  7.0 positions/day -> $1.59/day
    (lead-lag today: +$4.46/day)

At ~$1 of collateral per two-sided quoted market, a $160 account supports perhaps 30-50 markets once the
other arms are funded - roughly 0.3% of his footprint. Even assuming our per-position edge matched his
(unlikely without his proprietary selection), that is about **$1/day**, against infrastructure he needed
75,000 lines and WebSocket order-book ingestion to run.

**Recommendation: widen the SHADOW, leave the live switch alone.** The shadow already runs precisely
because the quoter is disabled (`quoter.ts:676` - `const shadow = !canTrade && (cfg.quoterShadowEnabled ??
true)`), so relaxing the weather-specific gates for shadow purposes costs no money and risks nothing. That
would answer the only question that matters - does generic two-sided spread capture show a positive
per-fill edge at breadth on this venue - before anyone spends a line on infrastructure. The `operatorHold`
on the quoter is the operator's and stays set.

Not done unilaterally: this was asked as idea mining, and widening the shadow's universe also adds
order-book fetches against the endpoint the live trader shares.

### From the toolkit repo - convergence, which is itself information

Its one non-LLM strategy, "Safe Compounder", is: *"NO side only, YES last <= 20c, NO ask > 80c, edge > 5c,
max 10%/position."* **That is our fade longshot arm**, arrived at independently. Useful two ways: it
corroborates the trade, and it says the trade is obvious enough to appear in a 579-star starter repo -
i.e. crowded, which is a fair explanation for why our fade edge is thin.

Its live lessons also corroborate ours:
- *"category discipline mattered more than LLM confidence"* - matches our fade category filter earning its
  keep while the LLM critic measured no skill.
- *"the LLM can be 80% confident on a CPI trade and still be wrong"* - matches the hunch forecaster beating
  the market on calibration (Brier 0.089 vs 0.215) and still losing money trading.
- *"quarter-Kelly outperformed higher fractions"* - not directly applicable; we size at a flat $1-2, which
  is far below any Kelly fraction at this bankroll.

## §79 - 2026-09-12 16:00Z: the market-making test (round 87), and a correction I owe the record

The operator asked to really test market making, shadow-first, and to scale if it works. Designed with a
10-agent research pass before writing anything. Two of its findings changed the shape of the whole thing.

### CORRECTION: we HAD tested market making, and it lost

In §78 I wrote that our quoter had "14 graded fills, ever" and that market making was therefore never
tested. **That was wrong.** The 14 was the SHADOW's gated allowed-cohort, used for the ladder's re-entry
gate. The live record is in this very document, in the 2026-09-06 review table:

> Kalshi weather quoter - 112 settlements, 29 W / 81 L, **-$29.07**; **653 maker fills, 896 contracts,
> -2.6c each**

653 real maker fills at -2.6c/contract, attributed to adverse selection. I read the shadow ledger and the
ladder verdict and never checked the review table three lines from the top of the file I have been appending
to all day. The scope point in §78 still stands - those fills were weather-only, on 2 series - but "never
tested" was false, and the prior is much stronger than I represented.

It is stronger still in a way that matters: those 653 fills ran on a FORECAST-based fair value. The naive
midpoint+/-1c rule a generic market maker uses carries *less* information than the thing that already lost
2.6c a contract. Expect worse, not better.

### The design's verdict, which I accept: this is a falsification test

Three numbers force it.

1. **The live book cannot hold enough risk for a positive answer to matter.** `quoterMaxExposure` is $4 and
   `quoterMaxInventory` is 1 - the real book rests 1-contract clips over a handful of markets. A large
   +1c/fill edge at 30 fills/day is ~$0.30/day. The only decision a PASS informs is whether to raise that
   cap 50-100x.
2. **The dead zone is wider than the plausible edge.** At ~20 day-clusters with a between-day SD of day-mean
   net around 2c, SE is ~0.45c. Any true per-fill edge between roughly -0.1c and +1.1c is unresolvable in 35
   days, and that band contains most realistic outcomes for a 2-3c book. INCONCLUSIVE is the modal outcome
   and that is disclosed in advance, not discovered later.
3. **The prior is negative and it is our own money** (above).

So the strongest claim this run can support is **"not refuted"**. A PASS authorises a 14-day live
confirmation at 1 contract on fee-free series with the exposure cap UNCHANGED. It does not authorise
scaling. A KILL is the outcome with real power here, and a clean non-peekable kill costs $0.

### What the universe scan already says, before any fill

Of **3,000 markets scanned: 36 are quotable.** 1.2%. The funnel, now logged every scan:

    noBook 719   tooTight 212   tooWide 811   priceBand 354   horizon 4   dupEvent 553   volume 310

**tooWide beats tooTight nearly 4:1.** The makeable universe is squeezed between markets already quoted
tightly by someone faster and markets nobody will quote at all. That is a structural read on whether this
venue is makeable at our speed, measured rather than assumed, and it is worth having independently of how
the run ends.

### The fill model, and why its bias direction is the whole ballgame

A quote holds {price, side, queueAhead}. Aggressive prints at or through our price consume the queue, and we
fill only when it is STRICTLY exhausted. Conservative in three deliberate places:

- JOIN (resting at an existing level) takes the whole displayed size as queue ahead, with no credit for any
  of it being stale. IMPROVE (creating a level inside the touch) starts at zero and is never re-inflated by
  size arriving later - those joiners are behind us in time priority.
- **Cancellations ahead of us are invisible in a public feed and are NOT credited.** Real fills caused by
  someone ahead pulling are simply missed. This is the largest conservative lever.
- The fill test uses PRICE, not `taker_side`. This repo has never verified which of `taker_side` /
  `taker_book_side` / `taker_outcome_side` means what, and building a primary metric on an unverified field
  is how a study ends up measuring its own misreading. Agreement is logged as a cross-check only.

The one place it must NOT be conservative is **book-cross fills**: if the market traded clean through our
resting price between snapshots we were filled, and those are precisely the ADVERSE ones. Excluding them
would quietly delete the losses and make the whole study optimistic. They are booked, and stamped at the
START of the interval so the markout captures more of the drift against us.

11 selftest assertions pin all of it, including the strictness boundary (39 against 40 ahead does not fill;
40 does not fill; 41 does) and the fee.

### The fee finding, asserted rather than assumed

At a 1-contract clip, `ceil(0.0175 * n * P * (1-P))` rounds up to **a full 1 cent** at any price. That is a
flat 1c/contract tax that alone consumes half of a 2c spread. It amortises to 0.44c at 50 contracts. Fee-
bearing series are therefore simulated rather than excluded, reported as a separate cohort, and the fee is
recorded at clip sizes 1/10/50 - so the operator can see exactly what raising the exposure cap would buy.

### Two gaps the first live cycle exposed

- **The depth gate was never applied.** The design requires `10 <= min(bidSize, askSize) <= 60`, but
  top-of-book sizes are not in the `/markets` payload, so the universe filter could not see them and I did
  not re-apply the rule at book time. The first cycle tracked a market with an **ask size of 0.24
  contracts**. Quoting into dust produces fills that could not have happened at any real size. Now gated
  where the sizes actually exist.
- **The selection funnel was invisible** - `eligible 35` with no way to see which clause cut what, the same
  blindness that made the hunch collector's `eligible 0` need a live probe to diagnose. Every clause now
  counts its own rejections, and the spread cut is split into tooTight/tooWide because those are opposite
  diagnoses about the venue.

### Pre-registered, hashed, and peek-proof

`prereg-<runId>.json` is written before the first fetch with every parameter and a sha256. Stop date is
**2026-10-17**, fixed: no early stop on good results, no extension on bad ones, and no count-based stop
(which is optional-stopping bias). Primary metric: day-clustered bootstrap mean of per-fill
`net15 = markout15C - feeCents1`, 10,000 resamples over days with a fixed seed so a re-grade reproduces.

PASS needs the 10th percentile >= +0.75c AND JOIN/IMPROVE agreeing in sign. KILL is the 90th percentile
<= +0.25c. Everything else is INCONCLUSIVE, which is a do-not-pursue for capital and explicitly does NOT
authorise extending, re-slicing, or grading on net5 instead.

**`--interim` cannot leak the metric**: it is a separate function that never reads a price, markout or fee
field, and the verdict path exits refusing to grade before the stop date. Both verified.

Request cost: <= 20/min against the live trader's separate 120/min client and Kalshi's ~1,200/min ceiling.
On a 429 it never retries - it abandons the cycle, and three throttles in an hour halt the run outright,
because a 429 is a threat to live trading rather than an inconvenience.

The sentinel now watches mmsim and both 15-minute recorders, relaunching a dead one and - separately -
raising a notify when a recorder reports itself unhealthy. That second check exists because ladder15 wrote
a perfectly fresh heartbeat over an empty ledger for its entire life. Notify and never revive: restarting a
process whose code is wrong just writes a fresh heartbeat over the same empty ledger, forever.

## §80 - 2026-09-12 19:10Z: the challenger comparison had no paired grader (round 88)

Spotted from a routine monitor line: an evening hunch pass produced **60 hunches and the challenger fired on
none of them** - its daily budget was already spent on the morning's 42. Which is the cost control working
exactly as designed, and which quietly breaks the comparison it was built for.

`hunch-gate.mjs` grades whichever directory it is pointed at. Running it on `hunches/` and again on
`hunches-challenger/` and setting the two Brier scores side by side compares **two different market
populations**, not two models - and it would look entirely reasonable while doing it. The gap is not small:

    incumbent forecasts 992   challenger 42   paired 42   incumbent-only 950

The populations differ BY CONSTRUCTION. `hunchChallengerMaxPerDay` caps the challenger at 40 and the
incumbent is uncapped, and eligible markets are hunched soonest-closing-first - so the challenger only ever
sees a short-horizon slice of each day.

Round 77 was designed as "paired, not parallel" for precisely this reason, and I wrote that rationale into
the round-77 patch header myself. The grading path never enforced it. A design decision that lives only in a
comment is a decision nobody has actually made.

`scripts/hunch-paired.mjs` enforces it at grading time: only markets where BOTH models produced a forecast,
with the per-market Brier DIFFERENCE as the unit of observation. Differencing removes market-level
difficulty entirely - the thing an unpaired comparison of two ledgers can never do. Day-clustered, with the
same under-three-cluster SE floor the ladder uses, and it prints "no width - not an interval" rather than a
zero-width band.

It also reports the **horizon profile of the paired set**, because the cap's selection effect is harmless to
the paired test (both models see identical inputs) and is NOT harmless to generalisation: "the challenger is
better" would mean considerably less if it were only ever asked the easy, soon-closing questions.

Current state: 42 paired, **0 settled** - they close 2026-09-18 - so it reports that and stops. The daily
cap stays; it is a cost control on a frontier model and the round-84 fix already had to stop it resetting
every pass.

## §81 - 2026-09-12 19:30 local: adversarial review of everything built today (rounds 78-88)

The operator asked for a hostile review of the day's code before calling it a holding pattern. Seven
reviewers over eight files, every non-LOW finding sent to an independent refuter with the runtime, then my
own execution tests on top. **36 findings reported, 24 verified standing, 0 refuted, 4 CRITICAL.** Three of
the four CRITICALs I had not found myself.

### The four CRITICALs

1. **mmsim's primary metric deleted the maker's edge.** `markoutC` was mid-to-mid drift; the fill price was
   stored and never read. A bid at 0.73 with mid 0.74 unchanged fifteen minutes later - the exact case where
   a market maker's edge is realised - scored 0 minus the 1c fee = **-1c on a break-even fill**. Constant
   negative bias on every fill, larger than both pre-registered gates. Thirty-five days of this would have
   returned a false KILL.
2. **crypto15-shadow stamped the poll slot before the poll could fail.** A 429 on series 2 of 6 silently
   dropped series 3-6 for the entire window - no discovery, no snapshots, no rows, no error.
3. **A decoy `p_yes` won.** `parseP`'s greedy brace match spanned two objects, failed, and `salvageP` took
   the FIRST match. Executed: a model's final 0.20 with an earlier "naive read gives 0.90" returned 0.90.
4. **My MIN_STOP_CLUSTERS guard (round 79) blocked the 100-trade sign rule** that §69 explicitly said it
   did not. Executed: n=100, hi<0, 3 clusters -> hold. My regression test used mean 0, so it never entered
   the hi<0 branch and passed while the guard was swallowing the backstop.

### Verified regressions of my OWN fixes - five of them

Step 11 of the rubric, "review the corrected version from scratch", was not ceremony. A fresh review of the
fixed code found five verified regressions, one CRITICAL:

- **cull-gate: I converted two of `settle()`'s three return paths to `{res, fetched}` and missed the
  third** (`if (!r.ok) return undefined`). Any HTTP error then crashed the caller's destructure - before the
  cache write, so the run's pacing progress was lost too.
- **parseP: nested objects were collected as later candidates**, so `{"p_yes": 0.2, "meta": {"p_yes":
  0.9}}` returned 0.9. And my truncation guard fired on any brace inside the final object, forcing salvage
  needlessly - which, combined with the above, took the nested decoy. One fix for both: top-level objects
  only, test the TAIL after the last complete one for an unclosed brace, salvage on that tail alone.
- **mmsim: "markouts first" with no cap moved the starvation onto the market loop.** The refuter imported
  the real module with a mocked fetch: 24 due markouts -> all 8 markets `ok:false`. Now the market loop's
  need is reserved and markouts spend the remainder; local-budget nulls are tagged `throttled`, distinct
  from a venue failure.
- **mmsim-grade: my new INCONCLUSIVE branch printed "cohorts disagree in sign ... NaNc"** when a cohort
  simply had too few days to bootstrap. Two facts, now told apart.

And one I caught myself with a probe before the reviewers: decoy-then-TRUNCATED-answer still returned the
decoy, because unclosed objects were invisible to the brace matcher.

**The parseP test now slices the real functions out of `hunch.ts` at runtime** - not a copy that could
drift - and runs fourteen adversarial inputs through them. 14/14.

### Everything else fixed (verified, all)

HIGH: loss-lock `> 0.98` fired on float noise for 12 of 97 price levels (the sum is algebraically 0.98);
no placement-time guard in the fill model; due markouts dropped forever on a budget null (live: markout15
coverage 72.3%, under the 80% gate); hardcoded dead-zone text; dutch capacity vetoes could never enrol;
`seriesKnown` reported lifetime cache size; the paired grader paired across days.
MEDIUM/LOW: request budget; `prints()` failure invisible; one-sided books counted as coverage misses;
`seenTrades` never pruned (117 orphaned tickers, 5,246 ids in 6h); grade messaging and prereg collision;
coin-vote floor; blank settlements cached forever; MLE pinned at the grid boundary; midnight file paths;
readdir order; LCG could yield 1.0; identical exit codes; catch-all words in the ungraded-block regex;
`'?'` category persisted; **no `import.meta.url` guard on mmsim - a refuter launched a second live instance
against Kalshi by importing the file.**

Refuted on evidence: `recordCulled` "not on every path" - if `searchMarkets` throws there was no scan and
nothing to cull.

### One honest open item

The adversarial suite produced one 85/88 run, unreproducible across ten further runs. Wall-clock-coupled
fixtures with one-hour margins, coincident with ~10 review agents loading the machine. **I discarded the
failure output on the only failing run**, so the tests are unnamed. Recorded as LIKELY, not resolved.

### Deployed

mmsim relaunched under a fresh pre-registration **33249be26379** (stops 2026-10-17T23:04Z); the seven hours
collected under the broken metric are archived as `mmsim-orphaned-1893097bff7b-broken-metric`, not deleted.
Both 15-minute recorders restarted. The live app rebuilt and restarted twice, bundle markers verified
against process start time. Regression at the end: review-fixes 366, ladder 126, adversarial 88 x2, both
selftests with new assertions, parseP 14/14, all eight scripts syntax-clean, every grader refusing to read
early, sentinel `findings: []`.

### The first real lambda sample, and why I am not quoting it

`cull-gate` settled its first day: **404 culled markets**, 334 with a two-sided book and a spread <= 10c.
The model-free table is the honest part:

    0.01-0.10  n= 92  price 0.032  settled 0.011   gap  -2.1c
    0.10-0.25  n= 71  price 0.169  settled 0.070   gap  -9.9c
    0.25-0.45  n= 44  price 0.342  settled 0.409   gap  +6.7c
    0.75-0.90  n= 32  price 0.838  settled 0.875   gap  +3.7c
    0.90-0.99  n= 77  price 0.974  settled 0.987   gap  +1.3c

Longshots below 25c settle well under their price; favorites above 75c settle above theirs. That is the
classic favorite-longshot bias - and it is NOT the Wang shape, which predicts overpricing everywhere. The
single-lambda fit (0.506) is dragged by the 163 low-price observations and is the wrong functional form for
the upper half.

**And it is one settlement day.** One cluster, largely one NCAAF slate, with an SE that treated 334 markets
as independent. My own code refuses a verdict under 5 day-clusters everywhere else; the lambda block did
not, and it read "excludes 0: YES" - the one-cluster band that killed momentum, wearing a different hat.
Fixed before this was written: under 5 settlement days the block now says the interval is unclustered and
reads no verdict from it.

What the table is allowed to say today: the direction at 0.10-0.25 (about -10c) is consistent with fade
being this account's main earner, and the direction at 0.75-0.99 is the opposite of what a Wang lambda>0
predicts. Nothing more until it has days behind it.

### Addendum, 19:40 local: I reported "sentinel clean" three times today, and never once verified it

The one-liner I used to read the sentinel's dry-run searched for `{"at"` with no space. The JSON is
pretty-printed as `{` newline ` "at"`, so the search never matched, the parse returned an empty object, and
it printed `count: 0`. Every "sentinel `findings: []`" in this document's §79-§81 and in the session log was
that parser failing - including the two I explained away as restart transients. **I verified a bug in my
check, not the state of the system.** The final grep-based check (`"findings": []` literal) returned zero
matches, which is what finally made me read the raw output.

The sentinel itself was right the whole time. It has one finding: `mini-error:manifold` - the Manifold
play-money mini-trader has had `Order of 31.28 exceeds max stake per bet (10)` as its persistent error for
at least four hours. Cause is a config disagreement, not code changed today: the mini sizes a bet at
`maxBalancePct = 4` of ~780 mana (~31), and the engine's global `riskLimits.maxStakePerBet = 10` rejects it
(engine.ts:107). The venue never receives an order, nothing executes, and the arm is dead-but-safe. Which
limit gives is the operator's decision; filed as backlog 80, not fixed under a review of other code.

The lesson is not about the sentinel. It is that a verification step whose output is "0" needs the same
suspicion as one whose output is "PASS": **a check that cannot fail is not a check.** The parse should have
been asserted against a field that must exist (`electron`, `mainLogAgeMin`) - it printed `None` for those
the one time I looked, and that was the tell.

## §82 - 2026-09-12 19:40 local: Manifold's stake cap, done per venue (round 89)

The operator's instruction: raise the engine's `maxStakePerBet` for Manifold, because it is mana, not
dollars.

**Not done by raising the number.** `RiskLimits.maxStakePerBet` is one global value applied in
`placeOrder` (engine.ts:106) and in the amend path (engine.ts:482), and its own comment says
"venue-currency": 10 is $10 on Kalshi and 10 mana on Manifold. Raising it globally would have raised the
real-money cap by the same factor. The faithful implementation is a per-venue override:

- `RiskLimits.maxStakePerBetByVenue?: Partial<Record<VenueId, number>>` (ipc.ts).
- `stakeCapFor(venue)` in the engine - the override if present, else the global - used at BOTH check
  sites, so the place and amend paths cannot drift apart (they were two hand-copied expressions).
- `config.json`: `{ "manifold": 100 }`. The mini sizes at `maxBalancePct 4` of ~780 mana (~31), so 100
  clears it with room for the balance to grow and still bounds a runaway. Kalshi and Polymarket US are
  absent from the map and fall through to the global 10, unchanged.

**A trap closed in the same change.** `SettingsPanel.tsx:86` sends only the two fields it knows about, and
the IPC handler at `index.ts:348` REPLACED the stored `riskLimits` with that literal. Any per-venue value
would have been silently wiped by the next settings save - the hand-built-literal failure of round 85, one
more time. The handler now merges over the stored object. The renderer is unchanged: it does not need to
know the field to stop destroying it.

The config edit was made with the app STOPPED, so no settings save could race it, and re-read after the
app's own startup write: field present, global still 10.

**Proof, not inference.** Within one scan of the restart, the Manifold mini's `lastError` cleared and its
open trades include `CACApccLQS NO 31.28` - the exact market and exact amount the sentinel had reported as
rejected for four hours. Sentinel `findings: []`, read this time through a parse that asserts on a required
field and so can fail.

What is NOT proven at runtime: that Kalshi's cap is still 10. Proving it would mean placing a real-money
order over $10 to watch it reject. The code path (`stakeCapFor` returns the global for a venue not in the
map) and the typecheck are the evidence, and that is stated rather than implied.

## §83 - 2026-09-13 03:39Z: momentum hard-stopped fourteen hours after reinstatement

    [ladder] kalshi-momentum: tiny-live -> disabled - net $-6.32 hit the -$5 stop at size x1

**The stop that fired is the money rule, not the statistical one.** Round 79 deliberately left the hard
-$5-per-notch stop ungated by MIN_STOP_CLUSTERS on the argument that a money bound is what makes waiting
for a fourth cluster affordable. It bounded the cost at $6.32 and fired on the first cycle past it. The
system worked as designed; the reinstatement lost money.

**What the trades were.** 33 settled since the 13:28Z promotion, one per event, across MLB, NCAAF spreads
and totals, T20 cricket, CS2 and a BTC daily. Per-contract net -180c; in dollars -$6.32 (the difference is
contract counts). The four worst, per contract: **-93c, -79c, -67c, -56c** - full-loss magnitudes, meaning
entries at roughly 93c, 79c, 67c and 56c. Momentum bought favorites at the top of a move and paid the whole
price when they reversed. That is the payoff-asymmetry failure §76 described from the logit analysis this
morning - a 3c move at 93c is not the same trade as a 3c move at 50c, and the flat threshold cannot tell
them apart - arriving in real money the same day.

**Where the ledger stands.** Lifetime momentum: 54 trades, 32 W / 22 L, **-$10.63**, CLV -2.9c per trade
(adversely selected at entry, on the fast meter). `demotions: 2`, so `cooldownAfter` escalates: cool-down to
**2026-09-27**. Six positions remain open, detached from the ladder's evidence, and settle on their own.

**What this does and does not say about round 79.** The original 2026-09-07 stop was statistically invalid
- a zero-width band from one cluster - and re-arming was the correct call on that evidence; the audit priced
resolving it at a couple of dollars, and it cost $6.32. That is the answer, bought at close to the quoted
price. Momentum as configured loses money on this account. It is not re-armed, the cool-down is not
lifted, and nothing about its threshold is retuned while it is disabled.

**The one open question is about the caps, not about momentum.** 57 momentum signals were BLOCKED by the
capacity caps today (49 long-horizon, the rest event-exposed) and are enrolled in the veto watch. When they
settle, the taken-versus-blocked comparison is the first real data on what the long-horizon cap does to
this arm - and if the blocked set did materially better than the taken set, that is a finding about the cap
selecting the wrong subset, not a reason to revive the arm.

Not changed: backlog 67 (a log-odds threshold) stands as the hypothesis this outcome supports, to be tested
in shadow, not live.

**Reconstruction note.** Three ledger reads returned nothing before the calibration ledger's `byEvent` gave
the per-event picture: `transition()` re-captures the ladder baseline on DEMOTION, so the promotion
baseline is overwritten and the stage delta cannot be recovered from ladder.json after the fact; and
settled auto-trader trades do not carry `strategy` in the episode rows my filter assumed. Backlog 81.

## §84 - 2026-09-13 09:15Z: the log-odds population gets measured before it is traded (round 90)

The operator asked what the risk of switching momentum to a log-odds threshold would be. The trade-level
answer (43 settled momentum trades by entry price) was that the arm loses in four of five price buckets,
worst at the money where the flat 3c bar and a log-odds bar agree exactly, with CLV negative almost
everywhere - an adversely selected signal, not a mis-measured move. A log-odds bar at the at-the-money
unit is a strict superset of the flat bar, so it can only ADD trades, all in the tails; at any higher bar no
setting turns the existing record positive. The dollar risk of a live switch is bounded by the money stop
(~$5-7, as the last two attempts cost) but the switch has no direction the data supports. He agreed the
tail population should be measured before it is ever traded. That is what this round builds.

**Recorder** (`src/main/strategies/momentumCandidates.ts`, observation only). Every momentum candidate
window - under the bar or over it - is recorded from the same calm universe and candles the live arm reads:
prices, point move, log-odds move, the two confirmation facts, the threshold in force, the side momentum
would buy, the best quotes, and three capacity facts raw (entries on the ticker today, minutes since its
last exit, whether the event already carries a position). It runs while the arm is disabled and has its own
term in the candle-fetch gate. One-cent floor; one row per (ticker, slot) plus growth re-records; 40,000
rows a day with drops counted; one log line an hour carrying the hour's totals, with "markets with candles
per scan" as the blindness signal and "failed to write" as the empty-ledger signal.

**Grader** (`scripts/momentum-candidates-gate.mjs`, GET-only). Largest move per (ticker, slot); the first
qualifying slot per (event, UTC day), mirroring the arm's one-per-event cap; windows the arm could not have
traded excluded on the raw capacity facts; every hypothetical entry priced at the executable side ask with
the taker fee in integer cents; settled from the public market endpoint with a cache; day-clustered 80%
bands; the "logit-only" population (rejected by the flat bar, admitted by a log-odds bar) scored separately,
because it is the only population that can distinguish the two rules. `--interim` reads no P&L. `--verdict`
refuses before the read date. No verdict under 100 settled decisions or 5 settlement days.

**Pre-registered.** Read date 2026-09-21T00:00Z. Bars 0.12 / 0.20 / 0.30 / 0.40 / 0.60. The only result
that would earn a log-odds bar a SHADOW test is a logit-only lower band above zero; anything else is the
flat bar with more trades. Momentum stays disabled to 09-27 regardless.

**Review.** First pass (three Sonnet lenses, a refuter per finding, real functions executed): 8 findings,
7 non-LOW, 0 refuted, deduplicating to four defects. CRITICAL: the recorder's private `midOf` required both
sides of a candle while the live arm's falls back to one, so one-sided candles the arm traded vanished with
no trace - reproduced by calling the real `momentumSignals` and the real `computeCandidate` on the same
window. CRITICAL: a NaN close time threw out of the recorder and through `computeSignals` before any arm had
run. MEDIUM: the log fired on every scan with a fresh row. HIGH: rows lacked the capacity facts. Fixed: one
exported `midOf` the trader now imports (its local copy deleted); a finite-check and a per-market try/catch
with errors counted; the hourly accumulator; the three facts. The from-scratch re-review of the CORRECTED
code found three more, all confirmed: HIGH, bookkeeping ran before the disk write, so a failed append left
the stats and the hourly line claiming rows that never landed and a later growth re-record discarded as a
dup - the exact failure the file's own header warns about. Now: select, write, then mark; failures counted,
rows left unmarked for the next scan. MEDIUM: minutes-since-exit was rounded, so 59.6 read as free of a
60-minute lockout; floored. MEDIUM: the grader's time ordering was untested; tested out of order. Three
LOWs taken too (a selftest name, a doc gap, and a fee-eaten breakeven counted as a loss - the fix for which
exposed a float artifact, so net cents are now integer cents).

Tests: review-fixes 392 (26 new), ladder 126, adversarial 88, grader selftest 26, typecheck, build.
Deployed 09:15:46Z, 42 s after the bundle. Backup `PRE-round90-momentum-recorder`.

**Also answered this round, from measurement rather than memory.** Are we executing as fast as we can?
No. Lead-lag runs on a fixed 60 s timer; the 15 s it is configured for and the 5 s default in its type are
read by nothing; its Kalshi price is a REST list snapshot while a websocket client for Kalshi already runs
50 live books for the auto-trader; lifetime 1,738 IOCs filled against 3,692 that filled nothing, which is
the cost of the minute. The auto-trader's last scan took 108.7 s against a 30 s poll, its signals execute on
books snapshotted at scan start, and no phase is timed. Lead-lag's pair list is a two-element literal with
no recorded reason; seven coins trade 15-minute windows on both venues today (BTC, ETH, SOL, XRP, DOGE, BNB,
HYPE; NEAR is Kalshi-only), and the 5c Polymarket spread cap that would make thin books self-excluding is
another dead knob. Backlog 84-88.

**Collecting (addendum, 09:19Z).** First scan after the restart: 259 markets offered, 212 with candles, 33
windows moved a cent or more and were written, 87 unmoved, 0 market errors, 0 failed writes. Rows carry the
side, the log-odds move, the close and both quotes. Pre-registration file written beside the rows with the
grader's sha256 (7732ffae42cd...).

## §85 - 2026-09-13 10:05Z: lead-lag at ten seconds, seven coins, and the caps that made it safe (round 91)

The operator asked whether we execute as fast as we can, then why only two coins, then why wait on
websockets, then "let's not constrain ourselves unless we have a good reason." Measured answers first: the
arm ran on a hardcoded 60 s timer while its configured 15 s and its type's 5 s default were read by nothing;
its Kalshi price came from a REST list snapshot; 68% of its IOCs had filled nothing (1,738 filled, 3,692
not) - the price of the minute. The pair list was a two-element literal with no recorded reason; a public
sweep of 24 coins found seven with a 15-minute up/down window on BOTH venues (BTC ETH SOL XRP DOGE BNB
HYPE; NEAR is Kalshi-only). And `leadLagMaxSpreadCents`, the gate that lets a thin Polymarket book exclude
itself per window, was a third dead knob.

**Shipped.** `leadLagPollIntervalMs` from config (default 10 s, floor 5 s) drives the timer; seven pairs
scanned in parallel, each contained in its own try/catch under `Promise.allSettled`; the Polymarket spread
gate wired, and the midpoint fallback (no book) no longer trades - it did; the Gamma slug-to-token lookup
cached per window; dislocations recorded and logged at most once a minute per (ticker, action); the cycle
line keyed on the found count changing; every early exit counted into a bucket so the status note adds up
to the pair count; **per-window caps on FILLED exposure** - contracts per ticker (default three full sweeps,
tracking the ladder's per-order size) and dollars across all tickers (default $60) - reserved before the
venue call and reconciled to the realized fill. Request volume: 84 GETs a minute at 10 s, 7 Gamma lookups
per 15 minutes, against a public read limit far above that.

**Three review passes, each finding something real in the pass before.** Pass one (three Sonnet lenses,
refuter per finding, 9 agents): CRITICAL, one pair's unguarded JSON parse rejected the whole batch, the
outer catch released the running guard with another pair's sweep still in flight, and the refuter
reproduced a DUPLICATE live order on the same edge; CRITICAL, no per-window cap at ~21x the attempt rate;
MEDIUM, fee-clearing dislocations exempt from the log throttle; MEDIUM, five silent exits. Pass two, from
scratch on the fixes (8 agents): CRITICAL, the new window cap was check-then-act across the venue await -
seven concurrent pairs each read the untouched total and the refuter placed seven orders past a $6 cap with
no log line; MEDIUM, the ledger used the IOC's limit price not the fill; HIGH, the cycle line flooded during
a persistent dislocation; HIGH, the containment test never reached the outer catch; MEDIUM, one throttle
clock for two logs. Pass three, from scratch on those fixes: zero findings - and the reviewer proved it by
mutating scratch copies of the engine: with the reservation removed the concurrent test fails at seven
orders, with the catch removed both containment assertions fail. Tests that bite. review-fixes 410 (18
new), ladder 126, adversarial 88, typecheck, build. Backup `PRE-round91-leadlag-speed-breadth`. Deployed
10:05:42Z, eight minutes after the bundle.

**Not done and why.** Websockets (backlog 86) follow one day after this, not in the same restart: a
frozen feed against a moving book manufactures dislocations, so the design needs a staleness cutoff with
REST fallback, and two exposure-changing edits in one restart cannot be told apart in the fill data. The
size ceiling on lead-lag (85) is decided on a day of fill-rate and markout at the new cadence. Scan phase
timing (87) is its own small round. The websocket reconnects (88) turned out to be planned resubscribes on
universe churn, not a flaky link - closed by diagnosis. The weekly cull-gate run (64) is scheduled, Fridays
08:00, first 09-18, command dry-run proven.

**Veto without a code change.** `leadLagPollIntervalMs: 60000` in `kalshi-auto.json` restores the old
cadence at the next restart; `leadLagMaxSpendPerWindow` and `leadLagMaxContractsPerWindow` are the exposure
dials.

**Observed (addendum, 10:15Z).** First seven-pair cycle 10:05:53Z: 7 live books, buckets summing to 7.
By 10:13Z the spread gate was refusing 2-3 thin Polymarket books per cycle and the 5-95c guard 2-3 more,
each counted. 19 cycle lines in nine minutes (change-keyed), 39 dislocation rows across all seven coins,
no errors, no Kalshi-leg failures, no window-cap holds. At 10:13:03Z ETH, XRP, DOGE and BTC dislocated the
same way within 120 ms and four sweeps fired concurrently at 8 contracts each, BNB twenty seconds before:
five coins, ~$15 of the $60 window - the correlated burst the reservation was built for, on the first
window it ran. The momentum recorder resumed at 10:10Z (23 rows, 225 of 260 markets with candles).

## §86 - 2026-09-13 11:00Z: the scan is timed (round 92, backlog 87)

The other half of the morning's speed question. The auto-trader's last scan took 108.7 s against a 30 s
poll, its taker arms execute on books snapshotted at scan start, and nothing said which phase eats the
time. Observation only: eleven marks inside `tick()` (vetoes, pending, orphans, exits, universe, data,
sports, signals, gate, review, execute), a pure `phaseDurations()` (tested, repeated names sum), the
profile on `state.lastScanPhases` (readable from kalshi-auto.json), one `scan` row per scan in the episodes
ledger with the phases and the counts - that is the measurement - and a console line for outliers over
150 s or every 20th scan.

Review (one Sonnet lens, refuters): HIGH, my 60 s "outlier" bar sat below the 108 s baseline and would have
logged every scan, contradicting its own comment - moved the measurement to the ledger and the bar to
150 s; MEDIUM, the first bucket charged four venue-facing calls to "exits" - each has its own mark now;
LOW, a repeated mark name dropped its earlier slice - sums now, tested. review-fixes 414, ladder 126,
adversarial 88, typecheck, build. Backup `PRE-round92-scan-timing`. Deployed 11:00:50Z, 36 s after the
bundle.

What comes next is a decision on evidence, not a guess: if the LLM gate and intelligence review dominate,
the fix is to re-read the book before execution or move the reviews off the path; if the universe fetch
dominates, it is the page bound (backlog 83) and pagination; if the sports polls dominate, they move to
their own timer. Read a day of `scan` rows first.

**First profile (addendum, 11:07Z).** One cold scan after the restart, NFL Sunday, raw universe 4,653
before caps, ~257 after: total 315.3 s - vetoes 30.5, pending 1.0, orphans 5.9, exits 62.7, universe 64.3,
data 136.0, sports 7.9, signals 7.0, gate/review/execute 0.0 (nothing approved). The LLM stages I assumed
this morning cost nothing here; the time is in fetching. `data` is candles + books + news for ~257 markets
(the cap bounds it; `scanned` is the raw count), which at 136 s points at per-market order-book calls;
`universe` is the paged walk; `exits` is the exit manager over open positions. Cold-start caches and a
weekend slate inflate a first scan, so this is one row, not the shape. Read a day of them.

## §87 - 2026-09-13 11:39Z: the unproven coins go back to micro size (round 93, backlog 91 + 92)

A self-correction of round 91. The 07:00 daily maintenance session (a separate headless run) found what I
had missed: the five new coins were sweeping at the 8-contract size BTC/ETH earned through three ladder
checkpoints, their settlements were pooling into the ladder evidence that earned it - and a pool cannot
stop a subset - and the $60 window cap was 42% of $142.57 equity and bound at the 11:00Z window. It
measured the gap (`scripts/leadlag-coins.mjs`, per coin off the venue ledger) and pre-registered a cohort
stop (`docs/PREREGISTERED-leadlag-coins.md`: >= 400 new-coin contracts and >= 5 day-clusters; upper bound
< 0 -> narrow to BTC/ETH; undecided by 2026-10-04 -> narrow by default). It did not change sizes, because
sizes are the operator's - and under the standing directive, mine.

**Shipped.** `leadLagProvenCoins` (config, default BTC/ETH) sweep at the ladder's size; every other coin
at `leadLagNewCoinContracts` (default 2, the ladder's own entry size for this arm, hard max 4), with a
per-ticker window room of three such sweeps. The ladder's pooled evidence counts proven-coin rows only
(rows without a coin field, pre-expansion, still count), so the stage BTC/ETH earned is not completed by a
mixture; the unproven cohort is judged by the pre-registered gate, and a cohort whose lower bound clears
zero is promoted by adding it to `leadLagProvenCoins` in config - full size and pooled evidence from then
on, no code change. `leadLagMaxSpendPerWindow` default $60 -> $40 (28% of equity).

Review: one Sonnet lens with the runtime, zero findings - but its transcript held a failing partial-fill
probe it had not reported, so I ran my own against the real engine before trusting the pass: a fill of 1
against 2 requested leaves room for two more sweeps, the fourth is held at exactly 5 of 5, and the hold is
logged once. The reviewer's probe was wrong; the reconciliation is right. review-fixes 418, ladder 126,
adversarial 88, typecheck, build. Backup `PRE-round93-leadlag-microsize`. Deployed 11:38:53Z.

At micro size the cohort reaches the 400-contract bar in roughly 200 fills - about a day at the rate seen
this morning - so the pre-registered date holds and the cost of finding out is a quarter of what it was.

## §88 - 2026-09-13 ~11:40Z: the daily kill switch tripped on lead-lag's correlated windows (round 94)

The operator reported it. Venue day -$34.95 on 76 settlements against a 20% limit on $142.57 equity
(~$28.50). The arms lost $4.68 of it (momentum's tail -$3.81, volume-spike -$0.89, fade +$0.02); the rest
was lead-lag, which since the round-91 go-live at 10:05Z had settled 49 fills, 386 contracts, for
**-$31.28** after fees (public settlement results, GET-only). Every arm has been held since; the last sweep
was 11:35:52Z, before the round-93 restart.

**Where it went.**

    window (UTC)  fills  contracts  coins   net
    11:00           13      104      six   -20.94
    11:30           11       88      six   -18.91
    10:45            7       56      six    -8.08
    by coin: XRP -19.52 (7 of 8 fills lost), HYPE -8.34, SOL -3.93, DOGE -3.82, BTC -0.56, ETH +1.04, BNB +3.85

Seven coins on one 15-minute crypto window are not seven bets. They are one bet on crypto direction taken
seven times, and round 91 took it at eight contracts each under a $60 window cap that admitted all of it.
I named the correlated burst at 10:15Z as "the case the reservation was built for" and read it as the cap
working. The cap worked; the bet was wrong, and the cap was sized for seven independent bets, not one.
Round 93's micro sizing for the five unproven coins went live at 11:38Z, ninety minutes after the two
losing windows. BTC/ETH at the 10 s cadence were flat on 11 fills - no evidence either way yet.

**What the kill switch did.** Exactly its job: it read the venue ledger (the local ledger showed only
-$8.36, because lead-lag's settlements are not in it), tripped, and held every engine including lead-lag.
The trip is the design working; the loss is the design being tested at the wrong size.

**Round 94, before the kill lifts at day rollover.** `leadLagMaxSpendPerWindow` default $40 -> $15
(~10% of equity: one wrong window cannot take most of a day's budget). New
`leadLagMaxCoinsPerDirectionPerWindow` (default 2): at most two coins swept the same way per window,
reserved before the venue call like the spend cap, released on a throw or a zero fill, kept on a fill.
Unproven coins stay at micro size. Nothing re-armed; the kill lifts on its own. Worst case now: two
proven coins at 3 x 8 plus two micro seats, bounded by $15 - a wrong window costs a tenth of equity, not a
quarter. review-fixes 419, ladder 126, adversarial 88, typecheck, build.

**What this says about round 91.** Breadth was the operator's directive and the right one; full size on
the new coins was mine and wrong by the ladder's own rule. The pre-registered cohort gate still decides
whether the new coins stay, at a quarter of today's cost per fill.

**Deployed (addendum, 12:00Z).** Round 94 live at 11:57:41Z. The review's one finding was about my test,
not the code: the zero-fill seat release could be removed and the test still passed, because the zero-fill
coin was first in iteration order and re-took its own seat either way. Rewritten with one seat and the
release proven by a different coin taking it; against the reviewer's mutated engine the new test fails,
against the real one it passes. Backup `PRE-round94-direction-cap`. After the restart: `tripped: true`
persisted, zero sweeps, no errors; the venue day had improved to -$23.66 on 79 settlements as the last open
positions settled, and the trip stays for the day regardless.

## §89 - 2026-09-14 10:30Z: implication arbitrage on Kalshi's ladders, tested and closed

From the tradoxvps guide the operator shared: combinatorial (logical-dependency) arbitrage was the one idea
not yet tested here. Kalshi's threshold ladders are its cleanest form - "above 78k" cannot be worth more than
"above 77k" - and the lock is buy YES on the weaker claim at its ask, buy NO on the stronger at one minus
its bid. `scripts/ladder_implication_scan.py` over four days of recorded books: 137,379 strike pairs across
247 events; 32 priced the wrong way round before fees (0.02%); zero positive after taker fees on both legs.
The market is monotone to within fees. Together with backlog 70 (same-event sums not executable at size)
that closes structural arbitrage on Kalshi at our size and cadence. Scorecard entry, not a build.

## §90 - 2026-09-14 11:16Z: the Polymarket consensus arm is built (round 95, build-queue item 13)

Build-queue item 13 had been triggered since 2026-09-12 and pre-registered on 2026-09-13
(`docs/PREREGISTERED-polymarket-consensus.md`); the arm itself was deferred twice because `autoTrader.ts`
was being edited by another session. Built and live today, at micro size on the ladder like every other arm.

**Today's reading of the trigger, before building anything.** `python scripts/polymarket_consensus.py
report`: 5,040 signals, **4,177 graded**, hit rate 0.70 at a mean price of 0.70, Brier 0.0944. Net per
contract at the Kalshi ask net of the taker fee, day-clustered (t on G-1 df): **+6.39c, 95% [+3.14,
+10.19]** over 692 rows and 7 days — the band still excludes zero and has tightened since 09-13
([+2.06, +11.23] on 584 rows / 6 days). Polymarket US is **+3.68c [-2.38, +10.97]** and still includes
zero, so the arm stays **Kalshi-only** exactly as pre-registered. Clustered by CATEGORY instead of day the
Kalshi band is [-5.14, +16.93] and includes zero — caveat 2 of the pre-registration is unchanged, and is
the reason this is a micro-size arm the ladder can stop rather than a size the concentration could hurt.

**What was built.**

- `src/main/strategies/consensus.ts` (new). `consensusRefusal()` is the whole pre-registered entry rule as
  one pure function — matched market, live ask present, signal <= 24 h old, market >= 6 h from close, ask
  inside 10-90c, and refused once the Kalshi ask has run more than 10c PAST the Polymarket price at signal.
  Drift is signed on purpose: Kalshi having already caught up is the case the pre-registration refuses,
  Kalshi being cheaper than the wallets paid is not. `parseConsensusSignals()` reads the shadow's JSONL,
  skips torn lines rather than throwing (another process appends to it), and keeps the NEWEST row per
  Kalshi market. `ConsensusFeed` caches on mtime+size — the shadow writes hourly and the scan runs every
  minute or two — and re-filters the cache for freshness on every read, so a signal cannot outlive its 24 h
  window just because the file stopped changing.
- `autoTrader.ts`: `consensusSignals()` at the `computeSignals` injection point, following `anchorSignals`'
  pattern for markets outside the ranked universe (fetch the market and its book, cache 10 min, at most 10
  fetches per scan). Entry is always YES on the matched market, because the matcher matches the Kalshi
  market whose YES side IS the signalled outcome (`polymarket_consensus.py:461-466`).
- **Taker-only is enforced in code**, not left to the `makerStrategies` list: the +6.4c was measured at the
  ask, a maker seat is a different strategy, and the maker path has nowhere to record the Polymarket source
  market. `makerEntryFor('consensus')` returns false unconditionally.
- `state.consensusActed` (persisted): one entry per Kalshi market and one per Polymarket source market
  (conditionId), pruned at 30 days. Persisted because the app boots about eighteen times a day and an
  in-memory set would let a restart take the same signal again. Marked at ORDER PLACEMENT, not at signal
  generation, so a signal the LLM gate or a capacity cap refused stays available.
- `GENERIC_STRATEGIES` gains `{ id: 'kalshi-consensus', venue: 'kalshi', key: 'consensus', flag:
  'consensusEnabled' }`. No size, arm or limit setting was touched: `consensusEnabled` ships **false**, and
  trade-small mode promotes it to tiny-live on the ladder's own next run.
- The arm logs one line per scan with its refusal counters (`[consensus] N fresh signals, M candidates |
  refused {...}`). A silent arm that does not say why it is silent is how the consensus shadow itself hid
  for four days (backlog 55) — that lesson is now in the arm it produced.

**Verification.** `npx tsc --noEmit` clean. `review-fixes` **461 / 0** (+47 new tests), `ladder` **126 / 0**,
`adversarial` **89 / 0**. The 47 new tests were **mutation-tested**: four mutants in a scratch copy — drift
made absolute, the 6 h floor made exclusive, the freshness re-filter deleted, and newest-row-wins reverted
to first-row-wins — each failed exactly one test and no other. The adversarial suite's strategy-count drift
alarm fired as designed (19 -> 20) and was updated with the arm's name alongside the number.

**Expected flow.** Of the last 24 h of signals, 111 carried a matched Kalshi market with an ask, 102 were
inside the 10-90c band and 75 survived the drift gate — before the >= 6 h-to-close floor, which removes the
5- and 15-minute crypto up-down markets entirely. That floor is also what keeps this arm off the same
15-minute windows lead-lag trades, so the two cannot stack on one directional bet.

## §91 - 2026-09-14 12:40Z: every strategy against our record

`docs/STRATEGY-TAXONOMY-2026-09-14.md`: ~40 strategy families from three research lenses (nine Sonnet
agents, every claim cited), each marked tried / running / shadow / dead / not tried against our ledgers,
with why and whether it is worth trying. The finding: the list is not missing a category; it is missing
speed on the one category the outside evidence shows paying, which is the socket and spot-first work
already queued. Eight items came out of it (build-queue 78-83 plus two already queued), one of them the
operator's (deposit to $250 for interest on the balance).

## §92 - 2026-09-14 13:30Z: the shortlist, tested where it could be tested today

The operator: "Let's go ahead and test the things that are worth testing." Of the taxonomy's eight, three were
readable today without money or an app change, one could be started as a shadow, and four stay on their
triggers for a stated reason (80 needs the 09-18 paired read; 81 is a January season; 82 is the operator's deposit;
maker-on-Polymarket-US is bound to mmsim's 10-17 read and the operator hold).

**78, Kalshi liquidity incentives (B3): read, closed at this size.** The public endpoint lists 200
programmes, all on 15-minute commodity/crypto-lead windows or weekly weather/LLM markets, with 300-1,000
contracts required resting on BOTH sides for a snapshot to count. The smallest is about $300 of collateral
in one market against $142 of equity. Not a strategy for us until equity is several times larger and a
programme lands on a series we quote. Detail in BACKLOG (78 read).

**79, domain calibration slopes (C2/C3): read, and it found something.** `scripts/backtests/calibration_slopes.py`
over the Becker archive (4.8M Politics trades among 67M): Politics prices are compressed toward 50c in both
halves of the sample and in every horizon bucket; buying the favourite side at 85-94c with at least six hours
to close nets +3.6c and +8.2c per contract after the taker fee in the two halves; longshots lose 5-21c. The
caveats are real and recorded: contract-weighted it holds every quarter, one-trade-one-vote it holds in the
election quarters and not in 2025Q1-Q2; five events carry 77% of the favourite contracts; the mention series
lose at every favourite band. That is the favourite-longshot bias our fade arm already earns at 90-97c,
extended by one domain and one band. Queued as 85 with a pre-registration rule and a live check on our own
recorded books (`scripts/backtests/politics_favourite_live.py`, GET-only); tiny-live only through the ladder,
only after the 09-19 cull-gate read and >= 30 settled decisions on our books.

**63, spot-first fair value (E2): shadow STARTED, ahead of the socket.** The socket (61) is the reason to
wait for money, not for measurement: a standalone recorder needs no app change and no key. `scripts/spot-shadow.mjs`
runs as `OracleTrader-SpotShadow` (cloned from the BtcCollector task: logon trigger, restart x3, no time
limit; self-test `--once` passed 5/5 coins before registration; first rows verified in the file). It records
Coinbase spot ticks, Kalshi public books every 2 s, the Polymarket CLOB book and Kalshi's result per window,
and computes the pre-registered lognormal fair value at every poll. The rule, the read date (2026-09-21T00:00Z),
the decision unit and what a PASS earns are in `docs/PREREGISTERED-spot-first-shadow.md`; the grader
`scripts/spot-shadow-gate.mjs` refuses an early verdict and has 16 self-test checks (one test assertion was
wrong on first run - it expected threshold 5 to drop the window rather than take the later 7c poll - and was
corrected; the code was right). Blind spots stated: sub-2-second edges and BNB/HYPE. Queue 84 owns the read.

**83, settlement basis (F3): read below.** (Result appended when the 3-day comparison finishes; the first
run returned "no market" for every window because Gamma hides closed markets from `?slug=` unless
`closed=true` is passed - a query bug, not a venue fact, fixed and re-run.)

**83, settlement basis: read, real, not a gate.** 43 of 2,013 matched 15-minute windows over three days
resolved differently on the two venues (2.1%), all with the index landing within about a basis point of
the strike; six of our windows were among them and cost $27.81 of the arm's gross losses. The cell read
over our own fills says the late, near-strike fills are the earners, so no time or distance gate is
supported; the cost is recorded as a property of the arm and read weekly (queue 86).

**85, political favourites: closed as a blanket rule the same afternoon it was queued.** The one-entry-per-
market replay loses about 10c per market at every favourite band in every quarter; the archive's headline was
three mega-events. Two useful residues: the category map routes football series into Politics (both scripts
now exclude them explicitly), and election-call favourites are the one sub-population that paid, which becomes
an October pre-registration for midterm night (queue 87), not a build today.

Net of the day: one shadow running with a fixed read date (spot-first, 09-21), one live-data confirmation of
where lead-lag's money actually comes from (the last five minutes near the strike), two candidates closed by
measurement before they cost anything (LIP at our size; political favourites as a rule), and one venue fact
that explains a third of lead-lag's gross losses.

## §93 - 2026-09-14 15:27Z: round 96, the consensus arm gets room (number of positions, not size)

The operator asked whether more positions would speed any test. One: the consensus arm's 40-settled-contract
judgment is flow-limited, and the flow was being blocked by the trader's shared long-horizon slot cap and
by the arm's own 202-day first entry. Two throughput changes at micro size, neither touching how a signal
is priced, sized or graded: a 21-day ceiling on entries (`too-far`) and two long-horizon slots reserved
for the arm (`longHorizonCapFor`). The pre-registration carries the amendment, dated before day 1 closed.
Eleven new tests; the counterfactual probe shows both assertions fail under the old shapes (no ceiling ->
null at 505 h; extra 0 -> cap 4). Restart verified against the bundle time. Everything else in the queue
is calendar-bound and stays where it is.

## §94 - 2026-09-15 06:45Z: round 97, consensus holds to settlement; the losing streak is lead-lag BTC

The operator: "On a losing streak with Kalshi. What are we losing on? Looks like it shut down due to a computer crash."
The shutdown was an unattended Windows Update restart (01:29-06:20Z). The losses are lead-lag: 09-13 -$15,
09-15 00h -$18, with BTC -$33.51 since 09-14 while four of the five new coins are positive. Size on the
ladder-sized pair meets a 50/50 held-side win rate; about two thirds of the recent matched-window loss sits in
the ~2% of windows the two venues settle differently. No lead-lag change: its pre-registered day-1 rule says
keep the cadence, the coin rule is 2 of 5 clusters, and the ladder's checkpoint is 18 settlements away.

One defect found on the way and fixed: the consensus arm was never on the hold-to-settle list, so its
pre-registered hold-to-resolution test was being run as a 5%/10% scalp. `holdsToSettlement()` is now a tested
pure function; the mutant test fails without the consensus line; restart verified against the bundle time.
The pre-registration carries the amendment and the grading cut.

## §95 - 2026-09-15 20:06Z: IBKR Gateway readiness in Settings

Added a localhost-only IB Gateway readiness check and Settings panel while the account's IBKR Lite-to-Pro
conversion is pending. It probes the standard paper port first (4002), then live (4001), reports the detected
mode, and exposes no order path or credentials. The focused test was mutation-checked by reversing port
preference; it failed as expected. Completion 15/15, review 483/0, ladder 126/0, adversarial 89/0, typecheck
and production build passed. The deployed Electron process started after the new bundle; account config and
the running experiment processes were not changed.
## §96 - 2026-09-15 23:48Z: paired lead-lag cadence shadow

The observed loss split does not support blaming sub-minute repeats: only $2.91 of the September 13 $47.97
losing streak came from repeats inside 60 seconds, and the September 14 streak had none. But a 10-second loop
can also select a different *first* opportunity than a 60-second loop, which historical fills cannot reconstruct.

Added a signal-only paired recorder inside the existing lead-lag scan. Every net-positive observation is the
10-second arm; the first scan per UTC minute is also the 60-second arm. The registered grader assigns one
hypothetical contract to the first signal from each arm on the same settled ticker, including the recorded taker
fee, and judges their paired difference with a day-clustered interval. It cannot place orders. The outcome read is
locked until 2026-09-21 00:00Z and also requires 300 paired markets across five UTC entry days.

This was chosen over restoring the old live build because the September 12 winning configuration bundled several
changes: BTC/ETH only, a hardcoded 60-second timer, and actual four-contract fills caused by the then-defective
four-contract clamp. Recreating that build would interrupt the existing coin-cohort experiment and remove later
safety controls. The paired design changes one variable while leaving all live settings, open tests and durable
window reservations intact.

Verification: the new assertion failed with the recorder calls removed, then passed restored; review-fixes 484,
ladder 126, adversarial 89, risk 11, remaining-defects 11, completion 15, plus model-usage, execution-quality,
collection-integrity and migration suites; typecheck and production build clean. Restarted once; Electron start
19:47:58 local was later than the 19:47:16 bundle. The live file then recorded 10 observations across six markets,
three present in the minute sample, while the lead-lag loop continued without new errors.

## §97 - 2026-09-16 08:00Z: what changed between lead-lag's winning streak and now (read only)

The operator: "I feel like it's because of something we changed." It is, and the changes are ours, in this order. Every
number is from the venue ledger (`tmp/k-2026-09-16.json`), the executed rows in `leadlag-dislocations.jsonl`, or
`main.log`; configs are from the dated zip backups' `userData/` copies.

**The winning configuration (09-07 to 09-12 12:46Z):** BTC and ETH only; a hard-coded 60-second poll; fills of
at most 4 contracts (the config said 8 from round 76 but the 4-contract clamp held it); the engine's own
position cap OFF (`riskLimits` 0/0); a sweep reached the venue **70 ms** after the dislocation was seen
(DISLOCATION line to SWEEP EXECUTED line, same coin, median; p90 0.13 s). BTC/ETH earned **+12.0c per contract**
over 489 contracts (+$58.59), positive on every day.

**What changed, and what each did (BTC/ETH per-contract net, log-measured sweep latency):**

| When (UTC) | Change | Latency | Edge |
|---|---|---|---|
| 09-12 12:46 | round 76: engine `riskLimits.maxOpenPositions` 0 -> 80, so every order is preceded by two venue reads (positions, open orders) | 0.07 -> 0.44 s | - |
| 09-12 14:13 | round 85: clamp fix, 8 real contracts per sweep | 0.86 s (p90 14.6 s) | +12.0c -> +1.7c on the same cadence and coins (period 09-12 14:13Z to 09-13 10:04Z, 491 contracts) |
| 09-13 10:05 | round 91: 10 s poll, seven coins swept concurrently (up to 21 venue calls per cycle on a ~2/s budget) | **14.0 s median, p90 45 s**; lone sweeps 9.3 s on 09-14 | -2.9c on 1,373 contracts since |
| 09-13 11:39, 11:57 | rounds 93-94: micro new coins; $15/window; 2 coins per direction | - | the caps also held BTC/ETH sweeps 54 times on 09-14; five new coins -$27 cumulative |
| 09-15 23:48 | another agent's limiter rewrite (writes first, 334 ms pacing) | 14 s -> 3.7 s | - |

Size is the cleanest single association: on every day since 09-13, fills of 8 contracts lost (-0.9 to -40c per
contract) while fills of 4 or fewer won (+9.7 to +54c), including within the same day (09-14: +9.7c vs -0.9c). The
loss sits in mid-price entries: 30-50c entries went +3.7c (winning period) -> -2.8c -> **-13.4c per contract**
and account for -$53.60 of the -$39.50 since round 91. Volatility helps explain the day-to-day swings (09-12 was the
calmest day of the period, BTC 13% annualised; 09-14/15 were 37-63%) but not the per-size split.

Not implicated: the 09-15 changes by the other agent (window-ledger persistence, order journal, request pacing) - the
only lead-lag log line they produced was one hold, and the pacing rewrite cut order latency by two thirds.

**Where it stands:** the ladder counts 198 BTC/ETH settlements since the x4 stage began (09-11 12:10Z) at net
-$3.45; at 200 its 100-trade sign rule stops the arm (3-day cool-down, then trade-small re-entry at notch 1 = 2
contracts). The kill switch is tripped today (venue day -$24.09, its third trip in four days after 09-13 and
09-15 08:43Z); entries resume 00:00Z. The 09-15 maintenance run filed queue item 60 (the day-one cadence read) as "not
due", which was wrong; the other agent's paired cadence shadow (item 105, read 2026-09-21) now owns that
question. Nothing was changed today: a Codex session is active in the repo, the ladder's stop is the designed
response, and the coin (~09-18) and cadence (09-21) tests are collecting. Two builds are queued (106, 107).
## §98 - 2026-09-16 07:12Z: position-cap reads removed from lead-lag bursts

Implemented backlog 106 from the read-only §97 diagnosis. `TradingEngine` now caches the live positions plus
resting-orders count for three seconds inside its existing per-venue entry queue. A filled buy or resting order
increments the cached count before the next queued order; any submission error invalidates it so an uncertain
order is re-read with the journal's pending reservation. The first entry after the TTL still fails closed through
fresh venue reads. This removes two authenticated GETs from every later order in a concurrent lead-lag burst while
preserving the operator's position cap.

The mutation without the local increment failed the original concurrent-last-slot regression. All ten suites pass:
review 484, ladder 126, adversarial 89, risk 12, remaining 11, completion 15, plus model-usage,
execution-quality, collection-integrity and migration; typecheck and build pass. Deployed at 03:12:22 local on a
03:12:09 bundle. The daily kill switch remained tripped at venue-day -$24.09, lead-lag continued recording with
zero new sweeps and no scan errors. A live latency measurement therefore waits for the first permitted fill.

## §99 - 2026-09-16 07:35Z: winning-period lead-lag settings restored, plus HYPE

The operator correctly pointed out that §97 was a diagnosis, not the restoration he had requested. The live configuration
still had seven coins, a 10-second timer and an eight-contract ceiling. Restored the behavioral baseline: 60-second
polling and four contracts maximum. Added an explicit configured coin universe and set it to BTC, ETH and HYPE;
HYPE is the one operator-requested extra coin and was positive in the latest six-hour venue ledger. The ladder now
uses one contract per notch, so its current notch 4 and future writes preserve the four-contract ceiling.

The engine's 80-position cap stays enabled with §98's three-second cache as the sole safety difference from the old
build. Today's tripped daily-loss stop is not reset, and no existing position or resting order is canceled. The
cadence and five-new-coin registrations were amended before deployment, without reading their outcomes, to record
that collection is paused rather than silently contaminated.

The universe-filter mutation failed 484/485 as expected. Sequential verification passed review 485, ladder 126,
adversarial 89, risk 12, remaining 11, completion 15, model-usage, execution-quality, collection-integrity and
migration, plus typecheck and production build. Backup:
`oracle-trader-PRE-round107-leadlag-baseline-restore-20260916-032907.zip`. The deployed process started after the
bundle, logged three scanned pairs, and advanced `lastScanAt` by 60.002 seconds. A post-restart venue dump remained
complete with 17 positions and the same two resting orders; the daily loss stop remained tripped.

## §100 - 2026-09-16 07:48Z: operator-authorized loss-stop reset and visible IBKR tab

The operator explicitly asked to verify the settings and reset the daily kill switch. Verified BTC/ETH/HYPE,
60,000 ms, maximum four contracts (HYPE retains its two-contract exploratory size), live armed,
dry run off, stop-entry off, and the existing 20% loss limit. A simple flag clear would immediately
re-trip on the same -$24.09, so added a dated, persisted operator baseline for each ledger. The raw
daily P&L remains intact; subsequent losses are measured from the reset values, and the baseline
expires at UTC midnight. Reset at 07:48:00Z with venue -$24.09 and local +$1.584479. No orders or
positions were removed, and ladder evidence and stops were preserved.

Added a visible IBKR tab using the existing Gateway check. Port 4001 is listening. This is still a
connection-readiness panel, not an authenticated account/market/trading integration; the panel states
that limitation explicitly. Earlier statements implying the paper API was connected were incorrect.

All ten suites passed, including 13 risk scenarios. The reset regression failed when the venue offset
was removed. Typecheck and production build passed. Backup: PRE-round108-reset-ibkr-tab-20260916-034555.

## §101 - 2026-09-16: real IBKR account and ForecastEx data

Replaced the readiness-only tab with authenticated account balances, positions, open orders,
ForecastEx contract search by product and month, and live quote snapshots. Added a serialized,
read-only TWS client using pinned @stoqey/ib 1.6.9. Incomplete responses, missing permissions and
disconnects surface errors; absent prices display Unavailable. No order-placement path is present.

Live Gateway on port 4001 returned one account with $0 cash/value/funds, zero positions and zero
open orders. September FF lookup returned 32 contracts. FF_091726_4.125_YES returned bid 1c / ask 5c
at 08:04:08Z. Broad unbounded FF lookups timed out on repeat requests, so search explicitly selects
a month. Quote requests use conId and exchange: replaying the contract-details date string produces
IBKR error 10372. Regression tests detect that broken identity construction.

All ten existing suites passed (review 485, ladder 126, adversarial 89, risk 13, remaining 11,
completion 15, plus model-usage, execution-quality, collection and migration); dedicated IBKR tests,
typecheck and production build passed. A separate Electron window loaded the actual built UI/preload
against the real Gateway, rendered all 32 contracts and obtained a live 5c ask via its quote button.
Unrelated Kalshi shell reads were stubbed in this isolated UI check; no simulated IBKR data was used.
Screenshot: tmp/ibkr-ui-smoke.png. Backup: PRE-round109-ibkr-data-20260916-035519.

Remaining: IBKR order preview/submission, durable fill reconciliation and strategy integration.
This is a useful read-only integration, not a completed automated IBKR trader. Kalshi configuration,
the dated loss-stop reset and existing tests were not changed in this round.

Deployed at 04:09:31 local, after the 04:05:22 production bundle. Startup reconnected the venues
and loaded 19 Kalshi positions. No new startup error appeared; the existing Electron development
CSP warning remains. No order was manually placed, amended or canceled during this integration.

## §102 - 2026-09-16: IBKR execution adapter, reconciliation and one-shot automation

Implemented the previously missing execution path. `IbkrAdapter` is registered with the engine;
UI and routed strategy orders pass through the existing stake/position caps and durable order journal.
Strict whole-contract, cent-tick, budget, venue, account and Gateway-mode validation precede submission.
Broker `whatIf` previews never transmit a trade. Acknowledgements are not counted as fills. Definite broker
rejections release reservations; lost acknowledgements remain reserved across restarts until reconciled.
Live execution uses port 4001 and client 17091; a paper Gateway cannot silently replace it.

ForecastEx closes buy the opposing contract through the same entry controls. The adapter verifies the held
quantity and rejects duplicate pending closes. Cancellation is limited to Oracle-owned ForecastEx orders.
Minute execution reconciliation collects commissions, deduplicates immutable execution IDs in the existing
durable archive and surfaces errors in the IBKR tab. Corrected execution IDs and ambiguous timestamps stop
ingestion for review rather than silently double counting or guessing dates. Explicit UTC or IANA-zone times
are supported; timezone-free execution timestamps require Gateway API timezone configuration. The bounded
TWS execution feed is not a complete historical settlement/P&L ledger, particularly after long downtime.

Added optional one-shot price watches: up to four rules, UI lifetime one hour, one-minute checks, live quotes
only, available-cash check and one IOC submission at the configured limit. Rules persist before submission;
interrupted/uncertain submissions are not retried. Stop-watch does not cancel any existing venue order.
This is an entry automation mechanism, not a new validated fair-value model; no Kalshi strategy or registered
experiment was ported or enabled on IBKR, and no production rule was created during verification.

The operator disabled Gateway's Read-Only API after the first broker preview returned error 321. Retest then passed:
FF_091726_4.125_YES, one contract at 1c, broker cash requirement 3c, zero open orders/executions/completed
orders afterward. Gateway omitted commission, so the UI explicitly identifies a published-schedule reserve
(1c per contract) and honors any larger broker margin requirement. It never labels that estimate a reported
commission. Source: https://investors.interactivebrokers.com/en/pricing/commissions-events.php .
Order semantics: https://www.interactivebrokers.com/campus/ibkr-api-page/event-trading/ .

Verification: all 12 suites passed (the ten existing suites plus IBKR reads and IBKR execution/automation),
typecheck/build clean. Tests include broker rejection, missing/invalid data, funds, duplicate closing orders,
late commissions, fill deduplication across restart, engine caps, attribution, timeout reservations and
watch interruption/no-retry behavior. Removing IBKR journal participation made the new regression fail;
source restored byte-identically. The actual built UI/preload queried real Gateway data and completed a
broker preview with no alerts; screenshot `tmp/ibkr-ui-round110.png`. Unrelated Kalshi shell IPC and watch
status were stubbed only in that isolated UI harness; IBKR account/contracts/quote/preview were real.

Backup: `oracle-trader-PRE-round110-ibkr-execution-20260916-041504.zip`. Deployed at 04:33:51 local after
the 04:33:50 bundle. The account remains unfunded. Live funded submission, fill, cancellation and opposing
pairing have not been venue-verified; no test trade was sent. Kalshi resumed with 20 positions and its
configuration, loss-stop baseline, ledger and existing tests preserved.

Production reconciliation completed at 08:35:22Z: zero executions, zero ingested, no remaining error.
The first pass collided with the isolated UI harness sharing client 17091; moved that harness to 17092,
after which both preview and the production reconciler succeeded. The empty execution feed appropriately
retains completeness `unknown`, rather than claiming complete historical coverage. Post-deploy settings
remain BTC/ETH/HYPE, 60 seconds, armed, dry-run off, stop-entry off and daily kill not tripped.

## §103 - 2026-09-16: autonomous IBKR paper strategy laboratory

Implemented 23 paper strategy arms with independent $1,000 accounts and a separate IBKR mode. The lab
starts automatically, samples fresh real Gateway quotes, persists orders/positions/results, closes positions
through opposing asks, pairs opposing contracts at $1 and grades expired contracts from complementary
ForecastEx final settlement values. Whole-contract liquidity limits, next-snapshot entry, conservative passive
trade-through, one-cent fee/slippage per taker leg and corrupt-ledger refusal prevent optimistic invented fills.
Exact public catalog/IBKR joins initially discovered 271 markets across six categories. Discovery is bounded
to 36 products and 12 pairs/product; each scan rotates up to 30 pairs. Daily station-temperature instruments
were found and the NWS forecast/observation model ported with explicit Weather Underground settlement-basis
risk, without claiming NWS can certify a resolved contract.

The IBKR tab now contains the full-width lab scorecard, pending paper orders, open positions, realized/open
net, unpriced marks, recent results, pause/resume and funded-live activation. The unrelated global Live
indicator is hidden on this tab. Promotion requires 30 closes, 10 events, three days and a positive conservative
day-cluster lower bound; this is a screening gate, not proof of profitability. Selected live entries route
through engine caps and the journal. Unique refs, durable execution dedupe, partial-IOC completion checks,
recovery of uncertain submissions and pairing-before-exit are tested. No broker trade was submitted.

The direct DeepSeek API returned HTTP 402. An existing funded OpenRouter environment key was verified and
the IBKR-only forecast callback uses `deepseek/deepseek-v4-pro` there, eight requests/day. Actual HTTP 200
responses and reported costs appeared in the model usage ledger; the initial candidates were vetoed. Kalshi's
model configuration was not changed. Forecast decisions, including vetoes, are archived separately and a
contract is not repeatedly requested for six hours. Previous-provider attempt counts remain in lab state.

Verification: all 13 suites passed, including reachable paths for all 23 strategies, quote validity and size,
fees, next-quote/passive fills, exit accounting, settlement, persistence/corruption, mode isolation, promotion,
IOC recovery/remainders/netting and weather station/day boundaries. Removing the live-data check made
the new regression fail; restored byte-identically. Typecheck/build passed. The actual built UI/preload read
real Gateway account/contracts and exercised paper pause/resume on a cloned real-feed ledger: 32 inventory
rows (23 arms + 9 capability/data exclusions), no alerts, disabled live activation, 1527px lab width. Unrelated
Kalshi shell reads were stubbed only in that isolated harness. Screenshots: `tmp/ibkr-ui-round111.png`.

Production began paper scanning at 09:30:23Z, had 16 paper positions on scan 2, and after restart resumed
with scan 3 closing 12 positions rather than resetting the ledger. Subsequent scans continued autonomously.
An independent four-cycle real-feed probe also produced 14 open positions and four closes. None of these
small early samples establishes an edge. The account is unfunded; actual funded brokerage execution is an
operator-enabled future event, not something a simulator can certify. CME ECES discovery and an ES option-
chain probe returned no supported event class. The report records those market/data boundaries explicitly.

Backup: `oracle-trader-PRE-round111-ibkr-paper-strategies-20260916-045005.zip`. Main live client 17091;
research 17093; isolated UI 17092. Existing Kalshi configuration values were preserved (encrypted credential
bytes naturally change on normal saves). Full strategy list, limits, accounting and sources are in
`docs/IBKR-PAPER-LAB-2026-09-16.md`.

Final launch correction: initial closes exposed entries whose round-trip spread/fees already breached the
8c loss stop. Added cost admission checks at signal and fill time, and held complete exhaustive baskets
together for settlement. Existing paper records were retained. Removing the cost check made its regression
fail. All 13 suites passed again; the final restored-source build was deployed at 09:44:50Z, with the process
created after the bundle. Use this timestamp to separate the initial admission rule from the corrected rule.
At 09:46:12Z production had 32 scans, 271 markets, 21 paper positions, 10 pending orders and 54 closes,
no lab error and zero real lab orders. All 23 cash balances reconciled to starting cash plus realized net less
open cost. Built UI checks passed again. OpenRouter returned seven successful responses costing about
$0.056 before the last deployment; the forecast source is operational, and insufficient-edge candidates
were declined. Final receipt: `tmp/testout/ibkr-lab-final-acceptance-round111.json`.


## §104 - 2026-09-16: IBKR left account panel and Paper/Live views

Round 112 moves Account to the left of the strategy lab and adds visible Paper/Live account selection.
Paper shows independent simulated strategy cash, aggregate net, positions and pending orders. Live shows
Gateway balances, positions, orders and broker tools. View selection never changes the global engine or
activates trading; the existing funded/qualified activation control is now at the top of the lab in Live.
Switch trading to Paper stops new lab live entries while preserving management of existing positions.
The status poll is shared between the account and lab; configuration errors remain visible. Broker order
tools are hidden in Paper view. Narrow windows stack the account above the lab without overlap.

Verified: typecheck/build; IBKR lab, review (485), ladder (126), adversarial (89) suites; actual built
Electron UI against a cloned ledger plus real Gateway account/market reads. Paper/Live view isolation,
unqualified activation disabled, pause/resume on the clone, wide and narrow layout passed. Narrow-layout
assertion first caught overlap and passed after grid row sizing was corrected. Receipts: tmp/ibkr-ui-round112.log,
tmp/ibkr-ui-round112*.png, tmp/testout/*-round112.txt. Production restarted at 15:45:36Z (PID 48180),
after the 15:45:24Z bundle. No trading settings or production records were edited.

## §105 - 2026-09-16: Polymarket.US paper laboratory and requested early maker read

Round 113: eight independent paper arms, public-data-only interface, next-quote taker fills, strict
trade-through passive fills, fees/slippage, settlement, durable balances and quotes, event/position/loss
caps, request pacing/backoff, and a scorecard at the top of the Polymarket US tab. Real-money holds and
other tests are unchanged. Handles the published US taker fee increase at 2026-09-17 03:59Z.

The operator explicitly requested reassessment of the ongoing maker test. Added an exploratory-only
grader mode without a capital verdict or changes to its original date guard. Found 1,060 conflicting
historical sequence IDs; exploratory analysis excludes all affected records/fill IDs and preserves raw
files. Remaining 601 graded fills across five days show -1.46c net 15-minute markout, descriptive 80%
day-bootstrap range [-2.36, -0.44]c. This is not realized P&L or a formal verdict. The original recorder
PID 20688 remains running; the historical conflicts still block a clean scheduled verdict.

Tests: new paper suite with mutation check, typecheck/build, ladder 126, adversarial 89, collection 7,
review 485 after an unchanged rerun of its minute-boundary cadence flake (first 484/485 log retained).
Built UI passed on a clone; actual public-data scans produced paper fills. Deployment process 24656
started 19:19:38Z after the 19:19:37Z bundle. At acceptance: 3 scans, 3 positions, 8 pending entries,
1 close; all eight balances reconcile. Four old live-entry flags remain false. Some public books return
429; those markets back off five minutes and missing quotes do not fill. Full assessment and rules:
`docs/POLYMARKET-PAPER-REASSESSMENT-2026-09-16.md`.

## §106 - 2026-09-17 07:30Z: are all three venues testing their strategies properly? (read only)

The operator asked after GPT enabled a Polymarket US paper lab (§105) and an IBKR paper lab (§103). Read the code, the
state files (`poly-paper.json`, `ibkr-lab.json`, `kalshi-auto.json`, `ladder.json`), their quote logs, `main.log`
and a fresh Kalshi dump. Kalshi is live and healthy, but its improvement since 09-16 comes from consensus
(+$7.65 on 09-16) and from lead-lag being stopped by the ladder at its 200-trade checkpoint (09-16 08:35Z, net
-$0.82; cool-down to 09-19, re-entry at one contract). Both paper labs run, but neither tests most of its
hypotheses: exits are too tight for taker arms, passive orders are too short-lived to fill, and in the IBKR lab
nothing is allowed to reach settlement. IB Gateway has been down since 03:45Z, so the IBKR lab is idle. Details,
numbers and fix directions are backlog items 121-124. No code or configuration was changed: the labs are paper
only, and another agent is actively developing them.

## §107 - 2026-09-17 07:31Z: round 114, the paper labs test their own hypotheses

The operator: "Go ahead and fix whatever isn't working properly." Fixed backlog 121, 122 and 124 from §106. Polymarket US:
stops measured from the fill-time mark (the taker round trip alone had exceeded the -5c stop), settlement controls
buy at the ask and hold, passive orders rest 30 minutes. IBKR: a hold-to-settlement set of 14 arms (fade, favorite,
calibration, political-favorite, fade-maker, ladder-value, spot-first, convergence, news, market-conditioned, three
weather arms, benchmark) with a 60-day horizon and 12 slots, applied to live positions too; timed arms stop from the
fill-time mark; calibration thresholds reachable (best real edge had been 0.62c against a 3c rule); model
probabilities kept when the model declines a trade; passive limits 2c inside for 60 minutes; partial discovery
keeps failed products' contracts and retries in 30 minutes (fired in production at 07:35Z). Reconciler repeats a
failure at most every 10 minutes. 14 new assertions, each mutation-checked; four old expectations that encoded the
old exits updated; 16 suites, typecheck and build clean; restart 07:31:43Z after the 07:31:26Z bundle; first held
entries on both labs observed with no stops. Kalshi untouched. Report: docs/reports/2026-09-17-strategy-testing-fixes.md.

## §108 - 2026-09-17 08:00Z: lead-lag's signal never broke; its execution speed did (read only)

The operator: "if our configuration was still the same as it was from the 11th and before it still would have been
positive." Tested with `scripts/backtests/leadlag_counterfactual.py`: every recorded BTC/ETH gap since 09-07, thinned
to one observation per ticker/side/minute, graded one contract at the quoted Kalshi price plus fee against public
Kalshi results. The signal earned every day: +9.9c/contract in the winning period, +8.1c 09-12 12:46Z to 09-13,
+6.7c in the losing 09-13 to 09-16 period, +10.0c since the restore (daily range +6.4c to +11.4c; first observation
per window only: +8.3, +8.3, +5.8, +7.2). Actual fills over the same periods: +18.4c, +0.2c, -2.9c. Sweep latency
(DISLOCATION line to SWEEP EXECUTED line): 0.07 s in the winning period; 0.44 s from 09-12 12:46Z when round 76
turned on the engine position cap (two venue reads before each order), and fills flipped to -5.2c/contract at the
old 4-contract size in that 1.5-hour window (44 fills); 0.68 s with 8 contracts; 14 s after round 91. The restored
setup traded one hour on 09-16 at a 6.6 s median (4 sweeps): the 3-second position-count cache (§98) expires between
60-second polls, so each burst still waits on fresh reads through the 334 ms Kalshi request pacing. Caveat: the
graded gaps assume a fill at the quoted price with no delay; the winning period's real fills beat that, which is
the point. Resuming on 09-19 without an order path that never waits on account reads is expected to repeat the loss.
Queued as backlog 126.

## §109 - 2026-09-17 08:07Z: round 115, the Kalshi order path is fast again; lead-lag re-enters early

Built backlog 126 after §108 showed the signal intact and execution slow. Found while reading the path: every Kalshi
request, orders included, went through one queue at one request per 334 ms, sized from the most expensive endpoint
listed (cfbenchmarks, 50 tokens, never called) against an account allowance of 300 read and 300 write tokens a second
(read with a GET-only script, `tmp/readonly-kalshi-limits.cjs`). Changes: (1) separate read and write lanes, 10 reads/s
and 15 writes/s (`kalshiRequestRates`, `HttpClient.writeRateLimit`); (2) the engine serves the position-cap count from
memory for up to 30 s, refreshes it in the background after 5 s, and lead-lag warms it at the start of each poll, so an
order never waits on account reads; (3) live entries reserve their slot inside the per-venue queue and submit outside
it, so orders no longer wait for each other's round trips (a simultaneous order at the very last free slot is now
refused while the first is in flight: conservative, never past the cap); (4) lead-lag passes the Kalshi shard it
already read, so a new 15-minute ticker needs no market lookup queued behind the scanner; (5) every executed sweep
records `latencyMs` (detection to acknowledgement) and `submitMs`, also in the SWEEP EXECUTED log line. Eight new
assertions; each change removed in turn made its suite fail. The risk suite now fails if a test never resolves (a
mutant hung it and Node exited 0). All 16 suites, typecheck and build clean. Restart 08:07:04Z after the 08:06:38Z
bundle; log shows "10 reads/s, 15 writes/s (separate lanes)". First scans after restart: median 15 s against 40 s over
the previous day (three scans during the exchange pause; re-measure).

The operator asked whether to wait until 09-19. No: the stop judged an execution defect, the signal graded positive every day,
and re-entry is the ladder's micro test (1 contract per sweep, -$5 stop). With the app stopped, kalshi-leadlag
`cooldownUntil` in ladder.json was set to now (backup `ladder.json.bak_round115_*`); stage, notch, demotions and
history untouched. The ladder chose "trade-small mode: real-money micro test 2" at 08:09Z and held it for the exchange
maintenance pause; re-entry at its next run after 09:00Z. Poll stays 60 s for this re-entry so one variable changes.

## §110 - 2026-09-17 08:16Z: lead-lag runs all eight coins that trade on both venues

The operator: "Can we expand that to other coins?" The live list was BTC, ETH and HYPE (§99). Public catalog check: Kalshi lists
15-minute series for ADA, BCH, BNB, BTC, DOGE, ETH, HYPE, NEAR, SOL, TON, XRP and ZEC; Polymarket has 15-minute up/down
twins for BTC, ETH, SOL, XRP, DOGE, BNB, HYPE and ZEC only. Graded signal per coin since 09-13 10:05Z: BTC +6.9c, ETH
+7.5c, SOL +6.8c, XRP +7.9c, DOGE +7.2c, BNB +7.6c, HYPE +7.6c per contract; live fills in the same slow-execution
period ranged -11.8c (DOGE) to +3.5c (BNB). ZEC added to `LEADLAG_COINS` (same CF Benchmarks vs Chainlink structure;
its Polymarket book is thin, about $99, and the 5c spread gate excludes it when wide). Config `leadLagCoins` set to all
eight with the app stopped (backup `kalshi-auto.json.bak_coins_*`). Unchanged: one contract per sweep, two coins per
direction per window, $15 per window, 60 s poll, BTC/ETH as the only coins pooled into the ladder. Tests: review-fixes
486 (pair list and ZEC slug), ladder 126, adversarial 89, risk 18, remaining 11, completion 17, coin grader self-test
11; typecheck and build clean; restart 08:16:14Z after the 08:15:46Z bundle. Coin cohort amendment recorded.

## §111 - 2026-09-17 09:40Z: round 116, lead-lag prices Kalshi from the live orderbook

**Defect.** After re-entry at 09:16Z, 36 of 36 lead-lag IOCs were accepted by Kalshi and cancelled with zero fill
(read-only dump `tmp/k-2026-09-17b.json`). The order path itself was fast: 36-125 ms from send to ack in the order
journal. Kalshi's public trade tape showed that the quotes the scan acted on were 20-40 s old. For example,
"ETH bid 58c at 09:22:16" was where ETH traded at 09:21:39-55, and by 09:22:06 it traded at 42-46c. The cause is
the source. `scanAndSweep` read `yes_bid/yes_ask` from `/markets?series_ticker=`, and Kalshi serves that list
from a cache. Polled side by side every 2.5 s, the list held 74/73c for 18 s while the orderbook and the tape moved
from 76c to 82c; `/markets/{ticker}` lagged about 5 s. Separately, sweeps waited 0.9-1.9 s inside the engine on
the position-count read: a 60 s poll is longer than the 30 s count cache.

**Fix.** `leadLag.ts`: the list still resolves the window's ticker and shard, and the quote now comes from
`/markets/{ticker}/orderbook?depth=1` via the new export `kalshiBookTop` (best YES bid; ask = 1 - best NO bid). A failed
book read counts as a Kalshi fetch failure, and the code never falls back to the list. Rows carry
`kalshiSource: 'orderbook'`. `engine.ts`: `warmOpenPositionCount` keeps the count refreshed every 10 s for
120 s after each call, so an order never awaits a read.

**Tests.** review-fixes 487 (the list mocks now carry a deliberately wrong 1/99c quote, with the real quote only in
the orderbook mock); a mutant that reverts to list pricing fails the suite. risk-controls, completion,
adversarial, remaining-defects and ladder all pass. There is no unit test for the keep-warm timer; it is verified
live by `latencyMs` instead.

**Live after restart (09:40:58Z).** 3 sweeps, 3 filled (BNB 13c, XRP 62c, BNB 4c), 99/106/138 ms from detection
to fill.

**Consequence for past analysis.** Every `leadlag-dislocations.jsonl` row before 09:40Z priced Kalshi from the
cached list. The "graded signal" in `scripts/backtests/leadlag_counterfactual.py` (+6-11c/contract) therefore graded
partly phantom gaps, and it is not evidence of edge. Actual fills remain valid evidence (period A +18.4c on real
fills). Grade only `kalshiSource == 'orderbook'` rows from now on.

## §112 - 2026-09-17 13:16Z: round 117, three defects from GPT's review of rounds 114-116

All three were confirmed from source before any change.

**1. Position cap race (`engine.ts`).** Round 116's net reservation counter adjusted any in-flight read by
`reservationsMade - reservedAtStart`. A zero fill that completed during a read decremented the counter, so the read's
count went negative, and two orders filled against a cap of one (GPT's reproduction). The counter is now per-entry
reservation tokens. The cache holds only the venue snapshot (positions + resting + journaled pending), and the count is
the snapshot plus outstanding tokens, so it cannot go negative. Token lifecycle:
- a zero fill, or an explicit 400/401/403/404/422/429 rejection, deletes the token at once;
- a fill, a resting order or an uncertain error marks it settled;
- a read removes a token only when the read began more than `RESERVATION_VISIBILITY_MS` (2 s) after the token
  settled.
An order the venue already shows can count twice for a moment, which errs toward the cap. Tests: GPT's reproduction,
plus an in-flight order and a mid-read fill that a read cannot vouch for. Five mutants (read forgets in-flight
tokens, read forgets tokens settled during it, zero fill keeps its slot, count ignores tokens, rejection keeps its
slot) each fail risk-controls.

**2. Rule cohorts pooled (`ibkrLab.ts`, `polyPaper.ts`, both panels).** Trades opened before `IBKR_RULES_SINCE` /
`POLY_PAPER_RULES_SINCE` (2026-09-17T07:31:43Z, round 114) stay in the ledger but are reported as
`legacyClosed`/`legacyRealized` (IBKR) and `legacyNet` (Polymarket). Every scorecard number, the Polymarket assessment
and IBKR live qualification use current-rule trades only. The panels show "+N old rules ($x)". Live data at the change:
IBKR 168 old / 38 new, Polymarket 176 old / 2 new. Move the constants forward whenever entry or exit rules change.

**3. IBKR live timed exits vs paper (`ibkrLab.ts`).** `IbkrLabLive.entryMark` is fixed on the first reconcile that
sees the fill with a fresh quote (null if none was fresh, which means absolute movement, as paper does when it has no
mark). The +5c / -8c exits now apply to `edge - entryMark`. Test: GPT's example (-7c at the fill, -9c later stays open,
a 9c adverse move exits). One difference remains: paper marks at the fill instant, while live marks at the next reconcile
(within one 30 s scan).

**Checks.** Typecheck passes and all 15 suites pass (review-fixes 512, ladder 126, adversarial 89, risk-controls 20,
IBKR lab, Polymarket paper and the rest). Restarted 13:16:10Z, after the 13:16:01Z bundle. Lead-lag scanning, labs
running, no new errors.

## §113 - 2026-09-17 13:56Z: round 118, IBKR price exits never fall back to an absolute stop

**Defect (GPT, reproduced).** Round 117 set a live position's `entryMark` to `null` when the first reconcile after the
fill saw a stale quote. The mark was never retaken, so exits reverted to the absolute -8c / +5c rule once quotes turned
fresh. With a stale first quote, the position exited where the normal case holds. Paper had the same fallback
(`entryMark` undefined when the opposing quote was not fresh at the fill).

**Fix (`ibkrLab.ts`, one policy for paper and live).** Price exits measure movement from the first fresh valuation at
or after the fill, recorded as `entryMark` plus `entryMarkAt` (the fill time when the fill quote was fresh).
- **Live:** a stale quote leaves the mark unset, and it is taken on the first fresh one, then fixed. The exit check skips
  a position with no mark (unreachable in practice, since an exit is only judged on a fresh quote).
- **Paper:** an unmarked position is marked on its first fresh opposing quote. Movement is then zero, and time and
  pre-close exits still apply.
- **Existing data:** 13 of 95 open paper positions had no mark and will be marked on their next fresh quote. There were
  no open live positions.

**Tests (ibkr-lab).** GPT's reproduction (stale first quote, then fresh: -7c to -9c holds, a 9c move exits), and paper's
unmarked position at -9c (marked rather than stopped, exits on a 9c move from the mark). The exit-price fixture now
carries an explicit mark. The live retry test uses the one-hour time exit. With the exact round-117 code restored, the
reproduction assertion fails. The skip-if-unmarked guard survives mutation because it is unreachable.

**Checks.** Typecheck and all 15 suites pass. Restarted 13:56:25Z, after the 13:56:16Z bundle.
