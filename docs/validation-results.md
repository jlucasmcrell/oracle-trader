# AutoTrader validation results — 2026-08-28 (overnight run)

Every verdict below comes from scripts in `scripts/` run against real Kalshi data
(live + `/historical/*`). Scripts: `backtest-fade.mjs`, `backtest-momentum.mjs`,
`backtest-volspike.mjs`, `backtest-dutch.mjs`, `backtest-settlement-proxy.mjs`,
`verify-crossvenue-overlap.mjs`, `diag-*.mjs` (data-shape investigations).

## Data-availability findings (hard-won, worth reading first)

1. **`/historical/markets` is dominated by multivariate (MVE) products** — the
   first ~80 pages are 85%+ `KXMVESPORTSMULTIGAMEEXTENDED` parlay shards.
   Without `mve_filter=exclude`, ANY historical analysis is garbage. Our first
   calibration (7,723 longshots, "0% YES") was contaminated this way; all
   numbers below use `mve_filter=exclude`.
2. **`/historical/markets` ends at the June-28 cutoff.** The last 2 months of
   settlements live on the LIVE endpoint `/markets?status=settled`
   (also needs `mve_filter=exclude`).
3. **Candle routing**: post-cutoff settled markets → live `/markets/candlesticks`
   (but SPARSE — only update-minutes, e.g. 4-8 candles per tennis market);
   pre-cutoff markets → `/historical/markets/{ticker}/candlesticks` (dense for
   some series, missing for others — ~42% of longshots have whole-life candles).
   Old-format candles use `{close: "0.94"}` keys; new format uses `close_dollars`.
4. **No historical order books and no historical settlement index** — book
   imbalance and settlement convergence are forward-only (the app now logs the
   former automatically: "Book lab").
5. Script pitfall found and fixed: `return` inside a worker loop kills the
   worker (left ~99.8% of samples unprocessed); all workers now use `continue`.

## Verdicts

| Strategy | Verdict | Evidence |
|---|---|---|
| momentum | **FAIL — disabled by default** | n=120 signals (1,500 markets, 21 dense): hit rate 35.8%, mean forward move **−6.6¢** (10-min moves mean-revert). Below the 4¢ round-trip hurdle by a wide margin. |
| volume-spike | **disabled (never fires)** | Zero signals in every live snapshot AND across 150 volume-bearing settled markets with production thresholds. Needs retuning before it matters. |
| cross-venue | **FAIL — disabled by default** | Live overlap discovery: 0/40 markets matched (40/40 lacked an asset keyword for Gamma; strike/time ladders don't overlap). Coverage pass bar was 5%. |
| book-imbalance | **unvalidated — forward-only** | No historical books exist. "Book lab" logging is now live in the app (snapshot + 5-min forward move, read-only). Interpret in 1-2 weeks. |
| fade (longshot) | **promising — enabled as a paper experiment** | Clean-pool calibration (n≈2,400 at p<0.10): 0.1–0.3% YES vs 3.5–7.5% implied. Entry-level replay (T−1h, executable NO-ask, 1¢ fee): n=74 total across 3 runs, YES rate 0–3.5%, mean net edge +4.4¢ / +16.0¢ / +9.4¢, 73–79% positive. n is too small for the 1,000-observation pass bar — Kalshi's archive sparsity caps it. Treat live use as experimental. |
| dutch | **FAIL — disabled by default** | 104 mutually_exclusive events (12h pre-close candle window each): **zero** Σbids > 1.03 excursions; live scans also found none. The arb essentially never occurs on Kalshi. |
| settlement-convergence | **inconclusive (n=4-7), disabled** | Historical proxy: winning side was still 3-22¢ from certainty at T−30 in most usable observations — room for the edge may exist, but the sample is too small and the index isn't archived. Forward logging is the real test. |

## Defaults shipped after this run

`momentumEnabled=false`, `volumeSpikeEnabled=false`, `crossVenueEnabled=false`,
`dutchEnabled=false`, `fadeEnabled=true` (paper-only unless LIVE is armed),
`bookEnabled=true`, `bookLogging=true` (read-only lab), `newsEnabled=false`,
`settleEnabled=false`. A config-version migration applies these once to
existing installs without touching anything else.

## Scripts and data notes

- `scripts/lib/hist.mjs` encodes the routing/cutoff/key-format rules above.
- Calibration consistency across 4 clean-pool runs: p<0.05 → 0.0-0.1% YES
  (n=608-1,832); 0.05-0.10 → 0.0-0.6% (n=165-693); 0.10-0.20 → 0.0-0.6%;
  0.20-0.35 → 0.4-0.9%; 0.35-0.50 → 0.0-1.0%; 0.50-0.65 → 0.0-6.9%.
  Kalshi prices systematically OVERSTATE low probabilities in the settled
  record (and mildly understate 0.95-0.99 favorites in some runs).
