# Degraded windows — periods the record must not be read as evidence

Times when the account was trading under a configuration later judged broken. Settlements inside a window are
**real money** and stay in every P&L total; what they are not is evidence about a strategy's edge, because the
thing being measured was not the thing intended to run.

Any read that spans one of these says so, and reports the excluded and included halves separately. The machine
copy is `scripts/backtests/degraded.py` (`WINDOWS`, `label(ts_ms)`), which the read scripts consult; the nightly
review is handed the same list in its evidence packet. Keep the two files in step.

| # | From (UTC) | To (UTC) | What was wrong | What ended it |
|---|---|---|---|---|
| 1 | 2026-09-12 12:46 | 2026-09-17 08:07 | **Kalshi order path slow, and lead-lag sized for independence it did not have.** Round 76 put two venue account reads in front of every order: sweep latency 0.07 s → 0.44 s, and fills flipped from +18.4c/contract to +0.2c (§108). Round 91 (09-13 10:05Z) then ran lead-lag at a 10 s poll, seven coins, 8 contracts each; latency reached 14 s. Seven coins on one 15-minute window is one bet on crypto direction taken seven times: 49 fills lost **-$31.28** in 90 minutes and tripped the daily kill switch at a venue day of -$34.95 (§88). Round 93 cut the unproven coins to micro size at 11:38Z and the arms were held. Round 99 restored the winning-period settings at 09-16 07:35Z, but the order path was still 6.6 s median (§108). | Round 115, 09-17 08:07Z: separate read/write rate lanes, the position count served from memory, entries reserving inside the queue and submitting outside (§109). Lead-lag priced from the live orderbook from §111. |
| 2 | (start of record) | 2026-09-18 13:34 | **Fee model double-divided.** `netCentsOf` divided an already-per-contract fee by the contract count a second time, so every calibration number before the fix understated fees. Dollar P&L from fills and settlements was never affected. | v27 config migration cleared the calibration accumulators (`CALIB_CLEARED_AT` in `src/main/ladder/ladder.ts`). Window 2 therefore applies to **calibration/`netCents` readings only**, not to reads built from fills and public settlement results. |

## How to use it

- A read built from **fills + public settlement results** (the authoritative path) is affected by window 1 only.
- A read built from the app's **calibration ledger** (`calib.byStrategy[...].netCents`) is affected by both, and
  window 2 is already handled for it by the v27 clear.
- Do not delete or "correct" a window's trades. Split the read and show both halves; the degraded half is
  evidence about the configuration, not about the strategy.
- Adding a window: append here, add the same entry to `scripts/backtests/degraded.py`, and say in
  REVIEW-CHANGES which reads it invalidates.
