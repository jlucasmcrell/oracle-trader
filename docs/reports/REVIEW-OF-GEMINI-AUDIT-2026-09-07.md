# Review of SYSTEM-AUDIT-STRATEGY-REPORT-2026-09-07 (Gemini)

Reviewed 2026-09-07 ~09:00 UTC against the code at commit state POST-round28 and the live venue dumps. Maintenance sessions: read this before acting on the Gemini report; several of its recommendations are wrong or already done.

## Part 1 claims (bugs)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1.1 | PolyUS commissions on settled markets dropped from realized P&L | CONFIRMED, small | engine.ts:402-410 skips fills on settled markets for every venue; PolyUS settlements carry fee 0; the venue's `realized` is gross (a 2-contract 42c win resolved to +1.16). Bound: $1.43 of commissions on record lifetime (passive fills pay 0; takers 1-2c/contract). One-line venue condition. |
| 1.2 | Post-only cross throws past the taker fallback | CONFIRMED as a code gap, UNOBSERVED | `executeMakerEntry` does not catch `placeOrder`; a 4xx would skip the taker path and tick `liveErrorStreak`; an accepted-then-cancelled order would be recorded as a rest. 28 rests, 0 rejects, 0 streak alerts, no post-only 400s in the log. Cheap to fix. |
| 1.3 | METAR daily peak resets at the UTC rollover | CODE CONFIRMED, IMPACT WRONG | noaaMetar.ts keys the peak by UTC date, but its only consumer is the LLM vetting text (vetting.ts). The quoter's banked extreme and the settlement ratchet read Kalshi's minute temperature index filtered to the station's measurement day (autoTrader.ts:1370-1380, quoter.ts refreshIndex). No strategy prices off it. |
| 1.4 | Reconciler drops later partial fills of a placed order | CODE CONFIRMED, NARROW | Placement records exist only when shares traded at placement; IOC/FOK remainders are cancelled, GTC rests write no placement record. Only a GTC order filling partly at placement and partly later is affected, which post-only prevents. 72 fills skipped as placement duplicates lifetime; ledger holds 1385 Kalshi shares vs 1348 at the venue, so no undercount today. Cheap refinement (skip by fill id and shares). |
| 1.5 | `yes_count_fp` needs an integer fallback | THEORETICAL | All 206 settlements since Aug 28 carry `_fp`; none carry `yes_count`. Harmless one-liner. Note the paired-revenue math the report quotes is already correct and is why the app's day figure was right on 2026-09-07. |
| 1.6 | Manifold account cached forever | CONFIRMED | manifold.ts:197. Play money; the panel shows the startup balance. Trivial. |
| 1.7 | Quoter cannot join the best bid | CONFIRMED in both paths | quoteAroundFair and the reservation clamp at quoter.ts:940-942 each require a 1c improvement. Joining keeps the margin and posts on tight books. Worth doing. The report's "no continuous inventory skew" is wrong: a 1c-per-contract lean already exists (a crude Avellaneda-Stoikov with the risk term folded into a constant). |

## Part 2-3 claims (API capabilities)

- Order groups "unused": WRONG. kalshi.ts ensureOrderGroup attaches every bot order to a per-shard group with a 500-contract/15 s limit as a runaway-loop breaker. The report's 10-contract limit would have cancelled every rest the moment the anchor's 16-contract order filled.
- `cancel_order_on_pause`: WRONG, already set on every resting order (kalshi.ts:862).
- Private WebSocket fill channel: RIGHT, unused (only `orderbook_delta`, in shadow). Reconciler runs every 5 min, not 3; the pending-order sweep runs every scan. A latency improvement for the quoter, not a bug.
- Subaccounts: RIGHT, unused (only in the transfer body). Collateral for weather is already isolated by the shard top-up; attribution already comes from the strategy-tagged ledger. Not worth the transfers now.
- Polymarket Global CLOB trading: NON-STARTER. Not available to US persons; the app is on Polymarket US for that reason. The global CLOB is used as a signal by lead-lag, which is the right use.
- Manifold WS / liquidity provision: play money, skip.
- In-play sports within 1 s: NOT FEASIBLE on our data. The Odds API and SGO are polled REST; the paid plan gives a 10-min in-play cadence on 645 credits/day. Kalshi in-play books are where the sharps sit.
- HRRR: PLAUSIBLE, UNPROVEN. Raw GRIB2 is heavy; Open-Meteo serves HRRR-based hourlies free for non-commercial use (fits the free-tier rule). Shadow-compare against the NWS hourly on settled highs for two weeks before believing "2 hours ahead".
- BRTI: RIGHT on the fact. KXBTCD rules: "simple average of the sixty seconds of CF Benchmarks' BRTI before 5 PM EDT". Convergence uses Coinbase spot (a BRTI constituent); a 60-second Coinbase mean near the strike is the free approximation.
- OpenRouter "15 min to 30 s": WRONG. The review already runs JSON mode; the last one took 38 s.
- Dutch book FOK: ALREADY BUILT (dutchBook.ts:334 fill_or_kill legs); 656 scans overnight found 0 slates, so "frequently below 0.96" does not hold at our size.
- Fee arithmetic (4.1): RIGHT, and consistent with the ladder's verdicts (taker strategies on thin edges get stopped).

## What the report missed

The four real defects found on 2026-09-07 were elsewhere: cross-sport anchor matching (traded once), a zero-width confidence band from one-cluster SE, lead-lag never recording executed sweeps for the ladder, and stopped strategies' rests staying live. Also from the overnight log: the hunch forecaster failed 30+ times per hour on OpenRouter credits and has no Ollama fallback (hunch.ts askModel).

## Recommendation

Do (cheap, confirmed): 1.2 try/catch plus treat a cancelled post-only as a reject; 1.1 venue-conditional fee; 1.7 join the queue in both paths; 1.4 skip by fill id; 1.6; 1.5; hunch Ollama fallback.
Shadow first: Open-Meteo HRRR vs NWS; BRTI-style 60 s average for convergence; private fill channel for the quoter.
Decline: 10-contract order group; subaccount partitioning; Polymarket Global trading; sub-second in-play sniping; an Avellaneda-Stoikov rewrite before the quoter shows a positive checkpoint.
