# Every prediction-market strategy, against our record (2026-09-14)

The operator asked for the complete list: everything one could do in a prediction market, which of it we have
tried, which we have not, why, and whether it is worth trying. Sources: three research lenses (academic and
quant literature; practitioner reports 2024-2026 split into six sub-searches; venue rulebooks and fee
schedules), nine Sonnet agents, ~1.1M tokens, every claim cited in their transcripts; plus our own ledgers
read today (trader perf by arm, ladder state, Polymarket US closed trades, every shadow instrument). Our
numbers are venue-currency dollars net of fees unless marked.

Standing constraints that shape every "worth it" verdict: US person; ~$142 equity; Kalshi and Polymarket US
(both CFTC, real money), Manifold (play money); Polymarket global is close-only for US persons and is a
SIGNAL, never a venue; free-tier data until profitable (exception: The Odds API); Windows desktop, no
colocation; every arm tested at micro size on the ladder and stopped by its stop rule.

Legend. TRIED = traded real or paper money with a verdict. RUNNING = live on the ladder now. SHADOW =
measuring without money, with a pre-registered read. DEAD = measured negative or not executable. NOT TRIED.

---

## A. Structural arbitrage (edge from prices that must satisfy an identity)

**A1. Intra-market YES+NO under $1.** TRIED, DEAD. The Dutch-book engine (`kalshi-dutch`, tiny-live, 0
trades) found same-event sums under one only at mids, never at executable prices with depth (backlog 70).
Literature agrees: an academic scan of Polymarket NBA found 7 executable episodes in 3,042 markets, median
life 3.6 s; two independent Kalshi scanners found nothing survives fees at retail size. Not worth retrying.

**A2. Logical implication (A implies B, so P(A) <= P(B)).** TRIED TODAY, DEAD on Kalshi's ladders:
`scripts/ladder_implication_scan.py`, 137,379 strike pairs over four days, 32 wrong-way before fees
(0.02%), 0 after fees (§89). The cross-event form ("wins division" implies "makes playoffs") is not
scanned; the literature's own follow-up found 62% of LLM-detected dependencies false on reading the rules,
and the remainder needed hours-long persistence in deep books. Not worth building at our size.

**A3. Cross-venue arbitrage (Kalshi vs Polymarket US vs global).** TRIED (PolyUS arb, 2026-09-02), DEAD.
Windows have compressed to ~2.7 s with most capture by sub-100 ms bots; it needs capital split across two
funded accounts and one leg can fill alone; the global book is close-only for us anyway. Not worth it.

**A4. Parlay / same-game correlation arbitrage vs sportsbooks.** NOT TRIED. Needs a sportsbook account as
the other leg, which is outside the venue set, and the edge is modelling intra-game correlation better than
the book. Not worth it here.

**A5. Multi-outcome collateral netting (NegRisk / mutually-exclusive NO baskets).** NOT TRIED as a
strategy; it is a capital-efficiency mechanic, not an edge. Kalshi nets same-market YES/NO and
mutually-exclusive-group NO. Worth using only when a basket strategy exists; none does.

**A6. Fee-tier arbitrage.** NOT APPLICABLE at our volume. Polymarket US rebates 10-50% of taker fees above
$250k a month; Kalshi's API tiers are volume-earned. Nothing to do at $142.

## B. Market making and liquidity provision (edge from being paid to rest)

**B1. Generic two-sided market making.** SHADOW, in a 35-day falsification run. Blanket MM on Kalshi's
thin ladders was measured dead on 09-02; the weather quoter lost $33.8 and is on operator hold; the
Polymarket US micro-maker went 49/50 for -$1.95 over eight days (band spans zero). `mmsim` runs to
2026-10-17 (363 simulated fills, 3 days, concentration guard flagged). The Stanford study of 41.6M Kalshi
trades finds adverse selection roughly twice as severe on single-name, fast contracts, and Kalshi's own
house maker runs at a loss. Verdict waits on the read; do not pre-empt it.

**B2. Maker seat on an existing directional edge (post-only entries).** TRIED, RUNNING. Fade v2 rests
maker orders (pre-registered 09-08); the Becker archive says the favourite side pays the maker +1.0 to
+3.4c and costs the taker. Kalshi's maker fee is ~1/4 of taker; Polymarket US pays makers a REBATE
(-1.25% coefficient) rather than charging them. Worth keeping; the venue fact below (F2) says a maker
strategy belongs on Polymarket US if anywhere, which our micro-maker test only half-exploited.

**B3. Liquidity Incentive Programme farming (Kalshi LIP).** NOT TRIED. Kalshi pays $1-$1,000 per market
per day for two-sided resting size from 100 contracts, scored by distance from a reference price; the app
already records the 200 active programmes daily. On a 5c market, 100 contracts a side is ~$5 of
collateral, inside our size. The failure mode is the same adverse selection as B1: reward-optimal quotes
sit where informed flow picks them off. WORTH A FEASIBILITY READ (build-queue 78): which live programmes
have target size <= 100 on markets priced under 10c or over 90c, what the daily pool pays per qualifying
side, and whether mmsim's fills on those markets would have covered the adverse selection. Money only
after that, pre-registered.

**B4. Polymarket global liquidity rewards / maker rebates.** NOT APPLICABLE (close-only venue).

**B5. Avellaneda-Stoikov inventory skew, VPIN-style toxicity filters.** NOT TRIED; both are refinements of
B1 and wait on mmsim's verdict (build-queue items 4 and 5 already gate on a positive quoter checkpoint).

## C. Behavioural and calibration edges (edge from systematic mispricing of probability)

**C1. Favourite-longshot bias: buy favourites, fade longshots.** TRIED, RUNNING as `kalshi-fade` (longshot
NO at 96-98c): lifetime 152 trades, 146 wins, +$10.80; tiny-live 99 settled since stage start, +$4.66;
Polymarket US fade 53 of 67 for +$0.18. This is the arithmetic the literature describes: one loss erases
~32 three-cent wins, so it wins almost always and earns almost nothing. The favourite leg was disabled on
evidence (08-31). The 588M-trade Polymarket study finds sub-10c YES buys lose ~19c per dollar and 90c+
buys earn ~0.8c; our cull-gate's first day showed the same shape (longshots 10-25c settle ~10c under
price, favourites above). Worth keeping at micro size; not a size-up candidate.

**C2. Calibration slope by domain (Wang transform / logistic recalibration).** SHADOW. `cull-gate.mjs`
records what the universe cull discards and fits lambda on settlements; first day lambda 0.51 on one
cluster, refused as a verdict; weekly run scheduled, read 09-19 with >= 5 settlement days. The 353M-trade
study explains 71.5% of out-of-sample variance in recalibration slopes by domain, horizon and size, and
isolates POLITICS as chronically compressed toward 50%. Our `calibratedYesRate()` asserts zero bias above
10c and has never been tested (backlog 68). WORTH TESTING OFFLINE NOW on the Becker archive by domain, then
against cull-gate (build-queue 79).

**C3. Political under-confidence fade (buy the side already above ~55-60% in political markets).** NOT
TRIED. A specific instance of C2 with the strongest published support. Politics is a small share of our
universe today and a true toss-up is genuinely 50%. Worth folding into C2's offline test rather than
building alone.

**C4. Contra-herd on single-name markets (retail overbuys YES on longshots that settle NO).** TRIED, as
the fade's NO leg on single-name events. The Stanford paper says this behavioural surplus is what pays
makers for adverse selection. Nothing new to build; it argues for keeping fade on single-name series.

**C5. Momentum / underreaction drift.** TRIED, DEAD twice. `kalshi-momentum` 54 trades, -$10.63, CLV
-2.9c, hard-stopped 09-07 and 09-13, cool-down to 09-27, demotion cap reached. The flat 3c bar buys the
top of a move at any price; the log-odds variant is being MEASURED, not traded (`momentum-candidates`,
read 09-21). On 15-minute crypto specifically the shadow reads -2.24c over 813 signals, band spans zero,
and a 4,904-strategy backtest found momentum variants regime-flip week to week. Not worth re-arming on the
current rule; the recorder decides whether any rule is worth a shadow.

**C6. Mean reversion on extremes.** TRIED, RUNNING at micro. `kalshi-mean-reversion` v3: 10 trades, 5/5,
+$18.28 lifetime, 4 settled since stage start -$3.54; the 15-minute variant is DEAD (11,846 rows, -2.56c;
the literature: 0 for 432 variants at 15 minutes, "not enough time to revert"). Worth keeping at micro on
the long horizon; never at 15 minutes.

**C7. Time-to-resolution convergence ("bond pulling to par").** TRIED as the BTCD near-settlement
convergence arm (pre-registered T-5, in-sample +2.75c, out-of-sample +2.4/+3.2c): live at micro, 1
settled, silenced by its own 95c cost ceiling (backlog 57). The literature calls this a description of a
correctly identified high-confidence position, not an edge. Worth leaving at micro; fix 57 when a day of
scan rows is in.

**C8. Convexity / lottery-ticket tail buying.** NOT TRIED, and C1 says the tail is the worst-measured side
of the book. Not worth it without an informational edge on the specific tail.

**C9. Reflexivity / focal-point trading.** NOT TRIED. Two theoretical preprints, no large-sample
measurement, self-defeating once traded. Not worth it.

## D. Information and forecasting edges (edge from a better probability than the price)

**D1. LLM forecaster vs market ("hunch").** SHADOW then live at micro. Anchor grading: 44 rows, Brier
0.063, ruleNet -$1.87 (09-08); challenger model added 09-12; paired read 09-18. Literature: the best LLM
forecasters sit at or just below the superforecaster median and above the crowd; human pros have won every
Metaculus season. Worth continuing exactly as pre-registered.

**D2. Market-conditioned prompting (LLM updates FROM the price as a prior, blended 0.7 market).**
NOT TRIED in that form. Measured on 856 real Kalshi mention markets: Brier 0.1392 vs 0.1402 raw market,
gains concentrated in intermediate-confidence markets. Our challenger sees the price but does not blend
this way. WORTH ONE VARIANT in the challenger after the 09-18 read (build-queue 80), scored by the same
paired grader.

**D3. Polymarket smart-money consensus as a Kalshi signal.** SHADOW then RUNNING. Built this morning by
the maintenance session (§90) at micro size: 692 rows over 7 days, +6.39c net per contract, 95% band
[+3.14, +10.19] day-clustered, includes zero when clustered by category. Kalshi-only as pre-registered.
Worth exactly what it is: a micro arm with a stop.

**D4. Whale / copy-trading.** TRIED on Manifold (the only venue that publishes positions), removed 08-31.
On Polymarket global the tooling exists but the venue is close-only for us, top-copied wallets are not
top performers, and ~25% of that venue's volume was wash trading. Not worth it.

**D5. Superforecasting discipline, base rates, outside view.** Not a strategy we can automate as such; it
is what D1-D3 and the pre-registration doctrine implement. No separate build.

**D6. Metaculus community forecast as an anchor.** SHADOW, collecting since 09-07 (66 pairs; token
confirmed in use today). Read when the pairs settle. Worth continuing.

**D7. Mention markets: transcript base rates, speed on live transcripts.** SHADOW (mention shadow: 467
strikes observed, first settlements today, >= 100 graded around 09-25). Literature: base-rate frequency
plus news salience beats intuition; live transcript bots poll every two minutes; the category is under a
CFTC probe after an insider case and sports mentions were pulled. Worth the shadow read; nothing live
before it.

**D8. Weather: ensemble / HRRR / climatology vs the station market.** TRIED, DEAD. Market mid Brier
0.0596 vs bias-corrected forecast 0.1232 over 164 city-date clusters (09-02); weather retired 09-09 after
the seat table showed the class we trade loses. Independent negative result in the literature: a LightGBM
model that beat its own NBM baseline still lost to Kalshi's mid after fees. HRRR shadow continues as
information only (revisit 09-21). Not worth re-arming.

**D9. Economics releases: pre-release ladder positioning vs consensus.** NOT TRIED. Kalshi's payrolls
ladder closes one minute before the release, so there is no post-release trade; the NBER paper finds
Kalshi already out-forecasts fed-funds futures and surveys, which argues against fading it. Not worth it
without a model that beats the ladder's own consensus.

**D10. Sports: devigged sharp lines (Pinnacle) vs Kalshi.** TRIED, DEAD. The sports anchor's out-of-sample
rule read -12.8c per contract over 42; the Kalshi-vs-Polymarket.com sports lag "fails correction, decays";
The Odds API is the one paid exception and it did not pay. `kalshi-sports-anchor` sits at micro with a
demotion. Literature: a public scanner found edges of 0.9% and 0.75% across 266 live games, "unattainable
after fee loads". Not worth more.

**D11. Player props via usage-vs-narrative divergence.** NOT TRIED. Qualitative claims only, thin books,
needs a projection model. Not worth it at this size.

**D12. Entertainment: guild precursors and aggregate forecasts for awards markets.** NOT TRIED. Seasonal
(January to March), no infrastructure, strong documented precursor signals (DGA matches Best Director 16
of 18 years). WORTH A PRE-REGISTERED SEASONAL RULE at micro size when the season opens (build-queue 81).

**D13. Politics: poll aggregators, early-vote data.** NOT TRIED. No quantified practitioner result found;
documented cases of markets and polls being wrong together. Not worth it as a standalone; C2/C3 cover the
measurable part.

**D14. Sentiment / social-signal trading.** NOT TRIED. X API access is not free; regime-unstable. Not
worth it.

**D15. Event-driven pre-positioning on scheduled announcements.** NOT TRIED beyond what D9 says. Same
verdict as D9.

## E. Latency and microstructure edges (edge from being faster than the venue's repricing)

**E1. Cross-venue lead-lag on 15-minute crypto (Polymarket first, Kalshi second).** TRIED, RUNNING,
the only earner. Live x4 since 09-11: +$36 on 09-12 at 60 s and two coins; -$31 on 09-13 after the
seven-coin, 10 s expansion swept six coins the same way in two windows and tripped the daily kill (§88);
+$6.87 on 176 fills so far on 09-14 under the round-94 caps. Lifetime 1,763 filled against 3,971 IOCs
that filled nothing. Day-one read at midnight UTC (build-queue 60).

**E2. Spot-first fair value on 15-minute crypto (exchange ticks, no Polymarket in the loop).** NOT
TRIED at speed. THIS IS THE DOCUMENTED WINNER: the profiled wallets that turned hundreds into hundreds of
thousands stream Binance/Coinbase ticks and hit the prediction market before it reprices, with an edge
window of hundreds of milliseconds on Polymarket and three to seven seconds on Kalshi; a practitioner
backtest reports +1.2c per contract after taker fees over 28,496 signals with Black-Scholes fair value,
+1.4c with a jump-diffusion variant, and 68% of target contracts with no exit liquidity. Our earlier
"efficient, dead" verdict on this idea was taken at a 30-60 s poll and does not transfer. The spot feed
exists in `liveSpot.ts`. WORTH IT, in order: Kalshi socket (61), Polymarket socket (62), then the
spot-first shadow (63 / backlog 96). Polymarket has already added dynamic taker fees to curb exactly this
on its venue; Kalshi has not.

**E3. Order-book imbalance.** TRIED as a TAKER arm, DEAD: `kalshi-book-imbalance` 37 trades, 11/26,
-$12.42, cool-down to 09-25 after two stops; Polymarket US 0 for 30, -$7.10. The literature's measured
version is a 55.5% hit rate at five minutes, which fees erase unless executed as a maker skew. WORTH
RETRYING ONLY as a maker-side signal inside B1/B2 after mmsim reads; never as a taker again.

**E4. Order-flow following ("large prints = knowledge").** TRIED, DEAD: `kalshi-flow-follow` 14 trades,
2/12, -$3.20, CLV -8.2c, operator hold. Not worth it.

**E5. Volume spikes.** TRIED, DEAD-ish: `kalshi-volume-spike` 34 trades, 14/20, -$5.12; re-entered at
micro after cool-down by the ladder's timer; 8 settled since, -$1.39. Let the ladder finish it.

**E6. News-latency bots on breaking news.** TRIED as `kalshi-news` (1 trade), effectively untested;
literature: paid wire feeds beat free ones by the seconds that matter. Not worth building further.

**E7. Late-expiry "sure thing" scalping (buy 93-97c in the last minutes).** NOT TRIED as such, and DEAD by
the literature and by our fade arithmetic: an 85c entry needs an 85% win rate to break even and the
practitioner who tested it lost. Not worth it.

**E8. In-play sports latency.** NOT TRIED. Betfair enforces in-play delays specifically to kill it; Kalshi
in-play needs feeds we do not have. Not worth it.

**E9. Settlement-window manipulation avoidance.** APPLIED implicitly: we trade Kalshi's 15-minute series,
which settle on a 60-second average of a regulated index; the paper finds manipulation concentrated in
5-minute contracts. Worth keeping as a "which contract" rule: never the 5-minute rung.

## F. Venue, rules and yield (edge from the venue's own mechanics)

**F1. Interest on collateral.** NOT USED. Kalshi pays a variable 3.25-4% APY on the whole portfolio,
including the marked value of open positions, above a $250 balance. We hold $142, so every idle dollar
earns nothing. This is a DEPOSIT decision and deposits are the operator's; recorded as such (backlog 82).

**F2. Fee geometry across venues.** KNOWN, partly unexploited. Kalshi taker 7% x P(1-P), maker ~1.75%;
Polymarket US taker 6%, maker REBATE 1.25%. Any maker strategy that survives mmsim is worth more on
Polymarket US than on Kalshi. Recorded against mmsim's 10-17 read (build-queue 77 covers the Kalshi LIP
side; this is the US side).

**F3. Settlement reference basis on the 15-minute crypto windows.** NOT MODELLED, and it matters for E1.
Kalshi settles on a 60-second average of CF Benchmarks' real-time index; Polymarket settles on a
60-second Chainlink TWAP. The "same" window can resolve differently when the two indices' baskets diverge
in that minute. Lead-lag treats them as one contract. WORTH MEASURING from public results on both venues
(build-queue 83): how often do matched windows resolve differently, and did any of our losing windows?

**F4. Fractional contracts.** IN USE (a 1.74-contract fill today). Nothing to do.

**F5. Order groups as a hard risk circuit-breaker.** NOT USED. Kalshi cancels every order in a group and
locks it when a matched-contracts cap trips over 15 seconds. Our window caps do this in software; the
venue-side version would survive a bug in ours. Worth a small build after the sockets, not before.

**F6. Timezone / rollover timing.** APPLIED (daily brakes roll at 00:00 UTC, backlog 52 notes the ET
mismatch). No edge here, only a correctness item.

**F7. Resolution-rule exploitation and oracle plays (UMA).** NOT APPLICABLE on Kalshi (exchange-determined
against named sources); Polymarket global's token-vote oracle has flipped $7M and $85M markets and is not
our venue. Signal-only consequence: a Polymarket price near a disputed resolution is not information.

**F8. Manifold mana, loans, leagues.** Play money; the loans are free leverage on nothing. We use Manifold
as a plumbing test only. Nothing to do.

## G. Money-management overlays (not edges)

**G1. Kelly / fractional sizing with correlation pooling.** APPLIED in spirit: the ladder sizes by
checkpoint, the window caps pool the seven crypto coins as ONE bet after 09-13, and the daily kill reads
20% of equity. The literature's specific warning, that correlated positions must be sized as one, is the
lesson §88 paid for.

**G2. Pre-registration, day-clustered bands, no verdict under five days / a hundred decisions.** APPLIED
everywhere since 09-06. It is the reason most rows above say DEAD instead of "promising".

## H. Prohibited or disqualifying (listed so nobody wonders)

Insider information (the teleprompter and pre-taped-show cases are under CFTC probe); settlement
manipulation; multi-accounting and airdrop wash trading (bans, and 25% of Polymarket's volume was fake);
VPN around the global geoblock; trading on non-public data of any kind. None of these is a strategy.

---

## What we might be missing: the honest shortlist

Ranked by evidence times feasibility at $142, free data, no colocation.

1. **Spot-first on the 15-minute crypto markets (E2).** The one family with documented large winners, a
   documented three-to-seven-second window on Kalshi specifically, and a feed we already have. Our version
   watches the second follower. Sockets first (61, 62), then the shadow (63). This is the biggest thing on
   the list and it is already queued.
2. **Domain calibration slopes, especially political under-confidence (C2, C3).** Free, offline, the
   largest studies in the field behind it, and our own instrument reads on 09-19. Queue 79.
3. **Kalshi liquidity incentives at our size (B3).** A real subsidy the app already records, within reach
   on cheap markets, and the same adverse-selection question mmsim is answering. Feasibility read first.
   Queue 78.
4. **Maker on Polymarket US rather than Kalshi (F2).** If mmsim passes, the venue that pays makers is the
   one to try it on. Bound to the 10-17 read.
5. **Market-conditioned prompting in the challenger (D2).** One measured method, one variant, one paired
   grader. Queue 80, after 09-18.
6. **Awards season (D12).** Cheap, seasonal, well-documented precursors. Queue 81, pre-register in January.
7. **The settlement basis under lead-lag (F3).** Not an edge; a risk we run blind. Queue 83.
8. **Interest on the balance (F1).** $108 more on deposit turns the idle account into a ~4% instrument.
   Operator's call, recorded.

Everything else on the list is either running, measuring with a fixed read date, or measured dead by us or
by the literature at our size. The pattern in the outside evidence is worth stating plainly: the strategies
with audited, large results are latency strategies run by capitalised bots, and the strategies retail
guides sell are the ones our ledgers already show earning pennies. The list is not missing a category. It
is missing speed on the one category that pays, and that is the work already in the queue.
