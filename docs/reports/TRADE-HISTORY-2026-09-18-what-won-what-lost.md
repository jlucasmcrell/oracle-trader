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
   looked like 10c were often 0c. This did not change on 09-12, but it is why the recorded
   "signal" stayed strongly positive through the losing streak: the measurement and the
   trade shared the same wrong price.

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

## 6. The other arms, briefly

- **fade** (+$8.18, 243 trades, 95% wins) - calibration z = **+0.15**: it wins exactly as
  often as its 0.95 entry prices imply. No edge; the profit is inside noise (t=1.99).
- **mean-reversion** (+$19.18 on 14 trades) - two outlier markets (LALIGA +$22, ATP +$10).
  Variance, not evidence.
- **weather maker** (-$45.97) - retired 09-09 after the seat measured -1.70c/contract over
  801,258 venue-wide contracts. Correctly dead.
- **book-imbalance** (-$12.42), **momentum** (-$10.63), **volume-spike** (-$4.80),
  **sports-anchor** (-$5.64), **flow-follow** (-$3.20) - all negative, all small.

## 7. What this says to do

1. **Lead-lag is the only arm with a measured edge, and the edge is latency.** Every future
   change to it should be judged first on what it does to sweep latency.
2. **Period A's +8.94c is not recoverable by copying period A's config**, because period A
   was also trading against cached quotes. What is recoverable is its discipline: few coins,
   small size, fastest possible path. The honest baseline is today's +1.35c graded / +1.86c
   filled.
3. **Do not raise size before latency is proven stable at the new poll rate.** The 09-12
   sizing increase is the single clearest before/after in the record: +12.0c -> +1.7c on
   unchanged coins and cadence.
4. ETH and HYPE are negative on both graded signal and fills in the new era; verdict due
   2026-09-21 (backlog 137).
