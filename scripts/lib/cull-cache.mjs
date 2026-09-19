/**
 * The settle-cache rules for `scripts/cull-gate.mjs`, kept here because the script itself runs on import
 * (top-level await, network) and so cannot be tested directly.
 *
 * The cache maps a Kalshi ticker to its settled result: `'yes'`, `'no'`, or `{ blankAt }` for a market that
 * settled without one. An OPEN market is deliberately absent rather than cached, because its answer is still
 * coming - caching "no answer" would freeze the row out of every later run.
 */

const BLANK_RECHECK_MS = 24 * 3600_000

/** Does this ticker still need a request? A blank result can fill in later, so re-check those for 24 h. */
export function needsSettleFetch(entry, now = Date.now()) {
  if (entry && typeof entry === 'object' && entry.blankAt !== undefined) return now - entry.blankAt >= BLANK_RECHECK_MS
  return entry === undefined
}

/**
 * What a `/markets` row should put in the cache, or `undefined` to cache nothing (market still open, so the
 * next run must ask again).
 */
export function settledCacheEntry(market, now = Date.now()) {
  const status = market?.status
  if (status !== 'settled' && status !== 'finalized') return undefined
  const res = market.result
  return res === 'yes' || res === 'no' ? res : { blankAt: now }
}
