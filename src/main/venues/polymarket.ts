import { HttpClient } from '../util/http'
import type { VenueAdapter, VenueCapabilities } from '../../shared/venue'
import type {
  AccountInfo,
  Holder,
  Leader,
  MarketSearchQuery,
  OrderBook,
  OrderResult,
  Position,
  PricePoint,
  PriceQuote,
  UserBet,
  UserPortfolio,
  VenueId,
  VenueMarket
} from '../../shared/types'

const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB = 'https://clob.polymarket.com'

// ---- raw Polymarket shapes (subset; mapped defensively) ----

interface PolyMarket {
  id: string // conditionId
  question?: string
  slug?: string
  description?: string
  outcomes?: string // JSON array string, e.g. '["Yes","No"]'
  outcomePrices?: string // JSON array string, e.g. '["0.52","0.48"]'
  clobTokenIds?: string // JSON array string, e.g. '["<yesToken>","<noToken>"]'
  volumeNum?: number
  volume24hr?: number
  liquidityNum?: number
  endDate?: string
  createdAt?: string
  closed?: boolean
  active?: boolean
  events?: { slug?: string; title?: string }[]
}

export class PolymarketAdapter implements VenueAdapter {
  readonly id: VenueId = 'polymarket'
  readonly name = 'Polymarket'
  readonly currency = 'USDC'
  readonly capabilities: VenueCapabilities = {
    liveTrading: false, // live order signing not wired yet (paper-only)
    realMoney: true,
    socialExposure: false // on-chain positions need wallet tracking (future work)
  }

  private gamma: HttpClient
  private clob: HttpClient
  private tokenCache = new Map<string, string[]>()

  constructor() {
    this.gamma = new HttpClient({ baseUrl: GAMMA, rateLimit: 300 })
    this.clob = new HttpClient({ baseUrl: CLOB, rateLimit: 300 })
  }

  async init(): Promise<void> {
    // No credentials required for public market data (v1 is paper-only).
  }

  // ---- market data ----

  async searchMarkets(query: MarketSearchQuery): Promise<VenueMarket[]> {
    let markets: PolyMarket[] = []

    if (query.term) {
      // Real text search: public-search returns matching events, each with its markets.
      const res = await this.gamma.get<{ events?: { markets?: PolyMarket[] }[] }>(
        `/public-search?q=${encodeURIComponent(query.term)}&limit_pagination=true`
      )
      for (const ev of res.events ?? []) {
        for (const m of ev.markets ?? []) markets.push(m)
      }
      markets = markets.slice(0, query.limit ?? 50)
    } else {
      const params = new URLSearchParams()
      params.set('active', 'true')
      params.set('closed', 'false')
      params.set('limit', String(Math.min(query.limit ?? 100, 200)))
      // Gamma's `order=liquidity` sorts the string field lexicographically, so fetch by
      // a reliable order and sort client-side. "ending soon" fetches by endDate.
      const order = query.sort === 'ending-soon' ? 'endDate' : query.sort === 'newest' ? 'createdAt' : 'volume24hr'
      params.set('order', order)
      params.set('ascending', String(query.sort === 'ending-soon'))
      if (query.sort === 'ending-soon') {
        // exclude past-dated unresolved markets server-side
        params.set('end_date_min', new Date().toISOString())
      }
      markets = await this.gamma.get<PolyMarket[]>(`/markets?${params.toString()}`)
    }

    // Drop markets whose close date has already passed (unresolved stragglers).
    const now = Date.now()
    markets = markets.filter((m) => !m.endDate || Date.parse(m.endDate) >= now)

    // Group by event slug (one event = many candidate/sub-markets) and keep the top 3
    // per event by volume, so a single event cannot flood the scanner.
    const byEvent = new Map<string, PolyMarket[]>()
    for (const m of markets) {
      const key = m.events?.[0]?.slug ?? m.slug ?? m.id
      const arr = byEvent.get(key) ?? []
      arr.push(m)
      byEvent.set(key, arr)
    }
    const grouped: PolyMarket[] = []
    for (const arr of byEvent.values()) {
      arr.sort((a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0))
      grouped.push(...arr.slice(0, 3))
    }

    let out = grouped.map((m) => this.mapMarket(m))
    if (query.minLiquidity) {
      const ml = query.minLiquidity
      out = out.filter((m) => (m.liquidity ?? 0) >= ml)
    }
    if (query.category) {
      const c = query.category.toLowerCase()
      out = out.filter((m) => (m.category ?? '').toLowerCase().includes(c))
    }
    return this.sortMarkets(out, query.sort)
  }

  private sortMarkets(markets: VenueMarket[], sort?: string): VenueMarket[] {
    const arr = [...markets]
    switch (sort) {
      case 'volume':
        return arr.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
      case 'prob-descending':
        return arr.sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))
      case 'ending-soon':
        return arr.sort((a, b) => (a.closeTime ?? Infinity) - (b.closeTime ?? Infinity))
      case 'newest':
        return arr.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      case 'liquidity':
      default:
        return arr.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0))
    }
  }

  async getMarket(id: string): Promise<VenueMarket> {
    const list = await this.gamma.get<PolyMarket[]>(`/markets?id=${encodeURIComponent(id)}`)
    const m = list[0]
    if (!m) throw new Error(`Polymarket market ${id} not found`)
    return this.mapMarket(m)
  }

  async getPrice(marketId: string, outcome = 'YES'): Promise<PriceQuote> {
    const tokenIds = await this.fetchTokenIds(marketId)
    const tokenId = tokenIds[outcome === 'NO' ? 1 : 0]
    if (!tokenId) throw new Error(`No token for outcome '${outcome}' on market ${marketId}`)
    const mid = await this.clob.get<{ mid: string }>(`/midpoint?token_id=${tokenId}`)
    const price = parseFloat(mid.mid)
    return { venue: this.id, marketId, outcome, price, probability: price, timestamp: Date.now() }
  }

  async getPriceHistory(marketId: string, limit = 500): Promise<PricePoint[]> {
    const tokenIds = await this.fetchTokenIds(marketId)
    const tokenId = tokenIds[0]
    if (!tokenId) throw new Error(`No token for market ${marketId}`)
    const res = await this.clob.get<{ history?: { t: number; p: number }[] }>(
      `/prices-history?market=${tokenId}&interval=max&fidelity=60`
    )
    return (res.history ?? []).map((h) => ({ timestamp: h.t * 1000, price: h.p })).slice(-limit)
  }

  async getOrderBook(marketId: string): Promise<OrderBook> {
    const tokenIds = await this.fetchTokenIds(marketId)
    const tokenId = tokenIds[0]
    if (!tokenId) throw new Error(`No token for market ${marketId}`)
    const book = await this.clob.get<{ bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] }>(
      `/book?token_id=${tokenId}`
    )
    const map = (levels: { price: string; size: string }[] | undefined) =>
      (levels ?? []).map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) })).filter((l) => l.size > 0)
    return {
      venue: this.id,
      marketId,
      bids: map(book.bids).sort((a, b) => b.price - a.price),
      asks: map(book.asks).sort((a, b) => a.price - b.price)
    }
  }

  // ---- account (paper-only: no live connection) ----

  async getAccount(): Promise<AccountInfo> {
    return { venue: this.id, userId: '', username: 'Not connected', balance: 0, currency: this.currency, realMoney: true }
  }

  async getPositions(): Promise<Position[]> {
    return []
  }

  // ---- trading (not wired yet) ----

  async placeOrder(): Promise<OrderResult> {
    throw new Error('Polymarket live trading is not wired yet (paper-only).')
  }

  async sellPosition(): Promise<OrderResult> {
    throw new Error('Polymarket live trading is not wired yet (paper-only).')
  }

  async cancelOrder(): Promise<void> {
    throw new Error('Not implemented for Polymarket.')
  }

  // ---- social / copy-trading (future work) ----

  async getTopHolders(): Promise<Holder[]> {
    return []
  }

  async getUserPortfolio(): Promise<UserPortfolio> {
    throw new Error('Not implemented for Polymarket.')
  }

  async getUserBets(): Promise<UserBet[]> {
    throw new Error('Not implemented for Polymarket.')
  }

  async getLeaderboard(): Promise<Leader[]> {
    return []
  }

  async getUserHoldings(): Promise<Position[]> {
    return []
  }

  // ---- helpers ----

  private async fetchTokenIds(marketId: string): Promise<string[]> {
    const cached = this.tokenCache.get(marketId)
    if (cached) return cached
    const list = await this.gamma.get<PolyMarket[]>(`/markets?id=${encodeURIComponent(marketId)}`)
    const m = list[0]
    if (!m) throw new Error(`Polymarket market ${marketId} not found`)
    const ids = parseJsonArray(m.clobTokenIds)
    this.tokenCache.set(marketId, ids)
    return ids
  }

  private mapMarket(m: PolyMarket): VenueMarket {
    const outcomes = parseJsonArray(m.outcomes)
    const prices = parseJsonArray(m.outcomePrices).map((s) => parseFloat(s))
    const tokenIds = parseJsonArray(m.clobTokenIds)
    if (tokenIds.length) this.tokenCache.set(m.id, tokenIds)
    return {
      venue: this.id,
      id: m.id,
      question: m.question ?? '',
      slug: m.slug,
      description: m.description,
      status: m.closed ? 'resolved' : 'open',
      probability: Number.isFinite(prices[0]) ? prices[0] : undefined,
      volume: m.volumeNum,
      volume24h: m.volume24hr,
      liquidity: m.liquidityNum,
      outcomeType: outcomes.length === 2 ? 'BINARY' : 'MULTIPLE_CHOICE',
      category: m.events?.[0]?.slug,
      createdAt: m.createdAt ? Date.parse(m.createdAt) : undefined,
      closeTime: m.endDate ? Date.parse(m.endDate) : undefined,
      resolved: m.closed,
      url: m.slug ? `https://polymarket.com/event/${m.slug}` : undefined
    }
  }
}

function parseJsonArray(v?: string | unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v !== 'string' || !v) return []
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed.map((x: unknown) => String(x)) : []
  } catch {
    return []
  }
}
