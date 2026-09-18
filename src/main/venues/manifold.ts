import { HttpClient } from '../util/http'
import type { VenueAdapter, VenueCapabilities } from '../../shared/venue'
import type {
  AccountInfo,
  Holder,
  Leader,
  MarketSearchQuery,
  OrderRequest,
  OrderResult,
  Position,
  PriceQuote,
  SellRequest,
  UserBet,
  UserPortfolio,
  VenueCredentials,
  VenueId,
  VenueMarket
} from '../../shared/types'

const BASE_URL = 'https://api.manifold.markets'

// ---- raw Manifold shapes (subset). The API is alpha, so map defensively. ----

interface ManiAnswer {
  id?: string
  text?: string
  probability?: number
}

interface ManiMarket {
  id: string
  question?: string
  slug?: string
  description?: string | Record<string, unknown>
  probability?: number
  totalLiquidity?: number
  volume?: number
  volume24Hours?: number
  uniqueBettorCount?: number
  outcomeType?: string
  isResolved?: boolean
  resolution?: string
  /** Set when resolution === 'MKT': the value (0..1) the market settled at. */
  resolutionProbability?: number
  resolutionTime?: number | null
  closeTime?: number | null
  createdTime?: number | null
  groupSlugs?: string[]
  tags?: string[]
  answers?: ManiAnswer[]
}

interface ManiUser {
  id?: string
  name?: string
  username?: string
  balance?: number
  totalDeposits?: number
  profit?: number
}

interface ManiBet {
  /** POST /v0/bet has been observed returning betId rather than id. */
  betId?: string
  id?: string
  userId?: string
  contractId?: string
  answerId?: string
  amount?: number
  shares?: number
  outcome?: string
  probBefore?: number
  probAfter?: number
  createdTime?: number
  isSold?: boolean
  isRedemption?: boolean
}

interface ManiMetric {
  contractId?: string
  userId?: string
  userName?: string
  name?: string
  outcome?: string
  shares?: number
  profit?: number
  totalShares?: { YES?: number; NO?: number }
  from?: { month?: { profit?: number } }
}

export class ManifoldAdapter implements VenueAdapter {
  readonly id: VenueId = 'manifold'
  readonly name = 'Manifold Markets'
  readonly currency = 'M$'
  readonly capabilities: VenueCapabilities = {
    liveTrading: true, // real M$ orders once an API key is provided
    // Mana is purchasable (~$1 per 100 M$) but NOT cashable: sweepstakes
    // cash-outs ended 2025-03-28; the only outbound path is charity donation
    // at M100/$1. Play money — winnings have no extractable value.
    realMoney: false,
    socialExposure: true // other users' positions/bets are public
  }

  private http: HttpClient
  private apiKey?: string
  private me?: ManiUser

  constructor() {
    this.http = new HttpClient({ baseUrl: BASE_URL, rateLimit: 450 })
  }

  async init(credentials?: VenueCredentials): Promise<void> {
    this.apiKey = typeof credentials?.apiKey === 'string' ? credentials.apiKey : undefined
    if (this.apiKey) {
      this.me = await this.http.get<ManiUser>('/v0/me', this.authHeaders())
    }
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Key ${this.apiKey}` } : {}
  }

  // ---- market data ----

  async searchMarkets(query: MarketSearchQuery): Promise<VenueMarket[]> {
    const params = new URLSearchParams()
    if (query.term) params.set('term', query.term)
    params.set('sort', mapManifoldSort(query.sort))
    if (query.status) params.set('filter', query.status)
    if (query.limit) params.set('limit', String(Math.min(query.limit, 1000)))

    const markets = await this.http.get<ManiMarket[]>(`/v0/search-markets?${params.toString()}`)
    let mapped = markets.map((m) => this.mapMarket(m))
    // search-markets omits answers for multiple-choice; enrich the top MC markets
    // from their full records so the scanner can show (and trade) the answers.
    const mcIds = mapped
      .filter((m) => m.outcomeType === 'MULTIPLE_CHOICE' && m.status === 'open')
      .slice(0, 20)
      .map((m) => m.id)
    if (mcIds.length > 0) {
      const full = await Promise.all(
        mcIds.map(async (id) => {
          try {
            return this.mapMarket(await this.http.get<ManiMarket>(`/v0/market/${id}`))
          } catch {
            return undefined
          }
        })
      )
      const byId = new Map<string, VenueMarket>()
      for (const e of full) if (e) byId.set(e.id, e)
      mapped = mapped.map((m) => byId.get(m.id) ?? m)
    }
    if (query.minLiquidity) mapped = mapped.filter((m) => (m.liquidity ?? 0) >= query.minLiquidity!)
    if (query.category) {
      const c = query.category.toLowerCase()
      mapped = mapped.filter(
        (m) => (m.category ?? '').toLowerCase().includes(c) || m.tags?.some((t) => t.toLowerCase().includes(c))
      )
    }
    return mapped
  }

  async getMarket(id: string): Promise<VenueMarket> {
    const m = await this.http.get<ManiMarket>(`/v0/market/${id}`)
    return this.mapMarket(m)
  }

  async getPrice(marketId: string, outcome = 'YES', side?: 'YES' | 'NO'): Promise<PriceQuote> {
    const m = await this.http.get<ManiMarket>(`/v0/market/${marketId}`)
    if (m.outcomeType === 'MULTIPLE_CHOICE' && outcome !== 'YES' && outcome !== 'NO') {
      const ans = (m.answers ?? []).find((a) => a.id === outcome || a.text === outcome)
      const p = ans?.probability ?? 0
      // The answer's probability is the YES price for THAT answer; the NO
      // leg is its complement. Ignoring `side` here charged both legs of one
      // answer the same price — 200 mana bought a position paying at most 131.
      return { venue: this.id, marketId, outcome, price: side === 'NO' ? 1 - p : p, probability: p, timestamp: Date.now() }
    }
    const p = m.probability ?? 0
    // The NO leg costs 1−p, and the requested outcome must be echoed back.
    // Returning the YES price for a NO position (and relabelling the outcome
    // as YES) made every NO entry buy ~20× too many shares and valued those
    // positions INVERSELY — a NO holding appeared to gain as YES rose.
    return {
      venue: this.id,
      marketId,
      outcome,
      price: outcome === 'NO' ? 1 - p : p,
      probability: p,
      timestamp: Date.now()
    }
  }

  // ---- account ----

  private meAt = 0

  async getAccount(): Promise<AccountInfo> {
    // Refresh at most every 30 s; the startup snapshot alone froze the balance for the session.
    const stale = !this.me || Date.now() - this.meAt > 30_000
    const u = stale ? await this.http.get<ManiUser>('/v0/me', this.authHeaders()) : this.me!
    if (stale) this.meAt = Date.now()
    this.me = u
    return {
      venue: this.id,
      userId: u.id ?? '',
      username: u.username ?? u.name ?? '',
      balance: u.balance ?? 0,
      currency: this.currency,
      profit: u.profit,
      realMoney: true
    }
  }

  async getPositions(): Promise<Position[]> {
    return this.fetchContractMetrics(await this.requireUserId())
  }

  async getUserHoldings(userId: string): Promise<Position[]> {
    return this.fetchContractMetrics(userId)
  }

  private async fetchContractMetrics(userId: string): Promise<Position[]> {
    const data = await this.http.get<{ metricsByContract?: Record<string, ManiMetric> | ManiMetric[]; contracts?: ManiMarket[] }>(
      `/v0/get-user-contract-metrics-with-contracts?userId=${encodeURIComponent(userId)}`
    )
    const contracts = new Map((data.contracts ?? []).map((c) => [c.id, c]))
    const out: Position[] = []
    // The live payload keys metricsByContract BY contractId (an object). A
    // for..of over it throws, which dropped every position.
    const metrics = Array.isArray(data.metricsByContract) ? data.metricsByContract : Object.values(data.metricsByContract ?? {})
    for (const m of metrics) {
      const total = (m.totalShares?.YES ?? 0) + (m.totalShares?.NO ?? 0)
      const shares = Math.max(total, m.shares ?? 0)
      if (shares <= 0) continue
      const contract = contracts.get(m.contractId ?? '')
      const outcome = (m.totalShares?.YES ?? 0) > 0 ? 'YES' : 'NO'
      out.push({
        venue: this.id,
        marketId: m.contractId ?? '',
        marketQuestion: contract?.question,
        outcome,
        shares,
        avgPrice: 0,
        currentPrice: contract?.probability
      })
    }
    return out
  }

  // ---- trading ----

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const body: Record<string, unknown> = {
      contractId: order.marketId,
      amount: order.amount,
      // MC bets take outcome (YES/NO on the answer) AND answerId; outcome
      // alone covers binary markets.
      outcome: order.outcome === 'NO' ? 'NO' : 'YES'
    }
    if (order.answerId) body.answerId = order.answerId
    if (order.limitPrice !== undefined) {
      // limitProb is a 0.01–0.99 probability in whole-percent steps
      // (docs.manifold.markets: "a number from 0.01 to 0.99 … two decimal
      // digits"). The old ×100 sent 62 instead of 0.62.
      body.limitProb = Math.round(Math.min(0.99, Math.max(0.01, order.limitPrice)) * 100) / 100
    }
    const bet = await this.http.post<ManiBet>('/v0/bet', body, this.authHeaders())
    const shares = bet.shares ?? 0
    return {
      venue: this.id,
      orderId: bet.id ?? bet.betId ?? '',
      marketId: order.marketId,
      outcome: order.outcome,
      amount: order.amount,
      shares,
      // True per-share cost basis; probAfter is the post-bet market prob,
      // which overstates the entry on any bet that moves the AMM.
      avgPrice: shares > 0 ? order.amount / shares : (bet.probAfter ?? 0),
      status: 'filled',
      timestamp: Date.now()
    }
  }

  async sellPosition(req: SellRequest): Promise<OrderResult> {
    const body: Record<string, unknown> = {}
    if (req.answerId) {
      body.answerId = req.answerId
    } else if (req.outcome !== 'YES' && req.outcome !== 'NO') {
      // Multiple-choice: resolve the answer id from the outcome text/id.
      try {
        const m = await this.http.get<ManiMarket>(`/v0/market/${req.marketId}`)
        const ans = (m.answers ?? []).find((a) => a.id === req.outcome || a.text === req.outcome)
        body.answerId = ans?.id ?? req.outcome
      } catch {
        body.answerId = req.outcome
      }
    } else {
      body.outcome = req.outcome === 'YES' ? 'YES' : 'NO'
    }
    if (req.shares !== undefined) body.shares = req.shares
    const bet = await this.http.post<ManiBet>(`/v0/market/${req.marketId}/sell`, body, this.authHeaders())
    // Sell bets report negative shares/amount; normalize so downstream
    // ledgers (which drop shares<=0 as no-fills) record the sale.
    const soldShares = Math.abs(bet.shares ?? 0)
    const proceeds = Math.abs(bet.amount ?? 0)
    return {
      venue: this.id,
      orderId: bet.id ?? '',
      marketId: req.marketId,
      outcome: req.outcome,
      amount: proceeds,
      shares: soldShares,
      avgPrice: soldShares > 0 && proceeds > 0 ? proceeds / soldShares : (bet.probAfter ?? 0),
      status: 'filled',
      timestamp: Date.now()
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.http.post(`/v0/bet/cancel/${orderId}`, undefined, this.authHeaders())
  }

  // ---- social / copy-trading ----

  async getTopHolders(marketId: string, limit = 10): Promise<Holder[]> {
    const rows = await this.http.get<ManiMetric[]>(`/v0/market/${marketId}/positions?order=profit&top=${limit}`)
    return rows.map((r, i) => ({
      userId: r.userId ?? '',
      username: r.userName ?? r.name,
      name: r.name,
      outcome: r.outcome ?? 'YES',
      shares: r.shares ?? 0,
      profit: r.profit,
      rank: i + 1
    }))
  }

  async getUserPortfolio(userId: string): Promise<UserPortfolio> {
    const p = await this.http.get<Record<string, unknown>>(`/v0/get-user-portfolio?userId=${encodeURIComponent(userId)}`)
    return {
      userId,
      investmentValue: asNum(p.investmentValue),
      balance: asNum(p.balance),
      profit: asNum(p.profit),
      dailyProfit: asNum(p.dailyProfit)
    }
  }

  async getLeaderboard(limit = 20): Promise<Leader[]> {
    const markets = await this.searchMarkets({ limit: 10, sort: 'liquidity', status: 'open' })
    const agg = new Map<string, { userId: string; username?: string; profit: number; monthProfit: number; markets: number }>()
    for (const mk of markets) {
      let holders: ManiMetric[] = []
      try {
        holders = await this.http.get<ManiMetric[]>(`/v0/market/${mk.id}/positions?order=profit&top=10`)
      } catch {
        continue
      }
      for (const h of holders) {
        if (!h.userId) continue
        const entry = agg.get(h.userId) ?? { userId: h.userId, username: h.userName ?? h.name, profit: 0, monthProfit: 0, markets: 0 }
        entry.profit += h.profit ?? 0
        entry.monthProfit += h.from?.month?.profit ?? 0
        entry.markets += 1
        agg.set(h.userId, entry)
      }
    }
    const leaders = [...agg.values()]
      .sort((a, b) => b.monthProfit - a.monthProfit || b.profit - a.profit)
      .slice(0, limit)

    // resolve display names for leaders whose name wasn't in the positions payload
    const resolved = await Promise.all(
      leaders.map(async (e) => {
        if (e.username) return e
        try {
          const u = await this.http.get<{ name?: string; username?: string }>(`/v0/user/by-id/${encodeURIComponent(e.userId)}`)
          return { ...e, username: u.name ?? u.username ?? e.username }
        } catch {
          return e
        }
      })
    )

    return resolved.map((e, i) => ({
      userId: e.userId,
      username: e.username,
      profit: Math.round(e.profit),
      monthProfit: Math.round(e.monthProfit),
      markets: e.markets,
      rank: i + 1
    }))
  }

  async getUserBets(userId: string, limit = 100): Promise<UserBet[]> {
    const bets = await this.http.get<ManiBet[]>(`/v0/bets?userId=${encodeURIComponent(userId)}&limit=${limit}`)
    return bets.map((b) => ({
      userId: b.userId ?? userId,
      id: b.id ?? '',
      marketId: b.contractId ?? '',
      outcome: b.outcome ?? 'YES',
      answerId: b.answerId,
      amount: b.amount ?? 0,
      shares: b.shares,
      probBefore: b.probBefore,
      probAfter: b.probAfter,
      createdAt: b.createdTime ?? 0,
      isSold: b.isSold === true || b.isRedemption === true
    }))
  }

  // ---- helpers ----

  private async requireUserId(): Promise<string> {
    if (!this.me?.id) this.me = await this.http.get<ManiUser>('/v0/me', this.authHeaders())
    return this.me?.id ?? ''
  }

  private mapMarket(m: ManiMarket): VenueMarket {
    const description = typeof m.description === 'string' ? m.description : undefined
    return {
      venue: this.id,
      id: m.id,
      question: m.question ?? '',
      slug: m.slug,
      description,
      status: m.isResolved ? 'resolved' : 'open',
      probability: m.probability,
      volume: m.volume,
      volume24h: m.volume24Hours,
      liquidity: m.totalLiquidity,
      uniqueBettorCount: m.uniqueBettorCount,
      outcomeType: mapOutcomeType(m.outcomeType),
      outcomes: (m.answers ?? [])
        .filter((a) => a.id || a.text)
        .map((a) => ({ id: a.id ?? a.text ?? '', text: a.text ?? a.id ?? '', probability: a.probability })),
      category: m.groupSlugs?.[0],
      tags: m.tags,
      createdAt: m.createdTime ?? undefined,
      closeTime: m.closeTime ?? undefined,
      resolutionTime: m.resolutionTime ?? undefined,
      resolved: m.isResolved,
      resolution: m.resolution,
      resolutionProbability: m.resolutionProbability,
      url: m.slug ? `https://manifold.markets/${m.slug}` : undefined
    }
  }
}

function mapOutcomeType(t?: string): VenueMarket['outcomeType'] {
  switch (t) {
    case 'BINARY':
      return 'BINARY'
    case 'MULTIPLE_CHOICE':
      return 'MULTIPLE_CHOICE'
    case 'NUMERIC':
      return 'NUMERIC'
    default:
      return 'OTHER'
  }
}

function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function mapManifoldSort(sort?: string): string {
  switch (sort) {
    case 'volume':
      return '24-hour-vol'
    case 'prob-descending':
      return 'prob-descending'
    case 'ending-soon':
      return 'close-date'
    case 'newest':
      return 'newest'
    case 'liquidity':
    default:
      return 'liquidity'
  }
}
