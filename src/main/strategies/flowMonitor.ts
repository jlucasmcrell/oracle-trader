/**
 * Order-flow monitor: "watch the money" without claiming to know why it moved.
 *
 * Unusually large or one-sided taker flow in a thin market is the footprint of
 * a participant who believes they know the outcome (a forecast, a score, a
 * data release). Bartlett & O'Hara (2026, Kalshi) show one-sided flow predicts
 * maker losses in single-name markets; our own weather ledger is the losing
 * side of exactly that flow. Two uses:
 *   - defensive: a maker pulls its quotes while the flag is up (quoter gate);
 *   - offensive: follow the flow as a signal ('flow-follow'), tested by the
 *     ladder like any other strategy.
 * The verdict is pure and unit-tested; the monitor only fetches and caches.
 */
import type { VenueAdapter } from '../../shared/venue'
import type { MarketTrade } from '../../shared/types'

export interface FlowStats {
  /** Prints inside the window. */
  n: number
  /** Dollars the takers spent inside the window (their own leg). */
  notional: number
  medianCount: number
  largestCount: number
  largestSide: 'YES' | 'NO' | null
  largestAgeMs: number
  /** Share of contracts where the taker bought YES (0..1). */
  yesShare: number
  dominant: 'YES' | 'NO' | null
}

export interface FlowConfig {
  /** A single print at least this many contracts ... */
  minLargestCount: number
  /** ... and at least this multiple of the window's median print. */
  sizeMultiple: number
  /** Or: this share of the window's contracts on one side ... */
  oneSidedShare: number
  /** ... with at least this many dollars behind it. */
  minNotionalDollars: number
  /** Only a print this recent can raise the flag. */
  maxAgeMs: number
}

export const FLOW_DEFAULTS: FlowConfig = { minLargestCount: 25, sizeMultiple: 5, oneSidedShare: 0.75, minNotionalDollars: 20, maxAgeMs: 15 * 60_000 }

export function flowStats(trades: MarketTrade[], now: number, windowMs = 15 * 60_000): FlowStats {
  const rows = trades.filter((t) => t.count > 0 && t.createdTs > 0 && now - t.createdTs <= windowMs)
  if (rows.length === 0) return { n: 0, notional: 0, medianCount: 0, largestCount: 0, largestSide: null, largestAgeMs: Number.POSITIVE_INFINITY, yesShare: 0.5, dominant: null }
  const counts = rows.map((t) => t.count).sort((a, b) => a - b)
  const medianCount = counts.length % 2 ? counts[(counts.length - 1) / 2] : (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2
  let largest = rows[0]
  let yes = 0
  let total = 0
  let notional = 0
  for (const t of rows) {
    if (t.count > largest.count) largest = t
    total += t.count
    if (t.takerOutcomeSide === 'yes') yes += t.count
    notional += t.count * (t.takerOutcomeSide === 'yes' ? t.yesPrice : t.noPrice)
  }
  const yesShare = total > 0 ? yes / total : 0.5
  return {
    n: rows.length,
    notional,
    medianCount,
    largestCount: largest.count,
    largestSide: largest.takerOutcomeSide === 'yes' ? 'YES' : 'NO',
    largestAgeMs: now - largest.createdTs,
    yesShare,
    dominant: yesShare >= 0.5 ? 'YES' : 'NO'
  }
}

export function flowVerdict(s: FlowStats, cfg: FlowConfig = FLOW_DEFAULTS): { toxic: boolean; side: 'YES' | 'NO' | null; reason: string } {
  const large = s.largestCount >= cfg.minLargestCount && (s.medianCount === 0 || s.largestCount >= cfg.sizeMultiple * s.medianCount) && s.largestAgeMs <= cfg.maxAgeMs
  const share = Math.max(s.yesShare, 1 - s.yesShare)
  const oneSided = s.n >= 5 && s.notional >= cfg.minNotionalDollars && share >= cfg.oneSidedShare
  if (large) return { toxic: true, side: s.largestSide, reason: `print of ${s.largestCount} vs median ${s.medianCount} (${Math.round(s.largestAgeMs / 60_000)}m ago)` }
  if (oneSided) return { toxic: true, side: s.dominant, reason: `${Math.round(share * 100)}% of ${s.n} prints on one side, $${s.notional.toFixed(0)}` }
  return { toxic: false, side: null, reason: '' }
}

/** Fetches and caches recent prints per market (one venue read per market per minute). */
export class FlowMonitor {
  private cache = new Map<string, { at: number; stats: FlowStats }>()

  constructor(private readonly windowMs = 15 * 60_000, private readonly ttlMs = 60_000) {}

  async read(adapter: VenueAdapter, marketId: string, now = Date.now()): Promise<FlowStats | null> {
    const c = this.cache.get(marketId)
    if (c && now - c.at < this.ttlMs) return c.stats
    if (!adapter.getRecentTrades) return null
    try {
      const trades = await adapter.getRecentTrades(marketId, 200, Math.floor((now - this.windowMs) / 1000))
      const stats = flowStats(trades, now, this.windowMs)
      this.cache.set(marketId, { at: now, stats })
      if (this.cache.size > 500) {
        for (const [k, v] of this.cache) if (now - v.at > 10 * this.ttlMs) this.cache.delete(k)
      }
      return stats
    } catch {
      // The cached window is already expired here; do not trade old flow after
      // a failed refresh as though it described the current fifteen minutes.
      return null
    }
  }
}
