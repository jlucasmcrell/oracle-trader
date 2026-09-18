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
  ['mention-stale', 'data/mention-shadow/run.log', 'OracleTrader-MentionShadow'],
  ['polyconsensus-stale', 'data/polymarket-consensus/run.log', 'OracleTrader-PolyConsensus'],
  ['spot-shadow-stale', 'data/spot-shadow/recorder.log', 'OracleTrader-SpotShadow', 20 * MIN],
]

/**
 * An absent mtime means the file has never been written - the shadow has not started rather than
 * died - which is a different finding and is left to the caller, so it is never "stale" here.
 */
export function isStale(mtimeMs, now, staleMs) {
  if (mtimeMs === undefined || mtimeMs === null) return false
  return now - mtimeMs > (staleMs ?? DEFAULT_STALE_MS)
}
