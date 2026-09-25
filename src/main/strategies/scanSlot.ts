/**
 * Who owns a scan slot on this tick. Shared by the auto-trader's tick and the lead-lag engine's poll,
 * because the defect is the same in both: a plain `busy` boolean cleared in a `finally` is released by a
 * THROWN scan but never by one that does not settle, and every later tick then returns "already in
 * progress" forever, silently.
 *
 * It happened twice. 2026-09-20: the 21:12:17Z auto-trader tick stalled during a host freeze and
 * `state.lastScanAt` was still 21:11:17.627Z 2 h 42 min later, so a Kalshi position that settled at
 * 21:07Z sat open in the ledger until 23:50Z. 2026-09-25: the lead-lag pass that started at
 * 2026-09-24T23:58:49Z never returned, and the arm - the only net-positive live one - observed nothing
 * for 11 h. Nothing watched for it either: the note, the dislocation count and `lastScanAt` all simply
 * stopped changing, which reads exactly like a quiet market.
 *
 * 'wedged' hands the slot to the new pass. The stale one is NOT cancelled - a promise cannot be - so it
 * is superseded instead: it may finish its awaits but must not trade or write state (see `scanEpoch` in
 * the auto-trader and `runGen` in the lead-lag engine).
 */
export function scanSlotVerdict(
  busy: boolean,
  busyAt: number,
  now: number,
  wedgeMs = SCAN_WEDGE_MS
): 'free' | 'busy' | 'wedged' {
  if (!busy) return 'free'
  return now - busyAt >= wedgeMs ? 'wedged' : 'busy'
}

/** A full auto-trader tick is minutes of work; 15 min is well past the slowest one on record. */
export const SCAN_WEDGE_MS = 15 * 60_000

/**
 * A lead-lag pass is three round trips per coin with a 6 s timeout on each, polled every 60 s. Five
 * missed polls is already a third of a 15-minute window, so the bar to supersede is much lower here.
 */
export const LEADLAG_WEDGE_MS = 5 * 60_000
