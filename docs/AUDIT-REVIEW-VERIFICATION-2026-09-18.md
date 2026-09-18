# Independent Review & Verification of AUDIT-CODE-API-STRATEGY-2026-09-18.md

**Reviewer:** RIFT Studio agent (independent pass)
**Date:** 2026-09-18
**Subject:** `docs/AUDIT-CODE-API-STRATEGY-2026-09-18.md` (1217 lines)
**Scope:** Confirm or refute every finding; review APIs, strategies, and code; document new
defects; propose additional strategies. **No code was modified.**
**Companion to:** the original audit. Read this *with* it, not instead of it.

---

## 0. Verdict

**The audit is high quality and its technical core is correct.** I independently verified
D1D9, 6, and 8.0 against the source, against the vendor documentation vendored in-repo at
`scripts/kalshi-docs/`, and against Kalshi's live published docs. Its arithmetic is right 
I recomputed every row of the D1 fee table and every row of the 8.0 fee/win table and they
match exactly. Its prioritisation (9) is sound. 8.0's reframing of the fee as
`0.07  mult  P` of the potential win is the single most valuable insight in the document
and is algebraically correct.

**Three qualifications:**

1. **It has a documentation-integrity problem.** It cites **seven source files that do not
   exist anywhere in the repository** (including `backups/`), attaches specific line counts
   and trade statistics to some of them, and has several stale line counts in 1.1. A
   developer following those citations will waste time. See 3 below.

2. **One recommended fix is incomplete (D6)** and **one entire proposed strategy is already
   implemented (S5)**. Both would misdirect work. See 3.2 and 3.10.

3. **It misses two defects that are, in my assessment, more consequential than several it
   does report**  a double-division in the fee term that feeds the ladder's promotion
   metric (N1), and four mutually inconsistent fee implementations including the paper
   simulator that grades strategies before they go live (N2). See 4.

**Bottom line:** trust the audit's *analysis*, verify its *citations*, and fix N1/N2 before
acting on any of its strategy proposals  because the ladder that would promote those
strategies is currently grading on a corrupted metric.

---

## 1. Method and evidence base

| Check | How |
|---|---|
| Code claims | Read the cited lines directly; `Select-String` across all non-`.bak` sources |
| Vendor claims | `scripts/kalshi-docs/*.md` (in-repo snapshots: `create-order-v2.md`, `fixed-point.md`, `order-direction.md`, `pagination.md`, `get-balance.md`, `get-markets.md`, `llms.txt`) **plus** live `docs.kalshi.com` / `kalshi.com/docs/kalshi-fee-schedule.pdf` via web search |
| Build health | `npx tsc --noEmit`  **exit 0, no output** |
| Runtime state | `%APPDATA%\oracle-trader\{ladder,kalshi-auto,mini-auto-polymarket-us}.json` (live; written minutes before review) |
| Repo hygiene | `git status`, `.bak` census, BOM scan, `package.json` scripts |

**What I could NOT verify** (no API credentials used, no network calls to the venues):
- The audit's live-API measurements: 14,154 series; 14 zero-fee series; 19 at 0.5;
  the `fee_type` distribution (13,991 / 160 / 3); "0.0% `fee_waiver_expiration_time`
  presence across 5,722 markets"; the `center_deci_edge_centi_cent` sample.
  These are plausible, internally consistent, and the audit documents its method in its
  appendix  but they are single-observer. **Re-run them before acting on D2/D4.**
- Whether the account is a direct member ($0.0001 balance alignment) or FCM-cleared
  ($0.01). This materially changes D1's severity  see 3.1.

**Corrections to my own process, for the record:** an early truncated read of the audit led
me to draft several "audit errors" that were false (that it claimed the Kalshi WebSocket was
unused, that it stated the wrong production base URL, that it invented Open-Meteo, that it
named a non-existent `minimum_tick_size` field, that it flagged a lead-lag comment as stale).
Every one of those was re-checked against the real text and **withdrawn**. The audit is
correct on all five. What remains below survived that re-check.

---

## 2. Finding-by-finding verification

| ID | Audit claim | Verdict | Evidence |
|---|---|---|---|
| **D1** | Fee ceils to $0.01; vendor ceils to $0.000001 + accumulator; overstates up to 7.29 | **CONFIRMED** (mechanism + arithmetic)  **severity is conditional**, see 3.1 | `autoTrader.ts:4894-4898` matches the quote verbatim. Vendor spec confirmed at `docs.kalshi.com/getting_started/fee_rounding` and in-repo `scripts/kalshi-docs/fixed-point.md:97`. I recomputed all five table rows: 7.29 / 3.01 / 1.59 / 1.14 / 1.0001  **exact match**. |
| **D2** | `mult > 0 ? mult : 1` coerces a legitimate `fee_multiplier: 0` to full fee | **CONFIRMED** | `kalshi.ts:1389`; consumed at `kalshi.ts:1402` (`m.feeRate = 0.07 * c.mult`). Kalshi documents `fee_multiplier = 0` series; the in-repo `get-series.md` confirms the field. |
| **D3** | `/incentive_programs` unpaginated, called once per session, output unused | **CONFIRMED in substance  citation wrong** | `kalshi.ts:963` . Call site is **`autoTrader.ts:4503-4519`** (`logIncentivePrograms`), scheduled by `setTimeout(..., 60_000)` at **4544**  *not* `autoTrader.ts:1136` (which is `gradeVetoes()`). Also: the rows are **not** wholly discarded  `autoTrader.ts:4515` persists `count` + the first 5 rows to the episodes store. |
| **D4** | App cannot quote Kalshi's sub-cent grid; `toFixed(2)` on every price | **CONFIRMED, fully** | `kalshi.ts:1010`, `1103`, `1145`  exact. `price_ranges` / `price_level_structure`: **0 hits in `src/`**. The inline comment at `kalshi.ts:1009` ("whole-cent prices are valid in every price-level structure") is, as the audit says, accurate  this is a forfeited capability, not a crash. Live docs confirm `center_deci_edge_centi_cent` and five other structures. |
| **D5** | Fill verb derived from `book_side`, which encodes yes/no not buy/sell | **CONFIRMED  but the recommended field is past its removal date** | Mapping is at **`kalshi.ts:867`** (audit says 877). In-repo `scripts/kalshi-docs/order-direction.md` states verbatim: *"`book_side` ... is the same bit in book-vocabulary. `bid`  yes, `ask`  no, always."* The audit's equivalence table is correct: half of fills get the wrong verb. **However** the same doc gives `action`/`side` a removal date of *"not before May 28, 2026"*  **already passed**. See 3.4. |
| **D6** | Unwrapped `getOpenOrders` takes down `portfolio:get` | **CONFIRMED  premise wrong, so the fix is incomplete** | `engine.ts:486` , `index.ts:190` has no `try/catch` . But see 3.2. |
| **D7** | Maker fee keyed on one exact `fee_type` string | **CONFIRMED as fragility; the current code is *correct*** | `kalshi.ts:1408`: `c.feeType === 'quadratic_with_maker_fees' ? KALSHI_MAKER_FEE_COEF * c.mult : 0`, with `KALSHI_MAKER_FEE_COEF = 0.0175` (`kalshi.ts:29`). This matches Kalshi's published maker spec **exactly** (coefficient 0.0175, `M` default **0**). The risk is only that a *future* `fee_type` that bills makers would be priced at 0. |
| **D8** | `getEventCategories` unpaginated | **CONFIRMED** | `kalshi.ts:1290`: `/events?limit=200&status=open`, no cursor. `scripts/kalshi-docs/pagination.md` confirms cursor pagination with a default limit of 100. |
| **D9a** | Fee-waiver path dead | **PLAUSIBLE, unverifiable** | `kalshi.ts:104` declares the field; `kalshi.ts:1362` maps it to `feeWaiverUntil`; `autoTrader.ts:2550` branches on `waived`. The code path is real. The "0.0% presence" measurement is the audit's alone. |
| **D9b** | `Retry-After` ignored | **CONFIRMED** | `http.ts` (135 lines, read in full): `RETRYABLE = {429,502,503,504}`, 3 attempts, `3003^attempt + rand250`. No `Retry-After` parse anywhere. |
| **D9c** | No response-body validation | **CONFIRMED** | `http.ts`: `(await res.json()) as T`. |
| **D9d** | `sandbox: false`; `contextIsolation: true` and `nodeIntegration: false` set | **PARTLY WRONG** | `index.ts:116-117` sets `sandbox: false` and `contextIsolation: true`. **`nodeIntegration` is never set**  it is `false` only by Electron default. Posture is as described; the claim that it is *set* is not. |
| **D9e** | Priority lane can starve normal GETs, no aging | **CONFIRMED** | `http.ts`: `queue.sort((a,b) => b.priority - a.priority)` on every drain; writes = 2, account reads = 1, everything else = 0; no age term. |
| **6.1** | No git; 81 `.bak` in `src/` | **CONFIRMED exactly** | `git status`  `fatal: not a git repository`. **81** `.bak` under `src/` (94 project-wide). `.gitignore` exists and lacks `*.bak*` / `backups/`. |
| **6.2** | Typecheck clean | **CONFIRMED** | `npx tsc --noEmit`  exit 0, zero diagnostics. |
| **6.3** | 8 files with a UTF-8 BOM | **CONFIRMED exactly** | Same 8: `adjudicator.ts`, `auditStore.ts`, `openRouterClient.ts`, `types.ts`, `sportsAnchor.ts`, `sportsGameOdds.ts`, `AutoTraderPanel.tsx`, `ipc.ts`. |
| **6.4** | No aggregate `test` script; handbook points at a non-existent `test:unit` | **CONFIRMED; count wrong** | `npm test`  *Missing script: "test"*. No `test:unit`. But there are **14** `test:*` scripts, not "~25". |
| **8.0** | `fee / potential win = 0.07  mult  P` | **CONFIRMED  excellent** | Algebra verified: `[0.07MP(1P)] / (1P) = 0.07MP`. All five table rows recomputed exactly. The maker corollary ("pure maker on `quadratic` pays no fee at all") matches the vendor spec and `kalshi.ts:1408`. |
| **4 stats** | Ladder / mini-auto figures | **CONFIRMED against live state** | `mini-auto-polymarket-us.json`: 237 trades, $16.2478; book-imbalance 1W/39L $8.569; micro-maker $1.954; weather-fair $5.280; fade +$0.181. `kalshi-fade` now 188 trades / $1.95 / 0.11 (audit: 187 / $1.85 / 0.07)  **one trade of drift**, i.e. the audit read live state honestly. |
| **2** | API inventory | **CONFIRMED, and more complete than it looks** | Base URL `https://api.elections.kalshi.com/trade-api/v2` (`kalshi.ts:31`) ; demo `external-api.demo.kalshi.co` (`kalshi.ts:62`) ; WS `orderbook_delta`/`ticker`/`public_trades` ; `gateway.polymarket.us/v1/markets` ; `data-api.polymarket.com` **0 hits**  (F2 stands); Manifold `/v0/bets?userId=`  and no `?marketId=`  (F3 stands); NOAA NWS, FAA aviationweather.gov, ForecastEx, Coinbase WS, Kraken WS all present . |

---

## 3. Corrections  things in the audit that would misdirect a developer

### 3.1 D1's recommended fix is wrong for the app's likely account type

The audit's "true fee" column is the **converged model fee**. The fee Kalshi actually
*charges* is a two-step process (`docs.kalshi.com/getting_started/fee_rounding`, mirrored at
`scripts/kalshi-docs/fixed-point.md:97`):

```
trade_fee     = ceil_6dp(0.07  M  C  P  (1P))
aligned_debit = ceil_to_balance_precision(positionCost + trade_fee)
charged_fee   = aligned_debit  positionCost        (accumulator rebates the excess across fills)
```

Balance precision is **$0.01 for FCM-cleared (non-direct) accounts**, $0.0001 for direct
members. When `positionCost` is already a whole number of cents  which is exactly the app's
current situation (integer contracts, 1 grid)  then
`ceil_cent(cost + fee)  cost = ceil_cent(fee)`, i.e. **precisely what `kalshiOrderFeeCents`
computes today.**

So:

- **Per-fill cash accounting: the current code is correct** for a $0.01-aligned account.
- **EV / decision gates: the audit is correct**  the smooth model fee is the right
  estimator, because the accumulator converges multi-fill orders to it.
- The audit's recommendation ("for EV purposes, use the smooth per-contract rate and drop the
  cent ceil entirely") is right for the gate at `autoTrader.ts:2557` and **wrong for the
  accounting path at `autoTrader.ts:4744-4755`**, where dropping the ceil would understate
  cash cost.

**Correct fix: two functions, not one.**

```ts
kalshiModelFeePerContract(feeRate, P)      // smooth, 6dp  -> EV gates (2557, fadeMinEdgeCents)
kalshiAlignedFeeCents(feeRate, P, C, prec) // ceil on cost+fee -> cash accounting (4748, 4753)
```

**Resolve first:** the account's balance alignment. `/portfolio/balance`
(`scripts/kalshi-docs/get-balance.md`) exposes **no precision field**, so determine it
empirically  compare `ceil_cent(cost + model_fee)` against the observed balance delta over a
handful of fills (see A5 below). Until then, **do not change the accounting path.**

**Note the coupling:** D1 becomes unconditionally real the moment D4 ships (sub-cent prices)
or fractional contracts are traded (N6), because `positionCost` stops being a whole cent.
**D1 and D4 must ship together**, and the fee module (N2) is the natural place to encode the
alignment rule once.

Also worth reconciling: `kalshi.ts:1351-1355` already documents the taker fee as *"rounded up
per fill to $0.000001"*  the adapter comment states the vendor rule correctly while the
strategy helper implements the cent approximation. A reader would assume the opposite.

### 3.2 D6's premise is false, so its fix is incomplete

The audit states: *"`getAccount` is wrapped (`.catch`  zero account) and `getPositions` is
wrapped, but `getOpenOrders` is not."*

**Verified false.** `engine.ts:473`:

```ts
const [account, rawPositions] = await Promise.all([adapter.getAccount(), adapter.getPositions()])
```

No `.catch` on either. And neither adapter method has an internal guard  `kalshi.ts:785-801`
(`getAccount`) and `kalshi.ts:803+` (`getPositions`) call `this.requireAuth()` (throws) and
`authGet` (throws `HttpError`). **All three venue calls are unwrapped**, and `index.ts:190`
(`ipcMain.handle(IPC.portfolioGet, (_e, venue) => engine.getPortfolio(venue))`) has no
`try/catch` either.

Consequence: wrapping only `getOpenOrders`, as the audit recommends, leaves two other calls
able to kill the same handler. The correct fix is **per-call degradation with an explicit
partial-result contract**:

```ts
const [account, rawPositions, openOrders] = await Promise.all([
  adapter.getAccount(),                                  // may reject -> surface a degraded flag
  adapter.getPositions().catch(e => ({ degraded: true, error: fmtErr(e), rows: [] })),
  adapter.getOpenOrders().catch(e => ({ degraded: true, error: fmtErr(e), rows: [] })),
])
```

A missing *balance* should arguably fail loudly (you cannot render a portfolio without it);
missing *positions* or *orders* should degrade to "unknown" and the UI must show that
`openOrderReserve` is unknown rather than zero  otherwise a failed order fetch reads as
"no capital reserved" and the sizing logic over-commits.

This also makes **N8** (Polymarket US throws on a paginated open-orders response) a live
trigger for the same outage, on a second venue.

### 3.3 Seven cited files do not exist

Searched the entire repository including `scripts/` and `backups/`:

| Cited at | File | Reality |
|---|---|---|
| 1.1, 4.1 (line 408) | `tradeFeed.ts` (217 lines) | **not found anywhere**  flow-follow lives at `autoTrader.ts:1744` (`flowSignals`); `flowMonitor.ts` is a separate monitor |
| 4.1 (line 411) | `correlatedMarkets.ts` (257 lines) | **not found anywhere**  and there is **no `kalshi-correlated` ladder strategy**. The only `correlated` hits in `ladder.ts:377,444` are comments about correlated *fills* in the statistics. **This 4.1 row appears to be fabricated.** |
| 4.4 (line 442) | `manifoldCopy.ts` (121), `manifoldPaper.ts` (228) | **not found anywhere**  the holder/position pattern is `manifold.ts:326` (`getTopHolders`) |
| 1.1, 4.1 | `settlement.ts` | **not found**  settlement is `engine.ts:513-541` (`getSettlements`) |
| 1.1 (`store/`) | `executionArchive.ts`, `tradeLog.ts` | **not found**  actual `store/` is `config.ts`, `episodes.ts`, `fillReconciler.ts`, `history.ts`, `json.ts`, `orderJournal.ts` (the audit omits `episodes.ts`, `history.ts`, `json.ts`) |

The **strategy rows themselves are real**  `kalshi-flow-follow` and `settlement` are genuine
ladder IDs and the trade statistics match live state. It is the *module attributions* that are
invented. 1.1 also omits `shared/ipc.ts` (the 51-channel contract it cites in the same
paragraph), `shared/ibkrLab.ts`, and `intelligence/{auditStore,nightlyReview,types}.ts`.

### 3.4 D5's fix targets a field that is past its removal date

`scripts/kalshi-docs/order-direction.md` marks `action` and `side` on `/markets/trades` as
*"deprecated, removal not before May 28, 2026."* **That date has passed.** The audit notes the
deprecation but recommends reading `action` anyway.

The deeper problem: **direction is not recoverable from the fill record alone.** `book_side`
gives yes/no; `outcome_side` gives long/short exposure; neither says whether the fill
*increased* or *decreased* that exposure. Once `action` is gone, the verb must be derived from
the position delta.

**Recommended fix:** stop storing a verb. Store `outcome_side` (which is what P&L actually
depends on) and derive increase/decrease from the change in `position_fp` for that ticker
across consecutive fills  the app already fetches positions in `getPositions`
(`kalshi.ts:815`). This is robust to the deprecation and removes the ambiguity permanently.

### 3.5 Stale line counts in 1.1

| File | Audit | Actual | |
|---|---|---|---|
| `engine.ts` | 1399 | **801** | 75% overstated |
| `autoTrader.ts` | 4859 | **5040** | stale |
| `polymarketUs.ts` | 912 | **963** | stale |
| `manifold.ts` | 442 | **482** | stale |
| `miniAuto.ts` | 1300 | **1425** | stale |
| `kalshi.ts` | 1635 | 1635 |  |
| `ladder.ts` / `quoter.ts` / `http.ts` / `venue.ts` / `polymarket.ts` | 1278 / 1245 / 135 / 121 / 281 | same |  |

The summary line also mixes two counting methods  *"`kalshi.ts` 1533 (1635 on disk today)"*
 where 1533 is the blank-line-excluded count. **The inline `file:line` citations are
nevertheless accurate** (I verified `kalshi.ts:1010/1103/1145/1290/1389/1408`,
`autoTrader.ts:4894-4898/2557-2562`, `engine.ts:486`). So: citations good, header counts
stale. Cosmetic, but it undermines confidence on first contact.

### 3.6 Minor citation slips

- **D3:** `autoTrader.ts:1136`  actually `4503-4519`, scheduled at `4544`.
- **D5:** `kalshi.ts:877`  actually `867`.
- **6.4:** "~25 `test:*` scripts"  **14**.

### 3.7 S5 is already implemented  descope it

See 3.10 below; this is the largest single correction.

### 3.8 D9's `nodeIntegration` claim

See the D9d row in 2. Security posture is as described; the specific claim is not.

### 3.9 What the audit gets right that deserves credit

It under-claims in places. Two things it does not mention:

- **The fixed-point migration is complete.** The app reads `_dollars` / `_fp` fields
  throughout (`kalshi.ts:84-97`, `160-256`, `815`, `868`). Kalshi **removed the legacy
  integer-cent fields on 2026-03-12**  a live breaking change the app has already retired.
  This is a meaningful engineering win and the audit doesn't bank it.
- **`getOrderBook` deriving asks as `1  yesBids` (`kalshi.ts:843`) is correct**, not a hack:
  Kalshi's orderbook returns bids only, by design, because YES and NO are reciprocal.
- **`authHeaders` signs `path.split('?')[0]`**, so the comment at `kalshi.ts:1126` ("the
  signature covers the path without the query") is accurate. No signing bug.

### 3.10 S5's premise is refuted by the code

The audit's S5 (ranked high-value, scheduled in 9's Week 2) opens:

> *"`leadLag.ts:700-704` gates on `edgeC >= minEdgeC`  a **flat cent** threshold  against a
> **price-proportional** fee. Wrong in both directions at once..."*

**Neither the line range nor the variables exist.** `leadLag.ts:700-704` is the micro-size
comment plus `sweepSizeFor` plus the limit/legCost computation. `edgeC` and `minEdgeC` appear
**nowhere** in `leadLag.ts`.

The actual gate, `leadLag.ts:599-630`:

```ts
const threshold = cfg.leadLagMinDislocationCents / 100   // 596  GROSS detection filter
if (poly.mid - kYesAsk >= threshold) {
  const feeCents = kalshiTakerFeeCents(kYesAsk)          // 602  fee at the EXECUTABLE price
  const gapCents = +((poly.mid - kYesAsk) * 100).toFixed(1)
  const netCents = +(gapCents - feeCents).toFixed(1)     // 604  NET of fee
  ...
  clearsFees: netCents > 0,                              // 614
  if (canTrade && d.clearsFees) await this.sweep(...)    // 630  TRADE GATE = net, price-aware
```

The file header says it outright (`leadLag.ts:13`): *"Kalshi taker fee so 'clears fees' is a
measured fact, not a constant."* **Lead-lag already does what S5 proposes.**

Consequences:

- **S5's headline upside is void.** "Re-score the 42,076 recorded dislocations with a net
  gate" is not new work  `feeCents`, `netCents` and `clearsFees` are **already computed and
  persisted per dislocation** (`leadLag.ts:620-621`, written by `appendCadenceRow` at 625).
  The "420 trades, an order of magnitude more evidence" projection does not survive contact
  with the code.
- **9's Week 2 loses its largest item.** "Free re-analysis of data already on disk" was
  leaning on S5.
- **The real question S5 should have asked:** why do **2,558 sweeps produce 13 trades**
  (0.5%)? That is an *execution/fill* problem, not a gate problem  and it is exactly what
  the audit's own **S4** (queue-position instrumentation) addresses. **S4 is correctly
  prioritised; S5 should be merged into it.**

**What survives of S5** (all valid, all smaller):
1. `kalshiTakerFeeCents(p)` (`leadLag.ts:31-32`) is `ceil(0.07  P  (1P)  100)`  it
   **hardcodes 0.07** (ignoring the series multiplier, so it is wrong on the 14 zero-fee and
   19 half-fee series) and **ceils per contract rather than per order**. Same class as N2.
2. There is **no slippage/depth term**. S5's `expectedSlipC(price, depth)` is genuinely
   absent and genuinely worth adding  the gate compares against a *mid* on the Polymarket
   side and an *ask* on the Kalshi side, with no book-depth check on either.
3. `leadLagMinDislocationCents` *is* a flat-cent filter, but it governs **what gets logged**,
   not what gets traded. Lowering it would enrich the research dataset at zero trading risk 
   a legitimate, cheap change, just not the one S5 describes.

**S5's second half is CONFIRMED and valuable.** `crossVenueSignals` (`autoTrader.ts:2298-2350`)
matches on `assetOf(m)` + `jaccard(kTokens, norm(pm.question))` + a 35-minute close-time
window (`autoTrader.ts:2344`) and **never compares strikes**  `strike` does not appear in the
matching body. On a 500-rung ladder with an identical title per rung this can pair different
strikes and call the difference a dislocation. Currently starved (0 candidates), so no live
damage, but it is a real latent defect and should be fixed before `kalshi-cross-venue` is
ever enabled.

---

## 4. NEW defects the audit missed

### N1  HIGH  `netCentsOf` double-divides the fee, corrupting the ladder's grading input

`autoTrader.ts:4753`:

```ts
const feePerContract = kalshiOrderFeeCents(t.feeRate ?? 0, yesPx, C) / C
```

`kalshiOrderFeeCents` **already returns cents per contract.** Its own doc comment
(`autoTrader.ts:4736`) says so: *"Kalshi taker fee **per contract**, in cents."* Three
independent call sites confirm the contract:

- `autoTrader.ts:2557`  `feeCents` subtracted directly from a per-contract edge 
- `autoTrader.ts:4748`  `(kalshiOrderFeeCents(...) * C) / 100`  total dollars 
- `autoTrader.ts:4851`  `kalshiOrderFeeCents(i.feeRate ?? 0, yesPx, 1)` used as a per-contract fee 

Dividing by `C` a second time **understates the fee by exactly `C`**:

| P | C | true /contract | reported /contract | understatement |
|---|---|---|---|---|
| 0.50 | 1 | 2.0000 | 2.0000 | 1.00 |
| 0.50 | 2 | 2.0000 | 1.0000 | **2.00** |
| 0.50 | 5 | 1.8000 | 0.3600 | **5.00** |
| 0.50 | 10 | 1.8000 | 0.1800 | **10.00** |
| 0.07 | 14 | 0.5000 | 0.0357 | **14.00** |
| 0.02 | 50 | 0.1400 | 0.0028 | **50.00** |

**Why this matters more than its size suggests:**

- It feeds `gradeEntry` at **`autoTrader.ts:3750`** (paper) and **`autoTrader.ts:3763`**
  (live)  i.e. **the metric the ladder uses to promote and demote strategies.**
- The bias is **price-dependent**. `contracts = floor(amountPerTrade / legCost)`, so cheaper
  contracts  larger `C`  larger understatement. **The ladder therefore systematically
  favours longshot / cheap-contract strategies over mid-price ones, independent of their real
  edge.** That is a corruption of the *comparison*, which is worse than a uniform offset.
- **Cash accounting is unaffected.** `realized` at `autoTrader.ts:3761` uses `entryFeeDollars`
  (`4748`), which multiplies per-contract cents by `C` correctly. So: **the money is tracked
  right; the quality signal is wrong.** Balances will reconcile while promotions are being
  decided on inflated numbers.
- **Currently masked, and will activate silently.** Live config has `amountPerTrade = 1`
  (`autoTrader.ts:875`), giving `C = 12` for most fills, so today's error is small. The
  default is **5** (`autoTrader.ts:212`). **Increasing clip size  which is precisely what a
  promotion does  turns this on.**

**Fix:** delete `/ C` at `autoTrader.ts:4753`. Add a regression test asserting
`kalshiOrderFeeCents(r, p, C) * C  total order fee in cents` for `C  {1,2,5,10,50}`, and a
second asserting `netCentsOf` equals `(payout  cost  fee)` computed independently.
**Then re-grade the full ladder history**  every strategy currently at `tiny-live` or above
was graded with this bug live.

### N2  HIGH  four divergent fee implementations; the paper simulator matches none

| Location | Formula | Rounding | Multiplier-aware? |
|---|---|---|---|
| `autoTrader.ts:4896` | `ceil(feeRateCP(1P)100  1e-9)/100`  per-contract | order total  |  uses `feeRate` |
| `dutchBook.ts:80` | `ceil(0.07countp(1p)100  1e-9)/100` | order total  |  **hardcodes 0.07** |
| `cryptoConvergence.ts:105-106` | `ceil(0.07p(1p)100)/100  count` | **per contract**  |  hardcodes 0.07, no `1e-9` guard |
| `engine/paper.ts:233` | `feeRate  shares  price  (1price)` | **none**  |  uses `feeRate` |

Divergence on identical inputs:

| P | C | paper | autoTrader / dutchBook | cryptoConvergence |
|---|---|---|---|---|
| 0.50 | 10 | $0.1750 | $0.18 | $0.20 |
| 0.02 | 50 | $0.0686 | $0.07 | **$0.50** |

At P=0.02, C=50 the spread between two in-repo models is **7.3**  coincidentally the same
magnitude the audit reports for D1, but this one is *internal* and needs no vendor doc to
prove.

**Why it matters:** `engine/paper.ts` is the simulator the ladder uses to grade a strategy
*before* it goes live. Its fee model differs from every live path, and the direction of the
error depends on price and clip size. **Paperlive promotion is therefore decided on costs
that do not match production.** Combined with N1, the promotion pipeline has two independent
fee errors pointing in opposite directions.

**Fix:** one exported fee module (`src/main/venues/kalshiFees.ts`) exposing
`kalshiModelFeePerContract` and `kalshiAlignedFeeCents` (per 3.1), imported by all four call
sites. Delete the local copies. This is also where the D1 alignment rule and the D2 multiplier
fix belong  one place, tested once.

### N3  MEDIUM  series-fee resolution is throttled to 20/scan, in-memory, and defaults to full fee

- `kalshi.ts:1384`: `const unknown = [...new Set(batch.map(seriesOf).filter(Boolean))].slice(0, 20)`
- `kalshi.ts:1373`: *"Best-effort  failures leave the 1 default."*
- `kalshi.ts:1355`: `feeRate: 0.07 * (this.seriesFeeCache.get(seriesOf(m) ?? '')?.mult ?? 1)`
- `kalshi.ts:1361`: default `makerFeeRate: KALSHI_MAKER_FEE_COEF * (...?.mult ?? 1)`
- The cache is **in-memory only**  empty after every restart.

Consequences:

1. After a restart, most markets carry `mult = 1` (full taker fee) until their series resolves,
   and only 20 resolve per scan. On a 14,154-series universe the long tail may never resolve
   within a session.
2. The default `makerFeeRate = 0.0175` is applied to markets whose series is unresolved. On
   the **13,991 plain-`quadratic` series the true maker fee is 0**, so the default overstates
   maker cost from nothing to 1.75%  **on exactly the markets the quoter targets.** The
   comment at `kalshi.ts:1356-1360` explains this was deliberate (avoid pricing "no data" as
   "free"), which is defensible for the *taker* gate but silently suppresses *maker* quoting.
3. It compounds **D2**: an unresolved zero-fee series is indistinguishable from a full-fee one.

**Fix:** persist `seriesFeeCache` to disk (~14k rows, trivial); run an uncapped background
warm-up pass at startup; and represent "unknown" as a distinct state from "1" so the maker
path can treat unknown as unknown instead of as billed.

### N4  MEDIUM  comment contradicts code on cache lifetime

`kalshi.ts:1372`: *"Multipliers are cached forever (they change rarely; a restart refreshes)."*
`kalshi.ts:1377`: `const ttl = c.feeType === 'quadratic_with_maker_fees' ? 0 : 24 * 3600_000`,
consumed by `stale()` at `1378-1381`.

The cache is **24 hours**, not forever  and `quadratic_with_maker_fees` entries are
**never cached** (`ttl = 0`), so those 160 series are re-fetched on every single scan. That is
the opposite of what the comment says and a needless rate-limit cost on the exact series the
maker path cares about. Same defect class the audit flags in D9; it missed this instance.

### N5  MEDIUM  the entry path can submit an IOC at $1.00 / $0.00

`kalshi.ts:993`: `yesLeg = order.outcome === 'YES' ? (ask + 0.01) : (bid - 0.01)`, then
`clamp01` at `kalshi.ts:998`.

On a collapsed book (ask = 0.99) this yields an IOC limit of **$1.00**  paying up to $1.00
for a contract whose maximum payoff is $1.00, i.e. **guaranteed  0 EV before fees**, with
effectively unbounded slippage. The comment calls this "bounded slippage"; at the extremes the
bound is vacuous.

The **reduce** path does the same clamp (`kalshi.ts:1091-1095`) but documents why:
*"a collapsed book (1 bid, 99 ask) pushes the marketable default to 0 or 1, and rejecting it
made positions unexitable exactly when exiting matters most."* **That reasoning is correct for
exits and wrong for entries.** The asymmetry is undocumented.

**Fix:** on the entry path, reject (or cap at a configurable `maxEntryPrice`) rather than clamp.

### N6  MEDIUM  fractional contract counts sent without checking `fractional_trading_enabled`

`kalshi.ts:1006-1010`: `count = Math.max(0.01, order.amount / legCost)`  `count.toFixed(2)`.

In-repo `scripts/kalshi-docs/fixed-point.md:76-91` confirms fractional counts are a real,
**per-market gated** capability, and warns: *"Even if you are not placing fractional orders,
you will encounter fractional values elsewhere in the API (for example, **fills**)."*
`fractional_trading_enabled` has **0 hits in `src/`**.

Two consequences:

1. Dollar-sized manual orders on a non-fractional series will be **rejected**.
2. **Fractional fills are mis-accounted.** `kalshi.ts:868` correctly parses
   `shares: toNum(f.count_fp)` as a float  but `entryFeeDollars` (`autoTrader.ts:4747`) and
   `netCentsOf` (`4752`) both do `Math.max(1, Math.round(t.shares))`. A 1.55-contract fill is
   accounted at C=2; a 0.4-contract fill at C=1. Meanwhile `realized` at `3761` uses the
   *unrounded* `t.shares` for P&L. **The reconciler will drift on fractional fills.**

**Fix:** read `fractional_trading_enabled` and gate the fractional path on it; remove
`Math.round(t.shares)` from the accounting helpers and let them work in float contracts.

### N7  LOW/MEDIUM  exits bypass the exchange-side circuit breaker

`placeOrder` attaches `order_group_id` / `exchange_index` (shard-routed, kill-switchable).
`sellPosition` (`kalshi.ts:1098`) posts `reduce_only: true` with **no order group**.

Defensible  you always want exits to work  but it means the order-group kill switch does not
cover the reduce path, and the asymmetry is undocumented. **Decide and document.**

### N8  LOW  Polymarket US turns open-orders pagination into a hard throw

`polymarketUs.ts:415`:

```ts
if (!rows || container.nextCursor || container.eof === false)
  throw new Error('Missing or incomplete open orders ledger')
```

Correctly refuses to silently truncate  good instinct. But combined with **D6** (unwrapped
`getOpenOrders` at `engine.ts:486`), a paginated response takes down the entire portfolio view.
This makes D6 **more likely to fire on Polymarket US than on Kalshi**. Fixing D6 per 3.2
resolves it; worth calling out because the audit frames D6 as Kalshi-specific.

### Verified-safe  do not chase these

Recorded so the next reader doesn't re-investigate:

- **`dailyBrakeBlock` is correct.** `miniAuto.ts:1415-1425` returns `null` when
  `dailyPnl.date !== today`, so the stale `dailyPnl.date = "2026-09-13"` in live state (vs
  `daily.date = "2026-09-18"`) is a **cosmetic lazy-roll artifact**, not a broken loss brake.
  It self-corrects on the next settled trade.
- **`authHeaders` signing is correct** (`path.split('?')[0]`); the comment at `kalshi.ts:1126`
  is accurate.
- **`sweepSizeFor` (`leadLag.ts:150-160`) matches its comment**  full size for
  `leadLagProvenCoins`, else `min(full, leadLagNewCoinContracts)`.
- **Ask derivation `1  yesBids` (`kalshi.ts:843`) is correct** per Kalshi's book vocabulary.
- **The fixed-point migration is complete**  no exposure to the 2026-03-12 legacy-field removal.

---

## 5. API surface  confirmed status and what is newly available

### 5.1 Confirmed against live vendor documentation

| Item | Status |
|---|---|
| Fee formula `round up(M  0.07  C  P  (1P))` | **Confirmed**  `kalshi.com/docs/kalshi-fee-schedule.pdf` (eff. 2026-07-07) |
| **Maker fee is a separate formula**: `round up(M  0.0175  C  P  (1P))`, **M default 0** | **Confirmed**  same PDF. `kalshi.ts:1408` implements this correctly. |
| Rounding is `ceil_6dp` on the trade fee, then balance alignment, then an accumulator that rebates | **Confirmed**  `docs.kalshi.com/getting_started/fee_rounding`; mirrored at `scripts/kalshi-docs/fixed-point.md:97` |
| `fee_multiplier` values in the wild: 1, 0.5, 0.25, **0** | **Confirmed**  `mult = 0` is legitimate, so **D2 is a real bug** |
| `price_level_structure` / `price_ranges` are real Market fields | **Confirmed**  `docs.kalshi.com/api-reference/market/get-markets` |
| Structures: `linear_cent` ($0.01), `deci_cent` ($0.001), `tapered_deci_cent`, `center_whole_edge_half_cent` ($0.005 edges), `center_whole_edge_quint_cent` ($0.002 edges), `center_deci_edge_centi_cent` ($0.0001 tails) | **Confirmed**  **D4 is real and the grid goes to $0.0001** |
| Vendor guidance: *"Do not key pricing logic off this name; new structures are introduced over time, and a client that reads `price_ranges` is automatically compatible with all of them."* | **Confirmed**  this is the authority for D4's fix |
| Legacy `tick_size` deprecated 2026-01-05, **removed 2026-05-07** | **Confirmed**  the app correctly does not use it |
| Legacy integer-cent market fields **removed 2026-03-12** | **Confirmed**  the app has already migrated |
| `action` / `side` on `/markets/trades` deprecated, removal "not before 2026-05-28" | **Confirmed  date has passed.** See 3.4 |
| Orderbook returns **bids only** | **Confirmed**  `kalshi.ts:843` handles it correctly |
| Fractional contracts are real and per-market gated (`fractional_trading_enabled`) | **Confirmed**  see N6 |
| `data-api.polymarket.com` unused by the app | **Confirmed** (0 hits)  **F2 stands** |
| Manifold `/v0/bets?marketId=` unused | **Confirmed** (only `?userId=`)  **F3 stands** |

### 5.2 Endpoints worth adding that the audit did not list

The audit's 3.3 is strong (`get-weather-index`, `forecast-percentile-history`,
`batch-cancel-orders-v2`, `decrease-order-v2`, `get-total-resting-order-value`,
`get-historical-cutoff-timestamps`). Two additions:

- **`/markets/candlesticks` is already used** (`kalshi.ts:570`, batch, up to 100 tickers) 
  worth noting because 3.3's framing implies historical price data is under-used. The batch
  form is the right one.
- **`negative_risk` on the event object.** Multi-outcome events where the exchange converts a
  full complement set. **Open question:** does `dutchBook.ts` scan *intra-event* negative-risk
  combinations, or only cross-venue? `kalshi-dutch` sits at 0 trades, so whatever it scans
  produces nothing. If it is cross-venue only, the intra-venue version is the
  higher-frequency opportunity and the field is already on the event payload the app fetches.
  **Verify before building.**

---

## 6. Strategy assessment

### 6.1 On the audit's S1S9

| | Assessment |
|---|---|
| **S1** Incentive-aware maker ladder | **Strongest.** Correctly identifies that `/incentive_programs` is fetched and unused. Note D3's citation fix (3.6) and that rows *are* partially persisted at `autoTrader.ts:4515`. |
| **S2** Fee-tier universe selection | **Excellent**, follows directly from 8.0. Depends on **D2 + N3** being fixed first  otherwise the multiplier data is unreliable. |
| **S3** Sub-cent tail making | **Valid, but blocked.** Requires **D4 + D1 + N6 together** (price grid, fee alignment on sub-cent cost, fractional counts). Do not start on D4 alone. |
| **S4** Queue-position instrumentation | **Correctly prioritised**, and more so now  see A2 below. |
| **S5** Net price-aware gate | **DESCOPE  already implemented.** See 3.10. Salvage the slippage term and the strike-matching fix. |
| **S6** Kalshi's own weather truth feeds | **Strong.** The quoter's 1.93 markout over n=1,083 says the fair-value chain is the problem, and settling against the venue's own index is the direct fix. |
| **S7** Polymarket Data-API | **Sound**, and the "port `manifold.ts:326` rather than invent it" observation is correct  `getTopHolders` already implements the pattern. |
| **S8** Implied-vol fair value on zero-fee crypto ladders | **Best genuine-edge idea in the document.** Composes S2 (KXBTCY/KXETHY are fee-free with real volume) with an unused IBKR capability (option chains / IV). Digital payoff on BTC + a live options feed + zero fees is a real structural edge. |
| **S9** RFQ / block trades as the size channel | **Valid.** `communications` (18 endpoints) untouched; `MAX_NOTCH = 5` exists because the app can't move more than the visible book. |

### 6.2 Additional proposals

**A1  Fix the grading metric before adding any strategy. (Week 1, item 0.)**
The audit's 9 Week 1 is "fix the fee model", meaning D1/D2  the *venue-facing* fee. It does
not know about **N1** (the `netCentsOf` double-division) or **N2** (four divergent models,
paper matching none). Since the ladder is the promotion mechanism for **every** strategy in
S1S9, a corrupted grading metric makes all future promotion decisions unreliable  including
the ones already made. Sequence: fix N1  fix N2  **re-grade the entire ladder history** 
*then* start S1/S2/S8. The re-grade is free (the data is on disk) and may reverse existing
promotions.

**A2  Decompose the 2,558  13 sweep conversion before building anything new.**
This is the project's central empirical question and the audit identifies it correctly in S4.
But part of it is answerable **today, with no new endpoint**: the app already reads
`/historical/orders`, and already measures detectionack latency (`leadLag.ts:88`). Split the
2,558 into *rejected / cancelled / expired-unfilled / partially-filled*. If the mass is
"expired unfilled", it is a queue-position problem (S4). If it is "rejected", it is a
price-validity or shard problem (D4/N5). **This is a few hours of work and it determines
whether S4 is worth building.**

**A3  Use `decrease-order-v2` to fix the quoter's adverse selection.**
The quoter is disabled at **1.93 markout over n=1,083**. On plain-`quadratic` series the
maker fee is **0** (8.0, confirmed), so that markout is *pure adverse selection*, not fee
drag. The audit lists `decrease-order-v2` in 3.3 as an unused endpoint that *"cuts exposure
without losing queue position"*  but never connects it to the quoter's problem. **That is the
connection.** A maker that can shrink a quote when the underlying moves, without forfeiting
its place in the queue, can cut adverse selection while keeping fill probability. Concretely:
on a reference-price move beyond a threshold, `decrease` the threatened side rather than
cancel/repost. This is the highest-leverage use of an endpoint the app already has documented
in-repo, and it targets the one strategy with the largest measured loss.

**A4  Global resting-notional brake via `get-total-resting-order-value`.**
Also listed in 3.3 and unused. One call returns total resting exposure across all shards 
the global risk number the app currently lacks (entries are order-group-gated; exits are not,
per N7). Cheap, and it closes a real risk-control gap.

**A5  Measure the fee accumulator empirically to resolve D1's open question.**
3.1 needs the account's balance alignment, and `/portfolio/balance` exposes no precision
field. But the accumulator's rebate is *observable*: over a window of fills, compare
` entryFeeDollars` (what the app books) against the actual balance delta. The difference is
the rebate, and its size tells you the alignment directly. **This turns D1's biggest unknown
into a measurement instead of a guess**, and it needs no new endpoint.

**A6  State the S3 dependency chain explicitly.**
S3 (sub-cent tail making) needs **D4** (read `price_ranges`), **D1** (fee alignment on
sub-cent `positionCost`), and **N6** (fractional counts + `fractional_trading_enabled`)
together. Shipping D4 alone produces orders the venue may reject or fills the accounting
mis-books. Sequence them as one unit.

---

## 7. Revised priority order

The audit's 9 is good. This is 9 with the corrections folded in:

**Week 1  correctness of the measurement layer (do not skip, do not reorder)**
1. **N1**  delete `/ C` at `autoTrader.ts:4753`. One character-class fix; unblocks everything.
2. **N2**  single fee module; delete the four local copies. Encode the 3.1 alignment rule here.
3. **A1**  re-grade the full ladder history with the corrected metric. Review every promotion.
4. **D2**  `mult > 0 ? mult : 1`  preserve 0. (`kalshi.ts:1389`)
5. **D6 per 3.2**  wrap **all three** venue calls in `engine.getPortfolio`, with a
   partial-result contract. Also resolves **N8**.
6. **A5**  measure the accumulator; determine balance alignment empirically.

**Week 2  the free re-analysis (revised: S5 removed)**
7. **A2**  decompose the 2,558  13 sweep conversion from `/historical/orders`. Decides S4.
8. **S4**  queue-position instrumentation, *if* A2 points at fills.
9. **D3 per 3.6**  paginate `/incentive_programs`, persist all rows. Prerequisite for S1.
10. **S5 residue**  add the slippage/depth term to the lead-lag gate; fix
    `crossVenueSignals` strike matching (`autoTrader.ts:2298-2350`) **before** enabling
    `kalshi-cross-venue`.

**Week 3+  capability**
11. **D4 + D1 + N6 as one unit** (A6)  then **S3**.
12. **N3 + N4**  persist the series-fee cache, remove the 20/scan cap, fix the `ttl = 0`
    anomaly on `quadratic_with_maker_fees`. Prerequisite for **S2**.
13. **S2** (fee-tier universe)  **S1** (incentive-aware maker ladder)  **S8** (IV fair value).
14. **A3** (`decrease-order-v2` for quoter adverse selection)  revive the quoter.
15. **A4** (global resting-notional brake), **N5** (entry price cap), **N7** (document the
    exit/kill-switch asymmetry), **D5 per 3.4** (store `outcome_side`, derive the verb).

**Engineering hygiene (unchanged from 6, all confirmed):** initialise git; add `*.bak*` and
`backups/` to `.gitignore`; delete the 81 `.bak` files under `src/` *after* the first commit;
strip the 8 BOMs; add an aggregate `test` script and correct the handbook's `test:unit`
reference (14 `test:*` scripts exist to wire up).

---

## 8. Handoff checklist

**Read first:** this document, then the original audit's 8.0 (the fee reframing) and 9.

**Trust:** the audit's analysis, arithmetic, and prioritisation. 8.0, D2, D4, D7, D8, 6.
**Verify before acting:** D3's citation, D5's fix, D6's fix, S5 in its entirety, and every
file path in 1.1 and 4.

**Do not trust:** the seven non-existent file citations (3.3); the 1.1 line counts (3.5);
S5's premise (3.10); the claim that `nodeIntegration` is explicitly set (3.8).

**Single most important action:** `autoTrader.ts:4753`  delete `/ C` (N1). It is one token,
it is corrupting every promotion decision the ladder makes, and it activates harder the moment
any strategy is sized up.

**Open questions requiring live API access or operator input:**
1. Is the account a direct member ($0.0001 alignment) or FCM-cleared ($0.01)?  A5 answers it.
2. Re-run the audit's live measurements (14,154 series; the zero-fee and `fee_type`
   distributions; `fee_waiver_expiration_time` presence). Single-observer today.
3. Does `dutchBook.ts` scan intra-event negative-risk combinations, or cross-venue only?
4. Has Kalshi actually removed `action`/`side` from `/markets/trades` yet (date passed
   2026-05-28)? Determines how urgent D5 is.
5. Which `price_level_structure` values appear on the tickers the app actually trades? D4's
   impact is zero if none of them are sub-cent.

**Build state at review time:** `npx tsc --noEmit`  exit 0, clean. No git history. 81 `.bak`
files under `src/`. App was live and writing state during the review.
