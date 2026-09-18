import type { TradingEngine } from '../engine/engine'
import type { MarketSearchQuery, VenueId, VenueMarket } from '../../shared/types'

/** Event/market discovery — the shared infrastructure copy-trading and other strategies build on. */
export class Scanner {
  constructor(private readonly engine: TradingEngine) {}

  async scan(venue: VenueId, query: MarketSearchQuery = {}): Promise<VenueMarket[]> {
    return this.engine.searchMarkets(venue, query)
  }

  /** v1 heuristic: open markets ordered by recent volume (a simple "what's hot" list). */
  async findOpportunities(venue: VenueId): Promise<VenueMarket[]> {
    const markets = await this.engine.searchMarkets(venue, { limit: 200, sort: 'liquidity', status: 'open' })
    return markets.filter((m) => m.status === 'open').sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
  }
}
