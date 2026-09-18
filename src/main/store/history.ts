import { JsonStore } from './json'
import type { HistoryStats, TradeRecord, VenueId } from '../../shared/types'

interface HistoryState {
  trades: TradeRecord[]
}

const MAX_TRADES = 5000

/** Retain summaries for realized-P&L accounting, but display/count actual executions once covered. */
export function visibleTrades(trades: TradeRecord[]): TradeRecord[] {
  const quantities = new Map<string, number>()
  for (const t of trades) if (t.ref === 'venue-fill' && t.orderId) {
    const key = `${t.venue}:${t.orderId}`
    quantities.set(key, (quantities.get(key) ?? 0) + t.shares)
  }
  return trades.filter(t => t.ref === 'venue-fill' || t.shares <= 0 || (quantities.get(`${t.venue}:${t.orderId ?? t.id}`) ?? 0) + 1e-6 < t.shares)
}

/** Persists every paper fill and derives performance stats from it. */
export class HistoryStore {
  private store: JsonStore<HistoryState>

  constructor(path: string) {
    this.store = new JsonStore<HistoryState>(path, { trades: [] })
  }

  record(t: TradeRecord): void {
    const s = this.store.get()
    s.trades.push(t)
    if (s.trades.length > MAX_TRADES) s.trades = s.trades.slice(-MAX_TRADES)
    this.store.save()
  }

  /** Batch append with one write (the fill reconciler's backfill is hundreds of rows). */
  recordMany(rows: TradeRecord[]): void {
    if (rows.length === 0) return
    const s = this.store.get()
    s.trades = [...new Map([...s.trades, ...rows].map(r => [`${r.venue}:${r.id}`, r])).values()].sort((a, b) => a.timestamp - b.timestamp)
    if (s.trades.length > MAX_TRADES) s.trades = s.trades.slice(-MAX_TRADES)
    this.store.save()
  }

  list(limit = 100, venue?: VenueId): TradeRecord[] {
    const trades = venue ? this.store.get().trades.filter((t) => t.venue === venue) : this.store.get().trades
    return visibleTrades(trades).slice(-limit).reverse()
  }

  clear(): void {
    this.store.update({ trades: [] })
  }

  orderStrategy(venue: VenueId, orderId: string): string | undefined {
    const refs = new Set(this.store.get().trades.filter(t => t.venue === venue && (t.orderId ?? t.id) === orderId && t.ref && t.ref !== 'venue-fill').map(t => t.ref!))
    return refs.size === 1 ? [...refs][0] : undefined
  }

  /** Aggregate stats — pass a venue for a per-broker slice (the tab views). */
  stats(venue?: VenueId): HistoryStats {
    const all = venue ? this.store.get().trades.filter((t) => t.venue === venue) : this.store.get().trades
    // Venue-reconciled fills (ref 'venue-fill') are single legs of resting
    // orders, not round trips; they count as fills but must not dilute the
    // win-rate / realized-P&L denominators, which are computed over sells.
    const trades = all.filter((t) => t.ref !== 'venue-fill')
    const buys = trades.filter((t) => t.side === 'buy')
    const sells = trades.filter((t) => t.side === 'sell')
    const totalVolume = buys.reduce((a, t) => a + t.amount, 0)
    const realizedPnl = sells.reduce((a, t) => a + (t.realizedPnl ?? 0), 0)
    const wins = sells.filter((t) => (t.realizedPnl ?? 0) > 0).length
    return {
      // Every fill row — a round trip contributes TWO (the buy and the sell).
      totalTrades: visibleTrades(all).length,
      buys: buys.length,
      sells: sells.length,
      // One per closed/settled position, matching the denominator winRate and
      // realizedPnl are computed over. Displaying totalTrades next to those
      // two reported ~2x the real trade count (40 fills for 20 PolyUS trades).
      // Verified against each auto-trader's own perf ledger: sells === trades
      // on all three venues, and buys - sells === open positions.
      completedTrades: sells.length,
      totalVolume,
      realizedPnl,
      winRate: sells.length > 0 ? (wins / sells.length) * 100 : 0
    }
  }
}
