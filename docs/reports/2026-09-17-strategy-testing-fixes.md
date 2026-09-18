# Strategy testing fixes — 2026-09-17

Round 114. Deployed 07:31:43 UTC (Electron start later than the 07:31:26 UTC bundle). Every paper trade closed
before that time was produced under the old rules; read results after it separately.

## Summary

Both paper labs were running but mostly measuring trading costs, not the ideas they are named after. Their
exit and order rules were changed so each arm tests its own hypothesis. Nothing here touches live money:
Kalshi's configuration, sizes, arms and loss limits are unchanged, and both labs remain paper-only.

| Venue | Arms | Before | After |
|---|---|---|---|
| Polymarket US (paper) | 8 | 3 taker arms stopped on the next quote; 5 passive arms nearly never filled | Taker arms hold for their 15-minute window; settlement controls take the ask and hold; passive orders rest 30 min |
| IBKR ForecastEx (paper) | 23 | Nothing could reach settlement; 4 arms could never trade; 7 wins in 163 | 14 settlement arms hold to the exchange result; calibration and political arms reachable; model forecasts used |
| Kalshi (live) | 13 enabled | Healthy; 3 arms rarely or never trade | Unchanged (see "Not changed") |

## What was wrong and what changed

### Polymarket US paper lab (`src/main/strategies/polyPaper.ts`)

1. **Taker arms were stopped before they could be tested.** Entry pays the ask plus 1c, the position is valued at
   the bid minus 1c, and a fee applies both ways. That round trip alone is worse than the −5c stop, so momentum,
   reversion and the benchmark were closed on the very next quote. Stops and targets are now measured from the
   position's value at the moment it filled, so only a real price move triggers them.
   Before: momentum 3/3 stopped, reversion 3/3, benchmark 116/165, median hold 1 minute.
2. **Longshot and favorite controls never filled.** Their thesis is the settlement bias, but they rested at the bid
   and needed the price to trade through them within 10 minutes. They now buy at the ask and hold to settlement.
   Before: 0 fills, although their conditions appeared in 487 and 554 of 5,432 recorded quotes.
3. **Passive orders expired too soon.** Join, improve and book-pressure orders now rest 30 minutes instead of 10.
   Before: 3 fills from hundreds of orders.

### IBKR paper lab (`src/main/strategies/ibkrLab.ts`, `ibkrSignals.ts`)

1. **No position could reach settlement.** Every position was closed at +5c, −8c, after one hour, or 10 minutes
   before close. Settlement arms now hold to the published ForecastEx result: fade, favorite, calibration,
   political-favorite, fade-maker, ladder-value, spot-first, convergence, news, market-conditioned, the three
   weather arms and the benchmark. They only enter contracts that expire within 60 days, and they get 12 slots
   instead of 4 so held positions do not block new entries. The same hold applies to any future live position.
   Before: fade 0/25 (median hold 2 min), favorite 0/31; one position in 163 ever settled.
2. **Timed arms were stopped by one tick.** Entries were admitted with up to 8c of round-trip cost, so a one-tick
   move after entry hit the −8c stop. Momentum, log-momentum, reversion, breakout, book-imbalance, microprice and
   maker keep their timed exits, now measured from the fill-time value.
3. **Convergence could never express its thesis.** It enters 2–6 minutes before close, and the 10-minute pre-close
   exit sold it immediately. It now holds to settlement.
4. **Calibration and political-favorite could never fire.** A 1.15 log-odds slope moves fair value at most about
   3c from mid, and the rule required 3c beyond the ask. The best edge on 29,601 real quote snapshots was 0.62c.
   They now enter when the recalibrated value is at least 0.5c above the ask and are judged at settlement, net of
   costs. The old reachability test passed only because it used zero and negative spreads.
5. **Model forecasts were thrown away.** News and market-conditioned used a model call that also decides whether to
   recommend a trade; it declined all eight, and the lab discarded the probability with the veto. The probability
   is now kept and tested. Note that today's eight-call budget was already spent, so these two arms start trading
   tomorrow.
6. **Passive arms almost never filled.** Maker orders rested 3c inside the ask for 10 minutes and needed a 4c fall
   to fill. They now rest 2c inside for 60 minutes. Before: maker 2 fills from 260 orders, fade-maker 0 from 98,
   weather-maker 0 from 18.
7. **A partial market discovery froze a truncated universe for six hours.** If some products fail mid-walk, their
   previous contracts are kept and discovery retries in 30 minutes. This fired in production at 07:35 UTC: two
   products failed and their contracts were kept.

### IBKR reconciler log noise (`src/main/store/fillReconciler.ts`)

With the gateway down, the reconciler logged the same failure every minute (209 lines in 3.5 hours). A repeated
identical failure is now logged at most every 10 minutes.

## Verification

- **Tests.** 16 suites pass: review-fixes 485, ladder 126, adversarial 89, risk-controls 14, remaining-defects 11,
  completion 15, model-usage, config-migration, ibkr, ibkr-execution, ibkr-lab, poly-paper, execution-quality,
  collection-integrity, venue-pnl. Typecheck and production build are clean.
- **New assertions.** 14 were added for these fixes. Each fix was removed in turn and its suite failed; every source
  was restored byte for byte. Receipts: `tmp/testout/*-round114*.txt`, `tmp/testout/mutants-round114.txt`.
- **Existing tests.** Four expectations encoded the old behaviour and were updated: the loss-stop admission and the
  opposing-ask exit fixture now use a timed arm, the declined-forecast test now expects the probability to be
  kept, and the live partial-exit test now shows a held arm is not exited.
- **Production, first 6 minutes.** IBKR placed new held entries for fade, favorite, benchmark and ladder-value, with
  no stops fired. Polymarket filled its first longshot (NO at 9c) and favorite (YES at 94c) at the ask, both holding.
  Passive orders now show a 30-minute life. There were no new errors apart from Polymarket 429s on public books,
  which back off as designed.
- **Safety.** No orders were placed, amended or cancelled by hand. No key, arm, size, loss limit, ladder stage or
  operator hold was changed. Backup: `oracle-trader-PRE-lab-fixes-2026-09-17-*.zip`.

## Not changed, and why

- **Kalshi news and cross-venue.** Both are implemented as designed and simply almost never qualify. News needs a
  headline from the last 30 minutes sharing a quarter of its words with a market title: one trade ever.
  Cross-venue compares Polymarket.com prices that lag by minutes: zero trades ever. Our own taxonomy already
  judged both ideas not worth building further. Making them trade means designing new strategies with live money,
  which is a decision for you, not a bug fix. Retiring them would only tidy the ladder.
- **Kalshi volume-spike** is often refused a slot by the long-horizon cap. That is the cap working as intended.
- **Kalshi Dutch-book** finds no arbitrage because none exists at executable prices. That is a valid result.
- **Lead-lag** stays stopped by the ladder until 2026-09-19 and will re-enter at one contract.

## What to watch

| When | What |
|---|---|
| From today | Polymarket taker arms show holds near 15 minutes; longshot/favorite settle within 72 hours |
| From tomorrow | IBKR news and market-conditioned begin using model forecasts |
| Daily | IBKR weather and crypto held positions settle daily; the settlement importer runs hourly |
| First week | IBKR maker, fade-maker and weather-maker should start filling under the longer life |
| Nov 2026 | Political-favorite results arrive when the election contracts settle |
| Ongoing | Paper results are screening evidence only; no lab promotes anything to live on its own |
