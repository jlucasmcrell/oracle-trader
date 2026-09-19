# Research program, 2026-09-18: all three venues, what is tested, what is not, what to do

Operator brief: "improve Polymarket and IBKR strategies and paper tests; go through them all; any strategies
not yet tested across the three; comprehensive and robust; research." This is the inventory, the audit, and the
ranked list with a data source and a trigger for every item. Everything here is GET-only unless the ladder
promotes it; nothing here changes an arm, a size or a limit.

## 1. Where the evidence stands (2026-09-18)

| Venue | Live | Paper / shadow | Evidence with a sign |
|---|---|---|---|
| Kalshi | lead-lag (6c floor, 1 ct), fade (calibration-flat), consensus (flat, judged), volume-spike, sports-anchor (1/11), mean-reversion (taker retest) | cadence shadow, spot-first shadow, momentum recorder, cull gate, weather books (new) | **Lead-lag is the only arm with a measured edge**: +8.94c/contract in its winning era, entirely from gaps >= 6c; +1.35c graded / +1.86c filled on honest quotes since 09-17. Everything else is flat or negative. |
| Polymarket US | every arm on operator hold | 8-arm paper lab (join, improve, momentum, reversion, pressure, longshot/favorite controls, alternating benchmark) | 2 closed trades under current rules. The lab tracked **12 of 791 candidates** because the catalog walk saw 3,000 of 80,000+ rows (fixed today, §118). |
| IBKR ForecastEx | unfunded | 23-arm paper lab (list in ibkrSignals.ts) | 38 closed under current rules; every held arm is waiting on settlement. |

## 2. Venue mechanics, verified from the venues today

- **Polymarket US** (docs.polymarket.us/fees): taker fee `0.0695 x C x p(1-p)`; **maker rebate `0.0125 x C x p(1-p)` paid at
  trade**; taker-fee rebates from $250k/month volume (not us). **Liquidity Incentive Program**: every second a random
  book snapshot scores each resting order `discount^ticks_from_best x size`; pools per market and time period at
  polymarket.us/rewards. The paper lab's `join`/`improve` arms assume **no rebate and no LIP** - they understate
  the maker seat by the rebate at minimum (0.31c/contract at 50c).
- **ForecastEx / IBKR**: $0 commission + **$0.01/contract exchange fee** (the lab's `fee=.01` is right); monthly
  **incentive coupons on the closing value of held contracts, paid regardless of outcome** - i.e. interest on
  position value while you wait. The lab excludes it. The rate is not published on forecastex.com; IBKR passes it
  through. For the hold-to-settlement arms it is the venue's one structural gift; item 152 models it once the
  rate is confirmed from the account's own coupon postings.
- **Kalshi**: taker `0.07 x C x p(1-p)` ceiled to $0.0001 per order (96.5% exact match on our fills); maker 0 on plain
  `quadratic` series; `/markets` list is cached (§111), only `/orderbook` is live.

## 3. Audit: the arms as built

**IBKR (23 arms, ibkrSignals.ts read in full).** Rules are coherent and venue-aware: fresh-quote gate (30 s),
paired-book synthetic bid/ask (ForecastEx has no trade prints), passive limits 2c inside the ask needing a real
trade-through, hold-to-settlement for the calibration family with a 60-day horizon cap, round-trip admission only for
timed arms, Weather Underground settlement basis explicitly retained for the NWS-driven weather arms. Nine
strategies are correctly marked not applicable (no prints, no wallets, no sports, no mention instruments).
Gaps: (a) **coupon yield** (above); (b) **the same-event cross-venue family is absent** - `cross-venue` is marked
unavailable because it was defined as 15-minute crypto, but ForecastEx lists Fed funds, CPI, unemployment,
GDP, initial claims, elections, daily crypto strikes and temperature thresholds at LAX/PHX/BOS/DEN/SO that
Kalshi also lists; (c) `calibration` applies one 1.15 log-odds slope to every category - the Becker slopes are
category-specific (politics compressed, sports not), so this arm is testing an average that may hold nowhere.

**Polymarket US (8 arms).** All microstructure or controls, all priced as if the venue paid makers nothing.
Gaps: (a) rebate/LIP in the maker accounting; (b) **no cross-venue arm** on a venue whose 80k markets are mostly
the same games and races Kalshi lists; (c) **no consensus arm** although the shadow already matches 1,947
signals to Polymarket US and grades them +4.10c/contract net of fee (band includes zero); (d) **no sports-anchor**
although The Odds API feed is paid for and the Kalshi anchor's matcher exists; (e) coverage - fixed today.

**Kalshi.** The taxonomy (STRATEGY-TAXONOMY-2026-09-14.md, A-H) stands. Today's additions: the gap floor (§115),
the endgame exception as a shadow read (147), capacity as the variable behind the 10 s loss (§114), consensus
judged flat (§112/§117), weather closed with a modal-bracket caveat (§116/§117), mean-reversion re-run as a taker.

## 4. What the 0.1% do, and what of it is reachable

The audited large winners on these venues are (i) latency arbitrage between venues and against spot, run by
capitalised bots; (ii) forecast owners with data the market lacks (weather balloons, proprietary models);
(iii) market makers paid by venue incentive programs who manage queue position and adverse selection. Retail
"strategies" (favourite bias, momentum, fading longshots) are the ones our ledgers show earning pennies, and the
literature agrees. Reachable for us, in order: (i) on the 15-minute crypto windows (running; the edge is speed
and gap size), (i) again on **same-event pairs across our own three venues**, which nobody in the app has
measured, and (iii) on Polymarket US where the venue pays makers - once mmsim's 10-17 read says the seat is not
adversely selected.

## 5. Ranked list, with source and trigger

1. **Polymarket US catalog index (§118, built).** Every short-dated market visible to the paper lab and the
   held live arms. Trigger 2026-09-20: `poly-paper` tracked count and candidates per scan.
2. **Same-event cross-venue shadow, Kalshi <-> ForecastEx (item 150).** Match by product: Fed funds / CPI /
   unemployment / claims / GDP strikes, elections, daily crypto strikes, temperature thresholds (ForecastEx
   "exceed X" = the sum of Kalshi brackets above X). Record both sides' top-of-book every 30 min from feeds we
   already have (IBKR lab quotes, weather books, Kalshi orderbooks); grade divergence vs each venue's result and
   who moves first. Read at 7 days. If ForecastEx lags Kalshi by hours on econ prints, that is a taker arm on
   the unfunded account; the size of the account is the operator's.
3. **Same-event cross-venue shadow, Kalshi <-> Polymarket US (item 151).** Sports games and politics on both.
   Needs the catalog index (1) and a team/event matcher; the sports-anchor matcher is the starting point.
   Same grading as (2). This is the only Polymarket US strategy family with a structural reason to exist.
4. **Polymarket US maker accounting (item 153).** Add the rebate to `join`/`improve` fills (documented formula), keep LIP
   out (needs the live schedule); re-baseline those two arms. Small, correct, and it stops understating the seat.
5. **Polymarket US consensus and sports-anchor paper arms (item 154).** Both signals exist; both are paper.
   Gate: after (1) has a week, so the arms see the whole venue.
6. **ForecastEx coupon in the IBKR lab (item 152).** Once the rate is known (first coupon posting on the real
   account, or IBKR's statement), accrue it on held positions. Changes which IBKR arms clear zero.
7. **Category-specific calibration slopes on IBKR (item 155).** Replace the single 1.15 with the Becker per-category
   slopes the Kalshi arm already uses; re-baseline `calibration`.
8. **Kalshi items already scheduled**: 6c floor judgment (146), endgame exception (147), ETH/HYPE (137), taker
   mean-reversion (145), gate tally (143), weather books first read (148), ECMWF ENS (149).

## 6. What this program will not do

No new live arm without a pre-registration, a shadow read with a sign, and the ladder's micro stage. No
subscription, deposit or key without the operator. No strategy that needs a forecast we do not have.

**2026-09-19 amendment.** Planning number for lead-lag is +1.5c/contract (handbook §12.17); +8.94c is a regime
figure and appears in no forward decision. Adding size anywhere on the ladder now needs the one-sided 95%
day-clustered band and >= 4 clusters (§12.14); 80% admits to tiny-live only.
