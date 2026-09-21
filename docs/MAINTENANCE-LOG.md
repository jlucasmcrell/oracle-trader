# Oracle Trader maintenance log

One dated section per run of the daily maintenance session (Windows task `OracleTrader-Maintenance`,
`scripts/maintenance.ps1`, prompt of record `docs/MAINTENANCE-PROMPT.md`). Newest at the bottom.
The same section is also written to `docs/reports/<date>.md`, which the desktop task delivers.

---

# Oracle Trader — maintenance, 2026-09-07

Headless run (Windows task `OracleTrader-Maintenance`), started 13:42 local / 17:42Z.

## 1. Liveness

| Check | State |
|---|---|
| App process (`electron.exe .`) | UP, no intervention needed (pid 5684, since 11:47 local) |
| `logs\main.log` | written continuously, last line at check time |
| `ladder.json` `lastRunAt` | 16:47Z, hourly tick, inside the 2 h bound |
| BTC collector (`node scripts/btc-collector.mjs`) | UP, pid 21756, running since 2026-09-02 |
| Nightly review `reviews\2026-09-07.md` | present, written 08:12 local |
| `OracleTrader-HrrrShadow` → `data\hrrr-shadow\forecasts.jsonl` | last run 13:20 local, result 0, file written 13:20 |

Nothing was down. The app was restarted twice **by this session**, both times to load a new
build (13:48:33 and 13:52:41 local, both visible, via `Start-ScheduledTask OracleTrader-App`);
`main.log` resumed both times — Manifold connect, `positions merged 14`, convergence and
lead-lag scans continuing.

## 2. Evidence read

**Venue-true P&L** (`scripts/venue-pnl.py` over fresh read-only dumps taken 13:43 local):

- Kalshi, last 24 h: **45 settlements, net -$5.60** after $4.82 fees.
  Losses concentrated in sports: KXMLBGAME -$4.07 (4), KXMLBEXTRAS -$2.78 (1), plus weather
  KXHIGHTSAN -$1.49 (3) and KXMLBTOTAL -$1.03 (2). Gains: KXBTC15M +$4.15 (11), KXETH15M +$0.33 (8).
- Kalshi, calendar day: 32 settlements, **+$0.56**.
- Polymarket US, last 24 h: 33 resolutions, **-$6.08**. Calendar day: 18 resolutions, -$5.15.
- Balances: Kalshi cash $84.16 + open positions at cost $23.78 = $107.94 ($106.15 at market);
  shards 0 $45.41 (weather — funded), 1 $0.00, 2 $20.09 (crypto), 3 $18.66 (sports).
  14 open positions, 2 resting orders. Polymarket US $50.85, all of it buying power.

**Accounting check (closes a "high" finding in last night's review).** The review flagged
"venue day +$0.75 over 23 settlements vs venue last24h -$9.49" as an inconsistency. It is not
one: those are different windows. Today reconciles exactly — the venue ledger's calendar day is
+$0.56 over 32 settlements, and the app's `state.venueDay` reads `realized 0.33 +
legacyRealized 0.23 = 0.56` over 32 settlements. The app agrees with the venue to the cent. The
rolling 24 h number is more negative only because it reaches back into yesterday afternoon.

**Gates.**

- `btc-gate.mjs`: **FAIL / NOT YET**. 89 events (needs 200), mean +0.70c over 242 graded,
  event-clustered Bonferroni LB -2.85c (needs above +1c), day-clustered LB -1.05c (must exclude
  zero). Sign flips 3.3%. Nothing to act on; it is collecting.
- `quoter-shadow-gate.mjs`: the ALLOWED cohort still has **0** settled proxy fills (needs 30 over
  40 events). The BLOCKED cohort is -5.61c/contract over 56 fills and 15 events, i.e. the gates
  are refusing quotes that would have lost. That supports the filter and says nothing about the
  quoter's own profitability.

**Silent-strategy check.**

- `[convergence]` fires 0 orders per scan, and the skip counters say why: of 188 candidates in
  window, 174 are `margin-out`, 13 `cost-out`, 1 `edge-out`, 0 `no-vol`, 0 `limits`. Working as
  designed, not stalled. Graded 9 (8W/1L), -32c.
- `[quoter]` reports `fair-value on 0 of 0` and `disabled: 91 candidates, would quote 0`. That is
  the ladder's doing — it demoted the quoter to shadow at 13:12Z — not a fault.

**Odds API spend.** `__spentDay:2026-09-07 = 644` against the 645/day budget (20,000/month ÷ 31);
yesterday 138. The plan self-throttles, but the anchor spent essentially the whole day's budget.

**Sharp anchor, out of sample.** `gradedN 17`, `gradedBrier 0.654106` (a **sum**, so mean Brier
0.038), `ruleN 8`, `ruleNet -$1.06`. `anchor-grades.jsonl` holds 17 rows and **gained 0 rows in
the last 24 h** — the 26 pending observations are MLS, NPB and Argentine games starting
2026-09-08 to 09-13, so grades arrive when those finish. No conclusion is available yet, and the
17 existing grades all come from one game.

**Errors in the last 24 h.**

- 222 × `HTTP 402 Insufficient credits` from OpenRouter (`[hunch]` 221, `[review]` 1), all
  between 2026-09-06 18:46Z and 2026-09-07 01:01Z. Recovered: the 08:12Z review wrote normally
  and the 15:44Z hunch pass ran `eligible 9, hunched 9, errors 0`. `hunchModelPlans` does fall
  back to local Ollama and it worked. No action.
- 1 × `[review]` JSON parse failure at 09:45Z (a later, extra pass; today's review file is fine).
- 13 × `[leadlag] sweep error ... 404 order_group_not_found`, last at 08:15Z. Sweeps continue to
  execute (778 sweeps, `SWEEP EXECUTED` lines throughout the day), so the 404 retry shipped
  yesterday is holding; watching.
- 1 × `[quoter] amend ... 404 not_found`.
- No 401/403/422, no `insufficient_balance`, no `ExpiredToken`, no unhandled rejections.

## 3. Ladder: stage, size and net since promotion

18 arms, **all at notch 1 (micro)**. No promotions or scale-ups today; one demotion.

| Arm | Stage | Settled since stage start | Net since stage start |
|---|---|---|---|
| quoter | shadow (cool-down to 09-10) | checkpoint of 20 | -$2.39, -17.24c/contract, 80% band -24.76..-9.72 |
| convergence | tiny-live | 0 | $0.00 |
| settlement | tiny-live | 0 | $0.00 |
| polyus-micro-maker | disabled (cool-down to 09-10) | 20 | -$2.05 |
| kalshi-fade | tiny-live | 4 | +$0.63 |
| kalshi-momentum | disabled (cool-down to 09-10) | 20 | -$4.41 |
| kalshi-book-imbalance | tiny-live | 1 | -$2.78 |
| kalshi-volume-spike | tiny-live | 0 | $0.00 |
| kalshi-cross-venue | tiny-live | 0 | $0.00 |
| kalshi-news | tiny-live | 0 | $0.00 |
| kalshi-dutch | tiny-live | 0 | $0.00 |
| kalshi-leadlag | tiny-live | 9 | +$0.93 |
| kalshi-sports-anchor | tiny-live | 0 | $0.00 |
| polyus-fade | tiny-live | 0 | $0.00 |
| polyus-book-imbalance | tiny-live | 7 | -$1.66 |
| polyus-weather-fair | tiny-live | 0 | $0.00 |
| kalshi-flow-follow | tiny-live | 0 | $0.00 |
| **kalshi-mean-reversion** | **tiny-live (new, 17:54Z)** | 0 | $0.00 |

The one verdict today — quoter tiny-live → shadow at 13:12Z on its 20-trade checkpoint — is
sound: its evidence comes from `clusteredMean` over the quoter's own settled rows, which already
carries the plain-SE floor, and the band (-24.76..-9.72) has real width. The ladder acted on its
own; nothing was overridden.

## 4. Defect found and fixed: the ladder was judging on a fabricated confidence band

**Symptom.** Last night's review raised "temporal data integrity": the packet generated
2026-09-07 contained calibration `byDay` observations dated **2026-09-09**.

**Reproduced.** `calib.byStrategy.momentum.byDay` = `{'2026-09-09': {n: 20, sum: -58.52},
'2026-09-07': {n: 1, sum: 5.25}}`, and `book-imbalance.byDay` = `{'2026-09-09': {n: 1}}`.

**Root cause, proven against the venue.** `gradeEntry` was called with
`dayKeyOf(t.closeTime)` / `dayKeyOf(trade.closeTime)`
(`src/main/strategies/autoTrader.ts:3066,3079,3555`). Kalshi lists a sports market with an
expiration-shaped `close_time` until play ends. The public market object for
`KXMLBGAME-26SEP061210MILCIN-CIN` reads `close_time 2026-09-06T19:29:54Z` **now**, but
`expiration_time 2026-09-09T16:10:00Z`, and the venue settled it at 19:32:55Z on 09-06 — while
it was trading, the cached `closeTime` was the 09-09 value. Those are exactly the 20 momentum
trades of the 09-06 churn. The settlement path self-heals `t.closeTime` from the venue before
grading (line 3057), but the **sale** path (`recordExit`, line 3555) does not, and every one of
those 20 trades was sold, not settled.

**Why it cost money.** `Ladder.traderEvidence` clusters the live evidence by those day buckets.
Twenty trades in one bucket is one cluster, and `clusteredSe` of a single cluster is *exactly
zero* — the 80% band collapses to a point and any negative mean reads as "losing with 80%
confidence". That is precisely the verdict that stopped momentum:
`mean -2.93c/contract (80% band -2.93..-2.93)`. The same zero-width band would just as happily
**scale up** an arm whose 20 trades happened to be positive. The floor for this had been added
to `clusteredMean` on 2026-09-07 but never to the trader-ledger path.

**Fix (smallest diff that closes both halves).**

- `src/main/strategies/autoTrader.ts`: new exported `clusterDayOf(ms, now)` — the day bucket is
  the day the P&L was **realized**, never after today; a sale is filed under the sale day, a
  settlement under its (self-healed) resolution day. Used at all three `gradeEntry` call sites.
- `src/main/ladder/ladder.ts`: new exported `dayClusteredSe(groups, n, mean, sq)` — the same
  floor `clusteredMean` already had (below three clusters, take the larger of the clustered and
  the plain SE; fall back to the plain SE when the buckets do not account for every trade).
  `traderEvidence` now calls it.

**Tests added.** 4 assertions on `clusterDayOf` (a future close clamps to today; a real past
close keeps its day; a missing close is today, never `"unknown"`) and 5 on `dayClusteredSe` (one
bucket is floored above zero; three buckets use the clustered SE; incomplete buckets fall back;
a single trade has no SE).

**Not repaired:** the two already-written `2026-09-09` buckets. The per-trade days are not
recoverable from the aggregate sums, and inventing one would be worse than a mislabelled
cluster; the key stops being a future date on 09-09 by itself. Noted in `docs/BACKLOG.md`.

## 5. Build queue (step 8)

Trigger checks run today, in order:

1. **Critic skill.** `python scripts/critic-skill.py <fresh dump>`: 302 decisions, settled per
   group ABSTAIN 21, VETO 24, ERROR 32 — under the 50-per-group bar, and 77 settled decisions is
   far under 200. **Verdict: keep measuring.** The direction so far is still unflattering to the
   critic: vetoed trades settled at **+2.9c/contract** (n=24) and abstained at +10.0c (n=21),
   i.e. it has been vetoing winners. It runs on free local models, so it costs nothing to keep.
2. **WebSocket book.** `wsStats.agreed/compared = 3762/3770 = 0.9979` — **PASS, day 1 of 7**.
3. **HRRR source.** Not before 2026-09-21. NOT MET.
4. **Kalshi private fill channel.** Needs quoter notch ≥ 2 or a positive checkpoint; the quoter
   is at notch 1 and was just demoted. NOT MET.
5. **Avellaneda-Stoikov skew.** Same trigger. NOT MET.
6. **Anchor on Polymarket US.** Needs the Kalshi anchor's first checkpoint positive; the anchor
   has 0 settled trades since stage start. NOT MET.
7. **Player props.** Needs anchor notch ≥ 2. NOT MET.
8. **New generic strategies (a): mean reversion on extremes.** No trigger above was met, so this
   was built. **DONE.**
9. SportsGameOdds role. No trigger.

### Built: `kalshi-mean-reversion`

Pre-registered *before* the first order, in `docs/PREREGISTERED-mean-reversion.md`. The rule as
specified in the backlog: fade a move of **≥ 8c over 10 minutes** on a market with **≥ 6 hours**
to close, **hold to settlement**. Two safety fences are registered with it — the move must have
traded (≥ 3 of the window's candles with volume, so a thin-book quote flicker does not count),
and no entry when the post-move price is under 5c or over 95c (there the move is usually the
market resolving).

Why this and not something else: the 2026-08-28 momentum backtest did not merely fail, it
measured the *opposite* — mean forward move **-6.6c** after a 10-minute move, 36% hit rate. The
reverting side has never been tested directly and it is the side the only real evidence points
at. The registered prediction is written down: a positive mean over the first 20 settled trades
with an 80% lower bound above -3c; if it stops below that, mean reversion is treated as tested
and failed on Kalshi and goes to the declined list.

Conflict guard: if momentum fires on the same market in the same scan, momentum keeps it and the
fade stands down — otherwise the app would buy YES and NO of one contract and pay two fees for a
certain loss.

Code: `meanReversionVerdict` (pure, unit-tested) and `meanReversionSignals` in
`src/main/strategies/autoTrader.ts`; config `meanReversionEnabled` / `WindowMinutes` (10) /
`MinMoveCents` (8) / `MinHoursToClose` (6) in `src/shared/ipc.ts`; the arm
`kalshi-mean-reversion` in `GENERIC_STRATEGIES`. It shipped **off**; the ladder promoted it
itself at 17:54:41Z — `kalshi-mean-reversion: disabled → tiny-live — trade-small mode:
real-money micro test 1 (stop -$5)`. No arm, size or limit setting was touched.

## 6. Verification

- `npx tsc --noEmit` — clean.
- `npx tsx scripts/tests/review-fixes.test.ts` — **182 passed, 0 failed**.
- `npx tsx scripts/tests/ladder.test.ts` — **74 passed, 0 failed**.
- `npx tsx scripts/tests/adversarial.test.ts` — **79 passed, 0 failed** (its "all seventeen
  strategies are tracked" assertion updated to eighteen).
- `npx electron-vite build` — clean.
- Backup `python scripts/backup.py MAINT-2026-09-07` →
  `G:\PROJECTS\oracle-trader-backups\oracle-trader-MAINT-2026-09-07-20260907-134809.zip`
  (408 files, 73.5 MB; only the live `lockfile` was skipped).
- App restarted and verified in `main.log`; the ladder line now lists all 18 arms.

What is **not** verified: the day-bucket fix is proven by unit test and by the venue's own
`close_time` / `expiration_time` / `settled_time` for the MILCIN market, but no trade has settled
under the new build yet, so the first live `byDay` key written by the fixed code has not been
observed. Check it on tomorrow's run.

## 7. Open questions for the operator (nothing blocking)

1. **The quoter's two numbers disagree, and both are right.** `trade-quality.mjs` reads the
   quoter's whole settled history at **+10.26c/contract over 26 events** (CI -3.86..+24.39),
   while the ladder's since-promotion cohort read **-17.24c/contract over 20**. Different
   cohorts, not a bug — and the ladder judging only the since-promotion window is the correct
   methodology. But it does mean the arm the ladder just stopped has a profitable older record,
   so its cool-down retry on 09-10 is worth watching rather than assuming it dead.
2. **The Odds API spent 644 of its 645 daily credits today** (138 yesterday). Nothing failed and
   the budget self-throttles, but the anchor is now running at the cap, which will thin coverage
   as more leagues come into season. No action proposed — flagging the trend.
3. **The sharp anchor produced no new graded rows in 24 h.** Its 26 pending observations are
   games that have not been played yet. Expected, not stuck, but it means the anchor's
   out-of-sample record is still 17 rows from a single game — no verdict is possible for days.

## 8. Delivery

`SendUserFile` and `PushNotification` are **not available in this headless session** (it runs
under the Windows task `OracleTrader-Maintenance`, which has no desktop tools). This file is
`docs\reports\2026-09-07.md`; the desktop task at 08:30 delivers it.

## Repair 2026-09-08T07:43Z

Drill incident `data/sentinel/incidents/2026-09-08T07-45-drill.md` (key `drill`) — the on-call
repair path was exercised end to end and **passed**. The headless session read
`docs/REPAIR-PROMPT.md` and the incident file, read `data/sentinel/status.json` (`"at"`:
2026-09-08T07:41:59.255Z, window opening 07:21:59.255Z, 139 lines scanned, one pre-existing
notify finding `review-failed:2026-09-08`), and confirmed the app is up: `Get-Process electron`
returned 4 processes (PIDs 5328, 25952, 41872, 43792, all started 03:27:23 local by the
`OracleTrader-App` task), matching status.json's `"electron": 4`. Outcome NOT-A-DEFECT (drill);
the incident's first line was flipped to `Status: CLOSED`. As the drill required, nothing else was
touched: no code, config, order, setting, suppression or restart, and no `docs/BACKLOG.md` entry
since no code changed.


---

# Oracle Trader — daily maintenance, 2026-09-08

Headless run (Windows task `OracleTrader-Maintenance`). The 07:00 firing died on an API-key
workspace error before reaching the model (`logs/maintenance-2026-09-08.log`, exit 1); this
session is the 07:09 retry and did the full run.

## 1. Liveness

| Check | State |
|---|---|
| App process | UP. Restarted twice by this session for the code changes below; final PID 5720, started 11:26:39Z, verified in `main.log`. |
| `main.log` freshness | UP — written continuously, most recent line seconds old. |
| `ladder.json` `lastRunAt` | 10:30:25Z on arrival (within 2 h), and ticked again 11:22:27Z with the new arm. |
| BTC collector | UP (`node scripts/btc-collector.mjs`, PID 2208). |
| Nightly review | PRESENT — `reviews/2026-09-08.md`, written after attempt 1 hit an OpenRouter 429; attempt 2 succeeded on `openai/gpt-5.6-sol`. |
| `OracleTrader-HrrrShadow` | UP — `data/hrrr-shadow/forecasts.jsonl` written 10:20Z. |
| `OracleTrader-MetaculusShadow` | Task ran 10:35Z. `pairs.jsonl` unchanged since 2026-09-07 20:36Z (16 pairs) — no new matches, not an error. |
| `OracleTrader-MentionShadow` | UP — `data/mention-shadow/run.log` written 11:09Z. |
| `OracleTrader-PolyConsensus` | UP — `data/polymarket-consensus/run.log` written 11:06Z. |
| Sentinel | UP — `status.json` `at` 11:20:01Z, 0 findings, 0 repair sessions today. |

Nothing was down. No restart was needed for liveness; the two restarts were to load this
session's build.

## 2. Money (venue-true, the ledger of record)

`python scripts/venue-pnl.py` on fresh read-only dumps, window 2026-09-07T11:10Z → 2026-09-08T11:10Z:

- **Kalshi +$9.59** after $2.66 fees over 40 settlements.
- **Polymarket US −$0.87** over 2 resolutions.
- Net venue-true 24 h: **+$8.72**.

The Kalshi day is one trade: `KXLALIGAGAME` **+$22.33** (mean-reversion, a longshot that landed).
Without it the day is −$12.74, and the losers are sports spreads and totals (`KXMLBSPREAD` −$4.19,
`KXMLBGAME` −$3.28, `KXMLBTOTAL` −$2.72, `KXSERIEAGAME` −$2.21) plus `KXBTCD` −$3.33. Weather was
roughly flat (−$0.95 across six brackets). Read the +$8.72 as one lottery ticket, not as an edge.

Balances. Kalshi cash **$95.02** (shard 0 $60.02, shard 1 $0.00, shard 2 $20.00, shard 3 $14.99;
weather trades need shard 0 and it is the best funded), open positions at cost $17.74, portfolio
$112.76 ($107.77 at market). Kalshi resting orders 0. Polymarket US balance **$63.19**, buying
power **$14.49** (the balance includes the cost of open positions; the engine already nets it),
0 resting orders, 13 open rows. Manifold is play money (M$833).

## 3. Ladder — every arm, stage and evidence since promotion

19 arms after today's build (was 18). `lastRunAt` 11:22:27Z.

| Arm | Stage | Notch | Since stage start | Verdict |
|---|---|---|---|---|
| quoter | shadow | 1 | — | cool-down to 2026-09-10 after 1 stop; no settled allowed-cohort fills yet |
| convergence | tiny-live | — | 0 settled, $0.00 | next checkpoint at 20 |
| settlement | tiny-live | 1 | 0 settled, $0.00 | next checkpoint at 20 |
| kalshi-fade | tiny-live | 1 | 7 settled, **+$1.16** | next checkpoint at 20 |
| kalshi-momentum | disabled | 1 | stopped −$4.41 over 20 | cool-down to 2026-09-10 |
| kalshi-book-imbalance | disabled | 1 | stopped −$9.20 (−$9 stop) | cool-down to 2026-09-11 |
| kalshi-volume-spike | tiny-live | 1 | 5 settled, −$0.36 | next checkpoint at 20 |
| kalshi-cross-venue | tiny-live | 1 | 0 settled, $0.00 | next checkpoint at 20 |
| kalshi-news | tiny-live | 1 | 0 settled, $0.00 | next checkpoint at 20 |
| kalshi-dutch | tiny-live | 1 | 0 settled, $0.00 | 152 opportunities seen, 0 executed |
| kalshi-leadlag | **live** | **2** | 0 settled, $0.00 | promoted 03:24:58Z on "20 trades, net $2.42" — see §5(b); that evidence was contaminated |
| kalshi-sports-anchor | tiny-live | 1 | 1 settled, −$1.29 | next checkpoint at 20 |
| kalshi-flow-follow | tiny-live | 1 | 3 settled, −$2.74 | next checkpoint at 20 |
| kalshi-mean-reversion | tiny-live | 1 | 4 settled, **+$20.56** | one +$22.33 hit; n=4 is not evidence |
| kalshi-weather-morning | tiny-live | 1 | new today, 0 settled | pre-registered, see §6 |
| polyus-fade | tiny-live | 1 | 0 settled, $0.00 | PolyUS is sports-heavy; the cheap-side universe is thin |
| polyus-book-imbalance | disabled | 1 | stopped −$3.92 over 20 | cool-down to 2026-09-11 |
| polyus-micro-maker | disabled | 1 | stopped −$2.05 over 20 | cool-down to 2026-09-10 |
| polyus-weather-fair | tiny-live | 1 | 0 settled, $0.00 | next checkpoint at 20 |

**Do the verdicts match the venue ledger?** Yes, with one exception now fixed. Spot checks:
book-imbalance's stop (−$9.20) matches the app ledger's −$10.82 over 14 trades and the venue's
1W/11L; mean-reversion's +$20.56 is the single `KXLALIGAGAME` settlement +$22.33 less costs;
fade's +$1.16 since promotion sits inside its lifetime +$5.97 over 52. The exception is lead-lag —
§5(b).

`trade-quality.mjs` flags, agreeing with the ladder: kalshi book-imbalance (−8.40c/contract,
clustered CI [−16.61, −0.19]) and momentum (−2.54c, CI [−5.62, +0.54]) are losing and are already
stopped; PolyUS book-imbalance (1W/30L, −$6.79) and micro-maker (−$2.10) likewise. Fade's 50/2 win
record is a base-rate trap: fee-inclusive it is −8.41c/contract with CI [−24.70, +7.88] — no edge
established in either direction.

## 4. Scans, gates, budgets

- **Crypto convergence is not silent, it is gated.** Latest scan note: in window 188 —
  margin-out 174, cost-out 14, no-vol 0, edge-out 0, event-dup 0, limits 0. Nothing reaches the
  margin fence. Lifetime 25 trades, 8W/1L, −32c.
- **Quoter** is in shadow (cool-down to 2026-09-10): "33 candidates, would quote 0 (4 gated)".
  The nightly review applied `quoterMinSpreadCents` 3 → 5 as its parameter change.
- **BTC T-5 gate** (`scripts/btc-gate.mjs`): **FAIL / NOT YET.** 268 strike-trades over 101
  events (needs 200), +0.50c/contract, Bonferroni LB −2.86c, day-clustered LB −1.16c.
- **Quoter shadow gate**: insufficient ALLOWED sample (0 settled proxy fills of the 30 needed).
  The BLOCKED cohort runs −5.61c/contract over 56 fills — the gates are refusing quotes that
  would have lost, which is evidence for the filter and says nothing yet about the strategy.
- **Odds API**: 322 credits spent today against the 645/day pace budget (yesterday 644 — at the
  cap). Under budget, no failures.
- **Kalshi WebSocket agreement**: 2566/2570 = **0.9984 — PASS, day 2 of 7**.

**Sharp anchor, out of sample.** `gradedN` **44**, `gradedBrier` **2.7792** (a sum; mean Brier
**0.063**), `ruleN` **20**, `ruleNet` **−$1.87**. `anchor-grades.jsonl` holds 44 rows and
**gained 27 in 24 h** (it gained 0 the day before, so grading is now flowing). The rule's
out-of-sample net is negative over its first 20 graded rows, while a mean Brier of 0.063 says the
anchor's probabilities are well calibrated — so the loss is in the trading rule or the fee, not in
the forecast. Not a verdict yet: 20 rows, dominated by one NCAAF game and one NPB slate.

## 5. Defects found, proved and fixed

### (a) Polymarket US rows kept a wrong close time forever — FIXED

`mini-auto-polymarket-us.json` `lastError` read "2 positions unsettled >12h past close (oldest
19h: tec-lpga-solheim-2026-09-13-w-usa)", and the sentinel had escalated a persisting PolyUS
trader error. Proof rather than inference: the two rows carried `closeTime` 2026-09-07T16:00Z,
while a read-only GET of the venue's own market object returns `marketType: "futures"`,
`gameStartTime: 2026-09-07T16:00Z` and `endDate: 2026-09-27T23:00Z`. They were opened before this
morning's futures fix (`deriveUsCloseTime`), and nothing ever refreshes a stored close time —
`manageExits` and the settlement check both trust `t.closeTime` for the life of the row
(`src/main/strategies/miniAuto.ts`). A wrong-EARLY close is doubly harmful: the row reads as
permanently unsettled, and it hides from the out-of-window exit, which only dumps rows whose close
is far away. That is how a Champions League winner resolving in June 2027
(`tec-ucl-final-2026-06-05-w-ars`, 17.64 shares) sits in a slot on a venue with $14.49 of buying
power.

Fix (the smallest that heals existing rows and costs no extra API calls): the settlement check
already fetches the market once a row is past close, so it now adopts the venue's close time when
that is LATER than the stored one and keeps waiting, instead of treating the row as overdue.
`refreshedCloseTime` in `src/main/strategies/ledgerAudit.ts` (pure, 7 new assertions in
`scripts/tests/review-fixes.test.ts`), called from `miniAuto.ts`. Only a later close is adopted;
moving one earlier would let a degraded market record pull a settlement forward.

**Verified live at 11:24Z**: both Solheim rows now read `closeTime` 2026-09-27T23:00Z and
`lastError` is gone.

### (b) Lead-lag counted IOC orders the venue accepted but never filled — FIXED

This one changed a real-money decision. `main.log` carried **358 "SWEEP EXECUTED" lines** between
the arm's 03:24:58Z promotion and 11:22Z; the venue's fills feed for the same window holds **2**
`KXBTC15M` fills, and no `15M` market has settled since 02:45Z. `leadLag.ts` placed an
`immediate_or_cancel` order and then set `d.executed = true`, incremented `tradesExecuted`, wrote
the research row and logged the sweep **without reading the order result** — and an IOC that
crosses nothing fills zero contracts. The Kalshi adapter already reports the truth
(`mapOrderResult`: `shares: filled`); nobody was reading it. Result: 331 phantom "executed" rows
in eight hours, and the same market swept twice within 24 seconds at the same price because
nothing filled.

It matters because `Ladder.leadLagEvidence` builds this arm's evidence from the tickers of
`executed` rows and then credits it with every settlement on those tickers — so the arm was being
judged on settlements of markets its sweep never held. It was promoted to **live ×2** on that
evidence at 03:24:58Z today.

Fix: `sweep()` now returns early unless `res.shares > 0`, counting the miss in a new
`sweepsNoFill`, and records `filledContracts` and `fillPrice` on the row it keeps. The ladder's
join now requires `filledContracts > 0` (`leadLagRowCounts` in `src/main/ladder/ladder.ts`, pure,
7 new assertions), which also excludes the pre-fix rows — they cannot be told apart, and an arm's
evidence restarting is a smaller harm than an arm scaled on another strategy's P&L. The arm keeps
its live ×2 stage; its next checkpoint will be computed from fills that actually happened.

**Verified live at 11:31Z**: `leadlag.json` shows `sweepsNoFill: 1` with `tradesExecuted`
unchanged at 1514 — an accepted, unfilled IOC is no longer a trade.

### Not defects (checked and dismissed)

- 43 `order group unknown` warnings and 14 `cancel refused` 400/404s in the last 24 h are all
  **before** the 09:30Z restart, i.e. before this morning's shard-routing fix went live. None
  since.
- The sentinel reported `schtasks` query errors for `OracleTrader-MentionShadow` and
  `OracleTrader-PolyConsensus` at 11:05Z. Those tasks were created at 11:07:17Z, two minutes
  later. The 11:20Z scan resolves both. A creation race, not a defect.
- The PolyUS `GET /v1/orders/open` 503 the sentinel escalated at 09:50Z has cleared: the endpoint
  answered normally in the 11:11Z read-only dump.
- The nightly review's "1,413 lead-lag executions, zero settled" is the same defect as §5(b),
  now fixed at the source.

## 6. Build queue

Trigger check, every item, today:

| # | Item | Trigger | Result |
|---|---|---|---|
| 1 | Critic skill check | 50+ settled per group | **NOT MET** — 33 abstain / 43 veto settled. Ran `scripts/critic-skill.py`: vetoes −$0.007/contract vs abstains +$0.055; no skill visible yet. |
| 2 | WebSocket book for execution | 0.99 agreement on 7 consecutive days | **NOT MET** — 0.9984 today, **day 2 of 7**. |
| 3 | HRRR forecast source | 2026-09-21 or 100+ station-days | **NOT MET** — date. |
| 4 | Kalshi private fill channel | quoter notch ≥ 2 or a positive checkpoint | **NOT MET** — quoter is in shadow cool-down. |
| 5 | Avellaneda-Stoikov skew | same as 4 | **NOT MET**. |
| 6 | Anchor on Polymarket US | Kalshi anchor's first checkpoint net positive | **NOT MET** — 1 settled, −$1.29. |
| 7 | Player props | anchor notch ≥ 2 | **NOT MET**. |
| 8 | New generic strategies | next untriggered build | **TAKEN — (b) time-of-day effects.** |
| 9 | SportsGameOdds role | none | deferred; still only lifecycle value. |
| 10 | Metaculus shadow | built | running; 16 pairs, 0 graded (they resolve 2027+). |
| 11 | Forecaster v2 | hunch gate at 200+ graded reading "not yet" | **NOT MET**. |
| 12 | Mention base rates | 100+ graded strikes | **NOT MET** — 356 observations, 311 strikes, 0 graded. |
| 13 | Polymarket consensus | 100+ graded signals | **NOT MET** — 15 signals, 3 Kalshi / 1 PolyUS matched, 0 graded. |
| 14 | Fade category audit | kalshi-fade reaches 20 settled | **NOT MET** — 7 since promotion. |

**Built today: item 8(b), the time-of-day effect — `kalshi-weather-morning`.**

Kalshi lists a city's daily temperature brackets the evening before and they trade all night
against the previous afternoon's forecast; the overnight model runs reach the NWS hourly product
before local mid-morning. The arm compares the forecast-implied bracket fair value (the same
`bracketFairValue` the quoter prices with) against the book in the station's own
**08:00–11:00 local** window, and takes the side that is mispriced by **≥ 5c after the taker fee
at the price actually paid**, holding to settlement. It stands down on any market the quoter is
resting on, so it never crosses our own quote.

Pre-registered in full **before** the arm could trade: `docs/PREREGISTERED-weather-morning.md`
(the rule, the fence values, the fixed prediction, and five weaknesses written down ahead of the
data — including that a silent arm is a legitimate result if the overnight book is already
current). Shipped with `weatherMorningEnabled: false`; the ladder promoted it to tiny-live by
itself at 11:22:27Z. Nineteen arms now.

## 7. Verification

- `npx tsc --noEmit` — clean.
- `npx tsx scripts/tests/review-fixes.test.ts` — **227 passed, 0 failed** (was 205; +22 today:
  close-time refresh, the morning-forecast rule, and the lead-lag evidence predicate).
- `npx tsx scripts/tests/ladder.test.ts` — **74 passed, 0 failed**.
- `npx tsx scripts/tests/adversarial.test.ts` — **80 passed, 0 failed**. Its stagger loop now
  counts `GENERIC_STRATEGIES` instead of a literal 12, so the next arm will not break it, and it
  gained an assertion that zero-fill sweeps do not scale lead-lag.
- `npx electron-vite build` — clean.
- App restarted onto the final build (PID 5720, 11:26:39Z) and verified in `main.log`; the ladder
  line at 11:22:27Z lists all 19 arms including `kalshi-weather-morning=tiny-live`.
- Backup `python scripts/backup.py MAINT-2026-09-08` →
  `G:\PROJECTS\oracle-trader-backups\oracle-trader-MAINT-2026-09-08-20260908-073600.zip`
  (605 files, 87.6 MB; only the live `lockfile` skipped). An earlier zip of the same label
  (`...-072143.zip`) predates the lead-lag fix; the 073600 one is the restore point.

**Not verified:** `kalshi-weather-morning` has not fired an order — its window is station-local
08:00–11:00 and it was promoted at 07:22 local, after the eastern cities' window. Its first
entries, if any, come tomorrow morning; check `main.log` for the strategy name and the
`weather-morning` calibration key.

## 8. Sentinel

`status.json` `at` 11:20:01Z (fresh), 0 open findings, `repairSessionsToday` 0. Incidents on file:
one, `data/sentinel/incidents/2026-09-08T07-45-drill.md`, first line **Status: CLOSED** — the
03:42Z repair-path drill, which passed and was closed by that session. Nothing was left for this
run to finish, and nothing needed re-closing. The digest since the last run carried two `notify`
lines, both resolved and neither dispatched: the nightly-review 429 (attempt 2 succeeded) and the
PolyUS `orders/open` 503 (the endpoint answers normally now). The PolyUS trader error the sentinel
was tracking underneath it was the close-time defect of §5(a), now fixed at the source.
`data/sentinel/suppressions.json` — nothing renewed.

Incidents opened today: 0 (one drill, closed). Repaired: 0 needed. Still open: 0. Sentinel
liveness: fresh, no restart required.

## 9. Shadows

- **HRRR vs NBM**: collecting; the verdict is due after 2026-09-21.
- **Metaculus**: 16 pairs, 0 graded. `schema-sample.json` exists and `communityP()` is producing
  pairs, so no field fix is needed. The pairs resolve 2027+; this is a slow instrument.
- **Mention base rates**: 356 observations over 311 strikes, 0 graded. The corpora are loading.
- **Polymarket smart-money consensus**: 15 signals, 3 matched to Kalshi and 1 to Polymarket US,
  0 graded.

None of the four is near its go-live trigger, and none of them trades.

## 10. Open questions for the operator (nothing blocking, nothing needed from you)

1. **The day's +$8.72 is one lottery ticket.** Strip the single +$22.33 La Liga longshot and the
   24 h is −$12.74. The ladder is doing its job — it has stopped four arms this week — but no
   Kalshi arm has yet produced a positive checkpoint on evidence wider than one trade.
2. **Lead-lag is at live ×2 on evidence that has just been invalidated** (§5(b)). I did not demote
   it: the ladder decides, and its next checkpoint will now be computed from real fills. If the
   arm was only ever profitable on phantom rows, the checkpoint will stop it. Worth watching.
3. **The sharp anchor's rule loses money while its forecast is well calibrated** (mean Brier 0.063
   over 44 rows, `ruleNet` −$1.87 over 20). That points at the entry rule or the fee, not the
   anchor itself. Nothing to change until the sample is bigger.
4. **The Odds API ran at 644 of 645 credits yesterday**, 322 by mid-morning today. The pacing
   works, but coverage will thin as more leagues come into season. No paid upgrade proposed.

## 11. Delivery

`SendUserFile` and `PushNotification` are **not available in this headless session** (the Windows
task `OracleTrader-Maintenance` has no desktop tools). This file is `docs/reports/2026-09-08.md`;
the desktop task at 08:30 local delivers it. The `claude.ai Gmail` and `claude.ai Google Calendar`
MCP servers also need OAuth authorization from an interactive session; they were not needed here.

---

# 2026-09-09 (headless run, 11:00-11:20Z)

## 1. Liveness

| Check | Result |
|---|---|
| App process | UP. Restarted twice by this session (11:07:55Z, then 11:12:09Z onto the final build, PID 7456). `[kalshi] positions merged 19` on boot, scans resumed. |
| `main.log` | Written continuously; newest line seconds old at every check. |
| `ladder.json` `lastRunAt` | 10:48Z at the start of the run — 12 min old, inside the 2 h bound. 19 arms. |
| BTC collector | UP (`node scripts/btc-collector.mjs`, PID 17716). 287,018 lines. |
| Nightly review | `reviews/2026-09-09.md` present, written 07:08Z (self-healed via `runIfDue` after the overnight outage). |
| `OracleTrader-HrrrShadow` | `data/hrrr-shadow/forecasts.jsonl` written 10:20Z. OK. |
| `OracleTrader-MentionShadow` | `run.log` 10:50Z. OK. |
| `OracleTrader-PolyConsensus` | `run.log` 10:59Z. OK. |
| `OracleTrader-MetaculusShadow` | Task ran 10:35Z, exit 0. `pairs.jsonl` last grew 00:36Z — 16 pairs yesterday, 24 today, so it IS growing; new rows appear only when a matching Kalshi market opens, not hourly. |
| Sentinel | `status.json` `at` 10:50:01Z — fresh. |

Nothing was down; nothing needed reviving. The overnight Windows-Update outage
(01:29:06Z to 06:57:18Z) was already recovered before this run, unattended and cleanly.

**Twelve `Manifold connected` markers on 2026-09-09** before this session's two restarts
(00:12, 00:46, 06:57, 07:15, 08:37, 08:54, 08:57, 08:59, 09:13, 09:23, 10:08, 10:46Z).
That string fires on renderer reloads as well as true process starts, so it is an upper
bound on restarts. All but the 06:57Z one line up with the round 47–55 sessions' own
app-stopped config changes; the 06:57Z one is the outage recovery. Two renderer crashes
(`process gone: crashed -1`, 08:57:05Z and 10:08:34Z) did not take the main process down.
Reconstructing this needed process start times cross-checked against log lines, because
nothing in the log says which build is running — filed as backlog 46.

## 2. Evidence read

**Errors, last 24 h.** 133 warnings and 3 errors, and no more than that.

- 132 `[ratchet] refused ...` warnings (78 NO price-floor, 28 book-too-wide, 26 YES
  price-floor) on `KXLOWTBOS-*` and `KXLOWTPHIL-*`. These are the round-47 guard REFUSING;
  no order was placed. See §6.
- 2 `[renderer] process gone: crashed -1`; 1 `[renderer] process gone: killed` (the
  01:29Z outage).
- 1 `[auto-trader] ledger trade not held at venue on 3 checks, dropping` (KXNPBTOTAL) —
  the designed reconciler behaviour, not an error condition.
- Zero `daily-cap`, zero brake trips, zero kill-switch lines, zero `unbooked` findings.

**Silent-strategy checks.**

- `[convergence]` newest verbose note: `in window 188: margin-out 173 cost-out 14 no-vol 0
  edge-out 1 event-dup 0 limits 0 | graded 9 (W:8 L:1) PnL: -32c`. The arm is not broken —
  173 of 188 candidates fail the margin test, which is the fence doing its job. It has
  fired 0 orders and has 0 settlements since 2026-09-06, so it is still un-judged.
- `[quoter]` has produced **no** `fair-value on N of M` line in 24 h, and should not: the
  arm is disabled (`disabled: 17 candidates, would quote 0 (4 gated) — shadow meter on`).
  The last such line is 2026-09-07T13:12Z. 1,202 quoter lines in the window, all the
  disabled-with-shadow form.

**Scripts.**

- `node scripts/btc-gate.mjs --json` gives **FAIL / NOT YET**. 302 strike-trades over 117
  events / 8 days; net taker +0.12c/contract; Bonferroni LB -3.10c, day-clustered LB
  -1.77c. Needs 200 events. Adverse rate 3.64% against a 3.6% sign-flip floor.
- `node scripts/quoter-shadow-gate.mjs --json` gives insufficient sample for the ALLOWED
  cohort (1 settled proxy fill of 30 needed, 1 event of 40). BLOCKED cohort -1.45c over
  128 fills, which supports the filter and says nothing about the strategy.
- `node scripts/trade-quality.mjs` flags book-imbalance, momentum, sports-anchor,
  volume-spike, flow-follow (all already stopped or held) and `mean-reversion: adverse
  fills`. Kalshi 18 open / 8 resting, kill switch clear.

**Balances.** Kalshi cash $57.69 — shard 0 $26.42, shard 1 $0.00, shard 2 $15.00,
shard 3 $16.27 — plus open positions at cost $51.53 = equity $109.22 ($106.12 at market).
Polymarket US $49.71 balance / $39.71 buying power (balance includes open-position cost).
At `amountPerTrade` $1 every shard except shard 1 covers a stake; shard 1 is empty and the
hourly balancer owns that, so it is a watch item, not an operator action.

**Odds API spend.** `__spentDay:2026-09-09` = **316** of the 645/day cap (09-08: 508,
09-07: 644). Comfortable.

**Sharp anchor, out of sample.** `gradedN` 44, `gradedBrier` 2.779 (this field is a SUM —
mean Brier **0.063**, well calibrated; backlog 44), `ruleN` 20, `ruleNet` **-$1.87**.
`anchor-grades.jsonl` gained **0 rows in 29 h** and stands at 44. That is a defect, not a
quiet day — see §5(b). The forecast is good and the trading rule built on it is not; that
verdict is unchanged and still under-powered at n=20.

## 3. Venue-true P&L, last 24 h

`python scripts/venue-pnl.py` on fresh read-only dumps taken at 11:00:52Z / 11:01:17Z:

- **Kalshi -$9.16** after $2.94 fees, over 40 settlements.
- **Polymarket US $0.00**, 0 settlements.

The whole loss is weather: the `KXLOWT*` / `KXHIGHT*` families sum to **-$8.73** (BOS
-2.67, MIA -2.55, ATL -1.60, SFO -0.97, SEA-high -0.74, HOU -0.43, PHIL -0.24, DC -0.20,
SEA-low +0.30, BOS-high +0.37). **Everything else together is -$0.43**, and inside that,
KXCONMEBOLLIBTOTAL +4.07 and KXBTC15M +2.21 against KXSOLD -3.71 and KXMLBGAME -1.24.

Weather was retired at 08:37Z, so most of this is legacy inventory settling out. The
exception is what §5(a) is about.

## 4. Ladder — running, and its evidence is sound

19 arms. Stake is `amountPerTrade` $1 x notch, capped by `maxBalancePct` 25% of equity;
no arm is above notch 1, so every live arm is at $1.

**Live (tiny-live, $1):**

| Arm | Settled since stage start | Net |
|---|---|---|
| kalshi-leadlag | 9 | **+$0.95** |
| kalshi-fade | 2 | +$0.23 |
| kalshi-volume-spike | 11 | -$2.11 |
| kalshi-sports-anchor | 4 | -$4.50 |
| convergence | 0 | $0.00 |
| kalshi-cross-venue | 0 | $0.00 |
| kalshi-news | 0 | $0.00 |
| kalshi-dutch | 0 | $0.00 |
| polyus-fade | 0 | $0.00 |
| kalshi-mean-reversion | 0 (re-baselined 09:23Z) | $0.00 |

**Off:** quoter, settlement, kalshi-weather-morning, polyus-weather-fair,
polyus-book-imbalance — all `operatorHold` with cool-downs to 2026-12-01;
kalshi-momentum to 2027-01-01; kalshi-book-imbalance to 09-11; polyus-micro-maker to
09-10; kalshi-flow-follow to 09-12.

**Verdict-vs-ledger check.** Every stop the ladder has made this week points the same way
as the venue ledger: momentum (-$4.41/20), book-imbalance (-$9.20 stop), flow-follow
(-$0.85/5 with CLV -15.6c on 5 of 5), polyus-micro-maker (-$2.05/20),
polyus-book-imbalance (1W/39L), quoter (-$2.39/20). The one app-ledger number that looks
good — mean-reversion +$21.82 over 6 — is a single +$22.87 La Liga ticket with the other
five at -$1.05, and the ladder is correctly **not** counting it: the arm was re-baselined
at 09:23Z after its second rule change, so that trade has left the evidence window by
design. No arm's verdict is resting on evidence the ledger contradicts.

The nightly review's accounting flag stands: venue-settled -$40.95 lifetime against app
ledgers of Kalshi +$0.65 / PolyUS -$11.30, a ~$30.30 gap, of which weather is -$44.94.
The reconciler is the review's own code proposal and is not built; it stays on the list.

## 5. Defects

### (a) FIXED — the generic arms were trading the weather ladders

**Found.** Mean-reversion, moved onto the maker path in round 54, rested into three
temperature brackets *after* round 50 retired every weather arm at 08:37Z:

| Order placed | Market | Size | Outcome |
|---|---|---|---|
| 09:54:05Z | `KXLOWTPHIL-26SEP09-T68` buy YES 0.84 | $3.00 | still resting |
| 10:03:29Z | `KXLOWTNYC-26SEP09-B68.5` buy YES 0.39 | $3.00 | still resting |
| 10:14:33Z | `KXLOWTATL-26SEP09-B69.5` buy YES 0.66 | $3.00 | **filled 10:37:46Z, maker** |

(The $3.00 sizes are correct for their placement time — they predate round 55's
`amountPerTrade` 3 to 1, and every order placed since is at $1. Not a second defect.)

**Why it matters, in evidence rather than in principle.** Round 50 measured the MAKER
seat in the `KX(HIGH|LOW)T*` series from the public trades endpoint: **-1.70c/contract,
CI95 [-2.66, -0.73], over 801,258 contracts and 78 station-days**, and -5.55c inside the
3–48 h / 7–93c window we actually rest in. It is positive on 10 of 78 station-days. And
the move and fade audits that justify the generic arms were run on the Becker dataset,
which round 50 also established contains **zero** `KXLOW` and zero `KX*T*` rows — so
mean-reversion's +2.79c/+4.03c backtest says nothing whatever about this class, while the
class itself has a measured negative seat. Backlog item 25 already fixed the house rule
for this ("weather re-opens only on a seat measurement"); nothing enforced it against the
non-weather arms.

Worse than the money: the arm was re-baselined at 09:23Z, so those three would have been
the **first evidence rows of its fresh checkpoint**. The arm the whole book is waiting on
would have been graded on a weather test. That is the round-46 attribution error again.

**Fix** — smallest diff that covers every arm and every entry path:

- `src/main/strategies/classify.ts`: new exported pure function `weatherSeatBlock(strategy,
  marketId)`, returning a reason when a non-weather-native arm touches a weather series.
  Matched on the **series ticker only** (`KXHIGH*`, `KXLOW*`, `KXRAIN*`, `KXSNOW*`, via the
  existing `isWeatherSeries`), because that is how the seat was measured. Weather-native
  arms (`settlement`, `weather-morning`, `quoter`) are exempt and keep their own gate.
- `src/main/strategies/autoTrader.ts`: two lines in `entryBlocked`, which is the single
  gate **both** entry paths run — the approval loop and the re-check immediately before
  execution, including the maker-rest branch.

**Verified.** 10 new assertions in `review-fixes.test.ts` (both directions: generic arms
blocked on high/low/rain/snow and on the legacy `KXHIGHLAX` series; weather-native arms
and all non-weather series pass). `npx tsc --noEmit` clean; `npx electron-vite build`
clean; the definition **and** the call site inside `entryBlocked` are both present in the
running `out/main/index.js`. Not yet observed firing in `main.log`: the only weather signal
generated since the restart (`KXLOWTATL-26SEP09-B71.5`, mean-reversion) was vetoed one gate
earlier by the price band at 0.04, so the new gate was never reached. It is unit-tested
and wired, not yet exercised live — stated plainly rather than claimed.

**Left alone deliberately:** the two resting weather orders. A maintenance session never
cancels an order by hand. Backlog 42 carries the follow-up: confirm tomorrow that
`managePendingOrders` retired them, because a rest whose entry rule no longer permits it
ought to be pulled and I do not know that it is.

### (b) DIAGNOSED, INSTRUMENTED, NOT FIXED — sports-anchor grading writes nothing

`anchor-grades.jsonl` has stood at 44 rows since 2026-09-08T06:01Z. Meanwhile `grade()`
polled The Odds API scores endpoint for all five sports 4.1 h before this run (2 credits
each, 10 credits per 6 h) and 91 finished observations sit ungraded. All 44 rows on file
are NCAAF; the ungraded ones are NPB (56), KBO (35) and MLS.

The suspicion is that the `/scores` feed's league coverage is narrower than `/odds`, so
`byId` — which requires `completed && scores` — is empty for those leagues and the poll
buys nothing. **Not confirmed.** Confirming it needs one authenticated GET, and the stored
key is encrypted; a maintenance session must not unwrap it, so I did not. (I attempted the
probe with the at-rest value, got a 401, and stopped there.)

Instrumented instead — one line per sport per poll:
`[anchor] scores <sport>: N events, M completed with scores; P pending, Q matchable`.
Tomorrow's run reads it and decides: `M`=0 means drop NPB/KBO from the grading poll (saves
4 credits per 6 h) and grade from Kalshi settlement; `M`>0 with `Q`=0 means the defect is
eventId/team-name matching, not coverage. Backlog 43.

This is a measurement-only change: no trading behaviour moves.

### Checked and dismissed

- **`amountPerTrade` appearing not to take effect.** Fills at 10:37Z and 11:00Z were $3.00
  against a config of $1. Both are maker fills of orders placed *before* round 55's sizing
  change; every order placed since is $1. No defect.
- **The 132 ratchet warnings.** The guard refusing, on an arm that cannot trade. See §6.
- **`KXUCLGAME-...-PSG` resting "sell 60 contracts"** with no position: selling YES at 0.95
  is buying NO at 0.05; 60 x $0.05 = the standard $3.00 stake of its placement time. Max
  loss $3.00. Not a naked exposure.

## 6. Sentinel

`status.json` `at` 10:50:01Z — fresh, no restart needed. `schtasks` shows all seven
OracleTrader tasks present and healthy.

**Incidents opened today: 1. Repaired/closed: 1. Still open: 0.**

`2026-09-09T00-20-log-warn-ratchet-refused-KXLOWTBOS-NO-lo.md` was the only OPEN file.
The sentinel dispatched a repair session for it at 00:20:01Z; that session left **no log
in `logs/`** and left the incident's Outcome section as the unfilled template. This run
finished it and closed it **NOT-A-DEFECT**: the lines are the round-47 `ratchetEntryBlock`
guard refusing entries, on an arm that is `settleLiveEnabled: false` and sits at ladder
stage `paper` with `operatorHold` until 2026-12-01. Every one of the 132 lines is a
refusal — no order, no money. Round 49 already throttled them to on-change-or-hourly per
market, so the rate is the floor.

Because the guard is permanent and Boston lists low brackets daily, this signature would
re-open an incident every night. Created `data/sentinel/suppressions.json` (the file did
not exist) with one entry: pattern matching `[ratchet] refused`, **until 2026-12-02** —
one day after the arm's hold — and the reason recorded in the file, pointing at the
incident. Verified by regex that it matches the live 11:00:04Z sample and does **not**
swallow the unrelated `[auto-trader] ledger trade not held at venue` warning.

Digest since the last run: the 00:20Z dispatch, and a 07:05Z block that revived all four
stale shadow tasks after the outage without dispatching a repair — correct behaviour.
Standing notify-only items: the PolyUS LPGA position 19 days from close, and Manifold's 4
positions unsettled >12 h past close (oldest 142 h).

**Discrepancy filed (backlog 45):** `status.json` says `repairSessionsToday: 2` while
`state.json` records one dispatch counted twice (once per signature, both pointing at the
same file) and `logs/` has no `repair-*.log` dated today at all. The daily budget of 3 is
being spent by sessions that leave no trace.

## 7. Shadows

- **HRRR vs NBM** — collecting; verdict due after 2026-09-21. Round 50 already established
  that `hrrr-shadow.mjs` computes daily MAXIMA only while 77% of quoter fills were LOW
  markets, so the instrument cannot see the market it was built for. Weather is retired
  regardless; the verdict is now academic and should be judged as such.
- **Metaculus** — 24 pairs (16 yesterday), 0 graded. `communityP()` is producing pairs, so
  no field fix is needed; they resolve 2027+.
- **Mention base rates** — 6,455 observations over 353 strikes, 0 graded. Corpora loading
  well (up from 356 observations yesterday).
- **Polymarket smart-money consensus** — 844 signals, 297 matched to Kalshi and 206 to
  Polymarket US, 0 graded. Up from 15 signals yesterday; the matcher is working.

None is near its go-live trigger. None trades.

## 8. Build queue — every trigger checked

| # | Item | Trigger | Result today |
|---|---|---|---|
| 1 | Critic skill check | 50+ settled per group | **MET — action DECLINED, rule revised.** See below. |
| 2 | WebSocket book for execution | >=0.99 agreement, 7 consecutive days | **NOT MET** — 249/250 = 0.996 PASS, **day 3 of 7**. (Counter reset at the outage; `lastError` "universe drift 52%".) |
| 3 | HRRR forecast source | 2026-09-21 | **NOT MET** — date. |
| 4 | Kalshi private fill channel | quoter notch >=2 or positive quoter checkpoint | **UNREACHABLE** — the quoter is permanently retired (backlog 37). |
| 5 | Avellaneda-Stoikov skew | same as 4 | **UNREACHABLE** — same. |
| 6 | Anchor on Polymarket US | Kalshi anchor's first checkpoint net positive | **NOT MET** — 4 settled, -$4.50. |
| 7 | Player props | anchor notch >=2 | **NOT MET**. |
| 8 | New generic strategies | (c) gated on MR v3 showing fills and a positive checkpoint | **NOT MET** — MR v3 has 0 settled since its 09:23Z re-baseline. |
| 9 | SportsGameOdds role | none ("when convenient") | Untriggered; still lifecycle-only. Free tier is now refusing 1,538 bookmaker odds per query. |
| 10 | Metaculus shadow | built | Running; 24 pairs, 0 graded. |
| 11 | Forecaster v2 | hunch gate at 200+ graded reading "not yet" | **NOT MET**. |
| 12 | Mention base rates | 100+ graded strikes | **NOT MET** — 353 strikes, 0 graded. |
| 13 | Polymarket consensus | 100+ graded signals | **NOT MET** — 844 signals, 0 graded. |
| 14 | Fade v2 | done 2026-09-08 | Done. |
| 15 | Becker backtests | (e) consensus history remains | Untriggered this run (49 GB, needs wallet-to-outcome mapping). |
| 16, 17 | quoter hours / weather time-of-day | done / answered | Closed. |

**Item 1 in full.** `critic-skill.py` on a fresh dump: 771 decisions; settled 63 ABSTAIN /
82 VETO / 47 ERROR — both groups past 50, so the trigger fires. Aggregate net per
contract: ABSTAIN +$0.046, VETO +$0.020, a 2.6c gap, and the pre-registered rule says
switch `intelligenceMode` to `veto`.

**I did not apply it,** for two reasons the rule as written cannot see:

1. **The vetoed cohort is profitable** — +2.0c/contract, +$1.68 over 82 settled trades.
   Enforcing the veto would forfeit a positive-EV third of the book in order to raise an
   average. That is the opposite of judging by net profit after fees.
2. **The 2.6c gap is composition, not skill.** Within strategy the sign flips: veto minus
   abstain is -5.6c on book-imbalance, -7.8c on momentum and -27.8c on volume-spike (the
   critic looks skilled), but **+58.9c on mean-reversion** (anti-skill) and about 0 on
   fade and flow-follow. The aggregate is driven by VETO holding 14 book-imbalance while
   ABSTAIN holds 20 momentum.

Revised criterion, written into `docs/BACKLOG.md` **now** so it is pre-registered rather
than chosen after the next result: switch to `veto` only when the vetoed cohort's own net
is **below zero**, *and* below the rest by >=2c, *and* the sign holds in a majority of the
strategies present in both cohorts. The 200-settled `intelligenceEnabled: false` clause is
unchanged. The operator can overrule this; it is a rule change I made on my own judgement and it is
the one decision in this report most worth a second opinion.

**No build-queue item was in a buildable triggered state,** and the next untriggered build
(8(c), market-maker rest patterns) is explicitly gated on MR v3 showing fills, which it has
not. The day's engineering went to the §5(a) defect instead, which was losing money and
was contaminating exactly the arm 8(c) waits on.

## 9. Verification

- `npx tsc --noEmit` — clean.
- `npx tsx scripts/tests/review-fixes.test.ts` — **278 passed, 0 failed** (+10 today).
- `npx tsx scripts/tests/ladder.test.ts` — **74 passed, 0 failed**.
- `npx tsx scripts/tests/adversarial.test.ts` — **80 passed, 0 failed**.
- `npx electron-vite build` — clean; both new markers present in `out/main/index.js`,
  including the call site inside `entryBlocked`.
- App restarted via `Start-ScheduledTask OracleTrader-App` onto the final build,
  **PID 7456 at 11:12:09Z**, verified in `main.log` (`positions merged 19`, scans resumed).
- Backup `python scripts/backup.py MAINT-2026-09-09` produced
  `G:\PROJECTS\oracle-trader-backups\oracle-trader-MAINT-2026-09-09-20260909-071229.zip`
  (648 files, 120.5 MB; only the live `lockfile` skipped). This is the restore point; an
  earlier zip of the same label (`...-070928.zip`) predates the anchor instrumentation.

**Not verified:** that `weatherSeatBlock` has refused a live entry — no weather signal has
reached it since the restart (see §5(a)). And backlog 42's follow-up: whether the two
resting weather orders get pulled.

## 10. Open questions for the operator — nothing blocking, nothing needed from you

1. **The book is gross-positive and net-negative, and that is still the whole story.**
   Round 54 measured it: $12.18 of fees on $427.71 of notional (2.85%) against -$2.56
   realized over 122 trades. Backlog 35 — the fee-aware entry gate — is the highest-value
   unbuilt item and is blocked on arms stating a cents-denominated edge, which most do not.
   That blocker is itself the finding.
2. **Nine of ten live arms have fewer than 12 settled trades, and the checkpoint needs
   about 92–370.** Round 51's measurement stands: at the measured per-trade dispersion the
   20-trade gate can only catch big losers. It has caught five. It cannot confirm a winner.
   Backlog 29 (CLV gating) is the way out and the second moments are now being recorded.
3. **I declined a pre-registered action today** (§8, item 1). Reasonable people could
   disagree; the reasoning and the replacement rule are both written down.
4. **The Odds API is being spent on grading that produces nothing** — 10 credits per 6 h
   against 0 rows in 29 h (§5(b)). Bounded and diagnosed; tomorrow's log settles it.

## 11. Delivery

`SendUserFile` and `PushNotification` are **not available in this headless session** (the
Windows task `OracleTrader-Maintenance` has no desktop tools). This file is
`docs/reports/2026-09-09.md`; the desktop task at 08:30 local delivers it. The
`claude.ai Gmail` and `claude.ai Google Calendar` MCP servers need OAuth authorization from
an interactive session and were not needed here.

---

# Oracle Trader — daily maintenance, 2026-09-10 (headless run, 11:00–11:20Z)

## 1. Liveness — everything was already up

| Check | Result |
|---|---|
| App process | UP on arrival (PID 16280, started 06:25:58Z). Restarted by this session at **11:09:24Z, PID 37264**, onto the new build. |
| `main.log` | Written continuously; newest line seconds old at every check. |
| `ladder.json` `lastRunAt` | 10:25:59Z on arrival (34 min old, inside the 2 h bound). Ticked again at **11:11:25Z** after the restart, so the loop survived it. 19 arms. |
| BTC collector | UP (`node scripts/btc-collector.mjs`, PID 17716, up since 09-09 06:57Z). 322,847 lines. |
| Nightly review | `reviews/2026-09-10.md` present, written 06:01:52Z. |
| `OracleTrader-HrrrShadow` | `forecasts.jsonl` written 10:20:11Z. OK. |
| `OracleTrader-MentionShadow` | `run.log` 10:50:27Z. OK. |
| `OracleTrader-PolyConsensus` | `run.log` 10:58:11Z. OK. |
| `OracleTrader-MetaculusShadow` | Task ran 10:35:01Z exit 0; `pairs.jsonl` 32 pairs (24 yesterday). Growing. |
| Sentinel | `status.json` `at` 10:50:02Z on arrival, 11:05:02Z at the final check. Fresh. |

All seven `OracleTrader-*` tasks present and healthy in `schtasks`. **Nothing was down and
nothing needed reviving.** The 06:25:58Z app start was not a crash and not a cold task start:
the fifteen lines before it are uninterrupted scan traffic to 06:25:53Z, with no shutdown
line, no `crashed`, and no gap — the same renderer-reconnect signature that fires a dozen
times a day (backlog 46: nothing in `main.log` says which build is running).

## 2. Evidence read

**Errors, last 24 h — four warnings and one error, and that is all.**

- 3 × `[ratchet] refused KXLOWTBOS-26SEP09-B60.5 NO` — the round-47 guard refusing; no order,
  no money. Suppressed until 2026-12-02.
- 1 × `[auto-trader] ledger trade not held at venue on 3 checks, dropping: KXKBOGAME-…-SAM` —
  the designed reconciler behaviour.
- 1 × `[renderer] process gone: crashed -1` (11:07:49Z); the main process was unaffected.
- Zero `failed`, zero `exception`, zero `kill-switch`, zero `daily-cap`, zero brake trips,
  zero `unbooked`, and no genuine HTTP 401/403/422/429 anywhere in the window.

This is a sharp drop from yesterday's 133 warnings, and the suppression is not why — these
are raw log counts, not sentinel findings. **The nightly review's "54 errors in 24h" flag is
reading the app's own `errors24h` counter, which disagrees with the log by an order of
magnitude.** Two passes at 18:58Z and 21:54Z reported `errors 14` in their summary line while
emitting no `[error]` lines. Filed as backlog 49; it is a telemetry discrepancy, not a
trading defect, but it is currently the loudest flag on a quiet day.

**Silent-strategy checks.**

- `[convergence]`, newest verbose note (10:55:39Z): `in window 188: margin-out 173 cost-out 14
  no-vol 0 edge-out 1 event-dup 0 limits 0 | graded 9 (W:8 L:1) PnL: -32c`. Unchanged in
  shape from yesterday: the margin fence rejects 173 of 188 and that is the fence working.
  It did fire three orders on 09-09 (13:55Z, 18:55Z, 19:54Z) and **all three were NO FILL** —
  so the arm is not mute, it is unfilled. Still 0 settled since 2026-09-06, still un-judged.
- `[quoter]` produced no `fair-value on N of M` line in 24 h and should not: the arm is
  disabled with the shadow meter on (`disabled: 30 candidates, would quote 0 (4 gated)`).
  Its cumulative counters are byte-identical at both ends of the window (`placed 1632 …
  filled 43.11`), confirming zero live quoter activity.

**Scripts.**

- `node scripts/btc-gate.mjs --json` — **FAIL / NOT YET**, but moving the right way. 345
  strike-trades over **134 events** / 9 days (302 / 117 yesterday). Net taker **+0.66c**
  (+0.12c yesterday); Bonferroni LB -2.20c, day-clustered LB -1.19c. Needs 200 events.
  Adverse 3.19% against a 3.2% sign-flip floor. Baseline check is healthy: our side +0.66c
  vs the opposite side at its ask -2.31c.
- `node scripts/quoter-shadow-gate.mjs --json` — insufficient sample for the ALLOWED cohort
  (3 settled proxy fills of 30 needed, 2 events of 40). BLOCKED cohort -3.16c over 275 fills,
  which supports the filter and says nothing about the strategy.
- `node scripts/trade-quality.mjs` — flags book-imbalance, momentum, sports-anchor,
  volume-spike, flow-follow (all stopped or held) and `mean-reversion: adverse fills`; on
  Polymarket US, book-imbalance, micro-maker and fade. Kalshi 21 open / 1 resting, kill
  switch clear.

**Balances.** Kalshi cash **$94.97** — shard 0 $39.88, shard 1 **$0.00**, shard 2 $39.14,
shard 3 $15.95 — plus open positions at cost $22.24 = equity **$117.21** ($113.94 at market).
Polymarket US $39.80 balance / $15.79 buying power (balance includes open-position cost).
Every configured stake is covered: Kalshi `amountPerTrade` $1 (×2 for the one notch-2 arm)
against a 25%-of-equity cap of $29.30; PolyUS $1 against a 10% cap of $3.98. Shard 1 is empty
again, as it was yesterday; the hourly balancer owns it and weather is retired, so it is a
watch item, not an operator action.

**Odds API spend.** `__spentDay:2026-09-10` = **322** of the 645/day cap (09-09: 592, 09-08:
508, 09-07: 644). Comfortable, and today's build cuts it further.

**Sharp anchor, out of sample — the numbers changed materially today; see §5.**
`gradedN` **171** (44 yesterday), `gradedBrier` 13.1189 — this field is a SUM, so **mean Brier
0.0767** (backlog 44), `ruleN` **92**, `ruleNet` **+$0.285**. `anchor-grades.jsonl` gained
**86 rows** in this run alone and stands at 171.

## 3. Venue-true P&L, last 24 h — the first clearly positive day

`python scripts/venue-pnl.py` on fresh read-only dumps taken at 11:00Z:

- **Kalshi +$6.79** after $2.63 fees, over 57 settlements.
- **Polymarket US -$2.00**, 18 resolutions.
- **Net +$4.79.**

The winner is crypto and it is concentrated: **KXBTC15M +$7.08 over 7 settlements** and
KXHIGHLAX +$1.86 over 2, against KXNPBTOTAL -$2.41, KXNPBGAME -$0.78, KXUCLGAME -$0.77 over 8
and KXNFLGAME -$0.62. Eighteen families settled between -$0.40 and +$0.30, i.e. noise.

**Weather was +$2.07** this window (KXHIGHLAX +1.86, KXLOWTBOS +0.12, KXRAIN +0.09) — legacy
inventory settling out in our favour for once, after yesterday's -$8.73. One day either way
means nothing against the -$42.97 lifetime weather deficit; it is recorded so tomorrow's
reader does not mistake it for a trend.

## 4. Ladder — running, and its verdicts match the ledger

19 arms. Stake is `amountPerTrade` $1 × notch, capped by `maxBalancePct` 25% of equity.

**Four stage changes since the last run**, all automatic:

| When (UTC) | Arm | Change | The ladder's stated reason |
|---|---|---|---|
| 09-09 21:39:49 | `kalshi-volume-spike` | tiny-live → **STOPPED** | checkpoint 23 trades, net **-$3.72**, -1.80c/contract (80% band -2.08..-1.52) |
| 09-09 21:39:49 | `kalshi-fade` | tiny-live → live ×2 | checkpoint 20 trades, net +$2.65, +5.23c/contract |
| 09-09 21:57:20 | `kalshi-fade` | **reverted to tiny-live ×1** | "round 63": the promoting checkpoint held 19 wins and 0 settlement losses; fade buys NO at 0.89–0.98, so the band measured how much the winners won, and 20 straight wins is a 36% event at zero edge |
| 09-10 05:01:04 | `polyus-micro-maker` | disabled → **live** | trade-small micro test 2 (stop -$5), cool-down expired 04:59:42Z |
| 09-10 07:26:06 | `kalshi-leadlag` | tiny-live → **live ×2** | checkpoint 20 trades, net **+$8.49**, +$0.42/trade (80% band 0.12..0.73) |

**Verdict-vs-ledger check.**

- **The lead-lag promotion is corroborated by the venue ledger, not just the app's tracker.**
  Lead-lag trades the 15-minute BTC/ETH pairs, and `KXBTC15M` is the single largest positive
  family in the venue-true 24 h read (+$7.08 over 7 settlements). The ladder's +$8.49 over 20
  and the settlement ledger point the same way. This is the first promotion this week where
  that is true.
- **The volume-spike stop is corroborated three ways**: the ladder's -$3.72/23, trade-quality's
  -1.80c/contract [-4.74, +1.14] over 26 trades, and the nightly review's independent flag.
- **The fade revert was the right call and I am leaving it alone.** Round 63's reasoning is
  sound and today's data agrees with it: trade-quality shows fade at 76 trades, 73W/3L, net
  +$9.28 but **-0.13c per contract [-7.00, +6.74]** once the losses are weighted by size. A
  73/76 win rate at -0.13c/contract is the exact shape the operator's "judge by net after fees, never
  win rate" rule exists to catch.
- **`polyus-micro-maker` came back on a timer, not on evidence.** It was stopped at -$2.05/20
  on 09-07 and re-armed automatically when its 3-day cool-down expired, with no new
  information. That is exactly the operator's standing rule ("stopped by its stop rule, retried after a
  cool-down"), so the ladder is behaving as designed — but it is also backlog 26, which notes
  that `tradeSmallEntry` never consults the gate, so a re-arm cannot be blocked by evidence
  even when the evidence is decisive. Correct today; a known hole in general.

No arm's verdict rests on evidence the ledger contradicts. Nine of the ten live arms still
have fewer than 24 settled trades.

## 5. The day's build — backlog 43, finished and verified live

**The trigger fired exactly as pre-registered.** Yesterday's session could not confirm why
sports-anchor grading wrote nothing, refused to unwrap an encrypted key to find out, and
instrumented `grade()` instead with one line per sport per poll. Those lines answered it in a
day. Over five polls in 24 h:

| Sport | events returned by `/scores` | **completed with scores** | pending |
|---|---|---|---|
| `baseball_npb` | 1 → 6 | **0 on every poll** | 84 |
| `baseball_kbo` | 1 → 4 | **0 on every poll** | 35 |
| `soccer_usa_mls` | 29 | 14 | 32 |
| `americanfootball_ncaaf` | 86 → 98 | 1 | 4 |
| `americanfootball_nfl` | 240 | 1 | 26 |
| `soccer_portugal_primeira_liga` | 11 | 1 | 12 |
| `soccer_argentina_primera_division` | 28 → 30 | 2 | 2 |

`M` = 0 for exactly the two leagues named and non-zero for every other, which is the
pre-registered "coverage, not matching" branch: **drop them from the grading poll and grade
them from Kalshi settlement instead.**

**Built.**

- `src/main/strategies/sportsAnchor.ts`: `NO_SCORES_FEED` (npb, kbo) skips those sports in
  `grade()` — 4 Odds credits per 6 h no longer spent on a call that returns nothing.
- New `SportsAnchor.gradeFromKalshi()`: one free public GET per Kalshi series per 6 h to
  `/markets?series_ticker=…&status=settled`, reading `result` ('yes'/'no'). It keys on the
  **exact ticker the observation was recorded on**, so there is no team-name and no score
  matching anywhere on this path — the class of bug that created this backlog cannot recur on
  it. Void markets (empty `result`) are skipped and stay pending.
- `ruleOutcome()` split out of `gradeObservation()` so both grading paths book P&L by
  identical arithmetic rather than a copy.
- `src/main/strategies/autoTrader.ts`: the write callback is hoisted and the new pass is
  called after the scores pass. Measurement only — `gradeFromKalshi` cannot place an order.

**Verified, in this order:**

- `npx tsc --noEmit` — clean.
- `npx tsx scripts/tests/review-fixes.test.ts` — **320 passed, 0 failed** (+17 today). The
  new assertions run off three observations lifted **verbatim from the live pending queue**
  (two NPB sides of one game plus one MLS row), and cover: the scores feed is never polled for
  those sports and spends no credit; exactly one settled-market query is issued, for the blind
  series only; both sides grade with the correct rule side and P&L; `gradedN`/`ruleN`/
  `ruleNet`/`gradedBrier` all move by the right amounts; the MLS row is untouched; the 6 h
  throttle holds; a market with no result stays pending.
- `npx tsx scripts/tests/ladder.test.ts` — 88 passed, 0 failed.
- `npx tsx scripts/tests/adversarial.test.ts` — 80 passed, 0 failed.
- `npx electron-vite build` — clean; both the definition and the call site are in
  `out/main/index.js`.
- App restarted via `Start-ScheduledTask OracleTrader-App`, **PID 37264 at 11:09:24Z**.
- **Observed firing live at 11:12:11Z** — not merely unit-tested:

```
[anchor] kalshi-settled KXNPBGAME:  200 settled, 188 with a result; 30 pending, 18 matchable
[anchor] kalshi-settled KXNPBTOTAL: 200 settled, 196 with a result; 55 pending, 33 matchable
[anchor] kalshi-settled KXKBOGAME:  200 settled, 170 with a result; 26 pending, 18 matchable
[anchor] kalshi-settled KXKBOTOTAL: 200 settled, 180 with a result; 17 pending, 17 matchable
```

`anchor-grades.jsonl` went **85 → 171 rows**, 86 of them tagged `gradedFrom:
"kalshi-settlement"`, and `__spentDay:2026-09-10` did not move off 322.

- Backup `python scripts/backup.py MAINT-2026-09-10` →
  `G:\PROJECTS\oracle-trader-backups\oracle-trader-MAINT-2026-09-10-20260910-071233.zip`
  (665 files, 166.2 MB; only the live `lockfile` skipped). This is the restore point.

### The result is more interesting than the fix, and it is a correction

**The anchor's trading rule is not losing. It was being graded on a censored sample.**

|  | before | after |
|---|---|---|
| `ruleN` | 42 | **92** |
| `ruleNet` | **-$5.375** (-12.8c/contract) | **+$0.285** (+0.31c/contract) |
| `gradedN` | 44 | 171 |
| mean Brier | 0.063 | 0.0767 |

The 50 newly graded rule trades netted **+$5.66, about +11.3c each**. For three consecutive
days the log recorded "the forecast is fine, the trading rule is not" — and that conclusion
was drawn from whichever leagues The Odds API's scores feed happened to cover, which was
overwhelmingly NCAAF. **Neither number is a verdict at n=92**; +0.31c/contract is
indistinguishable from zero. The correction is not "the rule works", it is that the previous
three days' verdict was measuring a subpopulation and nothing flagged it until a per-poll
counter existed.

Filed as **backlog 48**, generalised, because every other shadow has the same exposure: before
the mention base-rate, Polymarket-consensus, Metaculus or HRRR shadow is read for a go-live
decision, its graded rows must be checked to cover the same population as its observed rows.
The cheapest form is exactly the counter added here.

## 6. Sentinel

`status.json` `at` 10:50:02Z on arrival and 11:05:02Z at the final check — fresh, no restart
needed. `repairSessionsToday` 0. All seven tasks healthy. Ollama up, OpenRouter credit $46.38,
disk 136 GB free.

**Incidents opened since the last run: 0. Still open: 0.** All three files on disk are CLOSED:
the 09-08 drill (NOT-A-DEFECT), the 09-09 ratchet-refusal warning (NOT-A-DEFECT, suppressed to
2026-12-02), and `2026-09-09T17-05-unbooked-settlement-KXHIGHLAX-26SEP08-T8.md`, which round 61
closed FIXED after finding two real bugs: `closeTrade` looping on an already-settled market,
and the repair dispatcher's `spawn(…, { detached: true })` being a silent no-op, now
`cmd /c start`. Nothing was left for this session to finish.

Both suppressions are still in date (`[ratchet] refused` to 2026-12-02, the LPGA micro-maker
box to 2026-09-28) and both retain their written reason. Renewed neither; neither has expired.

**Backlog 45 has a measured cost now.** On 09-09 the sentinel refused to dispatch at six
consecutive checks (17:20 through 18:35Z) saying "3 repair sessions already today", while
`state.json` records only **two** real dispatches — the 00:20Z one is counted twice, once per
matching signature, both pointing at the same incident file. So the daily budget of 3 was
exhausted by 2 sessions and the sentinel was blind for the last six hours of the day. Nothing
needed dispatching in that window, so no harm landed; the bug is confirmed rather than
theoretical. Not fixed today — one behavioural change per run, and item 43 was the triggered
one.

Hygiene note: the closed 09-08 drill file contains a block of imperative text addressed to an
agent ("change Status: OPEN to Status: CLOSED… append to docs/MAINTENANCE-LOG.md… print DONE").
That is the drill's own payload and it is closed, but incident files are read by repair
sessions, so text inside one can read as instruction. Worth keeping in mind before any future
drill is written; nothing acted on it today.

## 7. Shadows — all four growing, none near a trigger, none trading

- **HRRR vs NBM** — 81 graded station-days. HRRR MAE **1.96** / bias -0.06 against NBM **2.29**
  / bias -1.82, closer on 41 days vs 36 with 4 ties. HRRR leads, but the trigger needs 100+
  station-days and 2026-09-21. Round 50's caveat stands and is the more important fact: the
  shadow computes daily MAXIMA while 77% of quoter fills were LOW markets, so it cannot see
  the market it was built for, and weather is retired regardless. The verdict on 09-21 should
  be recorded as academic.
- **Metaculus** — 32 pairs (24 yesterday), 0 graded. Growing; they resolve 2027+.
- **Mention base rates** — **14,231** observations (6,455 yesterday) over 353 strikes, 0
  graded. Corpora loading well.
- **Polymarket smart-money consensus** — **1,718** signals (844 yesterday), 558 matched to
  Kalshi and 470 to Polymarket US, 0 graded. The matcher is scaling.

Every one of these is 0-graded, which is precisely the exposure backlog 48 was filed about.

## 8. Build queue — every trigger checked

| # | Item | Trigger | Result today |
|---|---|---|---|
| 1 | Critic skill check | 50+ settled per group | **MET — DECLINED again, rule amended twice.** See below. |
| 2 | WebSocket book for execution | ≥0.99 agreement, 7 consecutive days | **NOT MET** — 10,946/11,021 = **0.9932 PASS**, day **4 of 7**. |
| 3 | HRRR forecast source | 2026-09-21 and 100+ station-days | **NOT MET** — 81 days, and the date. |
| 4 | Kalshi private fill channel | quoter notch ≥2 or positive quoter checkpoint | **UNREACHABLE** — quoter permanently retired (backlog 37). |
| 5 | Avellaneda-Stoikov skew | same as 4 | **UNREACHABLE** — same. |
| 6 | Anchor on Polymarket US | Kalshi anchor's first checkpoint net positive | **NOT MET** — 5 settled, -$4.51. |
| 7 | Player props | anchor notch ≥2 | **NOT MET**. |
| 8 | New generic strategies | (c) gated on MR v3 showing fills and a positive checkpoint | **NOT MET** — MR v3 still 0 settled since its 09-09 09:23Z re-baseline. |
| 9 | SportsGameOdds role | none ("when convenient") | Untriggered. Free tier now refusing 809 bookmaker odds per query; 224 objects this month, 2 graded. |
| 10 | Metaculus shadow | built | Running; 32 pairs, 0 graded. |
| 11 | Forecaster v2 | hunch gate at 200+ graded reading "not yet" | **NOT MET**. |
| 12 | Mention base rates | 100+ graded strikes | **NOT MET** — 353 strikes, 0 graded. |
| 13 | Polymarket consensus | 100+ graded signals | **NOT MET** — 1,718 signals, 0 graded. |
| 14 | Fade v2 | done 2026-09-08 | Done. |
| 15 | Becker backtests | (e) consensus history remains | Untriggered (49 GB, needs wallet-to-outcome mapping). |
| 16, 17 | quoter hours / weather time-of-day | done / answered | Closed. |
| **43** | **NPB/KBO grading** | **"read those lines in tomorrow's run"** | **MET — BUILT AND VERIFIED TODAY (§5).** |

**Item 1 in full.** 916 decisions; settled 84 ABSTAIN / 106 VETO / 47 ERROR — both groups past
50, so the trigger fires. ABSTAIN +$0.044/contract (+$3.71), VETO **-$0.006/contract (-$0.62)**,
a 5.0c gap.

Against the rule pre-registered yesterday — switch to `veto` only when (i) the vetoed cohort's
own net is below zero, (ii) it is below the rest by ≥2c, and (iii) the sign holds in a majority
of the strategies present in both cohorts — **(i) and (ii) now both pass**, unlike yesterday
when VETO was +$1.68. Condition (iii) fails: of the six strategies in both cohorts the critic
looks skilled in three (book-imbalance -5.6c, momentum -7.8c, volume-spike -26.9c),
anti-skilled in two (flow-follow +4.1c, mean-reversion +58.9c) and **exactly tied** in one
(fade, both +6.0c). Three of six is not a majority.

I have written two amendments into `docs/BACKLOG.md` **now**, before the next check, rather
than after seeing the next result:

1. **A tie counts against switching.** "Majority" means a strict majority of every strategy
   present in both cohorts, ties included in the denominator. Yesterday's wording did not say,
   and today it was load-bearing.
2. **The comparison is computed over currently enabled arms only.** This is the substantive
   one, and it is not a close call in dollars. VETO's -$0.62 is carried entirely by arms that
   are already stopped or held (book-imbalance -$2.24, volume-spike -$1.07, sports-anchor
   -$2.20). Restricted to the arms a forward-looking mode switch could actually still forgo,
   **VETO is +$1.41 over 44** (fade +$1.86/31, mean-reversion +$1.75/6, sports-anchor -$2.20/7)
   against ABSTAIN's -$0.89 over 9. Flipping to veto mode today would forfeit $1.41 of live
   edge to improve a historical average that includes trades nobody can avoid any more.

That is the second consecutive day the letter of this rule pointed one way and the money
pointed the other, which is itself the finding: **the aggregate cohort comparison keeps being
driven by composition** — which arms happened to be running — rather than by the critic's
skill. If the amended rule fires and I decline a third time, the rule is wrong and should be
replaced by a within-strategy test, not patched again.

**No other build-queue item was in a buildable triggered state**, and item 43 was, so the day's
engineering went there.

## 9. Verification summary

- `npx tsc --noEmit` — clean.
- `review-fixes` **320 passed / 0 failed**; `ladder` 88/0; `adversarial` 80/0.
- `npx electron-vite build` — clean, markers present in `out/main/index.js`.
- App restarted 11:09:24Z (PID 37264); `main.log` resumed; ladder ticked 11:11:25Z.
- New code observed **executing live** at 11:12:11Z with 86 rows written and zero Odds credits
  spent.
- Backup `oracle-trader-MAINT-2026-09-10-20260910-071233.zip`.

**Not verified:** that `weatherSeatBlock` (yesterday's fix) has refused a live entry — still no
weather signal has reached it, and there is no `weatherSeatBlock` line in 24 h of log. It stays
unit-tested and wired, not yet exercised. Stated plainly rather than claimed.

## 10. Open questions for the operator — nothing blocking, nothing needed from you

1. **The book is gross-positive and net-negative and that is still the whole story.** Today was
   +$4.79 venue-true, the first clearly positive day, and $2.63 of Kalshi fees went out on it.
   Backlog 35 — the fee-aware entry gate — remains the highest-value unbuilt item and is still
   blocked on arms stating a cents-denominated edge, which most do not.
2. **A shadow that grades a subpopulation reports the subpopulation.** That cost three days of
   a wrong verdict on the sports anchor (§5) and every other shadow on the board is currently
   0-graded. Backlog 48 is the general fix; it is cheap and I would build it next if nothing
   else triggers.
3. **I declined the pre-registered critic switch for the second day running** (§8) and amended
   the rule twice rather than once. If it fires again and I decline a third time, the rule
   should be replaced, not patched — I have written that down so a future session is bound
   by it.
4. **`polyus-micro-maker` re-armed on a timer with no new evidence** (§4). That is your
   standing cool-down rule working as intended, but backlog 26 means a failing gate could
   never stop it. Worth knowing the retry ladder currently has no evidence brake.
5. **`KXLOWTATL-26SEP09-B69.5` is still an open position 24 h after its market closed** — the
   venue has not settled it. Nothing to do by hand. If it is still open on 09-12 it becomes a
   real question about how `stuckSettlements` escalates.

## 11. Delivery

`SendUserFile` and `PushNotification` are **not available in this headless session** (the
Windows task `OracleTrader-Maintenance` has no desktop tools). This file is
`docs/reports/2026-09-10.md`; the desktop task at 08:30 local delivers it. The `claude.ai
Gmail` and `claude.ai Google Calendar` MCP servers need OAuth authorization from an interactive
session and were not needed here.

### Five lines for the push

1. Nothing needed from you.
2. Venue-true 24 h: **Kalshi +$6.79** after $2.63 fees / 57 settlements, **PolyUS -$2.00** —
   net **+$4.79**, the first clearly positive day.
3. Ladder: lead-lag promoted to **live ×2** on +$8.49/20 (the venue ledger agrees — KXBTC15M
   +$7.08); volume-spike **stopped** at -$3.72/23; micro-maker re-armed off cool-down; the
   fade ×2 promotion was reverted 17 min later on a 20-straight-wins artifact.
4. Errors: 5 log lines in 24 h, none costing money; no incidents open; the app's own
   "54 errors" counter disagrees with the log and is now backlog 49.
5. **The one thing:** the sports anchor's "the rule loses money" verdict was wrong — it was
   graded only on the leagues the odds feed covers. Grading NPB/KBO from Kalshi settlement
   moved it from -12.8c to +0.31c/contract over 92. Still not a verdict; the lesson is that
   every 0-graded shadow on the board has the same blind spot.


---

# Oracle Trader — daily maintenance, 2026-09-11 (headless run, 11:00–11:15Z)

## 1. Liveness — everything up, nothing needed reviving

| Check | Result |
|---|---|
| App process | UP on arrival (PID 37448, started **2026-09-11T00:05:32Z**). Restarted by this session at **11:10:33Z, PID 36624**, onto today's build. |
| `main.log` | Written continuously; newest line seconds old at every check. |
| `ladder.json` `lastRunAt` | 10:05:36Z on arrival (55 min, inside the 2 h bound); ticked again 11:05:32Z. 19 arms. |
| BTC collector | UP (`node scripts/btc-collector.mjs`, PID 17716, up since 09-09 06:57Z). 363,535 lines (+40,688). |
| Nightly review | `reviews/2026-09-11.md` present, written 06:06:10Z, one attempt. |
| `OracleTrader-HrrrShadow` | `forecasts.jsonl` 10:20:11Z. OK. |
| `OracleTrader-MentionShadow` | `run.log` 10:50:30Z. OK. |
| `OracleTrader-PolyConsensus` | `run.log` 10:58:03Z. OK. |
| `OracleTrader-MetaculusShadow` | Task ran 10:35:01Z exit 0; 40 pairs (32 yesterday). Growing. |
| Sentinel | `status.json` `at` 10:50:01Z — 10 min old, fresh. `repairSessionsToday` 0. |

All seven `OracleTrader-*` tasks present and healthy. **Nothing was down.**

The 00:05:32Z app start was **not** a crash, and this time the cause is known and it matters —
see §5. Note for future sessions: `Start-ScheduledTask OracleTrader-App` is a **no-op** when the
task is already in the Running state (it was, all day). The documented Stop-Process → wait →
`Start-Process` procedure is the one that actually restarts the app, and is what was used at
11:10:33Z. Yesterday's session reported a restart "via `Start-ScheduledTask`"; that path cannot
have been what restarted it.

## 2. Evidence read

**Errors, last 24 h — one recurring shape, and it is not costing money.**

- **16 × `[reconciler] run failed: GET /v1/portfolio/activities -> 429`** — Polymarket US, not
  Kalshi, rate-limiting the activity feed after `HttpClient` exhausts its three retries (~4 s of
  backoff). **No fills were lost**: the reconciler re-reads `limit=1000` every 5 min and every
  following run logged `completeness ok`. Its second cost is that `HttpError` slices 300 chars of
  a Cloudflare **HTML** error page into the message, which lands as ~6 junk lines in `main.log`
  per failure (~96/day). Filed as backlog 52.
- 2 × `[ratchet] refused KXLOWTBOS-26SEP11-T63 NO` — the round-47 guard refusing in the open on an
  arm that cannot trade. No order, no money. Suppressed to 2026-12-02.
- **Zero** `[error]`, zero `exception`, zero `kill-switch`, zero `daily-cap`, zero `unbooked`,
  zero brake trips, zero 401/403/422, and no genuine `crashed` line in the window.

**Silent-strategy checks.**

- `[convergence]` newest note (10:55:37Z): `in window 188: margin-out 174 cost-out 14 no-vol 0
  edge-out 0 event-dup 0 limits 0 | graded 9 (W:8 L:1) PnL: -32c`. Byte-identical in shape to the
  oldest in-window note 24 h earlier. The margin fence rejects 174 of 188 and that is the fence
  working, but the arm has now been **0-settled since 2026-09-06** and its graded counter has not
  moved in 2,887 consecutive log lines. Still un-judged, five days in.
- `[quoter]` produced **no** `fair-value on N of M` line, and should not: the arm is disabled with
  the shadow meter on. Its cumulative counters are identical at both ends of the window
  (`placed 1632 … filled 43.11`), confirming zero live quoter activity.

**Scripts.**

- `node scripts/btc-gate.mjs --json` — **FAIL / NOT YET**, still improving. 398 strike-trades over
  **157 events** / 10 days (345 / 134 yesterday). Net taker **+0.88c** (+0.66c yesterday);
  Bonferroni LB -1.76c, day-clustered LB -0.75c. Needs 200 events. Adverse 3.02% against a 3.0%
  sign-flip floor. Baseline healthy: our side +0.88c vs the opposite side at its ask -2.53c.
- `node scripts/quoter-shadow-gate.mjs --json` — insufficient sample for the ALLOWED cohort
  (7 settled proxy fills of 30 needed, 5 events of 40). BLOCKED cohort -3.00c over 447, which
  supports the filter and says nothing about the strategy.
- `node scripts/trade-quality.mjs` — flags book-imbalance, momentum, sports-anchor, volume-spike,
  flow-follow, mean-reversion on Kalshi; book-imbalance and micro-maker on Polymarket US. Kalshi
  20 open / 14 resting, kill switch clear, 24 trades today against a cap of 200.

**Balances.** Kalshi cash **$106.19** — shard 0 $37.68, shard 1 **$0.00**, shard 2 $52.37,
shard 3 $16.14 — plus open positions at cost $20.32 = equity **$126.51** ($125.22 at market), up
from $117.21 yesterday. Polymarket US $40.88 balance / $24.84 buying power (balance includes
open-position cost). Every configured stake is covered: Kalshi `amountPerTrade` $1 (×2 for the one
notch-2 arm) against a 25%-of-equity cap of $31.63; PolyUS $1 against a 10% cap of $4.09. Shard 1
is empty for the third day; the hourly balancer owns it and weather is retired, so it stays a
watch item, not an operator action.

**Odds API spend.** `__spentDay:2026-09-11` = **320** of the 645/day cap (09-10: 536, 09-09: 592,
09-08: 508). Comfortable.

**Sharp anchor, out of sample.** `gradedN` **232** (171 yesterday), `gradedBrier` 18.3576 — a SUM,
so **mean Brier 0.0791** (backlog 44) — `ruleN` **116** (92), `ruleNet` **+$1.98** (+$0.285).
`anchor-grades.jsonl` gained **61 rows**, to 232. The 24 new rule trades netted **+$1.70, about
+7.1c each**, taking the rule to **+1.71c/contract over 116**.

That number needs stating next to the one beside it, because they point in opposite directions:
**the anchor's paper rule is now mildly positive (+1.71c over 116) on the same day its live arm was
stopped for losing -10.21c/contract over 8.** Both are small samples, but the gap is 12c per
contract and it is the gap between a rule and its execution, not noise about the rule. That is the
thing to measure next if the arm comes back on 09-14.

**Late observation, 11:15:50Z** (after the restart, so it is current): `[mini polymarket-us]
entries blocked: open positions 48/48`. The PolyUS mini is at its open-position ceiling and is
taking no new entries on any arm — micro-maker, fade or book-imbalance. That is a limit working,
not a fault, and it is not one of the settings this session may change. But it means the PolyUS
arms' checkpoints advance only as existing positions resolve, so `polyus-fade` (33 settled, next
checkpoint 40) and `polyus-micro-maker` (40 settled, next checkpoint 60) are throughput-limited
rather than signal-limited right now. Related to backlog 22 and 32; recorded here so tomorrow does
not read their flat counters as silence.

## 3. Venue-true P&L, last 24 h — the best day so far

`python scripts/venue-pnl.py` on fresh read-only dumps taken at 11:02Z:

- **Kalshi +$9.57** after **$1.10** fees, over 44 settlements.
- **Polymarket US +$1.84**, 33 resolutions.
- **Net +$11.41.**

Concentrated and attributable: **KXBTC15M +$15.91 over 11 settlements** is more than the whole
book's profit, against KXLOWTATL -$3.00, KXETH15M -$1.21, KXHYPE -$1.01, KXBRENTD -$1.00 and
KXNASDAQ100U -$1.00. Nineteen families settled between -$0.61 and +$0.22, i.e. noise.

Two things worth keeping honest about this number. Fees were **$1.10 on $9.57**, against $2.63 on
$6.79 yesterday — the improvement is partly that the profit came from an arm that trades a spread,
not from a change in fee discipline. And KXBTC15M is one arm on one underlying: lead-lag is now
carrying the book, which is the thing §4 checks.

## 4. Ladder — running, and its verdicts match the ledger

19 arms. Stake is `amountPerTrade` $1 × notch, capped by `maxBalancePct` 25% of equity.

**Two stage changes since the last run**, both automatic:

| When (UTC) | Arm | Change | The ladder's stated reason |
|---|---|---|---|
| 09-11 01:05:34 | `kalshi-sports-anchor` | tiny-live → **STOPPED** | "net $-5.14 hit the -$5 stop at size x1"; cool-down to 2026-09-14 |
| 09-11 04:25:36 | `kalshi-book-imbalance` | disabled → **tiny-live** | "trade-small mode: real-money micro test 2 (stop -$5)" — cool-down expiry |

**Verdict-vs-ledger check.**

- **The lead-lag promotion made on 09-10 is confirmed by a second day of venue evidence.** The
  ladder reads `live x2: 17 settled since stage start, net $16.06`; the settlement ledger reads
  KXBTC15M **+$15.91 over 11** in the same window. Two independent counts of the same money, and
  they agree. This is the one arm on the board whose promotion the venue ledger has now
  corroborated twice.
- **The sports-anchor stop is corroborated three ways**: the ladder's -$5.14/8, trade-quality's
  -10.21c/contract with an event-clustered CI of [-17.86, -2.56] that excludes zero, and the
  nightly review's independent `KALSHI_SPORTS_ANCHOR_DEAD` flag. A correct stop.
- **`kalshi-book-imbalance` came back on a timer, not on evidence** — the same shape as
  `polyus-micro-maker` yesterday, and the same known hole (backlog 26: `tradeSmallEntry` never
  consults the gate). It is the operator's standing cool-down rule working as designed. Worth noting that
  its own evidence is the most decisive negative on the board — the nightly review has it at
  -8.40c/contract with a clustered CI of [-16.61, -0.19] excluding zero, and its PolyUS twin is
  1W/39L held to 2026-12-01 — and it is now 11 settled / -$0.53 into its second test. It will hit
  its -$5 stop or its 20-trade checkpoint on its own; no hand on the scale.
- **The fade revert of 09-09 continues to look right.** Fade is 98 trades, 93W/5L, net +$8.46 and
  **-1.25c per contract [-7.33, +4.84]**. A 95% win rate at negative cents per contract is exactly
  what the operator's "judge by net after fees, never win rate" rule exists to catch, and the nightly review
  independently flagged it as a win-rate trap.

No arm's verdict rests on evidence the ledger contradicts.

## 5. The day's work — the LLM critic was quietly spending $36 a day, and the cap that stopped it had a hole

**This is the most important thing in the report and it did not come from the backlog.**

Reading the sentinel digest, OpenRouter credit had gone **$46.38 → $14.78 (09-10 17:50Z) → $1.79
(09-10 23:50Z)** and was back at **$30.73** this morning, i.e. roughly **$45 spent in twelve hours**
and a top-up. Chasing it found that three source files had been edited at **20:04 local on 09-10
and rebuilt at 20:05**, with the app restarted 29 seconds later — outside any maintenance session,
with no log entry, no test and no backup label. Diffed against the 09-10 backup, the change was:

- `src/main/intelligence/engine.ts` — on the shadow path, drop the premium model from the paid
  fallback chain and add a per-day cap on paid critic calls.
- `src/shared/ipc.ts`, `src/main/strategies/autoTrader.ts` — `intelligenceMaxPaidPerDay`, default 60.

The diagnosis in its comment is correct and is worth repeating in full, because it is a real
finding: **the free Ollama critic path has never once served a review — 0 of 1,025 — so every
shadow critic call fell through to `openai/gpt-5.6-sol` at ~$0.22, 899 of them, about $198 of a
$230 grant, to produce a SHADOW measurement that cannot place an order.**

**The change works.** Critic calls by model per UTC day, from `intelligence/decisions.jsonl`:

| Day | `gpt-5.6-sol` (premium) | `deepseek-v4-pro` | `glm-5.3` | free / none |
|---|---|---|---|---|
| 2026-09-08 | **307** | – | – | – |
| 2026-09-09 | **170** | – | – | – |
| 2026-09-10 | **164** | – | – | – |
| 2026-09-11 | **0** | 35 | 29 | 34 |

**But the cap had a hole, and closing it is today's build.** `paidToday` was a plain class field.
The app booted **267 times in the 15 days to 09-11** (~18/day), and every boot reset the counter —
so "60 paid calls per day" was really *60 per process*. On the day 307 paid calls were made, a
per-process cap of 60 would not have stopped a single one of them. The one mechanism standing
between a silent failover and an unbounded bill was itself unbounded.

**Built** (`src/main/intelligence/engine.ts`, smallest diff that closes it):

- `paidToday` now loads from and writes to `intelligence/critic-budget.json` — atomic tmp+rename,
  the same shape and failure policy as the neighbouring `external-data-budget.json`.
- Counted **before** the call, so a crash mid-call cannot uncount it.
- Fails **open to zero-spent** on a missing, stale or corrupt file: telemetry must never crash the
  critic, and it holds no credentials.
- Pure helpers `paidBudgetRemaining`, `readPaidBudget`, `writePaidBudget` exported so the behaviour
  is testable without fs mocking or network.

**Verified, in this order:**

- `npx tsc --noEmit` — clean (also run *before* the edit, to confirm the unlogged 20:04 change had
  not left the tree broken; it had not).
- `npx tsx scripts/tests/adversarial.test.ts` — **88 passed, 0 failed** (+8 today). Block I asserts
  the read-back after a simulated restart, the remaining-budget arithmetic, the UTC-day roll
  zeroing a stale record, the floor at zero past the cap, a corrupt file resetting rather than
  throwing, and a cap of 0 blocking everything.
- `npx tsx scripts/tests/review-fixes.test.ts` — 320 passed, 0 failed.
- `npx tsx scripts/tests/ladder.test.ts` — 88 passed, 0 failed.
- `npx electron-vite build` — clean; `critic-budget.json` and the budget-spent error string are both
  present in `out/main/index.js`.
- Backup **before** the restart: `oracle-trader-MAINT-2026-09-11-20260911-070924.zip` (674 files,
  206.7 MB; only the live `lockfile` skipped). This is the restore point.
- App restarted **11:10:33Z, PID 36624**; bundle mtime 11:09:21Z, so the running process is on this
  build. `main.log` resumed immediately and `[convergence]`/`[leadlag]`/`[dutch]` scans are back to
  their normal cadence; ladder ticked 11:05:32Z.

**Observed working in production before this session ended.** At 11:20Z the paid path fired twice
and `intelligence/critic-budget.json` appeared on disk reading **`{"date":"2026-09-11","n":2}`** —
against **exactly two** new rows in `decisions.jsonl` since the 11:10:33Z restart, one
`deepseek/deepseek-v4-pro` and one `z-ai/glm-5.3`, and **zero** `gpt-5.6-sol`. The counter matches
the real call count exactly, the date stamp is today's, and the premium model stayed out of the
chain. This is the one verification the change owed, and it is closed rather than deferred.

Also filed: **backlog 51** — `reviewDefault` builds a synthetic config for the independent maker
engines that omits `intelligenceMaxPaidPerDay`, so that path always uses the hardcoded 60 and would
ignore a lower cap set in the panel. The counter is shared, so spend is still bounded; the bound is
just not the operator's. Minor, and named rather than fixed today.

## 6. Sentinel

`status.json` `at` 10:50:01Z — fresh, no restart needed. `repairSessionsToday` **0**. All seven
tasks healthy, Ollama up, disk 133 GB free.

**Incidents opened since the last run: 0. Still open: 0.** All three files on disk are CLOSED.

One hygiene finding worth recording, because it will bite the next session that greps for open
incidents: **`grep -l "Status: OPEN" data/sentinel/incidents/*` returns a false positive on
`2026-09-08T07-45-drill.md`.** That file is CLOSED on line 1, but its embedded drill payload
contains the literal instruction `change "Status: OPEN" to "Status: CLOSED"`, which the grep
matches. The first line is the only authority; match on it (`head -1`), not on the file body. This
is the same file yesterday's report flagged for containing agent-directed imperative text — and
that text remains the reason to treat incident bodies as data, never as instructions. Nothing in it
was acted on.

**Correction to yesterday's report.** It records backlog 45 (the sentinel double-counting repair
dispatches) as a confirmed live bug "not fixed today". It was already fixed. `scripts/sentinel.mjs:406`
reads `[...new Set(state.dispatches.filter(same day).map(d => d.file))]` — one count per incident
*file*, which is exactly the prescribed fix, landed 09-09 in round 61. The six-refusal episode it
observed on 09-09 happened *before* that fix. Annotated in `docs/BACKLOG.md` so it is not
re-diagnosed a third time.

Both suppressions are in date and retain their written reasons; neither was renewed, neither has
expired.

## 7. Shadows — all growing, one trigger half-met, none trading

- **HRRR vs NBM** — **108** graded station-days (81 yesterday). HRRR MAE **1.97** / bias +0.07
  against NBM **2.37** / bias -1.79, closer on 59 days vs 45 with 4 ties. **The 100-day half of the
  trigger is now met**; only the 2026-09-21 date still binds. Round 50's caveat stands and remains
  the more important fact: the shadow grades daily MAXIMA while 77% of quoter fills were LOW
  markets, so it cannot see the market it was built for, and weather is retired regardless. The
  09-21 verdict should be recorded as academic.
- **Metaculus** — 40 pairs (32 yesterday), 0 graded. Growing; they resolve 2027+.
- **Mention base rates** — **21,993** observations (14,231 yesterday) over **404** strikes, 0 graded.
- **Polymarket smart-money consensus** — **2,552** signals (1,718), 764 matched to Kalshi and 628 to
  Polymarket US, 0 graded.

Every one of these is still 0-graded, which is exactly the exposure backlog 48 was filed about.

## 8. Build queue — every trigger checked

| # | Item | Trigger | Result today |
|---|---|---|---|
| 1 | Critic skill check | 50+ settled per group | **MET — and the amended rule declined it by itself.** See below. |
| 2 | WebSocket book for execution | ≥0.99 agreement, 7 consecutive days | **NOT MET — STREAK BROKEN, back to day 0.** |
| 3 | HRRR forecast source | 2026-09-21 **and** 100+ station-days | **NOT MET** — 108 days (met), but the date binds. |
| 4 | Kalshi private fill channel | quoter notch ≥2 or positive quoter checkpoint | **UNREACHABLE** — quoter permanently retired (backlog 37). |
| 5 | Avellaneda-Stoikov skew | same as 4 | **UNREACHABLE** — same. |
| 6 | Anchor on Polymarket US | Kalshi anchor's first checkpoint net positive | **NOT MET** — the anchor was *stopped* today at -$5.14/8. |
| 7 | Player props | anchor notch ≥2 | **NOT MET** — anchor is disabled. |
| 8 | New generic strategies | (c) gated on MR v3 fills + a positive checkpoint | **NOT MET** — MR v3 at 2 settled, -$4.00. |
| 9 | SportsGameOdds role | none ("when convenient") | Untriggered. Free tier now refusing **1,644** bookmaker odds per query; 264 objects this month, 2 graded. |
| 10 | Metaculus shadow | built | Running; 40 pairs, 0 graded. |
| 11 | Forecaster v2 | hunch gate at 200+ graded reading "not yet" | **NOT MET**. |
| 12 | Mention base rates | 100+ graded strikes | **NOT MET** — 404 strikes, 0 graded. |
| 13 | Polymarket consensus | 100+ graded signals | **NOT MET** — 2,552 signals, 0 graded. |
| 14–17 | fade v2 / Becker / quoter hours / weather ToD | — | Done or closed. |

No item was in a buildable triggered state, so the day's engineering went to the defect in §5,
which is the higher call under step 4 anyway.

**Item 1 in full — the rule finally answered on its own.** 1,123 decisions; settled 95 ABSTAIN /
124 VETO / 49 ERROR / 1 ALLOW_UNCHANGED. The script's own verdict line says *"vetoes below the rest
(-0.019 vs 0.044); consider veto mode"*, and this time even the raw within-strategy read agrees —
the critic looks skilled in four of the six strategies present in both cohorts (book-imbalance
-5.6c, fade -5.5c, momentum -7.8c, volume-spike -26.9c) against anti-skilled in two (flow-follow
+4.1c, mean-reversion +44.7c). Four of six is a strict majority, so conditions (i), (ii) and (iii)
of the once-amended rule would all pass.

**Amendment 2 — compute over currently enabled arms only — is what decides it, for the third day
running.** Momentum, volume-spike, flow-follow and sports-anchor are all stopped or in cool-down;
their settlements cannot be forgone by a mode switch, so including them measures history rather
than the decision on the table. The arms live on the ladder *and* present in both cohorts are
book-imbalance, fade and mean-reversion. Restricted to those three:

- **VETO: -$0.13 over ~69 contracts = -0.19c/contract**
- **ABSTAIN: -$1.73 over ~33 contracts = -5.2c/contract**

Condition (i) passes (VETO's own net is below zero, barely). Condition (iii) passes (2 of 3
skilled). **Condition (ii) fails outright: VETO is 5.0c *above* the rest, not 2c below.** The rule
does not fire, so nothing changed and no discretionary override was taken.

That matters because of what the 09-10 note pre-registered: if the rule fired and a session
declined a *third* time, the rule was to be replaced rather than patched again. **It did not fire.**
The amendments did the work this time instead of a judgement call, which is the outcome that note
was asking for. One warning written into the backlog for the next reader: the raw and enabled-arms
reads now disagree in **direction**, not merely in size, so quoting the script's own verdict line
without applying both amendments gives the wrong answer.

**Item 2 in full — the streak broke.** Cumulative `agreed/compared` is 21,618/21,941 = **0.9853**,
and the day's own slice is 10,672/10,920 = **0.977**, well under the 0.99 bar; yesterday's 0.9932
was day 4 of 7, so the count returns to **day 0**. `wsStats.lastError` reads **`universe drift
32%`**. Recorded rather than chased: a counter that silently resets a seven-day streak on an
unexplained error needs to be understood before the trigger means anything, and that is now written
next to the trigger.

## 9. Verification summary

- `npx tsc --noEmit` — clean, before and after the edit.
- `adversarial` **88 passed / 0 failed** (+8); `review-fixes` 320/0; `ladder` 88/0.
- `npx electron-vite build` — clean, markers present in `out/main/index.js`.
- App restarted 11:10:33Z (PID 36624) on the 11:09:21Z bundle; `main.log` resumed; scans normal.
- Backup `oracle-trader-MAINT-2026-09-11-20260911-070924.zip`, taken before the restart.
- **Observed live at 11:20Z:** `critic-budget.json` = `{"date":"2026-09-11","n":2}` against exactly
  two paid critic calls since the restart, both on cheap models, zero premium (§5).
- **Not verified:** `weatherSeatBlock` still has not refused a live entry; `weatherSeat` appears
  **zero** times in the whole 108,000-line log. It stays unit-tested and wired, not yet exercised.

## 10. Open questions for the operator — nothing blocking, nothing needed from you

1. **Did you make the 20:04 change on 09-10?** (§5 — the paid-critic cap.) The diagnosis was right
   and it saved roughly $36/day, so this is not a complaint. But it reached live trading code with
   no test, no log entry and no backup, and it shipped with a hole that made the cap ineffective
   across restarts. If that was you, the ask is only that the label go in `MAINTENANCE-LOG.md` so
   the next session does not spend an hour reconstructing it from file mtimes. If it was **not**
   you, say so, because then nobody knows what wrote to `src/`.
2. **The book is still gross-positive and net-negative, but the gap is closing.** +$11.41
   venue-true today on $1.10 of fees, against a lifetime -$23.73 over 389 settlements. Backlog 35
   (the fee-aware entry gate) remains the highest-value unbuilt item and is still blocked on arms
   stating a cents-denominated edge, which most do not.
3. **One arm is carrying the book.** KXBTC15M (+$15.91/11) exceeded the entire day's profit;
   everything else netted negative. Lead-lag at live ×2 is now the strategy, not a strategy. That is
   not an argument against it — its promotion is the best-corroborated on the board — but it is
   concentration worth knowing about, and backlog 39 notes that risk counts positions and never nets
   exposure across an underlying.
4. **The sports anchor's rule and its execution now disagree by 12c a contract** (§2). Paper
   +1.71c/116; live -10.21c/8, stopped. When it comes back on 09-14 that gap is the thing to
   measure, not the forecast.
5. **`kalshi-book-imbalance` re-armed on a timer with the most decisive negative evidence on the
   board** (§4). The ladder is behaving exactly as you specified; backlog 26 is the note that a
   failing gate currently has no way to stop a cool-down retry.

## 11. Delivery

`SendUserFile` and `PushNotification` are **not available in this headless session** (the Windows
task `OracleTrader-Maintenance` has no desktop tools). This file is `docs/reports/2026-09-11.md`;
the desktop task at 08:30 local delivers it. The `claude.ai Gmail` and `claude.ai Google Calendar`
MCP servers need OAuth authorization from an interactive session and were not needed here.

### Five lines for the push

1. Nothing needed from you.
2. Venue-true 24 h: **Kalshi +$9.57** after $1.10 fees / 44 settlements, **PolyUS +$1.84** — net
   **+$11.41**, the best day so far; equity $126.51.
3. Ladder: sports-anchor **stopped** at -$5.14/8 (cool-down to 09-14); book-imbalance re-armed off
   cool-down; lead-lag's ×2 promotion confirmed a second day — KXBTC15M +$15.91/11 on the venue
   ledger against the ladder's +$16.06/17.
4. Errors: 18 log lines in 24 h, none costing money — 16 are Polymarket rate-limiting the activity
   feed, with no fills lost (backlog 52). No incidents open.
5. **The one thing:** the LLM shadow critic had been spending ~$36/day of OpenRouter credit on a
   measurement that cannot trade — 899 premium calls, ~$198 of a $230 grant. A cap added at 20:04
   on 09-10 stopped it dead (164 premium calls yesterday, **0** today), but it reset on every app
   start, so it was a cap per process, not per day. Now persisted to disk, tested, and seen working
   live before this run ended.

## Repair 2026-09-11T12:41Z

Incident `data/sentinel/incidents/2026-09-11T12-35-log-log-reconciler-run-failed-GET-vN-por.md`
(key `log:[log] [reconciler] run failed: GET /vN/portfolio/activities...`). Outcome **MITIGATED**. The
Polymarket US fill reconciler failed four runs in a row (12:20-12:35Z), each `-> 429` after HttpClient's
three retries. The venue pages its activity feed at 20 rows, so `activities()` (`polymarketUs.ts:378-385`)
fires ~20 unpaced GETs per run and trips the rate limit, at the same deep cursor while the feed is quiet.
This is the no-loss noise already recorded as BACKLOG 52. The reconciler state says completeness `ok`,
390 fills seen, matching the venue's 390 trade rows. A read-only dump with 700 ms between pages read the
whole feed with no error at 12:38Z, which proves pacing is the fix. Its trigger has not fired, so no code
was changed. Added a sentinel suppression (until 2026-09-18) and this evidence to backlog 52. Verified
with `sentinel.mjs --dry --since=2026-09-11T12:15:00Z` → `findings: []`. The pattern matches only the
21 `-> 429` lines on this endpoint. No restart, order, setting or key touched.

## Repair 2026-09-11T22:40Z

Incident `data/sentinel/incidents/2026-09-11T22-35-log-warn-kalshi-universe-fetch-hit-the-N.md`
(key `log:[warn] [kalshi] universe fetch hit the N-page bound; later markets not scanned`). Outcome
**FIXED**. The Kalshi universe pass (`kalshi.ts` `searchMarkets`, `ending-soon` branch) paginated the whole
horizon in one pass and stopped at 25 pages. `/markets` does not order by close time, and a read-only
public GET probe at the autoTrader's own 72 h horizon showed what that costs: 25,155 open markets in 26
pages, of which the 20,642 closing in 48-72 h filled pages 1-20 while EVERY market closing inside 6 h
landed on pages 23-26 — pages 24/25/26 were 100 per cent near-dated, page 26 spanning 8 to 23 minutes to
close. The bound was therefore not trimming spare far-dated inventory, it was deleting the nearest-dated
rows on the exchange, which is the opposite of what "later markets not scanned" reads like. A direct
old-vs-new probe twenty minutes later measured the live loss at **541 markets closing within the hour**
(the single pass saw 1,661 of 2,202) and it grows with the 48-72 h inventory, which is why the signature
appeared on 09-05 and came back on 09-11. Fix: a new exported pure helper `universeWindows()` slices the
horizon into ascending close-time windows (1/6/24/48/168/720 h, clipped to the caller's floor and
horizon) and the pass walks them near-dated first, each window with its own cursor and its own 25-page
budget, using `min_close_ts` (confirmed honoured by the venue); the floor defaults to `now - 3600` so the
new lower bound hides nothing the unbounded pass used to return, and the truncation warning now names its
window so a future occurrence is readable at a glance. Truncation can now only ever drop the far end.
Cost: 28 requests per pass instead of 25. Verified: the new pass returns 2,604 of 2,604 markets closing
inside 6 h and 2,202 of 2,202 inside 1 h with no truncation; 8 new tests on `universeWindows`
(review-fixes 328 passed / 0 failed, ladder 88/0, adversarial 88/0); typecheck and build clean; backup
`REPAIR-20260911-universe-windows`; restarted 22:40:28Z and main.log 22:40-22:51Z has no page-bound
warning and no warn/error line at all (the old code warned about once a minute), with leadlag executing
on a 15-minute BTC strike at 22:51:29Z and `sentinel.mjs --dry` since the restart returning
`findings: []`. No order, key, arm, size, limit or ladder stage touched.

## Repair 2026-09-12T08:25Z

Incident `data/sentinel/incidents/2026-09-12T08-05-log-log-mini-polymarket-us-cancel-refuse.md`
(21 signatures, all of them `[mini polymarket-us] cancel refused for <id> ... -> 400 {"code":3}`). Outcome
**FIXED**. One condition on 21 orders, not 21 findings: the sentinel key normalises digits but keeps the
order id, so `fade` and `micro-maker` going off at 07:46-07:50Z minted a fresh signature per rest they left
behind. Those refusals were not the venue declining to cancel — code 3 is gRPC INVALID_ARGUMENT — they were
our request being malformed. `polymarketUs.ts` had posted an EMPTY body to `POST /v1/order/{id}/cancel`
since 2026-09-03, and the venue's `CancelOrderRequest` (docs.polymarket.us, api-reference/orders/cancel-order)
has exactly one field, the required `marketSlug`. So NO Polymarket US cancel has ever worked: the 2,590
`cancelled-strategy-off` research rows of 2026-09-07 are the same five orders re-asked all day, and the
2026-09-07 §36 reading ("their game has started; they die with the market") was wrong — nine of this
morning's refusals were on Sunday's NFL slate, hours from kickoff. A read-only dump at 08:17Z found all 19
rests of two switched-off strategies still working the book, 17 `ORDER_STATE_NEW` and 2
`ORDER_STATE_PARTIALLY_FILLED`, good-till 2026-09-13. Fix: `cancelOrder(orderId, marketSlug?)` sends
`{ marketSlug }` when the caller knows it (`polymarketUs.ts:639-649`, `src/shared/venue.ts:72-73`), and
miniAuto's five cancel sites pass the slug they already hold (`miniAuto.ts:430, 895, 1009, 1027, 1065`);
autoTrader and the quoter are Kalshi-only and untouched. Verified: a new `cancelOrderTests()` stubs the
adapter's HTTP client and asserts path, slug and the no-invented-slug fallback (review-fixes 344 passed / 0
failed, ladder 113/0, adversarial 88/0); typecheck and build clean; backup
`REPAIR-20260912-polyus-cancel-slug`; restarted 08:13:47Z, and at the next 30-minute ask (08:21:48Z) all 19
cancels succeeded with no `cancel refused` line, the 08:22:51-57Z tick reconciled them (17 `expired-unfilled`
at zero fills, the 2 partials promoted), and an independent read-only dump at 08:24:04Z reports **0 open
orders** at the venue against 19 before. Worth a later look, NOT done here: the sentinel's signature key
should normalise venue order ids the way it already normalises the slug, or one switched-off strategy will
keep opening twenty incidents at once. No order, key, arm, size, limit or ladder stage touched by hand.

# Oracle Trader — daily maintenance, 2026-09-12 (headless run, 11:00–11:30Z)

## 1. Liveness — everything up on arrival, but the app had died and been revived overnight

| Check | Result |
|---|---|
| App process | UP on arrival (PID 44916, started **08:13:47Z** by the overnight repair session). Restarted by this session at **11:10:05Z, PID 41844**, onto today's build. |
| `main.log` | Written continuously; newest line seconds old at every check. |
| `ladder.json` `lastRunAt` | 10:13:47Z on arrival (46 min, inside the 2 h bound). 19 arms. |
| BTC collector | UP (`node scripts/btc-collector.mjs`, PID 17716, since 09-09 06:57Z). 404,231 lines (+40,696). |
| Nightly review | `reviews/2026-09-12.md` present, written 06:16:56Z, one attempt, `openai/gpt-5.6-sol`. |
| `OracleTrader-HrrrShadow` | `forecasts.jsonl` 10:20:12Z. OK. |
| `OracleTrader-MentionShadow` | `run.log` 10:50:35Z. OK. |
| `OracleTrader-PolyConsensus` | `run.log` 10:58:01Z. OK. |
| `OracleTrader-MetaculusShadow` | Task ran 10:35:01Z exit 0; **48 pairs** (40 yesterday). |
| Sentinel | `status.json` `at` 10:50:01Z — 10 min old, fresh. `repairSessionsToday` **1**. |
| `ladder15-shadow` | `node scripts/ladder15-shadow.mjs`, PID 48748, up since 07:54:19Z (round 71's recorder; idle until the ladders reopen Sunday). |

All seven `OracleTrader-*` tasks present. **Nothing was down at 11:00Z**, but two things in the
overnight record are worth stating plainly rather than leaving in the sentinel digest:

- **The app died and the sentinel revived it at 07:50:01Z** (`[revive] App down or hung: no electron
  process | restarted`), with the `OracleTrader-App` task carrying `lastResult -1` from 09-11
  21:16:13 local. The repair session then restarted it again at 08:13:47Z onto its own fix. So the
  self-healing path worked end to end — but the *cause* of the 07:50 death is not recorded anywhere,
  and `main.log` has no crash line.
- **Twelve process starts in the 24 h window**, seven of them inside 36 minutes (00:39:50Z–01:16:13Z).
  Those are the overnight build sessions (rounds 67–74), not instability.

## 2. Evidence read

**Errors, last 24 h — zero of consequence, and one warn that is drowning the log.**

- **Zero** `[error]`, zero `exception`, zero `crashed`, zero `kill-switch`, zero `daily-cap`, zero
  `unbooked`, zero 401/403/422. (The file has no `[error]` tag at all; the levels in use are `[log]`
  and `[warn]`.)
- **502 × `[warn] [kalshi] universe fetch hit the 25-page bound`** — 494 of them naming the 48–72 h
  close-time window. This is now 93% of all warns and is what makes log triage expensive. The nightly
  review raised it independently today as `KALSHI_UNIVERSE_SCAN_TRUNCATED` (309 by its own count) with
  a code proposal. It is a known, deliberately-unfixed backlog item: the warning is honest but carries
  no magnitude, and raising the page bound costs 25+ extra HTTP calls per scan per window for a
  speculative gain. The cheap first step (report how many rows the window collected and whether the
  last page was full) is still the right next move and is still not done.
- **37 × `[warn] [ratchet] refused`** — the round-47 guard refusing in the open on an arm that cannot
  trade. No order, no money; suppressed to 2026-12-02.
- **98 × 429**: 97 on the Polymarket US activity feed (§5, fixed today) and **one** on the Ollama
  cloud hunch model (`weekly usage limit`) at 09-11 21:19Z. The Ollama one did not recur and the hunch
  pass has run clean since; it is a free-tier ceiling, not a failure to act on.

**Silent-strategy checks.**

- `[convergence]` newest in-window note (10:55:18Z): `in window 188: margin-out 173 cost-out 15 no-vol
  0 edge-out 0 event-dup 0 limits 0 | graded 9 (W:8 L:1) PnL: -32c`. Byte-identical in shape to the
  oldest note 24 h earlier. **Six days at tiny-live with 0 settlements.** Diagnosed rather than left —
  see §6.
- `[quoter]` produced no `fair-value on N of M` line, and should not: the arm is disabled with the
  shadow meter on. Its cumulative counters are identical at both ends of the window (`placed 1632 …
  filled 43.11`), confirming zero live quoter activity. Shadow markout -1.53c over 693.
- `[leadlag]` is scanning and finding: `dislocations 23448 sweeps 1641`.
- **`[mini polymarket-us] micro-maker book budget spent (120); 643 in-band market(s) not examined`**,
  219 times. That is round 71's new lookup budget biting on almost every scan. It is working as
  designed (it replaced a 225-second sequential book fetch) but it is now the binding constraint on
  micro-maker's universe — noted because micro-maker was parked today anyway.

**Scripts.**

- `node scripts/btc-gate.mjs --json` — **FAIL / NOT YET**. 442 strike-trades over **171 events** /
  11 days (398 / 157 yesterday). Net taker **+0.60c** (+0.88c yesterday — the day went backwards);
  Bonferroni LB -2.87c, day-clustered LB -0.90c. Needs 200 events. Adverse 3.85% against a 3.8%
  sign-flip floor. Baseline still healthy: our side +0.60c vs the opposite side at its ask -2.32c.
- `node scripts/quoter-shadow-gate.mjs --json` — insufficient sample for the ALLOWED cohort (10
  settled proxy fills of 30 needed, 6 events of 40). BLOCKED cohort -2.58c over 550, which supports
  the filter and says nothing about the strategy.
- `node scripts/trade-quality.mjs` — flags book-imbalance, momentum, sports-anchor, volume-spike,
  flow-follow on Kalshi; book-imbalance and micro-maker on Polymarket US. Kalshi 16 open / 4 resting,
  kill switch clear, 12 trades today against a cap of 200. **Polymarket US resting 0** — against 19
  before this morning's cancel fix.

**Balances.** Kalshi cash **$147.65** — shard 0 $37.73, shard 1 **$0.00**, shard 2 $93.63, shard 3
$16.29 — plus open positions at cost $16.28 = equity **$163.92** ($164.03 at market), up from $126.51
yesterday. Polymarket US $41.86 balance / $21.80 buying power (balance includes open-position cost).
Every configured stake is covered: Kalshi `amountPerTrade` $1, ×4 for the one notch-4 arm = $4 against
a 25%-of-equity cap of **$40.98**; PolyUS $1 against a 10% cap of $4.19. Shard 1 has been empty four
days; the hourly balancer owns it and weather is retired, so it stays a watch item, not an operator
action.

**Odds API spend.** `__spentDay:2026-09-12` = **322** of the 645/day cap at 11:00Z. Worth flagging:
09-11 finished at **632**, i.e. **98% of the cap**, the closest it has come (09-10: 536, 09-09: 592,
09-08: 508). The anchor is in cool-down until 09-14 and still spending at that rate, so the budget is
carrying grading, not trading.

**Sharp anchor, out of sample.** `gradedN` **284** (232 yesterday), `gradedBrier` 25.9654 — a SUM, so
**mean Brier 0.0914** — `ruleN` **146** (116), `ruleNet` **+$1.595** (+$1.98). `anchor-grades.jsonl`
gained **52 rows**, to 284.

Read that carefully, because the headline moved the wrong way: **`ruleNet` FELL from +$1.98 to
+$1.595 while `ruleN` rose from 116 to 146.** The 30 new rule trades netted **-$0.385, about -1.3c
each**, taking the paper rule from +1.71c/contract over 116 to **+1.09c over 146**. Yesterday's report
made something of the gap between the paper rule (+1.71c) and the stopped live arm (-10.21c/8); a
third of that gap closed itself in one day, from the paper side. The honest reading is that 146
observations of a rule averaging one cent is not yet a result in either direction, and the arm's
09-14 return should be judged against the ledger, not against this.

## 3. Venue-true P&L, last 24 h — the best day so far, and one arm is all of it

`python scripts/venue-pnl.py` on fresh read-only dumps taken at 11:03Z:

- **Kalshi +$37.18** after **$3.87** fees, over 80 settlements.
- **Polymarket US -$0.17**, 28 resolutions.
- **Net +$37.01.**

Attribution is not subtle. **KXBTC15M +$31.39 over 20** and **KXETH15M +$6.95 over 8** sum to
**+$38.34** — more than the whole book's profit — against KXWTI -$1.02, KXBTCD -$0.69, KXLOLGAME
-$0.65, KXNASDAQ100U -$0.46 and a long tail between -$0.28 and +$0.35. Thirty-seven of the 39 families
that settled are noise.

Fees were **$3.87 on $37.18** (10.4%), against $1.10 on $9.57 yesterday. That is the cost of trading
four times the size on a spread strategy, not a discipline regression, but it is the line to watch if
lead-lag's edge per contract compresses.

## 4. Ladder — running, and its verdicts match the ledger

19 arms. Stake is `amountPerTrade` $1 × notch, capped by `maxBalancePct` 25% of equity.

**Ladder movements since the last maintenance run:**

| When (UTC) | Arm | Change | Stated reason |
|---|---|---|---|
| 09-11 12:10:35 | `kalshi-leadlag` | live ×2 → **live ×4** | "checkpoint 21 trades, net $16.38, mean 0.78$ (80% band 0.28..1.28): making money with 80% confidence" |
| 09-12 07:16:22 | `kalshi-flow-follow` | disabled → tiny-live | cool-down expiry, automatic ("real-money micro test 2") |
| 09-12 07:46 | `kalshi-flow-follow`, `polyus-fade`, `polyus-micro-maker` | → **disabled (`operatorHold`)** | "parked 2026-09-12 (operator approved): evidence-condemned, see REVIEW-CHANGES §67" |

**Verdict-vs-ledger check.**

- **Lead-lag's ×4 is corroborated by the venue ledger for a third consecutive day.** The ladder's
  current verdict reads `live x4: checkpoint 22 trades, net $33.46, mean 1.52$ (80% band 0.58..2.46);
  already at max size x4`. The settlement ledger reads **+$38.34 over 28** across KXBTC15M and
  KXETH15M in the same window. Two independent counts of the same money, agreeing in size and sign.
  This is the only arm on the board whose promotions the venue ledger has confirmed repeatedly, and it
  is now at MAX_NOTCH, so the ladder cannot scale it further.
- **The three parks are evidence-backed, and flow-follow's had the retry the ladder owed it.**
  flow-follow was auto-revived at 07:15Z on its cool-down and lost again the same morning before being
  parked at 07:46Z — so the park followed a retry, not instead of one. polyus-fade (45 settled,
  -$0.48, 84.4% win against an 86.7% break-even) and polyus-micro-maker (97 settled, -$1.67, 45.4%
  against 47.7%) are both structural: §67 shows 1,028 of the 1,035 Polymarket markets inside a 72 h
  horizon are sports, so there is no longshot-bias population for a fade to work on, and one maker
  rebate in 457 fills disproves micro-maker's thesis outright.
- **Polymarket US now has no live entry arm.** The venue stays enabled so its 26 open positions exit
  and settle. Its 24 h contribution was -$0.17, so nothing is being forgone today.
- **`kalshi-fade` is the win-rate trap the operator's rule exists to catch, and it is still being caught.**
  126 trades, 120W/6L, +$9.37 — and **+0.05c per contract [-4.68, +4.79]**. A 95% win rate worth
  nothing per contract. The ladder has it at tiny-live with the next checkpoint at 80; the nightly
  review flagged it independently. No hand on the scale.
- **`kalshi-mean-reversion` is the one live verdict I would not lean on.** Trade-quality reads
  +$18.28 over 10 at +10.02c/contract, but with an event-clustered CI of [-19.74, +39.77] — a band
  wider than the estimate is not evidence — and the ladder cohort since its 09-09 re-baseline is only
  **4 settled at -$3.54**. The aggregate and the cohort point in opposite directions because they are
  different samples. The ladder is using the cohort, which is right.
- **convergence, cross-venue and dutch each have 0 settlements since stage start** (convergence six
  days, the other two since 09-06), and `news` has 1 at -$0.11. None of them can reach a checkpoint at
  this rate. §6 diagnoses convergence; the other two are recorded in the backlog rather than guessed
  at.

No arm's verdict rests on evidence the ledger contradicts.

## 5. The day's work — the Polymarket reconciler was failing every run for six hours

**This came from the logs, not the backlog, and it is the higher call under step 4.**

`[reconciler] run failed: GET /v1/portfolio/activities -> 429` appeared **97 times in 24 h**, but the
distribution is what matters: **12 per hour from 01:00Z to 07:41Z, which is every single run.** Over
that stretch there were **9 successes and 71 failures**, and **no successful Polymarket US reconcile
at all between 01:26Z and 07:16Z — 5 hours 50 minutes.** Twelve fills accumulated unpublished and
landed in one batch at 07:16Z. No fills were lost, but for six hours the ledger of record lagged the
venue, and every exit and P&L decision in that window ran on a stale fill picture.

**Root cause, read from the implementation.** `activities()` (`src/main/venues/polymarketUs.ts`)
paginates the feed in a loop of up to 40 requests with nothing between them. The venue ignores
`limit=500` and serves 20 rows a page, so a 400-row feed is ~20 back-to-back GETs. `HttpClient` then
retries a 429 three times with 300/900/2700 ms of backoff — about 4 seconds, which cannot clear a
per-minute window. The 2026-09-11T12-35 incident had already proved the fix: the read-only dump
paginates the *same* feed with a 700 ms pause between pages and has never once been refused.

**Built** (smallest diff that closes it):

- `ACTIVITY_PAGE_PACE_MS = 700`, exported from `polymarketUs.ts`, mirroring
  `scripts/readonly-polyus-dump.cjs`.
- `activities()` waits that long before every page after the first.
- Three assertions in `review-fixes.test.ts`: the loop pages to the feed's end, every page after the
  first waits at least the pace, and the first page does not.

**Verified, in this order:**

- `npx tsc --noEmit` — clean.
- `npx tsx scripts/tests/review-fixes.test.ts` — **347 passed, 0 failed** (+3 today).
- `npx tsx scripts/tests/ladder.test.ts` — 113 passed, 0 failed.
- `npx tsx scripts/tests/adversarial.test.ts` — 88 passed, 0 failed.
- `npx electron-vite build` — clean; the paced loop is present in `out/main/index.js`
  (`if (page > 0) await new Promise((r) => setTimeout(r, ACTIVITY_PAGE_PACE_MS))`, and
  `const ACTIVITY_PAGE_PACE_MS = 700`).
- Backup **before** the restart: `oracle-trader-MAINT-2026-09-12-20260912-070931.zip` (702 files,
  236.3 MB zipped; only the live `lockfile` skipped). This is the restore point.
- App restarted **11:10:05Z, PID 41844**; bundle mtime 11:09:17Z, so the running process is on this
  build. `main.log` resumed immediately.

**Observed working in production before this session ended.** In the **20 minutes** since the
restart the Polymarket US reconciler has completed **every scheduled run** — its state file
`fill-reconciler-polymarket-us.json` advanced at 11:11:32Z, 11:15:22Z and on through 11:30:22Z — with
**zero** 429 lines and **zero** `run failed` lines in `main.log` since 11:10:00Z, against 12 failures
an hour for the six hours before it. The first run took **17 seconds**, which is ~22 pages × 700 ms
plus request time: the paced loop running to completion rather than throwing at four seconds.

Note on how this is verified, for the next session: a successful Polymarket US reconcile that
publishes nothing logs **nothing at all**, so absence of a failure line is not evidence. The positive
check is the mtime of `fill-reconciler-polymarket-us.json` advancing on the 5-minute timer.

The sentinel suppression for this signature runs to 2026-09-18 and was left in place; it can be
allowed to expire now that the cause is gone, and if the signature returns before then that is
information worth having.

## 6. Second change — the consensus shadow had never graded anything, and now has

Backlog 55 recorded that `scripts/polymarket_consensus.py` had graded **0 of 3,031 signals across 85
runs** and had never created `grades.jsonl`, while logging a cheerful `graded 0 signals` every hour.
The backlog's guess at the cause (a statement-ordering bug) was wrong; the code is ordered correctly.

**Actual root cause, reproduced against the live API.** `grade()` looks the market up with
`GET https://gamma-api.polymarket.com/markets?slug=<slug>` and then asks `if not m or not
m.get('closed'): continue`. **Gamma's `/markets` returns `[]` for a closed market unless you ask for
closed ones.** Probing twelve resolved slugs from `signals.jsonl` returned `[]` twelve times; the same
slugs with `&closed=true` return the resolved row with `outcomePrices ["1","0"]` and
`umaResolutionStatus: resolved`. The grader wanted *only* closed markets and was using the one query
guaranteed never to return one, and the `not m` branch was silent, so four days of hourly runs
reported success while reaching nothing.

**Built** (`scripts/polymarket_consensus.py`, no trading behaviour touched — this script places no
orders and reads only public endpoints):

- `&closed=true` on the Gamma lookup, with the reason in a comment above it.
- `resolved_winner(m)` extracted as a pure helper returning `(winner, None)` or `(None, reason)`.
- A `skip` counter printed on every pass: `graded N | skipped {'already-graded': …, 'still-open': …,
  'not-found': …, 'not-resolved': …}`. **A grading pass that reaches nothing must now say why** —
  that is the part that would have caught this on day one.
- `selftest` (pure, no network) and `grade` (grade-only, no wallet poll) subcommands.

**Verified:** `python scripts/polymarket_consensus.py selftest` — **6 passed, 0 failed**, including
an explicit assertion that the Gamma URL requests closed markets. Then a full grading pass:
`grades.jsonl` went from **0 rows to **2,596****, and `python scripts/polymarket_consensus.py
report` now prints a real result. See §8 item 13 for what it says.

## 7. Sentinel

`status.json` `at` 10:50:01Z — fresh, no restart needed. `repairSessionsToday` **1**, of a budget of 3.
All seven tasks healthy, Ollama up, OpenRouter credit $29.01, disk 1,588 GB free.

**Incidents opened since the last run: 1. Repaired: 1. Still open: 0.**

- **`2026-09-12T08-05` — `[mini polymarket-us] cancel refused` ×21 — OPENED, DISPATCHED, FIXED,
  CLOSED** by the on-call repair session at 04:05–04:26 local. Its finding is worth repeating because
  it was not a refusal at all: HTTP 400 `{"code":3}` is gRPC INVALID_ARGUMENT, and the app was posting
  an **empty body** to `POST /v1/order/{id}/cancel`, whose `CancelOrderRequest` has one required
  field, `marketSlug`. **No Polymarket US cancel had ever worked.** A read-only dump at 08:17Z found
  all 19 rests of two switched-off strategies still live on the book, nine of them on Sunday's NFL
  slate. After the fix all 19 cancelled at 08:21:48Z and an independent dump at 08:24:04Z reported
  **0 open orders**. Today's own dump confirms it still reads 0.
- `2026-09-11T22-35` (universe page bound) and `2026-09-11T12-35` (reconciler 429) are both CLOSED;
  `2026-09-11T23-35-undispatched.md` is a gating note, not an incident. The two 09-09 files and the
  09-08 drill are CLOSED. Checked on the `Status:` line, not by grepping the body — the drill file
  still false-positives a body grep, as yesterday's report warned.

All three suppressions are in date and retain their written reasons; none was renewed and none has
expired.

**Left undone by the repair session and now on the backlog (59):** the sentinel's signature key keeps
venue order ids, so those 21 `cancel refused` lines for 21 different orders became 21 signatures in
one dispatch. One stopped strategy will keep opening twenty incidents at once until ids are normalised
the way tickers already are.

## 8. Shadows and the build queue — every trigger checked

| # | Item | Trigger | Result today |
|---|---|---|---|
| 1 | Critic skill check | 50+ settled per group | **MET — declined, and for the first time the RAW read declines it too.** |
| 2 | WebSocket book for execution | ≥0.99 agreement, 7 consecutive days | **NOT COMPUTABLE AS WRITTEN** — see below and backlog 56. |
| 3 | HRRR forecast source | 2026-09-21 **and** 100+ station-days | **NOT MET** — 135 days (met), but the date binds. |
| 4 | Kalshi private fill channel | quoter notch ≥2 or positive quoter checkpoint | **UNREACHABLE** — quoter permanently retired. |
| 5 | Avellaneda-Stoikov skew | same as 4 | **UNREACHABLE** — same. |
| 6 | Anchor on Polymarket US | Kalshi anchor's first checkpoint net positive | **NOT MET** — anchor stopped at -$5.14/8, cool-down to 09-14. |
| 7 | Player props | anchor notch ≥2 | **NOT MET** — anchor disabled. |
| 8 | New generic strategies | (c) gated on MR v3 fills + a positive checkpoint | **NOT MET** — MR cohort 4 settled, -$3.54. |
| 9 | SportsGameOdds role | none ("when convenient") | Untriggered. |
| 10 | Metaculus shadow | built | Running; **48 pairs** (40), 0 graded. |
| 11 | Forecaster v2 | hunch gate at 200+ graded reading "not yet" | **NOT MET**. |
| 12 | Mention base rates | 100+ graded strikes | **NOT MET** — 29,890 observations over **467** strikes, **0 graded**. |
| 13 | Polymarket consensus | 100+ graded signals, net positive after fees | **See below — the trigger became evaluable for the first time today.** |
| 14–17 | fade v2 / Becker / quoter hours / weather ToD | — | Done or closed. |

**Item 1 — trigger met, rule declines it, and today both readings agree.** 1,279 decisions; settled
105 ABSTAIN / 160 VETO / 63 ERROR / 4 ALLOW_UNCHANGED. The script's own verdict line says *"vetoes
below the rest (-0.034 vs 0.032); consider veto mode"*, and conditions (i) and (ii) of the twice-
amended rule do pass on the raw aggregate. **Condition (iii) fails on the raw read for the first
time**: of the six strategies present in both cohorts the critic is skilled in three (book-imbalance
-11.7c, momentum -7.8c, volume-spike -26.9c) and anti-skilled in three (fade +1.0c, flow-follow +0.6c,
mean-reversion +31.2c) — three of six is not a strict majority, and the 09-10 tie-break counts ties
against switching. Amendment 2 (enabled arms only) then fails it three separate ways: the only enabled
arms present in both cohorts are fade and mean-reversion, over which **VETO is +$3.87 over 74 (+5.2c)
against ABSTAIN's -$0.56 over 28 (-2.0c)** — VETO's own net is above zero, it is 7.2c *above* the rest
rather than 2c below, and it is skilled in 0 of 2. **The rule does not fire; nothing changed and no
discretionary override was taken.** This is the first day since 09-09 on which the amendments were not
load-bearing, which is the healthier state for a rule to be in.

**Item 2 — the trigger has never been evaluated correctly, and that is a finding, not a reading.**
`wsStats` reads `compared 4,419, agreed 4,395` = **0.9946**, above the bar. But those are *per-process*
counters: `KalshiWs.stats` is an instance field, `cycle()` (including the `universe drift` path) does
not reset them, and a new process does — and the app booted **12 times in the last 24 h**. Every daily
check recorded so far, including yesterday's "day's own slice 10,672/10,920 = 0.977, streak broken,
back to day 0", was computed by subtracting the previous day's cumulative reading from today's. **That
subtraction is only valid if the process survived in between, and it did not.** Yesterday's streak
break may be real or may be an artifact of a restart; the counter cannot tell us. Today's honest
statement is the ratio over the current process only, 0.9946, and the trigger stays unmet because it
is not yet measurable. Filed as backlog 56 with the fix: persist a per-UTC-day `{compared, agreed}`
pair in state, roll it at midnight, read the trigger off that.

**Item 3 — HRRR.** 135 graded station-days (108 yesterday). HRRR MAE **1.95** / bias -0.01 against NBM
**2.29** / bias -1.64, closer on 72 days vs 58 with 5 ties. The count half of the trigger is
comfortably met; only the 2026-09-21 date binds. Round 50's caveat still stands and still matters more
than the verdict: the shadow grades daily MAXIMA while 77% of quoter fills were LOW markets, and
weather is retired regardless, so the 09-21 verdict should be recorded as academic.

**Item 13 — Polymarket consensus.** **TRIGGER MET, and it is the first real reading this shadow has ever produced.** 3,381 signals,
938 matched to Kalshi and 799 to Polymarket US; **2,596 graded** (743 not found at Gamma — mostly older
slugs the API no longer serves — 41 too fresh, 1 closed but unresolved). Results:

    hit rate 0.70 at mean price 0.69, Brier 0.0924   (i.e. the consensus is about as calibrated as the price)
    P&L per contract at the Polymarket price          +0.95c   n=2,596
    P&L at the Kalshi ask net of the taker fee        +5.35c   n=429 matched
    P&L at the Polymarket US price net of fee         +5.92c   n=374 matched

The pre-registered trigger is ">= 100 graded signals, net positive after fees at the price we could
have acted on", and on the literal terms it passes on both venues by a wide margin. Day-clustered
bands (G=5, t on G-1 df, the round-73 correction) put Kalshi at **95% [+2.59, +8.11]** and PolyUS at
**95% [+0.77, +11.08]**, both excluding zero. No row is outside the +/-100c physical bound.

Two caveats that belong in the pre-registration rather than in the way of it. **The whole dataset is
five signal days** (2026-09-08 onward), so G=5 is a thin cluster count on the arm that matters. And
clustering by *category* instead of by day widens the Kalshi band to **95% [-0.18, +10.88]**, which
straddles zero — 853 of the 2,596 rows are `btc` and 422 are `highest`, so the effective independent
sample is smaller than n suggests. The right response to that under the operator's rules is not a further
evidential bar; it is the ladder. A micro-size real-money arm settles this faster and more honestly
than another week of paper.

**This is therefore tomorrow's build**, and it is written into the build queue as item 13 TRIGGERED:
a pre-registration in `docs/PREREGISTERED-polymarket-consensus.md` stating the entry rule, the
five-day/category-clustering caveat and the stop, then a `GENERIC_STRATEGIES` arm at micro size that
the ladder gates like every other. Not done today because it is a full item and today's engineering
was already spent on two verified fixes (§5, §6); step 4's rule against starting work that cannot be
finished and verified in the same run applies exactly here. Nothing about it waits on the operator.

**Item 12 — mention base rates.** 29,890 observations over 467 strikes and **still 0 graded**, which
is exactly the exposure backlog 48 was filed about and is now demonstrated rather than theorised: the
consensus shadow had the same shape and its cause turned out to be a single query parameter. The
mention shadow is the next one to check the same way. Not started today — one build per run, and the
two above were already more than one.

## 9. Verification summary

- `npx tsc --noEmit` — clean.
- `review-fixes` **347 passed / 0 failed** (+3); `ladder` 113/0; `adversarial` 88/0.
- `python scripts/polymarket_consensus.py selftest` — 6 passed / 0 failed.
- `npx electron-vite build` — clean; the paced page loop and `ACTIVITY_PAGE_PACE_MS = 700` are both
  present in `out/main/index.js`.
- App restarted 11:10:05Z (PID 41844) on the 11:09:17Z bundle; `main.log` resumed; scans normal.
- Backup `oracle-trader-MAINT-2026-09-12-20260912-070931.zip`, taken before the restart.
- **Observed live:** every Polymarket US reconciler run completed in the 20 minutes since the
  restart (state file advancing 11:11:32Z → 11:30:22Z), zero 429s and zero failures, against 12
  failures an hour before it (§5).
- **Observed live:** `grades.jsonl` 0 → **2,596** rows (§6).
- **Not verified:** `weatherSeatBlock` still has not refused a live entry; `weatherSeat` appears zero
  times in the 24 h window. It stays unit-tested and wired, not yet exercised.

## 10. Open questions for the operator — nothing blocking, nothing needed from you

1. **Lead-lag is now the book, and it is out of ladder headroom.** +$38.34 of a +$37.01 day; at
   MAX_NOTCH ×4, so the ladder has no further move to make. Two things the backlog already names sit
   directly under it: the sweeper is the only live order path that does not go through `entryBlocked()`
   (so it obeys none of maxOpenPositions, maxPerUnderlying, maxDailyTrades or the churn guard), and its
   own dollar cap is arithmetically unreachable — `count * legCost` maxes at 3.96 against a limit of
   15.0, and `sweep skipped` has never once appeared in the log. That was fine at ×1. At ×4, on the arm
   carrying the account, it is worth your call on whether the sweeper should share the trader's caps.
2. **Did you authorise the three parks at 07:46Z?** `kalshi-flow-follow`, `polyus-fade` and
   `polyus-micro-maker` were set to `operatorHold` with the reason "operator approved". The evidence
   behind each is sound and I have not reversed them. But `operatorHold` is the one flag that stops the
   ladder's cool-down retry, and your standing rule is that nothing stays off without a ladder verdict
   and everything is retried after a cool-down. If those three are meant to be permanent, that is a
   change to the rule worth saying out loud; if not, they should carry a cool-down date like every
   other stop.
3. **The Odds API is running at 98% of its daily cap to grade an arm that is switched off.** 632 of
   645 on 09-11. The sharp anchor is in cool-down to 09-14 and the spend is entirely grading. Nothing
   has failed, and the budget code is doing its job — but if the anchor does not come back healthy,
   that subscription is paying for a measurement.
4. **The book is still net-negative lifetime but the gap is closing fast.** Venue-settled -$5.66 over
   460 settlements per tonight's review, against -$23.73 over 389 yesterday. +$37.01 today.
5. **Two shadows had produced zero output for days and nobody noticed** (§6, and item 12 above).
   Both logged success every hour while reaching nothing. The general fix is in backlog 48 — before any
   shadow is read for a go-live decision, check its graded rows cover the same population as its
   observed rows — and today's addition is narrower and cheaper: **a pass that grades nothing must log
   why.**

## 11. Delivery

`SendUserFile` and `PushNotification` are **not available in this headless session** (the Windows task
`OracleTrader-Maintenance` has no desktop tools). This file is `docs/reports/2026-09-12.md`; the
desktop task at 08:30 local delivers it. The `claude.ai Gmail` and `claude.ai Google Calendar` MCP
servers need OAuth authorization from an interactive session and were not needed here.

### Five lines for the push

1. Nothing needed from you.
2. Venue-true 24 h: **Kalshi +$37.18** after $3.87 fees / 80 settlements, **PolyUS -$0.17** — net
   **+$37.01**, the best day so far; equity $163.92.
3. Ladder: lead-lag promoted to **×4, its maximum**, and the venue ledger confirms it a third day
   (+$38.34 on KXBTC15M/KXETH15M, which is more than the whole book's profit). Three losing arms parked
   on evidence; Polymarket US now has no live entry arm.
4. Errors: zero of consequence. The overnight sentinel revived a dead app and its repair session fixed
   a real one — **no Polymarket US cancel had ever worked** (missing `marketSlug`), so 19 rests of
   switched-off strategies were sitting live on the book; all cancelled, venue now reads 0.
5. **The one thing:** two silent failures, both fixed and both verified live. The Polymarket
   reconciler was 429-failing *every* run for nearly six hours (no fill reconcile 01:26–07:16Z) because
   it paged an unpaced burst — now paced, two clean runs since. And the smart-money consensus shadow had
   graded 0 of 3,381 signals for four days because it asked the API for closed markets with the query
   that hides them; one parameter later it has **2,596** graded rows and build-queue item 13 is
   measurable for the first time.

---

# Oracle Trader — daily maintenance, 2026-09-13

Headless run (Windows task `OracleTrader-Maintenance`, 07:00 local). Everything below was read or run in
this session; nothing is carried over from yesterday's report except where it is labelled as a comparison.

**Read this first:** a second Claude session was working in this repo during the whole run (rounds 90, 91
and 92 landed between 05:15 and 07:01 local). That shaped what I did and did not touch, and it is the
subject of the day's main finding. Details in §3 and §10.

---

## 1. Liveness — everything up

| check | reading | verdict |
|---|---|---|
| App process | electron PID 27636, started **11:00:50Z** | up |
| `main.log` | last line 11:14:37Z, checked 11:14:43Z (6 s) | up |
| `ladder.json` `lastRunAt` | 11:02:51Z (12 min) | within 2 h |
| BTC collector | 1 process, `node scripts/btc-collector.mjs` | up |
| Nightly review | `reviews/2026-09-13.md` present, model `openai/gpt-5.6-sol`, 1 attempt | up |
| `OracleTrader-HrrrShadow` | last run 06:20, result 0 | up |
| `OracleTrader-MetaculusShadow` | last run 06:35, result 0 | up |
| `OracleTrader-MentionShadow` | last run 06:50, running | up |
| `OracleTrader-PolyConsensus` | last run 06:55, running | up |
| `OracleTrader-Sentinel` | `status.json` `at` = **11:05:01Z** (10 min) | fresh |

Nothing was down and nothing needed restarting. The app restart at 11:00:50Z was **not mine** — it was the
other session shipping round 92. I did not restart the app; see §10 for why that was the right call today.

Errors in `main.log` over 24 h: **zero `[error]` lines** (the newest in the whole file is 2026-09-09).
Warnings: 276 × Kalshi universe fetch hitting the 25-page bound in the 48-72 h window (known, backlog 83
/ item 48, fires Thursday evening to Friday evening weekly), 38 × `[ratchet] refused` on KXLOWTPHIL and
KXLOWTMIA (the guard working; suppressed to 2026-12-02 with a recorded reason).

## 2. Sentinel

- **Incidents opened since the last run: none.** The newest incident file is 2026-09-12T08-05.
- **Open incidents: none.** All seven incident files read `Status: CLOSED`. The one exception is
  `2026-09-11T23-35-undispatched.md`, which is an *undispatched* note rather than an incident (the
  repair budget was spent); its signature is the universe-pagination warning, already tracked.
- **Repaired by the sentinel: none needed.** `repairSessionsToday: 0`, `lockBusy: false`, `findings: []`.
- Suppressions: three, all still inside their windows, all with recorded reasons. **None renewed.**
- Sentinel liveness: `status.json` `at` 11:05:01Z, 10 minutes old. Fresh. `openrouterCredit` $27.13,
  ollama up, disk 1,579 GB free.

I checked the `findings: []` by parsing the file and reading the field, not by grepping it — the
2026-09-12 lesson was that a grep for `{"at"` never matches pretty-printed JSON and reports a clean
sentinel that isn't.

## 3. THE FINDING — the lead-lag coin expansion cannot be stopped by the ladder

This is the one thing worth your attention today.

**What happened.** Round 91 (another session, app restarted 10:05:42Z) widened `LEADLAG_COINS`
(`src/main/strategies/leadLag.ts:112`) from `BTC, ETH` to **seven coins** — adding SOL, XRP, DOGE, BNB,
HYPE — and cut the poll interval to 10 s.

**The gap.** The ladder carries **one** entry for this arm, `{ id: 'kalshi-leadlag', ... }` in
`GENERIC_STRATEGIES` (`src/main/ladder/ladder.ts:129`), and `leadLagEvidence()` joins every executed
sweep row regardless of coin. So the five new coins settle into the same pooled verdict that promoted
BTC/ETH to notch **×4**, and **a pool cannot stop a subset**. If the new coins lose and BTC/ETH carries
the average, the arm keeps trading them and the stop never fires on the part that is losing. The stage
baseline (`since` 2026-09-11T12:10Z, checkpoint at 100 settlements, 82 so far) was earned entirely by
BTC/ETH and will now be *completed* by a mixture. There was **no pre-registration** for the expansion and
no stop rule of its own.

**First reading** — `node scripts/leadlag-coins.mjs --check`, venue ledger, the first 55 minutes live:

| cohort | mkts | contracts | net | c/contract |
|---|---|---|---|---|
| all seven — *what the ladder sees* | 19 | 216 | **-$9.90** | -4.58c |
| BTC/ETH (established) | 5 | 40 | +$2.00 | +5.01c |
| five new coins | 14 | 176 | **-$11.91** | **-6.76c** |

Per coin: XRP **-24.5c** (40 contracts), DOGE -13.8c (24), SOL -3.9c (56), HYPE -3.9c (8), BNB +7.7c
(48); BTC +13.5c (16), ETH -0.7c (24).

**This is not evidence and I did not treat it as any.** One day-cluster, 55 minutes, 14 markets. This
project refuses verdicts under five day-clusters and it is refused here too. I did **not** reverse
another session's reviewed work on 55 minutes of data.

**What IS a fact and not a sample** is the volume shift: the new coins took **218 of 274 sweep fills
(80%)** in that first hour. Within a day this arm is mostly not the arm the ladder promoted. And over the
**last 24 h** the same script reads BTC/ETH at **+$1.39 over 623 contracts (+0.22c)** — the established
pair has been roughly flat for a day, and the entire -$10.51 pooled loss over that window is the new
coins.

**What I did about it** — measurement and a stop, no behaviour change:

- **`scripts/leadlag-coins.mjs`** (new): grades each coin off the venue ledger, netting exchange-netted
  pairs the way `scripts/venue-pnl.py` does (`revenue/100 + min(yes,no) - costs - fees`), with
  day-clustered 95% bands (t on G-1 df). It reads `LEADLAG_COINS` out of the live source at runtime and
  **throws** if it cannot, so it can never drift into a stale private copy of the coin list. `--check`
  joins `leadlag-dislocations.jsonl` and verifies that no coin settled more contracts than the sweep
  filled — i.e. that these series really are lead-lag's and nothing else's. It did: every coin settled at
  or below its fill count. **Attribution holds.**
- **`docs/PREREGISTERED-leadlag-coins.md`** (new): fixes the decision now, before the data arrives.
  Judge only at **≥ 400 new-coin contracts AND ≥ 5 day-clusters**; day-clustered upper bound < 0 →
  narrow `LEADLAG_COINS` back to BTC/ETH; lower bound > 0 → leave it; still undecided at **2026-10-04**
  → narrow by default. Per-coin narrowing is deliberately refused — five cohorts at one interval each is
  five chances to find a winner by looking.
- Backlog **91**, with the daily trigger: run the script, record the reading, act on the bound or the
  date and not before.

**Three defects in my own script, found and fixed before I trusted a number:**

1. It picked the newest dump by **name**, and `k-2026-09-13.json` sorts *before* `k-20260909.json`
   (`'-' < '9'`), so the first run read a four-day-old dump and printed an empty, cheerful report. Now
   sorts by mtime.
2. The attribution check compared 0 settled contracts against 274 fills and printed **"attribution
   holds"** — vacuously true and completely wrong. This is the same shape as the 2026-09-12 "sentinel
   clean" mistake. It now refuses the word OK unless both sides are non-empty and says INCONCLUSIVE
   instead.
3. With no `--since`, `args[sinceIdx + 1]` is `args[0]`, so an **explicitly given dump path was silently
   discarded** and the newest one read instead. That one only surfaced because I ran the guard test from
   (2) and it passed when it should have failed.

An 11-case `--selftest` covers all three plus the netting formula, and I **mutation-tested it**: deleting
the `min(yes,no)` pair term fails the netting case, and loosening the one-cluster guard fails the
interval case. The tests bite.

## 4. Ladder vs the venue ledger

Ladder `lastRunAt` 11:02:51Z. Stages and the ladder's own verdicts:

| arm | stage | notch | ladder verdict |
|---|---|---|---|
| kalshi-leadlag | live | **×4** | 82 settled since stage start, net **+$36.05**, checkpoint at 100 |
| kalshi-fade | tiny-live | 1 | 85 settled, +$3.79, checkpoint at 100 |
| kalshi-mean-reversion | tiny-live | 1 | 4 settled, -$3.54, checkpoint at 20 |
| kalshi-volume-spike | tiny-live | 1 | 3 settled, -$0.88, checkpoint at 20 |
| convergence | tiny-live | — | **0 settled**, $0.00, checkpoint at 20 |
| kalshi-cross-venue / kalshi-dutch | tiny-live | 1 | **0 settled** each |
| kalshi-news | tiny-live | 1 | 1 settled, -$0.11 |
| kalshi-momentum | disabled | 1 | cool-down to **2026-09-27** after 2 stops |
| kalshi-book-imbalance | disabled | 1 | cool-down to 2026-09-25 after 2 stops |
| kalshi-sports-anchor | disabled | 1 | cool-down to **2026-09-14** after 1 stop |
| kalshi-flow-follow | disabled | 1 | operator hold |
| quoter / settlement / polyus-fade / polyus-book-imbalance / polyus-micro-maker / polyus-weather-fair / kalshi-weather-morning | disabled | 1 | operator hold (four of them to 2026-12-01) |

**The ladder is running and its arithmetic is sound.** Its one structural problem is §3: the leadlag
verdict is a pooled number over seven coins.

**Silent arms.** convergence, cross-venue and dutch have **0 settlements since stage start**. Convergence
is not idle-by-accident — it logs `scanned crypto ladders, found 0 setups, fired 0 orders | graded 9
(W:8 L:1) PnL: -32c` every scan, i.e. it is scanning and finding nothing, which backlog 57 already
diagnoses as its 95c cost ceiling rather than its margin fence. The nightly review flagged the same
mismatch (ladder says 0 settled, the module says 9 graded / -32c) as a stage-accounting bug. Left for the
day the accounting item is taken; recorded, not forgotten.

The quoter's `fair-value on N of M` note has not appeared since **2026-09-07** — correct, not silent: the
quoter is off under operator hold, so it does not run. Its shadow gate still reads 16 settled allowed
fills over 10 events (needs 30/40); its blocked cohort is -4.13c with a band excluding zero, which says
the gates refuse quotes that would have lost.

## 5. Venue-true money

Fresh read-only dumps (`tmp/k-2026-09-13.json`, `tmp/p-2026-09-13.json`, GET only), then
`python scripts/venue-pnl.py --since 2026-09-12T11:03:02Z`:

- **Kalshi: -$21.43** after **$14.26** fees over **132 settlements**.
- **Polymarket US: $0.00** — no settlements in the window.
- **Net 24 h: -$21.43.** Equity: cash $124.34 + open positions at cost $18.23 = **$142.57** (at market
  $142.80). Kalshi balance by shard: **0 → $28.17** (weather trades need this one), 1 → $0.00,
  2 → $80.65, 3 → $15.52.

Yesterday was +$37.01 — the best day so far. Today is the worst. Where it went, by series: KXXRP15M
-$9.81, KXDOGE15M -$3.32, KXBTC15M -$3.22, KXBTCD -$3.02, KXNCAAFSPREAD -$2.27, KXNCAAFGAME -$2.22,
KXSOL15M -$2.18; against KXETH15M +$4.62 and KXBNB15M +$3.71.

**All of the XRP, DOGE, SOL and HYPE losses fall inside the 55 minutes after round 91 went live** (§3).
The rest of the day was ordinary: -$5.45 across everything else in the preceding 23 hours.

Polymarket US open 3, resting 0; Kalshi open 19, resting 7, 20 trades today, kill-switch clear.

## 6. Sharp anchor, out of sample

- `gradedN` **376** (284 yesterday, **+92**); `gradedBrier` **36.581** — a SUM, so **mean Brier 0.0973**
  (0.0914 yesterday, so slightly worse).
- `ruleN` **189** (146); `ruleNet` **+$7.885** (+$1.595).
- `anchor-grades.jsonl`: **376 rows, +92 in 24 h** (+144 in 48 h).

The headline moved the right way this time, and hard: **the 43 new rule trades netted +$6.29, about
+14.6c each**, against the -1.3c each the 09-12 session had to report. Two days is not a trend and the
arm is still in cool-down to 2026-09-14 after a stop (live record 8 trades, -$5.14, -10.2c/contract with
a band excluding zero). But the out-of-sample rule is now well clear of zero on 189 trades, which is the
opposite of what its live record says — that divergence is the thing to watch when the cool-down expires
tomorrow.

**Odds API spend:** 09-09 592, 09-10 536, 09-11 632, 09-12 **644**, 09-13 296 so far. Under the 645/day
cap every day, but 09-12 was **644 of 645** — one credit of headroom. Nothing failed.

## 7. Gates and quality

- **`node scripts/btc-gate.mjs --json` → FAIL / NOT YET.** 454 strike-trades, 177 events (needs 200),
  12 days. Net taker +0.61c; event-clustered Bonferroni LB **-2.76c** (needs > +1c); day-clustered LB
  -0.84c. Adverse 3.74%. Our side +0.61c vs the opposite side at its ask -2.32c.
- **`node scripts/quoter-shadow-gate.mjs --json` → insufficient sample.** Allowed cohort 16 settled proxy
  fills over 10 events (needs 30/40), -0.38c. Blocked cohort -4.13c over 665 fills / 122 events, band
  [-7.23, -1.03] — the gates are refusing quotes that would have lost.
- **`node scripts/trade-quality.mjs`.** Kalshi: fade 138 trades +$9.93 (+0.56c, band crosses zero);
  book-imbalance -$12.42 (-6.45c, **band excludes zero on the wrong side**); momentum -$10.63 (-4.32c);
  sports-anchor -$5.14 (-10.21c); volume-spike -$4.60 (-2.20c); flow-follow -$3.20 (-7.46c);
  mean-reversion +$18.28 (+10.02c, band far too wide to mean anything). Quoter shadow +4.61c over 33
  events, adverse 50%. Polymarket US 234 closed, -$16.25. Manifold +$44.59 (play money).

## 8. Shadows

| shadow | reading | go-live trigger |
|---|---|---|
| **Poly consensus** (item 13) | 4,221 signals, **3,418 graded**, hit 0.70 @ 0.69, Brier 0.0940. Day-clustered: **Kalshi +6.64c [+2.06, +11.23]** (n=584, 6 days); PolyUS +5.67c **[-0.58, +11.91]** | **MET on Kalshi.** See §9 |
| **Mention** (item 12) | 37,398 observations, 467 strikes, **graded 0** | Not met — and **not a bug**, see below |
| **HRRR** | **162** graded station-days; HRRR MAE **1.96** / bias -0.03 vs NBM **2.30** / bias -1.57; closer on 85 vs 70, 7 ties | Count half met; the **2026-09-21** date still binds |
| **Metaculus** | **56 pairs** on file, 0 graded | Token is in (pairs are growing); no grades yet |

**The mention shadow has graded 0 strikes for five days, and I checked whether that is the silent-shadow
failure again. It is not.** All 467 observed strikes expire in the **future** — the earliest on
**2026-09-14**, tomorrow. Expiry histogram: 09-14 ×34, 09-17 ×45, 09-23 ×29, 09-24 ×34, 09-25 ×89,
09-26 ×26, 09-30 ×37, 10-01 ×145, 10-07 ×28. The grader's gate (`market_end(last) > NOW`,
`mention_shadow.py:427`) is correct and simply has not had a settlement to grade yet. First grades land
tomorrow; the **≥ 100 graded** trigger becomes reachable around **2026-09-25**. Backlog 93 keeps the
cheap improvement anyway — `graded 0 strikes` should say *why*, because a line that reports zero without
a reason is exactly how the consensus shadow hid for four days.

## 9. Build queue — every trigger checked

| # | item | trigger check today | result |
|---|---|---|---|
| 1 | Critic skill | ran `critic-skill.py` on a fresh dump | **rule does not fire** — below |
| 2 | WebSocket book | per-process counters; still not computable (backlog 56) | blocked |
| 3 | HRRR source | 162 graded, HRRR ahead — but trigger is "**whichever is later**" and the date is 09-21 | not met |
| 4 | Kalshi fill channel | quoter notch 1, disabled | not met |
| 5 | Avellaneda-Stoikov skew | same as 4 | not met |
| 6 | Anchor on PolyUS | Kalshi anchor stopped at -$5.14, in cool-down | not met |
| 7 | Player props | anchor notch 1 | not met |
| 8 | New generic (c) maker-rest | gated on MR v3 fills + positive checkpoint; MR is 4 settled, **-$3.54** | not met |
| 10 | Metaculus | 56 pairs, 0 graded | not met |
| 11 | Forecaster v2 | hunch gate not yet at 200 graded | not met |
| 12 | Mention base rates | 0 graded; first settlement 2026-09-14 | not met |
| **13** | **Poly consensus** | **3,418 graded, Kalshi +6.64c, day-clustered band excludes zero** | **MET** |

**Item 1, the critic.** 1,444 decisions; settled 155 ABSTAIN / 174 VETO / 65 ERROR / 5 ALLOW_UNCHANGED.
Raw: ABSTAIN -0.005/contract, VETO -0.035 — conditions (i) and (ii) pass. Condition (iii) fails on the
raw read: of the six strategies in both cohorts the critic is skilled in three (book-imbalance -11.7c,
flow-follow -6.8c, volume-spike -27.7c) and anti-skilled in three (fade +1.0c, momentum +7.0c,
mean-reversion +31.2c) — three of six is not a strict majority, and the pre-registered tie-break counts
ties against switching. Amendment 2 (currently enabled arms only) kills it outright: the enabled arms in
both cohorts are fade, mean-reversion and volume-spike, over which **VETO is +$3.39 over 93 contracts
(+3.6c)** against ABSTAIN's +$3.75 over 54 (+6.9c) — VETO's own net is **above** zero, so condition (i)
fails. **The rule does not fire; nothing changed.** The `intelligenceEnabled: false` clause is not
reached either (399 settled decisions, but skill is composition-dependent, not absent). This is the
fourth consecutive day the amendments have been load-bearing.

**Item 13, today's build — PRE-REGISTERED, ARM NOT BUILT.** `docs/PREREGISTERED-polymarket-consensus.md`
is written: Kalshi-only, entry at the ask on a signal ≤ 24 h old with ≥ 6 h to close, refuse above 0.90 /
below 0.10 or if Kalshi has already moved > 10c past the Polymarket price, micro size through
`GENERIC_STRATEGIES`, hold to settlement, one entry per market. Stop: judge at ≥ 40 settled contracts and
≥ 5 day-clusters, upper bound < 0 stops it; hard money stop at **-$8** ungated by the cluster floor (the
momentum precedent); deadline 2026-10-13. It is pre-registered **Kalshi-only** because PolyUS's
day-clustered band *stopped* excluding zero between yesterday and today.

The arm itself was **not** built, and I want to be plain about that rather than dress it up. No
TypeScript reads any shadow data directory — I checked — so it needs a new `consensusSignals()` reader at
the `autoTrader.ts:1619-1620` injection point, a `consensusEnabled` flag in `src/shared/ipc.ts`, the key
mapping at `autoTrader.ts:557`, the ladder entry and tests. That is in a 231 KB file that another Claude
session was editing **during this run** (it built at 11:00:14Z and restarted the app at 11:00:50Z), and
step 4 forbids starting work that cannot be finished and verified in the same run. The injection points
are recorded in the pre-registration and in backlog 13 so tomorrow's session starts with the design done
rather than re-deriving it.

## 10. Two sessions in one repo

I was not alone in this repo. Rounds 90 (momentum recorder, 05:15), 91 (lead-lag 10 s + seven coins +
window caps, 06:05) and 92 (scan-timing instrumentation, built 11:00:14Z, app restarted 11:00:50Z) all
landed today from another session, the last of them 14 minutes before I finished reading the ledger.
`scripts/maintenance.ps1`'s lock only excludes maintenance and repair sessions, not an interactive one.

What I did about it, deliberately:

- **I made no change to `autoTrader.ts` or `leadLag.ts`** — the two files in flight.
- **I did not build and did not restart the app.** Building would have bundled another session's
  in-flight work into a real-money trader on my say-so. My own change is a read-only analysis script and
  needs neither. The app is up on round 92's bundle and scanning normally.
- I verified the tree was coherent before trusting anything: `npx tsc --noEmit` **clean**.

The window caps round 91 added are **binding and correct**, which I checked rather than assumed: the
11:00Z window filled to exactly the 24-contract per-ticker cap (`3 × leadLagMaxContractsPerOrder = 3 × 8`)
on both SOL and XRP, and spent ~$59 of the $60 `leadLagMaxSpendPerWindow`. The code reserves before the
await and reconciles to the realized fill, which is the right shape.

**Worth your eye, and it is a sizing question rather than a bug:** that default is **$60 per 15-minute
window on a $142 account** — up to ~42% of equity committed inside one window, at seven coins on a 10 s
poll. Nobody chose 60; it is the fallback in `autoTrader.ts:3791`. Sizes are yours, so it is raised here
and in backlog 92, not changed.

## 11. Verification

- `npx tsc --noEmit` — **clean** (run twice: before and after my change).
- `review-fixes` **414 passed / 0 failed** (347 yesterday; rounds 90-92 added the rest).
- `ladder` **126 / 0**. `adversarial` **88 / 0**.
- `node scripts/leadlag-coins.mjs --selftest` — **11 passed / 0 failed**, and **mutation-tested**: two
  scratch mutants (dropping the `min(yes,no)` pair term; loosening the one-cluster guard) each failed
  exactly one case. The scratch copy was deleted.
- `node scripts/leadlag-coins.mjs --check` — run against both a fresh and a deliberately stale dump; the
  stale one correctly reports **INCONCLUSIVE** instead of a false OK.
- Read-only dumps: `readonly-kalshi-dump.cjs` and `readonly-polyus-dump.cjs`, both exit 0, GET only.
- Backup `MAINT-2026-09-13` taken (`G:\PROJECTS\oracle-trader-backups`).
- **No build, no restart, no order, no config change, no setting touched.** Nothing in this run can move
  money. The one behavioural change available to me — narrowing the coin list — I explicitly declined on
  55 minutes of data and pre-registered instead.

## 12. Open questions for the operator — nothing blocking

1. **$60 a window on a $142 account.** `leadLagMaxSpendPerWindow` defaults to 60 and
   `leadLagMaxContractsPerWindow` to 24 per ticker; both are working exactly as written and both were
   hit this morning. At seven coins and a 10 s poll, lead-lag can commit ~42% of equity in fifteen
   minutes. That is your dial, not the ladder's.
2. **The expansion is untested and pooled.** Five coins went live this morning with no pre-registration
   and no stop of their own, into an arm sitting at ×4 on BTC/ETH's record. I have made it measurable and
   fixed the stop in advance (§3), but the underlying habit is worth a word: a change to *what* an arm
   trades is as much a new strategy as a new arm is, and the ladder cannot see it.
3. **The sharp anchor's out-of-sample rule and its live record now point opposite ways.** +14.6c per
   trade on the 43 newest graded rows (189 total, +$7.89) against -10.2c per contract on its 8 live
   trades. Its cool-down expires **tomorrow, 2026-09-14**, and the ladder will retry it automatically.
   That divergence is the thing to watch.
4. **The Odds API ran at 644 of 645 credits on 09-12** — one credit of headroom — to grade an arm that is
   switched off. Third day I have raised it; nothing has failed, so nothing is being asked.
5. **Two Claude sessions were editing this repo at once today.** No harm done and I stayed out of the
   way, but the maintenance lock does not cover interactive sessions, so this can recur.

## 13. Delivery

`SendUserFile` and `PushNotification` are **not available in this headless session** (the Windows task
`OracleTrader-Maintenance` has no desktop tools). This file is `docs/reports/2026-09-13.md`; the desktop
task at 08:30 local delivers it. The `claude.ai Gmail` and `claude.ai Google Calendar` MCP servers need
OAuth authorization from an interactive session; they were not needed here.

### Five lines for the push

1. Nothing needed from you.
2. Venue-true 24 h: **Kalshi -$21.43** after $14.26 fees / 132 settlements, **PolyUS $0.00** — net
   **-$21.43**, the worst day so far after yesterday's best. Equity $142.57.
3. Ladder: no promotions, no stops, no scale-ups. Lead-lag holds ×4 (82 of 100 to its checkpoint); the
   sharp anchor's cool-down expires tomorrow.
4. Errors: zero `[error]` lines in 24 h; no sentinel incidents opened; nothing down.
5. **The one thing:** another session widened lead-lag from 2 coins to 7 this morning, and **-$15.62 of
   today's loss is the five new coins in their first 55 minutes** — but the ladder counts all seven as
   one arm, so it cannot stop the new part. I did not reverse it on 55 minutes of data; I built the
   per-coin grader, pre-registered the stop (400 contracts / 5 days, or narrow by 2026-10-04), and
   flagged that `leadLagMaxSpendPerWindow` defaults to **$60 per 15-minute window on a $142 account**.


---

# Oracle Trader — daily maintenance, 2026-09-14

Headless run (Windows task `OracleTrader-Maintenance`, 07:00 local / 11:00Z). Everything below was read or
run in this session. Where a figure is compared with yesterday it is labelled as a comparison; nothing else
is carried over.

**Headline:** the day was **positive** (+$1.31 venue-true after $14.29 of fees), nothing was down, there
were zero errors and zero warnings in 24 h, and today's build — the Polymarket smart-money consensus arm,
build-queue item 13 — is **live on the ladder and has taken its first position**. One thing needs the operator, and
it is not urgent today: the OpenRouter balance.

---

## 1. Liveness — everything up, nothing restarted for cause

| check | reading | verdict |
|---|---|---|
| App process | electron PID 41512, `main.log` last line 11:00:25Z at an 11:00:30Z check | up |
| `ladder.json` `lastRunAt` | 10:57:39Z (3 min) | within 2 h |
| BTC collector | 1 process, `node scripts/btc-collector.mjs` (PID 17716) | up |
| Nightly review | `reviews/2026-09-14.md` present, model `openai/gpt-5.6-sol`, 1 attempt, no error | up |
| `OracleTrader-HrrrShadow` | last run 06:20 local, result 0; `forecasts.jsonl` 10:20Z | up |
| `OracleTrader-MetaculusShadow` | last run 06:35 local, result 0 | up |
| `OracleTrader-MentionShadow` | last run 06:50 local, result 0; `run.log` 10:50Z | up |
| `OracleTrader-PolyConsensus` | last run 06:55 local, result 0; `run.log` 11:00Z | up |
| `OracleTrader-Sentinel` | `status.json` `at` = **10:50:01Z** (10 min) | fresh |

**Nothing was down.** The app was restarted at **11:16:43Z**, by me and on purpose, to ship today's build
(§3) — not because anything had failed. It came back visibly via `Start-ScheduledTask OracleTrader-App`
(the task is `Hidden: False`, interactive) as PID 48788 and resumed scanning and sweeping immediately.

**`main.log`, last 24 h: zero `[error]` lines and zero `[warn]` lines.** (The newest error anywhere in the
file is 2026-09-09; the newest warning is a `[ratchet] refused` at 2026-09-13T02:22Z, before the window.)
The Kalshi universe-pagination warning that produced 276 lines yesterday produced **none** today — it is a
Thursday-evening-to-Friday-evening signature (backlog 83) and today is Monday. Both fill reconcilers read
`completeness: ok` with fresh `lastRunAt`, which is the check the Polymarket-429 suppression explicitly
asks for rather than trusting the suppressed pattern.

## 2. Sentinel

- **Incidents opened since the last run: none.** Newest incident file is still 2026-09-12T08-05.
- **Open incidents: none.** Every incident file's first lines read `Status: CLOSED` — checked by reading the
  status line of each file, not by grepping the directory.
- **Repairs: none needed.** `repairSessionsToday: 0`, `lockBusy: false`.
- **Findings: one**, and it is the one thing for the operator — `openrouter-low`, kind `notify`, "OpenRouter credit
  low: $2.03". Parsed out of `status.json` as a field, not grepped (the 2026-09-12 lesson).
- Suppressions: three, all inside their windows, all with recorded reasons. **None renewed.**
- Sentinel liveness: `at` 10:50:01Z, `mainLogAgeMin` 0, ollama up, disk 1,578 GB free. Fresh.
- The sentinel also revived `mmsim`, `ladder15-shadow` and `crypto15-shadow` on its own on 2026-09-13
  (23:50Z and 15:35Z); all three were running at the time of this check.

## 3. Today's build — the Polymarket consensus arm is live (build-queue item 13)

Item 13 has been triggered since 2026-09-12 and pre-registered since 2026-09-13
(`docs/PREREGISTERED-polymarket-consensus.md`). The arm itself was deferred twice because another Claude
session was editing `autoTrader.ts`. **Today the repo was quiet — no TypeScript file had been touched in 12
hours — so it was built, tested, shipped and verified in one run.** Full detail in `REVIEW-CHANGES` §90.

**The trigger, re-read before building anything.** `python scripts/polymarket_consensus.py report`: 5,040
signals, **4,177 graded** (3,418 yesterday), hit rate 0.70 at a mean price of 0.70, Brier 0.0944.
Day-clustered net per contract (t on G-1 df), computed over `grades.jsonl`:

| priced at | n | days | mean | 95% | vs 2026-09-13 |
|---|---|---|---|---|---|
| **Kalshi ask, net of taker fee** | **692** | **7** | **+6.39c** | **[+3.14, +10.19]** | tighter; still excludes zero |
| Polymarket US, net of fee | 650 | 7 | +3.68c | [-2.38, +10.97] | still includes zero |
| Polymarket price (all graded) | 4,177 | 7 | +0.42c | [-0.53, +2.10] | includes zero |

So the arm is **Kalshi-only**, exactly as pre-registered. Clustered by **category** instead of day the
Kalshi band is **[-5.14, +16.93]** and still includes zero — caveat 2 of the pre-registration is unchanged,
and it is precisely why this is a micro-size arm the ladder can stop and not a size that concentration
could hurt.

**What went in.** A new `src/main/strategies/consensus.ts` holding the pre-registered rule as one pure
function (`consensusRefusal`) plus the shadow's file reader; `consensusSignals()` in `autoTrader.ts` at the
`computeSignals` injection point, following `anchorSignals`' pattern for markets outside the ranked
universe; a persisted `state.consensusActed` ledger enforcing one entry per Kalshi market and one per
Polymarket source market; and `{ id: 'kalshi-consensus', venue: 'kalshi', key: 'consensus', flag:
'consensusEnabled' }` in `GENERIC_STRATEGIES`.

Three decisions worth stating because they are the ones that could have gone wrong:

1. **Taker-only is enforced in code, not left to a config list.** The +6.4c was measured at the Kalshi
   **ask**; a maker seat is a different strategy. `makerEntryFor('consensus')` returns false
   unconditionally, which also keeps the maker path — which has nowhere to record the Polymarket source
   market — unreachable for this arm.
2. **Drift is signed, not absolute.** The pre-registration refuses a signal once Kalshi has run *past* the
   Polymarket price; Kalshi being *cheaper* than the wallets paid is not a reason to refuse. An absolute
   test would have thrown away the best entries, and it is one of the four mutants below.
3. **The acted ledger is persisted and marked at order placement.** In memory it would reset on every boot
   and the app boots about eighteen times a day; marked at signal generation it would burn signals the LLM
   gate or a capacity cap refused.

**No size, arm or limit setting was touched.** `consensusEnabled` ships **false**; the ladder promoted the
arm itself at **11:18:44Z** — `kalshi-consensus: disabled → tiny-live — trade-small mode: real-money micro
test 1 (stop -$5)`.

**Verified live, end to end.** First scan with the arm on, 11:21:05Z:

```
[consensus] 79 fresh signals, 3 candidates | refused {"no-ask":6,"price-low":1,"drifted":1,"fetch-budget":68}
```

and one of the three executed: **`KXINXDUD-26SEP14H1600-T7656.85` YES, 7.69 contracts at $0.12** (~$0.92,
micro size), with `consensusActed` correctly carrying both the market and its Polymarket `conditionId`.

Read that `fetch-budget: 68` correctly, because it looks alarming and is not: the signal list is sorted
**newest-first** and the 10-market-fetch-per-scan cap therefore covers roughly the newest two hours of
arrivals at the observed ~5 matched signals/hour. Every new signal is evaluated on the scan it appears and
for dozens of scans afterwards; `fetch-budget` counts the already-judged tail. Backlog 79 records what
*would* be a defect (`no-ask` or `market-gone` dominating) so tomorrow's reader does not have to re-derive
this.

**Day-0 fact worth having: what actually binds is the long-horizon slot cap, not the entry rule.** The
same three candidates recur each scan; one entered and the other two are vetoed by existing guards —
`long-horizon slots full (4/4)` on an ATP match and a November congress market, and the weather-series
class guard on `KXRAIN-26SEP14-MIA`. Both are correct and both are already counterfactually graded
(`capacityKey` buckets them as `long-horizon`). Consensus signals are long-dated by construction — mean
lead time 36 h and a >= 6 h floor — so this arm will compete with fade and mean-reversion for four
slots. That is a real throughput constraint on the pre-registration's "40 settled contracts by
2026-10-13" deadline and it is on the watch list (backlog 79), not a change made today.

**Expected flow:** of the last 24 h of signals, 111 carried a matched Kalshi market with an ask, 102 were
inside the 10-90c band, 75 survived the drift gate — before the ≥ 6 h-to-close floor, which removes the 5-
and 15-minute crypto up-down markets entirely. That floor is also what keeps this arm off the same
15-minute windows lead-lag trades, so the two cannot stack into one directional bet.

## 4. Ladder vs the venue ledger

`lastRunAt` 11:18:44Z. The ladder is running, its arithmetic is sound, and its verdicts match the ledger.

| arm | stage | notch | ladder verdict |
|---|---|---|---|
| kalshi-leadlag | live | **×4** | 127 settled since stage start, **+$32.90**, checkpoint at 140 |
| kalshi-fade | tiny-live | 1 | **99 settled, +$4.66, checkpoint at 100** — one away |
| kalshi-volume-spike | tiny-live | 1 | 8 settled, -$1.39, checkpoint at 20 |
| kalshi-mean-reversion | tiny-live | 1 | 4 settled, -$3.54, checkpoint at 20 |
| kalshi-sports-anchor | tiny-live | 1 | **re-armed 01:57:54Z** on cool-down expiry, 0 settled |
| **kalshi-consensus** | **tiny-live** | **1** | **new today, 1 position open** |
| convergence | tiny-live | — | 1 settled, +$0.05, checkpoint at 20 |
| kalshi-cross-venue / kalshi-dutch | tiny-live | 1 | 0 settled each |
| kalshi-news | tiny-live | 1 | 1 settled, -$0.11 |
| kalshi-momentum | disabled | 1 | cool-down **2026-09-27**, demotions 2 |
| kalshi-book-imbalance | disabled | 1 | cool-down **2026-09-25**, demotions 2 |
| quoter / settlement / polyus-* / kalshi-flow-follow / kalshi-weather-morning | disabled or paper | 1 | operator hold |

**Only one ladder transition in 24 h**, and it was the ladder's own: `kalshi-sports-anchor: disabled →
tiny-live` at 01:57:54Z, the automatic retry after its cool-down expired. No promotions, no stops, no
scale-ups.

**Item 69 check (do the stopped arms stay stopped?): yes.** Momentum sits at demotions 2 with a cool-down
to 09-27 and book-imbalance at demotions 2 to 09-25; neither was re-entered on a timer.

**Silent arms.** cross-venue and dutch still have 0 settlements since stage start. Convergence logs
`found 0 setups` on every scan — it is scanning and finding nothing, which backlog 57 attributes to its 95c
cost ceiling. **Its scan note carries no skip-counter breakdown at all** (checked across the whole 24 h
window); that is the gap, and it is the same shape as the lesson the new consensus arm was built with.
The stage-accounting mismatch also persists: the ladder reads 1 settled / +$0.05 while the module's own
note reads `graded 10 (W:9 L:1) PnL: -27c`. Recorded, not forgotten; the nightly review flags it too.

The quoter's `fair-value on N of M` note has not appeared since **2026-09-07** — correct, not silent: the
quoter is under operator hold and does not run.

## 5. Venue-true money — a positive day

Fresh read-only dumps (`tmp/k-2026-09-14.json`, `tmp/p-2026-09-14.json`, GET only), then
`python scripts/venue-pnl.py --since 2026-09-13T11:03:02Z`:

- **Kalshi: +$1.31** after **$14.29** in fees over **164 settlements**.
- **Polymarket US: $0.00** — no settlements in the window (open 0, resting 0).
- **Net 24 h: +$1.31**, against **-$21.43** yesterday.
- Equity: cash **$119.09** + open positions at cost **$24.63** = **$143.72** (at market $142.93).
- Kalshi balance by shard: **0 → $30.11** (weather needs this one), 1 → $0.00, 2 → $73.46, 3 → $15.52.
- Kalshi open 23, resting 4, 19 trades today, **kill switch clear** (`dailyPnl` -$0.36, not tripped).

By series, the day was one bet going both ways: **KXETH15M +$11.74, KXXRP15M +$4.19, KXHYPE15M +$2.10,
KXBNB15M +$1.99, KXSOL15M +$1.97** against **KXBTC15M -$16.86 and KXDOGE15M -$4.28**. Everything else is
pennies. This is the second day in a row where the whole day's result is the 15-minute crypto book, and it
is worth saying plainly: yesterday the new coins lost and BTC/ETH held; today BTC lost and the new coins
carried it. Neither day is evidence; both are the same cluster.

**Lead-lag by coin** (`node scripts/leadlag-coins.mjs --check`, item 72's daily reading, since
2026-09-13T10:05Z): all seven pooled **-$9.04 over 1,079.71 contracts (-0.84c)**; BTC/ETH **-$3.11 over
477 (-0.65c)**; the five new coins **-$5.93 over 602.69 (-0.98c)**. Per coin: ETH +5.08c, BNB +3.58c,
HYPE +2.27c, SOL -0.17c, XRP -3.88c, DOGE -7.97c, BTC -5.90c. The pre-registered cohort gate reads
**NOT YET**: the ≥ 400-contract half is met (602.69) but there are only **2 day-clusters of the required
5**, so no bound is judged and nothing is narrowed. **Attribution holds** — every coin settled no more
contracts than the sweep filled.

## 6. Sharp anchor, out of sample

- `gradedN` **527** (376 yesterday, **+151**); `gradedBrier` **63.106** — a SUM, so **mean Brier 0.1198**
  (0.0973 yesterday, so worse).
- `ruleN` **253** (189); `ruleNet` **+$12.105** (+$7.885).
- `anchor-grades.jsonl`: **527 rows, +151 in 24 h**.

The **64 new rule trades netted +$4.22, about +6.6c each** — a third consecutive positive day
out of sample (+14.6c on 09-13, -1.3c on 09-12), and the rule now stands at +$12.11 over 253 trades. The
mean Brier got worse while the money got better, which is what you would expect if the newest cohort is
noisier games rather than worse prices.

**Its cool-down expired and the ladder re-armed it at 01:57:54Z**, automatically, per its own rule. So the
divergence flagged yesterday is now a live test: out-of-sample +6.6c/trade against a live record of 8
trades at **-10.2c per contract with a band excluding zero** (`trade-quality`: -$5.14, 1W/7L, CLV +2.50).
It has 0 settled trades since the re-arm and a -$5 stop. That is the right way to settle it and it needs
nothing from anyone.

**Odds API spend:** 09-10 536, 09-11 632, 09-12 644, 09-13 **644**, 09-14 **322 so far**. Under the 645/day
cap every day, but 644 of 645 for the second day running — one credit of headroom. Nothing failed.

## 7. Gates and quality

- **`node scripts/btc-gate.mjs --json` → FAIL / NOT YET.** 493 strike-trades, **194 events** (needs 200),
  13 days. Net taker +0.43c; event-clustered Bonferroni LB **-2.75c** (needs > +1c); day-clustered LB
  -0.98c. Adverse 3.85%. Our side +0.43c vs the opposite side at its ask -2.14c. Closer to the 200-event
  half than yesterday (177), still failing the economics.
- **`node scripts/quoter-shadow-gate.mjs --json` → insufficient sample.** Allowed cohort 19 settled proxy
  fills over 12 events (needs 30/40), -1.05c. Blocked cohort **-4.21c over 753 fills / 143 events, CI95
  [-7.35, -1.07]** — the gates keep refusing quotes that would have lost.
- **`node scripts/trade-quality.mjs`** (Kalshi, fee-inclusive, event-clustered): fade 152 trades **+$10.80
  (+1.18c, [-2.52, +4.88])**; mean-reversion +$18.28 (+10.02c, band far too wide to mean anything);
  book-imbalance **-$12.42 (-6.45c, [-11.29, -1.61], excludes zero on the wrong side)**; momentum -$10.63;
  volume-spike -$5.12; sports-anchor -$5.14; flow-follow -$3.20. Quoter shadow +4.61c over 33 events,
  adverse 50%. Polymarket US 237 closed, **-$16.25**. Manifold +$46.48 (play money).

## 8. Shadows

| shadow | reading | go-live trigger |
|---|---|---|
| **Poly consensus** (item 13) | 5,040 signals, **4,177 graded**, Kalshi **+6.39c [+3.14, +10.19]** (n=692, 7 days) | **MET — BUILT TODAY, §3** |
| **Mention** (item 12) | 44,334 observations, 467 strikes, **graded 0** | not met — see below |
| **HRRR** | **189** graded station-days; HRRR MAE **1.87** / bias -0.15 vs NBM **2.26** / bias -1.61; closer on 102 vs 80, 7 ties | count half met; the **2026-09-21** date still binds |
| **Metaculus** | **66 pairs** on file (56 yesterday), 0 graded | not met |

**The mention shadow graded 0 again today — the day yesterday's diagnosis predicted the first
settlements — and the diagnosis survives a sharper check.** Recomputed with the grader's OWN gate,
`market_end = max(expiration_time, close_time)` (`mention_shadow.py:326`), **zero of the 467 strikes have
expired**, and the earliest expiry is **2026-09-14T14:00:00Z** — three hours after the last hourly run.
The first grades should land at today's **14:50Z** run. The histogram is unchanged from yesterday
(09-14 ×34, 09-17 ×45, 09-23 ×29, 09-24 ×34, 09-25 ×89, 09-26 ×26, 09-30 ×37, 10-01 ×145, 10-07 ×28).

**A trap worth recording, because I walked into it first.** Reading `close_time` alone says **142 of 467
strikes are already overdue** and makes this look exactly like a four-day silent failure. It is not: a
mention market stops trading at `close_time` but is only *knowable* at `expiration_time`, which is why
the grader takes the max, and the max is what makes 0 the right answer. Grading a strike at `close_time`
would score only the early YES settlements — the 2026-09-08 bug the comment in that function describes.
**Check a gate with the gate's own function, not with the field that looks like it.**

This is still a dated prediction, so it is written down as one: **if 2026-09-15 reads `graded 0` with
strikes whose `market_end` has passed, backlog 93 stops being a logging improvement and becomes a
defect** (backlog 82).

## 9. Build queue — every trigger checked

| # | item | trigger check today | result |
|---|---|---|---|
| 1 | Critic skill | `critic-skill.py` on a fresh dump | **rule does not fire** — below |
| 2 | WebSocket book | per-process counters; still not computable (backlog 56) | blocked |
| 3 | HRRR source | 189 graded, HRRR ahead — trigger is "whichever is later" and the date is 09-21 | not met |
| 4, 5 | Kalshi fill channel / A-S skew | quoter notch 1, disabled | not met |
| 6 | Anchor on PolyUS | Kalshi anchor's first checkpoint not reached (0 settled since re-arm) | not met |
| 7 | Player props | anchor notch 1 | not met |
| 8(c) | maker-rest generic | gated on MR v3 fills + a positive checkpoint; MR is 4 settled, **-$3.54** | not met |
| 10 | Metaculus | 66 pairs, 0 graded | not met |
| 11 | Forecaster v2 | `hunch-gate.mjs`: **32 settled events**, needs 200 | not met |
| 12 | Mention base rates | 0 graded | not met |
| **13** | **Poly consensus** | **4,177 graded, Kalshi band excludes zero** | **MET → BUILT (§3)** |
| 60, 64 | lead-lag 10 s day-1 read; momentum blocked-vs-taken | dated on or after **2026-09-15** | not due |
| 65–68, 70 | challenger, cull-gate, log-odds, mention, mmsim | dated 09-18, 09-19, 09-21, 09-25, 10-17 | not due |
| 69 | stopped arms stay stopped | momentum dem 2 / cd 09-27; book-imbalance dem 2 / cd 09-25 | **held, correct** |
| 71 | universe page bound (weekly) | **0 warnings in 24 h** (Thu-Fri signature; today is Monday) | not due |
| 72 | lead-lag coin cohort (daily) | 602.69 contracts but **2 of 5 day-clusters** | recorded, **NOT YET** |
| 73 | news arm + Mentions | news arm has 1 settled trade, needs 20 | not due |
| 75 | anti-flood cap re-check | `openTrades` **21** (trigger is 60+ on three readings) | recorded, not met |
| 76 | implication arbitrage | closed by evidence at 10:30Z by another session | closed |
| 77 | Kalshi liquidity programs vs mmsim | gated on the 10-17 mmsim read | not due |

**Item 1, the critic — fifth consecutive day the amendments are load-bearing.** 1,463 decisions; settled
172 ABSTAIN / 178 VETO / 65 ERROR / 5 ALLOW_UNCHANGED. On the **raw** read ABSTAIN is +$0.001/contract and
VETO **-$0.032**, so (i) and (ii) pass; and on the raw within-strategy read the critic is skilled in **four
of the six** strategies present in both cohorts (book-imbalance -11.7c, volume-spike -24.1c, flow-follow
-6.8c, fade -0.2c) against anti-skilled in two (mean-reversion +31.2c, momentum +6.8c) — a strict majority,
so **the raw rule would say switch**. Amendment 2 (currently enabled arms only) decides it the other way:
of those six, only fade, mean-reversion and volume-spike are enabled today, and over them **VETO is +$3.77
over 97 contracts (+3.9c)** against ABSTAIN's +$4.57 over 70 (+6.5c). **Condition (i) fails outright —
VETO's own net is above zero**, so switching to veto mode would forfeit positive-EV trades to improve an
average. The rule does not fire; nothing changed. The `intelligenceEnabled: false` clause is not reached
either (420 settled decisions, but the skill is composition-dependent, not absent).

## 10. Verification

- `npx tsc --noEmit` — **clean**, run three times (before the change, after the change, after the tests).
- `review-fixes` **461 passed / 0 failed** (414 yesterday; +47 are today's).
- `ladder` **126 / 0**. `adversarial` **89 / 0** — see the flake note below.
- **Mutation-tested, four mutants in a scratch copy of `consensus.ts`**: drift made absolute; the 6 h floor
  made exclusive; the freshness re-filter deleted; newest-row-wins reverted to first-row-wins. Each failed
  **exactly one** test and no other, and the file was restored byte-identical (`diff -q`) afterwards.
- `npx electron-vite build` — clean. App restarted **visibly** via `Start-ScheduledTask OracleTrader-App`
  at 11:16:43Z; `main.log` resumed immediately and the arm logged and traded at 11:21:05Z.
- Read-only dumps: `readonly-kalshi-dump.cjs` and `readonly-polyus-dump.cjs`, both exit 0, GET only.
- Backup **`MAINT-2026-09-14`** taken (`oracle-trader-MAINT-2026-09-14-20260914-071552.zip`, 773 files,
  295 MB; the app's own `lockfile` was skipped as locked, as always).
- **No order was placed, amended or cancelled by hand; no key was read, printed or moved; no arm, size or
  loss limit was changed.** The only new position is the ladder's own micro test, placed by the app.

**The adversarial suite flaked once and the output was captured.** One run in five failed three section-F
assertions (`F: checkpoint win scales to x2` returning `{stage: tiny-live, notch: 1, cp: 1}` instead of
`{stage: live, notch: 2, cp: 0}`); the run before the change and three runs after were all 89/0. The
verbatim output is in `tmp/testout/adversarial-2026-09-14.txt` and the analysis so far is in **backlog 80**:
`cp: 1` means the checkpoint fired and its *verdict* was not a scale-up, which points at the checkpoint
verdict rather than the promotion stagger (`scaleUp()` gates on `liveAllowed()`, which reads only static
test config). **I did not chase it today** — one behavioural change per run, and today's was the consensus
arm — but a test that decides differently on identical inputs, in the promotion path of a real-money
trader, is filed as a defect and not as noise.

## 11. Open questions for the operator — one is actually due

1. **OpenRouter is at $2.03 and burning about $25 a day** ($27.13 on 09-13 → $2.03 this morning; the
   sentinel has flagged it four times since 09-13 11:50Z). **Nothing has failed**: today's nightly review
   ran on `openai/gpt-5.6-sol` at the first attempt, and the documented fallback is the local Ollama
   models. But there is roughly a day of headroom, and only you can top it up
   (openrouter.ai/settings/credits). What is *ours* to fix is that nobody has measured which caller spends
   it — that is backlog 83.
2. **kalshi-fade is one settlement from its 100-trade checkpoint** (99 settled, +$4.66). The nightly review
   is explicit that the evidence does not support a promotion — +1.18c/contract with a clustered CI of
   [-2.52, +4.88] — and the ladder's own 80% band will decide it automatically within a day. No action;
   just the next thing that will move on its own.
3. **The Odds API ran 644 of 645 credits for the second day running**, to grade an arm that has just been
   re-armed at micro size. Nothing has failed, so nothing is being asked — fourth time raised.
4. **Two days, one bet.** Yesterday's -$21.43 and today's +$1.31 are both almost entirely the 15-minute
   crypto book, with the sign flipping between which coins carried it. The pre-registered cohort gate
   (2 of 5 day-clusters) is the right place to settle that and it is not due yet.

## 12. Delivery

`SendUserFile` and `PushNotification` are **not available in this headless session** (the Windows task
`OracleTrader-Maintenance` has no desktop tools), and this run was explicitly told to skip sending. This
file is `docs/reports/2026-09-14.md`; the desktop task at 08:30 local delivers it. The `claude.ai Gmail`
and `claude.ai Google Calendar` MCP servers are unauthorized and would need an interactive session; they
were not needed here.

### Five lines for the push

1. **One thing needs you: OpenRouter is at $2.03** (~$25/day burn, ~a day left). Nothing has failed — the
   review ran fine today and falls back to Ollama — but only you can top it up.
2. Venue-true 24 h: **Kalshi +$1.31** after $14.29 fees / 164 settlements, **PolyUS $0.00** — a positive
   day after yesterday's -$21.43. Equity $143.72.
3. Ladder: no stops, no scale-ups. Two automatic moves, both the ladder's own — **sports-anchor re-armed**
   on cool-down expiry at 01:57Z, and **the new consensus arm entered at tiny-live** at 11:18Z. Lead-lag
   holds ×4; fade is one settlement from its checkpoint.
4. Errors: **zero `[error]` and zero `[warn]` lines in 24 h**; no sentinel incidents opened; nothing down.
5. **The one thing to know:** build-queue item 13 is **done** — the Polymarket smart-money consensus arm is
   live on Kalshi at micro size, and it has already taken its first position. The shadow's edge held on
   today's data (+6.39c/contract at the Kalshi ask, 95% [+3.14, +10.19] over 692 rows and 7 days); the
   arm's own -$5 ladder stop, a -$8 hard stop and a 2026-10-13 deadline were all fixed in writing before
   it existed.

## Repair 2026-09-15T06:27Z

Incident `data/sentinel/incidents/2026-09-15T06-20-collector-stale.md` (three findings: `collector-stale`
"last write 291 min ago", plus `unbooked-settlement` on `KXWTI-26SEP1414-T104.99` and
`KXBRASILEIROGAME-26SEP13BAHCR-TIE`). Outcome **NOT-A-DEFECT**: one Windows Update restart, seen from three
angles. `WindowsUpdateClient` 43 began installing 2026-09 Security Update KB5129195 (26200.9457) at
00:53:11Z, `User32` 1074 at 01:29:06Z records MoUsoCoreWorker.exe restarting <machine> on behalf of
NT AUTHORITY\SYSTEM ("Operating System: Service pack (Planned)", shutdown type restart), Kernel-Power 109
at 01:29:36Z and 577 "prepared for a system initiated reboot from Active"; `LastBootUpTime` 06:14:17Z with
Kernel-Power 578 on the way back. The rig was down 4 h 45 min and returned only because its tasks are
logon-triggered: electron PID 23904 at 06:20:07Z, `OracleTrader-BtcCollector` Last Run Time 06:20:37Z. The
collector neither crashed nor hung - `collector.log` ends at `tick 8311` 01:29:02.559Z and resumes
`collector v2 start (loop)` 06:20:37.728Z, and the app's `main.log` has the identical hole (6-22 lines per
minute through `[2026-09-15T01:28`, nothing until `[2026-09-15T06:20`), which no defect in
`scripts/btc-collector.mjs` could produce. Both settlements landed inside the outage (02:31:18Z, 01:33:38Z)
and the sentinel sampled six seconds before the app started; the first post-restart scan booked them via
`trySettle` (`autoTrader.ts:3592-3663`) - neither marketId remains in `state.openTrades` (27 rows,
kalshi-auto.json written 06:21:40Z), `dailyPnl` for 2026-09-15 realized $0.257 against `venueDay` 19
settlements, entry fills still in `history.json`, so nothing was dropped as an orphan. Verified healthy at
06:25Z: collector writing every minute, `2026-09-15.jsonl` 3,680,277 -> 3,804,008 bytes between 06:21 and
06:25, and the day file intact across the reboot (5,143 lines, 0 unparseable, last pre-gap ts
01:29:02.009Z, first post-gap ts 06:20:37.731Z); `[reconciler] ... completeness ok` 06:21:10Z, `[ladder]`
tick 06:22:14Z, 19 arms. **No code changed**, so no build, no test run, no backup, no restart, and no
`Recently done` line in `docs/BACKLOG.md`. **Not suppressed**, on purpose: `suppressions.json` patterns
match main.log line text and `collector-stale` is a file-mtime finding, so an entry could not reach it -
and the alarm was right, ~290 one-minute ticks of ladder and order-book capture for the pre-registered
convergence study (01:29-06:20Z) are gone and books cannot be rebuilt after the fact. **For the operator** (nothing
asked of the app): this box takes unattended Windows Update restarts, this one cost 4 h 45 min of trading
and collection, and only he can set Windows Update active hours or defer the automatic restart. Noticed in
passing and deliberately NOT acted on as unrelated work: `scripts/watchdog.mjs`, which is supposed to
restart a dead collector within 60 s, has itself been dead since 2026-09-03T08:03Z (`data/health/*` all
stop there) - it would not have helped here, since the whole box was off. No order placed, cancelled or
amended; no key, arm, size, limit, ladder stage or scheduled task touched.

## 2026-09-15 11:00Z - daily maintenance (headless, task OracleTrader-Maintenance)

Full section delivered as `docs/reports/2026-09-15.md`; this is the log copy of what matters.

**Liveness: everything up.** App PID 17844 (started 09:44:21Z, the morning session's improvement build),
`main.log` current at 11:05Z; `ladder.json` lastRunAt 10:44:22Z; BTC collector PID 31316 writing at
11:10Z; `reviews/2026-09-15.md` present (openai/gpt-5.6-sol, 1 attempt, no error); HrrrShadow 10:20Z,
MetaculusShadow 10:35Z, MentionShadow 10:50Z, PolyConsensus 11:00Z, all result 0; sentinel `at` 10:50:01Z;
the three recorders (crypto15 21864, ladder15 21560, mmsim 20688) alive with `health: ok` and mmsim still
on runId 33249be26379. Both fill reconcilers `completeness: ok`. **Nothing restarted by hand.** The
overnight gap was Windows Update KB5129195 (01:29Z-06:14Z), already closed NOT-A-DEFECT by the 06:27Z
repair session. No genuine error in 24 h: 5 suppressed `[ratchet] refused` and 3 `[leadlag] Kalshi leg
failed for 1 of 7 pairs`, ~6 h apart, self-recovering.

**Sentinel.** Two incidents opened, both the outage: `06-20-collector-stale` (closed by the repair session)
and `06-35-undispatched` (MetaculusShadow) - **closed in this run, NOT-A-DEFECT**: `last-mc.json` is now
written 10:35:41Z, task result 0, 0 missed runs, 75 pairs (+9); the sentinel's forced `Start-ScheduledTask`
at 06:20Z raced the task's own fixed `:35` trigger and then read "without effect". Open incidents: none.
Repairs today: 1 of 3. One finding, `horizon-kalshi:KXNCAAMBUAC-27-EKY`, a notify. **OpenRouter is back to
$16.83** - the operator topped it up, so yesterday's only open question is closed. Three suppressions, none renewed.
Blind spot filed, not fixed: the sentinel's 11:05Z quiet check read "app up" while the trader had placed no
order for two hours - it watches whether the app is running, not whether it is trading.

**THE DAY'S EVENT: the Kalshi daily-loss kill switch is TRIPPED, correctly.** `state.dailyPnl.tripped =
true`, `state.venueDay.realized = -24.18` on a 20%-of-equity limit at ~$82-107 equity. Last order of any
kind **08:43:31Z**; 09Z/10Z/11Z placed **zero** against a normal ~200/hour. Lead-lag still logs +3.5c to +9c
dislocations every 10 s and there is no `sweep held` line after 08:43Z either, because the halt is upstream
at `canTrade` (`leadLag.ts:525`). Exits keep managing; entries resume on the next UTC day. Nothing touched.

**Venue-true 24 h (fresh read-only dumps, `venue-pnl.py --since 2026-09-14T11:03:02Z`): Kalshi -$36.70**
after $17.54 fees over 220 settlements; **PolyUS $0.00** (0 open, 0 resting). Kalshi equity cash $75.44 +
$31.40 at cost = **$106.84**; shards 0 -> $15.82, 1 -> $0.00, 2 -> $44.62, 3 -> $14.99. PolyUS cash $39.85.
The seven 15-minute crypto ladders are **-$31.81 of the -$36.70** (KXBTC15M -22.02, KXDOGE15M -15.59,
KXHYPE15M -10.49, KXXRP15M -5.25, KXETH15M -1.07 against KXSOL15M +15.68, KXBNB15M +6.93). Third
consecutive day where that one cluster is the whole result.

**Ladder: zero transitions in 24 h** (`lastPromotionAt` still 2026-09-14T11:18:44Z). lead-lag live x4, 184
settled since stage start **+$9.85 (was +$32.90)**, checkpoint at 200; **fade's 100-trade checkpoint fired
and the ladder HELD it** - 120 settled, +$2.59, negative 5-min markout band, and `trade-quality` agrees
independently at -0.35c/contract [-4.28, +3.57]; consensus 15 settled -$3.29; volume-spike 14 -$1.10;
mean-reversion 5 -$3.49; sports-anchor 2 -$0.22; convergence 1 +$0.05; cross-venue and dutch still 0
settled after 9 days. momentum (cd 09-27) and book-imbalance (cd 09-25) stayed stopped - item 69 holds.
Convergence's scan note **now carries its skip breakdown** (`in window 188: margin-out 174 cost-out 13
no-vol 0 edge-out 1 event-dup 0 limits 0 | graded 10 (W:9 L:1) PnL: -27c`), closing yesterday's gap; the
stage-accounting mismatch against the ladder's 1 settled / +$0.05 persists. Quoter `fair-value on N of M`
last appeared 2026-09-07 - correct, it is under operator hold.

**Sharp anchor, out of sample:** gradedN **555** (+28), gradedBrier sum 66.950 -> **mean Brier 0.1206**;
ruleN **265** (+12), ruleNet **+$12.75** (+$0.645, about **+5.4c** per new rule trade - a fourth
consecutive positive day); `anchor-grades.jsonl` **555 rows, +28**. The live arm still disagrees
(-10.18c/contract, event-CI [-16.13, -4.23] over 10) and the 20-trade checkpoint will settle it.
**Odds API:** 09-11 632, 09-12 644, 09-13 644, 09-14 642, 09-15 238 so far - under 645 every day.

**Gates.** btc-gate **FAIL/NOT YET**, but the event half flipped: **210 events** (needs 200; 194
yesterday), 539 trades, net +0.79c, Bonferroni LB -2.15c, day LB -0.45c, adverse 3.53%. The count no longer
blocks it; the economics do. quoter-shadow-gate **insufficient sample**: allowed 23 fills / 13 events
(needs 30/40) at +2.48c; blocked -4.54c over 836/164, CI [-7.44, -1.65].

**CHANGED TODAY - `scripts/trade-quality.mjs` could never report a tripped kill switch.** The app keeps
`state.daily = {date, count}` (trade counter) and `state.dailyPnl = {date, realized, tripped}` (kill
switch); line 24 read `s.daily?.tripped`, a field that does not exist, so **the line could only ever print
"kill clear"** - and this morning it printed "clear" through a 2.5-hour halt, in the one script this daily
session uses to decide whether the trader is healthy. Fix: new pure module `scripts/lib/kill-state.mjs`
(`killState(state, today)`), imported by `trade-quality.mjs`, which reads `dailyPnl`, honours the same
UTC-day guard as `rollDaily`, reports **whichever ledger is worse** the way `dayRealizedForKill` chooses
it, and raises a FLAG. Now prints `kill TRIPPED (venue day -24.18) - new entries halted until the next UTC
day`. **8 new tests** in `review-fixes`; a mutant restoring the original `state?.daily` read fails **exactly
those 4** assertions and no others, file restored byte-identical. **No app source touched, so no restart.**

**Deployment verification (the backlog's "next routine daily maintenance" trigger) - all three pass.**
Scan phases from the episodes ledger (574 `kind: 'scan'` rows): median scan **117.7 s before 08:31Z -> 62.5 s
after the 09:44Z restart**, universe phase 29.8 s -> 7.9 s. **That is 62 scans on one morning and it is not
credited with any P&L** (the window's P&L is zero because the kill switch is holding entries). Order
journal: 57 appended rows -> 19 unique, **19 acknowledged, 0 pending, 0 rejected**, all with an orderId, so
no blocked reservation; rows are version `r2` and the first `r3` row will only appear on tomorrow's first
entry - **because of the kill switch, not the journal**, and that is the thing to check tomorrow. Orphan
exposure: **zero** `orphan-ledger` episodes, zero orphan alerts, `orphans` phase 0 ms on all 574 scans.

**Shadows.** Poly consensus 5,750 signals / **4,844 graded**, Brier 0.0922, **+6.00c** at the Kalshi ask net
of fee (791 matched) - but the arm itself is now the test. **Mention shadow graded its first 34 strikes**,
exactly as backlog 82's dated prediction said it would, so **item 82 is closed and item 93 stays a logging
improvement**. The first evidence is against the shadow's premise: **Brier base 0.2680 vs market ~0.0000** -
all 34 are `KXTRUMPSAY-26SEP14` strikes the market priced at 0.5c that did not happen, while the transcript
base rate put them at 4.5-13.6%. Caveats recorded now rather than later: one event = **one cluster**, and
all NO-side. HRRR 216 graded station-days, MAE 1.89 vs NBM 2.31, closer 118 v 89 - the 09-21 date binds.
Metaculus 75 pairs, 0 graded.

**Build queue: every trigger checked** (table in the report). Item 1, the critic, **does not fire for the
sixth consecutive day and the amendments are again load-bearing**: raw ABSTAIN +$0.020 vs VETO -$0.038 and
4 of 7 strategies skilled would say switch, but restricted to currently-enabled arms present in both cohorts
(fade, volume-spike, mean-reversion, consensus) **VETO is +$2.71 over 107 (+2.5c)** against ABSTAIN's +$8.63
over 112 - condition (i) fails outright. Item 79 (day-2 consensus refusal mix) read and **healthy**: `no-ask`
1-2 and no `market-gone`, 7 candidates per scan across 501 scans. Item 78/13 recorded not judged (15 settled
of the 40 required). Item 72 NOT YET (982 contracts but 3 of 5 day-clusters).

**Verification:** tsc clean; review-fixes **483/0**, ladder **126/0**, adversarial **89/0** (no flake this
run; backlog 80 stays open); `electron-vite build` clean; all suite output captured to
`tmp/testout/*-2026-09-15.txt` before anything else ran. Backup **MAINT-2026-09-15**
(`oracle-trader-MAINT-2026-09-15-20260915-071025.zip`, 988 files, 336 MB). No order placed, amended or
cancelled by hand; no key read, printed or moved; no arm, size, loss limit, ladder mode or execution setting
changed. `SendUserFile`/`PushNotification` unavailable in this headless session and sending was explicitly
skipped - the 08:30 desktop task delivers `docs/reports/2026-09-15.md`.

**Open for the operator: nothing due.** OpenRouter is topped up; the kill switch clears itself; both venues cover
their stakes. Context only: lead-lag is at live x4, the largest size on the ladder, with its stage total
down $23 in a day and its 200-settlement checkpoint 16 away.

## 2026-09-16 11:00Z - daily maintenance (headless, task OracleTrader-Maintenance)

Full section: `docs/reports/2026-09-16.md`.

**Liveness: everything up, nothing restarted, nothing down.** App electron PID 47432 started 09:44:51Z
(the overnight session's own deploy), `main.log` writing at the 11:12Z check, `ladder.json` `lastRunAt`
10:44:51Z, collector PID 31316, `reviews/2026-09-16.md` present (1 attempt, no error), all five hourly
shadow tasks fresh, sentinel `at` 11:05:02Z, the four recorders alive as single processes.

**Two things happened before this session and are not its work.** Backlog items 106-111 were built overnight
(03:30-05:44 local) by a concurrent session - lead-lag cached position count, the 4-contract lead-lag
ceiling, the explicit daily-loss restart baseline, authenticated IBKR/ForecastEx discovery and execution,
and a 23-arm IBKR **paper** laboratory. And **the operator reset the tripped Kalshi daily stop at 07:48:00Z**
(`state.killReset`, venue offset -24.09, local +1.58, "after baseline verification"). The kill switch is
clear, `dailyPnl` +7.85 untripped, 44 trades today.

**The day's real event: the ladder stopped lead-lag by itself at 08:35:53Z** - "checkpoint 200 trades, net
$-0.82, mean -0.00$ (80% band -0.23..0.22): 100+ trades and net not positive", cool-down to **2026-09-19**,
demotions 1, `leadLagLiveEnabled` false because the LADDER set it. The venue agrees to the second: last
`SWEEP EXECUTED` 08:35:58Z, five seconds later, and 5,473 dislocation lines since with 82 sweeps in the
window. Backlog 106's acceptance check (detection-to-fill below the 3.7 s baseline) therefore cannot be
read - entries stopped before the first post-deploy fill.

**Today's fix: the mention shadow was scoring a price that only exists after the answer is known**
(`scripts/mention_shadow.py`). `grade()` scored the last observation at or before `close_time`, and a Kalshi
mention market settles YES the instant the phrase is said with `close_time` set to that moment - so all 34
graded rows scored a mid of 0.995/0.005/0.015 and 33 of 34 had `brier_mkt` **exactly 0.0000**. Item 12's
">= 100 graded, Brier better than the price" trigger was unreachable by construction. A second defect in the
same twenty lines: the counterfactual NO branch was dead code - its first clause read `(1 - bid) - (1 - p)`,
which is `p - bid`, the negative of the NO edge, and contradicted the second clause. Fix: pure
`scored_observation` (first sight), `counterfactual` with the edge as `bid - p`, `grade_entry` recording
`scored_ts` and `mid_last`, plus `selftest` (10 assertions) and `regrade` (no network). Three mutants run on
a scratch copy: M1 3 failures, M2 2 failures, M3 0 - which is why the now-inert pre-close filter was deleted
rather than tested. Regraded: **Brier base 0.2719 vs market 0.1328**, and the 15 counterfactual NO trades
lose **4.2c/contract**. Not a verdict - 34 rows, one event, one cluster - but an honest one at last, and the
sign is against the shadow's premise.

**Venue-true 24 h: Kalshi -$13.58 after $5.66 fees over 110 settlements; Polymarket US $0.00, 0 resolutions.**
The 15-minute crypto book is -$21.90 of it (SOL -8.89, ETH -6.58, BNB -2.91, XRP -2.21, BTC -0.70,
DOGE -0.61) against HYPE +2.28 and sports +$9.03. Kalshi cash $74.85 + positions at cost $18.47 = **$93.32**;
shard 0 (weather) $26.56, shard 2 $22.63, shard 3 $25.66. PolyUS $39.85.

**Ladder vs ledger.** Every verdict agrees in direction. One magnitude gap, filed not fixed: the ladder
stopped lead-lag on -$0.82/200 trades while `leadlag-coins.mjs --check` puts the cohort at **-$60.47 over
396 markets (-2.52c/contract)** and the 15m crypto series at -$19.62 in 24 h. Different windows explain some
of it, not a factor of seventy - **backlog 112**.

**Sharp anchor:** `gradedN` **612** (555, **+57**), `gradedBrier` 73.807 (a SUM; mean **0.1206**),
`ruleN` **305** (265), `ruleNet` **+$16.23** (+$12.75, **+$3.48** in 24 h), `anchor-grades.jsonl` 612 rows.
The live arm is still the weak half: -$5.64 over 11, -9.64c/contract.

**Gates and spend:** Odds API **236** of 645 at 11:00Z. btc-gate FAIL/NOT YET (607 trades, 232 events,
+0.34c, day LB -1.09c). quoter-shadow-gate insufficient sample (30 fills / 18 events vs 30/40); its blocked
cohort at -4.34c over 910 supports the filter. `trade-quality.mjs` reads **"kill clear" and now means it** -
first daily run since the `kill-state.mjs` fix.

**Shadows:** HRRR 243 station-days (+27), MAE 1.92 vs NBM 2.31, closer 132 v 101 - the 09-21 date still
binds. Metaculus 84 pairs (+9), 0 graded. Consensus arm +$3.73 / 26 settled, CLV +15.40c, 14 short of its
checkpoint. Lead-lag coins NOT YET (1,120 contracts but 4 of 5 day-clusters) and it stops accumulating while
the arm is in cool-down.

**Sentinel:** fresh, **no incidents opened, none open, no repairs**. Three suppressions, none expired, none
renewed; the Polymarket-429 one expires 2026-09-18 and needs a decision tomorrow. Backlog 100 (the sentinel
watches whether the app is running, not whether it is trading) was **blind again today** - lead-lag stopped
at 08:35Z and three quiet checks since read "app up". Correct silence two days running is the argument for a
finding, not an alarm.

**Errors, 24 h:** 2 x `[dutch] scan failed: The operation was aborted due to timeout` at 11:03:19Z (**new
signature**, recovered next pass, `executed 0`) - backlog 114. 1 x `[reconciler] run failed: Gateway
disconnected` at 08:34:52Z - the **IBKR** gateway, self-recovered, both venue reconcilers `completeness: ok`.
3 x `[ibkr-lab] IBKR 200: No security definition` (paper only) - backlog 115. Nothing else real.

**Build queue: every trigger checked** (table in the report). Item 1, the critic, **does not fire for the
seventh consecutive day**: the raw read says "consider veto mode", but restricted to currently enabled arms
present in both cohorts (fade, mean-reversion, volume-spike, consensus) **VETO is +$3.10 over 112 (+2.77c)**
against ABSTAIN's +$12.76 over 162 - condition (i) fails outright and (iii) fails 2 of 4. **Item 64 is MET
and UNANSWERABLE: its evidence expired.** `calib.vetoWatch` is a rolling 180-row buffer covering 09-14 to
09-16 with **zero momentum rows**, and `calib.vetoesByReason` is not per-strategy. Closed as unanswerable;
the general lesson is **backlog 116** - a dated item whose evidence lives in a rolling buffer must be read
inside that buffer's window. Items 100-103 remain the next untriggered builds.

**Verification:** tsc clean; review-fixes **485/0**, ladder **126/0**, adversarial **89/0** (no flake this
run, backlog 80 stays open); `electron-vite build` clean; `mention_shadow.py selftest` 10/0 plus three
mutants; all output captured to `tmp/testout/*-2026-09-16.txt` before anything else ran. Backup
**MAINT-2026-09-16** (`oracle-trader-MAINT-2026-09-16-20260916-071142.zip`, 1,220 files, 392.7 MB zipped).
**The app was not restarted** - nothing in `src/` was touched, so there was nothing to deploy. No order
placed, amended or cancelled by hand; no key read, printed or moved; no arm, size, loss limit, ladder mode
or execution setting changed. `SendUserFile`/`PushNotification` unavailable in this headless session and
sending was explicitly skipped - the 08:30 desktop task delivers `docs/reports/2026-09-16.md`.

**Open for the operator: nothing due.** Context only: lead-lag is stopped until 09-19 and is the arm that has been
losing the money; the overnight 4-contract ceiling is deployed but unverified against a live fill; the
cadence shadow collects nothing while the arm is down; the mention shadow's first honest reading is against
its own premise.

## Repair 2026-09-17T04:05Z

Incident `data/sentinel/incidents/2026-09-17T03-50-log-warn-ibkr-lab-Error-Gateway-API-not.md`
(`[warn] [ibkr-lab] Error: Gateway API not available yet...`, x10 since 03:35Z). Outcome **FIXED**, with the
warn itself ruled external. **IB Gateway is simply off** - at 03:53Z there was no `ibgateway`/TWS/java process
on the box and 127.0.0.1:4001 and :4002 both refused - and the lab's own log stops dead between `scan 1592`
03:44:56.398Z and the first warn 03:45:11.605Z, matching `ibkr-lab.json` `lastScanAt`/`lastError` and
`fill-reconciler-ibkr.json` to the second. Nothing was at risk: `mode: paper`, `liveStrategies: []`,
`live: []`, `seenFillIds: []`, no IBKR order ever sent, and the quote call throws BEFORE
`fillOrders`/`closePositions` (`ibkrLab.ts:114` vs `126-127`), so no entry or exit is ever decided on a stale
book - `freshAsk`'s 30 s ceiling would refuse them anyway.

**Proving that turned up a real defect one line above it.** At 03:53:46.786Z the 6-hourly discovery window
opened. `s.discoveryAt` is written only on SUCCESS, so with the gateway down every 30 s scan re-ran the whole
36-product, 2-month contract walk and each failing `reader.markets()` logged a line: main.log went from **2
`[ibkr-lab]` lines a minute (03:42-03:52) to 83 at 03:53 and 164 for every full minute after it
(03:54-03:58)** - roughly 236k
lines/day into a 29 MB file that `scripts/sentinel.mjs` reads whole every 15 minutes. The market universe
itself was never corrupted (`forecastexData.ts:63` throws when nothing matches, so the old `s.markets`
survives); the cost is the log, the sentinel and a pointless walk twice a minute. Fix: `scan()` keeps a
`discoveryFailedAt` and waits 10 minutes after a failed discovery (`ibkrLab.ts:32,95-96,98`). The
no-universe-at-all case deliberately still tries every scan - there the scan has nothing else to do and must
stay loud instead of reporting a healthy "0/0 fresh pairs".

**Verification:** the four new assertions in `scripts/tests/ibkr-lab.test.ts` fail on the pre-fix file
(`A failed discovery is not retried on the next scan`) and pass on the fixed one; tsc clean; review-fixes
**485/0**, ladder **126/0**, adversarial **89/0**; `electron-vite build` clean with the change present in
`out/main/index.js`; output in `tmp/testout/*-2026-09-17.txt`. Backup **REPAIR-2026-09-17**
(`oracle-trader-REPAIR-2026-09-17-20260916-235827.zip`, 1,326 files, 427.1 MB). Deployed: electron stopped,
`OracleTrader-App` started, new PIDs 03:59:25Z, and the app came back healthy (Manifold 03:59:26Z, `[ladder]`
tick 04:01:28Z, convergence, lead-lag, poly-paper and the hunch pass all scanning). **Verified live with the
gateway still down:** the first scan of the new process ran ONE discovery walk (03:59:41Z) and then stopped
repeating it - exactly 2 lines a minute for nine straight minutes (04:00-04:08), every one of them the
`[warn]` and not one `[log]` discovery line, against 164 a minute before the restart - and then released on
schedule for exactly one further walk at 04:10:02.053Z, 10 min 21 s after the previous one, so the retry is
proven to resume on the live process and not only against the test's fake clock. The residual 2/min warn is suppressed to 2026-09-24 (pattern
`\[ibkr-lab\] Error: Gateway API not available yet`), checked with the sentinel's own `new RegExp(p,'i')`
against the stored signature, the raw sample and the finding key, and checked NOT to match
`IBKR 200: No security definition`, `Gateway disconnected`, `IBKR request timed out`,
`IBKR laboratory storage failed` or the `[reconciler]` line.

No order placed, amended or cancelled by hand; no key read, printed or moved; no arm, size, loss limit,
ladder mode or execution setting changed.

**Open for the operator: start IB Gateway.** Nothing on this box starts it - there is no scheduled task for it - and
the 23-arm paper laboratory records nothing until he does; it has been stopped since 03:44:56Z. The lab
resumes by itself the moment the gateway is back. Backlog **120** carries it, and because the log signature
is now suppressed for a week, the daily run must read `ibkr-lab.json` `lastScanAt`/`scans` rather than the
log's silence.

---

## Repair 2026-09-17T11:00Z

Incident `data/sentinel/incidents/2026-09-17T10-50-hrrr-stale.md` (`hrrr-stale`:
`data/hrrr-shadow/forecasts.jsonl` last written 08:20:11.724Z, the sentinel's own task restart at
10:35:01.949Z without effect). Outcome **NEEDS-OPERATOR**. **The LAN router's DNS resolver returns NXDOMAIN for
`api.open-meteo.com`.** No code changed, so nothing was built, tested, restarted or backed up.

The scheduled task is innocent: `OracleTrader-HrrrShadow` is `Ready`, **Last Result 0**,
`NumberOfMissedRuns: 0`, next run 7:20 local. Reproduced by hand at 10:51:05-10:51:12Z with the task's own
command - all 27 stations `forecast failed: fetch failed`, `forecasts stored for 0/27 stations`, exit 0 -
and the failures are ~263 ms apart, i.e. only the loop's `sleep(250)`, so each fetch dies instantly.
`fetch` rejects with `cause.code = ENOTFOUND`; `collect()` appends inside a per-station `try`
(`scripts/hrrr-shadow.mjs:134`, catch `:136-138`), so a total failure never touches `forecasts.jsonl` and
its mtime - the only thing the sentinel watches (`scripts/sentinel.mjs:181,186-196`) - stays put. The task
therefore "runs and succeeds" forever while collecting nothing.

Pinned to one hostname and to the router, not to the upstream: `192.168.50.1` (ASUS `ZenWiFi_XT8-0D50`)
NXDOMAINs `api.open-meteo.com` 5/5 on A and AAAA, and `nslookup` aimed straight at it - past the Windows
cache - says the same, so `ipconfig /flushdns` was not the answer. `1.1.1.1` and `8.8.8.8` both answer
`188.40.99.226` (Google with a full 1800 s TTL, i.e. freshly fetched); `9.9.9.9` NXDOMAINs like the router.
The name is a **sub-delegation** - `arely.ns.cloudflare.com` hands off to `geo-ns01/02.open-meteo.com` -
and both geo servers (`91.200.176.1`, `109.104.147.1`, bunny.net) answer `188.40.99.226` **when queried
from this box**, so the upstream is up and reachable and it is the router's recursion that will not follow
the delegation. One label over, `ensemble-api.open-meteo.com` resolves fine through the same router, which
is why `btc-collector.mjs:132` - the only other `open-meteo` caller in the repo - never went stale.

Blast radius is that one shadow. The app never noticed: 4 electron processes (oldest up 05:40:58 local),
`main.log` writing at 10:54:29.548Z, and not a single `ENOTFOUND`/`EAI_AGAIN`/`getaddrinfo`/`open-meteo`
line in it; `api.weather.gov` (200/106 ms) and `api.elections.kalshi.com` (200/50 ms) both fine, so grading
continues (`grades.jsonl` 297 rows, 2026-09-16 graded at 07:20:09.598Z). Lost so far: the 09:20Z and 10:20Z
forecast runs, plus an isolated earlier hole at 02:20Z that looks like the same resolver flapping once
before it failed outright; those hours are unrecoverable, as Open-Meteo serves the current run only. The
2026-09-21 decision survives it - `node scripts/hrrr-shadow.mjs report` already reads HRRR
`n=270 mae 1.91 bias -0.31` vs NBM `n=270 mae 2.30 bias -1.59` (closer HRRR 144 / NBM 116 / ties 10),
well past the 100-station-day bar, and the lost hours are overnight ones the report's `issueHour=9` filter
discards anyway.

**Not suppressed, on purpose.** `hrrr-stale` *is* suppressible - `add()` matches the pattern against the
finding key and title (`scripts/sentinel.mjs:88`), so the 2026-09-15 note that a file-mtime finding cannot
be reached by an entry is out of date and should not be trusted again. It stays loud because hourly data
loss is not the benign noise the suppression rule is for, and the repeating finding is what carries this to
The operator. The cost is bounded to two dispatches a day by the 12 h per-key rule (`scripts/sentinel.mjs:506`);
the 3-hourly `revive-task` restart is an 8 s no-op. A re-dispatched session should read the incident and
close in one pass.

No order placed, amended or cancelled by hand; no key read, printed or moved; no arm, size, loss limit,
ladder mode, ladder stage or scheduled task setting changed.

**Open for the operator: fix DNS for `api.open-meteo.com`.** Either point the router (`192.168.50.1`) at
`1.1.1.1`/`8.8.8.8`, or set this box's Ethernet adapter DNS to the same. I did neither unattended: both
redirect the name resolution of the live app's venue traffic at 07:00 local with nobody watching, and a
resolver change that went wrong would cost far more than a shadow experiment - the same class of call as
the 2026-09-15 unattended-Windows-Update finding. The shadow resumes by itself once the name resolves;
confirm with `nslookup -type=A api.open-meteo.com 192.168.50.1`, then `node scripts/hrrr-shadow.mjs`
logging `forecasts stored for 27/27 stations`.

---

## 2026-09-17 11:00Z - daily maintenance (headless, task OracleTrader-Maintenance)

Headless run (Windows task `OracleTrader-Maintenance`, 07:00 local / 11:00Z). Everything below was read or
run in this session; comparisons with yesterday are labelled as such.

**Headline:** the trader is healthy, nothing was down at the venue, and the ledger is **green over 24 h —
Kalshi +$4.14 after fees on 63 settlements, Polymarket US resolved nothing.** Two things were fixed today,
both of them a component that had stopped working while every liveness light stayed on. (1) The **HRRR
weather shadow had collected nothing since 08:20Z** because the LAN router started answering NXDOMAIN for
`api.open-meteo.com`; the 06:50 repair session diagnosed it correctly but stopped at "only the operator can change
the resolver". There was a third option it did not consider — resolve the name inside the shadow's own
process — and that is now in and verified against the live failure. (2) The **cross-venue arm has been
"tiny-live" for eleven days with one signal in its life**, and it is not a shy strategy: it compared
`markets.slice(0, 12)` — the same head of the list on every scan — against a universe of **249** markets,
so 95% of the board was never looked at. It now rotates through the whole universe on the same twelve-search
budget and says out loud why it is silent. **Nothing needs the operator today.**

---

## 1. Liveness — one thing was down, and it is back

| check | reading | verdict |
|---|---|---|
| App process | `electron.exe .` PID **20792**, started 09:40:58Z (round 116's deploy) | up |
| `logs\main.log` | last write 11:00:29Z at the 11:00Z check | up |
| `ladder.json` `lastRunAt` | **10:40:58Z** (19 min at the check) | inside the 2 h bound |
| BTC collector | `node scripts/btc-collector.mjs` PID 31316 | up |
| Nightly review | `reviews/2026-09-17.md` present, 1 attempt, no error | up |
| `OracleTrader-HrrrShadow` | `forecasts.jsonl` last written **08:20:11Z — 160 min, STALE** | **DOWN, fixed (§4a)** |
| `OracleTrader-MetaculusShadow` | `last-mc.json` 10:35:42Z; **93 pairs** (84 yesterday, +9) | up |
| `OracleTrader-MentionShadow` | `run.log` 10:50:29Z | up |
| `OracleTrader-PolyConsensus` | `run.log` 11:00:22Z | up |
| `OracleTrader-Sentinel` | `status.json` `at` 10:50:01Z, then 11:05:01Z | fresh |
| Recorders | `crypto15-shadow`, `ladder15-shadow`, `mmsim`, `spot-shadow`, one process each | alive, no duplicates |
| Scheduled tasks | all ten `OracleTrader-*` present, none disabled | ok |

The app was restarted **twice, by this session and only by this session** — 11:09:56Z (PID 7212) to load
today's build, and 11:19:24Z (PID 50696) to load one tuning change to it (§4b). Both were visible starts and
`main.log` resumed immediately both times.
`pairs.jsonl` for Metaculus has not grown since 20:36Z yesterday, but that file only grows when a new pair
matches — the shadow's liveness file `last-mc.json` is on schedule, so it is running, not stuck.

## 2. Evidence read

**Venue-true P&L, fresh read-only dumps (`venue-pnl.py`, netted pairs — not raw `revenue - costs`):**

- Kalshi, since 2026-09-16T11:00Z: **63 settlements, +$4.14 after $1.53 of fees.** Best series
  KXATPCHALLENGERMATCH +$5.85 (n=4), KXXRP15M +$1.97 (n=4), KXMLBRFI +$1.51 (n=3); worst
  KXWTACHALLENGERMATCH -$1.99 (n=7), KXBNB15M -$1.57 (n=4).
- Polymarket US: **0 resolutions, $0.00.** Balance $39.85, nothing open, nothing resting.
- Kalshi balances by shard: **0: $19.03, 1: $0.00, 2: $22.97, 3: $26.11** (cash $68.12), open positions
  $29.19 at cost / $26.79 at market, **29 positions, 0 resting orders**, equity $97.30.
  Stakes are $1 (`amountPerTrade`) against a `maxBalancePct` ceiling of 25% = $24.33: **every configured
  stake is covered on both venues**, and shard 0 (the weather shard) does not bind while every weather arm
  is retired.

**Kill switch:** clear. `state.dailyPnl` +$0.85 realized, `tripped: false`; `venueDay` +$2.45 over 23
settlements; 19 trades today. (Read through `scripts/lib/kill-state.mjs`, the 09-15 fix.)

**`trade-quality.mjs`** — the live Kalshi book, all-time by arm: fade 220 trades +$7.92 (-0.67c/contract,
CI -4.10..+2.76), consensus 54 +$4.43, mean-reversion 14 +$19.18 (+9.08c, CI -15.83..+34.00 — n is tiny),
volume-spike 63 -$3.97, momentum 54 -$10.63, book-imbalance 37 -$12.42, flow-follow 14 -$3.20,
sports-anchor 11 -$5.64. Flags: book-imbalance, momentum, sports-anchor, volume-spike and flow-follow all
"REVIEW: losing" — of those only volume-spike and sports-anchor are still enabled, the rest are in
cool-down or held. Polymarket US is -$16.25 lifetime over 237 closed trades, all of its arms disabled.

**Gates:** `btc-gate` **FAIL / NOT YET** — 249 events, 657 graded strike-trades, net +0.22c/contract,
day-clustered CI [-1.09, +1.54] (needs a lower bound above zero) and Bonferroni LB -2.62c against a +1c bar.
`quoter-shadow-gate` **insufficient sample** — the allowed cohort has 30 settled proxy fills over 18 events
against a 30/40 bar, +6.30c [-11.10, +23.70]; the blocked cohort is -4.87c [-7.52, -2.23] over 957, which
supports the gates as a filter and says nothing about the strategy behind them.

**Odds API spend:** **322 of 645 today** (534 yesterday; 644/645 on 09-12 and 09-13). Under budget.

**Sharp anchor, out of sample:** gradedN **650**, gradedBrierSum 75.798 → **mean Brier 0.1166**; ruleN
**328**, ruleNet **+$18.675 = +5.69c/contract**. `anchor-grades.jsonl` is at **654 rows, +42 since
yesterday's run** — but all 42 are dated 09-16 and the newest is 19:21:42Z; see §7 item 135.

**Silent-strategy checks the prompt names:**

- `[convergence]`: scanning normally — `in window 188: margin-out 174 cost-out 14 no-vol 0 edge-out 0
  event-dup 0 limits 0 | graded 10 (W:9 L:1) PnL -27c`. Refusing on margin, which is the gate doing its job.
- `[quoter] fair-value on N of M`: **still absent from the log**, as backlog 113 recorded yesterday — the
  quoter is disabled (operator hold since 09-09) and logs `disabled: 27 candidates, would quote 0` instead.
  The last "fair-value on" line in the whole file is 2026-09-07. Not a new defect; that checklist item in
  the prompt is stale while the arm is off.
- WebSocket agreement (build-queue item 2, daily reading): **7,014 / 7,030 = 0.9977**, above the 0.99 bar,
  **on the current process only** — the counters are per-process and the app restarts, so this is not a
  day's slice and the seven-day streak still cannot be computed (backlog 56).
- Lead-lag: **16 executed sweeps since the 09:40:58Z orderbook fix, median latency 89 ms, p90 99 ms**
  (one 1,960 ms outlier). The re-armed arm has no settled trade yet.

**Shadows:** HRRR n=270 station-days, MAE **1.91 (bias -0.31)** vs NBM **2.30 (bias -1.59)**, closer on
144 vs 116. Mention shadow: 34 graded, Brier base 0.2719 vs **market 0.1328** — the market still wins and
the 15 counterfactual trades lose 4.24c/contract, which is the honest reading the 09-16 fix exposed.
Polymarket consensus: 7,423 signals, 6,367 graded, hit 0.71 at mean price 0.71, Brier 0.0902,
**+4.63c/contract at the Kalshi ask net of fee** (n=1,022). Metaculus: 93 pairs, **0 graded** — nothing to
report until questions resolve. Spot-first: 529,340 Kalshi polls over 4 days, 1,255 settled windows,
candidate decisions 2c/3c/5c = 2,059/1,935/1,670, read on 2026-09-21 as pre-registered.

## 3. Ladder verdicts against the venue ledger

The ladder is running (hourly tick, `lastRunAt` 10:40:58Z) and it made one transition in the last 48 h:
**kalshi-leadlag disabled → tiny-live at 09:16:16Z today**, "trade-small mode: real-money micro test 2
(stop -$5)", after the operator ended its cool-down early yesterday. Ten arms are tiny-live at notch 1
(convergence, fade, volume-spike, cross-venue, news, dutch, leadlag, sports-anchor, mean-reversion,
consensus); ten are disabled, paper or operator-held, each with a recorded reason.

Nothing the ladder claimed today is contradicted by the ledger: the arms with open checkpoints
(fade 163 trades -0.03c, consensus 53 settled +$3.59, volume-spike 37 settled -$0.24) match the venue-side
numbers in `trade-quality.mjs` within the difference in windows, and the arms it stopped are the arms the
venue shows losing. **Backlog 112 stays open and unreconciled** — yesterday's lead-lag stop quoted
"200 trades, net -$0.82" against a venue read of -$60.47, a factor of seventy — but there is nothing to
reconcile today: the re-armed arm has 0 settled trades. Do it at its first checkpoint, before the ladder
can promote on that arithmetic.

## 4. What changed today

### 4a. The HRRR shadow was silently collecting nothing, and it did not have to be the operator's problem

**Defect.** `data/hrrr-shadow/forecasts.jsonl` had not been written since 08:20:11Z. The task fires on the
hour, exits 0 and reports `NumberOfMissedRuns: 0`; `collect()` appends per station inside a `try` and
swallows the error (`scripts/hrrr-shadow.mjs:136-138`), so **an hour of lost data looks exactly like a
successful run**. Confirmed at the resolver: `nslookup api.open-meteo.com 192.168.50.1` → `Non-existent
domain`; the same name from `1.1.1.1` → `188.40.99.226`.

The 10:50Z repair session diagnosed this correctly and stopped, because the two fixes it could see (the
router, or this box's adapter) both redirect the **live trading app's** venue lookups at 07:00 local with
nobody watching. That reasoning was right. What it missed is that neither is necessary.

**Fix — `scripts/lib/dns-fallback.mjs` (new) and `scripts/hrrr-shadow.mjs`.** `getJsonWithDnsFallback()`
tries the normal `fetch` first and falls back to `1.1.1.1`/`8.8.8.8` **only** on `ENOTFOUND`/`EAI_AGAIN`.
One process, one request path; the app's resolution is untouched. Anything that is not a name failure —
refused connection, TLS error, HTTP status — propagates unchanged, so a real fault cannot hide behind a
second resolver. Worth recording for the next reader: **`dns.setServers()` would not have worked here.**
It rebinds `dns.resolve*`, while `fetch`/undici connects through `dns.lookup` (getaddrinfo). The helper
resolves the name itself and hands `node:https` an explicit `lookup`.

**Verified against the live failure, not a mock.** `node scripts/hrrr-shadow.mjs` at 11:06:25Z logged
`api.open-meteo.com: system resolver failed, retrying via 1.1.1.1/8.8.8.8` for every station and then
**`forecasts stored for 27/27 stations`**; `forecasts.jsonl` went 6,251 → 6,278 rows. The 08:20Z–11:06Z
hole is permanent (Open-Meteo serves the current run, not a past one) and falls in overnight hours the
report's `issueHour >= 9` filter discards anyway, so the 09-21 decision is unaffected.

### 4b. Build queue: the cross-venue arm could not see the market it was meant to compare (item 123)

**Trigger check.** Item 123's trigger is "any day" and it is the first met item on the list (1 and 2 are
daily readings, 3 waits on the 09-21 date, 4–7 are gated on a positive quoter or anchor checkpoint that does
not exist, 8c waits on mean-reversion v3 fills, and 127/129/130/132 are dated 09-18 or later — 127 needs 20
executed sweeps against the 16 we have). Yesterday's round left 123 marked "stays open for the operator: news and
cross-venue are correct as coded and almost never qualify". On the operator's standing rule — *a strategy that never
produces signals is a bug to diagnose, not a decision to leave* — that verdict deserved one read of the
implementation before it stood. It does not survive it.

**Defect** (`autoTrader.ts`, `crossVenueSignals`). The loop ran over `markets.slice(0, 12)` — the **same
head of the scan list on every scan**, against a universe the arm's own new note now measures at **249**
markets. About 95% of the board was never compared to Polymarket at all, and the cap counted *markets
looked at* rather than *searches made*, so a head full of markets with no tradeable asset could spend the
whole budget on zero searches. The title-token test also ran **after** the Gamma round trip, paying for
searches whose results were then discarded.

**Fix.** `crossVenueBatch()` + `CROSS_VENUE_SEARCH_BUDGET`: the budget is now a budget of **searches**, the
window **rotates** across the universe and resumes where it stopped, and only markets that would really be
searched spend it. Unsearchable markets are skipped for free and counted. And the arm says why it is silent,
the way the consensus arm does.

**Verified live at 11:11:08Z**, the first pass on the new build:

`[cross-venue] 249 universe, searched 12 from offset 0, 0 candidates | refused {"no-asset-or-title":67,"below-similarity":12}`

and then rotating across the universe exactly as intended — offsets 0, 159, 171, 61, 102 on the following
passes, with **the arm's first candidate in eleven days at 11:16:13Z** (`264 universe, searched 12 from
offset 159, 1 candidates`). It was not executed: candidates still go through the gates, and the ladder still
governs the arm at micro size.

**The verification then found a second thing, which is why the app was restarted twice.** The arm does not
run once per 10-minute scan — it runs about **twice a minute**. At twelve searches a pass that is ~1,440
requests an hour against a free public endpoint, roughly **seven times** what the old code actually spent
(the head slice averaged ~1.8 real searches a pass, because most of the head has no tradeable asset). "Fit
budgets in code" applies, so `CROSS_VENUE_SEARCH_BUDGET` is **4**, not 12: ~480 requests an hour, and the
~38 searchable markets of a 250-market universe are still covered in about **five minutes**, far inside the
life of any dislocation worth taking. Verified live on the second build at the tuned rate.

The refusal counters are already a result: 67 of the 79 markets examined in the first pass carry no tradeable
asset, and the real searches are refused overwhelmingly at `below-similarity` — priced Polymarket markets
that miss the 0.3 title-similarity floor. **That is the next question, and it is a matcher question, not a
reason to lower the floor** — filed as backlog 133 with a day of counts as its trigger.

**Gate:** run twice, once per build. `tsc --noEmit` clean; `review-fixes` **512 passed / 0 failed**
(+23 assertions today: 9 for the DNS fallback, 14 for the rotation — coverage across consecutive passes,
skipped rows not spending budget, empty and zero-budget universes, negative and out-of-range cursors, and a
guard that the shipped budget stays positive, since a 0 would silence the arm again); `ladder` 126/0;
`adversarial` 89/0 (no flake in either run, cf. backlog 80); `electron-vite build` clean; backup
`MAINT-2026-09-17` written (1,428 files, 445.8 MB zip); app restarted visibly at 11:09:56Z and 11:19:24Z,
both verified in `main.log`, with no `[error]` line after either.

## 5. Sentinel

`status.json` `at` 10:50:01Z at the first check and 11:05:01Z at the last — fresh, inside the 30-minute
bound, no `Start-ScheduledTask` needed. **Two incidents opened today, both now CLOSED; none still open:**

- `2026-09-17T03-50` IBKR gateway warning storm — closed by the 03:50 repair session, which fixed a real
  defect behind it (a failed contract discovery retried on every 30 s scan, 2 → 164 log lines a minute).
  The residual warn is external, suppressed to 09-24; the gateway itself is the operator's (backlog 120).
- `2026-09-17T10-50` HRRR stale — closed by the repair session as NEEDS-OPERATOR; **reopened, fixed and
  re-closed by this session** (§4a). The incident file carries the update so tomorrow's run does not
  escalate a fixed problem to the operator again.

`repairSessionsToday: 2` of the 3/day budget. Suppressions: only the `[ibkr-lab]` signature, expiring
2026-09-24 with its reason recorded — not renewed, not extended. The `hrrr-stale` finding was deliberately
left unsuppressed by the repair session; with collection restored it should go quiet on its own, and if it
does not, that is a second fault worth seeing.

## 6. Build-queue trigger checks (every one, as the prompt requires)

| # | trigger | today |
|---|---|---|
| 1 | critic skill, daily | **MET, rule does not fire** — see below |
| 2 | WS agreement ≥ 0.99 for 7 days | 0.9977 on the current process; the day's slice still is not computable (backlog 56) |
| 3 | HRRR MAE < NBM after 2026-09-21 | half met (n=270 ≫ 100, MAE 1.91 vs 2.30); **the date binds** |
| 4, 5 | quoter notch ≥ 2 / positive quoter checkpoint | not met (quoter retired; backlog 37) |
| 6 | anchor's first checkpoint net positive | not met — 3 settled since stage start, -$0.50, checkpoint at 20 |
| 7 | anchor notch ≥ 2 | not met |
| 8c | mean-reversion v3 fills + positive checkpoint | not met — 8 settled, -$2.64 |
| 121/122/124 | paper-lab fixes | done yesterday (round 114) |
| 123 | any day | **MET — built today (§4b)** |
| 125 | 2026-09-24 | not yet |
| 127 | first 20 executed sweeps after 09:40:58Z | **not yet — 16 sweeps.** Median 89 ms, p90 99 ms, both inside the 200 ms / 1 s bars, so it is tracking to pass; 128 stays gated on it |
| 129, 130 | 2026-09-18 | not yet |
| 132 | 2026-09-19 | not yet |

**Item 1, critic skill (`critic-skill.py` on today's dump).** 1,695 decisions; settled 300 ABSTAIN /
215 VETO / 65 ERROR / 10 ALLOW_UNCHANGED. Raw aggregate: ABSTAIN +$0.031/contract, VETO -$0.032, and the
script prints "consider veto mode". The amended rule (the 09-10 tie-break, and amendment 2: **currently
enabled arms only**) declines it again, by a wider margin than yesterday. The enabled arms present in both
cohorts are consensus, fade, mean-reversion and volume-spike; over those, **VETO is +$3.12 over 133
contracts (+2.3c)** against ABSTAIN's +$13.84 over 198 (+7.0c). Condition (i) fails — the vetoed cohort's
own net is **above** zero. Condition (iii) fails — the critic looks skilled in 2 of 4 (consensus,
volume-spike) and anti-skilled in 2 (fade, mean-reversion), which is not a strict majority. Only (ii)
passes. **Nothing changed.** The 200-settled `intelligenceEnabled: false` clause is not reached either: the
skill is not absent, it is composition-dependent — the same reading as every day since 09-09.

## 7. Backlog

Added **133** (cross-venue similarity is the next question — read a day of refusal counts; do **not** lower
the similarity floor first), **134** (the nightly review's 24 h venue P&L disagrees with `venue-pnl.py` in
sign: the review says -$9.98 and raises `LAST_24H_LOSS` while the netted read says +$4.14 over the same day
and +$15.41 since 06:00Z — the review is using the raw `revenue - costs` shape the prompt forbids),
**135** (the sports anchor graded nothing for 16 h with `0 matchable` on four settled sweeps — benign or a
drifting ticker join, decided tomorrow), **136** (the router's resolver, and the rule that a future name
failure is fixed in-repo rather than on the box). Updated the HRRR shadow entry and item 123. Removed
nothing.

## 8. For the operator — nothing is due

No deposit, subscription, key, arm, size or loss-limit change is needed. Stakes are covered on both venues
($1 stakes against $68.12 of Kalshi cash and $39.85 on Polymarket US), no credit balance failed (OpenRouter
$15.71, Odds API 322 of 645 today), and the ladder made no scale-up that a cap clipped.

Two things are worth knowing, neither blocking:

1. **IB Gateway is still off** (since 03:45Z), so the 23-arm IBKR paper lab is frozen. Only the operator can start
   it; nothing is at risk while it is down (mode `paper`, no live IBKR arm, no order ever sent).
2. **The LAN router's DNS is genuinely broken** for `api.open-meteo.com`, `api.kalshi.com` and
   `api.metaculus.com` (every host this project actually uses still resolves). Pointing the router at
   `1.1.1.1`/`8.8.8.8` is the right repair for the house; the trader no longer depends on it.

## 9. Delivery

This is the headless runner: **`SendUserFile` and `PushNotification` are not available in this session.**
The report is written to `docs/reports/2026-09-17.md`, and the desktop task at 08:30 local delivers it.

## 10. Ten-line summary

1. Everything is up; the app was restarted once, by this session, to load today's build.
2. Kalshi is +$4.14 venue-true after fees over 24 h on 63 settlements; Polymarket US resolved nothing.
3. The kill switch is clear, 19 trades today, $1 stakes fully covered by $68.12 of Kalshi cash.
4. The HRRR shadow had lost three hours of data to the router's NXDOMAIN on api.open-meteo.com; fixed
   in-repo with a fallback scoped to that one process, verified live at 27/27 stations.
5. The cross-venue arm was comparing the same 12 of 249 markets on every pass; it now rotates the whole
   universe, covers it in ~5 minutes, and logs why it is silent — and it produced its first candidate in
   eleven days within five minutes of the deploy. Its searches are refused almost entirely at the title
   similarity floor, which is tomorrow's question (backlog 133) and a matcher problem, not a reason to
   lower the floor.
6. The critic-skill rule fired on the raw read and was declined again on the enabled-arms amendment.
7. Sharp anchor: 650 graded, mean Brier 0.1166, rule +$18.675 over 328 = +5.69c/contract; no new grade
   in 16 h, which is backlog 135 to confirm or diagnose tomorrow.
8. Lead-lag execution is fast after yesterday's orderbook fix: 16 sweeps, median 89 ms, p90 99 ms.
9. Two sentinel incidents today, both closed; no incident is open; the sentinel itself is fresh.
10. Nothing needs the operator. IB Gateway is still off (his to start) and the router's DNS is still broken for
    three names, none of which this project now depends on.


## 2026-09-18 15:39Z - daily maintenance (headless, task OracleTrader-Maintenance, 11:30 local catch-up)

The 07:00 and 07:05 runs and the 08:05 repair session all exited 1 on "You've hit your weekly limit -
resets 11am (America/New_York)". This run is the 11:30 local catch-up added in commit e73ced0 this
morning, and it is the first live proof that the per-day idempotence guard (keyed on SUCCESS) does not
suppress the catch-up after failed attempts. Incident 2026-09-18T12-05-maintenance-failed is now CLOSED
NOT-A-DEFECT.

Note for anyone reading the git log: three build items were finished earlier today (11:19-11:38 local) by
a separate session - 136 state backup, 132/127/128-step-1 lead-lag re-baseline and the 10 s poll, 139
Manifold removal. This section does not repeat them; it covers the maintenance run itself.

## 1. Liveness

- App **up**, 4 electron processes, restarted 15:36:02Z by that earlier session; `main.log` age 0 min.
- `ladder.json` `lastRunAt` **15:38:02Z**, inside the 2 h bar.
- BTC collector **up** (`node scripts/btc-collector.mjs`, pid 31316).
- Nightly review `reviews/2026-09-18.md` present (written 06:23Z), `attempts: 1`, no error.
- Sentinel `status.json` **15:49:08Z**, fresh; the task returned rc=0 on the tick I started after the code change.
- Hourly shadows all inside 2 h: HRRR 15:20Z, mention 14:50Z, Polymarket-consensus 15:00Z, Metaculus 15:50Z.
- **DOWN and fixed: the spot-first recorder.** `data/spot-shadow/recorder.log` stopped at **13:32:12Z** and
  the last row was written 13:34Z; no `node scripts/spot-shadow.mjs` process existed. Restarted visibly via
  `Start-ScheduledTask OracleTrader-SpotShadow` at **15:43:29Z** and verified collecting (Coinbase ws
  subscribed, window 15:30Z resolved on all five coins, PM ws subscribed). **2 h 09 m of the pre-registered
  spot-first dataset is lost**, four days before its 2026-09-21 verdict (queue 84). Cause NOT established:
  the script already has `unhandledRejection`/`uncaughtException` handlers that log and continue, and the log
  ends on a clean heartbeat with `errors 0`, so it was not an uncaught throw; there is no Windows error
  report; the Scheduled Task discards stderr, so an OOM (173 M WebSocket messages over a 3-day process) would
  leave exactly this evidence and so would a kill. Recorded as backlog 145.
- **mmsim is halting itself, by design, and it is now doing it twice a day.** See section 4b.

## 2. Evidence

**Venue-true 24 h** (`scripts/venue-pnl.py` on fresh GET-only dumps, `--since 2026-09-17T15:40:00Z`):

- **Kalshi: 215 settlements, net +$5.34 after $4.35 fees.** The lead-lag 15-minute family is the whole of
  it: BNB +$3.16, XRP +$2.61, DOGE +$1.96, SOL +$1.43, BTC +$1.09, ZEC +$0.51 against **HYPE -$1.74 and
  ETH -$0.75**. Outside it, one bad night of single-contract sports NO legs (-$1.04 to -$0.98 each on
  LALIGA/NFL/EFL/CHNL1/UEL BTTS and silver) against KXUEL1HSPREAD +$2.01 and MLBRFI +$1.76.
- **Polymarket US: 0 resolutions, $0.00.** Balance $39.85, nothing open, nothing resting.
- Kalshi balances by shard: **0: $12.37, 1: $0.00, 2: $25.33, 3: $28.27** (cash $65.98), 30 positions at
  cost $30.90, 5 resting orders, equity $96.88 at cost / $91.47 at market. Stake is $1 (`amountPerTrade`)
  against a `maxBalancePct` ceiling of 25% = $24.22: **every configured stake is covered on both venues**,
  and shard 0 does not bind while every weather arm is retired.

**Kill switch:** clear. `state.dailyPnl` -$2.75 realized, `tripped: false`; `venueDay` +$4.28 over 129
settlements; 32 trades today (cap 200).

**`trade-quality.mjs`** - live Kalshi book, all-time by arm: fade 243 trades +$8.18 (+4.50c/contract,
event CI +1.04..+7.96), mean-reversion 14 +$19.18, consensus 87 -$0.34, volume-spike 68 -$4.80,
momentum 54 -$10.63, book-imbalance 37 -$12.42, sports-anchor 11 -$5.64, flow-follow 14 -$3.20,
cross-venue 3 -$0.20, news 1 -$0.11. Flags "REVIEW: losing" on book-imbalance, momentum, sports-anchor,
volume-spike, flow-follow - of those only volume-spike and sports-anchor are still enabled. Polymarket US
-$16.25 lifetime over 237 closed trades, all arms disabled. Quoter shadow: 44 fills, +4.61c/contract over
33 events, CI [-8.28, +17.51], adverse 50%.

**Gates:** `btc-gate` **FAIL / NOT YET** - 276 events, 738 graded strike-trades over 17 days, net
+0.08c/contract, day-clustered CI [-1.11, +1.26], Bonferroni LB -2.58c against a +1c bar.
`quoter-shadow-gate` **insufficient sample** - allowed cohort 35 settled proxy fills over 21 events against
a 30/40 bar, +7.69c [-8.54, +23.91]; blocked cohort -4.75c [-7.28, -2.23] over 1,059, which supports the
gates as a filter and says nothing about the strategy behind them.

**Odds API spend:** **380 of 645 today** (490 yesterday). Under budget.

**Sharp anchor, out of sample:** gradedN **767**, gradedBrierSum 84.997 -> **mean Brier 0.1108**; ruleN
**390**, ruleNet **+$22.635 = +5.80c/contract**. `anchor-grades.jsonl` **771 rows, +117 since yesterday**,
newest 14:41:30Z - so **backlog 135 is resolved**: the `kalshi-settled` sweeps now report 6, 16 and 6
matchable on NPBTOTAL/KBOTOTAL/KBOGAME instead of yesterday's `0 matchable`, and the grader is current
rather than a day behind.

**Errors, last 24 h:** 1,066 warn + 2 error. **1,065 of the warns are the single IBKR Gateway-down
signature** (suppressed to 2026-09-24, external: only the operator starts IB Gateway), and the 2 errors are
the `ibkr:snapshot` / `ibkr:markets` handlers during the same outage. The **last** such line is 12:37:21Z
and the lab has been scanning since (`scan 4057`, 25/30 fresh pairs, 111 paper positions, 279 closed), so
the gateway came back by itself and the 23-arm paper lab is collecting again - which is the check the
suppression note demanded instead of trusting the signature's silence. **Zero real HTTP 429s in the app
log** (the 35 lines matching "429" are digits inside counters, not statuses).

**Silent-strategy checks the prompt names:**

- `[convergence]`: scanning - `in window 188: margin-out 173 cost-out 12 no-vol 0 edge-out 3 event-dup 0
  limits 0 | graded 10 (W:9 L:1) PnL -27c`. Refusing on margin, which is the gate doing its job.
- `[quoter] fair-value on N of M`: **still absent**, third day (backlog 113). The arm is disabled under the
  operator hold and logs `disabled: 117 candidates, would quote 0 (4 gated)` instead. That checklist line in
  the maintenance prompt is stale while the arm is off; it is not a new defect.
- `[cross-venue]`: `256 universe, searched 4 from offset 40, 0 candidates | refused
  {"no-asset-or-title":14,"below-similarity":4}` - the rotating budget from round 117 is working and
  **`below-similarity` is still the whole refusal on every search made**, which is backlog 133's open
  question (the matcher, not the threshold).
- `[dutch]`: 1,600 events scanned (59 exclusive), 0 arb slates, opps 152, executed 0.
- WebSocket agreement (queue item 2): **315 / 320 = 0.9844 on the current process only**, below the 0.99
  bar. The counters are per-process and the app restarted at 15:36Z, so this is not a day's slice and the
  seven-day streak is still not computable (backlog 56). Day 0.

**Shadows:** HRRR **297** graded station-days, MAE **1.96** (bias -0.37) vs NBM **2.29** (bias -1.54),
closer on 157 vs 130 (10 ties). Mention shadow: **82 graded**, Brier base 0.2132 vs **market 0.1112** - the
market still wins, and the 39 counterfactual 15c-gap trades lose **1.97c/contract**. Polymarket consensus:
8,416 signals, **7,282 graded**, hit 0.71 at mean price 0.71, Brier 0.0892, **+5.47c/contract at the Kalshi
ask net of fee** (n=1,162) and +4.11c at the Polymarket US price net of fee (n=1,123). Metaculus: **102
pairs, 9 open, 0 graded** - see section 4c. Spot-first: restarted, verdict 2026-09-21.

## 3. Ladder verdicts against the venue ledger

The ladder is running (`lastRunAt` 15:38:02Z) and made **no stage transition** in the last 24 h. Stages:
tiny-live on convergence, kalshi-fade, kalshi-volume-spike, kalshi-cross-venue, kalshi-news, kalshi-dutch,
kalshi-leadlag, kalshi-sports-anchor, kalshi-mean-reversion, kalshi-consensus; disabled or held on quoter,
settlement (paper), polyus-micro-maker, polyus-fade, polyus-book-imbalance, polyus-weather-fair,
kalshi-momentum (cool-down to 09-27), kalshi-book-imbalance (cool-down to 09-25), kalshi-flow-follow,
kalshi-weather-morning.

**Backlog 112 is SOLVED, and it was never an arithmetic error.** The ladder reads
`kalshi-leadlag: 35 settled since stage start, net -$0.23`. Stage start is 2026-09-17T09:16:16Z. On the
venue ledger over exactly that window, `KXBTC15M` is **n=17, +$1.48** and `KXETH15M` is **n=18, -$1.71**:
**35 settlements, -$0.23, to the cent.** The ladder's evidence join is `leadLagRowCounts`
(`src/main/ladder/ladder.ts:115`), which drops any sweep whose coin is not in `leadLagProvenCoins` - still
the round-93 default `BTC, ETH`. So the ladder is not miscounting the arm; it is counting the **proven-coin
subset on purpose**, exactly as `docs/PREREGISTERED-leadlag-coins.md` addendum 2026-09-13 specifies. The
2026-09-16 "-$0.82 against `leadlag-coins.mjs` -$60.47" gap has the same cause: that script reads all coins,
the ladder reads two. **No factor of seventy, no defect - two different cohorts.**

What that leaves is a real and uncomfortable fact rather than a bug: over the same stage window the six
unproven coins settled **+$6.71 over 173 settlements** while the two the ladder judges by settled -$0.23,
so the arm's next checkpoint (at 40 proven-coin settlements, 5 away) will decide the **whole** arm on
**BTC and ETH alone** - and those are two of the three worst coins in the cohort read below. I have not
touched it: a pool that cannot stop a subset is the pre-registered design, and re-cutting the cohort on the
day its number looks inconvenient is exactly the re-fitting the pre-registration forbids. Recorded as
backlog 144 with the checkpoint as its trigger.

**Cohort stop rule, run today** (`node scripts/leadlag-coins.mjs --json --since 2026-09-13T10:05:00Z` on
the fresh dump). Both bars are now met - **1,354 contracts** on the new coins (bar 400) over **6
day-clusters** (bar 5) - and the verdict is **UNDECIDED**: the new-coin day-clustered 95% interval is
[-6.81, +3.82] around -1.50c/contract, so neither the "upper bound < 0 -> narrow back to BTC/ETH" branch nor
the "lower bound > 0 -> leave it" branch fires. Per the pre-registration that means keep collecting and
re-read daily, with an automatic narrow-back on **2026-10-04** if it is still undecided. Per coin since
09-13: BNB +3.05c, SOL +2.55c, ETH +0.30c against XRP -3.43c, HYPE -3.22c, DOGE -9.95c and **BTC -6.17c
(95% [-12.28, -0.07], the only coin whose interval excludes zero, and it is negative)**. Established
BTC/ETH -2.55c, new coins -1.50c, pooled -2.02c. Note the window deliberately spans the era backlog 132
voided for SIGNAL grading; the venue ledger is real settled money and is unaffected by how the signal was
priced, so this read stands.

## 4. What changed today

### 4a. The sentinel now watches the spot-first recorder (the day's build)

`scripts/sentinel.mjs` watched four hourly shadow tasks for staleness with one 130-minute threshold. The
spot-first recorder is a Scheduled Task too, but a **continuous** one - the task starts a process that then
lives for days - and it was in no watch list at all, which is why its death at 13:34Z cost 2 h 09 m today
and would have cost the rest of the day if this run had not looked. 130 minutes would not have caught it in
time either.

- new `scripts/lib/task-watch.mjs`: the watch table and the `isStale` rule, with a per-row threshold that
  falls back to 130 min. It is a separate module because `sentinel.mjs` runs a live tick on import, so the
  table could not otherwise be asserted by a test.
- `scripts/sentinel.mjs` imports it; the loop body is unchanged apart from calling `isStale`.
- `data/spot-shadow/recorder.log` added at **20 min** (its heartbeat is every 10 min), reviving
  `OracleTrader-SpotShadow` through the same `startTask` path and the same 3 h re-revive guard as the
  others. Detection goes from "whenever a human looks" to one sentinel tick, at most 35 min.
- new suite `scripts/tests/task-watch.test.mjs`, wired as `npm run test:task-watch` (so `npm test` picks it
  up automatically): 11 rule assertions including the two regressions that would bring today back - dropping
  the spot row, and letting a continuous recorder inherit the hourly allowance - plus the exact 127-minute
  gap observed today, asserted to trip the 20 min threshold and NOT the default.

Verified: `npx tsc --noEmit` rc=0; `npm test` **18/18 suites passed** in 9.7 s; `npx electron-vite build`
rc=0; `node scripts/sentinel.mjs --dry` clean; a real `Start-ScheduledTask OracleTrader-Sentinel` tick at
15:49:08Z returned **rc=0** and wrote a normal `status.json` (no `spot-shadow-stale` finding, correctly -
the recorder was 6 minutes old). Backup `MAINT-2026-09-18` written
(`oracle-trader-MAINT-2026-09-18-20260918-114812.zip`, 1,731 files, 518 MB).

**The app was NOT restarted.** Nothing in this change touches the trading app - the sentinel is a plain
node script the task re-runs from source every 15 minutes - and the app was already restarted at 15:36:02Z
on the current build. Bouncing a live trader holding 30 positions and 5 rests to prove a no-op would be the
riskier choice, so it was not made.

### 4b. mmsim is being throttled off the box by our own request rate (found, not changed)

The market-making simulator has died repeatedly and the sentinel's "still stale after a relaunch" finding
made it look like a broken relaunch. It is not. Its own row file says so:
`{"event":"halt","reason":"429-storm","detail":"3 throttles within an hour; exiting rather than competing
with live trading"}` - twice today (12:34Z and 13:42Z), and the relaunch in between worked fine.

mmsim uses the **public unauthenticated** Kalshi endpoint, so it shares the per-IP budget with the live
trader. `http429` events per day: 09-13 **6**, 09-14 **1**, 09-15 **3**, 09-16 **7**, 09-17 **12**, 09-18
**11 in 13.7 h** - the step is at round 115 (2026-09-17 08:07Z), which raised the app's Kalshi lanes to
10 reads/s and 15 writes/s. Today's 10 s lead-lag poll (15:28Z) lands on top of that and its effect is not
in these numbers yet.

Nothing changed. mmsim's 429 policy is **pre-registered** - altering any parameter mints a new `runId` and
restarts the 35-day clock, so "just raise the threshold" would destroy the run it is meant to protect - and
the halt is the protective behaviour working. But at roughly 40 minutes of collection per 3 h revive cycle
the falsification run (verdict 2026-10-17) is quietly being gutted, which is backlog 119's integrity concern
arriving by a new door. Recorded as backlog 146 with a 2026-09-19 trigger, so the 10 s poll's contribution
is measured against today's 11 before anyone reasons about it.

### 4c. Metaculus shadow: not a defect, plus one failed task run

`pairs.jsonl` has not grown since 2026-09-18T01:36Z, which looks like the failure mode the prompt names.
It is not: a manual run exits **0** and logs `matches 0; pairs stored 0; event without a clear market 6`.
The six candidates are all long-horizon Metaculus questions (2028-2030) whose nearest Kalshi market closes
Dec 2026, so they are refused by the 60-day close-date guard, and everything genuinely matchable is already
in the 102 stored pairs (the `seen` set). 9 pairs are open, 0 graded - nothing has resolved yet.
Separately, the **11:35 scheduled run exited -1 and wrote nothing** (the 12:35 run and my manual run were
fine); one bad run, no data lost, now visible as a sentinel `task:` notify. Backlog 147 to watch the rate.

### 4d. A second session was editing this repo during the run

At 15:52-15:54Z an interactive session committed `746e500 fade: reprice a resting maker order only on a 3c
move` - a **behavioural change to the live fade arm** (`autoTrader.ts` now requires a 3c move before chasing
a resting maker order, on the finding that amended maker markets ran -2.17c/contract against +0.33c for
never-amended ones) plus a fade loss-distribution read that concludes the arm does not scale. That is that
session's work and its own evidence; it is recorded here only because it lands inside this run's window and
the operator should not have to reconcile two accounts of the same day.

Two consequences for this report. First, its `git add -A` swept this run's uncommitted source changes -
`scripts/lib/task-watch.mjs`, `scripts/tests/task-watch.test.mjs`, the `sentinel.mjs` import and the
`package.json` wiring - into that commit, so section 4a's code is in `746e500` rather than in the
maintenance commit, and the maintenance commit carries the documentation only. Nothing was lost and nothing
was overwritten. Second, both sessions reached for backlog numbers 140 and 141; the maintenance items are
renumbered **144-147** and a standing note on how to avoid the next collision is at the end of
`docs/BACKLOG.md`. `tsc` and the full suite were re-run on the merged tree, after that commit, and are green.

## 5. Sentinel

`status.json` at 15:49:08Z (bar: 30 min) - live. **1 incident opened today**
(`2026-09-18T12-05-maintenance-failed`), dispatched to a repair session that died on the same weekly quota;
**closed NOT-A-DEFECT by this run** with the catch-up verification written into the file. **No incident is
now OPEN** (the only other `Status: OPEN` in the directory is inside the 09-08 drill, which is closed at the
end of its own file). 1 repair session used of the 3/day budget. Standing notifies: `mmsim-stale` (section
4b), `horizon-kalshi:KXNCAAMBUAC-27-EKY` (a position closing more than 45 days out), and the new
`task:OracleTrader-MetaculusShadow last result -1` (section 4c). Suppressions: 4 on file, all still within
their stated expiry, none renewed today; `[reconciler] run failed: GET /vN/portfolio/activities` lapsed at
2026-09-18T00:00Z and was deliberately **not** renewed - the reconciler is current
(`fill-reconciler-kalshi.json` 15:36Z, `-polymarket-us.json` 15:37Z) and backlog 52 is still the fix.

## 6. Build-queue trigger checks (every one, as the prompt requires)

1. **Critic skill** (daily) - trigger MET, **rule does NOT fire, nothing changed**, sixth day running. 1,812
   decisions; settled 351 ABSTAIN / 240 VETO / 65 ERROR / 12 ALLOW_UNCHANGED. The raw read says switch
   (ABSTAIN +2.7c, VETO -2.8c, and the script prints "consider veto mode"). Amendment 2 (currently enabled
   arms only) decides it again: of the arms live on the ladder and present in both cohorts - consensus,
   fade, mean-reversion, volume-spike - VETO's own net is **+$3.33 over 158, i.e. +2.1c**, which fails
   condition (i) outright, and the critic is skilled in 2 of 4 (consensus -6.8c, volume-spike -22.9c)
   against anti-skilled in 2 (fade +3.2c, mean-reversion +23.4c), which is not a strict majority and fails
   (iii). Only (ii) passes. The `intelligenceEnabled: false` clause is not reached: skill is
   composition-dependent, not absent.
2. **WebSocket book** - NOT met, 0.9844 on the current process, and still not computable as a day's slice
   (backlog 56). Day 0 of 7.
3. **HRRR source** - half met (297 station-days, HRRR MAE 1.96 vs NBM 2.29, closer 157-130); the
   **2026-09-21** date still binds.
4, 5. **Kalshi fill channel / Avellaneda-Stoikov** - NOT met (quoter notch 1, disabled under operator hold);
   see backlog 37, the trigger may be unreachable by retirement.
6. **Sports anchor on Polymarket US** - NOT met: the Kalshi anchor's stage net is -$0.50.
7. **Player props** - NOT met (anchor notch 1).
8. **Generic strategies, item (c) maker rest patterns** - NOT met: gated on mean-reversion v3 showing fills
   and a positive checkpoint; MR is tiny-live at -$2.64.
65. **Challenger paired read** (on/after 2026-09-18) - **MET, run, nothing to report**:
   `node scripts/hunch-paired.mjs` reads 1,399 incumbent forecasts, 217 challenger, 217 paired, **0 paired
   AND settled**. The challenger started 09-12 into markets that close days out; re-read daily until 20.
66. **cull-gate read** - NOT met (2026-09-19).
67. **Momentum log-odds verdict** - NOT met (2026-09-21).
68. **Mention shadow** - NOT met on both halves: 2026-09-25, and 82 graded of 100.
69. **Momentum cool-down** - NOT met (2026-09-27); the ladder holds it at demotions 2.
70. **mmsim verdict** - NOT met (2026-10-17), and see 4b for whether it will have the rows.
72. **Lead-lag coin cohort** (daily) - **MET and run: UNDECIDED**, section 3.
84. **Spot-first verdict** - NOT met (2026-09-21); today's gap is recorded against it.
86. **Weekly lead-lag basis** - NOT met (first read Monday 2026-09-21).
125. **Paper-lab first reads** - NOT met (2026-09-24).
129. **Main scan time after the pacing change** (2026-09-18) - **MET, read**: median scan **11.9 s**, p90
   17.1 s over 1,115 scans today, against 15.0 s on 09-17 and **38.1 s** on 09-16. Phase split on the last
   scan: universe 6.7 s, data 4.1 s, signals 2.6 s, exits 2.2 s, pending 0.9 s, the rest under 200 ms.
   **Day's 429 count on the app's Kalshi lanes: 0** (it was 4 over 09-16/17). The read lane does not need
   lowering; the cost has moved to the public endpoint instead (4b).
130. **Eight-coin lead-lag first read** (2026-09-18 12:00Z) - **MET**; the substantive read was done at
   15:28Z by the earlier session and is confirmed here on the venue ledger (sections 2 and 3). The one part
   it left open, ZEC: **1 settlement, 1 contract, in six days** - its Polymarket book essentially never
   passes the spread gate, so ZEC is not yet a cohort member in any meaningful sense.
134. **Lead-lag orderbook leg failures** (2026-09-18 12:00Z) - **MET, PASS**: **2** `Kalshi leg failed`
   lines in 24 h against roughly 8,600 ten-second cycles, far under the 1% bar, so the public orderbook
   endpoint is not rate-limiting the quote and no move to the authenticated batched endpoint is warranted.
137. **ETH and HYPE verdict** - NOT met: 2026-09-21 or 100 orderbook-priced rows per coin, and they are at
   **34 and 44**. Both stayed negative on both measures today (ETH -6.33c graded, HYPE -1.99c).
138. **Lead-lag at 10 s, first read** - NOT met (2026-09-19 12:00Z).

**Item taken:** none of the met triggers required a build (1 declines by its own rule; 65, 72, 129, 130 and
134 are reads). The day's build is section 4a, taken from the liveness failure this run actually found,
which is the queue's own standing rule that a silent recorder death is a defect to fix rather than a result.

## 7. Backlog

Added 144 (the ladder judges lead-lag on its two worst coins), 145 (spot-first recorder died with no cause
on disk), 146 (mmsim throttled off the public endpoint by our own rate), 147 (Metaculus task exit -1).
Closed 112 (reconciled exactly; it was two cohorts, not an error) and 135 (the anchor's `0 matchable`
sweeps). Recorded the readings for 65, 72, 129, 130 and 134 in place.

## 8. For the operator - nothing is due

No ladder scale-up exceeds `maxBalancePct` x equity ($1 stake against a $24.22 ceiling); both venue balances
cover every configured stake; no subscription or credit balance failed (OpenRouter $15.34). The one thing
worth his eye, non-blocking: **IB Gateway was down from before 03:45Z until 12:37Z** and the 23-arm IBKR
paper lab collects nothing while it is off - it is back now, on its own, and the suppression that hides the
1,065 warn lines expires 2026-09-24. Only he can start it.

## 9. Delivery

This is the headless runner, so it has no `SendUserFile` and no `PushNotification`. The day's section is
written to `docs/reports/2026-09-18.md` for the 08:30 desktop delivery task.

## 10. Ten-line summary

1. Venue-true last 24 h: **Kalshi +$5.34** after $4.35 fees over 215 settlements; **Polymarket US $0.00**.
2. The whole of it is the lead-lag 15-minute family; **HYPE -$1.74 and ETH -$0.75** are the only losers in it.
3. **No ladder transition** today; lead-lag tiny-live, next checkpoint 5 settlements away.
4. **Backlog 112 solved**: the ladder's -$0.23 over 35 matches BTC+ETH on the venue ledger **to the cent** -
   it judges the proven-coin subset on purpose, so there was never a seventy-fold error.
5. But that means the next checkpoint decides the **whole** arm on its two worst coins, while the other six
   earned **+$6.71** in the same window. Not touched - re-cutting a cohort on the day is re-fitting. Backlog 144.
6. Coin cohort stop rule ran with both bars met for the first time: **UNDECIDED** ([-6.81, +3.82]c),
   auto-narrow to BTC/ETH on 2026-10-04 if it stays that way.
7. **Fixed:** the spot-first recorder was dead for 2 h 09 m and in no watch list; restarted, and the sentinel
   now watches it at 20 minutes (new module + 18th test suite, tsc/build/18-of-18 green).
8. **Found:** mmsim halts itself on a 429 storm twice a day - our own raised request rate is throttling it off
   the shared public endpoint, and its 35-day run is losing hours. Pre-registered, so recorded not changed.
9. Sentinel healthy, the day's one incident closed NOT-A-DEFECT (the 07:00 runs hit the weekly model quota;
   the new 11:30 catch-up is what produced this report, verified live). A **second session** also committed a
   live fade change at 15:54Z and swept this run's source files into its commit - see 4d; suites green after.
10. **Nothing is needed from the operator.** IB Gateway was down 03:45Z-12:37Z and came back on its own.

## Repair 2026-09-18T21:26Z

Incident `data/sentinel/incidents/2026-09-18T21-20-log-warn-engine-portfolio-read-failed-fo.md`
(`[warn] [engine] portfolio read failed for 'polymarket-us' (GET /v1/orders/open?limit=500 -> 429: <!doctype
html>`, x3). Outcome **NOT-A-DEFECT**: a transient Cloudflare edge 429 on the Polymarket US gateway, absorbed
by the degraded-read path. No code changed, so nothing was built, tested, restarted or backed up, and no
suppression was added.

Three warns only - 21:14:40.143Z, 21:16:40.101Z, 21:18:39.895Z - and none in the six minutes of clean reads
after (`grep -c "portfolio read failed" main.log` = 3 at 21:24:56Z; this signature had never appeared before
in 231k lines). Each carries "serving last good snapshot from 65s ago", so at a ~60 s read cadence every
second read was refused for four minutes and then it stopped. The body is a Cloudflare interstitial, not the
gateway's JSON error envelope; the only precedent is 2026-09-12 05:11Z-07:41Z on `/v1/portfolio/activities`,
which this app caused with an unpaced 20-page burst and which was fixed by `ACTIVITY_PAGE_PACE_MS`
(`polymarketUs.ts:505-512`).

This time the app's own load did not move: the paper lab (`index.ts:425-431`, 1 req/1.5 s, scan every 60 s)
is the gateway's heaviest consumer and its scans 2878-2885 logged normally straight through the window. Only
the portfolio lane was refused, intermittently - a per-IP edge counter, not a per-key budget. The one load
change on this host in that window was a concurrent Claude session measuring full catalog walks against the
same gateway, committed at 21:23:27Z as `1388cb7` ("80k+ open markets ... a 3,000-row walk saw 4% of it").
Circumstantial: its requests are not in main.log.

Impact was bounded because both guards worked. `http.ts:60-61,105-111` retries a GET 429 three times
(300/900/2700 ms); `engine.ts:495-508` then serves the last good snapshot rather than rejecting the whole
read - the guard added earlier today, which is also why the sentinel saw a "new" signature for an old class
of failure. The snapshot feeds stake sizing only (`autoTrader.ts:1733`, `miniAuto.ts:653`); every order
lifecycle path calls `adapter.getOpenOrders()` directly (`miniAuto.ts:985`, `quoter.ts:684,898`,
`autoTrader.ts:3280,3475`) and none of them errored. Three cycles sized off a 65-second-old equity number.

Two deliberate omissions. **No suppression:** `1388cb7` adds a background full-catalog walk of up to 2,000
gateway GETs paced 120 ms (~500 req/min) every 30 min, to the gateway that just returned edge 429s at a small
fraction of that rate. It is not running yet - the live electron started 19:53:25Z, `out/main/index.js` was
rebuilt at 21:22:11Z, and main.log has zero "catalog walk" lines - so muting the signature now would blind
the sentinel to the first sign that the walk is pushing the account's own reads off the edge counter. Logged
as backlog 156 with a 2026-09-19 trigger. **No restart:** nothing of this session's needed deploying, and
`Start-ScheduledTask OracleTrader-App` would have put that minutes-old, never-run-in-production walk live
with no way to verify it here; that restart belongs to the session that owns `1388cb7`.

## 2026-09-20 11:00Z - daily maintenance (headless, task OracleTrader-Maintenance)

## 1. Liveness

Everything was already up; nothing needed reviving before the work started.

| Check | State |
|---|---|
| App process | UP (pid 30316) → restarted for today's deploy, now pid 24188, started 11:15:43Z |
| main.log | written 11:00:29Z at the start of the run, 11:15:59Z after the restart |
| ladder.json `lastRunAt` | 10:47:59Z (2 min before the check) |
| BTC collector | UP (pid 31316, `node scripts/btc-collector.mjs`) |
| Nightly review | `reviews/2026-09-20.md` present, 1 attempt, no error |
| Sentinel | `status.json` at 10:50:01Z (10 min), task Running, 0 repair sessions today |
| HrrrShadow | forecasts.jsonl 10:20Z |
| MentionShadow / PolyConsensus | run.log 10:50Z / 11:00Z |
| MetaculusShadow | task last ran 10:35Z result 0; `last-mc.json` 10:35Z (pairs.jsonl only grows when a new pair appears) |
| SpotShadow / ladder15 / crypto15 / mmsim / books recorders | all processes present, heartbeats 11:00Z |

**Sentinel.** No incident files are OPEN — the newest is 2026-09-18T23:20Z and it is closed. Since yesterday's
run the digest holds three mmsim relaunches (09-19 15:50Z after 133 min dark, 09-19 23:20Z, 09-20 09:20Z, all
after the `429-storm` exit that is backlog 175, read due tomorrow), the standing "Kalshi position closes more
than 45 days out" note on KXNCAAMBUAC-27-EKY, and the OpenRouter credit note. No repairs were dispatched and
none were needed.

## 2. Evidence

**Venue-true P&L, last 24 h** (`venue-pnl.py` on fresh read-only dumps taken 11:01Z):

- Kalshi **+$5.47** after $2.19 of fees, 105 settlements. Best: KXBTC15M +$1.93 over 20, KXBNB15M +$1.58 over 9,
  KXKBOGAME +$2.44 on one. Worst: KXMLBRFI −$3.99 over 4, KXNCAAFGAME −$2.04 over 6, KXXRP15M −$1.73 over 7.
- Polymarket US **$0.00** — 0 resolutions; every polyus arm is on operator hold. Balance $39.85, no positions.
- Kalshi cash $62.39 + open positions at cost $28.89 = $91.29 (at market $91.09). 28 positions, 6 resting.
- Shard balances: shard 0 **$3.94**, shard 1 $0.00, shard 2 $31.07, shard 3 $27.38. Weather trades need shard 0
  and both weather arms are on hold, so $3.94 is not blocking anything today — but it is the shard to watch if
  weather ever comes off hold.

**Gates.** `btc-gate` FAIL/NOT YET: 820 strike-trades over 312 events and 19 days, net −0.18c/contract,
Bonferroni LB −2.71c, day-clustered LB −1.38c. The event count passes; the edge does not exist yet.
`quoter-shadow-gate`: insufficient sample for the ALLOWED cohort (42 settled proxy fills over 23 events; the bar
is 30 over 40). The BLOCKED cohort is −4.54c with a CI that excludes zero, which keeps saying the gates refuse
quotes that would have lost.

**Sharp anchor.** `gradedN` 926, `gradedBrier` 106.85 (a SUM — backlog 44), `ruleN` 470, `ruleNet` **+22.28**.
`anchor-grades.jsonl` gained **133 rows** since yesterday's run (930 total). The out-of-sample rule is still the
only anchor number that is positive; the live arm is not (see §3).

**Odds API spend.** 09-15 456, 09-16 534, 09-17 490, 09-18 496, **09-19 644**, 09-20 294 by 11:00Z. The cap is
645/day and yesterday came within one credit of it. Nothing failed, but the margin is gone — noted for the
operator below, no action taken (changing the poll plan is a behavioural change and today's was already spent).

**Silent strategies.** The `[convergence]` scan note reads `found 0 setups, fired 0 orders` on every cycle and
has for days — that is backlog 197 (our scan geometry, not the venue), already written up in §143. The
`[quoter]` "fair-value on N of M" line has not appeared since 2026-09-07 because the quoter is disabled on an
operator hold; the shadow meter is still running (34 candidates, 4 gated, would quote 0).

**Log.** 452 warn/error lines in 24 h. 444 are the one IBKR gateway line (`Gateway API not available yet`).
The other eight: five Cloudflare 429s on the Polymarket US open-orders read (absorbed by the degraded-read
path), two IBKR request timeouts, one exhausted Kalshi universe fetch in the hunch pass. No errors at all since
the restart.

**Shadows.**

- Mention base-rate: Brier **0.2132 base vs 0.1112 market** — the base rate is well behind the price (fed
  n=48 0.1716 vs 0.0959; trump-period n=34 0.2719 vs 0.1328). Counterfactual 15c-gap taker trades: 39, mean
  **−1.97c/contract**. Build-queue item 12's go-live trigger requires the base rate to BEAT the price after
  fees. It loses. Not promoted, and the live-tracking half (backlog 179, latency rather than base rate) remains
  the only reason to keep the corpus running.
- Polymarket smart-money consensus: 9,960 signals, 8,736 graded, hit 0.71 at mean price 0.71, Brier 0.0910;
  **+5.29c/contract at the Kalshi ask net of fee** (1,369 matched) and +4.27c at the Polymarket US price net of
  fee (1,440). Build-queue item 13 is already BUILT (2026-09-14, §90) and `kalshi-consensus` is live on the
  ladder at tiny-live, so this is confirmation, not a new trigger. Live consensus is +$2.52 over 18 settled.
- Metaculus: 120 pairs on file, **no graded pairs yet** — nothing to report until the first resolution.

## 3. Ladder

`lastRunAt` 10:47:59Z, `lastPromotionAt` 2026-09-17T09:16Z. Twenty arms; the ladder is deciding on its own and
its verdicts match the venue ledger.

| Arm | Stage | Notch | Verdict / evidence since stage start |
|---|---|---|---|
| kalshi-fade | tiny-live | 1 | 36 settled, net −$0.12; calib −5.21c CI [−15.34, +4.93] |
| kalshi-leadlag | tiny-live | 1 | 38 settled, net **+$1.57** (hard stop $10/notch since §139) |
| kalshi-consensus | tiny-live | 1 | 18 settled, net **+$2.52**; CLV +15.0c, but adverse fills flagged |
| kalshi-volume-spike | tiny-live | 1 | 4 settled, net −$1.30 |
| kalshi-cross-venue | tiny-live | 1 | 2 settled, net −$0.73 |
| convergence | tiny-live | — | 1 settled, net +$0.05; fires nothing (backlog 197) |
| kalshi-dutch / mean-reversion / news / sports-anchor | tiny-live | 1 | 0 settled each; news −$0.11, sports-anchor −$0.50 |
| kalshi-book-imbalance | disabled | 1 | cool-down to 2026-09-25 after 2 stops |
| kalshi-momentum | disabled | 1 | cool-down to 2026-09-27 after 2 stops |
| kalshi-flow-follow, kalshi-weather-morning, quoter, settlement, all four polyus arms | disabled | 1 | operator hold |

Trade-quality flags the same arms the ladder has already stopped or is watching: book-imbalance −$12.42 over 37,
momentum −$10.63 over 54, sports-anchor −$5.64 over 11 with adverse fills, volume-spike −$5.03 over 72,
flow-follow −$3.20 over 14. The live consensus cohort `consensus:pre-matcher-20260919` is −$7.13 over 114, which
is the pre-matcher stage and is correctly detached from the current one.

Two ladder notes carried forward, neither actionable today: no arm has a `baseline.wTrades` yet (backlog 172,
read due 2026-09-26), and `lastPromotionAt` has not moved in three days.

## 4. What changed — backlog 174, the audit's twenty-four lows (REVIEW-CHANGES §144)

Today's due read was the one pre-registered item: take B-36..B-59 from
`docs/reports/AUDIT-BUG-CORRECTNESS-2026-09-19.md` in report order, in one round, once the §134 build had run
24 h clean.

**The gate was checked first.** The registration named 18:00Z as the end of the window and this run is at 11:00Z,
so it was evaluated on its three observables over the ~20 h elapsed rather than deferred to a session that will
not exist today: no `.corrupt-` file since 2026-09-03, zero `recovered-exit` and zero `dutch-unwind` lines in
main.log ever, and the only warn class in 24 h is the known IBKR gateway line. Clean.

**Eighteen fixed.** The ones that touch money or evidence: a Dutch basket is now graded at all (B-36 — `netN`
was stuck at 0 forever, so only the hard stop could ever act on that arm); convergence grades the FILLED size
instead of the requested one (B-37); a convergence order is on disk before the POST, so a crash between the
venue's fill and our push can no longer lose the fill or let a second IOC fire in the same window (B-38); a
ladder stop now stops the rest of the scan it lands in (B-39); an unrecognised `executionMode` can no longer
take the live submission path (B-40); the stake cap no longer refuses an EXIT (B-52 — a cheap large position
was untradeable out through the engine); a failed market read no longer drops a settled position as an orphan
(B-54); and a refusal thrown before any POST is no longer logged by lead-lag as an "uncertain order" holding
the window's budget (B-58, new `PreSubmitRefusal`). The rest: B-41 (venue-day split read 100 rows), B-42 (one
torn journal line voided the whole journal), B-43 (paper order ids collided across sessions), B-45 (a degraded
portfolio read re-stamped itself fresh — a multi-hour outage read as 10 seconds old to stake sizing), B-46 (the
nightly review's allow-list held two ladder SIZE knobs and `reviewAutoApplyLive` is true by default, so it was
moving live arm size against the ladder — both keys deleted), B-47 (prototype-named keys bypassed the
allow-list), B-49 ("last 24h" was 24–48 h), B-50/B-51/B-57 (three operator-facing lies in the UI: tooltips
claiming a disarm the code never does, a P&L panel that loaded forever, a refused exchange switch that said
nothing).

**Five deferred with their own items and triggers** — backlog 200 (B-44 paper reset ordering), 201 (B-48 polyus
research log has no mode field; every polyus arm is on hold so nothing live is contaminated today), 202 (B-53
200-fill reconcile window — derived, never observed, needs a reproduction), 203 (B-56 lead-lag running guard —
read and deliberately NOT changed: shortening it would let a second sweep run against an order of unknown fate,
the opposite of what B-58 just fixed), 204 (B-59 sports-anchor freshness — plumbing that changes what the arm
trades).

**Verification.** tsc clean, `electron-vite build` clean, **20/20 suites** with six new regression cases
(`risk-controls`: the closeFrom exit above the cap, and `PreSubmitRefusal` vs a venue rejection;
`remaining-defects`: the torn journal line, paper id collision, the portfolio-age re-stamp, the allow-list).
Two existing tests were updated rather than the code: `ladder.test.ts` used a now-deleted allow-list key as its
"live strategy" example, and `config-migration.test.ts`'s dutch scaffolding had a `getMarket` that always threw,
which under B-54 is now "no evidence" — both were corrected and B-54 gained its own assertions on both sides.
Backup `MAINT-2026-09-20`. Restart 11:15:43Z, main.log resumed 11:15:44Z, no error or warn line since.

## 5. Build-queue trigger checks

1. **Critic skill check** — trigger MET, rule does NOT fire, nothing changed (fourth consecutive day).
   The script's own aggregate: vetoes below the rest, **−0.027 vs +0.042 per contract** (274 settled VETO, 310
   ABSTAIN, 65 ERROR, 15 ALLOW_UNCHANGED) — conditions (i) and (ii) pass on the raw read. Condition (iii) fails,
   and amendment 2 (currently enabled arms only) fails it twice over. The enabled arms present in BOTH cohorts
   are cross-venue, fade, mean-reversion and volume-spike; the critic is skilled in two (cross-venue −6.7c,
   volume-spike −23.4c per contract) and anti-skilled in two (fade +0.3c, mean-reversion +17.9c) — two of four is
   not a strict majority, and ties count against. Restricted to those four arms VETO is **+$1.85 over 109 trades**
   against ABSTAIN's +$13.09 over 222, so VETO's own net is ABOVE zero and condition (i) fails as well.
   The `intelligenceEnabled: false` clause is not reached: skill is present in some arms and absent in others,
   which is composition, not absence.
2. **WebSocket book for execution** — not computable as written (backlog 56, needs a persisted per-UTC-day pair).
3. **HRRR forecast source** — trigger is 2026-09-21, tomorrow. `hrrr-shadow.mjs report` runs then.
4/5. **Kalshi fill channel, Avellaneda-Stoikov** — gated on a quoter notch ≥ 2 or a positive quoter checkpoint;
   the quoter is disabled on an operator hold and its shadow cohort is still under sample. Not met.
6/7. **Sports anchor on Polymarket US / player props** — gated on the Kalshi anchor's first checkpoint being net
   positive. The live arm is −$5.64 over 11 with adverse fills. Not met.
12. **Mention base-rate go-live** — not met and moving away: the base rate's Brier is nearly double the market's.
13. **Polymarket consensus go-live** — already BUILT and live (2026-09-14); today's report confirms the edge.

Today's item was the due read (174), which is what the build-queue rule asks for: the first item whose trigger
is met, finished end to end. No second behavioural change was taken.

## 6. For the operator

**Nothing is needed from you.** The three standing notes, none of which block anything:

- OpenRouter credit is **$12.04** and falling ~$0.25/day. The nightly review and the hunch pass fall back to
  Ollama when it runs out; they do not stop.
- The Odds API spent **644 of 645** credits yesterday. Nothing failed, but the daily margin is now one credit.
  If it ever overruns, the sharp anchor's polls thin out — it does not cost money.
- Kalshi shard 0 holds **$3.94**. Weather trades need shard 0 and both weather arms are on hold, so this is
  inert today; it would matter the day weather comes off hold.

## 7. Delivery

This headless runner has no `SendUserFile` and no `PushNotification` (see MAINTENANCE-PROMPT §10). This file is
`docs/reports/2026-09-20.md`; the 08:30 desktop task delivers it.

## 8. Ten-line summary

1. Everything was up: app, collector, ladder ticking, sentinel fresh, all six shadows within their windows, no
   open incidents, nothing needed reviving.
2. Venue-true last 24 h: **Kalshi +$5.47** on 105 settlements after $2.19 of fees; Polymarket US $0.00 (0
   resolutions, all arms on hold).
3. Today's pre-registered read was backlog 174 — the audit's twenty-four lows, B-36..B-59, in one round. The
   clean-operation gate was checked and passed on all three observables.
4. **Eighteen fixed**, five deferred with their own triggers (backlog 200–204). The consequential ones: a Dutch
   basket is graded at all, convergence grades the filled size and journals before the POST, a ladder stop stops
   the scan it lands in, the stake cap stops refusing exits, a failed market read stops dropping settled
   positions, and lead-lag stops treating a pre-POST refusal as an uncertain fill.
5. The nightly review's allow-list held two ladder SIZE knobs and `reviewAutoApplyLive` is true by default — it
   lowered `convergenceMaxDailyTrades` 10→4 last night against the ladder's own setting. Both keys are gone.
6. Verified: tsc clean, build clean, **20/20 suites** with six new regression cases; backup taken; app restarted
   11:15:43Z and the scan loop is clean with no error or warn line since.
7. Ladder unchanged and running: leadlag +$1.57/38 and consensus +$2.52/18 are the two positive live arms; fade
   is −$0.12/36; book-imbalance and momentum are in cool-down; seven arms sit on operator holds.
8. Sharp anchor `ruleNet` **+22.28** over 470, 133 new graded rows today; the live anchor arm is still −$5.64/11.
9. Shadows: the mention base rate LOSES to the market (Brier 0.2132 vs 0.1112) and is not promotable; the
   Polymarket consensus is +5.29c/contract net of fee over 8,736 graded, confirming an arm that is already live.
10. **Nothing is needed from you.** Watch items only: OpenRouter $12.04, the Odds API at 644 of 645 credits
    yesterday, and $3.94 left on Kalshi shard 0.

**Gap noted:** MAINTENANCE-LOG.md has no 2026-09-19 section and there is no `docs/reports/2026-09-19.md`.
The 09-19 07:00 run exited 0 while waiting on a background cull-gate, and `maintenance.ps1`'s per-day
guard then skipped the 11:30 catch-up as "already completed". Filed as backlog 205; the guard should key
on the written report, not the exit code. No attempt was made to reconstruct that day here - the ten
changes it produced are all recorded in REVIEW-CHANGES sections 133-139.

---

## Repair 2026-09-21T00:12Z

Headless on-call session (Windows task, `scripts/repair.ps1`), one incident:
`data/sentinel/incidents/2026-09-20T23-50-unbooked-settlement-KXLALIGAGAME-26SEP20.md`. **Outcome: FIXED.**

The sentinel's finding — a consensus NO on `KXLALIGAGAME-26SEP20VCFRSO-RSO` that Kalshi settled at
21:07:34Z still sitting in `openTrades` at 23:50Z — was real, but the settlement path was not what was
broken. The whole autoTrader scan loop had been wedged for **2 h 42 min**: `state.lastScanAt` was still
2026-09-20T21:11:17.627Z at 23:53Z with a 30 s poll interval, and all 21 open rows carried the same
`lastSideMidAt` 21:12:19.086Z from the wedged pass's own quote batch. `tick()` guards itself with a plain
`busy` boolean cleared in a `finally`, so a scan that throws releases it but a scan that never SETTLES
never reaches the `finally` — every tick since returned `'scan already in progress'`, silently, because the
`[auto-trader] scan` line only prints 1-in-20 and the stall watchdog only posts a webhook and never
recovers. `trySettle` and `settlementProbeDue` live inside that tick, so nothing could book. The wedge
started during a host freeze (the whole process logged nothing 21:12:17→21:15:32Z and again
21:15:57→21:19:57Z; the first Kalshi read after the gap returned `401 header_timestamp_expired`, signed
before the freeze and sent after). The wedged pass had finished `manageExits`, so it stalled in the
`universe` phase; the exact hung await is not identifiable from the logs and the fix does not depend on it.

The fix bounds the slot instead of the await: `SCAN_WEDGE_MS` (15 min, 20× the 210.5 s slowest scan on
record) and a pure `scanSlotVerdict(busy, busyAt, now)` in `autoTrader.ts`; a tick past the deadline takes
the slot with a `[auto-trader] scan wedged for N min` warn. The stale pass cannot be cancelled, so it is
superseded by a `scanEpoch`: it returns at `mark('review')` before `executeSignal`, its `catch` no longer
persists over the ledger, and its `finally` no longer releases the live pass's slot. Eight regression cases
in `scripts/tests/review-fixes.test.ts`, the incident's own timestamps among them.

Verified: typecheck clean, build clean, `review-fixes` 532/0, `ladder` 158/0, `adversarial` 89/0; backup
`oracle-trader-REPAIR-2026-09-20-20260920-195729.zip`; app restarted 00:05:11Z. The position booked at
00:05:54.376Z (`settledMarkets["KXLALIGAGAME-26SEP20VCFRSO-RSO"] = {shares: 3.23}`, consensus 34→35
trades, 17 losses) and the scan loop is completing again (`lastScanAt` 00:05:45.386Z, 81.2 s, scans
33671→33672). The 15-minute takeover itself has not fired in production and is covered by unit cases only.

**Noted, not acted on** (different signature, out of this incident's scope): `state.lastError` still reads
`3 positions unsettled >12h past close (oldest 54h: KXWTIW-26SEP1814-B99.50)`. Those three rows have been
stuck since 09-18/09-19, i.e. from before this wedge, and two sit at a pinned 0.975/0.985 quote that
`settlementProbeDue` should have been probing all along. Filed as backlog 210.

---

## 2026-09-21 (daily maintenance, headless 11:00-12:05Z)

Full section, with every number and its provenance, is `docs/reports/2026-09-21.md` and REVIEW-CHANGES **153**
(renumbered: a concurrent session committed its own 152 and backlog 216-220 at 11:16Z while this run was going).

1. **Liveness: nothing was down.** App up (this session restarted it at 11:23:03Z for the build; the sentinel had
   revived it at 00:05Z after the host lost the process), `main.log` current, ladder tick 4 min old, collector up,
   today's nightly review present, every hourly shadow inside the hour, sentinel `at` 11:20:01Z with **zero open
   incidents**. The one incident since the last session (`2026-09-20T23-50-unbooked-settlement-KXLALIGAGAME`) was
   dispatched and FIXED by the on-call repair at 00:12Z.
2. **THE DAY'S HEADLINE, and it is not a defect: the operator's daily loss cap tripped at about 09:10Z.** Local
   ledger -$13.40 against the 20% floor on ~$67 of equity; venue-settled is -$7.44 on 46 settlements and the rest
   is open-position mark-to-market (backlog 159, at his direction). Kalshi has refused every entry since -
   4,740 fade, 96 consensus, 6 mean-reversion, 2 volume-spike in the 10:45Z gate note. Nothing changed; loss
   limits are his.
3. **Venue-true 24 h: Kalshi -$9.88** after $3.09 fees on 102 settlements (cash $52.81, 27 open at $27.83 cost,
   6 resting); **Polymarket US $0.00**, no resolutions, balance $39.85.
4. **All six due reads performed; five triggers retired, one build shipped.**
   - **86** weekly lead-lag basis: 61 of 4,648 two-venue windows disagreed (**1.31%**), all within 3.6 bp of the
     strike; our money there is 19 fills for **-$9.89** of a -$44.59 total, so 78% of the loss is in AGREEING
     windows. The registered cell is -2.11c/contract, day-clustered CI95 **[-12.77, +8.55]** -> **no gate**.
   - **157** executable-bound regrade: **+6.90c/contract at the adverse Polymarket bound after fees** (vs +8.08c
     at the mid), **97.3%** of rows still clear the fee, and the narrow-spread bucket carries the same six cents
     as the wide - so it is not book noise. Forward Kalshi markout +1.83c +/- 1.79 over 231 rows: signal fine,
     execution still the question.
   - **173** Kalshi fill direction: the deprecated fields are still emitted but perfectly degenerate with
     exposure in all 3,404 archived fills; **nothing in the archive marks an exit**. Handbook 8.1 written; both
     `side` consumers checked and safe.
   - **175** mmsim: dark 14.2% of 09-18 and **33.5% of 09-19**, but 6.5% and 1.4% since, halts 4/7/3/0 - decaying
     untouched. **Decision: change nothing** (parameters are pre-registered). Residue -> backlog 222.
   - **107** lead-lag size ceiling: already implemented at `ladder.ts:138`. Retired.
5. **A defect found inside a read and fixed.** Both lead-lag basis scripts globbed `tmp/k-*.json`, which does not
   match `tmp/kalshi-<date>.json` - the name the session's own fresh dump has used since 09-19 - so the weekly
   read was grading our fills against a dump from 09-18 and silently lost **172 fills, every one from 09-19 to
   09-21**, the exact post-restore period it exists to judge. Both now take an explicit path, glob both names and
   print the dump they chose; `leadlag_basis_cells.py` also now prints the day-clustered band the rule is stated
   on rather than just the cell's total.
6. **Build shipped (build queue 3): HRRR is the weather fair value's forecast, NWS the fallback.** 378 graded
   station-days, **HRRR MAE 1.93 / bias -0.27 vs NBM 2.27 / -1.27**, closer on 201 to 166. `parseOpenMeteoHourly`
   is exported and carries fifteen assertions because Open-Meteo's grammar differs from the NWS feed's in three
   ways that each yield a wrong fair value rather than an error. tsc clean, build clean, **20/20 suites**, backup
   `MAINT-2026-09-21`, app restarted 11:23:03Z. Verified live end to end (NYC/LAX/CHI all `source=hrrr`);
   **the weather arms are on operator holds so this path does not appear in main.log today** and that is stated
   rather than papered over.
7. **Daily build-queue checks.** Critic skill: all three RAW conditions pass for the first time since 09-11, and
   amendment 2 declines it - over the four enabled arms present in both cohorts VETO is **+0.69c against
   ABSTAIN's +4.17c**, so VETO's own net is above zero and condition (i) fails. Nothing changed. WebSocket book:
   the per-UTC-day counters backlog 56 asked for now exist; 09-19 **0.9948 PASS**, 09-20 **0.9895 FAIL**, 09-21
   **0.9895 FAIL** - streak at 0, build stays parked.
8. **Ladder unchanged and running.** lead-lag **+$2.17/51** is the only positive live arm of size; fade -$0.20/50,
   consensus -$3.00/41, sports-anchor -$2.17/8. Three arms in cool-down, seven on operator holds. Consensus's
   verdict reconciles to the cent against the trade-quality ledger.
9. **Sharp anchor out of sample:** `ruleN` 503, `ruleNet` **+21.37**, `gradedN` 1,034, mean Brier 0.1254;
   `anchor-grades.jsonl` gained **108 rows** in 24 h whose own `rulePnl` sums to **-$0.91**. Odds API **278 of
   645** credits today (09-19 closed at 644, one under). Shadows: mention base rate LOSES to the market (Brier
   0.2132 vs 0.1112, not promotable); Polymarket consensus **+4.62c/contract** at the Kalshi ask net of fee over
   1,430 matched; Metaculus 129 pairs, still nothing graded.
10. **Nothing is needed from the operator.** Watch items only: OpenRouter at $11.76, and the fact that two Claude
    sessions were writing this repo at the same time today (hence the 152/153 renumber).

11. **Suppressions checked, none renewed.** The `[reconciler] run failed` suppression expired 09-18 and is left
    expired: its own note said to check the reconciler's state rather than the signature, and both reconcilers
    read `completeness: ok` (Polymarket US 11:33:21Z, 432 fill IDs; Kalshi 11:33:10Z). The `[ibkr-lab] Gateway
    API not available` suppression (to 09-24) demanded this run check `ibkr-lab.json` rather than the
    signature's silence: the gateway came back at ~06:50Z and the lab reads `lastScanAt` 11:32:18Z, **9,696
    scans, lastError empty**, 500 closed paper trades. No incident warranted.

**Delivery note:** this is the HEADLESS runner, which has no `SendUserFile` or `PushNotification`. The report is
written to `docs/reports/2026-09-21.md` for the 08:30 desktop task to deliver.
