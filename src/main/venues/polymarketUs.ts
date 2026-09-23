import { createPrivateKey, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { HttpClient } from '../util/http'
import { reconcileUsLedger } from './usLedger'
import type { VenueAdapter, VenueCapabilities } from '../../shared/venue'
import type {
  AccountInfo,
  Holder,
  LivePnl,
  Leader,
  MarketSearchQuery,
  OpenOrder,
  OrderBook,
  OrderRequest,
  OrderResult,
  Position,
  PriceQuote,
  SellRequest,
  UserBet,
  UserPortfolio,
  VenueCredentials,
  VenueFill, VenueSettlement,
  VenueId,
  VenueMarket
} from '../../shared/types'

// Polymarket US (CFTC-regulated) — Retail API.
// Market data:  https://gateway.polymarket.us/v1/markets (public)
// Trading:      https://api.polymarket.us/v1/{orders,order/close-position,portfolio/positions,account/balances}
// Auth: Ed25519 signature over `timestamp + method + path` with headers
// X-PM-Access-Key / X-PM-Timestamp / X-PM-Signature (docs.polymarket.us).

const GATEWAY = 'https://gateway.polymarket.us'
const API = 'https://api.polymarket.us'

/** PKCS8 DER prefix for a raw 32-byte Ed25519 seed. */
const ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** Pause between activity-feed pages; see `activities()`. Matches scripts/readonly-polyus-dump.cjs. */
export const ACTIVITY_PAGE_PACE_MS = 700

/**
 * A futures market (tournament, season or election winner: marketType or
 * sportsMarketType "futures") trades for months, and its gameStartTime is only
 * the NEXT fixture, during which the venue halts and then reopens it. Reading
 * that fixture as the trading close made the UEFA Champions League winner look
 * like a market closing in 13 hours: the fade rested 96c NO on it and
 * book-imbalance bought Arsenal at 17c, both locked until June 2027
 * (2026-09-08). Sampled 2026-09-08: NFL division winners carry a fixture 1.7
 * days out and an endDate 137 days out; games keep endDate within ~14 days.
 */
/** Catalog index cadence and bounds (see PolymarketUsAdapter.refreshCatalog). */
export const CATALOG_REFRESH_MS = 30 * 60_000
export const CATALOG_STALE_MS = 45 * 60_000
export const CATALOG_HORIZON_MS = 7 * 24 * 3600_000
export const CATALOG_MAX_ROWS = 200_000
const CATALOG_PAGE_GAP_MS = 120

/** Only the fields mapMarket/isUsFutures read: 54k cached rows with descriptions and images was needless memory. */
const CATALOG_FIELDS = ['bestAskQuote', 'bestBidQuote', 'closed', 'endDate', 'ep3Status', 'feeCoefficient', 'gameStartTime', 'id', 'marketSides', 'minimumTradeQty', 'orderPriceMinTickSize', 'outcomePrices', 'outcomes', 'question', 'slug', 'status', 'title', 'volume', 'volume24hr', 'marketType', 'sportsMarketType'] as const
function catalogRow(m: UsMarket): UsMarket {
  const out: Record<string, unknown> = {}
  for (const k of CATALOG_FIELDS) if ((m as Record<string, unknown>)[k] !== undefined) out[k] = (m as Record<string, unknown>)[k]
  return out as UsMarket
}

export function isUsFutures(m: { marketType?: string; sportsMarketType?: string }): boolean {
  return m.marketType === 'futures' || m.sportsMarketType === 'futures'
}

/**
 * The derived trading close (ms). Games close at kickoff (endDate is weeks
 * late); a game that started over six hours ago and is not resolved is dead;
 * daily markets and futures keep endDate.
 */
export function deriveUsCloseTime(i: { endMs?: number; gameMs?: number; resolved: boolean; futures: boolean }, now: number): number | undefined {
  const { endMs, gameMs, resolved, futures } = i
  if (futures) return endMs
  const staleGame = gameMs !== undefined && !resolved && gameMs < now - 6 * 3600_000
  if (staleGame) return gameMs
  // Once a market RESOLVES the venue replaces the placeholder with a real endDate - the settled NFL props
  // read 2026-09-09T23:49Z against a kickoff of 00:20Z the next day - so trust it from that point on.
  if (resolved) return endMs
  // No `gameMs > now` here, deliberately (2026-09-12). A game's trading close is kickoff whether kickoff is
  // ahead of us or behind; nothing about that depends on when we ask. Requiring a FUTURE kickoff left a
  // six-hour hole between kickoff and the stale-game branch above, and inside it this returned endDate - a
  // placeholder the venue sets at kickoff + 14 days. Because refreshedCloseTime adopts a LATER venue close,
  // a single getMarket inside that window ratcheted a live position's close a fortnight forward: out of
  // settlement range, hidden from the out-of-window exit, and holding one of the venue's 48 slots until the
  // venue stopped quoting the market. Fourteen finished NFL props blocked the venue this way on 09-10, and
  // ten more games were doing it again by 09-12.
  return gameMs !== undefined && endMs !== undefined && endMs - gameMs > 48 * 3600_000 ? gameMs : endMs
}

interface UsMarket {
  id?: number | string
  slug?: string
  question?: string
  title?: string
  outcomes?: string
  outcomePrices?: string
  endDate?: string
  active?: boolean
  closed?: boolean
  /** moneyline | drawable_outcome | futures | ... ("futures" = tournament, season or election winner). */
  marketType?: string
  sportsMarketType?: string
  volume?: string | number
  volume24hr?: string | number
  bestBidQuote?: { value?: string } | null
  bestAskQuote?: { value?: string } | null
  settlement?: unknown
  /** Taker fee coefficient (e.g. "0.06"). */
  feeCoefficient?: string | number
  /** Minimum trade quantity in contracts. */
  minimumTradeQty?: string | number
  /** Price tick size (e.g. "0.001"). */
  orderPriceMinTickSize?: string | number
  marketSides?: { description?: string; price?: string | number | null; long?: boolean; tradable?: boolean }[]
  /** MARKET_STATUS_OPEN | MARKET_STATUS_RESOLVED | MARKET_STATUS_HALTED ... (never read before). */
  status?: string
  ep3Status?: string
  /** Sports: the game start. Trading halts here; endDate is a median 55 DAYS later. */
  gameStartTime?: string
}

interface UsBookEntry {
  px?: { value?: string }
  qty?: string
  size?: string
  quantity?: string
}

interface UsExecution {
  lastShares?: string
  lastPx?: { value?: string }
}

interface UsTrade {
  id?: string
  marketSlug?: string
  state?: string
  price?: { value?: string }
  qtyDecimal?: string
  isAggressor?: boolean
  realizedPnl?: { value?: string } | null
  updateTime?: string
}

interface UsExecution {
  order?: { id?: string; intent?: string; outcomeSide?: string; action?: string; manualOrderIndicator?: string }
  lastShares?: string
  lastPx?: { value?: string }
  commissionNotionalCollected?: { value?: string } | null
}
interface UsPositionSide {
  netPositionDecimal?: string
  netPosition?: string
  cost?: { value?: string }
  realized?: { value?: string }
  updateTime?: string
}
export interface UsActivity {
  type?: string
  accountBalanceChange?: { transactionId?: string; status?: string; amount?: { value?: string; currency?: string } }
  trade?: UsTrade & { aggressorExecution?: UsExecution; passiveExecution?: UsExecution; createTime?: string }
  positionResolution?: { marketSlug?: string; beforePosition?: UsPositionSide; afterPosition?: UsPositionSide; updateTime?: string; side?: string }
}

/** A flat account's cash less completed outside funding is net trading P&L, including fees. */
export function usCashPnl(activities: UsActivity[], balance: number, openPositions: number): LivePnl {
  const result: LivePnl = { available: false, source: 'unavailable', realizedPnl: 0, fees: 0, settlements: 0, fills: 0 }
  const fail = (why: string) => ({ ...result, unavailableReason: why })
  if (openPositions || !Number.isFinite(balance)) return fail('Cash reconciliation requires a flat account and a valid balance.')
  let funding = 0, fundingRows = 0
  const seen = new Set<string>()
  for (const a of activities) {
    if (a.trade) {
      const t = a.trade
      if (/CANCEL|REJECT|BUST/i.test(t.state ?? '')) return fail('Corrected trade activity requires a cash-ledger audit.')
      const fee = Number((t.isAggressor ? t.aggressorExecution : t.passiveExecution)?.commissionNotionalCollected?.value ?? 0)
      if (!Number.isFinite(fee)) return fail('Invalid fee in account activity.')
      result.fees += fee; result.fills++
    } else if (a.positionResolution) result.settlements++
    else if (a.accountBalanceChange) {
      const c = a.accountBalanceChange
      if (c.status !== 'ACCOUNT_BALANCE_CHANGE_STATUS_COMPLETED') return fail('Unsettled funding activity prevents a final cash reconciliation.')
      if (!c.transactionId || seen.has(c.transactionId)) return fail('Missing or duplicate funding identifier.')
      seen.add(c.transactionId)
      const value = Number(c.amount?.value)
      if (!Number.isFinite(value) || c.amount?.currency !== 'USD') return fail('Invalid funding amount or currency.')
      if (['ACTIVITY_TYPE_TAKER_FEE_REBATE', 'ACTIVITY_TYPE_LIQUIDITY_PROGRAM'].includes(a.type ?? '')) continue
      if (!['ACTIVITY_TYPE_ACCOUNT_DEPOSIT', 'ACTIVITY_TYPE_ACCOUNT_WITHDRAWAL', 'ACTIVITY_TYPE_REFERRAL_BONUS', 'ACTIVITY_TYPE_TRANSFER'].includes(a.type ?? '')) return fail('Unrecognized funding type; reconciliation required.')
      funding += a.type === 'ACTIVITY_TYPE_ACCOUNT_WITHDRAWAL' ? -Math.abs(value) : value
      fundingRows++
    } else return fail('Unrecognized account activity.')
  }
  if (!fundingRows && (balance !== 0 || activities.length)) return fail('No opening funding history; cash P&L unavailable.')
  return { ...result, available: true, source: 'account-cash', realizedPnl: balance - funding }
}

export class PolymarketUsAdapter implements VenueAdapter {
  readonly id: VenueId = 'polymarket-us'
  readonly name = 'Polymarket US'
  readonly currency = 'USD'
  readonly capabilities: VenueCapabilities = {
    liveTrading: true,
    realMoney: true,
    socialExposure: false
  }

  private gateway: HttpClient
  private api: HttpClient
  /**
   * Background catalog index (2026-09-18). The gateway lists 80,000+ open markets, leaves `volume` null on every
   * row, and honours neither orderBy=gameStartTime nor a start-time floor, so the only way to find every
   * short-dated market is to walk the whole catalog. A 3,000-row walk per scan saw ~4% of it (the paper lab
   * tracked 12 of 791 candidates). This walks all of it every CATALOG_REFRESH_MS in the background, keeps the
   * rows whose derived close is inside CATALOG_HORIZON_MS, and lets searchMarkets('ending-soon') read from it.
   */
  private catalog?: { at: number; rows: UsMarket[] }
  private catalogTimer?: ReturnType<typeof setInterval>
  private catalogWalking = false
  private keyId?: string
  private edKey?: KeyObject

  constructor(marketDataPaceMs?:number) {
    this.gateway = new HttpClient({ baseUrl: GATEWAY, rateLimit: marketDataPaceMs?1:200, rateLimitWindowMs:marketDataPaceMs })
    this.api = new HttpClient({ baseUrl: API, rateLimit: 200 })
  }

  /** Start the background catalog walk (idempotent). Exposed so the app can start it without credentials. */
  startCatalogRefresh(moneylinesPath?: string): void {
    if (this.catalogTimer) return
    this.moneylinesPath = moneylinesPath
    void this.refreshCatalog().catch(() => undefined)
    this.catalogTimer = setInterval(() => { void this.refreshCatalog().catch(() => undefined) }, CATALOG_REFRESH_MS)
    this.catalogTimer.unref?.()
  }

  /** The moneyline subset of the index for scripts/sports-books.mjs (backlog 151), so the recorder does not walk
   *  the gateway a second time. Atomic write; a failure is logged, never thrown. */
  private moneylinesPath?: string
  private writeMoneylines(rows: UsMarket[]): void {
    if (!this.moneylinesPath) return
    try {
      const ml = rows.filter((m) => typeof m.slug === 'string' && m.slug.startsWith('aec-') && /^who will win\b/i.test(String(m.question ?? '')))
      writeFileSync(`${this.moneylinesPath}.tmp`, JSON.stringify({ at: Date.now(), rows: ml }))
      renameSync(`${this.moneylinesPath}.tmp`, this.moneylinesPath)
    } catch (e) {
      console.warn(`[polymarket-us] moneylines file: ${String(e).slice(0, 120)}`)
    }
  }

  /** One full walk of the open catalog; keeps rows closing inside the horizon. Never throws to the caller. */
  async refreshCatalog(): Promise<number> {
    if (this.catalogWalking) return this.catalog?.rows.length ?? 0
    this.catalogWalking = true
    const started = Date.now()
    try {
      const kept: UsMarket[] = []
      let pages = 0
      for (let offset = 0; offset < CATALOG_MAX_ROWS; offset += 100) {
        const params = new URLSearchParams({ limit: '100', offset: String(offset), closed: 'false', orderBy: 'volume', orderDirection: 'desc' })
        const res = await this.gateway.get<{ markets?: UsMarket[] }>(`/v1/markets?${params.toString()}`)
        const ms = res.markets ?? []
        pages++
        for (const m of ms) {
          if (m.closed) continue
          const close = deriveUsCloseTime({ endMs: m.endDate ? Date.parse(m.endDate) : undefined, gameMs: m.gameStartTime ? Date.parse(m.gameStartTime) : undefined, resolved: m.status === 'MARKET_STATUS_RESOLVED', futures: isUsFutures(m) }, started)
          if (close !== undefined && close > started && close - started <= CATALOG_HORIZON_MS) kept.push(catalogRow(m))
        }
        if (ms.length < 100) break
        await new Promise((r) => setTimeout(r, CATALOG_PAGE_GAP_MS))
      }
      this.catalog = { at: Date.now(), rows: kept }
      this.writeMoneylines(kept)
      console.log(`[polymarket-us] catalog walk: ${pages} pages, ${kept.length} markets closing within ${CATALOG_HORIZON_MS / 3600_000}h, ${((Date.now() - started) / 1000).toFixed(0)}s`)
      return kept.length
    } catch (err) {
      console.warn('[polymarket-us] catalog walk failed:', err instanceof Error ? err.message : String(err))
      return this.catalog?.rows.length ?? 0
    } finally {
      this.catalogWalking = false
    }
  }

  async init(credentials?: VenueCredentials): Promise<void> {
    this.keyId = typeof credentials?.apiKeyId === 'string' ? credentials.apiKeyId : undefined
    const secret = typeof credentials?.privateKey === 'string' ? credentials.privateKey : undefined
    this.edKey = undefined
    if (secret) {
      try {
        const seed = Buffer.from(secret, 'base64').subarray(0, 32)
        this.edKey = createPrivateKey({
          key: Buffer.concat([ED25519_PREFIX, seed]),
          format: 'der',
          type: 'pkcs8'
        })
      } catch {
        this.edKey = undefined
      }
    }
  }

  // ---- market data (public gateway) ----

  async searchMarkets(query: MarketSearchQuery): Promise<VenueMarket[]> {
    // For "ending soon" we paginate the full catalog: volume-sort buries the
    // low-volume short-dated markets (esports/soccer/weather), so a shallow
    // fetch only returns long-dated futures.
    //
    // 3,000 rather than 1,000 (2026-09-09): the venue leaves `volume` NULL on
    // every row, so orderBy=volume is not a liquidity ranking — it is an
    // arbitrary but stable order, and the first 1,000 rows of ~33,800 were a
    // fixed 3% sample. A coverage sweep found 4 genuine fade-band candidates
    // (4-7c, 19-22h to close) at offsets 2,020-7,849, outside the old bound,
    // which is why polyus-fade had never filled an order. The cost is 20 extra
    // 100-row requests on a scan that completes in 3.6s against Kalshi's 68s.
    const want = query.sort === 'ending-soon' ? 3000 : Math.min(query.limit ?? 200, 1000)
    let collected: UsMarket[] = []
    // A fresh catalog index covers the whole venue; the 3,000-row walk below is the fallback until the first walk lands.
    const fresh = query.sort === 'ending-soon' && this.catalog && Date.now() - this.catalog.at < CATALOG_STALE_MS
    if (fresh) collected = this.catalog!.rows.slice()
    else
    // Paginate: the gateway caps at 100/request and volume-sorts. orderBy=endDate
    // is silently ignored, so we bound by date and sort client-side.
    for (let offset = 0; offset < want; offset += 100) {
      const params = new URLSearchParams()
      params.set('limit', '100')
      params.set('offset', String(offset))
      params.set('closed', 'false')
      params.set('orderBy', 'volume')
      params.set('orderDirection', 'desc')
      // endDate is NOT the trading close for sports (median 55 days after the
      // game), so a server-side endDateMax window hides the entire sports
      // catalog and reads as "no markets" inside any short horizon. Fetch the
      // open catalog and apply the horizon CLIENT-SIDE on the derived
      // closeTime (gameStartTime-aware) after mapping.
      params.set('endDateMin', new Date(Math.min(query.minCloseTime ?? Date.now(), Date.now())).toISOString())
      const res = await this.gateway.get<{ markets?: UsMarket[] }>(`/v1/markets?${params.toString()}`)
      const ms = res.markets ?? []
      if (ms.length === 0) break
      collected.push(...ms)
      if (ms.length < 100) break
    }
    const now = Date.now()
    let mapped = collected
      .filter((m) => !m.closed && (!m.endDate || Date.parse(m.endDate) >= now))
      .map((m) => this.mapMarket(m))
    // Horizon on the DERIVED close time (see mapMarket), not the venue's endDate.
    if (query.minCloseTime !== undefined) mapped = mapped.filter((m) => m.closeTime === undefined || m.closeTime >= query.minCloseTime!)
    if (query.maxCloseTime !== undefined) mapped = mapped.filter((m) => m.closeTime !== undefined && m.closeTime <= query.maxCloseTime!)
    if (query.term) {
      const t = query.term.toLowerCase()
      mapped = mapped.filter((m) => m.question.toLowerCase().includes(t))
    }
    if (query.sort === 'ending-soon') {
      mapped = mapped.sort((a, b) => (a.closeTime ?? Infinity) - (b.closeTime ?? Infinity))
    }
    return mapped.slice(0, query.limit ?? 200)
  }

  async getMarket(id: string): Promise<VenueMarket> {
    const res = await this.gateway.get<{ markets?: UsMarket[] }>(`/v1/markets?slug=${encodeURIComponent(id)}`)
    const m = res.markets?.[0]
    if (!m) throw new Error(`Polymarket US market ${id} not found`)
    const mapped = this.mapMarket(m)
    // Past close with no resolution: ask the public settlement endpoint so
    // strategies can settle mini positions with venue truth.
    // Ask for settlement when the venue says RESOLVED or the close has passed —
    // not the clock alone (sports endDate is weeks late; a cached closeTime
    // stalled Kalshi settlement the same way). The book is the primary source:
    // /settlement 404/500'd on 11 of 16 resolved markets and cannot express a
    // fractional (void / last-traded) settlement, which 3.2% of markets have.
    //
    // RESOLVED only (review 2026-09-22, section 160). The book says EXPIRED minutes before the venue writes the real
    // 0/1, and its settlementPx meanwhile holds the last close: 47 of 177 live closes and 4 of 40 lab settlements
    // were booked at that provisional price (Chelsea-Hull at 0.07, finalized 0). Once RESOLVED, the long side's
    // own price is final too; the two must agree or we wait for the next pass.
    if (mapped.resolution === undefined && mapped.resolved) {
      const book = await this.fetchSettlementPrice(mapped.id)
      const side = resolvedLongPrice(m)
      const px = book !== undefined && (side === undefined || Math.abs(book - side) < 0.0005) ? book : undefined
      if (px !== undefined) {
        mapped.resolved = true
        if (px === 1) mapped.resolution = 'yes'
        else if (px === 0) mapped.resolution = 'no'
        else {
          // Fractional: settle at price, the same way Manifold MKT does.
          mapped.resolution = 'MKT'
          mapped.resolutionProbability = px
        }
      }
    }
    return mapped
  }

  async getPrice(marketId: string, outcome = 'YES'): Promise<PriceQuote> {
    const m = await this.getMarket(marketId)
    // No YES price means no quote. The old `?? 0` fabricated YES=0 / NO=1 and
    // the mini would sell into it.
    if (m.probability === undefined) throw new Error(`No price available for ${marketId}`)
    const yes = m.probability
    const price = outcome === 'YES' ? yes : 1 - yes
    return { venue: this.id, marketId, outcome, price, probability: yes, timestamp: Date.now() }
  }

  async getOrderBook(marketId: string): Promise<OrderBook> {
    // Response shape: { marketData: { marketSlug, bids: [{px:{value},qty}], offers: [{px:{value},qty}] } }
    const res = await this.gateway.get<{ marketData?: { bids?: UsBookEntry[]; offers?: UsBookEntry[] } }>(
      `/v1/markets/${encodeURIComponent(marketId)}/book`
    )
    const md = res.marketData ?? (res as unknown as { bids?: UsBookEntry[]; offers?: UsBookEntry[] })
    const parseSide = (raw?: UsBookEntry[]): { price: number; size: number }[] => {
      if (!Array.isArray(raw)) return []
      return raw
        .map((e) => {
          const price = parseFloat(String(e.px?.value ?? ''))
          const size = parseFloat(String(e.qty ?? e.size ?? e.quantity ?? ''))
          return { price, size }
        })
        .filter((l) => Number.isFinite(l.price) && l.price > 0 && l.size > 0)
    }
    const bids = parseSide(md.bids).sort((a, b) => b.price - a.price)
    const asks = parseSide(md.offers).sort((a, b) => a.price - b.price)
    return { venue: this.id, marketId, bids, asks }
  }

  // ---- account ----

  async getAccount(): Promise<AccountInfo> {
    this.requireAuth()
    const data = await this.authGet<{ balances?: { currency?: string; currentBalance?: number; marginRequirement?: number }[] }>(
      '/v1/account/balances'
    )
    const usd = data.balances?.find((b) => b.currency === 'USD')
    if (usd?.currentBalance === undefined || usd.currentBalance === null || !Number.isFinite(Number(usd.currentBalance))) throw new Error('Missing or invalid USD balance')
    if (usd.marginRequirement === undefined || usd.marginRequirement === null || !Number.isFinite(Number(usd.marginRequirement)) || Number(usd.marginRequirement) < 0) throw new Error('Missing or invalid USD margin requirement')
    return {
      venue: this.id,
      userId: this.keyId!,
      username: 'Polymarket US',
      // Current balance includes short collateral. Sep 10/11 complete activity
      // replays reconcile cash exactly after subtracting the venue's margin.
      balance: Number(usd.currentBalance) - Number(usd.marginRequirement),
      currency: this.currency,
      realMoney: true
    }
  }

  async getPositions(): Promise<Position[]> {
    this.requireAuth()
    const positions: Record<string, { netPositionDecimal?: string; avgPx?: { value?: string }; cost?: string | { value?: string } }> = {}
    let cursor = ''
    const seen = new Set<string>()
    for (;;) {
      const data = await this.authGet<{ positions?: typeof positions; nextCursor?: string; eof?: boolean }>(
        '/v1/portfolio/positions' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''))
      if (!data.positions || typeof data.positions !== 'object' || Array.isArray(data.positions)) throw new Error('Missing positions ledger')
      for (const [slug, p] of Object.entries(data.positions)) {
        if (slug in positions) throw new Error('Repeated position across pages')
        positions[slug] = p
      }
      if (data.eof === true || (!data.nextCursor && data.eof !== false)) break
      if (!data.nextCursor || seen.has(data.nextCursor)) throw new Error('Incomplete or repeated positions cursor')
      cursor = data.nextCursor; seen.add(cursor)
    }
    const out: Position[] = []
    for (const [slug, p] of Object.entries(positions)) {
      if (!p || p.netPositionDecimal === undefined || p.netPositionDecimal === '') throw new Error('Missing position quantity')
      const net = Number(p.netPositionDecimal)
      if (!Number.isFinite(net)) throw new Error('Invalid position quantity')
      if (net === 0) continue
      // cost may arrive as an Amount object ({ value, currency }); parseFloat
      // of an object is NaN, which made every avgPrice NaN.
      const cost = parseFloat(typeof p.cost === 'object' && p.cost !== null ? (p.cost.value ?? '0') : (p.cost ?? '0'))
      const avgPrice = p.avgPx?.value !== undefined ? Number(p.avgPx.value) : cost / Math.abs(net)
      if (!Number.isFinite(avgPrice) || avgPrice < 0 || avgPrice > 1) throw new Error('Invalid position cost')
      out.push({
        venue: this.id,
        marketId: slug,
        outcome: net > 0 ? 'YES' : 'NO',
        shares: Math.abs(net),
        // Position avgPx is already the held leg: BUY_SHORT execution at YES
        // 0.075 produces position avgPx 0.925 (verified Sep 11 account snapshot).
        avgPrice
      })
    }
    return out
  }

  /** Open resting orders (maker lifecycle). Field names mapped defensively. */
  async getOpenOrders(): Promise<OpenOrder[]> {
    this.requireAuth()
    const raw = await this.authGet<unknown>('/v1/orders/open?limit=500')
    const container = (raw ?? {}) as Record<string, unknown>
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray(container.orders)
        ? container.orders
        : Array.isArray(container.openOrders)
          ? container.openOrders
          : Array.isArray(container.open_orders)
            ? container.open_orders
            : undefined
    if (!rows || container.nextCursor || container.eof === false) throw new Error('Missing or incomplete open orders ledger')
    return (rows as Record<string, unknown>[])
      .map((outer) => {
        const nested = (outer.order && typeof outer.order === 'object' ? outer.order : outer) as Record<string, unknown>
        const qty = firstNum(nested, ['quantityDecimal', 'quantity', 'qtyDecimal', 'qty', 'order_qty', 'orderQty'])
        const filled = firstNum(nested, ['filledQuantityDecimal', 'filledQuantity', 'cumQuantityDecimal', 'cumQuantity', 'cumQtyDecimal', 'cumQty', 'cum_qty', 'executedQuantity'])
        const rawPrice = nested.price
        const priceValue = typeof rawPrice === 'object' && rawPrice !== null
          ? (rawPrice as { value?: unknown }).value
          : rawPrice
        let sidePrice = priceValue === undefined ? 0 : parseFloat(String(priceValue))
        // Institutional schema uses fixed-point integer prices; retail uses decimal Amount.value.
        if (sidePrice > 1) sidePrice /= sidePrice > 100 ? 10_000 : 100
        const intent = String(nested.intent ?? nested.order_intent ?? '')
        const outcomeSide = String(nested.outcomeSide ?? nested.outcome_side ?? '')
        const isShort = intent.includes('SHORT') || outcomeSide.toUpperCase().includes('NO')
        return {
          orderId: String(nested.id ?? nested.orderId ?? nested.order_id ?? ''),
          marketId: String(nested.marketSlug ?? nested.market_slug ?? nested.symbol ?? ''),
          outcome: (isShort ? 'NO' : 'YES') as 'YES' | 'NO',
          yesPrice: sidePrice,
          initialCount: qty,
          fillCount: filled,
          remainingCount: Math.max(0, firstNum(nested, ['leaves_qty', 'leavesQty', 'leavesQuantity']) || qty - filled),
          status: 'resting' as const,
          createdTs: nested.createTime || nested.created_at ? Date.parse(String(nested.createTime ?? nested.created_at)) : undefined
        }
      })
      .filter((o) => o.orderId !== '')
  }

  /**
   * All pages of the activity feed for the given types, newest first, up to `max` rows.
   * The venue ignores `limit` and serves 20 rows a page, so this fires ~20 requests back to
   * back; unpaced, that burst 429s and the 3 retries (~4 s of backoff) cannot clear a
   * per-minute window. On 2026-09-12 every reconciler run failed for 5 h 50 m and 12 fills
   * went unpublished. The read-only dump paginates the same feed with a 700 ms pause and
   * has never been refused, so the page loop waits the same.
   */
  private async activities(types: string, max: number): Promise<UsActivity[]> {
    const out: UsActivity[] = []
    let cursor = ''
    const seen = new Set<string>()
    for (let page = 0; out.length < max; page++) {
      if (page > 0) await new Promise((r) => setTimeout(r, ACTIVITY_PAGE_PACE_MS))
      const q = `limit=500&sortOrder=SORT_ORDER_DESCENDING` + (types ? `&types=${types}` : '') + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
      const data = await this.authGet<{ activities?: UsActivity[]; nextCursor?: string; eof?: boolean }>(`/v1/portfolio/activities?${q}`)
      if (!Array.isArray(data.activities)) throw new Error('Missing activities page')
      const rows = data.activities
      out.push(...rows)
      if (data.eof === true) break
      if (!data.nextCursor || rows.length === 0 || seen.has(data.nextCursor)) throw new Error('Incomplete or repeated activities cursor')
      cursor = data.nextCursor
      seen.add(cursor)
    }
    return out.slice(0, max)
  }

  async getAccountPnl(): Promise<LivePnl> {
    try {
      const before = await this.getAccount()
      const activities = await this.activities('', Infinity)
      const positions = await this.getPositions()
      const after = await this.getAccount()
      if (before.balance !== after.balance) throw new Error('Account changed during reconciliation; retry on the next refresh')
      return reconcileUsLedger(activities, positions, after.balance, usCashPnl(activities, after.balance, 0))
    } catch (e) {
      return { available: false, source: 'unavailable', realizedPnl: 0, fees: 0, settlements: 0, fills: 0,
        unavailableReason: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Cleared TRADE activities: our own execution's side, size, price and commission. */
  async getFills(limit = 200): Promise<VenueFill[]> {
    this.requireAuth()
    const out: VenueFill[] = []
    for (const a of await this.activities('ACTIVITY_TYPE_TRADE', Math.max(1, limit))) {
      const t = a.trade
      // The feed reports every trade as TRADE_STATE_NEW (168 of 168 on 2026-09-06);
      // filtering for a 'cleared' state returned nothing for the venue's whole life.
      if (!t || /CANCEL|REJECT|BUST/i.test(t.state ?? '')) continue
      const ex = t.isAggressor ? t.aggressorExecution : t.passiveExecution
      const qty = parseFloat(ex?.lastShares ?? t.qtyDecimal ?? '0')
      if (!(qty > 0)) continue
      const outcome: 'YES' | 'NO' = ex?.order?.outcomeSide === 'OUTCOME_SIDE_NO' ? 'NO' : 'YES'
      out.push({
        id: t.id ?? '',
        orderId: ex?.order?.id,
        marketId: t.marketSlug ?? '',
        outcome,
        side: ex?.order?.action === 'ORDER_ACTION_SELL' ? 'sell' : 'buy',
        shares: qty,
        // price.value is ALWAYS the YES-leg price regardless of order intent.
        // placeOrder and sellPosition convert; this path did not, so every NO
        // fill was recorded at its complement (2026-09-09 audit: 114 of 261
        // rows). Rows written before this fix keep the old convention.
        price: (() => {
          const yesPx = parseFloat(ex?.lastPx?.value ?? t.price?.value ?? '0')
          return outcome === 'YES' ? yesPx : 1 - yesPx
        })(),
        fee: parseFloat(ex?.commissionNotionalCollected?.value ?? '0') || 0,
        isTaker: !!t.isAggressor,
        // Raw realizedPnl does not reconcile to cash and is not an additive fill profit.
        timestamp: t.updateTime ? Date.parse(t.updateTime) : 0
      })
    }
    return out
  }

  /**
   * POSITION_RESOLUTION activities as settlements: the venue reports the
   * position before and after resolution, so realized P&L is the change in
   * its realized field and the market result follows the sign of the position
   * that won. Commissions are charged on the trades, not here.
   */
  async getSettlements(limit = 100): Promise<VenueSettlement[]> {
    this.requireAuth()
    const out: VenueSettlement[] = []
    for (const a of await this.activities('ACTIVITY_TYPE_POSITION_RESOLUTION', Math.max(1, limit))) {
      const r = a.positionResolution
      const before = r?.beforePosition
      const after = r?.afterPosition
      if (!r?.marketSlug || !before || !after) continue
      const net = parseFloat(before.netPositionDecimal ?? before.netPosition ?? '0')
      const shares = Math.abs(net)
      if (!(shares > 0)) continue
      const cost = Math.abs(parseFloat(before.cost?.value ?? '0'))
      const realized = parseFloat(after.realized?.value ?? '0') - parseFloat(before.realized?.value ?? '0')
      // The record says which side won; the realized-P&L change is 0 on 12 of 182 real resolutions and read those wins
      // as losses (review 2026-09-22, section 160). usLedger.ts reads the same field. Fall back only when it is absent.
      const result: 'YES' | 'NO' =
        r.side === 'POSITION_RESOLUTION_SIDE_LONG' ? 'YES' : r.side === 'POSITION_RESOLUTION_SIDE_SHORT' ? 'NO' : net > 0 ? (realized > 0 ? 'YES' : 'NO') : realized > 0 ? 'NO' : 'YES'
      out.push({
        marketId: r.marketSlug,
        result,
        shares,
        cost,
        revenue: cost + realized,
        settlementRevenue: cost + realized,
        yesShares: net > 0 ? shares : 0,
        noShares: net < 0 ? shares : 0,
        fee: 0,
        realizedPnl: realized,
        timestamp: after.updateTime ? Date.parse(after.updateTime) : before.updateTime ? Date.parse(before.updateTime) : 0
      })
    }
    return out
  }
  // ---- trading ----

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    this.requireAuth()
    const maker = order.postOnly === true || order.timeInForce === 'good_till_canceled'
    let body: Record<string, unknown>
    if (maker && order.limitPrice !== undefined) {
      // Resting LIMIT order (maker path). docs.polymarket.us orders/overview,
      // 'Understanding Price with Order Intent': "The price.value field ALWAYS
      // represents the long side's price, regardless of which order intent you
      // use ... To trade the NO side at any price X, set price.value = 1.00 - X."
      // order.limitPrice is already the YES-leg price from the strategy, so it
      // is sent UNCHANGED for both intents. The previous 1 - limit for NO put a
      // 7c-YES longshot fade at 0.93 - ~90 ticks off-market, and inverted on
      // readback. Quantity is contracts, sized off the LEG cost we actually pay.
      const yesPrice = order.limitPrice
      if (!(yesPrice > 0 && yesPrice < 1)) throw new Error('Maker limit out of range')
      const legCost = order.outcome === 'YES' ? yesPrice : 1 - yesPrice
      body = {
        marketSlug: order.marketId,
        type: 'ORDER_TYPE_LIMIT',
        price: { value: yesPrice.toFixed(3), currency: 'USD' },
        quantity: order.contracts !== undefined
          ? Math.max(1, Math.floor(order.contracts))
          : Math.max(1, Math.floor(order.amount / Math.max(legCost, 0.01))),
        intent: order.outcome === 'YES' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT',
        manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
        participateDontInitiate: true,
        synchronousExecution: true,
        maxBlockTime: '10',
        ...(order.expirationTs
          ? { tif: 'TIME_IN_FORCE_GOOD_TILL_DATE', goodTillTime: new Date(order.expirationTs * 1000).toISOString() }
          : { tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL' })
      }
    } else if (order.timeInForce === 'immediate_or_cancel' && order.limitPrice !== undefined) {
      // Taker LIMIT, immediate-or-cancel: it cannot trade worse than the limit, which is the long side's price for
      // both intents (the docs: "price.value always represents the long side's price"). The market order's slippage
      // band below does not bound a BUY_SHORT: on 2026-09-23 a lag order sent with a 0.83 long bid as its reference
      // bought the short side at an average 0.42 - 25c worse than the 0.17 it was sent for (section 162).
      const yesPrice = order.limitPrice
      if (!(yesPrice > 0 && yesPrice < 1)) throw new Error('Taker limit out of range')
      const legCost = order.outcome === 'YES' ? yesPrice : 1 - yesPrice
      body = {
        marketSlug: order.marketId,
        type: 'ORDER_TYPE_LIMIT',
        price: { value: yesPrice.toFixed(3), currency: 'USD' },
        quantity: order.contracts !== undefined
          ? Math.max(1, Math.floor(order.contracts))
          : Math.max(1, Math.floor(order.amount / Math.max(legCost, 0.01))),
        tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
        intent: order.outcome === 'YES' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT',
        manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
        synchronousExecution: true,
        maxBlockTime: '10'
      }
    } else {
      body = {
        marketSlug: order.marketId,
        type: 'ORDER_TYPE_MARKET',
        cashOrderQty: { value: String(order.amount), currency: 'USD' },
        tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
        intent: order.outcome === 'YES' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT',
        manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
        // Block until executed so the response carries real executions — without
        // this the app had to guess fills (and guessed wrong).
        synchronousExecution: true,
        maxBlockTime: '10'
      }
      // Bound market-order slippage when the caller supplied a YES-leg limit:
      // reference the side price the limit implies and allow a small band.
      if (order.limitPrice !== undefined) {
        // currentPrice is a price.value, i.e. the YES price, for either intent.
        const yesRef = order.limitPrice
        if (yesRef > 0 && yesRef < 1) {
          body.slippageTolerance = {
            currentPrice: { value: yesRef.toFixed(3), currency: 'USD' },
            bips: 100
          }
        }
      }
    }
    // Never retry a rejected limit/slippage instruction as an unprotected market order.
    order.onSubmit?.()
    const res = await this.authPost<{ id?: string; executions?: UsExecution[] }>('/v1/orders', body)
    const executions = res.executions ?? []
    let filled = 0
    let notional = 0
    for (const e of executions) {
      const s = parseFloat(e.lastShares ?? '0')
      // Execution prices follow the same contract as price.value: the YES
      // price. A NO fill cost us 1 - that.
      const yesPx = parseFloat(e.lastPx?.value ?? '0')
      const legPx = order.outcome === 'YES' ? yesPx : 1 - yesPx
      filled += s
      notional += s * legPx
    }
    // Report only what actually executed — the old estimated-shares fallback
    // fabricated fills that never happened.
    return {
      venue: this.id,
      orderId: res.id ?? '',
      marketId: order.marketId,
      outcome: order.outcome,
      amount: filled > 0 ? notional : 0,
      shares: filled,
      avgPrice: filled > 0 ? notional / filled : 0,
      fee: executions.reduce((sum, e) => sum + (Number(e.commissionNotionalCollected?.value ?? 0)), 0),
      status: filled > 0 ? 'filled' : 'open',
      timestamp: Date.now()
    }
  }

  async sellPosition(req: SellRequest): Promise<OrderResult> {
    this.requireAuth()
    const positions = await this.getPositions()
    const pos = positions.find((p) => p.marketId === req.marketId && p.outcome === req.outcome)
    const held = pos?.shares ?? 0
    const shares = req.shares !== undefined ? Math.min(req.shares, held) : held
    if (shares <= 0) throw new Error('No position to sell')
    if (req.limitPrice !== undefined && !(req.limitPrice > 0 && req.limitPrice < 1)) throw new Error('Closing limit out of range')
    let res: { id?: string; executions?: UsExecution[] }
    req.onSubmit?.()
    if (req.limitPrice !== undefined || (req.shares !== undefined && held > 0 && req.shares < held - 1e-9)) {
      // Partial close: the close-position endpoint always sells the WHOLE
      // position, so partial exits go through a quantity market order in the
      // SELL intent for the held side.
      res = await this.authPost<{ id?: string; executions?: UsExecution[] }>('/v1/orders', {
        marketSlug: req.marketId,
        type: req.limitPrice === undefined ? 'ORDER_TYPE_MARKET' : 'ORDER_TYPE_LIMIT',
        ...(req.limitPrice === undefined ? {} : { price: { value: req.limitPrice.toFixed(3), currency: 'USD' } }),
        quantity: shares,
        tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
        intent: req.outcome === 'YES' ? 'ORDER_INTENT_SELL_LONG' : 'ORDER_INTENT_SELL_SHORT',
        manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
        synchronousExecution: true,
        maxBlockTime: '10'
      })
    } else {
      res = await this.authPost<{ id?: string; executions?: UsExecution[] }>('/v1/order/close-position', {
        marketSlug: req.marketId,
        synchronousExecution: true,
        maxBlockTime: '10',
        manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC'
      })
    }
    const executions = res.executions ?? []
    let filled = 0
    let notional = 0
    for (const e of executions) {
      const s = parseFloat(e.lastShares ?? '0')
      // price.value is ALWAYS the YES-leg price (docs: "regardless of order
      // intent"). placeOrder converts; this path did not, so selling a NO
      // position with YES at 10c booked proceeds of 10c/share instead of 90c
      // (found by the 2026-09-02 external review, verified from source).
      const yesPx = parseFloat(e.lastPx?.value ?? '0')
      const px = req.outcome === 'YES' ? yesPx : 1 - yesPx
      filled += s
      notional += s * px
    }
    const avgFill = filled > 0 ? notional / filled : 0
    // The venue charges a taker commission on the EXIT leg too. It was never
    // subtracted, so every closed mini trade booked about 3% of stake better
    // than it really did — and the ladder promotes and demotes on exactly this
    // number (2026-09-09 audit: $3.28 of exit commission unbooked on this
    // venue). Position avgPrice is pooled across strategies; callers with an
    // owned entry ledger must use their own cost basis and these execution fees.
    const exitFee = executions.reduce((a, e) => a + (parseFloat(e.commissionNotionalCollected?.value ?? '0') || 0), 0)
    return {
      venue: this.id,
      orderId: res.id ?? '',
      marketId: req.marketId,
      outcome: req.outcome,
      amount: notional,
      // Honest zero when nothing executed — callers keep the position and retry.
      shares: filled,
      avgPrice: avgFill,
      fee: exitFee,
      status: filled > 0 ? 'filled' : 'open',
      realizedPnl: pos && filled > 0 && avgFill > 0 ? (avgFill - pos.avgPrice) * filled - exitFee : undefined,
      timestamp: Date.now()
    }
  }

  /**
   * The venue's `CancelOrderRequest` body carries the market slug, and an empty
   * body is rejected with HTTP 400 `{"code":3}` — INVALID_ARGUMENT, not a
   * refusal to cancel (docs.polymarket.us, api-reference/orders/cancel-order).
   * Nineteen strategy-off rests survived that way on 2026-09-12.
   */
  async cancelOrder(orderId: string, marketSlug?: string): Promise<void> {
    this.requireAuth()
    const path = `/v1/order/${encodeURIComponent(orderId)}/cancel`
    await this.api.post(path, marketSlug ? { marketSlug } : {}, this.authHeaders('POST', path))
  }

  // ---- social (not supported) ----

  async getTopHolders(): Promise<Holder[]> {
    return []
  }

  async getUserPortfolio(): Promise<UserPortfolio> {
    throw new Error('Not supported on Polymarket US.')
  }

  async getUserBets(): Promise<UserBet[]> {
    throw new Error('Not supported on Polymarket US.')
  }

  async getLeaderboard(): Promise<Leader[]> {
    return []
  }

  async getUserHoldings(): Promise<Position[]> {
    return []
  }

  // ---- helpers ----

  private requireAuth(): void {
    if (!this.keyId || !this.edKey) throw new Error('Polymarket US credentials not configured')
  }

  private authHeaders(method: 'GET' | 'POST', path: string): Record<string, string> {
    this.requireAuth()
    const timestamp = String(Date.now())
    // The signed path excludes query parameters (docs.polymarket.us
    // authentication: message = timestamp + method + path, e.g.
    // "/v1/portfolio/positions").
    const bare = path.split('?')[0]
    const message = `${timestamp}${method}${bare}`
    const signature = sign(null, Buffer.from(message), this.edKey!).toString('base64')
    return {
      'X-PM-Access-Key': this.keyId!,
      'X-PM-Timestamp': timestamp,
      'X-PM-Signature': signature
    }
  }

  private authGet<T>(path: string): Promise<T> {
    return this.api.get<T>(path, this.authHeaders('GET', path))
  }

  private authPost<T>(path: string, body?: unknown): Promise<T> {
    return this.api.post<T>(path, body, this.authHeaders('POST', path))
  }

  private mapMarket(m: UsMarket): VenueMarket {
    let outcomes: string[] = []
    let prices: number[] = []
    try {
      outcomes = m.outcomes ? (JSON.parse(m.outcomes) as string[]) : []
      prices = m.outcomePrices ? (JSON.parse(m.outcomePrices) as number[]).map(Number) : []
    } catch {
      // leave empty
    }
    const bid = m.bestBidQuote?.value ? parseFloat(m.bestBidQuote.value) : undefined
    const ask = m.bestAskQuote?.value ? parseFloat(m.bestAskQuote.value) : undefined
    // outcomePrices is a NULL-DROPPED side list, not a positional [YES, NO]:
    // 247 of 1,740 open markets carried a single element, so index 0 was the
    // NO price whenever YES had no quote. marketSides is positional and
    // flags the long side explicitly (long === true on 3,141/3,141).
    const longSide = (m.marketSides ?? []).find((sd) => sd && sd.long === true)
    const longPx = longSide && longSide.price !== null && longSide.price !== undefined && longSide.price !== '' ? parseFloat(String(longSide.price)) : NaN
    const probability = Number.isFinite(longPx) && longPx > 0 ? longPx : prices.length === 2 && prices[0] > 0 ? prices[0] : undefined
    const resolved = m.status === 'MARKET_STATUS_RESOLVED'
    const endMs = m.endDate ? Date.parse(m.endDate) : undefined
    const gameMs = m.gameStartTime ? Date.parse(m.gameStartTime) : undefined
    // endDate is NOT the trading close for sports (median 55 days after the
    // game). When gameStartTime precedes endDate by more than two days the
    // market is a game and trading halts at the start; weather/daily markets
    // (gameStartTime ~24h before endDate) keep endDate. Data-driven, not a
    // category guess.
    // Only a FUTURE game start is a trading close. A season-long futures
    // market carries a gameStartTime at the season's opening day, months in
    // the past, while it keeps trading until endDate.
    // A game that started more than six hours ago and is not resolved is a dead
    // market with a stale book (the venue's endDate keeps it 'open' for weeks).
    // Report its close as the game start (already past) so no strategy enters it;
    // first live day: the mini bought YES on two WTA matches from three days earlier.
    // Futures (winner markets) keep endDate: see deriveUsCloseTime.
    const closeTime = deriveUsCloseTime({ endMs, gameMs, resolved, futures: isUsFutures(m) }, Date.now())
    return {
      venue: this.id,
      id: m.slug ?? String(m.id ?? ''),
      question: m.question ?? m.title ?? '',
      status: m.closed || resolved || m.ep3Status === 'CLOSED' ? 'closed' : 'open',
      resolved,
      probability,
      volume: num(m.volume),
      volume24h: num(m.volume24hr),
      outcomeType: outcomes.length === 2 ? 'BINARY' : 'OTHER',
      closeTime,
      spread: bid !== undefined && ask !== undefined ? Math.max(0, ask - bid) : undefined,
      feeRate: m.feeCoefficient !== undefined && m.feeCoefficient !== '' ? parseFloat(String(m.feeCoefficient)) : undefined,
      tickSize: m.orderPriceMinTickSize !== undefined ? num(m.orderPriceMinTickSize) || undefined : undefined,
      minTradeQty: m.minimumTradeQty !== undefined ? num(m.minimumTradeQty) || undefined : undefined,
      url: m.slug ? `https://polymarket.us/markets/${m.slug}` : undefined
    }
  }

  /** One order by id — fill attribution when the activities feed carries no order id. avgYes is the YES-leg average. */
  async getOrder(orderId: string): Promise<{ fillCount: number; avgYes?: number; state?: string } | undefined> {
    this.requireAuth()
    const raw = await this.authGet<Record<string, unknown>>(`/v1/order/${encodeURIComponent(orderId)}`).catch(() => undefined)
    if (!raw) return undefined
    const first = raw.order && typeof raw.order === 'object' ? raw.order as Record<string, unknown> : raw
    const o = first.order && typeof first.order === 'object' ? first.order as Record<string, unknown> : first
    const fillCount = firstNum(o, ['cumQuantity', 'cumQuantityDecimal', 'cum_qty', 'cumQty', 'filledQuantity'])
    const avgObj = (o['avgPx'] ?? o['averagePrice'] ?? o['avgPrice'] ?? o['avg_px']) as { value?: string } | string | number | undefined
    const avgRaw = typeof avgObj === 'object' && avgObj ? avgObj.value : avgObj
    let avgYes = avgRaw !== undefined && avgRaw !== '' ? parseFloat(String(avgRaw)) : undefined
    if (avgYes !== undefined && avgYes > 1) avgYes /= avgYes > 100 ? 10_000 : 100
    return { fillCount, avgYes: Number.isFinite(avgYes as number) ? (avgYes as number) : undefined, state: typeof o['state'] === 'string' ? (o['state'] as string) : undefined }
  }

  /** Validate an order payload against the venue WITHOUT placing it (POST /v1/order/preview). Returns the raw response for inspection. */
  async previewOrder(order: OrderRequest): Promise<unknown> {
    this.requireAuth()
    const yesPrice = order.limitPrice ?? 0.5
    const legCost = order.outcome === 'YES' ? yesPrice : 1 - yesPrice
    return this.authPost<unknown>('/v1/order/preview', {
      marketSlug: order.marketId,
      type: 'ORDER_TYPE_LIMIT',
      price: { value: yesPrice.toFixed(3), currency: 'USD' },
      quantity: Math.max(1, Math.floor(order.amount / Math.max(legCost, 0.01))),
      intent: order.outcome === 'YES' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT',
      manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
      participateDontInitiate: true,
      tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL'
    })
  }

  /**
   * Settlement PRICE (1, 0, or fractional) from the public book: marketData.state
   * EXPIRED/TERMINATED with stats.settlementPx (verified live 2026-09-02 on
   * resolved markets). Falls back to /settlement, which is unreliable.
   */
  private async fetchSettlementPrice(slug: string): Promise<number | undefined> {
    try {
      const res = await this.gateway.get<{ marketData?: { state?: string; stats?: { settlementPx?: { value?: string } | string } } }>(
        `/v1/markets/${encodeURIComponent(slug)}/book`
      )
      const md = res.marketData
      const st = md?.state
      if (st === 'MARKET_STATE_EXPIRED' || st === 'MARKET_STATE_TERMINATED') {
        const raw = md?.stats?.settlementPx
        const v = typeof raw === 'object' && raw ? raw.value : raw
        const px = v !== undefined && v !== '' ? parseFloat(String(v)) : NaN
        if (Number.isFinite(px) && px >= 0 && px <= 1) return px
      }
    } catch {
      // fall through to the settlement endpoint
    }
    const legacy = await this.fetchSettlement(slug)
    return legacy === 'yes' ? 1 : legacy === 'no' ? 0 : undefined
  }

  /** Venue-truth resolution once settled (public endpoint; 404 until settled). */
  private async fetchSettlement(slug: string): Promise<string | undefined> {
    try {
      const res = await this.gateway.get<{ settlement?: unknown }>(
        `/v1/markets/${encodeURIComponent(slug)}/settlement`
      )
      return parseUsSettlement(res.settlement)
    } catch {
      return undefined
    }
  }
}

function num(v?: string | number): number {
  if (v === undefined || v === null) return 0
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/** First finite numeric among the candidate keys (API field names vary). */
function firstNum(o: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = o[k]
    if (v === undefined || v === null) continue
    const n = typeof v === 'number' ? v : parseFloat(String(v))
    if (Number.isFinite(n)) return n
  }
  return 0
}

/**
 * Map the settlement endpoint's payload to a resolution.
 *
 * GET /v1/markets/{slug}/settlement returns `{"slug":"…","settlement":0}` —
 * `settlement` is a NUMBER, 1 = YES won and 0 = NO won. Verified 2026-09-01
 * against `outcomePrices` across 14 resolved markets (8 YES, 6 NO), agreeing
 * 14/14.
 *
 * This was previously typed as `{ outcome, result }`, so `(0)?.outcome` was
 * undefined and EVERY settled market came back unresolved. The failure was
 * silent and permanent: the market still fetches, so the zombie guard never
 * fired either, and mini positions simply sat open forever (three PolyUS
 * weather fades stuck 14h past close, all three actually winners).
 *
 * Anything ambiguous returns undefined — a guessed resolution books a
 * fabricated win or loss, which is worse than waiting.
 */
/** The long side's price on a RESOLVED market (1 or 0, or the void price), or undefined when the record has none. */
export function resolvedLongPrice(m: { status?: string; marketSides?: { long?: boolean; price?: unknown }[] }): number | undefined {
  if (m.status !== 'MARKET_STATUS_RESOLVED') return undefined
  const long = (m.marketSides ?? []).find((s) => s && s.long === true)
  if (!long || long.price === undefined || long.price === null || long.price === '') return undefined
  const px = parseFloat(String(long.price))
  return Number.isFinite(px) && px >= 0 && px <= 1 ? px : undefined
}

export function parseUsSettlement(value: unknown): 'yes' | 'no' | undefined {
  if (typeof value === 'number') {
    if (value === 1) return 'yes'
    if (value === 0) return 'no'
    return undefined
  }
  const raw = (
    typeof value === 'string'
      ? value
      : ((value as { outcome?: string; result?: string } | null | undefined)?.outcome ??
         (value as { outcome?: string; result?: string } | null | undefined)?.result ??
         '')
  )
    .toString()
    .toLowerCase()
  if (raw.includes('yes')) return 'yes'
  if (raw.includes('no')) return 'no'
  return undefined
}
