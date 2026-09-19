# Oracle Trader - bug and correctness audit, 2026-09-19

Produced by a 281-agent workflow: 13 subsystem finders and an invariants prover, three adversarial refuters per finding (code-path, semantics, reproduction; a finding survives only when at least two uphold it), a second-pass boundary sweep, one synthesizer. Read-only: no tracked file was modified. Counts: 79 raw findings, 78 unique, 76 upheld, 2 refuted; second pass 10 raw, 10 upheld.

---

# Oracle Trader — Final Engineering Report (adversarial correctness audit)

Scope: `G:\PROJECTS\oracle-trader` at commit `978dbd1` (2026-09-19 06:35 -0400). Every `file:line` below was re-read in that tree before citation; the line numbers in the source material that had drifted were corrected. Live state (`%APPDATA%\oracle-trader`, read only, 2026-09-19 ~13:20Z): `executionMode: live`, `riskLimits {maxStakePerBet: 10, maxOpenPositions: 80}`; Kalshi trader `enabled/autoPoll/liveArmed: true`, `amountPerTrade 1`, `maxOpenPositions 60`, `fadeEntryMode maker`, `dutchLiveEnabled/convergenceLiveEnabled/leadLagLiveEnabled/sportsAnchorLiveEnabled/consensusEnabled: true`, 26 open trades (12 consensus, 14 fade; 25 fractional), 3 resting fade orders; order journal 2,178 unique rows (2,164 acknowledged, 14 rejected, 0 pending, 0 `ot-` ids); Polymarket US mini: every strategy flag off, 0/0; IBKR lab: paper, no live strategies. 86 verifier-upheld items were merged into 59 findings (1 critical, 8 high, 24 medium, 26 low).

## 1. Executive summary

The order-submission path itself is in good shape: POSTs are never auto-retried (`http.ts:80`), every Kalshi/Polymarket US/IBKR submission is journaled before it leaves the process (`engine.ts:297-315`), and concurrent entries cannot share the last cap slot. The defects that survived adversarial verification are almost all in what happens around the order: local position bookkeeping that can drop or resurrect real positions, guards whose inputs can silently degrade to "nothing held", and operator/ladder writes that overwrite each other. No finding places an order at the wrong venue or on the wrong side by itself.

Counts after merging duplicates: 1 critical, 8 high, 24 medium, 26 low. Fifty of the 59 are `verified` (established directly in code or by deterministic reproduction), 7 `likely`, 2 `hypothesis`.

Unintended live orders: yes, via three routes. The "Reset state" buttons (B-01) cancel every real resting order and forget every real position in live mode with no confirmation; the panel's stale full-config write (B-08) can re-enable an arm the ladder just stopped, at its pre-stop size; and a lost order response or a crash before the end-of-scan persist (B-05, B-09) leaves a real order/position outside every ledger while the entry guard lets the same market be bought again.

Restart handling is not safe. `closeTrade` and the Polymarket mini persist a booked exit while the trade is still in `openTrades` (B-03); this resurrected closed trades three times in production (09-07, 09-09 x2) and can settle a trade twice. `pendingOrders` is persisted only at scan end (B-05), the churn guard lives in memory (B-12), a quarantined `kalshi-auto.json` comes back with `DEFAULT_CONFIG` and migrations 2-20 skipped (B-13), and most state writers are unflushed with loaders that overwrite a corrupt file (B-31).

Order/fill reconciliation: the venue-fill archive and `recordMany` dedupe are sound (no double-booked fill was found). The gaps are in adoption: a journal row the reconciler recovers only updates the journal (B-09); an order the venue never created is unrecoverable and blocks that market's exits forever (B-04); an ambiguous exit that filled is never booked (B-25); and the archive labels half of all Kalshi fills with the wrong side (B-23, already logged as audit item D5).

Risk controls are bypassable: `KalshiAdapter.getPositions` never rejects (B-02), so the engine cap's "fails CLOSED" branch, `reconcileLedgerWithVenue`'s glitch guard, `trySettle`'s unreachable-means-unknown rule and the boot-reconcile gate all see an empty or partial venue instead of an error; a failed balance read silences the kill switch and the equity cap for that scan (B-10); the engine cap releases its reservation for every Polymarket US and IBKR order, and for Kalshi rests too, because no adapter reports `venueStatus === 'resting'` (B-14).

The component I trust least is the Kalshi-side local ledger reconciliation (`autoTrader.ts` `reconcileLedgerWithVenue`/`trySettle`/`orphanSweep` over `KalshiAdapter.getPositions`): it is the only thing that manages exits and grades results for 26 real positions, it can delete a held position after 15 minutes of read failures, it cannot re-adopt a position it lost, and it keys Dutch baskets by an identifier the venue never reports (B-06).

The metrics that drive automation are contaminated in several places: the ladder's evidence counters skip checkpoints after every evidence restart (B-19), the consensus arm's 12 void positions will settle into the restarted cohort (B-20), Kalshi arms are judged on an equal-per-trade mean while the doctrine and both labs use contract weighting (B-21), and the quoter's stage evidence is the whole weather ledger (B-22).

Two things were documented as fixed today and are not: the §129 `closeFrom` fix does not cover `placeOrderChecked`'s ledger write (B-35), and the §127 fractional-contract fee fix never reaches `entryFeeDollars`/`netCentsOf` (B-34). One documented "fails closed" fix (REVIEW-CHANGES:145) is defeated by the adapter it depends on (B-02).

## 2. Findings

ID: B-01
Title: "Reset state" / "Reset" IPC handlers are not gated on execution mode and have no confirmation; in live mode one click cancels every real resting order and drops every tracked live position
Area: Electron IPC / live-trading safety
Severity: critical
Confidence: verified
Location: `src/main/index.ts:209`, `:223` (unguarded) vs `:363-368` (guarded paper reset); `src/main/strategies/autoTrader.ts:1116-1147`, `:4784-4796`; `src/main/strategies/miniAuto.ts` reset (same shape); `src/renderer/src/AutoTraderPanel.tsx:121-126`, `:509-511`; `src/renderer/src/MiniAutoPanel.tsx:58-63`, `:300-302`

Claim: `IPC.autoTraderReset` and `IPC.autoMiniReset` call `reset()` regardless of execution mode and the panel buttons fire them without a confirm, while the settings "Reset everything (paper)" handler refuses in live mode precisely because the same `reset()` cancels real orders and forgets real positions.

Evidence: `index.ts:209` `ipcMain.handle(IPC.autoTraderReset, () => autoTrader.reset())`; `:223` `ipcMain.handle(IPC.autoMiniReset, (_e, venue) => requireMini(venue).reset())`. Contrast `:364-368`: `// The traders' reset() cancels every resting order and drops every tracked position. In live mode those are REAL. The button says paper.` followed by `if (engine.getExecutionMode() === 'live') throw new Error('Reset is paper-only...')`. `autoTrader.ts:1131-1133` `for (const p of this.state.pendingOrders) { adapter?.cancelOrder(p.orderId).catch(() => undefined) }` then `:1134` `const fresh = defaultState()` and `:1141` `this.state = fresh`; `defaultState()` (`:4784-4796`) has `openTrades: [], pendingOrders: [], daily: {count: 0}, dailyPnl: {realized: 0, tripped: false}, perfByStrategy: {}`. `AutoTraderPanel.tsx:509` `<button className="ghost" onClick={reset}>Reset state</button>` with `reset()` at `:121-126` calling `window.api.autoTrader.reset()` directly; the LIVE-arm checkbox two hundred lines earlier does use `window.confirm` (`:241`).

Execution path: operator clicks "Reset state" -> `IPC.autoTraderReset` -> `AutoTrader.reset()` -> `doReset()` (deferred to the next tick boundary if a scan is busy, `:1120-1123`) -> `cancelOrder` x3 (unawaited, real) -> `state = defaultState()` -> next tick: `manageExits`/`trySettle` iterate an empty `openTrades` (`:3709-3716`), `entryBlocked` (`:2805-2815`) counts 0 open, `orphanSweep` (`:3507-3517`) only alerts.

Failure scenario: today's state (live, 26 open trades, 3 resting fade orders, `dailyPnl.realized -4.36`). T0: click. T1: the 3 resting Kalshi orders are cancelled at the venue; 26 positions vanish from the ledger; `daily.count` returns to 0 (up to `maxDailyTrades 200` further entries allowed); `dailyPnl.tripped` is cleared. T2 (next scan): fade re-qualifies a strike already held -> `market already open` (`:2814`) does not fire -> second real position on one market; consensus event caps blind. T3: the 26 forgotten positions ride to settlement with no stop-loss, no pre-close exit, no grading; `venueDay` is also wiped, so `venueLedgerStale()` (`:4547-4551`) blocks entries only until the next `refreshVenueDay` (`:1757`, next tick).

Actual consequence: authoritative local position state for real money discarded by one unconfirmed click; caps and exits blind for 26 positions until they settle; the daily trade counter and local kill latch reset. The venue-side kill leg self-heals (`dayRealizedForKill` `:4554-4563` takes the worse of venue/local once `venueDay` is refetched), the daily-count cap does not.

Existing protection: `reset()` defers while a scan is busy; `bookStats`/`calib` survive (`:1139-1140`); orphan sweep alerts once per untracked position; the engine's own cap (80) still reads venue positions.

Cheapest confirmation test: with `engine.setExecutionMode('live')`, a stub adapter recording `cancelOrder`, `state.pendingOrders=[{orderId:'o1'}]`, `state.openTrades=[t1]`, `state.daily.count=58`, `state.dailyPnl.tripped=true`: call `reset()`; today `cancelOrder('o1')` is called and `getStatus()` shows `openTrades=[]`, `dailyTrades=0`, `killSwitchTripped=false`; `IPC.settingsResetPaper` throws in the same state.

ID: B-02
Title: `KalshiAdapter.getPositions` never rejects: an unreadable positions feed reads as "no positions", defeating the engine cap's fail-closed branch, the ledger reconcile's glitch guard, `trySettle`'s stale-trade rule and the live boot gate
Area: `venues/kalshi.ts` + engine position cap + `autoTrader` venue reconciliation
Severity: high
Confidence: verified
Location: `src/main/venues/kalshi.ts:815-866` (catches at `:832-836`, `:838-845`); `src/main/engine/engine.ts:796-801`, `:810`; `src/main/strategies/autoTrader.ts:3990-3995`, `:3999-4008`, `:3895-3898`, `:3500-3505`, `:2782`

Claim: every HTTP failure of the unscoped and per-shard `/portfolio/positions` reads is swallowed and `getPositions()` resolves with whatever merged (an empty array under a full outage, a partial set under a shard failure), so four callers that treat "read failed" as "unknown" instead see a successful read of nothing.

Evidence: `kalshi.ts:832-836` `try { const d = await this.authGet<...>('/portfolio/positions?limit=200') ... } catch (err) { console.warn('[kalshi] positions (default) failed:', ...) }`; `:838-845` `for (const shard of shards) { try { ... } catch { // a shard the account does not have ... contributes nothing } }` — the only throw in the function is `requireAuth()` (`:816`). Consumers: `engine.ts:797-801` `try { positions = (await adapter.getPositions()).length } catch (err) { throw new Error('Position cap check failed ...') }` (dead branch; `:757-758` comment "Fails CLOSED"); `autoTrader.ts:3993-3995` `try { held = new Set((await adapter.getPositions()).map(...)) } catch { return }` (comment `:3984` "A failed positions call counts for nothing"); `:3895-3896` `const held = await adapter.getPositions().catch(() => null); if (held === null) return`; `:3500-3505` `try { positions = await adapter.getPositions() } catch { fetchedClean = false } if (fetchedClean) this.reconciledLive = true`. `main.log` 2026-08-28..09-19: 2 `positions (default) failed` lines (2026-09-03 503 `authentication_error`, 2026-09-04 500) and 0 `Position cap check failed` lines. REVIEW-CHANGES-2026-09-06.md:145 records this class as fixed by "`countOpenPositions` fails closed" — the fix is defeated one layer down.

Execution path: (a) 5-min `reconcileTimer` (`:4657-4659`) -> `reconcileLedgerWithVenue` -> `getPositions` (auth 5xx/429 after `http.ts` 3 GET retries, `:61-62`) -> `[]` -> `held = {}` -> every trade older than 10 min misses -> third miss -> `getMarket` (public, succeeds, unresolved) -> `removeTrade` + `orphan-ledger` (`:4003-4007`). (b) `manageExits` -> `trySettle` (3 h past close, unresolved) -> `getPositions` `[]` not `null` -> `removeTrade` (`:3897-3898`). (c) `placeLiveOrderReserved` -> `countOpenPositions` -> `readOpenPositionCountNow`: `positions = 0`, `base = 0 + resting + pending` cached 30 s (`:810`). (d) first tick after restart -> `orphanSweep` -> `reconciledLive = true` on a partial view -> `entryBlocked` `:2782` no longer holds entries.

Failure scenario: T0 auth layer returns 503 (as on 2026-09-03) or shard 3 (MLB) returns 5xx while the unscoped read succeeds (the unscoped read omits shard 3, `:817-820` comment). T0+5/10/15 min: three reconcile runs see the 12 consensus and 14 fade trades (all >10 min old) absent -> all 26 removed, 26 `orphan-ledger` rows, no `recordExit`/`gradeEntry`. T0+16 min: `market already open`/`event already exposed` no longer see them -> fade re-buys held strikes ($1 each). Cap variant: with 78 venue positions and cap 80, a 15-s positions outage makes `base = 0 + resting`, every entry in the window passes.

Actual consequence: loss of the only ledger that manages exits and grades results for every live Kalshi position under a plausible 15-minute read outage (money stays at the venue; stops/pre-close exits stop; settlement P&L and calibration never book; duplicate $1 entries on held markets); the engine cap under-counts for up to 30 s per failed read; the boot gate clears on a partial view. The three `ledger trade not held` drops in `main.log` (09-07, 09-09 x2) were correct drops (B-03) — the guard cannot distinguish that case from an outage.

Existing protection: `getOpenOrders` (`:890-918`) still throws, so the open-orders half fails closed; GET retries 3x; the 3-miss rule needs ~15 min of consecutive failures; `venueLedgerStale()` blocks new entries only if the settlements feed also fails; no read-failure telemetry beyond one warn line.

Cheapest confirmation test: `const a:any = new KalshiAdapter(); a.requireAuth=()=>{}; a.authGet=async()=>{throw new HttpError(503,'x')}; assert.deepEqual(await a.getPositions(), [])` (reproduced by the finders). Then stub `getPositions -> []` three times with one >10-min-old open trade and `getMarket -> unresolved`; `openTrades` shrinks; the fix test is the inverse (rejection -> trade retained, cap check throws).

ID: B-03
Title: Full exits and settlements persist the booked P&L before the trade is removed; a restart inside the window resurrects the closed trade (3 production occurrences) and can settle it a second time — same defect in the Polymarket mini
Area: exits -> persisted state -> settlement (Kalshi `closeTrade`; mini settlement and sale paths)
Severity: high
Confidence: verified
Location: `src/main/strategies/autoTrader.ts:3796-3797`, `:4428-4490` (persist at `:4483`), `:3966-3970`, `:1453`/`:1465`, `:1154-1170`; compare the safe order at `:3845-3846`, `:3864-3866`, `:3877-3879`; `src/main/strategies/miniAuto.ts:1170-1171`, `:1272-1273`, `:1296-1298`, `:1324-1368` (persist at `:1368`), `:1371-1374`

Claim: `recordExit` mutates perf/dailyPnl and calls `persist()` while the trade is still in `openTrades`; `removeTrade` only mutates memory and nothing persists again until the end of the scan, so a process exit in between reloads a closed trade as open with its P&L already booked.

Evidence: `autoTrader.ts:3796-3797` `this.recordExit(pnl, t.perfKey ?? t.strategy, t)` then `this.removeTrade(t.id)`; `:4482-4483` `this.state.dailyPnl.realized += pnl; this.persist()` (the `graded: true` flag is set after the persist, `:4486-4488`); `:3966-3970` `removeTrade` filters the array and calls no persist; the next persist is `:1453` (end of tick) or `:1465` (catch); `stop()` (`:1154-1170`) clears timers only. `trySettle` does it safely: `this.removeTrade(t.id)` precedes `this.recordExit(...)` at `:3845-3846`, `:3865-3866`, `:3878-3879`. The mini does it unsafely in all three paths: `miniAuto.ts:1170-1171`, `:1272-1273`, `:1296-1298` (`recordExit` then `removeTrade`; persist at `:1368`; `removeTrade` `:1371-1374` no persist; tick persist `:957`). Production (episodes + `main.log`): 09-07 `exit` 17:48:13.637Z pnl +0.11 on KXMLBGAME-26SEP071335LAABOS-BOS -> `[main] Manifold connected` 17:48:34.340Z -> `orphan-ledger` 18:19:10.575Z (shares 4.62, ageMin 35); 09-09 exit 09:13:03Z (pnl -1.44) -> restart 09:13:08Z -> drop 09:38:03Z; exit 11:07:28Z (pnl -0.24) -> restart 11:07:55Z -> drop 11:27:10Z. `main.log` shows 343 boots in 22 days (~15/day).

Execution path: tick -> `manageExits` -> `closeTrade` (full fill) -> `recordExit` (persist with trade present) -> `removeTrade` (memory) -> process exit before `:1453` -> constructor loads the trade as open -> `manageExits` quotes it and `entryBlocked` counts it -> either `reconcileLedgerWithVenue` drops it after 3 misses (observed) or, if the market resolves first, `trySettle` -> `gradeEntry` + `recordExit` again (`:4004` skips the drop for resolved markets, so nothing prevents this variant).

Failure scenario: T0 pre-close exit sells 4.62 YES @0.69 (entry 0.65): +$0.11 booked, file written with the trade listed. T0+20 s maintenance restart. T0+30 s boot: trade open. T0+35 min market resolves YES (grace 30 min) -> `realized = (1-0.65)*4.62 - fee = +$1.58` booked again, graded again; `perfByStrategy`/`dailyPnl` inflated; losing variant: a phantom -$3 settlement feeds `dayRealizedForKill`.

Actual consequence: observed: closed trades resurrected and dropped as orphans 20-35 min later (blocking re-entry, consuming caps); deterministic-but-unobserved: double-counted settlement P&L and calibration grades feeding the ladder's stop/scale-up and the kill switch's local leg.

Existing protection: `reconcileLedgerWithVenue` drops an unheld, unresolved trade after >=15 min; nothing reverses the first booking; the venue settlement ledger governs the kill switch when it is worse than local.

Cheapest confirmation test: stub engine whose `sellPosition` returns a full fill, `JsonStore` on a temp file; call `manageExits` with a take-profit quote; before any further tick read the file: `openTrades` still lists the trade while `perf.realizedPnl` includes the exit. Construct a second `AutoTrader` from that file and run `trySettle` with `getMarket -> resolution 'yes'`: `perf.trades` increments again.

ID: B-04
Title: An uncertain submission the venue never created becomes a permanent pending journal row: it blocks every later buy AND sell (including the stop-loss) on that market, counts against the position cap forever, and IBKR's multi-round-trip `prepare()` widens the pre-submission window to seconds
Area: order journal / `reconcileOrders` / restart recovery
Severity: high
Confidence: verified
Location: `src/main/engine/engine.ts:297-315`, `:88-101`, `:810`; `src/main/store/orderJournal.ts:34-44`; `src/main/venues/kalshi.ts:1055`, `:1109`, `:928-945`; `src/main/strategies/autoTrader.ts:3800-3811`; `src/main/venues/ibkrAdapter.ts:78-108`; `src/main/venues/ibkr.ts:175-176`; `src/main/strategies/ibkrLab.ts:45`, `:268-274`

Claim: a POST that fails with 5xx/timeout/reset after `onSubmit`, or a crash between `journal.begin` and the socket write, leaves the row `pending`; `reconcileOrders` can only move a row to `acknowledged` when the venue lists the client id, so an order the venue never accepted is never resolved, and `journal.begin` refuses both sides on that market indefinitely.

Evidence: `engine.ts:311` `if (intent && (!submitted || (e instanceof HttpError && [400, 401, 403, 404, 422, 429].includes(e.status)))) this.journal!.update(intent, { state: 'rejected' })` — 5xx/AbortError/ECONNRESET after `onSubmit` stay `pending`; `orderJournal.ts:39` `if (this.pending(input.venue).some(r => r.marketId === input.marketId)) throw new Error('Unresolved submission on ...')` blocks buys and sells; `engine.ts:96-98` only writes `acknowledged`; no code writes `rejected` elsewhere; `:810` `base = positions + resting + this.journal.pending(venue).length`. `kalshi.ts:1055`/`:1109` call `onSubmit()` immediately before `authPost`. `autoTrader.ts:3803-3809`: only `/no (paper )?position/i` removes the trade; anything else sets `exitAttempts` and returns false, so the stop-loss retries every scan into the journal block. Polymarket US has no `findOrderByClientId` at all (`grep`: 0 hits), so `reconcileOrders` returns at `:90` and every ambiguous polyus row is permanent. IBKR: `ibkrAdapter.ts:78-108` runs `resolve`, `getAccount`, whatIf `submit`, `getAccount` (four Gateway sessions, 25 s ceiling each) before `ibkr.ts:175-176` `beforeSubmit?.(); ib.placeOrder(...)`; `ibkrLab.ts:274` `else continue` keeps the lab record `uncertain`. Handbook §16 Sept-15 note (1166-1170): "unknown submitted orders remain reserved until positively identified ... Do not manually discard unknown rows" — it does not say exits are blocked, and identification is impossible for a never-created order. Journal today: 0 pending, so the path has not fired in the r3 era; `main.log` has 18 `POST ... 503` in one minute on 2026-09-03 (pre-journal).

Execution path: `manageExits` -> `sellPosition` -> `submitLive` -> `journal.begin` -> adapter `onSubmit` -> POST 503 -> catch leaves `pending` -> `closeTrade` catch -> next scan `journal.begin` throws `Unresolved submission` -> repeats until settlement; `FillReconciler.run` (5 min) -> `reconcileOrders` -> `findOrderByClientId` pages `/portfolio/orders` and `/historical/orders` -> undefined -> row untouched.

Failure scenario: T0 fade holds NO at 92c, stop-loss fires, sell IOC POST returns 503 (venue never created the order). T1 every scan: exit refused, `exitAttempts++`. T2 every 5 min: recovery finds nothing. Outcome: the position settles at 0 (full stake) instead of the stop; base cap count +1 for the life of the journal; a repeat of the 09-03 burst strands 18 markets. Second trigger: kill between `journal.begin` (`engine.ts:300`) and `onSubmit` — provably unsent (`submittedAt` undefined; nothing reads that field) — same permanent outcome; on IBKR the window is several seconds per order.

Actual consequence: the stop-loss/exit for that position is defeated for its whole life (bounded by position size, $1-$4 today); N stranded rows consume N of the 80 cap slots and block N markets; no log, alert or UI surfaces stuck rows (`[orders]` logs recoveries only).

Existing protection: deliberate fail-closed policy; recovery works for rows the venue did create (Kalshi and IBKR open/filled orders); 15-minute markets expire; `trySettle` still books the settled outcome.

Cheapest confirmation test: extend `scripts/tests/remaining-defects.test.ts` "unknown buy persists" with `findOrderByClientId -> undefined`: after reconciler runs at +61 s, +6 min, +1 h assert `pending().length === 1`, `engine.sellPosition` on that market rejects `/Unresolved/`, and an entry with `maxOpenPositions = venue positions + 1` is refused; also a row written with no `submittedAt` (adapter throws before calling `onSubmit`, then reload the journal) still blocks the market.

ID: B-05
Title: `orphanSweep`'s cancel of untracked resting orders is dead since the order journal replaced `ot-` client ids with UUIDs: a resting maker order whose response was lost, or placed just before a crash, stays resting untracked, can fill, and the market can be entered again
Area: restart recovery / lost-acknowledgement handling
Severity: high
Confidence: verified
Location: `src/main/strategies/autoTrader.ts:3492`, `:3151-3156`, `:3186` vs `:1453`, `:2814-2815`, `:3507-3517`; `src/main/engine/engine.ts:81`, `:299-302`, `:88-101`; `src/main/store/orderJournal.ts:40`; `src/main/venues/kalshi.ts:1018`, `:1528-1530`; `src/main/index.ts:392`; `src/main/util/http.ts:80`, `:98`

Claim: every Kalshi order now carries the journal's `randomUUID()` as `client_order_id`, so `o.clientOrderId?.startsWith('ot-')` is never true and no untracked resting order is ever cancelled; journal recovery only flips the row to `acknowledged`, nothing re-adopts the order into `pendingOrders`, and `entryBlocked` consults only the local ledger.

Evidence: `orderJournal.ts:40` `clientOrderId: randomUUID()`; `engine.ts:299-302` `journaled = order.venue === 'kalshi' || ...`; `request = { ...order, clientOrderId: intent?.clientOrderId ?? order.clientOrderId, ...}`; the journal is always constructed (`index.ts:392` passes `paperStateDir`; `engine.ts:81`); `kalshi.ts:1018` `client_order_id: order.clientOrderId ?? genId()` so `genId()`'s `ot-` prefix (`:1528-1530`) is unreachable. Every sub-engine also routes through `engine.routedAdapter` (`autoTrader.ts:4045`, `:4058`, `:4076`, `:4093` -> `engine.ts:684` `routed.placeOrder = (order) => this.placeOrder(...)`), so there is no producer of `ot-` ids in the running app; the journal holds 0 `ot-` ids in 2,178 rows and `main.log` has 0 `orphan order canceled` lines since 08-28. `autoTrader.ts:3492` `if (o.clientOrderId?.startsWith('ot-') && !this.state.pendingOrders.some(...) && !this.quoter.ownsOrder(o.orderId)) { await adapter.cancelOrder(o.orderId)...`. Loss paths: `http.ts:98` 45-s POST timeout, never retried (`:80`); `:3155-3156` `if (!/post.?only|would.?cross|cross|self.?trade/i.test(msg)) throw err` so `:3186` `pendingOrders.push` never runs; or a kill between `:3186` and the end-of-tick persist `:1453`. Handbook:532 still says the sweep "cancels untracked `ot-` orders".

Execution path: `executeMakerEntry` -> `engine.placeOrder` -> `submitLive` (UUID) -> venue accepts post-only GTC -> response lost / crash before persist -> restart or next scan: `pendingOrders` lacks it -> `orphanSweep` lists it, prefix test false -> not cancelled -> +5 min `reconcileOrders` marks the journal row `acknowledged` (`:96-98`, journal only) -> `journal.begin` no longer blocks the market -> `entryBlocked` `:2814-2815` sees no `openTrades`/`pendingOrders` row -> second entry -> the first order rests to `expirationTs` and fills -> `orphanSweep` alerts "untracked position ... Not auto-managed" (`:3510-3517`).

Failure scenario: T0 10:49Z fade rests NO on KXHIGHNY-26SEP20-T80 (expiration ~13 min before close, hours away); fetch aborts at 45 s though Kalshi created O1. T0+5 min: journal acknowledged; T0+6 min: sweep skips O1; T0+7 min: same signal recomputed, second post-only O2 rests; later both fill: venue holds 2x the intended NO size, only O2 in the ledger; O1's contracts settle outside every exit rule and evidence.

Actual consequence: duplicate real-money exposure on one market (2 x $1 today) and an untracked live position per lost-response/crash event; a documented safety mechanism that does not exist. Before 09-15 the same order was cancelled.

Existing protection: resting orders carry `expiration_time` and `cancel_order_on_pause`; the journal's pending row blocks re-entry for ~60 s-5 min until recovery; one-time untracked-position alert; the venue-fill archive records the fill; the engine cap counts the resting order via `getOpenOrders`.

Cheapest confirmation test: `AutoTrader` in live mode, empty ledger, stub `getOpenOrders -> [{orderId:'X', clientOrderId: randomUUID(), marketId:'M'}]`, `getPositions -> []`, spy `cancelOrder`; call `orphanSweep()`: `cancelOrder` is not called; with `clientOrderId:'ot-1'` it is.

ID: B-06
Title: Live Dutch baskets are stored with `marketId` = EVENT ticker while the venue reports positions by MARKET ticker, so the venue reconcile drops every basket 10-25 minutes after entry and its legs become untracked
Area: dutch legs -> openTrades -> reconciliation -> settlement
Severity: high
Confidence: verified
Location: `src/main/strategies/autoTrader.ts:2563`, `:2570`, `:3596-3608`, `:3999-4007`, `:3823-3848`, `:2814`, `:2819`; `src/main/venues/kalshi.ts:851-857`

Claim: `reconcileLedgerWithVenue` tests `held.has(t.marketId)` where `t.marketId` is the event ticker and `held` holds market tickers; it never consults `t.legs`, so after three misses it calls `getMarket(eventTicker)`, which fails, and removes the basket without `recordExit`.

Evidence: `autoTrader.ts:2563` `marketId: e.eventTicker,` (`groupLegs` at `:2570` carry the legs); `:3597-3608` `this.state.openTrades.push({ id: sig.id, marketId: sig.marketId, ..., legs: entries })`; `kalshi.ts:851-857` maps `marketId: p.ticker`; `:3999` `if (held.has(t.marketId) || pending.has(t.marketId) || now - t.createdAt < 10 * 60_000) continue`; `:4003-4007` `const mk = await adapter.getMarket(t.marketId).catch(() => undefined); if (mk?.resolved || mk?.resolution !== undefined) continue; ... this.removeTrade(t.id)`. `orphanSweep` (`:3507`) does check `t.legs?.some(...)`; the reconcile does not. `trySettle`'s dutch branch (`:3823-3848`) runs only over `openTrades`. Live: `dutchEnabled`/`dutchLiveEnabled` true, `liveArmed` true; `kalshi-dutch` tiny-live since 09-06; no `dutch` key in `perfByStrategy` (the arm has not filled yet).

Execution path: tick -> `dutchSignals` -> `executeDutch` (N IOC NO legs filled) -> `openTrades[{marketId: eventTicker, legs}]` -> reconcile at +10..15 min miss 1, +20 miss 2, +25 miss 3 -> `getMarket(eventTicker)` rejects -> `removeTrade` -> `trySettle` never runs for the legs -> `orphanSweep` alerts per leg.

Failure scenario: 12:00Z event with 3 legs (closes in 6 h) shows sum of bids 1.04; basket buys NO 0.35 on each leg ($1). 12:25Z: dropped as `orphan-ledger`. `removeTrade` calls `noteExit(eventTicker)`, so `re-entry lockout` (`:2795-2797`) blocks the same event for 60 min; after that, if the pricing condition persists, the basket can be bought again (`:2814` compares event ticker vs event ticker, `:2819` skips the event cap for dutch). 18:30Z legs settle at the venue; the ledger records nothing.

Actual consequence: every live Dutch fill is lost from the ledger within ~25 minutes: settlement P&L never recorded (the arm can never accumulate ladder evidence), legs untracked, duplicate baskets possible after the lockout. Bounded by the $1 basket (live `amountPerTrade 1`).

Existing protection: `orphanSweep` alerts once per leg market; the venue settles the legs correctly; the 60-minute churn lockout after the drop (a correction to the finders' "T0+30m duplicate").

Cheapest confirmation test: push `{marketId:'EV-1', legs:[{marketId:'EV-1-A'},{marketId:'EV-1-B'}], createdAt: now-11min}`; stub `getPositions -> [EV-1-A, EV-1-B]`, `getMarket('EV-1') -> reject`; call `reconcileLedgerWithVenue` three times; the trade is removed today.

ID: B-07
Title: TWS `COMPLETED_ORDER` messages carry no `orderId`/`clientId`, so the IBKR lab's `terminal()` is never true (live exits never submit, unfilled IOCs never close, partial entries never settle) and `findOrderByClientId`'s completed-orders fallback is dead code
Area: IBKR / ForecastEx — `ibkrLab.ts` live reconciliation and `ibkrAdapter.ts` order recovery
Severity: high
Confidence: verified
Location: `node_modules/.pnpm/@stoqey+ib@1.6.9/.../core/io/decoder.js:1959` (`decodeMsg_COMPLETED_ORDER`), `:599`/`:614` (`readOrderId`/`readClientId` only in `decodeMsg_OPEN_ORDER`), `:2134`, `:2201`; `src/main/venues/ibkr.ts:209-215`; `src/main/strategies/ibkrLab.ts:262-266`, `:291`, `:293`, `:309`, `:246`; `src/main/venues/ibkrAdapter.ts:140-141`; `scripts/tests/ibkr-lab.test.ts:127`, `scripts/tests/ibkr-execution.test.ts:95`

Claim: `reconcileLive` identifies a completed order by `${order.clientId}:${order.orderId}` and `findOrderByClientId` filters completed rows on `o.order.clientId===17091`, but the pinned decoder never populates either field on a completed order, so both lookups can never match.

Evidence: `decodeMsg_COMPLETED_ORDER` (`decoder.js:1959-2030`) calls `readOrderRef()`, `readPermId()`, ... and never `readOrderId()`/`readClientId()` (those are called only at `:599`/`:614` in `decodeMsg_OPEN_ORDER`; the setters are `:2134`/`:2201`); `ibkr.ts:209-215` passes the decoded row through unchanged. `ibkrLab.ts:264-266` `const row=completed.find(o=>\`${o.order.clientId}:${o.order.orderId}\`===id); return !!row&&/^(Filled|Cancelled|...)$/i.test(...)&&...` -> `'undefined:undefined'` never equals `'17091:<n>'`. Consumers: `:293` `if(!p.filled&&terminal(p.orderId,0)){...status='closed'...}`; `:309` `if(!terminal(p.orderId,p.filled)||ids.some(...))continue` gates the exit submission; `:291` `ordersComplete`. `ibkrAdapter.ts:140-141` `(await this.reader.completed()).find(o=>o.order.orderRef===ref && o.order.clientId===17091)` / `if (complete?.order.orderId !== undefined)`. The suites pass only because the fakes invent the fields: `ibkr-lab.test.ts:127` `completed=async()=>[{order:{clientId:17091,orderId:1,filledQuantity:0},state:{status:'Cancelled'}}]`; `ibkr-execution.test.ts:95` `api.complete=[{orderRef:'recover-me',clientId:17091,orderId:90}]`.

Execution path: paper fill -> `enterLive` -> `engine.placeOrder` (IOC, `:252`) -> record `open` -> `reconcileLive` -> `terminal()` false for every order no longer open -> `:293` skipped (unfilled IOC stays `open`), `:309` `continue` (filled position never reaches `sellPosition`), `:291` false for partial fills; `:246` `s.live.filter(...status!=='closed').length>=maxOpenPerStrategy` then blocks further entries. Recovery: `reconcileOrders` -> `findOrderByClientId` -> completed path never matches; an unfilled IOC whose acknowledgement was lost is never identified (B-04 consequence).

Failure scenario: `mode 'live'`, `liveStrategies ['momentum']`. T0 IOC fills 1 @0.50; T1 (+2 h) NO ask 0.90 fresh: edge -0.43, move -0.83 < -0.08, age >1 h: the exit rule says exit; `terminal('17091:1',1)` false -> `continue`; the position rides to settlement (full $0.51). Four unfilled IOCs stay `open` forever and the arm stops after `maxOpenPerStrategy` (4) attempts. Reproduced by the finder with decoder-shaped rows (0 exits) vs fixture-shaped rows (exit submitted).

Actual consequence: once any arm is enabled live, no live position can be exited by the rule it qualified on and no lost-acknowledgement IOC can be recovered; latent today (`ibkr-lab.json`: `mode paper`, `liveStrategies []`, `live []`; IBKR funded $100 on 2026-09-19, BACKLOG:1936).

Existing protection: settlement of fully filled entries with no exit order still works (`:291` short-circuits on `filled===quantity`); recovery still works via open orders (`OPEN_ORDER` carries the ids) and executions; live requires `configure()` with `liveEligible`, live engine mode and funding (`:77-89`).

Cheapest confirmation test: change `ibkr-lab.test.ts:127` to the decoder's shape `[{order:{orderRef:'x',permId:1,filledQuantity:0},state:{status:'Cancelled'}}]` and run `npm run test:ibkr-lab`: the `status==='closed'` assertion fails; `node -e` slicing `decoder.js` between `decodeMsg_COMPLETED_ORDER() {` and `decodeMsg_COMPLETED_ORDERS_END() {` finds no `readOrderId()`/`readClientId()` (confirmed: 0).

ID: B-08
Title: The AutoTrader and mini panels write the whole config from a <=10-s-old snapshot on every control change, silently reverting ladder stops/scale-downs and nightly-review applies; the ladder then records the reversal as "manual change in the panel" and resumes the arm with a fresh baseline, no demotion and no cool-down
Area: IPC config vs ladder/nightly-review timers (lost update)
Severity: high
Confidence: verified
Location: `src/renderer/src/AutoTraderPanel.tsx:87`, `:91-96`; `src/renderer/src/MiniAutoPanel.tsx:31-42`; `src/main/index.ts:199-205`, `:217-220`; `src/main/strategies/autoTrader.ts:1039-1044`, `:1813`; `src/main/strategies/miniAuto.ts:392-397`; `src/main/ladder/ladder.ts:735-742`, `:857-862`, `:897`, `:902-906`; `src/main/intelligence/nightlyReview.ts:453-454`

Claim: `patch(p)` sends `{ ...cfg, ...p }` where `cfg` is refreshed only by a 10-s interval, `setConfig` merges every key verbatim, and the ladder derives operator holds from config, so a process-side write inside the window is overwritten and mislabelled.

Evidence: `AutoTraderPanel.tsx:87` `const t = setInterval(load, 10_000)`; `:93` `const next = await window.api.autoTrader.setConfig({ ...cfg, ...p })` (every checkbox/select/keystroke); `index.ts:204` `return autoTrader.setConfig(cfg)`; `autoTrader.ts:1040` `this.config = { ...this.config, ...cfg }` (no version check); `ladder.ts:897` `this.autoTrader.setConfig({ [g.flag]: on, ..., ...this.sizesFor(s.id, 1) })`; `:735-742` `if (liveish(cfgStage) !== liveish(s.stage)) { s.history.push({..., reason: 'manual change in the panel' }); s.stage = cfgStage; s.since = Date.now(); s.baseline = this.captureBaseline(id); s.operatorHold = !liveish(cfgStage) }` — bypasses `transition()` (`:902`, the only place `demotions` increments) and the cool-down check, which lives only in `apply()` (`:857-862`). `computeSignals` reads `this.config.fadeEnabled` directly (`:1813`), so trading resumes on the next scan, not at the next ladder run. `nightlyReview.ts:453` `this.autoTrader.setConfig({ [a.key]: a.to })` is reverted the same way. `main.log`: 0 `manual change in the panel` lines to date (latent).

Execution path: `Ladder.run` (hourly, `index.ts:474`) -> `apply(stop)` -> `setConfig({fadeEnabled:false, strategySizeMult:{fade:1}})` -> operator toggles any control within <=10 s -> `patch` -> `setConfig(full stale copy)` -> `fadeEnabled:true`, notch restored -> next tick emits and executes fade signals -> next `Ladder.run` -> `strategy('kalshi-fade')`: stage back to tiny-live, new baseline, `operatorHold=false`.

Failure scenario: T0 12:00:03Z panel loads `{fadeEnabled:true, strategySizeMult.fade:2}`; T1 12:00:05Z ladder -$5 stop: `fadeEnabled:false`, mult 1, `demotions=1`, `cooldownUntil` +3 d; T2 12:00:09Z operator changes `pollIntervalSeconds` -> both reverted; T3 12:00:30Z scans place fade maker orders at x2; T4 13:00Z ladder logs a manual re-enable, fresh baseline, cool-down ignored. Inverse ordering (ladder promotes, stale write turns it off) sets `operatorHold=true`, which automation never lifts.

Actual consequence: a real-money stop or scale-down undone by an unrelated click, the arm resumes at its pre-stop size for up to an hour before even being noticed, the ladder's record is wrong; the same path reverts nightly-review parameter applies.

Existing protection: 10-s re-poll bounds the window; ladder transitions are infrequent; engine `maxStakePerBet`/`maxOpenPositions` still bound each order; the -$5 stop re-fires once new losses accrue.

Cheapest confirmation test: `c0 = trader.getConfig(); trader.setConfig({fadeEnabled:false, strategySizeMult:{fade:1}}); trader.setConfig({...c0, pollIntervalSeconds:20}); assert(trader.getConfig().fadeEnabled === false)` fails today.

ID: B-09
Title: A journal-recovered (`acknowledged`) BUY that filled is never adopted by the trader or lead-lag: the position is unmanaged, absent from the arm's evidence, and the same market can be bought again once the journal's per-market block lifts
Area: `engine.reconcileOrders` consumers
Severity: high
Confidence: likely
Location: `src/main/engine/engine.ts:88-101`; `src/main/store/orderJournal.ts:34`, `:39`; `src/main/strategies/autoTrader.ts:3086-3097`, `:2814-2815`, `:3507-3517`, `:4260-4275`; `src/main/strategies/leadLag.ts:797-808`; `src/main/ladder/ladder.ts:1172-1197`; `src/main/store/fillReconciler.ts:146`, `:159-165`

Claim: `reconcileOrders` resolves an uncertain submission only in the journal; no strategy reads that back for Kalshi, so a buy whose response was lost but which filled becomes an untracked venue position, its result is missing from the arm's calibration/ladder evidence, and the entry guard (local ledger only) admits a second buy after the pending row becomes `acknowledged`.

Evidence: `engine.ts:96-98` `this.journal.update(row, { state: 'acknowledged', orderId: found.orderId, ... })` and nothing else; `orderJournal.ts:34` `pending()` filters `state === 'pending'`, so `:39`'s block lifts on acknowledgement; `autoTrader.ts:3086-3097` catch: `sig.error = msg; result.errors.push(...)` — `openTrades.push` happens only on the success path (`:3049`); `:2814-2815` `market already open`/`order already resting` read `openTrades`/`pendingOrders` only; `gradeEntry` (`:4260-4275`) is fed only by trades in `openTrades`; `leadLag.ts:797-808` keeps the window reservation but `d.executed` stays false and `appendRow` is not reached, and `ladder.ts:1172-1197` builds lead-lag evidence from `executed` rows. `FillReconciler` (`:146`, `:159-165`) writes the recovered fill into `history.json` with `strategyRef`, which is not the strategy's ledger.

Execution path: `executeSignal` -> `placeOrder` -> IOC fills, response lost -> catch -> [>=60 s, reconciler every 5 min] `reconcileOrders` -> `acknowledged` -> `journal.begin` no longer blocks -> next scan same signal -> entry guard passes -> second buy.

Failure scenario: T0 book-imbalance buys YES $1 IOC on K; venue fills 2.5 @0.40; response lost. T0..T0+5m40s journal blocks K. T0+6 min: same signal, second $1 IOC fills; venue holds 5.0 YES, ledger 2.5; the first 2.5 hold to settlement with no stop/pre-close exit and never enter the arm's checkpoint.

Actual consequence: doubled stake on one market (bounded to the per-trade stake, $1 today), an unmanaged live position, and ladder evidence computed on an incomplete sample. Not observed (0 `[orders] recovered` lines in `main.log`).

Existing protection: journal block while pending (~1-6 min); one-time orphan alert; venue settlements feed the kill switch; hold-to-settle arms are unaffected in outcome; the venue-wide cap re-reads positions.

Cheapest confirmation test: fake adapter whose `placeOrder` calls `onSubmit` then rejects with a plain `Error`, `findOrderByClientId -> {orderId}`; run `executeSignal`, then `reconciler.run()`, then a second scan with the same signal; assert the second `placeOrder` is refused with `market already open` — it is accepted.

ID: B-10
Title: Kalshi entry path fails OPEN when the venue balance read fails: the kill switch is silent, the equity stake cap is skipped and the balance/shard checks are skipped, while the sub-engines fail closed on the same condition
Area: risk-control bypass / kill switch
Severity: medium
Confidence: verified
Location: `src/main/strategies/autoTrader.ts:1732-1748`, `:2785`, `:4516-4522`, `:2877-2886`, `:2851`, `:2855`; contrast `:4035`

Claim: when `engine.getPortfolio('kalshi')` fails or returns no account, `data.balance`/`data.equity` are undefined and `entryBlocked` treats an unknown balance as "no kill, no cap, no affordability check".

Evidence: `:1734-1740` `if (pf.mode === 'live' && !pf.account) { data.balance = undefined; data.equity = undefined; ... }`, `:1746-1748` `catch { data.balance = undefined; data.equity = undefined }`; `:2785` `const kill = this.killSwitchCheck(data.equity ?? data.balance)`; `:4522` `if (balance === undefined) return null` (before `dayRealizedForKill` at `:4527`); `:2884-2886` `if (cfg.maxBalancePct > 0 && base !== undefined) {...} return cfg.amountPerTrade * mult`; `:2851` `if (data.balance !== undefined && stakeNow > data.balance)`; `:2855` `if (... && data.balanceByShard)`. `subEngineKilled` `:4035` `if (this.engine.getExecutionMode() === 'live' && this.lastEquity === undefined) return true`. `venueLedgerStale()` (`:4547-4551`) is fed by `refreshVenueDay`'s separate `getSettlements` call, so a portfolio failure alone does not hold entries. Finders reproduced: `killSwitchCheck(80)` with day -41 vs limit -16 -> `TRIPPED`; `killSwitchCheck(undefined)` -> `null`.

Execution path: tick -> `gatherData` (portfolio throws) -> `computeSignals` -> `passesGates` -> `entryBlocked`: kill null, stake `amountPerTrade*mult`, no balance/shard check -> `executeSignal` -> live order.

Failure scenario: T0 scan N: realized day loss -$11 vs limit -$12; T1 settlements move the venue day to -$14 (settlements feed succeeds); T2 scan N+1: `getPortfolio` 429 -> every approved signal is submitted although the limit is breached; T3 scan N+2 with a good read trips the switch after the fact. Repeats on every failed read while the limit stays breached and untripped.

Actual consequence: one scan of new real-money entries per failed portfolio read after the daily loss limit is breached, at a stake the equity cap did not bound (bounded by `maxDailyTrades 200` and the position/event caps).

Existing protection: sticky `dailyPnl.tripped` once tripped on a known balance; `venueLedgerStale()` if the settlements feed also fails; venue collateral rejection; `getPortfolio` serves a last-good snapshot for 10 s (so the trigger is a fresh failure after the cache expires).

Cheapest confirmation test: `Object.create(AutoTrader.prototype)` as in `scripts/tests/risk-controls.test.ts`, `maxDailyLossPct 20`, `dailyPnl.realized -41` today untripped: `killSwitchCheck(80)` matches `/TRIPPED/`, `killSwitchCheck(undefined) === null`; a full `entryBlocked` with `{balance:undefined, equity:undefined}` returns null.

ID: B-11
Title: The execution-mode switch guard counts mini `openTrades` only, not mini resting orders; a live->paper flip while Polymarket US maker orders rest promotes their later fills into `openTrades` and then silently discards them at settlement through the paper path
Area: Polymarket US mini / execution-mode plumbing
Severity: medium
Confidence: verified
Location: `src/main/index.ts:165-167`; `src/main/strategies/miniAuto.ts:411`, `:982`, `:1026-1031`, `:1069-1074`, `:1261-1268`, `:1282-1290`; `src/main/store/fillReconciler.ts:140`; `docs/DEVELOPER-HANDBOOK.md:376`

Claim: `miniHeld` omits `pendingOrders` (the Kalshi line two rows above includes them), so the flip is allowed while real maker orders rest; the next tick still reads the live open-order list, promotes any fill, cancels the rest with errors swallowed, and a promoted live position is later settled via `settlePaperPosition`, which returns null so `removeTrade` drops it with no P&L.

Evidence: `index.ts:166-167` `const held = k.openTrades.length + (k.pendingOrders ?? []).length` / `const miniHeld = [...miniAutos.values()].reduce((n, m) => n + m.getStatus().openTrades.length, 0)` (`getStatus` exposes `pendingOrders` at `:411`); `miniAuto.ts:982` `const finalSweep = this.engine.getExecutionMode() !== 'live'`; `:1026-1031` promotion runs regardless of mode; `:1069-1074` `if (finalSweep) { for (const p ...) await adapter.cancelOrder(...).catch(() => undefined) } this.state.pendingOrders = []` (a refused cancel — 33 `cancel-refused` research rows exist — leaves the order resting and invisible); `:1282-1290` `if (mode === 'paper') { const rec = this.engine.settlePaperPosition(...); if (rec) {...} else { this.removeTrade(t.id) } }`; `fillReconciler.ts:140` returns unless live. Handbook:376: "switching is refused while positions or orders are held".

Execution path: click Paper -> `engineSetMode`: `held + miniHeld = 0` despite N resting mini orders -> switch -> mini tick -> `managePendingOrders` (live `getOpenOrders`/`getFills`) -> fill promoted -> `finalSweep` cancels, clears `pendingOrders` -> `manageExits` hold-to-settle -> resolution -> `settlePaperPosition` null -> `removeTrade`, no `recordExit`.

Failure scenario: T0 micro-maker rests 2 GTD orders (`pendingOrders 2`, `openTrades 0`); T1 flip to paper passes; T2 order A shows `fillCount 1` -> live position in `openTrades`; order B's cancel is refused -> keeps resting live, untracked; T3 A resolves -> row removed silently; B fills later with no ledger row.

Actual consequence: loss of the mini's authoritative record for real positions and untracked live orders after an operator mode switch; the daily-loss brake and ladder evidence miss them. Latent today (all mini arms off, 0/0).

Existing protection: guard refuses while any mini `openTrade` exists; `FillReconciler` archives fills once mode is live again; the live portfolio view shows venue truth.

Cheapest confirmation test: `MiniAuto` with a stub engine in live mode, one `pendingOrder`; evaluate `held + miniHeld` as in `index.ts:165-167` (0); set mode paper, stub `getOpenOrders` returning the order with `fillCount 1` and `cancelOrder` rejecting; tick -> `openTrades.length===1`, `pendingOrders.length===0`; stub `getMarket` resolved past close, tick -> `openTrades` empty and `perf.trades===0`.

ID: B-12
Title: The per-market churn guard (2 entries/day, 1-hour re-entry lockout, momentum 1/day) is an in-memory Map reset on every process start; the app boots ~15-18 times a day
Area: dedupe state that lives only in memory
Severity: medium
Confidence: verified
Location: `src/main/strategies/autoTrader.ts:675-676`, `:699-709`, `:2795-2802`, `:4784-4796`; `docs/BACKLOG.md:226`

Claim: `noteEntry`/`noteExit` write only `this.churn`, `PersistedState`/`defaultState()` carry no churn field, and the constructor never rebuilds it, so after a restart the trader can re-enter a market it exited minutes earlier and exceed the per-day cap.

Evidence: `:675-676` `/** Per-market churn record (in memory) ... */ private churn = new Map<...>()`; `:2795-2802` `const churn = this.churn.get(sig.marketId); if (churn && churn.day === nowDate()) { if (churn.lastExitAt && now - churn.lastExitAt < 60 * 60_000) return 're-entry lockout ...'; if (churn.entries >= 2) return 'per-market entry cap (2 per day)'; ...}`; `defaultState()` `:4784-4796` has no churn; `PersistedState.consensusActed`/`sportsPollAt` were persisted for exactly this reason (the codebase's own comments cite "eighteen times a day"); `main.log` shows 343 `Manifold connected` boots in 22 days.

Execution path: `executeSignal` -> `noteEntry` (memory) -> exit -> `noteExit` (memory) -> restart -> `new Map()` -> `entryBlocked` finds no record -> re-entry.

Failure scenario: T0 10:00Z mean-reversion enters KXMLB-...-NYY NO (entries=1); T0+20 m stop-loss exits (`lastExitAt`); T0+25 m maintenance restart; T0+26 m first scan: same signal passes and enters again inside the lockout; another restart permits a 3rd entry. Each round trip pays taker fees both ways — the 2026-09-06 pattern (13 entries in an hour, -$4.41) the guard was written for.

Actual consequence: bounded per market per restart to one extra entry at the configured stake ($1), but the only defence against the documented churn loss is off for the first scan after every boot.

Existing protection: per-event cap and open-position dedupe prevent holding one market twice simultaneously; `maxDailyTrades` and the kill switch are persisted; momentum (the original offender) is disabled until 2027.

Cheapest confirmation test: `noteEntry('M')` twice and `noteExit('M')`, assert `entryBlocked` returns the lockout; construct a second `AutoTrader` on the same file, assert it returns null.

ID: B-13
Title: `AutoTrader` stamps `configVersion: 20` into the JsonStore defaults, so a quarantined `kalshi-auto.json` comes back on `DEFAULT_CONFIG` with migrations 2-20 skipped (the exact defect fixed in the mini on 2026-09-03)
Area: migrations / corrupt-file fallback
Severity: medium
Confidence: verified
Location: `src/main/strategies/autoTrader.ts:758-762`, `:52-53`, `:214-227`, `:261`; 25 gates of the form `(persisted.configVersion ?? 1) < N`; `src/main/store/json.ts:24-41`; contrast `src/main/strategies/miniAuto.ts:239-246`

Claim: on a parse failure `JsonStore.load` quarantines the file and keeps the constructor defaults, whose `configVersion` is 20, so v2-v20 never run and the trader is rebuilt from `DEFAULT_CONFIG` plus v21-v27 and persisted as 27.

Evidence: `:758-762` `this.store = new JsonStore<PersistedStore>(statePath, { config: { ...DEFAULT_CONFIG }, state: defaultState(), configVersion: 20 })`; `json.ts:30-40` catch renames to `.corrupt-<ts>` and leaves `this.data` at the defaults; `miniAuto.ts:239-246` comment: "NOT CONFIG_VERSION: JsonStore keeps these defaults when the file is absent or will not parse ... On 2026-09-03 this very file was quarantined for a stray BOM ... 0 makes every migration run". Live file vs `DEFAULT_CONFIG`: `amountPerTrade 1` vs 5 (`:214`), `maxOpenPositions 60` vs 25 (`:216`), `maxDailyTrades 200` vs 60 (`:223`), `maxPerUnderlying 8` vs 1 (`:222`), `enabled/autoPoll/liveArmed true` vs false (`:52-53`, `:261`).

Execution path: `JsonStore.load` throws -> quarantine -> defaults (20) -> constructor runs only `< 21..27` -> `persist(27)` -> `restartTimer`: `enabled false`, nothing scans -> operator re-arms from the panel (the `.corrupt-` file is surfaced nowhere) -> `amountPerTrade 5` at 25% of equity.

Failure scenario: T0 a BOM'd/torn `kalshi-auto.json` (precedent: mini file 2026-09-03; `kalshi-auto.json` is hand-edited routinely per the `.bak_*` history) is quarantined at boot; T1 panel shows the trader off; operator flips `enabled+autoPoll+liveArmed`; T2 next scan stakes `min(5, 25% x ~$60) = $5` — five times the pre-registered size — on the default arm set with `maxPerUnderlying 1`; the 26 open trades are not in `openTrades`, so their exits are never managed.

Actual consequence: operator-owned sizes and switches silently revert to code defaults (5x order size) after a file fault; tracked positions become unmanaged; fail-closed until a human re-arms, which is exactly the step the mini fix said must not require reading a log line.

Existing protection: `DEFAULT_CONFIG` has `enabled/autoPoll/liveArmed false`; the quarantined copy is recoverable by hand; v21-v27 still run; `.bak_*` and hourly zips exist.

Cheapest confirmation test: write `{garbage` to a temp `kalshi-auto.json`, construct `AutoTrader`, assert `getConfig().amountPerTrade === 5` and the rewritten file has `configVersion 27` plus a `.corrupt-*` sibling; with the default at 0 the v18 migration yields `amountPerTrade 1`.

ID: B-14
Title: The engine position-cap reservation is released immediately for every Polymarket US and IBKR order (no `venueStatus === 'resting'`), and — because Kalshi's V2 create response carries no `status` — for Kalshi rests too, so back-to-back entries pass the cap against a stale count for up to 30 s
Area: `engine.placeLiveOrderReserved` / reservations
Severity: medium
Confidence: verified
Location: `src/main/engine/engine.ts:43-44`, `:245-246`, `:762-766`, `:810`; `src/main/venues/polymarketUs.ts:724-735`; `src/main/venues/ibkrAdapter.ts:110`; `src/main/venues/kalshi.ts:1522`, `:201-212`; `scripts/kalshi-docs/create-order-v2.md:218-259`

Claim: a reservation survives only when `res.shares > 0 || res.venueStatus === 'resting'`; Polymarket US never sets `venueStatus`, IBKR sets the broker's raw word (`Submitted`/`PreSubmitted`/`Filled`) with `shares 0`, and Kalshi's `venueStatus: res.status` is undefined because `CreateOrderV2Response` has no `status` property, so a resting order drops its token while `openPositionCountCache` (30-s max age, refresh after 5 s) still excludes it.

Evidence: `engine.ts:245` `if (!(res.shares > 0 || res.venueStatus === 'resting')) this.reservations.get(order.venue)?.delete(token)` (the success path never deletes the cache); `polymarketUs.ts:724-735` returns `{ ..., shares: filled, ..., status: filled > 0 ? 'filled' : 'open', timestamp }`; `ibkrAdapter.ts:110` `shares:0, ..., status:'open' as const, venueStatus:state.status`; `kalshi.ts:1522` `venueStatus: res.status,` with the vendored schema listing only `order_id, client_order_id, fill_count, remaining_count, average_fill_price, average_fee_paid, ts_ms`. Finders' deterministic repro: stub adapter returning `{shares:0,status:'open'}` under `maxOpenPositions=1` accepted three consecutive orders; the same with `venueStatus:'resting'` refused at the cap.

Execution path: `placeOrder` -> `countOpenPositions` (cached base N-1 < N) -> `reserveSlot` -> `submitLive` -> `{shares:0}` -> token deleted, cache untouched -> next candidate in the same loop -> same base -> passes -> ... until the background read (`:810`, counts `getOpenOrders`) lands.

Failure scenario: cap N, venue at N-1 read at T0; T0+1 s order A rests; T0+2 s order B; T0+3 s order C: venue holds N+2 commitments against N until the refresh.

Actual consequence: the engine-level cap is not enforced for maker rests inside one cache window; overshoot = rests placed within ~5-30 s. Practically inert today: the AutoTrader's own cap (60, counts `pendingOrders` synchronously at `:3186`/`:2805-2809`) and the mini's (48, `miniAuto.ts:696-701`, push at `:839`) bind first, every Polymarket US arm is off, and IBKR's only automated paths are IOC (`ibkrLab.ts:252`, `ibkrWatch.ts:36`); the manual `IbkrPanel` order (`IbkrPanel.tsx:46`, no `timeInForce` -> GTC) is the one reachable resting path.

Existing protection: local strategy caps below the engine cap; `readOpenPositionCountNow` re-reads resting orders within 5-30 s; `ibkrLab.maxOpenPerStrategy`.

Cheapest confirmation test: `TradingEngine` live, `maxOpenPositions=1`, stub `getPositions/getOpenOrders -> []`, `placeOrder -> {orderId:'a', status:'open', shares:0}`; two back-to-back `placeOrder` calls both resolve; with `venueStatus:'resting'` the second throws `At max open positions`. For Kalshi: `mapOrderResult` on the documented example body yields `venueStatus === undefined`.

ID: B-15
Title: `getPortfolio(venue, 'live')` under paper execution falls back to the PAPER snapshot when the live read fails and caches it under the live key: the "Real account" view shows paper cash and positions for 10 s per failed read
Area: engine portfolio snapshot / UI truth
Severity: medium
Confidence: verified
Location: `src/main/engine/engine.ts:458-466`, `:476`, `:518-523`; `src/main/index.ts:190`; `src/renderer/src/App.tsx:66-70`, `:273`, `:346`, `:506`

Claim: `computePortfolio`'s catch reads `portfolioCache.get(`${this.mode}:${venue}`)` (the engine's mode) instead of the requested `mode`, which is always `'live'` at that point.

Evidence: `engine.ts:518` `const last = this.portfolioCache.get(\`${this.mode}:${venue}\`)` inside the live-read catch (the paper branch returned at `:476`); `:464-465` `pending = this.computePortfolio(venue, mode).then(value => { this.portfolioCache.set(key, { at: Date.now(), value })` with `key = \`${mode}:${venue}\``. Reachable: `App.tsx:66-70` `const other = s.executionMode === 'live' ? 'paper' : 'live'; window.api.portfolio.get(v, other)` every 15-s refresh; `index.ts:190` passes `mode` through. (The finders' own rejected suspicion said "the renderer never passes a mode"; `App.tsx:66-70` shows it does.)

Execution path: refresh -> `portfolio.get(v,'live')` (engine paper) -> `computePortfolio(venue,'live')` -> `getAccount` 429 -> fallback reads `paper:venue` (just refreshed by the primary call) -> returned and cached as `live:venue` -> `shown = otherPortfolio` (`:273`).

Failure scenario: engine paper, Kalshi tab, "Real account" selected; one 429 on the account read; for the next 10 s the pane shows the paper balance/positions under the Real-account button (the inner chip reads PAPER because `shown.mode` is `'paper'`, `:346`).

Actual consequence: self-contradicting operator display in the view §123 introduced; no order impact (`Sell` is disabled off the execution view, `App.tsx:506`; strategies call `getPortfolio` with the default mode). Latent while `executionMode` is live.

Existing protection: snapshot carries its own `mode`; 10-s cache expiry; `Sell` disabled on the non-execution view.

Cheapest confirmation test: engine paper; `getPortfolio('kalshi')` (primes the paper cache); stub `getAccount` to reject; `const p = await engine.getPortfolio('kalshi','live'); assert(p.mode === 'live')` fails (`'paper'`).

ID: B-16
Title: The Polymarket mini deletes an expired resting order's row immediately after a fire-and-forget cancel — the fill race the Kalshi trader's comment names and avoids — orphaning a fill that lands between the open-orders snapshot and the cancel
Area: maker lifecycle (cancel vs fill race)
Severity: medium
Confidence: verified
Location: `src/main/strategies/miniAuto.ts:1032-1035`; compare `src/main/strategies/autoTrader.ts:3347-3353`

Claim: in the "still resting but past `expirationTs+120`" branch the mini cancels and removes the local row in the same pass, so a fill after the `open` snapshot is never promoted.

Evidence: `miniAuto.ts:1032-1035` `if (Date.now() / 1000 > p.expirationTs + 120) { await adapter.cancelOrder(p.orderId, p.marketId).catch(() => undefined); this.state.pendingOrders = this.state.pendingOrders.filter((x) => x.orderId !== p.orderId) }` on an `o` from the pass's snapshot (`:983`); `autoTrader.ts:3348-3353`: "a fill can land between the orders snapshot and this cancel. Leave the row; the gone-branch reconciles fills from the feed and then removes it." followed by `cancelOrder` and `continue` (no filter). The mini has no periodic orphan sweep at all (`bootReconcile` `:204-215` runs once per process).

Execution path: tick -> `getOpenOrders` at T0 -> loop reaches P (past expiry, venue kept it) -> cancel at T2 -> row deleted -> fill at T1 (T0<T1<T2) never seen -> position untracked; next scan may re-enter M.

Failure scenario: T0 order P (`fillCount 0`) resting 3 min past expiry; T1 +1.5 s P fills 1 contract; T2 +2 s cancel + delete: 1 contract held at the venue, absent from the ledger.

Actual consequence: untracked live inventory and a possible duplicate entry; bounded to one order and currently inert (every Polymarket US arm off), but it becomes live the moment any mini arm is re-armed, and unlike Kalshi there is no later alert.

Existing protection: the venue should have expired the order; `FillReconciler` archives the fill for P&L visibility (no position adoption).

Cheapest confirmation test: stub `getOpenOrders -> [P resting, fillCount 0, expirationTs 5 min ago]`, `cancelOrder` resolves, `getOrder` afterwards reports `fillCount 1`; one tick: row gone, `openTrades` empty; the Kalshi trader under the same stub keeps the row and promotes next tick.

ID: B-17
Title: `managePendingOrders`' strategy-off branch `continue`s before the fill-promotion step, so fills on a still-resting order of a stopped strategy are not promoted (and not managed) until the order leaves the book — potentially hours when the venue refuses the cancel
Area: maker-order reconciliation / ladder stops
Severity: medium
Confidence: verified
Location: `src/main/strategies/autoTrader.ts:3313-3329`, `:3331-3346`; `docs/REVIEW-CHANGES-2026-09-06.md:1045`

Claim: when `!strategyOn(p.strategy)` and the order is still listed, the loop cancels (at most every 30 min; a refusal is only logged) and `continue`s, skipping `o.fillCount - p.promoted`.

Evidence: `:3313` `if (o && !this.strategyOn(p.strategy)) { ... await adapter.cancelOrder(p.orderId) ... continue }` precedes `:3331-3337` `if (o) { const newlyFilled = o.fillCount - p.promoted; if (newlyFilled > 0.005) { this.promoteFill(...)`; `:3317-3318` comment "A venue can refuse, so ask at most every 30 minutes"; REVIEW-CHANGES:1045 records two refused cancels that "stayed open ... they die with the market".

Execution path: ladder stop -> next tick order still resting with `fillCount 0.6` -> cancel refused -> `continue` -> repeats every tick -> the 0.6 contracts are in no `openTrades` row: no stop-loss/take-profit (`manageExits` iterates `openTrades`), no settlement booking until the gone-branch (`:3427-3448`) reconciles from the 200-fill window (B-53).

Failure scenario: T0 volume-spike rest 1.05 YES; T1 0.6 fills; T2 ladder stops volume-spike; T3 cancel refused (venue 5xx); T3..T3+30 min same; a live position of a stopped arm is unmanaged for the refused-cancel window; if >200 fills pass first the slice is lost (B-53).

Actual consequence: unmanaged live exposure for the duration of the refusal window on the arms with TP/SL exits; bounded by one order's size.

Existing protection: the row survives, so `entryBlocked` still refuses re-entry; a successful cancel moves the order to the gone-branch next tick.

Cheapest confirmation test: `pendingOrders=[{strategy:'volume-spike', promoted:0}]`, `volumeSpikeEnabled=false`, `getOpenOrders -> [{fillCount:0.6}]`, `cancelOrder` rejecting; after `managePendingOrders` assert `openTrades` has 0.6 shares (actual: none, `p.promoted` still 0).

ID: B-18
Title: The Polymarket paper lab runs on a second adapter instance that never gets the catalog index, so its "whole venue" discovery is still the 3,000-row volume-sorted fallback (§118 marked this fixed)
Area: Polymarket US paper lab / catalog index
Severity: medium
Confidence: verified
Location: `src/main/index.ts:402-403` vs `:425-427`; `src/main/venues/polymarketUs.ts:222`, `:234-240`, `:321`, `:324-325`; `src/main/strategies/polyPaper.ts:145-147`; `docs/REVIEW-CHANGES-2026-09-06.md:4147`, `:4152`, `:4187`

Claim: `startCatalogRefresh` is called only on the engine's registry adapter; `PolyPaperLab` is wired to `new PolymarketUsAdapter(1500)` whose private `catalog` is never populated, so `searchMarkets({sort:'ending-soon', limit:5000})` always takes the fallback walk.

Evidence: `index.ts:402-403` `const polyUs = engine.getAdapter('polymarket-us'); if (polyUs instanceof PolymarketUsAdapter) polyUs.startCatalogRefresh(...)` vs `:425-427` `const polyVenue=new PolymarketUsAdapter(1500); polyPaper=new PolyPaperLab(..., { searchMarkets:q=>polyVenue.searchMarkets(q), ... })`; `polymarketUs.ts:222` `private catalog?: {...}` set only by `refreshCatalog`; `:321` `const want = query.sort === 'ending-soon' ? 3000 : ...`; `:324-325` `const fresh = query.sort === 'ending-soon' && this.catalog && ...; if (fresh) collected = this.catalog!.rows.slice()`. `polyPaper.ts:145-147` comment "the adapter's catalog index makes the whole 72 h window cheap"; REVIEW-CHANGES:4187 "The paper lab's next discovery reads from it." Live `poly-paper.json`: `discovered 1222` (a 3,000-walk number) while the engine instance's moneyline subset alone holds ~1,214 rows.

Execution path: boot -> `new PolymarketUsAdapter(1500)` (no `startCatalogRefresh`) -> `polyPaper.scan()` every 60 s -> `searchMarkets` -> `fresh=false` -> 30 paginated gateway GETs at 1/1.5 s -> horizon filter -> 12-market rotation from an arbitrary ~4% slice.

Failure scenario: every 30 min the lab's rotation pool is the same fixed volume-sorted slice §118 said it eliminated; all eight lab scorecards and the 09-24 read are computed on it while the record claims full coverage.

Actual consequence: research contamination and a false coverage claim for the stated Polymarket US qualification path; no money.

Existing protection: none for the lab instance; the engine adapter (mini, held arms) has the index.

Cheapest confirmation test: two adapters with a mocked gateway, `startCatalogRefresh` on one, `searchMarkets({sort:'ending-soon',limit:5000})` on the other: 30 `/v1/markets?...offset=` GETs are issued.

ID: B-19
Title: Evidence restarts (v27 re-baseline, hand re-base, manual panel flip) never reset `lastCheckpoint`, so live arms skip every checkpoint until 60-100 post-restart trades — three live arms are in that state now
Area: ladder checkpoints / `traderEvidence`
Severity: medium
Confidence: verified
Location: `src/main/ladder/ladder.ts:402-409`, `:735-742`, `:1119-1124`; the only resets at `:905` and `:932`

Claim: when an arm's evidence counter restarts without going through `apply()`/`scaleUp()`, `s.lastCheckpoint` keeps its old value and `decideStage` holds until `floor(n/20)` exceeds it, so the 20/40/60/80-trade band checks are skipped and only the -$5 hard stop acts.

Evidence: `:406-408` `const checkpoint = Math.floor(ev.n / CHECKPOINT_TRADES); if (checkpoint <= lastCheckpoint) { return { kind: 'hold', ..., reason: \`... next checkpoint at ${(lastCheckpoint + 1) * CHECKPOINT_TRADES}\` } }`; `:1123-1124` zeroes `netN/netSum/netSq/dayN:/daySum:` on the baseline but not `s.lastCheckpoint`; `:735-742` sets stage/since/baseline/operatorHold only. Live `ladder.json`: `kalshi-fade` `lastCheckpoint 4`, verdict "23 settled since stage start, net $-1.09; next checkpoint at 100"; `kalshi-volume-spike` `lastCheckpoint 2`, "4 settled ... next checkpoint at 60"; `kalshi-consensus` `lastCheckpoint 4`, "2 settled ... next checkpoint at 100" (its accumulator was renamed by hand on 09-19; `since` still 2026-09-14). Finders reproduced: `decideStage({n:20,netDollars:-3,mean:-15,se:3,sd:30,clusters:5},1,0).kind === 'stop'` but `...,1,4).kind === 'hold'`.

Execution path: hourly `Ladder.run` -> `traderEvidence` re-baselines to 0 -> `judgeLive` -> `decideStage(ev, notch, lastCheckpoint=4)` -> hold at n=20/40/60/80.

Failure scenario: fade reaches 20 post-clear settlements with mean -15c, se 3c, 5 day-clusters (the checkpoint rule says stop): hold "next checkpoint at 100"; ~4 more trading days until n=100 or the -$5 stop.

Actual consequence: a losing arm the band would stop at 20 trades runs to 100 or to -$5 x notch; a winning arm cannot scale before 100; the documented 20-trade checkpoint rule is silently off for fade, volume-spike and consensus today. Relates to §127 M-04: the re-baseline fix is incomplete.

Existing protection: the -$5 x notch hard stop runs every evaluation; at n=100 the thorough rules apply.

Cheapest confirmation test: `node scripts/tests/run.cjs` one-liner: `decideStage({n:20,netDollars:-3,mean:-15,se:3,sd:30,clusters:5,stake:1},1,4).kind === 'stop'` (currently `'hold'`); or compare each live arm's `lastCheckpoint` with `floor(traderEvidence.n/20)`.

ID: B-20
Title: The consensus re-base left the 12 open pre-amendment positions attached to the fresh `consensus` cohort; their settlements grade into the restarted evidence and can trip its hard stop
Area: cohort re-base / `detachOpenTrades` / `traderEvidence`
Severity: medium
Confidence: verified
Location: `src/main/strategies/autoTrader.ts:3528-3545` (only caller `ladder.ts:764`), `:3877`, `:3879`; `docs/PREREGISTERED-polymarket-consensus.md:154-155`

Claim: the §129 re-base moved the 108-trade accumulator to `consensus:pre-matcher-20260919` by editing state, but the ladder captured no new baseline and `detachOpenTrades` never ran, so every open consensus trade still has `perfKey` undefined and settles into `consensus`.

Evidence: live `kalshi-auto.json`: 12 open trades with `strategy 'consensus'` and no `perfKey` (BTTS/RFI/spread tickers §129 declared void); `perfByStrategy['consensus:pre-matcher-20260919'].trades 108`; `perfByStrategy.consensus` already `trades 4, realizedPnl -2.25` since the 09:39Z re-base; `ladder.json` `kalshi-consensus` `since 2026-09-14`, baseline zeros. `:3877` `this.gradeEntry(t.perfKey ?? t.strategy, ...)`, `:3879` `this.recordExit(realized, t.perfKey ?? t.strategy, t)`; `detachOpenTrades` is called only from `captureBaseline` on a stage transition. Prereg:154-155: "Prior trades are kept under `consensus:pre-matcher-20260919`; the arm restarts its evidence from this amendment ... The 12 open positions hold to settlement".

Execution path: `trySettle(void BTTS trade)` -> `gradeEntry('consensus', ...)` + `recordExit(realized,'consensus')` -> `calib.byStrategy.consensus` and `perfByStrategy.consensus.realizedPnl` -> `traderEvidence('consensus')` -> `decideStage` hard stop on contaminated `netDollars`.

Failure scenario: -$2.25 already booked; the remaining void positions (~$1 each, historical win rate 49/108) settle 09-20..09-23; if `netDollars <= -5` -> stop, `demotions=1`, 3-day cool-down for a cohort the pre-registration says restarted; otherwise the fresh cohort's first read is majority void rows.

Actual consequence: the restarted consensus evidence and the 2026-10-13 read are contaminated by up to 12 settlements the amendment excludes; a spurious ladder stop plus demotion count is plausible.

Existing protection: the -$5 stop bounds the loss; nothing routes these settlements away from the live cohort.

Cheapest confirmation test: read `kalshi-auto.json`: every `openTrades` row with `strategy==='consensus'` created before 2026-09-19T09:39Z has `perfKey===undefined`; `t.perfKey ?? t.strategy` -> `'consensus'`. Fix: a one-off `detachOpenTrades('consensus','pre-matcher-20260919')`.

ID: B-21
Title: Kalshi arms are judged on an equal-per-trade mean of per-contract nets (partial closes become extra observations), not the contract-weighted estimand the doctrine and both labs now use
Area: `traderEvidence` estimand / `gradeEntry`
Severity: medium
Confidence: verified
Location: `src/main/strategies/autoTrader.ts:4271-4275`, `:4486-4490`, `:3779`; `src/main/ladder/ladder.ts:1126-1129`; `docs/DEVELOPER-HANDBOOK.md:904`; `docs/REVIEW-CHANGES-2026-09-06.md:4343`

Claim: `gradeEntry` adds one unit-weight observation per graded close (or partial slice) regardless of shares, so `traderEvidence.mean` weights each contract by 1/shares (= price at a fixed $1 stake), which the ledger's `netN/netSum/netSq` cannot correct.

Evidence: `:4272-4274` `s.netN = (s.netN ?? 0) + 1; s.netSum = (s.netSum ?? 0) + netCents; s.netSq = ... + netCents * netCents` (no shares term); `:4490` `this.gradeEntry(strategy, ..., (pnl / gradeOver) * 100, ...)` once per partial slice (`:3779`) and again at settlement; `ladder.ts:1129` `const mean = n > 0 ? sum / n : 0`. Live open trades carry 1.06-5.56 shares (25 of 26 fractional) — up to a 3.8x weight difference within one arm. Handbook:904 "The labs now weight every contract equally"; §127 F-04 fixed `polyPaper.ts`/`ibkrLab.ts` only.

Execution path: `trySettle`/`closeTrade` -> `gradeEntry(unit weight)` -> `calib.byStrategy[key]` -> `traderEvidence` mean/se/sd -> `decideStage` band.

Failure scenario: 10 trades at 0.20 (5 contracts) losing -20c/contract and 10 at 0.80 (1.25 contracts) winning +19c: contract-weighted -12.2c/contract; ladder mean -0.5c, band -4.3..+3.3 -> "inconclusive" instead of "losing with 80% confidence". A 0.1-share partial exit at -50c plus 0.9-share settlement at +5c adds two equal observations for a trade whose net is -0.5c.

Actual consequence: the ladder's band estimates a different quantity than the doctrine's estimand, largest on arms whose entry price varies (consensus 0.17-0.67, mean-reversion >=0.35); a loss concentrated in cheap high-share trades is under-weighted. `netDollars` (hard stop) is unaffected.

Existing protection: hard stop is on dollars; fade's 0.89-0.98 band keeps its weights within ~10%.

Cheapest confirmation test: grade two trades (5 shares @ -20c/contract, 1 share @ +19c/contract) and assert `netSum/netN` equals the contract-weighted -13.5c (currently -0.5c).

ID: B-22
Title: `quoterEvidence` judges the quoter on every KX(HIGH|LOW) settlement in the venue ledger — including the settlement ratchet and weather-morning arms — and its `n` counts rows the mean excludes
Area: `quoterEvidence`
Severity: medium
Confidence: verified
Location: `src/main/ladder/ladder.ts:1084-1092`, `:404-405`, `:1277`

Claim: the quoter's stage evidence is the settlement list filtered only by timestamp and ticker prefix, with no attribution to the quoter's own fills, and both the hard stop and scale-up read it.

Evidence: `:1087` `const rows = pnl.details.filter((d) => d.timestamp >= since && /^KX(HIGH|LOW)/.test(d.marketId))`; `:1089` `obs = rows.filter((r) => r.shares > 0)`; `:1091` `n: rows.length` (unfiltered) while mean/se come from `obs`; `VenueSettlement` carries no strategy field; `settlement` is judged from the strategy-keyed calib ledger (`:1277`) but its fills land in the same weather settlements. Live: quoter and settlement both `operatorHold` with `cooldownUntil 2026-12-01` — they come off hold on the same date.

Execution path: `Ladder.run` quoter branch (tiny-live/live) -> `quoterEvidence(since)` -> `engine.getLivePnl('kalshi').details` -> `decideStage` on other arms' settlements (`:404-405` hard stop on `netDollars`).

Failure scenario: quoter and settlement both tiny-live from T0; over 5 days the ratchet settles 20 bracket rows netting -$4.80 while the quoter's own fills net +$0.30: `n=20, netDollars -4.50`, band negative -> quoter stopped; the inverse masks quoter losses behind ratchet gains and delays the stop.

Actual consequence: cross-arm contamination of a live stop/scale-up input; latent today (all weather arms held to 2026-12-01).

Existing protection: operator holds; the venue ledger row list is capped at 1,000.

Cheapest confirmation test: fixture `getLivePnl` returning one KXHIGH row with `shares 0` and one with `shares 1`: `quoterEvidence.n === 1` (currently 2); attribution needs the quoter's own fill tickers (`quoter.status()` has them).

ID: B-23
Title: Kalshi fill direction is derived from `book_side`, which Kalshi defines as directional exposure, not buy/sell: every NO buy and every exit is archived and displayed with the wrong side/outcome and the wrong notional (audit item D5, 2026-09-18, still unfixed)
Area: Kalshi adapter / fill reconciler / trade history
Severity: medium
Confidence: verified
Location: `src/main/venues/kalshi.ts:873`, `:879`, `:881`; `scripts/kalshi-docs/order-direction.md:15-16`, `:35`; `src/main/store/fillReconciler.ts:76-77`; `src/renderer/src/BacktestPanel.tsx:140-141`; `docs/AUDIT-CODE-API-STRATEGY-2026-09-18.md:493`; `docs/AUDIT-REVIEW-VERIFICATION-2026-09-18.md:79`

Claim: `getFills` maps `book_side === 'ask'` to `sell` and `outcome_side` to the outcome, but Kalshi documents both as the same bit (`bid ≡ yes, ask ≡ no`) with buy-no and sell-yes collapsed, so a NO buy is recorded as `sell NO`, a YES exit as `sell NO` priced at the NO leg, and a NO exit as `buy YES`.

Evidence: `:873` `const outcome = f.outcome_side === 'no' ? 'NO' : 'YES'`; `:879` `side: f.book_side === 'ask' ? 'sell' : 'buy'`; `:881` `price: outcome === 'YES' ? toNum(f.yes_price_dollars) : toNum(f.no_price_dollars)`; order-direction.md:15-16 "`bid ≡ yes`, `ask ≡ no`, always", :35 "buy-no and sell-yes both produce long no". Live archive (`fill-reconciler-kalshi.json.fills.jsonl`, 3,104 rows): 0 `buy|NO`, 0 `sell|YES`; lead-lag (which only buys) shows 794 `buy|YES` and 743 `sell|NO`. This is the same defect as D5 in the 09-18 audit docs (rated Medium there, "mislabels half of all fills"); no fix has landed.

Execution path: `FillReconciler.run` (5 min) -> `getFills` -> `planFillIngest` rows `{side, outcome, price, amount}` (`:76-77`) -> execution archive + `history.recordMany` -> `historyList` -> `BacktestPanel` renders `t.side`/`t.outcome`.

Failure scenario: lead-lag buys NO 3 contracts at yes 0.62: fill `outcome_side 'no', book_side 'ask'` -> row `sell NO @0.38, amount 1.14`. A volume-spike stop-loss sells 2 YES at 0.30 -> row `sell NO @0.70, amount 1.40`: a $0.60 sale of YES archived as a $1.40 sale of NO.

Actual consequence: the append-only execution archive (the handbook's audit artifact) and the trade-history list misstate direction on roughly half of all Kalshi fills and the notional of every exit; any research reading side/outcome/amount from these rows is contaminated.

Existing protection: money paths consume only `orderId/shares/price/fee` (`managePendingOrders`, quoter attribution, `computeLivePnl`, `visibleTrades`); engine placement summaries carry the true side.

Cheapest confirmation test: count archive rows with `side 'buy' && outcome 'NO'` (expect >0; actual 0) and `side 'sell' && outcome 'YES'` (actual 0); unit: `getFills` on `{outcome_side:'no', book_side:'ask', yes_price_dollars:'0.62'}` for an order placed as NO must yield `side 'buy'`.

ID: B-24
Title: `executeDutch` accepts a partially filled leg as a complete basket, its unwind sells the WHOLE venue NO position on each filled leg (including another arm's contracts), and Dutch legs are exempt from the per-market/per-event guards; the audited "unwinds partials" code is the recorder-only engine
Area: dutch order request -> fill -> unwind
Severity: medium
Confidence: likely
Location: `src/main/strategies/autoTrader.ts:3590`, `:3594`, `:3620-3623`, `:2814`, `:2819`, `:2826`, `:4147`; `src/main/venues/kalshi.ts:1081-1085`; `src/shared/types.ts:227-228`; `docs/DEVELOPER-HANDBOOK.md:572`

Claim: the live path rejects a leg only on zero fill, so a fractional IOC fill is booked as a leg; on a later leg failure the unwind calls `sellPosition` without `shares`, which the Kalshi adapter resolves to the account's entire NO position on that market; a failed unwind is swallowed and the filled legs never enter the ledger.

Evidence: `:3590` `if (res.status === 'open' || res.shares <= 0) { ... throw }` then `:3594` `entries.push({ marketId: legs[i], outcome: 'NO', shares: res.shares, ... })` — no comparison with the requested count (`mapOrderResult` reports `status 'partial'`); `:3622` `await this.engine.sellPosition({ venue: VENUE, marketId: e.marketId, outcome: 'NO', ref: 'auto:dutch' }).catch(() => undefined)`; `kalshi.ts:1081-1085` `if (count === undefined) { const positions = await this.getPositions(); const pos = positions.find(...); count = pos?.shares ?? 0 }`; `types.ts:227-228` "omit to close the whole position". Guards: `:2814` compares `sig.marketId` (event ticker) against leg tickers never; `:2819`/`:2826` skip the event/underlying caps for dutch. Handbook:572 documents `dutch` as "multi-leg IOC, unwinds partials" and BACKLOG/REVIEW-CHANGES closed the accepted-vs-filled audit citing `dutchBook.ts` (`res.shares >= contracts`), whose engine `dutchCfg()` hard-codes `dutchLiveEnabled: false` (`:4147`).

Execution path: `executeSignal(dutch)` -> `executeDutch` -> per-leg IOC at bid-1c -> `res.shares < requested` on a thin leg -> pushed -> basket held to settlement with unequal legs; OR leg k throws -> catch -> `sellPosition(whole venue NO position)` -> failure swallowed -> no ledger entry for legs 1..k-1.

Failure scenario: 3-leg $1 basket, leg A fills 0.30 of 0.81, B and C 0.81: payout 1.11 if B/C resolve YES but 1.62 if A does, against cost $0.78 — modeled +$0.04 becomes -$0.11 downside, held to settlement. Variant: leg C throws after A and B filled; the unwind of A also sells a fade NO position on the same strike (both arms trade longshot NO strikes); the fade row later books P&L on contracts no longer held until `reconcileLedgerWithVenue` drops it with no `recordExit`.

Actual consequence: bounded mis-hedged exposure recorded as a riskless basket (~$1 basket at today's `amountPerTrade 1`), plus cross-arm liquidation at an IOC price with the sold arm's P&L never attributed. Documented as fixed, in a code path that is not the live one.

Existing protection: IOC at bid-1c; zero-fill abort; `orphanSweep` alerts on untracked legs; Dutch fires rarely (no live fill yet); the 5-min reconcile clears the phantom row (without P&L).

Cheapest confirmation test: stub `engine.placeOrder` returning `shares 0.30` for leg 1 and full size for the others: `executeDutch` pushes an openTrade with legs [0.30, 0.81, 0.81] today; stub the third leg to throw and assert `sellPosition` is called with `shares` equal to the leg's fill (today `undefined`).

ID: B-25
Title: An ambiguous (timed-out/5xx) Kalshi exit that actually filled is never booked: the trade is either dropped as `orphan-ledger` with no exit P&L or, if the market resolves first, booked as a full settlement at the wrong size
Area: `closeTrade` / `reconcileLedgerWithVenue` / `trySettle` with the journal's per-market block
Severity: medium
Confidence: likely
Location: `src/main/strategies/autoTrader.ts:3800-3811`, `:3999-4008`, `:3875`; `src/main/store/orderJournal.ts:39`; `src/main/engine/engine.ts:88-103`, `:311`; `src/main/venues/kalshi.ts:1109`

Claim: after a sell IOC times out post-submission, `closeTrade` records nothing, retries are refused by the journal for ~1-6 minutes, no code reconciles the recovered sell into the open trade, and the trade then leaves the ledger without its realized exit.

Evidence: `kalshi.ts:1109` `req.onSubmit?.()` before the POST, so `engine.ts:311` leaves the row `pending` on an AbortError; `:3803-3809` only `/no (paper )?position/i` removes the trade, otherwise `t.exitAttempts = attempt`; `orderJournal.ts:39` refuses the retry; `engine.ts:96-98` only acknowledges; `:4004-4007` `if (mk?.resolved || mk?.resolution !== undefined) continue; ... this.removeTrade(t.id)` with no `recordExit`; `:3875` `const realized = (win - t.entryPrice) * t.shares - entryFeeDollars(t)` uses the ledger's shares.

Execution path: `manageExits` -> `closeTrade` -> `sellPosition` -> `submitLive` (pending) -> POST aborts at 45 s (order already matched) -> catch -> subsequent scans `Unresolved submission` -> reconciler acknowledges (journal only; once unblocked the next retry sends a `reduce_only` sell against a flat position, whose venue error text may or may not match the removal regex) -> `reconcileLedgerWithVenue` drops it after 3 misses OR `trySettle` books a full settlement.

Failure scenario: fade holds 2.0 NO @0.60; stop-loss sells IOC @0.45; venue fills 2.0 @0.46 (real -0.32) but the response is lost. Case A (unresolved market): T0+15 min dropped; perf ledger, `dailyPnl` and calib never see -0.32. Case B (resolves NO within 15 min): `trySettle` books `(1-0.60)*2 - fee = +0.72` for a position sold at 0.46.

Actual consequence: the arm's realized P&L and ladder evidence are wrong for every such trade (a stop-loss that disappears or turns into a win); not yet observed (0 `Unresolved submission` lines).

Existing protection: venue settlements remain the ground truth; the fill reconciler archives the sell with attribution; `reduce_only` prevents an over-sell; the journal prevents a duplicate sell while pending.

Cheapest confirmation test: fake adapter whose `sellPosition` calls `onSubmit` then throws a plain `Error`, then reports the position gone and the market resolved; one `closeTrade`, then three `reconcileLedgerWithVenue` passes (or one `trySettle`); assert `recordExit` was called with the fill price — observe removal with no exit, or a settlement booking.

ID: B-26
Title: The mini's fallback fill attribution for a vanished resting order filters fills by market and time only — not `outcome`/`side`/`orderId` — so a two-sided micro-maker or a manual trade on the same market becomes a phantom fill for the wrong leg whenever `GET /v1/order/{id}` misses after five minutes
Area: Polymarket US mini / maker fill reconciliation
Severity: medium
Confidence: likely
Location: `src/main/strategies/miniAuto.ts:1045`, `:1050`, `:1055-1058`, `:1061-1062`, `:569`, `:1079-1092`; `src/main/venues/polymarketUs.ts:930`, `:585`, `:591`

Claim: when `adapter.getOrder` returns undefined (it swallows every error) and the row is older than 5 minutes, the fallback sums all fills on the market since `createdAt` and promotes the total as the pending order's own side.

Evidence: `:1045` `const venueOrder = adapter.getOrder ? await adapter.getOrder(p.orderId).catch(() => undefined) : undefined`; `:1050` 5-minute grace; `:1055-1058` `const mine = fills.filter((f) => f.marketId === p.marketId && f.timestamp >= p.createdAt - 10_000); total = mine.reduce(...)`; `:1061` `this.promotePendingFill(p, newly, ...)` keyed by `p.outcome` (`:1086`); `polymarketUs.ts:930` `.catch(() => undefined)`; the fill rows carry `outcome`, `side` (`:585`, `:591`) and `orderId`, none used; `:569` micro-maker rests both `['YES','NO']` by default.

Execution path: tick -> `managePendingOrders` -> YES order gone -> `getOrder` 429/404 -> undefined -> row >5 min -> fills on M since `createdAt` (includes the sibling NO fill and any sells) -> `promotePendingFill(YES, shares, legOf(vwap))` -> phantom YES position -> settled as if held.

Failure scenario: T0 rests YES@0.45 and NO@(yes 0.47) on M; T1 the NO fills at 0.53; T2 (>5 min) the YES order expires, `GET /v1/order/{YES id}` 429s while `/portfolio/activities` succeeds; T3 total=1 -> ledger shows YES 1@0.53 and NO 1@0.53; the venue holds only NO; both rows book settlement P&L.

Actual consequence: phantom position rows, wrong per-strategy evidence for the micro-maker checkpoints and the daily-loss brake, a slot consumed by a non-existent position; bounded to one contract per event; historical mini fills (202/202) matched via the primary `getOrder` path, so the fallback has not fired to date; the arm is on hold.

Existing protection: `getOrder` first; 5-minute grace; a failed `getFills` aborts the pass; operator hold.

Cheapest confirmation test: `getOpenOrders -> []`, `getOrder -> undefined`, `getFills -> [{marketId:'M', outcome:'NO', side:'buy', shares:1, price:0.53}]`, `pendingOrders=[{orderId:'y', marketId:'M', outcome:'YES', promoted:0, createdAt: now-6min}]`; `managePendingOrders` -> `openTrades` gains a YES row at 0.53 (bug) instead of an `expired-unfilled` log.

ID: B-27
Title: The live orphan sweep sends an "untracked position — review it" alert for every lead-lag and convergence position it sees, once per ticker per process, on the same unthrottled ntfy webhook as the kill switch, ladder and daily summary
Area: `orphanSweep` vs sub-engine positions
Severity: medium
Confidence: likely
Location: `src/main/strategies/autoTrader.ts:3506-3517`, `:711`, `:4408-4410`, `:3478`; `src/main/util/alert.ts:6-39`; `src/main/strategies/leadLag.ts` (own state only), `src/main/strategies/cryptoConvergence.ts:475`

Claim: `tracked` is computed from the main trader's `openTrades`/`pendingOrders` only; lead-lag and convergence record positions in their own files and never push into `openTrades` (the only pushes are `:3049`, `:3245`, `:3598`), so each of their positions triggers one push per ticker per process on an arm that opens dozens of 15-minute tickers a day.

Evidence: `:3507-3509` `const tracked = this.state.openTrades.some((t) => t.marketId === pos.marketId || t.legs?.some(...)) || this.state.pendingOrders.some(...)`; `:3510-3517` `if (!tracked && !this.orphanAlerted.has(pos.marketId)) { ...; this.alert('Oracle Trader — untracked position', ...) }`; `:711` `private readonly orphanAlerted = new Set<string>()` (cleared on each of ~15 daily boots); `alert.ts:6-39` swallows every failure, no throttle; `alert()` (`:4408-4410`) writes only to the webhook, so `main.log`'s 0 `untracked position` lines are not evidence either way. Live: `leadLagLiveEnabled`/`convergenceLiveEnabled` true; webhook host `ntfy.sh`; 416 executed lead-lag rows since 09-17 09:40Z.

Execution path: tick (30 s) -> `orphanSweep` (5-min throttle, `:3478`) -> `getPositions` -> lead-lag ticker absent from `openTrades` -> alert -> restart -> Set cleared -> still-held tickers alerted again.

Failure scenario: 15:00:35Z sweep buys YES x1 on KXBTC15M-26SEP191100-00; 15:05:10Z sweep alerts "untracked position ... review it"; same for every other coin that window; the real alerts share the topic.

Actual consequence: tens of false "review this position" pushes a day describing deliberate positions; the sweep's real purpose (a manual/phantom position) is diluted; whether the ntfy free tier actually rate-limits real alerts is unmeasured.

Existing protection: per-ticker dedupe within one process; lead-lag positions live <=15 minutes.

Cheapest confirmation test: live-mode `AutoTrader`, stub `getPositions -> [{marketId:'KXBTC15M-26SEP191100-00', outcome:'YES', shares:1}]`, `getOpenOrders -> []`, empty ledger, webhook captured: one "untracked position" alert; a new instance on the same state file alerts again.

ID: B-28
Title: Convergence and fade can take opposite sides of the same KXBTCD strike with no cross-arm check; Kalshi nets the two into one signed position and both ledgers mis-book the outcome
Area: cross-arm venue netting
Severity: medium
Confidence: likely
Location: `src/main/strategies/cryptoConvergence.ts:359`, `:396-401`, `:455-465`, `:250-269`; `src/main/strategies/autoTrader.ts:2814`, `:3999-4008`, `:3875`, `:4159`; `src/main/venues/kalshi.ts:851-855`

Claim: convergence's only exposure check is its own `state.trades`, the trader's `market already open` sees only `openTrades`, and `position_fp` is one signed count per market, so a convergence YES buy at T-5 on a strike where fade holds NO (bought hours earlier when the strike was above spot) closes the fade contracts instead of opening a position, and neither ledger notices.

Evidence: `:359` `const side: 'YES' | 'NO' = spot > strike ? 'YES' : 'NO'`; `:396-401` `sameEvent = this.state.trades.filter(...)`; `:455-465` `adapter.placeOrder({ venue:'kalshi', marketId: m.ticker, outcome: side, ... immediate_or_cancel })`; `:264` settles from `resolution` with no venue-position check; `kalshi.ts:853-855` `const pos = toNum(p.position_fp); const outcome = pos > 0 ? 'YES' : 'NO'`. Live now: fade holds NO on KXBTCD-26SEP1917-T82749.99 (1.08 @0.93), KXETHD-, KXSOLD-, KXXRPD- strikes closing 2026-09-19T21:00Z; `convergenceSeries ['KXBTCD']` (`:4159`), `convergenceLiveEnabled true`, 10 settled convergence trades.

Execution path: fade maker rest fills NO -> hours later spot crosses above the strike -> convergence qualifies YES at T-5 -> IOC on the same ticker -> venue nets -> if counts are equal the market disappears from positions -> fade dropped as `orphan-ledger` (no P&L) after 3 misses, or `trySettle` books both as full settlements (`:4004` skips the drop once resolved).

Failure scenario: fade NO 1.00 @0.92 (YES 8c) day D-1; day D 20:55Z BTC 0.54% above the strike, YES ask 0.90 -> convergence YES x1 fills; `position_fp = +1 - 1 = 0`: the fade NO was sold at 0.10 (-0.82) and no YES exists; 21:00Z resolves YES; both arms book phantom results (fade dropped unbooked or -99c "settlement"; convergence +10c "win" on a closed leg).

Actual consequence: two live arms trading against each other paying two taker fees, the fade's hold-to-settlement thesis closed early by our own order, and phantom observations in both arms' evidence; bounded by $1 stakes; requires a strike moving from deep OTM to ITM before T-5, which is uncommon.

Existing protection: different price bands; fractional fade sizes make exact netting to zero unlikely; the 5-min reconcile eventually clears a phantom row (without P&L).

Cheapest confirmation test: run `scanAndExecute` against a stub whose `/markets` list carries one KXBTCD "greater" strike at T-5 with yes_ask 0.90 while a stub `AutoTrader` state holds a fade NO on the same ticker; convergence still places YES (no guard).

ID: B-29
Title: Per-keystroke saving of the "day loss <= %" field can trip the sticky daily kill switch on an intermediate digit, and nothing un-trips it for the rest of the UTC day
Area: UI-vs-engine truth / risk limits
Severity: medium
Confidence: likely
Location: `src/renderer/src/AutoTraderPanel.tsx:399`; `src/main/index.ts:199-205`; `src/main/strategies/autoTrader.ts:1039-1044`, `:4516-4534`, `:4494-4508`, `:414`/`:4555` (`killReset` never written), `:2785`, `:3012`, `:1430-1432`

Claim: the percentage is persisted on every input change with no validation or debounce; an in-flight scan re-checks `entryBlocked` (and therefore `killSwitchCheck`) before every approved candidate, and a tripped state is latched until the day rolls.

Evidence: `:399` `<input type="number" ... value={cfg.maxDailyLossPct} onChange={(e) => patch({ maxDailyLossPct: Number(e.target.value) })} />`; `:4520` `if (d.tripped) return 'kill-switch: daily loss limit hit — new entries halted'`; `:4523-4529` `const limit = (cfg.maxDailyLossPct / 100) * Math.max(balance, 1); ... if (realized <= -limit) { d.tripped = true`; the only reset is `rollDaily` (`:4494-4508`); `killReset` is declared (`:414`) and read (`:4555`) but never assigned. Correction to the source finding: `setConfig` -> `restartTimer` (`:1042`, `:4652-4680`) re-arms the sub-engine timers with 15-35 s delays, so the "lead-lag 10 s tick" is not the vector; the reachable vector is the scan already in flight (60-190 s, handbook §16.16), whose execute loop (`:1430-1432`) calls `entryBlockedWatched` (`:3012`) -> `killSwitchCheck` per candidate on the live `this.config`.

Execution path: operator edits 20 -> 15: type '1' -> `patch({maxDailyLossPct:1})` -> `this.config.maxDailyLossPct = 1` persisted -> in-flight scan's next `executeSignal` -> `killSwitchCheck`: limit 1% x $111 = $1.11, day realized -$3.40 -> `tripped=true`, alert -> operator types '5' -> `maxDailyLossPct=15` -> every later check returns early at `:4520`.

Failure scenario: today: `maxDailyLossPct 20`, local day -$4.36; typing '1' while a scan executes trips at any equity below $436; all Kalshi entries (trader and sub-engines via `subEngineKilled` `:4029`) halt until 00:00Z; only "Reset state" (B-01) or the day roll un-trips.

Actual consequence: a trading day of entries lost on a UI artefact, with an alert that reads as a genuine loss-limit event; fail-closed; probability per edit depends on scan phase (unmeasured).

Existing protection: fail-closed direction; the trip is logged and alerted; no debounce, no minimum bound, no un-trip path.

Cheapest confirmation test: `AutoTrader` on a temp state, `dailyPnl={date:today, realized:-2, tripped:false}`; `setConfig({maxDailyLossPct:1})`; `killSwitchCheck(100)` -> `TRIPPED`; `setConfig({maxDailyLossPct:20})`; `killSwitchCheck(100)` still returns the tripped message although -2 > -20.

ID: B-30
Title: A corrupt or schema-mismatched `poly-paper.json` throws inside `app.whenReady` before `autoTrader.start()`, leaving the live Kalshi trader unmanaged and the app without a window
Area: persistence / startup ordering
Severity: medium
Confidence: likely
Location: `src/main/strategies/polyPaper.ts:70-72`; `src/main/index.ts:381`, `:426-428` vs `:436`, `:456-474`, `:485-486`; contrast `src/main/strategies/ibkrLab.ts:38-47`

Claim: `PolyPaperLab`'s constructor does a bare `JSON.parse` and throws on any shape it dislikes (including a strategy id missing from `cash`), and it is constructed before `autoTrader.start()`, the reconcilers, the ladder, IPC registration and the window inside a `.then(async ...)` with no catch.

Evidence: `polyPaper.ts:71` `this.state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{...}`; `:72` `if(this.state.version!==1||!Array.isArray(this.state.trades)||POLY_PAPER_STRATEGIES.some(s=>!Number.isFinite(this.state.cash[s.id])))throw Error('Invalid Polymarket paper ledger; refusing to overwrite')`; `index.ts:426` `polyPaper=new PolyPaperLab(...)` precedes `:436` `autoTrader.start()`, `:456-464` reconcilers, `:472-474` ladder, `:485` `registerIpc()`, `:486` `createWindow()`; `:381` `app.whenReady().then(async () => {` with no `.catch` and no `unhandledRejection` handler in `src/`. `ibkrLab.ts:38-47` catches and sets `this.failure`, and tolerates a new strategy id (`:44`).

Execution path: boot -> `new AutoTrader` (timers not started) -> `new PolyPaperLab` throws -> the async callback rejects -> with Node's default unhandled-rejection mode the main process exits (a crash, not a hang) -> the sentinel restarts it with the same file -> loop.

Failure scenario: a hand edit or `scripts/poly-paper-reset.py` leaves a BOM (precedent: `mini-auto-polymarket-us.json` quarantined for a BOM on 2026-09-03, `miniAuto.ts:241-243`), or a strategy id is added without a `cash` entry; every restart dies before `autoTrader.start()`; resting maker orders live out their server-side expiry unmanaged; non-hold arms get no stop/pre-close exit until someone renames the file.

Actual consequence: exit management, orphan sweep, fill reconciliation and the ladder all stop, driven by a paper-only file; the sentinel (`scripts/sentinel.mjs:166-170`, `app-down` -> revive/repair) bounds the outage to its 15-minute cycle plus a repair session.

Existing protection: `poly-paper.json` is written with `writeFileAtomic` (flushed), so torn writes are unlikely; the sentinel detects a dead process.

Cheapest confirmation test: write `{}` (or a valid ledger missing one strategy's `cash`) to a temp path and `new PolyPaperLab(tmp, stubs)`: throws synchronously; then read `index.ts:426-436` ordering.

ID: B-31
Title: Only the settings/review/hunch/lab files use the flushed writer; `kalshi-auto.json`, `history.json`, ladder, lead-lag, fill-reconciler, dutch, convergence and quoter state are written unflushed, and five of those loaders overwrite a corrupt file instead of quarantining it
Area: persistence / atomic writes (handbook §16.4 fix incomplete)
Severity: medium
Confidence: likely
Location: `src/main/store/json.ts:8` vs `:49-50`; `src/main/ladder/ladder.ts:589-594`, `:643-651`; `src/main/strategies/leadLag.ts:344-357`; `src/main/store/fillReconciler.ts:105-109`, `:127-133`; `src/main/strategies/dutchBook.ts:112-118`, `:136-142`; `src/main/strategies/cryptoConvergence.ts:139-145`, `:177-184`; `src/main/strategies/quoter.ts:396-402`, `:517-523`

Claim: `JsonStore.save` and every sub-engine `persist()` call `writeFileSync` without `flush`, so a power loss after the rename can leave a zero/partial file; the ladder/reconciler/dutch/convergence/quoter loaders swallow the parse error and the next `persist()` overwrites the only copy.

Evidence: `json.ts:8` `writeFileSync(tmp, content, { encoding: 'utf8', flush: true })` (used by `config.ts:110`, review, hunch, `ibkrLab`, `polyPaper`) vs `:49-50` `writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8'); renameSync(tmp, this.path)`; `ladder.ts:591-593` `if (existsSync(p)) this.state = {...JSON.parse(...)} } catch { // fresh state }` then `:647-648` unflushed write + rename (identical shape in the other four). Handbook §16.4 scopes the flushed fix to "settings, nightly review files and both hunch state files"; §7.3 (line 394) still says `config.json` writes in place (it does not, `config.ts:110`).

Execution path: `persist()` -> unflushed `writeFileSync(tmp)` -> `renameSync` -> power loss before the page cache reaches NTFS -> boot -> `JsonStore.load` quarantines `kalshi-auto.json` (defaults, see B-13) / `ladder.json` loads "fresh state" and is silently replaced on the ladder's first run.

Failure scenario: 23:59:58Z persist writes 245 KB and renames; mains drop 50 ms later on a desktop without a UPS; on boot `kalshi-auto.json` is zeros (quarantined -> B-13) and `ladder.json` becomes `{strategies:{}}`: every strategy's demotion history, stage timestamps and cool-downs are gone, so a twice-demoted arm can be re-promoted.

Actual consequence: loss of the in-app position ledger and, for the sub-engine files, irrecoverable loss (no quarantine copy; only the hourly zip). Requires abrupt power loss (Windows-Update restarts flush and are not this trigger).

Existing protection: temp+rename protects against process crashes; hourly zips and `.bak_*`; `JsonStore` quarantines; the fill reconciler rebuilds dedupe from the append-only `.fills.jsonl`; lead-lag blocks the window on a malformed file rather than resuming.

Cheapest confirmation test: `grep -n flush src/main/store/json.ts src/main/ladder/ladder.ts ...` shows `flush` only in `writeFileAtomic`; write `{` to a temp `ladder.json`, construct `Ladder`, call `persist()`: the file is replaced and no `.corrupt-` sibling exists.

ID: B-32
Title: The Polymarket WS shadow snapshot is taken before the REST `/book` round trip, so the pre-registered agreement read compares two different instants and its `ageMs` filter cannot correct it
Area: lead-lag (shadow measurement)
Severity: medium
Confidence: likely
Location: `src/main/strategies/leadLag.ts:465-468`, `:474-477`, `:646-666`; `src/main/services/polyClobWs.ts:106-108`; `docs/PREREGISTERED-leadlag-polyws-shadow.md:16-26`

Claim: `polyQuote()` captures the socket top and computes `ageMs` before awaiting the REST `/book`, then the row stores that pre-fetch snapshot next to a REST bid/ask produced one round trip later, and the `/book` body's server `timestamp` is discarded.

Evidence: `:475` `const ws = this.wsTop(upToken)` then `:477` `const bookRes = await fetch(\`${POLY_CLOB_API}/book?token_id=...\`)`; `:467` `ageMs: Math.max(0, Date.now() - t.at)` at the same pre-fetch instant; the row (`:646-666`) stores `polyBid: poly.bid, polyAsk: poly.ask ... polyWs: poly.ws`. The registration filters on `polyWs.ageMs <= 5000` and PASSes at >= 98% agreement within 1c over >= 500 rows; a FAIL is acted on by the maintainer without asking (§132). First live row (`leadlag-dislocations.jsonl` 2026-09-19T10:29:22.782Z KXBTC15M-26SEP190630-30): `polyWs {bid 0.44, ask 0.45, ageMs 20, changes 330}` vs REST `0.50/0.51`; 24 `polyWs` rows so far.

Execution path: `scanAndSweep` -> `polyQuote(slug)` -> `wsTop` snapshot S at T0 -> `await fetch /book` (B at T0+RTT) -> `{bid,ask from B, ws: S}` -> row written -> the 09-24 read counts B != S as socket disagreement.

Failure scenario: a top that moves every ~2.7 s (330 changes in the window) and a ~150-400 ms `/book` RTT produce disagreement in several percent of rows against a 98% bar although the socket may have matched the book at the instant B was generated.

Actual consequence: the automated PASS/FAIL is biased toward a spurious FAIL, closing the event-driven Kalshi read line on a measurement artefact; research only, no order reads the socket.

Existing protection: none in code.

Cheapest confirmation test: mock `/book` whose implementation applies a new best bid/ask to `polyWs` before resolving; run `scanAndSweep` with a stubbed `top`; the row's `polyWs` equals the pre-fetch top while `polyBid/polyAsk` equal the fetched book. Offline: tabulate agreement conditioned on `changes`.

ID: B-33
Title: Recorded sweep latency starts after two sequential Kalshi round trips, so the Polymarket quote's age at the IOC is neither bounded (beyond the 6-s fetch timeouts) nor measured, and backlog 127's <200 ms gate passes by construction
Area: lead-lag (latency verification)
Severity: medium
Confidence: likely
Location: `src/main/strategies/leadLag.ts:566`, `:583`, `:607`, `:647`, `:813-815`, `:102`; `docs/BACKLOG.md:1630-1637`

Claim: per pair the Polymarket book is fetched first, then the Kalshi `/markets` list, then the `/orderbook`, and only then is `ts` stamped; `latencyMs = ackAt - ts` therefore excludes both Kalshi round trips and no timestamp of either quote is recorded.

Evidence: `:566` `const poly = await this.polyQuote(pair.pmSlug)`; `:583` `fetch(\`${KALSHI_API}/markets?series_ticker=...\`)`; `:607` `fetch(\`${KALSHI_API}/markets/${...}/orderbook?depth=1\`)`; `:647` `ts: new Date().toISOString()`; `:814` `d.latencyMs = ackAt - (Date.parse(d.ts) || submitAt)`; `:102` comment "Detection (quotes in hand) to venue acknowledgement". Live: 416 executed rows since 09-17 09:40Z, median `latencyMs` 58 ms, p90 105 ms (backlog 127's bar: median <200 ms, p90 <1 s).

Execution path: timer -> `scanAndSweep` -> `polyQuote` (T0) -> list (T0+RTT1) -> orderbook (T0+RTT1+RTT2) -> `ts` -> `sweep` -> POST -> `ackAt`; Poly age at ack = RTT1 + RTT2 + latencyMs, unrecorded.

Failure scenario: row 2026-09-19T10:29:22.782Z: REST Poly mid 0.505 read at T0; Kalshi YES bid 0.76 read two round trips later; IOC filled at YES 0.85/NO 0.15 with `latencyMs 186`; the row cannot say how old the 0.505 was (the socket showed 0.445 at T0). (The finders' reading of that fill as adverse is wrong — it beat the floor by 10c; the point is the unmeasured age, not that fill.)

Actual consequence: the operator-facing latency verification (127) and the cadence/socket sequencing decisions built on it (128) do not measure the dominant part of the signal-to-fill delay; the executable-bound regrade (157) cannot correct for an age it does not have.

Existing protection: 6-s timeouts on each read bound the worst case; `submitMs` isolates the POST.

Cheapest confirmation test: stub `fetch` with 150-ms delays on the two Kalshi calls and assert `latencyMs < 150` (the metric excludes them); read-only: time the two unauthenticated Kalshi GETs back to back 50 times and add the sum to the recorded latency.

Low findings (all still numbered and cited):

| ID | Title | Location | One-line claim | Confidence |
|---|---|---|---|---|
| B-34 | §127 fractional-contract fee fix does not reach the ledger | `autoTrader.ts:4860`, `:4875`; `scripts/tests/kalshi-fee.test.ts:144-147`; handbook:427-430; REVIEW-CHANGES:4344 | `entryFeeDollars`/`netCentsOf` still compute `C = Math.max(1, Math.round(t.shares))` before calling the fee helpers, so every fractional order's entry fee is mis-stated (1.47 @0.67: $0.0155 vs venue $0.0228, -32%); the N1 invariant test hard-codes the same rounding and only integer shares; marked fixed in §127/§8.1, not fixed on the settlement path | verified |
| B-35 | §129 `closeFrom` fix incomplete on the cap-disabled path | `engine.ts:189`, `:293` vs `:249`; `scripts/tests/risk-controls.test.ts:52-70`; REVIEW-CHANGES:4414 | with `riskLimits.maxOpenPositions <= 0` live orders route through `placeOrderChecked`, whose `recordFill(order.marketId, 'buy')` still records an IBKR opposing-buy exit as a new buy of the other contract; §129 claims `placeOrderChecked` verified; the regression test uses cap 1 only; unreachable at today's cap 80 | verified |
| B-36 | kalshi-dutch settlements never graded; detach label ignored | `autoTrader.ts:3846`, `:4486-4490`; `ladder.ts:132`, `:1126` | `recordExit(realized, 'dutch')` passes no trade, so `gradeEntry` never runs (`netN` stays 0, `traderEvidence.n` = 0 forever, only the hard stop can act) and a detached basket's `perfKey` is ignored, booking previous-stage baskets into the current stage's dollars | verified |
| B-37 | Convergence grades settlement on the REQUESTED count | `cryptoConvergence.ts:466`, `:264` | `trade.status = res.shares > 0 ? 'filled' : 'no_fill'` discards `res.shares`; `realizedPnlCents` multiplies by `t.contracts`, so a 0.4-of-1 partial IOC is graded as a full contract in the arm's ladder evidence; BACKLOG's 09-08 audit covered the status flag, not the size | verified |
| B-38 | Convergence records a live fill only after the POST returns | `cryptoConvergence.ts:455`, `:475`, `:497`, `:396-401` | a process exit between the venue fill and `state.trades.push` (persisted only in the scan's `finally`) loses the fill; after restart `sameEvent`/`openLive`/`liveToday` are empty and a second IOC can be placed inside the same T-5 window (bounded 1-4 contracts); the journal attributes but never restores it | verified |
| B-39 | A ladder stop landing during the execute phase does not stop signals approved earlier in the scan | `autoTrader.ts:1797-1826`, `:2988-3016`, `:3313` (only `strategyOn` use), `:1430-1432`; `ladder.ts:897` | `strategyOn` is applied only at signal generation and in `managePendingOrders`; `executeSignal` re-checks caps but not the flag, so a flag flipped off by the hourly ladder during a 60-190 s scan still executes that scan's remaining signals (IOC fills stand; rests are cancelled next tick) | verified |
| B-40 | `executionMode` never validated on load or IPC | `config.ts:53-62`; `index.ts:398`; `engine.ts:265`; `miniAuto.ts:728`, `:734` | a `null`/`'Paper'` in a hand-edited `config.json` satisfies neither `mode === 'paper'` nor `mode === 'live'`: orders go to `submitLive` with the mini's `liveArmed` and boot-reconcile vetoes skipped (the renderer can only send the two literals; stake cap still applies) | verified |
| B-41 | `refreshVenueDay`'s legacy split reads the newest 100 history rows | `autoTrader.ts:4585`; `history.ts:44` (`list(limit = 100)`) | `getHistory(undefined, VENUE)` resolves to 100 rows (today <13 h of fills), so any older position's settlement gets `ff === undefined` and lands in `realized` instead of `legacyRealized`; conservative for the kill switch, wrong for the panel split | verified |
| B-42 | One unparsable journal line voids the whole journal | `orderJournal.ts:26-32`; `engine.ts:810`; `ibkrLab.ts:273` | a torn last line sets `failure` and leaves `orders = []`: beyond the documented submission block, every journaled reservation drops out of the cap count, fill attribution loses `clientOrderId`, and `ibkrLab` closes an `uncertain` live row as "rejected before acceptance" with `net=0` (fail-open for that row) | verified |
| B-43 | History ledger has no paper/live tag; paper ids restart at `paper-1` | `paper.ts:48`, `:145`; `history.ts:36-39`; `engine.ts:721-741` | `PaperBroker.seq` is in-memory, `recordMany` dedupes by `venue:id`, so paper fills from different sessions collide and a later reconciler write drops all but one per id; `list()/stats()` mix paper and live rows for one venue | verified |
| B-44 | Paper reset swaps brokers mid-order | `index.ts:369-373`; `engine.ts:270-276`, `:706-712`; `autoTrader.ts:1120-1123` | `resetPaperAccounts()`/`clearHistory()` apply immediately while `autoTrader.reset()` defers, so an in-flight paper buy completes on the discarded broker (which persists over the fresh file) and lands in the just-cleared history; paper only | verified |
| B-45 | Portfolio fallback re-caches the stale snapshot with a fresh timestamp | `engine.ts:464-466`, `:518-523` | on every failed live read the last-good value is returned and re-cached with `at: Date.now()`, so the "from Ns ago" age restarts each poll and a multi-hour outage reads as a 10-15-s-old balance (stake sizing only) | verified |
| B-46 | Nightly review can raise live-arm capacity knobs | `nightlyReview.ts:70`, `:76`, `:126`, `:450-453`; `ladder.ts:800-803`; handbook:795-796 | with `reviewAutoApplyLive: true` (default and live) the `live` predicate is never consulted; `quoterMaxMarkets` {1..8} and `convergenceMaxDailyTrades` {1..6} are in the allow-list although the ladder's `sizesFor` treats them as size; today it can only lower convergence (live 10 > max 6) | verified |
| B-47 | Allow-list bypassed by prototype-named keys | `nightlyReview.ts:111-112`, `:121`, `:126` | `PARAM_BOUNDS[target][key]` is a plain lookup, so `constructor`/`__proto__`/`toString`/`hasOwnProperty`/`valueOf` are truthy bounds with undefined min/max and get written onto the config as junk own-properties; with `reviewAutoApplyLive=false` the same input throws and fails that day's review closed | verified |
| B-48 | Polymarket US arm evidence mixes paper and live closes | `miniAuto.ts:1326-1334`, `:1391-1392`; `ladder.ts:1200-1213` | `logResearch('closed', ...)` carries no mode field and `miniRows` filters on type/strategy/ts only, so a paper session's closes enter a live arm's `n`/`mean`/`netDollars` (mode switch is global) | verified |
| B-49 | Nightly review `last24h` is a 24-48 h window | `nightlyReview.ts:259`, `:269`, `:336` | `dayStart` is yesterday 00:00Z, not now-24h, so the field sums 24 + hours-since-midnight of settlements (30 h at the 06:00Z run); a distinct root cause from BACKLOG #134 | verified |
| B-50 | Kill-switch tooltips claim LIVE is disarmed | `AutoTraderPanel.tsx:266`, `:397`; `autoTrader.ts:4529-4534` | both operator-facing tooltips say "LIVE disarmed. Re-arm manually" while the code sets `disarmed = false` and auto-resumes at the UTC day roll (§16.6 lists only the `ipc.ts` comment) | verified |
| B-51 | "Real account" view under paper execution shows "Loading P&L from the venue..." forever | `App.tsx:76-87`, `:346-347`, `:407-409` | `livePnl` is fetched only when the engine mode is live, but the P&L block is keyed to the shown snapshot's mode, so the other-ledger view never leaves the loading branch | verified |
| B-52 | IBKR closes (opposing buys) are still refused by the per-venue stake cap | `engine.ts:218` (before the `closeFrom` exemption at `:221`); `ibkrAdapter.ts:124`; `ibkrLab.ts:81`, `:320`; `IbkrPanel.tsx:46`, `:56` | `amount = quantity*(1-p)+0.02*quantity` of the opposite leg is checked against `maxStakePerBet` (10) before the §129 exemption; unreachable through the lab (contracts bounded 1-4) but reachable for a cheap manual position (e.g. 80+ contracts entered under $10), which then cannot be exited through the engine | verified |
| B-53 | Vanished maker order reconciled against only the newest 200 fills | `autoTrader.ts:3300`, `:3333-3337`, `:3430-3448` | a rest that partially filled earlier (`p.promoted` set) and completes after >200 later account fills (356-687 fills/day observed) yields `filledTotal - p.promoted < 0`, so the final slice is never promoted and the row is deleted; the orphan sweep does not compare share counts | likely |
| B-54 | Reconcile drops a trade as `orphan-ledger` when the market read fails at the third miss | `autoTrader.ts:4003-4007` | `getMarket(...).catch(() => undefined)` makes `mk` undefined, `mk?.resolution !== undefined` is false, and the settled-early position is removed without `recordExit` on a transient 429/5xx, losing its grade and P&L | verified |
| B-55 | `JsonStore.save` swallows write/rename failures | `json.ts:51-53`; contrast `orderJournal.ts:50` | disk-full/EPERM produces one warn line; the trader keeps running on state that never reached disk, and a later restart loads the last successful file (kill trip re-derives from the venue ledger within one scan; recent trades can be double-settled or lost) | likely |
| B-56 | A hung order POST holds the lead-lag running guard for the 45-s HTTP timeout | `http.ts:98`; `leadLag.ts:515`, `:564`, `:729`; live `leadLagPollIntervalMs 60000` | one sweep whose POST neither returns nor errors keeps `running` set until the 45-s wall clock, so subsequent poll ticks no-op (other coins in the same cycle still run; the reservation is retained correctly) | likely |
| B-57 | Refused Kalshi demo/production switch surfaces nothing | `SettingsPanel.tsx:123-133`; `index.ts:309-322`; contrast `App.tsx:194-201` | the checkbox `onChange` has no try/catch, so the main-process refusal (positions held) is an uncaught rejection: no status line, no activity log entry, the box stays put with no reason | likely |
| B-58 | Lead-lag treats every non-`HttpError` pre-submission refusal as an uncertain fill | `leadLag.ts:797-808`; `engine.ts:218`, `:223`, `:800`, `:806`; `orderJournal.ts:39` | stake-cap, position-cap, cap-read-failure and journal refusals are plain `Error`s thrown before any POST, so the sweep logs "uncertain order" and keeps count/dollars/direction seat for the window (under-trading only; one verifier's refutation relied on BACKLOG #50's stale "limits are 0" — live limits are 10/80, so the throws are reachable) | hypothesis |
| B-59 | Sports-anchor freshness is measured from receipt time; bookmakers' `last_update` never read; Kalshi mid from a 10-min list cache | `sportsAnchor.ts:552`, `:685`, `:727`, `:786` (no `last_update` anywhere); `autoTrader.ts:1894-1895`, `:3123-3145` | the gap can be composed of a stale bookmaker line and a stale Kalshi mid and is never re-derived before execution; impact is bounded because the arm is maker-first (`makerStrategies`, `:283`) and rests 1c inside the live book, so only the taker fallback executes on the stale gap | hypothesis |

## 3. Top 5 by expected real-world impact

1. B-03 (exit persisted before removal). Already occurring: three confirmed resurrections in production; the trigger (a restart within the seconds-to-minutes between a full close and the end-of-scan persist) recurs with ~15 boots/day. Maximum plausible impact: a double-booked settlement of a few dollars feeding the ladder stop and kill switch, plus 20-35 min of blocked re-entry per event. Probability per day: high.
2. B-02 (`getPositions` never rejects). Needs a failure, but the failure has occurred twice (503 auth error, 500) and the fail-closed fix is documented as done. Maximum plausible impact: all 26 live positions dropped from the only ledger that manages exits, then re-bought ($1 each) — bounded in dollars, unbounded in evidence damage. Probability: low per day, certain to matter when it happens.
3. B-01 (ungated Reset). Needs one click, no failure. Maximum impact: 3 real cancels, 26 unmanaged positions, blind caps, cleared daily counters. Probability: low but purely operator-timing dependent; the settings page already treats the identical action as paper-only.
4. B-06 (Dutch baskets keyed by event ticker). Deterministic on the first live Dutch fill; the arm is armed (`dutchLiveEnabled true`, tiny-live) and has simply not filled yet. Maximum impact: every basket lost from the ledger within 25 min, duplicate baskets after the hour lockout; ~$1 each.
5. B-05/B-09 (untracked resting order / unadopted recovered buy). Need a lost response (45-s timeout after acceptance) or a crash between `pendingOrders.push` and the scan-end persist. Not observed yet in the r3 era. Maximum impact: one unmanaged position and one duplicate $1 entry per event, repeatable across the ~15 daily boots. Runner-up: B-08 (panel lost update) — needs a click within ~10 s of an hourly ladder write; undoes a real-money stop when it lands.

## 4. Restart safety verdict

- Crash during submission (before the socket write): questionable. The journal row stays `pending` forever (B-04); safe in direction (nothing re-sends) but the market's exits and entries are blocked for the life of the journal and a cap slot is consumed; IBKR's `prepare()` makes the window seconds wide. Kalshi/IBKR recover rows the venue did create; Polymarket US recovers nothing (no client-id lookup).
- Crash after exchange acceptance (before the local push/persist): unsafe. A resting Kalshi maker order is never cancelled or adopted (B-05); a filled IOC is never adopted (B-09); the churn guard forgets the market (B-12); convergence forgets its fill (B-38). The venue-wide cap re-reads positions, so the aggregate limit holds; the per-market dedupe does not.
- Crash during a partial fill: questionable. Maker slices already promoted are persisted only at scan end; a stopped-strategy rest promotes nothing while it rests (B-17); a slice can be lost to the 200-fill window (B-53); Dutch partials are booked as complete (B-24).
- Crash after a full fill (entry): questionable — `openTrades.push` happens in memory and persists at scan end, so the position is orphaned until the next venue read alerts (B-05 path). Crash after a full exit: unsafe — the exit is persisted with the trade still open (B-03), observed three times.
- Crash during settlement: unsafe for `closeTrade`/mini paths (B-03 double-settlement variant, deterministic when the market resolves before the 3-miss drop); `trySettle` itself uses the safe order. State-file integrity on abrupt power loss is unverified and unflushed (B-31); a quarantined trader file comes back on code defaults with migrations skipped (B-13).
- Could not verify: whether the sentinel/scheduled-task restarts kill mid-tick (SIGKILL) or wait; NTFS behaviour under power loss.

## 5. Order-lifecycle verdict by venue

Kalshi (live, 26 positions, 3 rests):
- Submission: safe — journaled first, POST never auto-retried, order-group retry only after an explicit rejection, `client_order_id` supplied. Acknowledgement: unsafe for the ambiguous case — a 5xx/timeout after `onSubmit` is a permanent pending row (B-04); an accepted-but-lost maker order is never cancelled (B-05); a recovered buy is never adopted (B-09). Fill: taker fills are sized from `fill_count` (partial correct); maker fills promoted per tick from the open-orders list; the fee on fractional counts is mis-stated in the ledger (B-34); fills archived with the wrong side/outcome (B-23). Partial fill: Dutch accepts partials as complete (B-24); a stopped strategy's rest promotes nothing (B-17); late slices can vanish (B-53). Cancellation: orphan cancel dead (B-05); refused cancels retried every 30 min with fills unpromoted meanwhile (B-17); expiry cancel is race-safe. Ambiguous response: exits that filled are never booked (B-25). Reconnect: n/a (REST; the websocket is shadow-only). Reconciliation: `getPositions` cannot fail (B-02), so the ledger can be wiped on an outage, Dutch baskets are always dropped (B-06), a failed market read drops a settled trade (B-54), resurrected trades are dropped as orphans (B-03). Settlement: `trySettle` is safe in ordering but can double-settle a resurrected trade (B-03); consensus void positions grade into the new cohort (B-20); `netCentsOf` and evidence weighting are biased (B-21, B-34).

Polymarket US (funded, every arm held):
- Submission journaled; no client-id recovery at all (every ambiguous response is a permanent pending row, B-04); `venueStatus` never reported so the engine cap reservation is released (B-14); the mode-switch guard ignores resting orders (B-11); expired-order rows are deleted in the cancel race (B-16); fallback attribution ignores outcome/side (B-26); the paper lab's universe is a 3,000-row slice (B-18); paper and live closes share one research log (B-48). Could not verify: live submission/fill/cancel behaviour (no live arm; only public GETs were made), `GET /v1/order/{id}` behaviour for expired orders.

IBKR / ForecastEx (funded $100 on 09-19, lab paper, no live strategies):
- Terminal detection and completed-order recovery are dead on the real message shape (B-07); a crash during the multi-session `prepare()` leaves an unsent pending row (B-04); every IBKR order releases its reservation (B-14); closes can be refused by the stake cap for cheap large positions (B-52); a corrupt journal closes an uncertain row as rejected (B-42). Could not verify anything against the Gateway (down at audit time); YES+NO netting, IOC acceptance and the $0.01 fee are unexercised assumptions (§102).

## 6. Risk-control bypass attempts

- Reset the trader in live mode: bypass found (B-01).
- Failed balance read during a breached daily loss: bypass found (B-10) — kill silent, equity cap skipped for that scan.
- Position cap via cached count and released reservations: bypass found, bounded (B-14) — engine cap only; strategy caps (60/48) bind first.
- Stale panel write vs ladder stop/cool-down: bypass found (B-08).
- Churn guard across restarts: bypass found (B-12).
- Mid-scan strategy flag flip: bypass found, one scan (B-39).
- Execution-mode flip while mini orders rest: bypass found (B-11); flip while the Kalshi trader holds anything: prevented (`index.ts:165-171`).
- `executionMode` malformed in `config.json`: bypass found, requires a hand edit (B-40).
- Kill-switch keystroke trip: fail-closed false trip (B-29), no bypass.
- Direction-seat/window-budget double spend across the seven concurrent lead-lag pair tasks: prevented (synchronous check-then-reserve before the first await, verified `leadLag.ts:753-779`).
- IPC mode flip between `executeSignal`'s mode read and the engine's: prevented (synchronous path; guard refuses while anything is held).
- Lead-lag/convergence/quoter bypassing the engine cap: prevented (`routedAdapter` routes `placeOrder` through `engine.placeOrder`, `engine.ts:684`; `subEngineKilled` fails closed on an undefined equity).
- Automatic re-POST of a timed-out order: prevented (`http.ts:80`; the Kalshi order-group retry follows an explicit rejection).
- Stake cap on `closeFrom` exits: over-refuses rather than bypasses (B-52).
- Journal-pending reservations inflating the cap: intended and observed correct (0 pending rows today).

## 7. Metrics/data-integrity issues

Affecting automation or eligibility: B-19 (checkpoints skipped on three live arms now), B-20 (void consensus positions grade into the restarted cohort), B-21 (equal-per-trade mean vs contract-weighted estimand), B-22 (quoter judged on other arms' weather settlements), B-36 (Dutch never graded), B-37 (convergence graded on requested count), B-03 (double-counted settlements after a resurrection), B-25 (lost exits), B-34 (fee on rounded C in `netDollars`), B-46 (review can change live size knobs). Hiding losses / false profitability: B-03 (a phantom settlement can turn a stopped loss into a booked win), B-25 case B, B-41 (legacy split), B-49 (`last24h` overstated window). Research contamination: B-18 (paper lab universe), B-23 (fill direction archive, D5), B-32/B-33 (lead-lag shadow and latency measurements), B-43 (paper/live rows commingled), B-48 (mini research log mixes modes), B-27 (alert channel noise dilutes the one real orphan signal).

## 8. Expensive code with thin tests

1. `engine.placeLiveOrderReserved` release rule (`engine.ts:245`): no test drives an adapter result with `shares 0` and a `venueStatus` other than the literal `'resting'` (Polymarket US shape, IBKR `'Submitted'`, Kalshi V2 with no status). Missing test: two back-to-back GTC orders under `maxOpenPositions 1` with `{shares:0,status:'open'}` must have the second refused.
2. `KalshiAdapter.getPositions` (`kalshi.ts:815-866`): no test asserts that an `authGet` failure propagates. Missing test: `authGet` rejecting 503 on every read -> `getPositions()` rejects; `readOpenPositionCountNow` throws `Position cap check failed`; `reconcileLedgerWithVenue` returns without dropping.
3. `orphanSweep` (`autoTrader.ts:3492`): no test at all. Missing test: a resting order with a `randomUUID()` client id absent from `pendingOrders` must be cancelled.
4. `closeTrade`/`recordExit` persistence ordering (`autoTrader.ts:3796-3797`; mini `:1170-1171`, `:1296-1298`): no test reloads the state file between `recordExit` and the scan-end persist. Missing test: after a full close, the on-disk file must not contain the trade while `perf.realizedPnl` includes it; a reloaded trader must not settle it again.
5. IBKR `terminal()`/`findOrderByClientId` (`ibkrLab.ts:262-266`, `ibkrAdapter.ts:140-141`): the suites drive hand-written fakes that invent `clientId`/`orderId` on completed orders. Missing test: completed rows shaped like the decoder's output (`orderRef`, `permId`, no `orderId`/`clientId`) must still close an unfilled IOC and submit a live exit.

## 9. Documentation contradictions

- `docs/DEVELOPER-HANDBOOK.md:532`: `orphanSweep()` "cancels untracked `ot-` orders" — no `ot-` id has been issued since 2026-09-15 (B-05).
- Handbook:572: `dutch` "unwinds partials" — the live `executeDutch` accepts partials and unwinds whole venue positions; the audited code is the recorder-only engine (B-24). BACKLOG/REVIEW-CHANGES closed the accepted-vs-filled audit against `dutchBook.ts`.
- Handbook:376: execution-mode switch "refused while positions or orders are held" — mini resting orders are not counted (B-11).
- Handbook:793-796: nightly review "never touches arms, sizes, limits or keys" — `quoterMaxMarkets`/`convergenceMaxDailyTrades` are ladder size knobs and are applied to live arms (B-46).
- Handbook:427-430 / REVIEW-CHANGES:4344 (§127 F-05): fractional C is "the only fee path" and rounding is "gone" — `entryFeeDollars`/`netCentsOf` still round (B-34).
- REVIEW-CHANGES:4414 (§129 F-01): `closeFrom` fix "verified (`placeLiveOrderReserved`, `placeOrderChecked`)" and "skip the cap" — `placeOrderChecked`'s `recordFill` is unfixed (B-35) and the stake cap still applies to closes (B-52).
- REVIEW-CHANGES:145: "`countOpenPositions` fails closed" — defeated by `getPositions` never rejecting (B-02); the engine comment `engine.ts:757-758` repeats the claim.
- REVIEW-CHANGES:4152/4187 (§118): the paper lab reads the catalog index — it does not (B-18).
- Handbook:394: `config.json` "writes in place" — `config.ts:110` uses `writeFileAtomic`; meanwhile the trader/ladder/sub-engine files are the unflushed ones (B-31).
- BACKLOG.md:619 (#50): "engine-level backstop is switched off (limits 0)" — live `config.json` has `maxStakePerBet 10, maxOpenPositions 80`; stale, and it misled one verifier (B-58).
- `AutoTraderPanel.tsx:266`, `:397` tooltips: "LIVE disarmed" — the code never disarms (§16.6 documents only the `ipc.ts` comment) (B-50).
- `docs/PREREGISTERED-polymarket-consensus.md:154-155`: "the arm restarts its evidence from this amendment" — the 12 open positions still settle into the restarted key (B-20).
- Handbook:904 / §12.15: "every contract weighted equally" — true for the labs, not for the Kalshi trader's ladder evidence (B-21).
- Handbook §16 Sept-15 note: "unknown submitted orders remain reserved until positively identified" — never-created orders cannot be identified and the reservation also blocks exits (B-04).

## 10. Things investigated and concluded probably correct

Refuted by the verifiers (not resurrected):
- Amend V2 `fill_count` double-promotion: `p.promoted = am.fillCount` sits inside `if (newly > 0.005)`, so a non-crossing amend (fillCount 0) never resets `promoted`; a crossing amend self-corrects on the next reconcile.
- Dutch sub-engine leg that throws is neither counted nor unwound: `dutchCfg()` hard-codes `dutchLiveEnabled: false` (`autoTrader.ts:4147`), so `dutchBook.ts`'s execution loop never places an order; the same fact refutes "two Dutch executors run live at once" (the two-executor half of B-24's source was dropped).

Finders' own rejected suspicions, confirmed not to be defects: HTTP client retries of POSTs (`http.ts:80`, GET/DELETE only); journal write failure inside `onSubmit` marking a sent order rejected (`onSubmit` fires synchronously before every POST); Kalshi order-group re-POST (follows an explicit rejection, same client id); placement summaries plus reconciler rows double-counting history (different id namespaces, `visibleTrades` hides covered summaries, `recordMany` dedupes); reservation tokens/journal rows/venue snapshot triple-counting (errs toward the cap); direction-seat double spend across concurrent pairs (synchronous reserve before the first await); Polymarket `clobTokenIds[0]` inversion (verified against Gamma and the fill archive); two pairs mapping to one 15M ticker (exact `close_time` match, one open market per series); lead-lag fee multiplier (recorded fees match the venue); consensus NO pricing as `1 - yes bid` (correct complement, same leg as `poly_price`); taker IOC partial treated as full (sized from `fill_count`); weather strike semantics (`greater`/`between`, verified live); Polymarket US fee rounding (differs only at an exact half-cent); `calibratedYesRate` negative branch (unreachable below the favorite band); `mapKalshiSettlement` `result` for void/scalar (no consumer reads it); migration v25-before-v24 ordering (synchronous, persist(27) at the end); status word `resolved` for paused markets (booking needs an explicit yes/no); reconciler crash/backfill duplication (three idempotent guards, 3,089/3,089 distinct); lead-lag window epoch units (seconds throughout); UTC day roll (documented, backlog 52); `hourOfWeek` local time (research feature only); episode file local-day naming (rows carry ms timestamps); `getPositions` `limit=200` truncation (30-32 positions, far from full); `submitLive` "no order ID" (both venues always return one); Kalshi fill_count integer (fractional strings observed); `getOpenOrders` without `exchange_index` (spec says omit = all shards); `count.toFixed(2)` overrun (<1c); IPC mode flip between mode read and engine check (synchronous, guard refuses while anything is held); `setConfig -> restartTimer` re-arming one-shot timers (every sub-engine has a running guard); mini v9 `amountPerTrade 1000` on a fresh file (boot reconcile + engine stake cap 10 + paper balance); double-click "Close" (reduce_only + venue count); IbkrPanel close price inversion (inverted again in `closeAsBuy`, net correct); the lab's `minTradeQty`/tick assumptions; IBKR OrderState field types; TWS farm notices (routed to `info`); client ids 17091/17093; lab live entries vs the $10 cap at 1-4 contracts; paper YES/NO pairing fee scaling; `void` promises on timers (every target catches internally); Polymarket US `getFills` missing execution fields (all 432 rows carry an order id); IBKR `reqExecutions` session scope (polled every 60 s while live); lead-lag two-direction sweeps on one ticker (per-row grading sums to the venue close); two Kalshi arms on one market in one scan (sequential executes re-check `entryBlocked`); reconcile timer racing `manageExits` (resolved markets skipped, `removeTrade` idempotent); mini two-sided micro-maker double fill (legs sum to the captured spread); quarantined `kalshi-auto.json` re-arming the ladder (`liveArmed` defaults false); `tradeSmallEntry` re-arming on a timer (backlog 26, documented).

Reversals of rejected suspicions: the finders rejected the `getPortfolio` cross-mode fallback as unreachable ("the renderer never passes a mode"); `App.tsx:66-70` passes the other mode every refresh, so it stands as B-15. The finders rejected "Kalshi V2 no `status` releases the reservation" as immaterial; it is real and merged into B-14 with the masking cap noted. The finders' "convergence and fade are always on the same side" ignores that fade enters hours before T-5 (B-28).

Verifier narrowings applied above: B-06's duplicate-basket timing (60-min churn lockout after the drop); B-24's "two executors" dropped; B-29's vector corrected from the lead-lag timer to the in-flight scan; B-32/B-33's fill example corrected; B-35's venue list (IBKR only); B-14's Kalshi variant kept as low-confidence; B-56's "stalls all coins" corrected to "skips subsequent ticks"; B-52's reachability corrected (manual panel, not the lab); B-30's "hang" corrected to "crash".

## 11. Could not check

- Whether Kalshi `/portfolio/orders` or `/historical/orders` ever lists an order that was never accepted, and whether `/historical/orders` exists at all (only authenticated GETs could settle it; none were made). Determines whether B-04 is "permanent" and whether Kalshi recovery throws every run.
- Production frequency of POST 5xx/timeouts under the 09-15 limiter and Kalshi's behaviour on a timed-out POST (whether the order is created): the only evidence is pre-journal (18 POST 503s on 2026-09-03); 0 pending rows exist today.
- Whether `/portfolio/positions?limit=200` without cursor following truncates once >200 rows per shard accumulate (the merged-count log counts only non-zero rows).
- Wh

- Whether Kalshi ever returns a `status` word on the V2 create response in practice (the vendored schema omits it) and whether asynchronous IOC fills can arrive after the create response (all observed fills reconcile, so no evidence of it).
- Kalshi post-only rejection behaviour (HTTP error vs accepted-then-canceled), which `executeMakerEntry` handles both ways; not verifiable without placing an order.
- Runtime confirmation of B-03's double-settlement variant (only the orphan-drop variant is in the logs; the resolved-market variant follows from the code).
- Round-trip times of the two unauthenticated Kalshi reads on the trading box (B-33's unmeasured quote age).
- Whether `GET /v1/order/{id}` on Polymarket US returns 404 or is rate-limited alongside `/portfolio/activities` for expired orders (decides whether B-26's fallback is systematic or rare); whether the venue accepts a fractional `quantity` on the partial-close SELL path; whether `trade.id` is unique per execution.
- The engine-side catalog index size within 72 h (to quantify B-18 precisely; only the moneyline subset was readable).
- Everything IBKR-live: FORECASTX acceptance of IOC on these OPT contracts, YES+NO netting at $1, the exact $0.01 exchange fee, retention of `reqExecutions`/`reqCompletedOrders` across a Gateway restart, whether TWS re-sends bound orders on every connection, back-to-back sessions on one client id. The Gateway was down at audit time and only public GETs were permitted.
- NTFS behaviour on power loss for unflushed write+rename (B-31) and whether the sentinel/scheduled-task restarts kill mid-tick; the ~18 boots/day figure is quoted from BACKLOG.md:226 (main.log shows 343 boots in 22 days).
- Whether Kalshi always populates `settled_time` on settlement rows (`mapKalshiSettlement` falls back to 0, silently excluding a row from the venue-day kill ledger).
- Whether ntfy's free tier has ever rate-limited this topic (B-27's "real alerts dropped" consequence is inferred from `alert.ts` swallowing failures, not observed).
- Whether a ladder transition or nightly-review apply has ever coincided with a panel write (B-08 is latent: 0 `manual change in the panel` lines).
- Kalshi's published fee schedule (kalshi.com returned 429/a security checkpoint; docs pages 404); the 0.07/0.0175 coefficients and 4dp-ceil rule are taken from the repo's own fills-archive audit (`kalshiFee.ts`, §127).
- IBKR/ForecastEx commission pages (403/404); the flat $0.01/contract matches `ibkrAdapter.ts:95`'s stated schedule but was not verified externally.
- Test coverage baseline: the finders reported `npx tsc --noEmit` clean and `npm test` green (15 `*.test.ts` files under `scripts/tests`); none of the suites exercises the five gaps in section 8, a never-found journal row over time, `orphanSweep` with UUID ids, the cap-disabled `closeFrom` path, fallback snapshot ageing, the churn guard across a restart, an unparseable `kalshi-auto.json`, the mode-switch guard for mini resting orders, `MiniAuto.managePendingOrders`' fallback attribution, `PolyPaperLab` discovery against the index, `traderEvidence` against a re-baselined accumulator, or the renderer panels' write paths (the §123 renderer harness was removed).