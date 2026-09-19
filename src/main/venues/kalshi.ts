import { sign, constants } from 'node:crypto'
import { HttpClient, HttpError } from '../util/http'
import { KALSHI_MAKER_FEE_COEF, KALSHI_TAKER_FEE_COEF } from '../util/kalshiFee'
import { recordCulled, type CulledRow } from './cullRecorder'
import type { VenueAdapter, VenueCapabilities } from '../../shared/venue'
import type {
  AccountInfo,
  EventDetails,
  Holder,
  Leader,
  LiveDataSnapshot,
  MarketCandle,
  MarketSearchQuery,
  MarketTrade,
  OpenOrder,
  OrderBook,
  OrderRequest,
  OrderResult,
  Position,
  PricePoint,
  PriceQuote,
  SellRequest,
  UserBet,
  UserPortfolio,
  VenueCredentials,
  VenueFill,
  VenueId,
  VenueMarket,
  VenueSettlement
} from '../../shared/types'

const BASE = 'https://api.elections.kalshi.com/trade-api/v2'

/**
 * Requests per second for the read and write lanes: half of each bucket's refill at the default call cost,
 * reads capped at 10/s and writes at 15/s. The old single pace divided the smaller refill by the most expensive
 * endpoint listed (cfbenchmarks, 50 tokens, never called here): one request every 334 ms for everything,
 * orders included, against an account allowance of 300 read and 300 write tokens a second (2026-09-17).
 */
export function kalshiRequestRates(rawLimits: unknown, rawCosts: unknown): { read: number; write: number } {
  const limits = rawLimits as { read?: { refill_rate?: number; bucket_capacity?: number }; write?: { refill_rate?: number; bucket_capacity?: number } }
  const costs = rawCosts as { default_cost?: number; endpoint_costs?: { cost: number }[] }
  if (!Array.isArray(costs?.endpoint_costs)) throw new Error('Missing endpoint costs')
  const values = [limits?.read?.refill_rate, limits?.write?.refill_rate, limits?.read?.bucket_capacity, limits?.write?.bucket_capacity, costs.default_cost]
  if (values.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) throw new Error('Invalid API limits')
  const perSecond = (refill: number, cap: number) => Math.max(1, Math.min(cap, Math.floor(refill / (2 * costs.default_cost!))))
  return { read: perSecond(limits.read!.refill_rate!, 10), write: perSecond(limits.write!.refill_rate!, 15) }
}

/** At most five requests/second and half the smaller budget at the highest listed single-call cost. */
export function conservativeKalshiPace(rawLimits: unknown, rawCosts: unknown): number {
  const limits = rawLimits as { read?: { refill_rate?: number; bucket_capacity?: number }; write?: { refill_rate?: number; bucket_capacity?: number } }
  const costs = rawCosts as { default_cost?: number; endpoint_costs?: { cost: number }[] }
  if (!Array.isArray(costs?.endpoint_costs)) throw new Error('Missing endpoint costs')
  const values = [limits?.read?.refill_rate, limits?.write?.refill_rate, limits?.read?.bucket_capacity, limits?.write?.bucket_capacity,
    costs.default_cost, ...costs.endpoint_costs.map(r => r.cost)]
  if (values.some(n => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) throw new Error('Invalid API limits')
  const maxCost = Math.max(costs.default_cost!, ...costs.endpoint_costs.map(r => r.cost))
  if (Math.min(limits.read!.bucket_capacity!, limits.write!.bucket_capacity!) < maxCost) throw new Error('Insufficient token capacity')
  return Math.max(200, Math.ceil(2000 * maxCost / Math.min(limits.read!.refill_rate!, limits.write!.refill_rate!)))
}
/** Demo exchange: separate credentials, mock funds, real matching engine. */
const DEMO_BASE = 'https://external-api.demo.kalshi.co/trade-api/v2'
const WS_BASE = 'wss://external-api-ws.kalshi.com/trade-api/ws/v2'
/** Note .co, not .com — and demo keys authenticate only against demo hosts. */
const WS_DEMO_BASE = 'wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2'
/** Kalshi maker fee coefficient on quadratic_with_maker_fees series: ceil(0.0175 × C × P × (1−P)). */
export { KALSHI_MAKER_FEE_COEF }

// ---- raw Kalshi shapes (per docs.kalshi.com) ----

interface KalshiMarket {
  ticker?: string
  event_ticker?: string
  title?: string
  yes_sub_title?: string
  no_sub_title?: string
  market_type?: string
  status?: string
  close_time?: string
  created_time?: string
  open_time?: string
  expected_expiration_time?: string
  can_close_early?: boolean
  yes_bid_dollars?: string
  yes_ask_dollars?: string
  no_bid_dollars?: string
  no_ask_dollars?: string
  last_price_dollars?: string
  previous_price_dollars?: string
  yes_bid_size_fp?: string | number
  yes_ask_size_fp?: string | number
  /** Market payloads carry ONLY the yes_* size pair (0 of 5,186 captured rows had a no_* size). The NO-bid depth IS yes_ask_size_fp. */
  exchange_index?: number
  volume_fp?: string | number
  volume_24h_fp?: string | number
  open_interest_fp?: string | number
  liquidity_dollars?: string
  floor_strike?: number
  cap_strike?: number
  strike_type?: string
  rules_primary?: string
  result?: string
  settlement_timer_seconds?: number
  fee_waiver_expiration_time?: string
  mve_collection_ticker?: string
  mve_selected_legs?: unknown
}

/**
 * Multivariate-event (parlay) detection. mve_filter=exclude demonstrably
 * leaks MVE markets; a parlay's multiplicative pricing would poison the
 * fade calibration the EV gate rests on, so the scanner triple-checks.
 */
export function isMveMarket(m: { ticker?: string; mve_collection_ticker?: string; mve_selected_legs?: unknown; strike_type?: string }): boolean {
  return (
    (m.ticker ?? '').startsWith('KXMVE') ||
    m.mve_collection_ticker !== undefined ||
    m.mve_selected_legs !== undefined ||
    m.strike_type === 'functional'
  )
}

/**
 * Ascending close-time slices for the universe pass, in seconds.
 *
 * `/markets` does not order by close time, so one paginated pass over the whole
 * horizon spends its page budget on whatever the API happens to return first.
 * Measured 2026-09-11 at the autoTrader's 72 h horizon: 25,155 open markets, of
 * which 20,642 close in 48-72 h and filled pages 1-20, while EVERY market
 * closing inside 6 h landed on pages 23-26 — so the 25-page bound dropped 155
 * markets 8-23 minutes from close, the nearest-dated rows on the exchange.
 * Slicing by close time gives the near end its own page budget; a truncation
 * can then only ever drop the far end, which is the half nothing trades yet.
 *
 * A slice must also be narrow enough not to truncate at all, because WITHIN a
 * slice the API's order is still not close time — and it returns that slice's
 * nearest-dated rows LAST. Measured 2026-09-18 at the same 72 h horizon: the
 * 48-72 h slice needed 26 pages, so the 617 rows past the bound were the ones
 * closing at the 48 h edge, among them $647k-volume NCAAF totals; 190 markets
 * left the scanner's universe, 132 of them autoTrader-eligible and 79 in the
 * fade band. Six-hourly edges out to 72 h put the densest band (66-72 h,
 * 13,062 rows) at 14 of 25 pages and cost 39 requests a pass instead of 34.
 */
export function universeWindows(nowSec: number, floorTs: number, horizonTs: number): [number, number][] {
  if (!(horizonTs > floorTs)) return []
  const edges = [1, 6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72, 96, 120, 144, 168, 336, 720]
    .map((h) => nowSec + h * 3600)
    .filter((t) => t > floorTs && t < horizonTs)
  const bounds = [floorTs, ...edges, horizonTs]
  const out: [number, number][] = []
  for (let i = 0; i + 1 < bounds.length; i++) out.push([bounds[i], bounds[i + 1]])
  return out
}

interface KalshiEvent {
  event_ticker?: string
  series_ticker?: string
  category?: string
  title?: string
  subtitle?: string
  mutually_exclusive?: boolean
  markets?: KalshiMarket[]
}

interface KalshiSeries {
  ticker?: string
  title?: string
  category?: string
  volume_fp?: string | number
}

interface KalshiTrade {
  trade_id?: string
  ticker?: string
  count_fp?: string | number
  yes_price_dollars?: string
  no_price_dollars?: string
  taker_outcome_side?: string
  taker_book_side?: string
  taker_side?: string
  created_time?: string
  is_block_trade?: boolean
}

interface KalshiCandlePrice {
  open_dollars?: string
  high_dollars?: string
  low_dollars?: string
  close_dollars?: string
}

interface KalshiCandle {
  end_period_ts?: number
  price?: KalshiCandlePrice
  yes_bid?: KalshiCandlePrice
  yes_ask?: KalshiCandlePrice
  volume_fp?: string | number
}

/** Create Order V2 response (docs.kalshi.com/api-reference/orders/create-order-v2). */
interface KalshiOrderV2 {
  /** The exchange status word: resting, canceled, executed, ... */
  status?: string
  order_id?: string
  client_order_id?: string
  fill_count?: string
  remaining_count?: string
  average_fill_price?: string
  average_fee_paid?: string
  ts_ms?: number
}

interface KalshiPosition {
  ticker?: string
  position_fp?: string | number
  market_exposure_dollars?: string
  realized_pnl_dollars?: string
}

interface KalshiFill {
  fill_id?: string
  order_id?: string
  ticker?: string
  market_ticker?: string
  outcome_side?: string
  book_side?: string
  count_fp?: string | number
  yes_price_dollars?: string
  no_price_dollars?: string
  is_taker?: boolean
  fee_cost?: string | number
  created_time?: string
}

interface KalshiOrder {
  order_id?: string
  client_order_id?: string
  ticker?: string
  /** Exchange shard the order rests on (2026-08-20: listed on every order). */
  exchange_index?: number
  outcome_side?: string
  book_side?: string
  yes_price_dollars?: string
  no_price_dollars?: string
  initial_count_fp?: string | number
  fill_count_fp?: string | number
  remaining_count_fp?: string | number
  status?: string
  created_time?: string
  expiration_time?: string
}

interface KalshiSettlement {
  ticker?: string
  event_ticker?: string
  market_result?: string
  yes_count_fp?: string | number
  yes_count?: string | number
  yes_total_cost_dollars?: string
  no_count_fp?: string | number
  no_count?: string | number
  no_total_cost_dollars?: string
  /** Integer CENTS (legacy field). Prefer revenue_dollars when present. */
  revenue?: string | number
  revenue_dollars?: string
  settled_time?: string
  fee_cost?: string | number
}

export class KalshiAdapter implements VenueAdapter {
  readonly id: VenueId = 'kalshi'
  readonly name = 'Kalshi'
  readonly currency = 'USD'
  readonly capabilities: VenueCapabilities = {
    liveTrading: true,
    realMoney: true,
    socialExposure: false
  }

  private http: HttpClient
  private apiKeyId?: string
  private privateKey?: string
  private demo = false
  private eventCategoryCache: Map<string, string> | null = null
  private eventCategoryCacheAt = 0
  private categoriesCache: string[] | null = null
  private categoriesCacheAt = 0
  /** series ticker -> fee multiplier + category + fetch time (24h TTL). */
  private seriesFeeCache = new Map<string, { mult: number; category?: string; at: number; feeType?: string }>()
  /** Series whose fee lookup failed, so the warning is emitted once not per scan. */
  private feeLookupWarned = new Set<string>()
  /** Exchange-side circuit-breaker group ('' = creation failed, don't retry). */
  /**
   * Exchange-side circuit-breaker groups, ONE PER SHARD. Kalshi runs each
   * exchange_index as a separate matching engine and an order group only
   * exists on the shard it was created on: a single cached group (created
   * on shard 0) made every order routed to a funded shard 2/3 fail with
   * 404 order_group_not_found (observed on demo 2026-09-02 the moment the
   * shards were funded). '' = creation failed for that shard, place without.
   */
  private orderGroupByShard = new Map<number, string>()
  /** ticker -> exchange_index, filled by mapMarket so placeOrder needs no extra fetch. */
  private shardOf = new Map<string, number>()
  /**
   * order_id -> { ticker, shard } for the V2 cancel. The V2 DELETE cannot find
   * an order from its id alone (docs: "An order_id alone cannot identify the
   * exchange shard"): without market_ticker / exchange_index it looks on shard
   * 0 and answers 404 for every crypto and sports order, so two book-imbalance
   * rests on shard 2 outlived the ladder's stop (2026-09-08). Filled by
   * placeOrder and getOpenOrders; a miss is resolved with one legacy
   * GET /portfolio/orders/{id}, which finds an order on any shard.
   */
  private orderRoute = new Map<string, { ticker: string; shard?: number }>()
  private lastPositionsSig = ''

  constructor() {
    this.http = new HttpClient({ baseUrl: BASE, rateLimit: 120 })
  }

  async init(credentials?: VenueCredentials): Promise<void> {
    this.apiKeyId = typeof credentials?.apiKeyId === 'string' ? credentials.apiKeyId : undefined
    this.privateKey = typeof credentials?.privateKey === 'string' ? credentials.privateKey.replace(/\\n/g, '\n') : undefined
    const demo = credentials?.demo === true
    this.demo = demo
    const baseUrl = demo ? DEMO_BASE : BASE
    this.http = new HttpClient({ baseUrl, rateLimit: 1, rateLimitWindowMs: 500 })
    if (this.apiKeyId && this.privateKey) {
      try {
        const [limits, costs] = await Promise.all([
          this.authGet<unknown>('/account/limits'), this.authGet<unknown>('/account/endpoint_costs')
        ])
        const rates = kalshiRequestRates(limits, costs)
        this.http = new HttpClient({ baseUrl, rateLimit: rates.read, rateLimitWindowMs: 1000, writeRateLimit: rates.write, writeRateLimitWindowMs: 1000 })
        console.log(`[kalshi] account-verified request pacing: ${rates.read} reads/s, ${rates.write} writes/s (separate lanes)`)
      } catch { console.warn('[kalshi] API limits unavailable; conservative 500ms request pacing retained') }
    }
    // One-shot free tier upgrade: grants a PERMANENT Advanced API usage level
    // (3× write budget) once ≥1 of the last 100 orders was API-created.
    // 403 just means not yet eligible — retried on next launch.
    if (!demo && this.apiKeyId && this.privateKey) {
      this.authPost('/account/api_usage_level/upgrade').catch(() => undefined)
    }
  }

  /** Exchange-wide trading status (public). Fail open: assume active on error. */
  async getExchangeStatus(): Promise<{ tradingActive: boolean }> {
    try {
      const res = await this.http.get<{ trading_active?: boolean; exchange_active?: boolean }>('/exchange/status')
      return { tradingActive: (res.trading_active ?? res.exchange_active ?? true) === true }
    } catch {
      return { tradingActive: true }
    }
  }

  // ---- market data ----

  async searchMarkets(query: MarketSearchQuery): Promise<VenueMarket[]> {
    const now = Math.floor(Date.now() / 1000)
    const seen = new Set<string>()
    const collected: KalshiMarket[] = []
    const append = (markets: KalshiMarket[]) => {
      for (const m of markets) {
        if (m.ticker && !seen.has(m.ticker)) {
          seen.add(m.ticker)
          collected.push(m)
        }
      }
    }

    if (query.category) {
      // Categories live on series (Get Series List supports category/tags); pull
      // the highest-volume series in the category and their markets.
      const seriesRes = await this.http.get<{ series?: KalshiSeries[] }>(
        `/series?category=${encodeURIComponent(query.category)}&include_volume=true`
      )
      const topSeries = (seriesRes.series ?? [])
        .sort((a, b) => toNum(b.volume_fp) - toNum(a.volume_fp))
        .slice(0, 10)
      for (const s of topSeries) {
        if (!s.ticker) continue
        try {
          const res = await this.http.get<{ markets?: KalshiMarket[] }>(
            `/markets?series_ticker=${encodeURIComponent(s.ticker)}&status=open&mve_filter=exclude&limit=10`
          )
          append(res.markets ?? [])
        } catch {
          // ignore a failed series fetch
        }
      }
    } else if (query.sort === 'ending-soon') {
      // Fully-paginated passes, near-dated first. The old nested horizon
      // windows (15m ... 180d) were each a SINGLE 1000-row page with no
      // cursor: the 24h window alone holds ~9,000 markets, and the API's
      // default order put every in-band crypto strike past row 1000, so the
      // fade never saw them (2026-09-02: 15 in-band BTC strikes on the
      // exchange, 0 reached the bot). A cursor fixes that; a cursor alone is
      // not enough, because the API's default order is not by close time and
      // far-dated inventory consumes the page bound first (25 pages at 180d on
      // demo -> 0 in-band BTC strikes; 2026-09-11 at 72h -> the 155 markets
      // closing inside 23 minutes fell off the end). Page each close-time
      // slice separately so the near end always gets its own budget.
      const horizonTs = query.maxCloseTime !== undefined ? Math.floor(query.maxCloseTime / 1000) : now + 7 * 86400
      // One hour of look-back by default: the unbounded pass this replaced also
      // returned the handful of rows whose close_time has just passed while the
      // venue still calls them open, and a lower bound must not newly hide them.
      const floorTs = query.minCloseTime !== undefined ? Math.floor(query.minCloseTime / 1000) : now - 3600
      const MAX_PAGES = 25
      for (const [loTs, hiTs] of universeWindows(now, floorTs, horizonTs)) {
        let cursor: string | undefined
        let pages = 0
        for (;;) {
          let res: { markets?: KalshiMarket[]; cursor?: string }
          try {
            res = await this.http.get<{ markets?: KalshiMarket[]; cursor?: string }>(
              `/markets?status=open&min_close_ts=${loTs}&max_close_ts=${hiTs}&mve_filter=exclude&limit=1000` +
                (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
            )
          } catch {
            break // keep what we have; the next window and the next scan retry
          }
          const page = res.markets ?? []
          append(page)
          pages++
          cursor = res.cursor
          if (!cursor || page.length === 0) break
          if (pages >= MAX_PAGES) {
            // Never truncate silently: a capped universe reads as "covered".
            const hrs = (t: number): string => (((t - now) / 3600) | 0).toString()
            console.warn(
              `[kalshi] universe fetch hit the ${MAX_PAGES}-page bound in the ${hrs(loTs)}-${hrs(hiTs)}h close-time window; later markets in it not scanned`
            )
            break
          }
        }
      }
    } else {
      const res = await this.http.get<{ markets?: KalshiMarket[] }>(
        `/markets?status=open&max_close_ts=${now + 180 * 86400}&mve_filter=exclude&limit=1000`
      )
      append(res.markets ?? [])
    }

    const categories = await this.getEventCategories()

    // status was already filtered server-side (status=open)
    const raw = collected

    // Group by the series prefix embedded in the ticker (top 3 per series by 24h
    // volume) so a single event or tournament cannot flood the scanner.
    const bySeries = new Map<string, KalshiMarket[]>()
    for (const m of raw) {
      const key = (m.ticker ?? '').split(/-\d/)[0] || m.event_ticker || m.ticker || ''
      const arr = bySeries.get(key) ?? []
      arr.push(m)
      bySeries.set(key, arr)
    }
    // A strike whose executable YES price sits in the fade band (longshot tail
    // or its favorite mirror). The anti-flood cap ranks by 24h volume, and on
    // a price ladder the volume lives at the money: keeping "top 3" of a
    // 30-strike BTC ladder kept three coin-flips and discarded every 3-10c
    // tail — the exact strikes the fade strategy exists to trade. Observed
    // 2026-09-02: 15 in-band BTC strikes on the exchange, 0 reached the bot.
    const inFadeBand = (m: KalshiMarket): boolean => {
      const bid = toNum(m.yes_bid_dollars)
      const ask = toNum(m.yes_ask_dollars)
      if (!(bid > 0 && ask > 0)) return false
      return (bid >= 0.03 && ask <= 0.12) || (ask <= 0.97 && bid >= 0.88)
    }
    const grouped: KalshiMarket[] = []
    // What the cap discards, for the counterfactual ledger. A culled market never becomes a candidate, so
    // it can never reach entryBlocked's veto watch — without recording it here there is no way to ever
    // learn what this cap costs. Observation only; nothing below changes what the cap keeps.
    const culled: CulledRow[] = []
    for (const [key, arr] of bySeries.entries()) {
      arr.sort((a, b) => toNum(b.volume_24h_fp) - toNum(a.volume_24h_fp))
      // Game series hold a whole slate under one prefix (KXMLBGAME = every
      // game today) — the anti-flood cap must not hide the day's schedule.
      const top = arr.slice(0, /GAME/.test(key) ? 40 : 3)
      const keep = new Set(top.map((m) => m.ticker))
      grouped.push(...top)
      // The cap limits mid-range flooding; it must never remove the tails.
      for (const m of arr) if (!keep.has(m.ticker) && inFadeBand(m)) grouped.push(m)
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i]
        if (keep.has(m.ticker) || inFadeBand(m)) continue
        const yb = toNum(m.yes_bid_dollars)
        const ya = toNum(m.yes_ask_dollars)
        // A market with no two-sided book was never tradeable by anyone, so its counterfactual is empty —
        // and unquoted strikes are the bulk of what the cap removes. Recording them would bury the signal.
        if (!(yb > 0 && ya > 0)) continue
        culled.push({ ts: Date.now(), ticker: m.ticker ?? '', key, rank: i, seriesSize: arr.length, yb, ya, vol24: toNum(m.volume_24h_fp), oi: toNum(m.open_interest_fp), close: m.close_time })
      }
    }
    recordCulled(culled)

    let mapped = grouped
      // Tails often have no print yet but a live two-sided book; do not
      // require a last trade for a market that is already in the band.
      .filter((m) => (toNum(m.last_price_dollars) > 0 || toNum(m.volume_fp) > 0 || inFadeBand(m)) && !isMveMarket(m))
      .map((m) => this.mapMarket(m, categories.get(m.event_ticker ?? '')))

    if (query.term) {
      const t = query.term.toLowerCase()
      mapped = mapped.filter((m) => m.question.toLowerCase().includes(t))
    }
    if (query.minLiquidity) {
      const ml = query.minLiquidity
      mapped = mapped.filter((m) => (m.liquidity ?? 0) >= ml)
    }
    await this.applySeriesFees(mapped)
    return this.sortMarkets(mapped, query.sort)
  }

  async getOrderBook(marketId: string): Promise<OrderBook> {
    // Docs: the orderbook returns YES bids and NO bids. A NO bid at price p is
    // equivalent to an ask (sell YES) at yes-leg price 1-p.
    const res = await this.http.get<{ orderbook_fp?: KalshiOrderbookFp }>(
      `/markets/${encodeURIComponent(marketId)}/orderbook`
    )
    return parseOrderBook(this.id, marketId, res.orderbook_fp)
  }

  async getOrderBooks(marketIds: string[]): Promise<OrderBook[]> {
    // Batch endpoint wants repeated `tickers` query params (verified live:
    // comma-joining collapses into one bogus entry). It also CAPS the count:
    // 60 tickers -> 200, 120 -> 400 "Tickers ... validation", 200 -> HTTP 414
    // (probed 2026-09-02). One request for the whole universe therefore
    // failed the moment the universe grew past ~100 markets, and the caller's
    // catch turned that into ZERO books - which silently produced zero fade
    // signals. Chunk well under the cap; a failed chunk loses only itself.
    const CHUNK = 50
    const wanted = new Set(marketIds)
    const out: OrderBook[] = []
    for (let i = 0; i < marketIds.length; i += CHUNK) {
      const chunk = marketIds.slice(i, i + CHUNK)
      const q = chunk.map((id) => `tickers=${encodeURIComponent(id)}`).join('&')
      try {
        const res = await this.http.get<{ orderbooks?: { ticker?: string; orderbook_fp?: KalshiOrderbookFp }[] }>(
          `/markets/orderbooks?${q}`
        )
        for (const o of res.orderbooks ?? []) {
          if (o.ticker && wanted.has(o.ticker)) out.push(parseOrderBook(this.id, o.ticker, o.orderbook_fp))
        }
      } catch (err) {
        console.warn(`[kalshi] orderbooks chunk ${i / CHUNK + 1} (${chunk.length} tickers) failed:`, err instanceof Error ? err.message : String(err))
      }
    }
    return out
  }

  async getRecentTrades(marketId: string, limit = 1000, minTs?: number): Promise<MarketTrade[]> {
    const q =
      `ticker=${encodeURIComponent(marketId)}&limit=${Math.min(1000, Math.max(1, limit))}` +
      (minTs ? `&min_ts=${minTs}` : '')
    const res = await this.http.get<{ trades?: KalshiTrade[] }>(`/markets/trades?${q}`)
    return (res.trades ?? []).map((t) => ({
      id: t.trade_id ?? '',
      yesPrice: toNum(t.yes_price_dollars),
      noPrice: toNum(t.no_price_dollars),
      count: toNum(t.count_fp),
      createdTs: t.created_time ? Date.parse(t.created_time) : 0,
      takerOutcomeSide: t.taker_outcome_side === 'no' ? 'no' : 'yes',
      takerBookSide: t.taker_book_side === 'ask' ? 'ask' : 'bid',
      isBlockTrade: !!t.is_block_trade
    }))
  }

  async getCandles(
    marketTickers: string[],
    periodMinutes: 1 | 60,
    startTs: number,
    endTs: number
  ): Promise<Record<string, MarketCandle[]>> {
    const out: Record<string, MarketCandle[]> = {}
    for (let i = 0; i < marketTickers.length; i += 100) {
      const chunk = marketTickers.slice(i, i + 100)
      const q =
        `market_tickers=${encodeURIComponent(chunk.join(','))}` +
        `&start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodMinutes}`
      const res = await this.http.get<{ markets?: { market_ticker?: string; candlesticks?: KalshiCandle[] }[] }>(
        `/markets/candlesticks?${q}`
      )
      for (const m of res.markets ?? []) {
        if (!m.market_ticker) continue
        out[m.market_ticker] = (m.candlesticks ?? []).map((c) => {
          const p = c.price ?? {}
          const b = c.yes_bid ?? {}
          const a = c.yes_ask ?? {}
          return {
            endTs: c.end_period_ts ?? 0,
            open: numOrUndef(p.open_dollars),
            high: numOrUndef(p.high_dollars),
            low: numOrUndef(p.low_dollars),
            close: numOrUndef(p.close_dollars),
            bidClose: numOrUndef(b.close_dollars),
            askClose: numOrUndef(a.close_dollars),
            volume: toNum(c.volume_fp)
          }
        })
      }
    }
    return out
  }

  async getEventDetails(eventTicker: string): Promise<EventDetails> {
    const res = await this.http.get<{ event?: KalshiEvent }>(
      `/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`
    )
    const e = res.event
    if (!e?.event_ticker) throw new Error(`Kalshi event ${eventTicker} not found`)
    return this.mapEvent(e)
  }

  async searchEvents(limit = 200, cursor?: string): Promise<{ events: EventDetails[]; cursor?: string }> {
    const path =
      `/events?status=open&with_nested_markets=true&limit=${Math.min(200, Math.max(1, limit))}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
    const res = await this.http.get<{ events?: KalshiEvent[]; cursor?: string }>(path)
    return {
      events: (res.events ?? [])
        .filter((e) => e.event_ticker)
        .map((e) => this.mapEvent(e)),
      cursor: res.cursor
    }
  }

  private mapEvent(e: KalshiEvent): EventDetails {
    return {
      eventTicker: e.event_ticker!,
      seriesTicker: e.series_ticker,
      title: e.title,
      mutuallyExclusive: !!e.mutually_exclusive,
      markets: (e.markets ?? []).map((m) => this.mapMarket(m))
    }
  }

  async getLiveData(eventTicker: string): Promise<LiveDataSnapshot> {
    interface KalshiLiveCandle {
      open_ts_ms?: number
      close?: number
    }
    let res: {
      live_data?: {
        type?: string
        details?: { candlesticks?: Record<string, KalshiLiveCandle[]> }
      }
    }
    try {
      res = await this.http.get(`/live_data/events/${encodeURIComponent(eventTicker)}`)
    } catch (err) {
      // Weather events 404 on the generic endpoint — the temperature index
      // lives at /live_data/weather/{city}. Route there before giving up
      // (previously the throw skipped the fallback entirely).
      const weather = await this.weatherLiveData(eventTicker)
      if (weather) return weather
      throw err
    }
    const ld = res.live_data
    const buckets = ld?.details?.candlesticks ?? {}
    // Prefer the finest bucket available.
    const key = ['1M', '15M'].find((k) => Array.isArray(buckets[k]) && buckets[k]!.length > 0)
    const candles = (key ? (buckets[key] ?? []) : [])
      .filter((c) => typeof c.close === 'number')
      .map((c) => ({ timestamp: c.open_ts_ms ?? 0, price: c.close as number }))
    if (candles.length === 0) {
      // Not a crypto/commodity event — try the canonical weather temperature
      // index when the ticker maps to a supported city.
      const weather = await this.weatherLiveData(eventTicker)
      if (weather) return weather
    }
    const last = candles[candles.length - 1]
    // Staleness measured from the bucket's expected end (open + bucket width).
    const bucketMs = key === '1M' ? 60_000 : 15 * 60_000
    return {
      eventTicker,
      type: ld?.type,
      latest: last?.price,
      staleMinutes: last ? Math.max(0, (Date.now() - last.timestamp - bucketMs) / 60_000) : undefined,
      series: candles
    }
  }

  /**
   * Kalshi's minute-resolution temperature index (the settlement input for
   * its weather-index markets): GET /live_data/weather/{city}. Supported
   * cities verified live 2026-08-29. Best-effort ticker→city mapping —
   * unknown tickers return null and the caller falls through.
   */
  private async weatherLiveData(eventTicker: string): Promise<LiveDataSnapshot | null> {
    const t = eventTicker.toUpperCase()
    // Temperature series carry an exact station code — resolve it strictly
    // and NEVER fall through to fragment guessing: 'KXLOWTOKC' contains
    // 'KC', and feeding an Oklahoma City market Kansas City temperatures is
    // how a settlement model fires confident wrong verdicts.
    const temp = /^KX(?:HIGHT?|LOWT?)([A-Z]+)$/.exec(t.split('-')[0])
    const city = temp
      ? tempStationCity(eventTicker)
      : WEATHER_CITIES.find((w) => w.patterns.some((p) => t.includes(p)))?.city
    if (!city) return null
    try {
      const res = await this.http.get<{ timeseries?: { t?: number; v?: number; status?: string }[] }>(
        `/live_data/weather/${encodeURIComponent(city)}`
      )
      const series = (res.timeseries ?? [])
        .filter((p) => typeof p.v === 'number' && typeof p.t === 'number')
        .map((p) => ({ timestamp: p.t!, price: p.v! }))
      if (series.length === 0) return null
      const last = series[series.length - 1]
      return {
        eventTicker,
        type: 'weather-index',
        latest: last.price,
        staleMinutes: Math.max(0, (Date.now() - last.timestamp - 60_000) / 60_000),
        series: series.slice(-240)
      }
    } catch {
      return null
    }
  }

  async getMarket(id: string): Promise<VenueMarket> {
    const mapped = this.mapMarket(await this.fetchMarket(id))
    await this.applySeriesFees([mapped])
    return mapped
  }

  /**
   * Historical YES price series from candlesticks (for the backtest tab).
   * Picks the coarsest period that still covers the market's life in one call.
   */
  async getPriceHistory(marketId: string, limit = 500): Promise<PricePoint[]> {
    const m = await this.fetchMarket(marketId)
    const nowSec = Math.floor(Date.now() / 1000)
    const endSec = Math.min(nowSec, m.close_time ? Math.floor(Date.parse(m.close_time) / 1000) : nowSec)
    const openSec = m.open_time ? Math.floor(Date.parse(m.open_time) / 1000) : endSec - 7 * 86400
    const spanMin = Math.max(1, (endSec - openSec) / 60)
    const period: 1 | 60 = spanMin <= 5000 ? 1 : 60
    const candles = await this.getCandles([marketId], period, openSec, endSec)
    const series = (candles[marketId] ?? [])
      .map((c) => ({ timestamp: c.endTs * 1000, price: c.close ?? midCandle(c) }))
      .filter((p): p is PricePoint => p.price !== undefined && p.price > 0)
    return series.slice(-limit)
  }

  async getPrice(marketId: string, outcome = 'YES'): Promise<PriceQuote> {
    const m = await this.fetchMarket(marketId)
    return this.marketQuote(m, outcome)
  }

  async getPrices(requests: { marketId: string; outcome: string }[]): Promise<PriceQuote[]> {
    const ids = [...new Set(requests.map(r => r.marketId))]
    const markets = new Map<string, KalshiMarket>()
    for (let i = 0; i < ids.length; i += 50) {
      const data = await this.http.get<{ markets?: KalshiMarket[]; cursor?: string }>(`/markets?tickers=${encodeURIComponent(ids.slice(i, i + 50).join(','))}&limit=1000`)
      if (!Array.isArray(data.markets) || data.cursor) throw new Error('Incomplete price batch')
      for (const m of data.markets) if (m.ticker) markets.set(m.ticker, m)
    }
    return requests.flatMap(r => {
      const m = markets.get(r.marketId)
      if (!m) return []
      try { return [this.marketQuote(m, r.outcome)] } catch { return [] }
    })
  }

  private marketQuote(m: KalshiMarket, outcome: string): PriceQuote {
    const bid = toNum(m.yes_bid_dollars), ask = toNum(m.yes_ask_dollars)
    const yes = bid > 0 && ask >= bid && ask <= 1 ? (bid + ask) / 2 : undefined
    if (yes === undefined || !Number.isFinite(yes)) throw new Error('No valid market price')
    let price: number
    if (outcome === 'NO') {
      const noBid = toNum(m.no_bid_dollars)
      const noAsk = toNum(m.no_ask_dollars)
      price = noBid > 0 && noAsk >= noBid && noAsk <= 1 ? (noBid + noAsk) / 2 : 1 - yes
    } else {
      price = yes
    }
    return { venue: this.id, marketId: m.ticker!, outcome, price, probability: yes, timestamp: Date.now() }
  }

  // ---- account ----

  async getCategories(): Promise<string[]> {
    // 1h TTL — the old cache-forever behavior meant the category dropdown
    // never refreshed within a session.
    if (this.categoriesCache && Date.now() - this.categoriesCacheAt < 3600_000) return this.categoriesCache
    try {
      const res = await this.http.get<{ tags_by_categories?: Record<string, string[]> }>('/search/tags_by_categories')
      this.categoriesCache = Object.keys(res.tags_by_categories ?? {}).sort()
      this.categoriesCacheAt = Date.now()
    } catch {
      this.categoriesCache = this.categoriesCache ?? []
    }
    return this.categoriesCache
  }

  async getAccount(): Promise<AccountInfo> {
    this.requireAuth()
    const data = await this.authGet<Record<string, unknown>>('/portfolio/balance')
    return {
      venue: this.id,
      userId: this.apiKeyId!,
      username: 'Kalshi',
      balance: parseBalance(data),
      portfolioValue: typeof data.portfolio_value === 'number' ? data.portfolio_value / 100 : undefined,
      // Collateral is held per exchange shard; balance_dollars is the
      // AGGREGATE. Deposits land on shard 0, so crypto (shard 2) and
      // MLB/tennis (shard 3) orders have $0 behind them until allocated.
      balanceByShard: parseBalanceBreakdown(data),
      currency: this.currency,
      realMoney: true
    }
  }

  async getPositions(): Promise<Position[]> {
    this.requireAuth()
    // Positions are SHARD-SCOPED like balances and order groups: the unscoped
    // call omitted the baseball shard's six positions while the ledger held
    // eight (2026-09-02, demo). Query every shard we know about plus the
    // unscoped default, and merge by ticker.
    const shards = new Set<number>([0, 1, 2, 3, ...this.shardOf.values()])
    const seen = new Map<string, KalshiPosition>()
    const perShard: string[] = []
    const merge = (rows: KalshiPosition[] | undefined, label: string): void => {
      let n = 0
      for (const p of rows ?? []) {
        if (!p.ticker || toNum(p.position_fp) === 0) continue
        if (!seen.has(p.ticker)) { seen.set(p.ticker, p); n++ }
      }
      perShard.push(`${label}:${n}`)
    }
    // A read that FAILS must reject, never resolve to "no positions": the engine cap's fail-closed branch, the
    // ledger reconcile's three-miss drop, trySettle's stale-trade rule and the boot gate all treat a resolved
    // empty list as the truth (audit 2026-09-19, B-02). Until then every failure here was a warn line and [].
    try {
      const d = await this.authGet<{ market_positions?: KalshiPosition[] }>('/portfolio/positions?limit=200')
      merge(d.market_positions, 'default')
    } catch (err) {
      console.warn('[kalshi] positions (default) failed:', err instanceof Error ? err.message : String(err))
      throw err
    }
    for (const shard of shards) {
      try {
        const d = await this.authGet<{ market_positions?: KalshiPosition[] }>(`/portfolio/positions?limit=200&exchange_index=${shard}`)
        merge(d.market_positions, `shard${shard}`)
      } catch (err) {
        // A shard the account does not have, or a rejected parameter, is a 4xx and contributes nothing. Anything
        // else (5xx, 429, a timeout) means the merged view would be PARTIAL, which a caller cannot tell from complete.
        if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) continue
        console.warn(`[kalshi] positions (shard ${shard}) failed:`, err instanceof Error ? err.message : String(err))
        throw err
      }
    }
    const sig = perShard.join(' ')
    if (sig !== this.lastPositionsSig) {
      this.lastPositionsSig = sig
      console.log(`[kalshi] positions merged ${seen.size} (${sig})`)
    }
    const out: Position[] = []
    for (const p of seen.values()) {
      const pos = toNum(p.position_fp)
      const outcome = pos > 0 ? 'YES' : 'NO'
      const shares = Math.abs(pos)
      const exposure = toNum(p.market_exposure_dollars)
      out.push({
        venue: this.id,
        marketId: p.ticker ?? '',
        outcome,
        shares,
        avgPrice: shares > 0 ? exposure / shares : 0
      })
    }
    return out
  }

  /** Executed fills — the authoritative source of realized P&L + fees. Cursor-paginated up to `limit`. */
  async getFills(limit = 100): Promise<VenueFill[]> {
    this.requireAuth()
    const rows = await this.authPaged<KalshiFill>('/portfolio/fills', 'fills', limit)
    return rows.map((f) => {
      const outcome: 'YES' | 'NO' = f.outcome_side === 'no' ? 'NO' : 'YES'
      return {
        id: f.fill_id ?? '',
        orderId: f.order_id,
        marketId: f.ticker ?? '',
        outcome,
        side: f.book_side === 'ask' ? 'sell' : 'buy',
        shares: toNum(f.count_fp),
        price: outcome === 'YES' ? toNum(f.yes_price_dollars) : toNum(f.no_price_dollars),
        fee: toNum(f.fee_cost),
        isTaker: !!f.is_taker,
        timestamp: f.created_time ? Date.parse(f.created_time) : 0
      }
    })
  }

  /** Resting orders — the maker-order lifecycle reads fills/expiry from here. */
  async getOpenOrders(marketId?: string): Promise<OpenOrder[]> {
    this.requireAuth()
    const q = `status=resting&limit=200` + (marketId ? `&ticker=${encodeURIComponent(marketId)}` : '')
    const orders: KalshiOrder[] = []
    let cursor = ''
    const seen = new Set<string>()
    do {
      const page = await this.authGet<{ orders: KalshiOrder[]; cursor?: string }>(`/portfolio/orders?${q}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`)
      if (!Array.isArray(page.orders)) throw new Error('Missing open-orders page')
      orders.push(...page.orders)
      cursor = page.cursor ?? ''
      if (cursor && seen.has(cursor)) throw new Error('Repeated open-orders cursor')
      seen.add(cursor)
    } while (cursor)
    const data = { orders }
    for (const o of data.orders ?? []) if (o.order_id && o.ticker) this.orderRoute.set(o.order_id, { ticker: o.ticker, shard: o.exchange_index })
    return (data.orders ?? []).map((o) => ({
      orderId: o.order_id ?? '',
      clientOrderId: o.client_order_id,
      marketId: o.ticker ?? '',
      outcome: o.outcome_side === 'no' ? 'NO' : 'YES',
      yesPrice: toNum(o.yes_price_dollars),
      initialCount: toNum(o.initial_count_fp),
      fillCount: toNum(o.fill_count_fp),
      remainingCount: toNum(o.remaining_count_fp),
      status: o.status === 'canceled' ? 'canceled' : o.status === 'executed' ? 'executed' : 'resting',
      createdTs: o.created_time ? Date.parse(o.created_time) : undefined,
      expirationTs: o.expiration_time ? Math.floor(Date.parse(o.expiration_time) / 1000) : undefined
    }))
  }

  /** Settled markets — realized P&L = revenue − cost − fees. Cursor-paginated up to `limit`. */
  async getSettlements(limit = 100): Promise<VenueSettlement[]> {
    this.requireAuth()
    const rows = await this.authPaged<KalshiSettlement>('/portfolio/settlements', 'settlements', limit)
    return rows.map(mapKalshiSettlement)
  }

  async findOrderByClientId(clientOrderId: string, marketId: string, since: number): Promise<{ orderId: string } | undefined> {
    const query = `ticker=${encodeURIComponent(marketId)}&min_ts=${Math.floor(since / 1000) - 60}&limit=200`
    for (const route of ['/portfolio/orders', '/historical/orders']) {
      let cursor = ''
      const seen = new Set<string>()
      do {
        const page = await this.authGet<{ orders: KalshiOrder[]; cursor?: string }>(`${route}?${query}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`)
        if (!Array.isArray(page.orders)) throw new Error('Missing recovery orders page')
        const match = page.orders.find(o => o.client_order_id === clientOrderId)
        if (match?.order_id) return { orderId: match.order_id }
        cursor = page.cursor ?? ''
        if (cursor && seen.has(cursor)) throw new Error('Repeated recovery cursor')
        seen.add(cursor)
      } while (cursor)
    }
    return undefined
  }

  /**
   * Kalshi maker/liquidity incentive programs (GET /incentive_programs). Read
   * only: the rows are surfaced so the operator can see which series pay for
   * resting liquidity; nothing trades on them. Shape is logged, not assumed.
   */
  /**
   * Move collateral between exchange shards (one-off, event-contract side).
   * Intra Account Transfer API: POST /portfolio/intra_exchange_instance_transfer,
   * amount in CENTICENTS (1/100 of a cent). Cross-shard transfers run in up to
   * three non-atomic steps and completed steps are not undone on failure, so
   * callers keep amounts small and re-read balances afterwards.
   */
  async transferBetweenShards(fromShard: number, toShard: number, dollars: number): Promise<string> {
    this.requireAuth()
    const amount = Math.round(dollars * 10_000)
    if (!(amount > 0)) throw new Error('transfer amount must be positive')
    if (fromShard === toShard) throw new Error('source and destination shard are the same')
    const res = await this.authPost<{ transfer_id?: string }>('/portfolio/intra_exchange_instance_transfer', {
      source: 'event_contract',
      destination: 'event_contract',
      amount,
      source_exchange_shard: fromShard,
      destination_exchange_shard: toShard,
      source_subaccount: 0,
      destination_subaccount: 0
    })
    return res.transfer_id ?? ''
  }

  async getIncentivePrograms(): Promise<Record<string, unknown>[]> {
    try {
      const res = await this.authGet<Record<string, unknown>>('/incentive_programs?limit=200')
      const rows = (res.incentive_programs ?? res.programs ?? res.data) as unknown
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
    } catch {
      return []
    }
  }

  // ---- trading ----
  //
  // Create Order V2 semantics (docs.kalshi.com/api-reference/orders/create-order-v2):
  //   side: bid ≡ buy YES, ask ≡ sell YES — "this endpoint quotes everything
  //   from the YES side", and per the order-direction doc, "direction does not
  //   change the price". The `price` field is therefore ALWAYS the YES-leg
  //   price, for both bid and ask. Buying NO = ask at the YES-leg price
  //   (economically NO at 1 − price). Never send the complement here.

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    this.requireAuth()
    const side = order.outcome === 'YES' ? 'bid' : 'ask'

    let yesLeg = order.limitPrice
    if (yesLeg === undefined) {
      // No limit given (manual UI orders): behave like a market order with
      // bounded slippage — cross the live book by 1¢, IOC below.
      const ob = await this.getOrderBook(order.marketId).catch(() => undefined)
      const bid = ob?.bids[0]?.price
      const ask = ob?.asks[0]?.price
      yesLeg = order.outcome === 'YES' ? (ask !== undefined ? ask + 0.01 : undefined) : bid !== undefined ? bid - 0.01 : undefined
      if (yesLeg === undefined) {
        throw new Error(`No resting liquidity to ${order.outcome === 'YES' ? 'lift' : 'hit'} on ${order.marketId}`)
      }
    }
    const leg = clamp01(yesLeg)
    // Size off the worst-case cost of the leg actually being bought.
    const legCost = order.outcome === 'YES' ? leg : 1 - leg
    if (legCost <= 0) throw new Error('Cannot determine a price for this market')
    const count = order.contracts !== undefined ? Math.max(0.01, order.contracts) : Math.max(0.01, order.amount / legCost)

    const body: Record<string, unknown> = {
      ticker: order.marketId,
      client_order_id: order.clientOrderId ?? genId(),
      side,
      count: count.toFixed(2),
      // whole-cent prices are valid in every price-level structure
      price: leg.toFixed(2),
      time_in_force: order.timeInForce ?? 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross'
    }
    if (order.postOnly) {
      body.post_only = true
      // Resting orders should not survive an exchange trading pause — the
      // world can change materially before trading resumes.
      body.cancel_order_on_pause = true
    }
    if (order.expirationTs && (order.timeInForce ?? 'immediate_or_cancel') === 'good_till_canceled') {
      body.expiration_time = Math.floor(order.expirationTs)
    }
    // A caller that already read the market (lead-lag lists the series every poll) passes its shard, so a new
    // 15-minute ticker does not cost a market lookup queued behind the scanner before the order can go.
    if (typeof order.exchangeIndex === 'number') this.shardOf.set(order.marketId, order.exchangeIndex)
    if (!this.shardOf.has(order.marketId)) {
      // Lead-lag and the crypto sweeps place on tickers that never went through
      // mapMarket, so the shard was unknown, the shard-0 order group rode into
      // shard 2 and every such order cost a failed POST plus a retry without
      // the breaker ("order group unknown", 24 times 2026-09-07/08). One market
      // read learns the shard; a failure keeps the old default.
      try {
        this.mapMarket(await this.fetchMarket(order.marketId))
      } catch {
        // unknown shard: fall through to the shard-0 default below
      }
    }
    const shard = this.shardOf.get(order.marketId) ?? 0
    const group = await this.ensureOrderGroup(shard)
    if (group) body.order_group_id = group

    let res: KalshiOrderV2
    order.onSubmit?.()
    try {
      res = await this.authPost<KalshiOrderV2>('/portfolio/events/orders', body)
    } catch (err) {
      // The cached group is not known on the exchange this order routed to
      // (a market whose shard we never learned rides a shard-0 group into
      // shard 2, or the group expired). Re-ensuring the same shard recreated
      // the same mismatch and the retry failed too (2026-09-07: 13 lead-lag
      // sweeps lost), so retry ONCE without any group and forget the cached
      // one so the next order re-creates it. A wrong group must never block
      // an order that is otherwise valid.
      if (!group || !/order_group_not_found/.test((err instanceof Error ? err.message : String(err)))) throw err
      console.warn(`[kalshi] order group unknown for ${order.marketId} (shard ${shard}); placing without a group`)
      this.orderGroupByShard.delete(shard)
      delete body.order_group_id
      res = await this.authPost<KalshiOrderV2>('/portfolio/events/orders', body)
    }
    if (res.order_id) {
      if (this.orderRoute.size >= 4000) this.orderRoute.delete(this.orderRoute.keys().next().value as string)
      this.orderRoute.set(res.order_id, { ticker: order.marketId, shard })
    }
    return this.mapOrderResult(res, order, count, leg)
  }

  async sellPosition(req: SellRequest): Promise<OrderResult> {
    this.requireAuth()
    let count = req.shares
    if (count === undefined) {
      const positions = await this.getPositions()
      const pos = positions.find((p) => p.marketId === req.marketId && p.outcome === req.outcome)
      count = pos?.shares ?? 0
    }
    if (!count || count <= 0) throw new Error('No position to sell')

    // Closing: sell YES ≡ ask, sell NO ≡ bid — price is ALWAYS the YES-leg price.
    const side = req.outcome === 'YES' ? 'ask' : 'bid'
    let yesLeg = req.limitPrice
    if (yesLeg === undefined) {
      // Marketable default: cross the live spread by 1¢ so IOC actually fills.
      const ob = await this.getOrderBook(req.marketId).catch(() => undefined)
      const bid = ob?.bids[0]?.price
      const ask = ob?.asks[0]?.price
      yesLeg = req.outcome === 'YES' ? (bid !== undefined ? bid - 0.01 : undefined) : ask !== undefined ? ask + 0.01 : undefined
      if (yesLeg === undefined) {
        const quote = await this.getPrice(req.marketId, 'YES')
        yesLeg = quote.probability
      }
    }
    // Clamp BEFORE validating: a collapsed book (1¢ bid, 99¢ ask) pushes the
    // marketable default to 0 or 1, and rejecting it made positions
    // unexitable exactly when exiting matters most.
    if (yesLeg === undefined || !Number.isFinite(yesLeg)) throw new Error('Cannot determine a closing price')
    const leg = clamp01(yesLeg)

    req.onSubmit?.()
    const res = await this.authPost<KalshiOrderV2>('/portfolio/events/orders', {
      ticker: req.marketId,
      client_order_id: req.clientOrderId ?? genId(),
      side,
      count: count.toFixed(2),
      price: leg.toFixed(2),
      time_in_force: req.timeInForce ?? 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
      reduce_only: true
    })
    return this.mapOrderResult(res, { venue: this.id, marketId: req.marketId, outcome: req.outcome, amount: 0 }, count, leg)
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.requireAuth()
    let route = this.orderRoute.get(orderId)
    if (!route) {
      // Unknown after a restart: the legacy GET finds an order on any shard.
      const d = await this.authGet<{ order?: KalshiOrder }>(`/portfolio/orders/${encodeURIComponent(orderId)}`).catch(() => undefined)
      if (d?.order?.ticker) {
        route = { ticker: d.order.ticker, shard: d.order.exchange_index }
        this.orderRoute.set(orderId, route)
      }
    }
    const q = new URLSearchParams()
    if (route?.ticker) q.set('market_ticker', route.ticker)
    if (route?.shard !== undefined) q.set('exchange_index', String(route.shard))
    const qs = q.toString()
    // The signature covers the path without the query (see authHeaders).
    const path = `/portfolio/events/orders/${encodeURIComponent(orderId)}` + (qs ? `?${qs}` : '')
    await this.http.del(path, () => this.authHeaders('DELETE', path))
    this.orderRoute.delete(orderId)
  }

  /**
   * Amend a resting order in place (no cancel/recreate gap with zero book
   * presence). Price is the YES-leg price; count is the TOTAL fillable count.
   * Note: a price change loses queue position (only size decreases keep it).
   */
  async amendOrder(orderId: string, marketId: string, side: 'bid' | 'ask', yesPrice: number, count: number): Promise<{ fillCount: number; avgYes: number }> {
    this.requireAuth()
    // Same shard-routing rule as the cancel: the V2 amend body accepts
    // exchange_index, and an order on shard 2 is not found without it.
    const shard = this.shardOf.get(marketId) ?? this.orderRoute.get(orderId)?.shard
    const res = await this.authPost<KalshiOrderV2>(`/portfolio/events/orders/${encodeURIComponent(orderId)}/amend`, {
      ticker: marketId,
      side,
      price: clamp01(yesPrice).toFixed(2),
      count: Math.max(0.01, count).toFixed(2),
      ...(shard !== undefined ? { exchange_index: shard } : {})
    })
    return { fillCount: toNum(res.fill_count), avgYes: toNum(res.average_fill_price) }
  }

  /**
   * Decrease a resting order's REMAINING count in place. A size decrease is the one
   * amendment that PRESERVES queue position (see amendOrder note), so this shrinks a
   * stale quote's pick-off exposure without forfeiting its slot. `reduceTo` is the new
   * desired REMAINING count (the V2 decrease endpoint operates on remaining count,
   * unlike amend's total-fillable `count`). Always send reduce_to (never reduce_by):
   * reduce_to is idempotent and the HTTP adapter retries, so reduce_by could
   * double-apply on a timeout retry.
   */
  async decreaseOrder(orderId: string, marketId: string, reduceTo: number): Promise<{ fillCount: number; remainingCount: number | undefined }> {
    this.requireAuth()
    const shard = this.shardOf.get(marketId) ?? this.orderRoute.get(orderId)?.shard
    const res = await this.authPost<KalshiOrderV2>(`/portfolio/events/orders/${encodeURIComponent(orderId)}/decrease`, {
      ticker: marketId,
      reduce_to: Math.max(0, reduceTo).toFixed(2),
      ...(shard !== undefined ? { exchange_index: shard } : {})
    })
    // A7: an absent remaining_count must stay absent - see toNumOpt. A fabricated
    // 0 would be read by the caller as "the order is gone".
    return { fillCount: toNum(res.fill_count), remainingCount: toNumOpt(res.remaining_count) }
  }

  /**
   * Read a resting order's queue position: the quantity of contracts resting ahead of it
   * on the same side at the same price (0-indexed). 0 = front of queue. Returns undefined
   * when the venue omits the field - unknown is NOT the same as front. Diagnostic only: it
   * exposes the cost of the quoter's repricing policy.
   */
  async getOrderQueuePosition(orderId: string): Promise<number | undefined> {
    this.requireAuth()
    const res = await this.authGet<{ queue_position_fp?: string | number; queue_position?: string | number }>(
      `/portfolio/orders/${encodeURIComponent(orderId)}/queue_position`
    )
    // A7: absence must read as UNKNOWN, never as 0. 0 means "front of queue", the
    // best possible case, so coercing absence to 0 would bias the very evidence
    // that decides whether the /decrease policy goes live.
    return toNumOpt(res.queue_position_fp ?? res.queue_position)
  }

  /**
   * Exchange-side circuit breaker: all bot orders join one order group with
   * a matched-contracts limit per rolling 15s window. When tripped, the
   * EXCHANGE cancels every resting order in the group and rejects new ones —
   * a kill switch that survives app crashes and dead network links.
   * 500 contracts/15s is far above normal small-stake flow; only a runaway
   * loop trips it. Failure to create a group never blocks trading.
   */
  private async ensureOrderGroup(shard: number): Promise<string | undefined> {
    const cached = this.orderGroupByShard.get(shard)
    if (cached !== undefined) return cached || undefined
    try {
      // exchange_index binds the group to this shard. If the create endpoint
      // does not accept it the call fails and this shard runs without a group
      // (protection, not a dependency) — which is strictly better than
      // attaching a group the shard does not recognise.
      const res = await this.authPost<{ order_group_id?: string }>('/portfolio/order_groups/create', {
        contracts_limit: 500,
        ...(shard > 0 ? { exchange_index: shard } : {})
      })
      this.orderGroupByShard.set(shard, res.order_group_id ?? '')
    } catch (err) {
      console.warn(`[kalshi] order group create failed for shard ${shard}; placing without:`, (err instanceof Error ? err.message : String(err)))
      this.orderGroupByShard.set(shard, '')
    }
    return this.orderGroupByShard.get(shard) || undefined
  }

  /** Record a market's shard for placeOrder; returns it for the VenueMarket mapping. */
  private rememberShard(m: KalshiMarket): number | undefined {
    if (typeof m.exchange_index !== 'number') return undefined
    if (m.ticker) this.shardOf.set(m.ticker, m.exchange_index)
    return m.exchange_index
  }

  // ---- social (not supported) ----

  async getTopHolders(): Promise<Holder[]> {
    return []
  }

  async getUserPortfolio(): Promise<UserPortfolio> {
    throw new Error('Not implemented for Kalshi.')
  }

  async getUserBets(): Promise<UserBet[]> {
    throw new Error('Not implemented for Kalshi.')
  }

  async getLeaderboard(): Promise<Leader[]> {
    return []
  }

  async getUserHoldings(): Promise<Position[]> {
    return []
  }

  // ---- helpers ----

  private requireAuth(): void {
    if (!this.apiKeyId || !this.privateKey) throw new Error('Kalshi credentials not configured')
  }

  /**
   * Sign an ABSOLUTE path. The WebSocket handshake signs '/trade-api/ws/v2',
   * which is not under the REST '/trade-api/v2' prefix — so the prefix lives
   * in the REST caller, not here.
   */
  private signPath(method: 'GET' | 'POST' | 'DELETE', absPath: string): Record<string, string> {
    this.requireAuth()
    const timestamp = String(Date.now())
    const signature = sign('sha256', Buffer.from(`${timestamp}${method}${absPath}`), {
      key: this.privateKey!,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST
    }).toString('base64')
    return {
      'KALSHI-ACCESS-KEY': this.apiKeyId!,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature
    }
  }

  private authHeaders(method: 'GET' | 'POST' | 'DELETE', path: string): Record<string, string> {
    // Kalshi signs the path WITHOUT query parameters (docs: "sign only
    // /trade-api/v2/portfolio/orders" for …/orders?limit=5). Signing the query
    // string produces a 401 INVALID_SIGNATURE.
    return this.signPath(method, '/trade-api/v2' + path.split('?')[0])
  }

  /** Upgrade-request headers for the WS handshake (signs the socket's own pathname). */
  wsHeaders(wsUrl: string): Record<string, string> {
    return this.signPath('GET', new URL(wsUrl).pathname)
  }

  /** WSS endpoint matching this adapter's environment (demo creds ↔ demo socket). */
  wsUrl(): string {
    return this.demo ? WS_DEMO_BASE : WS_BASE
  }

  // Headers are passed as factories so the timestamp+signature are minted
  // AFTER the rate-limiter wait and fresh on every retry — a signature built
  // before a limiter sleep goes stale and 401s.
  private authGet<T>(path: string): Promise<T> {
    return this.http.get<T>(path, () => this.authHeaders('GET', path))
  }

  private authPost<T>(path: string, body?: unknown): Promise<T> {
    return this.http.post<T>(path, body, () => this.authHeaders('POST', path))
  }

  /**
   * Cursor-paginated authenticated list. Kalshi caps every list endpoint at
   * 200 rows per page; the old single-page fetch silently truncated fills and
   * settlements once the account had more than one page of history, so the
   * "venue-authoritative" P&L panel would have reported the newest 200 rows
   * as the whole record (this account passed 131 settlements and 677 fills
   * within four days of going live).
   */
  private async authPaged<T>(path: string, key: string, limit: number): Promise<T[]> {
    const out: T[] = []
    const pageSize = Math.min(200, Math.max(1, Math.floor(limit)))
    let cursor: string | undefined
    const seen = new Set<string>()
    while (out.length < limit) {
      const q = `${path}?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const data = await this.authGet<Record<string, unknown>>(q)
      if (!Array.isArray(data[key])) throw new Error(`Missing ${key} page`)
      const rows = data[key] as T[]
      out.push(...rows)
      cursor = typeof data.cursor === 'string' && data.cursor ? data.cursor : undefined
      if (!cursor) break
      if (rows.length === 0 || seen.has(cursor)) throw new Error(`Incomplete or repeated ${key} cursor`)
      seen.add(cursor)
    }
    return out.slice(0, limit)
  }

  private async getEventCategories(): Promise<Map<string, string>> {
    if (this.eventCategoryCache && Date.now() - this.eventCategoryCacheAt < 3600_000) return this.eventCategoryCache
    this.eventCategoryCacheAt = Date.now()
    const map = new Map<string, string>()
    try {
      const res = await this.http.get<{ events?: KalshiEvent[] }>('/events?limit=200&status=open')
      for (const e of res.events ?? []) {
        if (e.event_ticker && e.category) map.set(e.event_ticker, e.category)
      }
    } catch {
      // leave empty
    }
    this.eventCategoryCache = map
    return map
  }

  private async fetchMarket(id: string): Promise<KalshiMarket> {
    const raw = await this.http.get<{ market?: KalshiMarket }>(`/markets/${encodeURIComponent(id)}`)
    const m = raw.market ?? (raw as unknown as KalshiMarket)
    if (!m || !m.ticker) throw new Error(`Kalshi market ${id} not found`)
    return m
  }

  private mapMarket(m: KalshiMarket, category?: string): VenueMarket {
    const yesBid = toNum(m.yes_bid_dollars)
    const yesAsk = toNum(m.yes_ask_dollars)
    const noBid = toNum(m.no_bid_dollars)
    const noAsk = toNum(m.no_ask_dollars)
    // Spread in YES-leg points: yesAsk - yesBid when both resting; else the
    // equivalent gap from the NO side (1-noBid - (1-noAsk) = noAsk - noBid).
    let spread: number | undefined
    if (yesBid > 0 && yesAsk > 0) spread = Math.max(0, yesAsk - yesBid)
    else if (noBid > 0 && noAsk > 0) spread = Math.max(0, noAsk - noBid)
    return {
      venue: this.id,
      id: m.ticker ?? '',
      question: m.title
        ? m.title + (m.yes_sub_title && !m.title.includes(m.yes_sub_title) ? ` · ${m.yes_sub_title}` : '')
        : '',
      status: m.status === 'active' || m.status === 'open' ? 'open' : m.status === 'closed' ? 'closed' : 'resolved',
      probability: kalshiPrice(m),
      volume: toNum(m.volume_fp),
      volume24h: toNum(m.volume_24h_fp),
      // liquidity_dollars is present but 0.0000 on every captured market, so
      // top-of-book depth is computed. The NO-bid depth is yes_ask_size_fp
      // (verified against the order book: yes_ask_size == best NO-bid size).
      // This used to read no_bid_size_fp, a field the payload has never
      // carried: toNum(undefined)=0 silently dropped half the book and
      // rejected ~58% of fade-band markets as illiquid.
      liquidity: toNum(m.yes_bid_size_fp) * yesBid + toNum(m.yes_ask_size_fp) * noBid,
      exchangeIndex: this.rememberShard(m),
      outcomeType: m.market_type === 'binary' ? 'BINARY' : 'OTHER',
      category,
      createdAt: m.created_time ? Date.parse(m.created_time) : undefined,
      closeTime: m.close_time ? Date.parse(m.close_time) : undefined,
      spread,
      eventTicker: m.event_ticker,
      seriesTicker: seriesOf(m),
      floorStrike: typeof m.floor_strike === 'number' ? m.floor_strike : undefined,
      capStrike: typeof m.cap_strike === 'number' ? m.cap_strike : undefined,
      strikeType: m.strike_type,
      // Kalshi quadratic taker fee: 0.07 × multiplier × C × P × (1−P), rounded
      // up per fill to $0.000001. The series-level multiplier (S&P/Nasdaq 0.5,
      // most series 1) is patched in asynchronously by applySeriesFees where a
      // batch has been fetched; 0.07 is the conservative standard fallback.
      feeRate: KALSHI_TAKER_FEE_COEF * (this.seriesFeeCache.get(seriesOf(m) ?? '')?.mult ?? 1),
      // Default the MAKER coefficient too, rather than leaving it undefined for every consumer to read as
      // `?? 0`. applySeriesFees resolves only 20 uncached series a scan and the cache is in-memory, so
      // after a restart most markets carry no series fee data at all - and "no data" was being priced as
      // "maker trading is free" at the EV gate, on series Kalshi genuinely bills makers for. Overwritten
      // with the truth (0 on a plain quadratic series) as soon as the series resolves.
      makerFeeRate: KALSHI_MAKER_FEE_COEF * (this.seriesFeeCache.get(seriesOf(m) ?? '')?.mult ?? 1),
      feeWaiverUntil: m.fee_waiver_expiration_time ? Date.parse(m.fee_waiver_expiration_time) : undefined,
      rulesPrimary: m.rules_primary ? m.rules_primary.slice(0, 600) : undefined,
      canCloseEarly: m.can_close_early,
      resolution: m.result && m.result !== '' ? m.result : undefined,
      url: m.ticker ? `https://kalshi.com/markets/${m.ticker}` : undefined
    }
  }

    /**
   * Resolve fee multipliers for the distinct series in a market list and patch
   * feeRate in place. Multipliers are cached for 24h; a restart clears the
   * in-memory cache and they are re-resolved on the following scan. At most 20
   * stale series are resolved per scan so a large market list cannot burst
   * through the venue's rate limit - any remainder is picked up by later scans.
   *
   * FIXED 2026-09-18: a FAILED lookup used to be cached as a 1x default for the
   * full 24h TTL. One transient 429 therefore froze that series' multiplier at
   * 1x for a day, silently mispricing every fee computed on it (2x too high on
   * the 0.5x S&P/Nasdaq series) and losing the maker-fee flag with it. Failures
   * are no longer cached, so the next scan retries. The operator is warned once
   * per series instead of the failure being silent.
   */
  private async applySeriesFees(markets: VenueMarket[]): Promise<void> {
    const now = Date.now()
    const ttl = 24 * 3600_000
    const stale = (s: string): boolean => {
      const c = this.seriesFeeCache.get(s)
      return !c || now - c.at > ttl
    }
    const unknown = [...new Set(markets.map((m) => m.seriesTicker).filter((s): s is string => !!s && stale(s)))]
    await Promise.all(
      unknown.slice(0, 20).map(async (s) => {
        try {
          const res = await this.http.get<{ series?: { fee_multiplier?: number; category?: string; fee_type?: string } }>(`/series/${encodeURIComponent(s)}`)
          const mult = res.series?.fee_multiplier
          this.seriesFeeCache.set(s, {
            mult: typeof mult === 'number' && mult > 0 ? mult : 1,
            category: res.series?.category || undefined,
            feeType: res.series?.fee_type || undefined,
            at: now
          })
        } catch (err) {
          // FIXED 2026-09-18: never cache a default on failure. Doing so froze
          // this series' multiplier at 1x for the full 24h TTL after a single
          // transient 429, silently mispricing every fee on it (2x too high on
          // the 0.5x S&P/Nasdaq series) and losing the maker-fee flag. Leaving
          // it uncached means the next scan retries; warn once per series.
          if (!this.feeLookupWarned.has(s)) {
            this.feeLookupWarned.add(s)
            console.warn(
              `[kalshi] series fee lookup failed for '${s}' (${(err as Error).message}); fees stay at the 1x default until a later scan resolves it`
            )
          }
        }
      })
    )
    for (const m of markets) {
      const c = this.seriesFeeCache.get(m.seriesTicker ?? '')
      if (c !== undefined) {
        m.feeRate = KALSHI_TAKER_FEE_COEF * c.mult
        // The audit (2026-09-02) found maker fees hard-coded to zero for every
        // series while Kalshi bills makers on quadratic_with_maker_fees series.
        // The published maker coefficient is 0.0175 (one quarter of the 0.07
        // taker coefficient, July 2026 fee schedule); the earlier 0.07 guess
        // overstated maker cost four-fold and blocked marginal maker entries.
        m.makerFeeRate = c.feeType === 'quadratic_with_maker_fees' ? KALSHI_MAKER_FEE_COEF * c.mult : 0
        // Series-level category is the authoritative one (the event-level
        // field is deprecated and the old 200-event snapshot went stale).
        if (c.category && !m.category) m.category = c.category
      }
    }
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
        return arr.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    }
  }

  private mapOrderResult(res: KalshiOrderV2, order: OrderRequest, count: number, yesLeg: number): OrderResult {
    const filled = toNum(res.fill_count)
    const avgYes = toNum(res.average_fill_price)
    // Convert the YES-leg average to the price of the leg actually traded.
    const yesRef = avgYes > 0 ? avgYes : yesLeg
    const legAvg = order.outcome === 'YES' ? yesRef : 1 - yesRef
    const feePerContract = toNum(res.average_fee_paid)
    return {
      venue: this.id,
      orderId: res.order_id ?? '',
      marketId: order.marketId,
      outcome: order.outcome,
      // Report what actually traded — an unfilled IOC is 0 shares / $0, not
      // the requested size (the old fallback made no-fills look like fills).
      amount: filled > 0 ? filled * legAvg : 0,
      shares: filled,
      avgPrice: legAvg,
      fee: filled > 0 && feePerContract > 0 ? feePerContract * filled : undefined,
      status: filled >= count - 0.005 ? 'filled' : filled > 0 ? 'partial' : 'open',
      venueStatus: res.status,
      timestamp: res.ts_ms ?? Date.now()
    }
  }
}

function genId(): string {
  return `ot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Ticker-fragment → weather-index city (supported list verified live 2026-08-29). */
const WEATHER_CITIES: { city: string; patterns: string[] }[] = [
  { city: 'miami', patterns: ['MIA'] },
  { city: 'dfw', patterns: ['DFW', 'DAL'] },
  { city: 'houston', patterns: ['HOU'] },
  { city: 'phl-delaware-valley', patterns: ['PHL', 'PHIL'] },
  { city: 'puget-sound', patterns: ['SEA', 'PUGET'] },
  { city: 'sf-bay', patterns: ['SFO', 'SFBAY'] },
  { city: 'greater-boston', patterns: ['BOS'] },
  { city: 'southeast-michigan', patterns: ['DET', 'MICH'] },
  { city: 'kansas-city', patterns: ['KANSAS'] },
  { city: 'minneapolis-st-paul', patterns: ['MSP', 'MINN'] }
]

/** Exact station code → indexed metro for temperature series (no substring guessing). */
const TEMP_STATIONS: Record<string, string> = {
  MIA: 'miami',
  DAL: 'dfw',
  DFW: 'dfw',
  HOU: 'houston',
  PHIL: 'phl-delaware-valley',
  PHL: 'phl-delaware-valley',
  SEA: 'puget-sound',
  SFO: 'sf-bay',
  SF: 'sf-bay',
  BOS: 'greater-boston',
  DET: 'southeast-michigan',
  DTW: 'southeast-michigan',
  KC: 'kansas-city',
  MCI: 'kansas-city',
  MSP: 'minneapolis-st-paul'
}

/**
 * Resolve a temperature event ticker (KXHIGHT/KXLOWT and the no-T KXHIGH/
 * KXLOW shapes) to its indexed metro via EXACT station-code match, or null
 * when the station has no minute index (NYC, DC, ATL, OKC, EWR, TTN, ...).
 */
export function tempStationCity(eventTicker: string): string | null {
  const m = /^KX(?:HIGHT?|LOWT?)([A-Z]+)$/.exec(eventTicker.toUpperCase().split('-')[0])
  if (!m) return null
  return TEMP_STATIONS[m[1]] ?? null
}

/** Series ticker = the prefix before the first '-' (KXXRPD-26AUG2721-T2.1399 → KXXRPD). */
function seriesOf(m: KalshiMarket): string | undefined {
  const src = m.event_ticker || m.ticker || ''
  const prefix = src.split('-')[0]
  return prefix || undefined
}

function clamp01(v: number): number {
  return Math.min(0.99, Math.max(0.01, v))
}

interface KalshiOrderbookFp {
  yes_dollars?: [string, string][]
  no_dollars?: [string, string][]
}

/** Convert Kalshi's YES-bids + NO-bids book into the normalized two-sided book. */
function parseOrderBook(venue: VenueId, marketId: string, ob?: KalshiOrderbookFp): OrderBook {
  const fp = ob ?? { yes_dollars: [], no_dollars: [] }
  const bids = (fp.yes_dollars ?? [])
    .map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }))
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && l.size > 0)
    .sort((a, b) => b.price - a.price)
  const asks = (fp.no_dollars ?? [])
    .map(([p, s]) => ({ price: 1 - parseFloat(p), size: parseFloat(s) }))
    .filter((l) => Number.isFinite(l.price) && l.price < 1 && l.size > 0)
    .sort((a, b) => a.price - b.price)
  return { venue, marketId, bids, asks }
}

/** Mid of a candle's closing bid/ask, when present. */
function midCandle(c: MarketCandle): number | undefined {
  if (c.bidClose !== undefined && c.askClose !== undefined) return (c.bidClose + c.askClose) / 2
  return c.bidClose ?? c.askClose
}

/** Parse a fixed-point dollar string; undefined when absent/empty. */
function numOrUndef(v?: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : undefined
}

/** balance_breakdown[].balance is a DOLLARS string (unlike the top-level `balance`, which is integer cents). */
export function parseBalanceBreakdown(data: Record<string, unknown>): Record<number, number> | undefined {
  const bb = data.balance_breakdown
  if (!Array.isArray(bb) || bb.length === 0) return undefined
  const out: Record<number, number> = {}
  for (const row of bb as { exchange_index?: unknown; balance?: unknown }[]) {
    const idx = Number(row.exchange_index)
    const bal = parseFloat(String(row.balance ?? ''))
    if (Number.isInteger(idx) && Number.isFinite(bal)) out[idx] = bal
  }
  return Object.keys(out).length ? out : undefined
}

export function parseBalance(data: Record<string, unknown>): number {
  const dollars = data.balance_dollars
  if (typeof dollars === 'string') {
    const n = parseFloat(dollars)
    return Number.isFinite(n) ? n : 0
  }
  const cents = data.balance
  if (typeof cents === 'number') return cents / 100
  return 0
}

/** Best estimate of the YES price: last trade first, then real bid/ask midpoint; undefined when untraded. */
function kalshiPrice(m: KalshiMarket): number | undefined {
  const last = toNum(m.last_price_dollars)
  if (last > 0) return last
  const bid = toNum(m.yes_bid_dollars)
  const ask = toNum(m.yes_ask_dollars)
  if (bid > 0 && ask > 0) return (bid + ask) / 2
  return undefined
}

function toNum(v?: string | number): number {
  if (v === undefined || v === null) return 0
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * A7: like toNum, but PRESERVES absence. Use this wherever a missing field means
 * "unknown" rather than "zero", because in those contexts 0 is a meaningful
 * value: a queue position of 0 reads as "front of queue" (the best case) and a
 * remaining count of 0 reads as "nothing left". toNum would fabricate that.
 */
function toNumOpt(v?: string | number): number | undefined {
  if (v === undefined || v === null) return undefined
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Map one raw settlement row to the venue-neutral shape. Exported so the unit
 * conventions can be tested against a REAL captured payload — this is where a
 * 100× realized-P&L bug once lived, and the field names give no hint on their
 * own.
 *
 * Units verified live against the demo exchange 2026-09-01 (KXQUICKSETTLE,
 * 2.67 YES @ 0.70, settled YES):
 *   revenue: 267            -> integer CENTS (2.67 shares × $1.00)
 *   revenue_dollars         -> ABSENT from the live payload, so the /100
 *                              branch below is the normal path, not a fallback
 *   fee_cost: "0.039300"    -> DOLLARS, despite lacking the _dollars suffix
 *                              that marks the other dollar fields
 *   yes_total_cost_dollars  -> DOLLARS
 * realizedPnl then reproduced the account's own balance delta exactly
 * (49.7482 → 47.8399 → 50.5099 = +0.7617). Settlement itself charges no fee;
 * fee_cost is the entry fee already debited at fill time, and subtracting it
 * here is what makes realizedPnl the trade's true round-trip P&L.
 */
export function mapKalshiSettlement(s: KalshiSettlement): VenueSettlement {
  const yesShares = toNum(s.yes_count_fp ?? s.yes_count)
  const noShares = toNum(s.no_count_fp ?? s.no_count)
  const cost = toNum(s.yes_total_cost_dollars) + toNum(s.no_total_cost_dollars)
  // Kalshi's settlement `revenue` reports only the payout on the remaining
  // net position. Opposite YES/NO contracts are paired automatically and
  // return $1 per pair before settlement; those proceeds are not repeated in
  // the row's revenue field. Omitting them made two-sided maker activity look
  // catastrophically unprofitable (77-row live audit: -$190.41 vs -$18.26).
  const settlementRevenue = s.revenue_dollars !== undefined ? toNum(s.revenue_dollars) : toNum(s.revenue) / 100
  const pairedRevenue = Math.min(yesShares, noShares)
  const revenue = settlementRevenue + pairedRevenue
  const fee = toNum(s.fee_cost)
  return {
    marketId: s.ticker ?? '',
    result: s.market_result === 'no' ? 'NO' : 'YES',
    shares: yesShares + noShares,
    yesShares,
    noShares,
    cost,
    revenue,
    settlementRevenue,
    pairedRevenue,
    fee,
    realizedPnl: revenue - cost - fee,
    timestamp: s.settled_time ? Date.parse(s.settled_time) : 0
  }
}
