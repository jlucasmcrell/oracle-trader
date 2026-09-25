// Which Windows-task recorders the sentinel watches for staleness, and the rule that decides it.
//
// This lives outside scripts/sentinel.mjs because that file runs a full live tick on import (by
// design - it is a script, not a module), so the table could not otherwise be asserted by a test.
//
// The distinction the table encodes: an HOURLY task may legitimately be 60 minutes old, so 130
// minutes is the default before it counts as stale. A CONTINUOUS recorder is a task that starts a
// process which then lives for days and writes a heartbeat every few minutes; giving it the hourly
// allowance hides most of a dead day. The spot-first recorder died at 2026-09-18T13:34Z and nothing
// noticed for 2 h 07 m, four days before its pre-registered 2026-09-21 verdict - which is why the
// threshold is per row rather than one constant.

export const MIN = 60_000
export const DEFAULT_STALE_MS = 130 * MIN

/** [key, repo-relative file whose mtime is the liveness signal, Windows task name, staleMs?] */
export const TASK_WATCH = [
  ['hrrr-stale', 'data/hrrr-shadow/forecasts.jsonl', 'OracleTrader-HrrrShadow'],
  ['metaculus-stale', 'data/metaculus-shadow/last-mc.json', 'OracleTrader-MetaculusShadow'],
  // Retired 2026-09-23 (section 163), their tasks disabled: the spot-first recorder after its FAIL (section 157), and the
  // consensus shadow after the arm's hard stop (section 152) - its state file had been torn since the 09-21 power loss.
  // Retired 2026-09-25 (section 169), their tasks disabled by their own registered reads, NOT by a freshness signal:
  //   OracleTrader-MentionShadow - read 12/68b FAIL: 182 graded strikes, base-rate Brier 0.2441 against the market's
  //     0.1551, and the counterfactual 15c-gap taker loses 2.17c/contract. The registration's action on FAIL is
  //     "close the line and disable the task".
  //   OracleTrader-SportsBooks - read 163 found nothing: the post-final Kalshi book is at 1c/99c wherever
  //     Polymarket's is, and the wide cases are the stale in-play book read 234 already retired. Its note said to
  //     disable the recorder unless the read found something.
  // Neither is stale and neither is a bug. Do not re-enable either on a freshness or "a strategy is off" signal.
]

/**
 * An absent mtime means the file has never been written - the shadow has not started rather than
 * died - which is a different finding and is left to the caller, so it is never "stale" here.
 */
export function isStale(mtimeMs, now, staleMs) {
  if (mtimeMs === undefined || mtimeMs === null) return false
  return now - mtimeMs > (staleMs ?? DEFAULT_STALE_MS)
}
