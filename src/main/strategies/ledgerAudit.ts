/**
 * Ledger invariants — deterministic reconciliation checks, run every scan.
 *
 * Both settlement bugs found on 2026-09-01 shared a shape: the ledger and the
 * venue disagreed, silently, with no error raised anywhere. The PolyUS
 * settlement parser returned undefined for EVERY resolved market, so positions
 * sat open forever; they never tripped the zombie guard either, because that
 * only fires when a market is UNFETCHABLE and these fetched perfectly.
 *
 * Nothing here guesses or mutates. A stuck position is reported, never
 * auto-closed — booking a fabricated win or loss is strictly worse than
 * holding a stale row, and the operator can see the age and judge.
 */

/** Open-position shape both traders share (structural, so neither imports the other). */
export interface AuditableTrade {
  marketId: string
  closeTime?: number
  /**
   * When the venue was last asked about this market and answered "not resolved yet". A row carrying a
   * recent stamp is waiting on the VENUE, which is a fact about the venue and not a defect in us.
   */
  venueUnresolvedAt?: number
}

export interface StuckSettlementReport {
  count: number
  worstHours: number
  worstMarketId?: string
  message?: string
  /** Past close, but the venue itself confirmed it has not resolved them. Reported, never alarmed on. */
  awaitingVenue: number
}

/**
 * Positions still open well past their close time.
 *
 * Some lag is legitimate and venue-specific (Kalshi weather settles 7-10h
 * after close; a monthly natural-gas contract can sit a day awaiting official
 * data), so this is a WARNING with the age attached, not a defect claim. What
 * makes it worth surfacing is that a permanently-broken settlement path looks
 * exactly like ordinary lag until someone checks the clock — which is how the
 * PolyUS bug survived, and how three winning positions sat uncredited for 14h.
 */
export function stuckSettlements(
  openTrades: readonly AuditableTrade[],
  nowMs: number,
  thresholdHours = 12,
  freshCheckMs = 6 * 3_600_000
): StuckSettlementReport {
  let count = 0
  let awaitingVenue = 0
  let worstHours = 0
  let worstMarketId: string | undefined
  for (const t of openTrades) {
    if (t.closeTime === undefined) continue
    const hours = (nowMs - t.closeTime) / 3_600_000
    if (hours < thresholdHours) continue
    // Asked recently, and the venue said it has not resolved this yet. Manifold's closeTime only stops
    // BETTING - resolution is the creator's to do, whenever they feel like it, and some questions ("Will
    // I drop out of a PhD within 3 years?") cannot resolve on any timetable. That is the venue's business.
    // A stale stamp still counts: a settlement path that broke after the last check must resurface.
    if (t.venueUnresolvedAt !== undefined && nowMs - t.venueUnresolvedAt <= freshCheckMs) {
      awaitingVenue++
      continue
    }
    count++
    if (hours > worstHours) {
      worstHours = hours
      worstMarketId = t.marketId
    }
  }
  if (count === 0) return { count: 0, worstHours: 0, awaitingVenue }
  return {
    count,
    awaitingVenue,
    worstHours,
    worstMarketId,
    message:
      `${count} position${count === 1 ? '' : 's'} unsettled >${thresholdHours}h past close ` +
      `(oldest ${worstHours.toFixed(0)}h: ${worstMarketId}) — check the venue resolved them` +
      (awaitingVenue > 0 ? ` [${awaitingVenue} more awaiting the venue's own resolution]` : '')
  }
}

/**
 * The close time an open row should adopt when the venue reports one.
 *
 * `closeTime` is captured once, at entry, and then trusted forever. That is
 * wrong whenever the venue's own derivation was wrong at entry: PolyUS
 * futures reported the NEXT FIXTURE rather than the resolution date, so a
 * Champions League winner (June 2027) was stored as closing in 13 hours. A
 * too-early close is doubly harmful — the row looks permanently unsettled
 * (`stuckSettlements` fires forever) AND it hides from the out-of-window
 * exit, which only dumps rows whose close is FAR away, so the capital stays
 * locked in a months-out market.
 *
 * Only a LATER close is adopted. Moving a close earlier would let a partial
 * or degraded market record bring a settlement check forward, and the
 * resolution path already handles a market that settled sooner than stored.
 *
 * Returns the new close time, or undefined to keep the stored one.
 */
export function refreshedCloseTime(stored: number, venue: number | undefined): number | undefined {
  if (venue === undefined || !Number.isFinite(venue)) return undefined
  return venue > stored ? venue : undefined
}

/**
 * A side quote at (or within rounding of) 0 or 1: the market has almost
 * certainly resolved, so the settlement probe should fire even though the
 * cached close time is still ahead. Compared after rounding to 4 dp: Kalshi's
 * NO price is derived as 1 - last_price, and 1 - 0.99 is 0.010000000000000009
 * in floating point, which a bare `<= 0.01` missed — two settled NO-side
 * mean-reversion losers sat unbooked for a day (2026-09-08) while their YES
 * mirror image would have been probed at once.
 */
export function isPinnedQuote(price: number): boolean {
  if (!Number.isFinite(price)) return false
  const p = Math.round(price * 10000) / 10000
  return p >= 0.99 || p <= 0.01
}

/**
 * Should the settlement block run even though the cached close time is still ahead?
 *
 * Yes when the venue has stopped quoting the position, or quotes it pinned at 0/1 - either way the market
 * has almost certainly resolved. This exists because the market fetch that would reveal a corrected close
 * lives INSIDE the settlement block, so a close time wrong in the LATE direction is otherwise
 * unrecoverable: on 2026-09-10 fourteen Polymarket US prop fades carried a close of 2026-09-24 against a
 * venue endDate of 2026-09-09T23:49Z on markets the venue had already resolved, and they held fourteen of
 * that venue's 48 position slots while entries were blocked at 48/48.
 *
 * Throttled per trade so a permanently quote-less row costs one market fetch per interval, not one a scan.
 */
/**
 * Mean and one-sided 80% band from a (n, sum, sumSq) triple - or `undefined` when the triple cannot support
 * one.
 *
 * Three ways it refuses, and all three have happened:
 *  - `sqN` disagrees with `n`: the sum of squares covers fewer observations than the sum. `clvSq` began
 *    accumulating later than `clvSum`, so every arm with older history carries a short one and every SE
 *    taken from it came out 1.4x-2.1x too small.
 *  - `sumSq` is below `n * mean^2`, which is arithmetically impossible for a complete sum of squares.
 *    flow-follow read clvN=8, clvSum=-81.50, clvSq=96.75 against a floor of 830.28.
 *  - fewer than two observations, where a sample variance is undefined rather than zero.
 *
 * Refusing is the point. A band that is silently too tight is worse than no band: it reads as evidence.
 */
export function statsBand(
  n: number,
  sum: number,
  sumSq: number | undefined,
  sqN: number | undefined,
  z = 0.84
): { n: number; mean: number; sd: number; se: number; lo: number; hi: number } | undefined {
  if (!Number.isFinite(n) || n < 2 || sumSq === undefined || !Number.isFinite(sumSq)) return undefined
  if (sqN !== undefined && sqN !== n) return undefined
  const mean = sum / n
  const floor = n * mean * mean
  if (sumSq < floor - 1e-9) return undefined
  const variance = (sumSq - floor) / (n - 1)
  const sd = Math.sqrt(Math.max(0, variance))
  const se = sd / Math.sqrt(n)
  return { n, mean, sd, se, lo: mean - z * se, hi: mean + z * se }
}

export function settlementProbeDue(
  quotePrice: number | undefined,
  lastProbeAt: number | undefined,
  now: number,
  intervalMs = 10 * 60_000
): boolean {
  const suspicious = quotePrice === undefined || isPinnedQuote(quotePrice)
  return suspicious && now - (lastProbeAt ?? 0) > intervalMs
}
