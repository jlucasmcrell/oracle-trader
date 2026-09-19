# What won, what lost, and what changed between them

**2026-09-18.** Every number here is venue-authoritative: Kalshi's own settlement records
(1,420 settled markets, 2026-08-28 to 2026-09-18), not the app ledger. Reproduce with
`tmp/k-2026-09-18.json` (GET-only dump) and the per-family classifier in this document.

Account total over the period: **-$54.32**.

## 1. Where the money went, by strategy family

| Family | Contracts | Net | Per contract |
|---|---|---|---|
| Weather maker (quoter + weather fades) | 1,437 | **-$45.97** | -3.20c |
| "Other" (assorted small arms) | 747 | -$16.36 | -2.19c |
| Crypto/commodity dailies (fade, convergence) | 578 | -$14.00 | -2.42c |
| Lead-lag 15-minute crypto | 3,849 | **+$11.96** | +0.31c |
| Sports (consensus, mean-reversion, anchors) | 1,636 | +$8.98 | +0.55c |
| Politics/macro | 327 | +$1.07 | +0.33c |

Two facts follow. The account's whole loss is the weather maker seat plus the small
negative arms; and the only family with a large positive contract count is lead-lag, whose
**+0.31c/contract lifetime average hides a +9c era and a -2c era**.

## 2. The daily curve, and the two inflection points

| Date | Net | What was running |
|---|---|---|
| 09-03 to 09-06 | -$8.69, -$7.16, -$13.22, -$10.78 | weather maker quoting; lead-lag not yet live |
| 09-07 | **+$15.26** | sports +$10.40 (one LALIGA market +$22.33), lead-lag +$4.97 |
| 09-08 | -$16.67 | weather -$8.74, crypto dailies -$7.29 |
| 09-09 | +$3.17 | weather retired this day |
| 09-10 | +$5.66 | lead-lag +$11.05 |
| 09-11 | +$8.41 | lead-lag +$9.19 |
| 09-12 | **+$33.39** | lead-lag +$36.21 - the peak |
| 09-13 | -$22.87 | lead-lag -$15.09, sports -$5.65 |
| 09-14 | -$3.69 | lead-lag +$1.86 on 1,765 contracts |
| 09-15 | -$25.98 | lead-lag -$24.49 |
| 09-16 | -$10.10 | lead-lag -$19.62, sports +$11.94 (ATP +$10.39) |
| 09-17 | -$2.01 | lead-lag -$0.35; orderbook fix lands 09:40Z |
| 09-18 | +$3.36 | lead-lag +$5.93 |

The weather bleed ends 09-09. Everything after that is lead-lag's story.

## 3. Lead-lag: the winning streak, the losing streak, and the isolation

| Period | Config | Contracts | Net | Per contract |
|---|---|---|---|---|
| **A: 09-07 to 09-12** | BTC+ETH only, 60 s poll, <=4 contracts/sweep, no position-cap reads on the order path, sweep latency **~0.07 s** | 713 | **+$63.73** | **+8.94c** |
| **B+C: 09-13 to 09-16** | 7 coins, 8 contracts/sweep then window caps, 10 s poll, latency **14 s median (p90 45 s)** | 2,853 | **-$57.34** | **-2.01c** |
| **D: 09-17 to 09-18** | 8 coins, 1 contract/sweep, live orderbook quotes, 10 s poll, latency **57 ms median** | 283 | +$5.57 | +1.97c |

**The isolation that matters.** In period B+C the coins we had been winning on went
negative on their own:

| Period | BTC+ETH | The five added coins |
|---|---|---|
| A | +8.94c (713 contracts) | not traded |
| B+C | **-1.83c** (1,656 contracts) | -2.25c (1,197 contracts) |
| D | -0.51c (45) | +2.44c (238) |

So the coin expansion is **not** the cause. BTC and ETH, unchanged, went from +8.94c to
-1.83c. Whatever broke, broke for the markets that were already working.

## 4. What actually changed, in order (REVIEW-CHANGES §97, §108)

| When (UTC) | Change | Measured effect |
|---|---|---|
| 09-12 12:46 | `maxOpenPositions` 0 -> 80, so every live order was preceded by two venue reads (positions, open orders) | sweep latency **0.07 s -> 0.44 s** |
| 09-12 14:13 | sizing clamp fixed: 8 real contracts per sweep instead of <=4 | latency 0.86 s, p90 14.6 s; BTC/ETH edge **+12.0c -> +1.7c** on the same coins and cadence |
| 09-13 10:05 | 10 s poll with seven coins swept concurrently - up to 21 venue calls per cycle against a ~2/s budget | latency **14 s median, p90 45 s** |
| 09-13 11:39-11:57 | micro size for unproven coins, $15/window, 2 coins per direction | caps also held BTC/ETH sweeps 54 times on 09-14 |
| 09-15 23:48 | limiter rewrite (write lane first, 334 ms pacing) | 14 s -> 3.7 s |
| 09-16 07:35 | winning-period settings restored (60 s poll, small size) | partial recovery |
| 09-17 08:07 | round 115 fast path: reservation-based cap accounting, separate read/write lanes, shard hint | latency **-> ~0.1 s** |
| 09-17 09:40 | round 116: quotes taken from the live **orderbook** instead of the cached `/markets?series_ticker=` list | the list held a quote for 18 s while the book moved 76c -> 82c |

**How we were winning (period A).** A genuine cross-venue dislocation is worth a few cents
and lasts seconds. We were taking a handful of them per hour on the two most liquid coins,
at 1-4 contracts, with an IOC that reached the exchange in ~70 ms. The edge is entirely a
speed-and-selectivity edge: the gap has to still exist when the order lands.

**How we lost it.** Four changes, each individually defensible, all pointing the same way:
1. **Venue reads inserted into the order path** (09-12) - 6x latency for a risk check that
   could have been done in the background.
2. **8 contracts per sweep** (09-12) - the same stale-quote gap, but each bad fill now costs
   8x, and a larger order is more likely to be the one an informed taker fills.
3. **10 s poll x 7 coins** (09-13) - saturated the request budget, so latency went to 14 s.
   At 14 s the gap we are trading is long gone; we were systematically buying what someone
   else had already corrected.
4. **Stale quotes throughout** - the Kalshi price came from a cached list endpoint. Gaps that
   looked like 10c were often 0c. This did not change on 09-12, so it is not a cause of the
   streak, but it is why the recorded "signal" stayed strongly positive through it: the
   measurement and the trade shared the same wrong price. Note what staleness did NOT do:
   the IOC always executed against the real book, never the stale price, so it never paid
   us and never charged us. Measured paid-minus-quoted: era A mean -2.31c (46% of fills
   better than quoted, 31% worse), era D on orderbook quotes -0.05c (91% identical). Fresh
   quotes remove decision noise; they are weakly better, never worse.

The 09-13 kill-switch trip (§88) is the same story: correlated windows, seven coins, one
direction, all at 14 s latency.

## 5. What we are doing differently now

- Quotes come from `/markets/{ticker}/orderbook`, never the cached list (§111).
- 1 contract per sweep; $15 per window; 2 coins per direction; 3 sweeps per ticker.
- The position cap is a reservation count refreshed in the background - no venue read on the
  order path (§109, §112).
- Separate read/write lanes at the account's real limits; shard hint skips a market lookup.
- Measured 09-17/09-18: **57 ms median, 101 ms p90** over 284 executed sweeps.
- Graded signal on honest quotes is **+1.35c/contract**, and realized fills are **+1.86c** -
  execution is no longer worse than the signal. Both are a fifth of period A's +8.94c.

## 6a. The other arms, briefly

- **fade** (+$8.18, 243 trades, 95% wins) - calibration z = **+0.15**: it wins exactly as
  often as its 0.95 entry prices imply. No edge; the profit is inside noise (t=1.99).
- **weather maker** (-$45.97) - retired 09-09 after the seat measured -1.70c/contract over
  801,258 venue-wide contracts. Correctly dead.
- **book-imbalance** (-$12.42), **momentum** (-$10.63), **volume-spike** (-$4.80),
  **flow-follow** (-$3.20) - all negative, all small.

## 6. Sports: what won, what it was, and what it says

**The two good sports days were two single clusters, not a process.**

| Day | Sports net | What it was |
|---|---|---|
| 09-07 | +$10.40 | ONE market: LALIGA Elche v Real Sociedad, 38 contracts YES at 24c, resolved YES, **+$22.33**. The other four sports fills that day and the next lost $2.2-$2.9 each. |
| 09-16 | +$11.94 | Consensus took 22 ATP challenger matches, 13 won, +$10.95. |

**09-07's configuration** (`kalshi-auto.json.bak_20260907-041806`): mean-reversion v1, taker, no entry floor,
`amountPerTrade` $5, `maxDailyTrades` 20 (hit by 08:52Z), `maxOpenPositions` 6, universe 40 markets at
liquidity >= 150. That is a config that buys longshots quickly at size. Across its 7 sports settlements it
was +$18.41; without the one lottery ticket, **-$3.92 on 6**. It is not a config to return to.

**Consensus (the Polymarket smart-wallet arm), judged on every settled market, not just sports:**

| | |
|---|---|
| Settled markets / contracts / day clusters | 86 / 260 / 5 |
| Net | **+$0.31 (+0.12c/contract)** |
| Day-clustered 95% band | **[-6.35, +6.59]** - includes zero both ways |
| By day | 09-14 -3.01, 09-15 -0.96, **09-16 +7.65**, 09-17 -1.69, 09-18 -1.67 |

The pre-registered judgment (>= 40 contracts, >= 5 clusters) is met and lands on **neither stop nor
promote**. Our fills disagree with the signal grader in **both** directions: **+$15.07 on categories the
grader marks negative** (atp -0.4c on n=302, wta -4.1c, mlb -3.3c) and **-$3.98 on the ones it marks
positive**. The sports subset's +$9.18 is variance, and tennis in particular is not a signal we have.

What the grader (7,306 graded signals, +5.56c at the Kalshi ask over 1,165 matched) does support: btc
(n=2,280, +0.9c), weather "highest" (n=1,287, +0.55c), and small-n soccer/football (mls +7.7c n=41, spl
+6.1c n=35, nfl +3.4c n=97, cfb +2.3c n=77, uel/epl +1-2c). Tennis is flat, mlb negative. **No category
filter was added**: the pre-registration's 40-contract judgment is the arbiter, and our own fills are too
few to override the grader in either direction.

**One throughput defect, fixed.** The arm allows ten market fetches per scan for signals outside the scan
universe, but counted cache hits against that ten. The feed lists signals in a stable order, so the same
ten rows were injected every scan and rows 11+ were refused `fetch-budget` on every scan - **51-75 of
~95 fresh signals a scan were never evaluated at all**, from the day the arm went live. Now only a real
venue call spends the budget; a regression test pins it (the old placement fails it).

**Mean-reversion has the only backtested edge among the non-lead-lag arms, and it is not being run.**
The 6c/10-minute move audit over 17.9M candles (§52) graded +2.2 to +3.6c/contract across 53,346
signals. Live: **12 entries in 11 days**, +$19.18 app-attributed, of which +$22.33 is the LALIGA ticket.
The momentum recorder, reading the **same** candle feed and market list, saw **154 qualifying setups on 42
tickers on 09-17 and 132 on 35 tickers on 09-18**; the arm entered once. The signals are generated and
then vetoed - and `stats.vetoed` (1,987,623 against 4,235 approvals, ~67 a scan) recorded neither which
strategy nor why. A per-strategy gate tally now prints every 50 scans. **Its first line (17:28Z, 50 scans):**

| Strategy | Generated | Vetoed | Reason |
|---|---|---|---|
| fade | 2,611 | 2,609 | long-horizon slots full x2,436; event/order already resting x167 |
| consensus | 111 | 111 | long-horizon slots full x111 |
| volume-spike | 69 | 69 | long-horizon slots full x69 |
| mean-reversion | 34 | 34 | weather series: maker seat measured negative x34 |

Two findings. **Mean-reversion's live setups are weather brackets, and a gate from the quoter's retirement
refuses maker entries on weather because that seat measured -1.70c/contract over 801,258 contracts.** That
gate is correct; what it exposes is that §52's +2.2 to +3.6c was a TAKER backtest at the post-move price,
and the live arm rests a MAKER order - the edge was never on the seat the arm uses. Worse, `classify.ts:97`
records that the Becker dataset behind that backtest contains **zero weather rows**: the only setups the live
arm finds are on the one series family its evidence never covered. The recorder also sees
non-weather setups (KXBTCD, KXETHD, KXWTI daily brackets, ~25 tickers/day) on which the arm generated
nothing in this window; tomorrow's tallies say whether those ever reach it. **The long-horizon cap (4
slots, `maxLongHorizonPositions`) is held by six consensus positions** - one of them an NCAA 2027 market
198 days out, opened before the 21-day ceiling - so fade, consensus and volume-spike cannot take any market
more than 24 h from close. That cap is the operator's ("lockdown intent" in the code); it is reported, not
changed.

**Sports-anchor** (The Odds API feed): 11 trades, 1 win, -$5.64. **Volume-spike** on sports: 24 markets,
+$0.39. **Momentum**: disabled at the -$5 stop.

**What this says to do for sports.** Nothing here was a winning process that we changed away from.
The order is: (1) let consensus evaluate its whole pool - done; (2) read the gate tally and unblock
mean-reversion, the one arm with a measured prior; (3) stop treating tennis as evidence; (4) judge
consensus's category mix at its next ladder checkpoint against the grader, not against our 59 fills.

## 7. What this says to do

1. **Lead-lag is the only arm with a measured edge, and the edge is latency.** Every future
   change to it should be judged first on what it does to sweep latency, and second on what
   it does to per-contract net at the day's contract count (capacity).
2. **Period A's +8.94c is the target, not a fluke to be explained away.** Everything that
   was true in period A (fast path, small size) is true again, and two things are better
   (live quotes, no cap reads). The gap between A's +8.94c and D's +1.97c is unexplained on
   283 contracts over two days; it needs a week. Coin count is NOT the lever: in era D the
   added coins ran +2.44c against BTC/ETH's -0.51c, and in era B+C both were negative. More
   coins with a real Polymarket 15-minute twin means more independent shots at the same
   per-contract edge, not more contracts pushed into one market. What the daily table does
   suggest is a capacity limit: +8c to +21c on 10-90 contract days, +7c at 516, negative or
   flat at 677-1,765 (confounded with the latency breakage, but the hypothesis to test).
3. **Do not raise size before latency is proven stable at the new poll rate.** The 09-12
   sizing increase is the single clearest before/after in the record: +12.0c -> +1.7c on
   unchanged coins and cadence.
4. ETH and HYPE are negative on both graded signal and fills in the new era; verdict due
   2026-09-21 (backlog 137).

---

## Amendment 2026-09-19 (external review, REVIEW-CHANGES §127)

Five independent model reviews of the public repository each named §7 item 2 - "Period A's +8.94c is the
target, not a fluke" - as the single belief in this record most likely to be wrong. Their argument holds:
period A's boundary was drawn after the fact; its gaps were measured against the same stale list quote that
generated the trade; four other things changed at its edges (coins, cadence, size, quote source); and the honest
orderbook era grades +1.35c signal / +1.86c realized, a fifth of it. The supported statement is narrower:
low execution latency appears NECESSARY for lead-lag to earn; nothing here shows it is SUFFICIENT to recover
+8.94c. Item 2 is withdrawn. Period A is recorded as a regime. The forward planning number for lead-lag is
**+1.5c/contract** (handbook §12.17), and no sizing or cadence change is judged against +8.94c.
