/**
 * T-5 Minute Crypto Spot Convergence Strategy.
 *
 * Implements the pre-registered strategy (docs/PREREGISTERED-btc-convergence.md)
 * which achieved +1.41c/contract net edge (0.0% adverse selection on 0.20%+ margins)
 * across forward out-of-sample data.
 *
 * Upgraded Features:
 * 1. Sub-second live WebSocket tick ingestion (Coinbase Advanced Trade).
 * 2. Fractional Kelly sizing calculator integration for mathematically optimal compound growth.
 * 3. Immediate-Or-Cancel (IOC) crossing with bounded 1c slippage.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VenueAdapter } from '../../shared/venue'
import { liveSpotFeed } from '../services/liveSpot'
import { calcQuarterKellySizing } from '../util/kelly'
import { kalshiTakerOrderFeeDollars } from '../util/kalshiFee'

const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2'
const COINBASE_API = 'https://api.exchange.coinbase.com/products'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}
const r2 = (x: number): number => Math.round(x * 100) / 100
const normalCdf = (x: number): number => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x)
  const p = 1 - d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? p : 1 - p
}

export interface CryptoConvergenceConfig {
  convergenceEnabled: boolean
  convergenceLiveEnabled: boolean
  convergenceSeries: string[] // ['KXBTCD', 'KXETHD', 'KXSOLD', 'KXXRPD']
  convergenceMinMarginPct: number // default 0.20%
  convergenceMaxMarginPct: number // default 0.60%
  convergenceMinEdgeCents: number // default 1.0c
  convergenceMinCostCents: number // default 60c
  convergenceMaxCostCents: number // default 88c
  convergenceMaxContractsPerTrade: number // default 2
  convergenceMaxOpenTrades: number // default 1 in micro-live
  convergenceMaxDailyTrades: number // default 3 independent events/day
  convergenceModeledWinProbability: number // provisional executable-edge prior
  convergenceTradeHorizonMinMinutes: number // default 2
  convergenceTradeHorizonMaxMinutes: number // default 6
  /** Enable Quarter-Kelly optimal sizing based on modeled edge */
  useKellySizing?: boolean
}

export interface ConvergenceTrade {
  id: string
  ts: string
  seriesTicker: string
  marketTicker: string
  eventTicker?: string
  coin: string
  strike: number
  spotAtEntry: number
  marginPct: number
  outcome: 'YES' | 'NO'
  costPrice: number
  feeCents: number
  netEdgeCents: number
  modeledWinProbability?: number
  strategyVersion?: string
  contracts: number
  closeTime: string
  status: 'no_fill' | 'error' | 'shadow' | 'filled' | 'settled'
  result?: 'yes' | 'no'
  realizedPnlCents?: number
}

export interface CryptoConvergenceStatus {
  enabled: boolean
  liveEnabled: boolean
  active: boolean
  gradedTrades: number
  wins: number
  losses: number
  realizedPnlCents: number
  lastSpot: Record<string, number | null>
  lastScanAt?: number
  note: string
  attempts: number
  fills: number
  noFills: number
  openTrades: number
  dailyFills: number
}

interface ConvergenceState {
  trades: ConvergenceTrade[]
  totalTrades: number
  wins: number
  losses: number
  realizedPnlCents: number
  lastScanAt?: number
}

/**
 * Taker fee in dollars for a `count`-contract Kalshi order.
 *
 * Routed through the canonical model (2026-09-18) so the float-dust guard -
 * absent here until now, though leadLag and dutchBook both had it - and the
 * venue's order-level rounding are defined in exactly one place. Without the
 * guard a value that should ceil to exactly N cents can be pushed to N+1 by
 * binary-float dust.
 *
 * The EV gate calls this with count = 1 because the real size is chosen further
 * down (Kelly, then capped). A 1-contract fee is the CONSERVATIVE bound: the
 * venue ceils the ORDER total, and that ceil amortises across more contracts as
 * size grows, so a bigger order never pays more per contract than this figure.
 */
function calcTakerFee(price: number, count: number): number {
  return kalshiTakerOrderFeeDollars(price, count)
}

export class CryptoConvergenceEngine {
  private running = false
  private note = 'idle'
  private spotCache: Record<string, number | null> = {}
  private volCache = new Map<string, { at: number; sigmaPerMinute: number }>()
  private state: ConvergenceState = {
    trades: [],
    totalTrades: 0,
    wins: 0,
    losses: 0,
    realizedPnlCents: 0
  }

  constructor(
    private readonly path: string,
    private readonly log: (s: string) => void = console.log
  ) {
    try {
      if (existsSync(path)) {
        this.state = { ...this.state, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<ConvergenceState>) }
      }
    } catch {
      // fresh state
    }
    // Legacy IOC misses were stored as "pending" even though no exchange
    // order remained. Normalize them so the UI and retry logic are truthful.
    for (const t of this.state.trades as Array<ConvergenceTrade & { status: string }>) {
      if (String(t.status) === 'pending') t.status = 'no_fill'
    }

    // Initialize live sub-second spot websocket feed
    liveSpotFeed.start()
  }

  status(cfg: CryptoConvergenceConfig): CryptoConvergenceStatus {
    const today = new Date().toISOString().slice(0, 10)
    return {
      enabled: cfg.convergenceEnabled,
      liveEnabled: cfg.convergenceLiveEnabled,
      active: this.running,
      gradedTrades: this.state.wins + this.state.losses,
      wins: this.state.wins,
      losses: this.state.losses,
      realizedPnlCents: r2(this.state.realizedPnlCents),
      lastSpot: this.spotCache,
      lastScanAt: this.state.lastScanAt,
      note: this.note,
      attempts: this.state.trades.filter((t) => t.status !== 'shadow').length,
      fills: this.state.trades.filter((t) => t.status === 'filled' || t.status === 'settled').length,
      noFills: this.state.trades.filter((t) => t.status === 'no_fill').length,
      openTrades: this.state.trades.filter((t) => t.status === 'filled').length,
      dailyFills: this.state.trades.filter((t) => (t.status === 'filled' || t.status === 'settled') && t.ts.slice(0, 10) === today).length
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = this.path + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.path)
    } catch (e) {
      this.log('[convergence] persist failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  private async fetchSpot(coin: string): Promise<number | null> {
    // Use WebSocket only while fresh. A disconnected socket must never leave
    // an indefinitely stale price eligible for a real-money order.
    const wsTick = liveSpotFeed.getTick(coin)
    if (wsTick && Date.now() - wsTick.timestamp <= 5_000 && Number.isFinite(wsTick.price)) {
      this.spotCache[coin] = wsTick.price
      return wsTick.price
    }

    try {
      const res = await fetch(`${COINBASE_API}/${coin}-USD/ticker`, {
        signal: AbortSignal.timeout(6000)
      })
      if (!res.ok) return null
      const data = (await res.json()) as { price?: string }
      const p = num(data.price)
      this.spotCache[coin] = p
      return p
    } catch {
      return null
    }
  }

  /** Realized one-minute log-return volatility from point-in-time Coinbase candles. */
  private async minuteVol(coin: string): Promise<number | null> {
    const cached = this.volCache.get(coin)
    if (cached && Date.now() - cached.at < 2 * 60_000) return cached.sigmaPerMinute
    try {
      const end = new Date()
      const start = new Date(end.getTime() - 70 * 60_000)
      const url = `${COINBASE_API}/${coin}-USD/candles?granularity=60&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`
      const res = await fetch(url, { signal: AbortSignal.timeout(7000) })
      if (!res.ok) return null
      const candles = (await res.json()) as number[][]
      const closes = candles.filter((x) => x.length >= 5 && Number.isFinite(x[4])).sort((a, b) => a[0] - b[0]).map((x) => x[4])
      if (closes.length < 20) return null
      const returns = closes.slice(1).map((x, i) => Math.log(x / closes[i])).filter(Number.isFinite)
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length
      const variance = returns.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, returns.length - 1)
      const sigmaPerMinute = Math.max(0.00035, Math.sqrt(variance))
      this.volCache.set(coin, { at: Date.now(), sigmaPerMinute })
      return sigmaPerMinute
    } catch { return null }
  }

  /**
   * Conservative probability that spot remains on its current side at close.
   * Distance is reduced by a 2.5bp Coinbase/BRTI basis reserve, then evaluated
   * against recent realized volatility. Shrink toward 50% and cap by the
   * configured empirical prior so a calm hour cannot manufacture certainty.
   */
  private async modeledProbability(coin: string, spot: number, strike: number, minutesToClose: number, cap: number): Promise<number | null> {
    const sigma = await this.minuteVol(coin)
    if (!sigma) return null
    const rawDistance = Math.abs(Math.log(spot / strike))
    const adjustedDistance = Math.max(0, rawDistance - 0.00025)
    const z = adjustedDistance / Math.max(1e-8, sigma * Math.sqrt(Math.max(0.5, minutesToClose)))
    const cdf = normalCdf(z)
    const shrunk = 0.5 + (cdf - 0.5) * 0.96
    return Math.min(Math.max(0.5, cap), Math.max(0.5, shrunk))
  }

  private async reconcileSettlements(adapter: VenueAdapter): Promise<void> {
    const now = Date.now()
    for (const t of this.state.trades) {
      if (t.status !== 'filled' || Date.parse(t.closeTime) + 60_000 > now) continue
      const market = await adapter.getMarket(t.marketTicker).catch(() => undefined)
      const resolution = market?.resolution?.toUpperCase()
      // Kalshi maps terminal venue status to status='resolved' and exposes the
      // winning side through resolution. The optional resolved boolean is used
      // by other adapters and is not populated by Kalshi, so accept either.
      const isResolved = market?.resolved === true || market?.status === 'resolved'
      if (!isResolved || (resolution !== 'YES' && resolution !== 'NO')) continue
      const won = resolution === t.outcome
      t.status = 'settled'
      t.result = resolution.toLowerCase() as 'yes' | 'no'
      t.realizedPnlCents = +((won ? (1 - t.costPrice) * 100 : -t.costPrice * 100) * t.contracts - t.feeCents * t.contracts).toFixed(2)
      if (won) this.state.wins++
      else this.state.losses++
      this.state.realizedPnlCents += t.realizedPnlCents
      this.log(`[convergence] SETTLED ${t.marketTicker} ${won ? 'WIN' : 'LOSS'} ${t.realizedPnlCents >= 0 ? '+' : ''}${t.realizedPnlCents.toFixed(2)}c`)
    }
  }

  /**
   * Scan hourly crypto ladders at T-5 minutes and fire convergence orders.
   */
  async scanAndExecute(
    adapter: VenueAdapter,
    cfg: CryptoConvergenceConfig,
    mode: 'paper' | 'live',
    armed: boolean,
    killed: boolean,
    /** Exchange trading paused (weekly maintenance): settle, but place nothing. */
    paused = false
  ): Promise<void> {
    if (this.running || !cfg.convergenceEnabled) return
    this.running = true
    const now = Date.now()

    try {
      this.state.lastScanAt = now
      await this.reconcileSettlements(adapter)
      if (paused) {
        this.note = 'exchange trading paused; not scanning'
        return
      }
      const seriesList = cfg.convergenceSeries || ['KXBTCD', 'KXETHD', 'KXSOLD', 'KXXRPD']
      let candidatesFound = 0
      let ordersFired = 0
      // Why the window's strikes did not qualify — a silent "0 setups" for two
      // days is indistinguishable from a broken feed without this.
      let inWindow = 0
      const skip = { strike: 0, margin: 0, cost: 0, vol: 0, edge: 0, event: 0, limits: 0 }

      let accountBalance = 100
      try {
        const acc = await adapter.getAccount()
        if (acc?.balance && acc.balance > 0) accountBalance = acc.balance
      } catch {
        // default fallback
      }

      for (const series of seriesList) {
        const coin = series.replace(/^KX/, '').replace(/D$/, '')
        const spot = await this.fetchSpot(coin)
        if (!spot) continue

        let marketsRes: Response
        try {
          marketsRes = await fetch(`${KALSHI_API}/markets?series_ticker=${series}&status=open&limit=1000`, {
            signal: AbortSignal.timeout(10000)
          })
        } catch {
          continue
        }
        if (!marketsRes.ok) continue
        const data = (await marketsRes.json()) as { markets?: any[] }
        const markets = data.markets ?? []

        for (const m of markets) {
          const close = m.close_time ? Date.parse(m.close_time) : NaN
          if (!Number.isFinite(close)) continue
          const minutesToClose = (close - now) / 60_000

          // Must be in the target T-5m window (e.g. 2 to 6 minutes before close)
          if (minutesToClose < cfg.convergenceTradeHorizonMinMinutes || minutesToClose > cfg.convergenceTradeHorizonMaxMinutes) {
            continue
          }
          inWindow++

          // Only "greater" markets read spot > floor_strike as YES. A "less" market carries its threshold in
          // cap_strike (skipped below by the null floor) and a "between" market would resolve NO above its cap;
          // refuse anything else explicitly rather than trusting the floor alone (external review, 2026-09-19).
          const strikeType = String((m as { strike_type?: string }).strike_type ?? 'greater')
          if (!/^greater/.test(strikeType)) {
            skip.strike++
            continue
          }
          const strike = num(m.floor_strike)
          if (strike === null || strike <= 0) {
            skip.strike++
            continue
          }

          const margin = Math.abs(spot - strike) / spot
          if (margin < cfg.convergenceMinMarginPct / 100 || margin > cfg.convergenceMaxMarginPct / 100) {
            skip.margin++
            continue
          }

          const side: 'YES' | 'NO' = spot > strike ? 'YES' : 'NO'
          const yesAsk = num(m.yes_ask_dollars)
          const yesBid = num(m.yes_bid_dollars)

          // On Kalshi, buying YES pays yes_ask; buying NO pays 1 - yes_bid
          const cost = side === 'YES' ? yesAsk : (yesBid !== null ? +(1 - yesBid).toFixed(4) : null)
          if (cost === null || cost < cfg.convergenceMinCostCents / 100 || cost > cfg.convergenceMaxCostCents / 100) {
            skip.cost++
            continue
          }

          const feeDollars = calcTakerFee(cost, 1)
          // Expected edge is probability minus executable cost minus fee. The
          // old code assumed a 100% win, which turned payout upside into fake
          // alpha. 0.97 is a provisional, explicitly configured micro-live
          // prior and must be replaced by a larger calibrated sample.
          const modeledWinProb = await this.modeledProbability(
            coin, spot, strike, minutesToClose,
            Math.min(0.995, Math.max(0.5, cfg.convergenceModeledWinProbability))
          )
          // Missing volatility data fails closed for the v2 live rule.
          if (modeledWinProb === null) {
            skip.vol++
            continue
          }
          const netEdgeCents = (modeledWinProb - cost) * 100 - feeDollars * 100
          if (netEdgeCents < cfg.convergenceMinEdgeCents) {
            skip.edge++
            continue
          }

          candidatesFound++
          const tradeId = `conv-${m.ticker}-${Date.now()}`

          const eventTicker = String(m.event_ticker ?? m.ticker)
          // One FILLED position per event. IOC zero-fills are execution
          // observations, not positions; permit up to three bounded retries
          // in the fixed T-5 window instead of idling after one missed quote.
          const sameEvent = this.state.trades.filter((t) => (t.eventTicker ?? t.marketTicker) === eventTicker)
          if (sameEvent.some((t) => t.status === 'filled' || t.status === 'settled') || sameEvent.filter((t) => t.status === 'no_fill' || t.status === 'error').length >= 3) {
            skip.event++
            continue
          }

          const openLive = this.state.trades.filter((t) => t.status === 'filled' && Date.parse(t.closeTime) > now).length
          const today = new Date(now).toISOString().slice(0, 10)
          const liveToday = this.state.trades.filter((t) => (t.status === 'filled' || t.status === 'settled') && t.ts.slice(0, 10) === today).length
          if (openLive >= cfg.convergenceMaxOpenTrades || liveToday >= cfg.convergenceMaxDailyTrades) {
            skip.limits++
            continue
          }

          // Sizing: Use Fractional Kelly if enabled, otherwise fallback to max contracts
          let count = Math.max(1, Math.min(4, cfg.convergenceMaxContractsPerTrade))
          if (cfg.useKellySizing) {
            const kelly = calcQuarterKellySizing({
              accountBalance,
              costPrice: cost,
              trueProbability: modeledWinProb,
              maxBalancePct: 0.01,
              maxContracts: Math.max(1, Math.min(4, cfg.convergenceMaxContractsPerTrade))
            })
            count = Math.max(1, Math.min(4, cfg.convergenceMaxContractsPerTrade, kelly.recommendedContracts))
          }

          const canTrade = mode === 'live' && armed && !killed && cfg.convergenceLiveEnabled
          const trade: ConvergenceTrade = {
            id: tradeId,
            ts: new Date().toISOString(),
            seriesTicker: series,
            marketTicker: m.ticker,
            eventTicker,
            coin,
            strike,
            spotAtEntry: spot,
            marginPct: +(margin * 100).toFixed(3),
            outcome: side,
            costPrice: cost,
            feeCents: +(feeDollars * 100).toFixed(2),
            netEdgeCents: +netEdgeCents.toFixed(2),
            modeledWinProbability: +modeledWinProb.toFixed(4),
            strategyVersion: 'convergence-v2-vol-0.20-0.40',
            contracts: count,
            closeTime: m.close_time,
            status: canTrade ? 'no_fill' : 'shadow'
          }

          this.log(`[convergence] QUALIFIED ${side} on ${m.ticker} (Strike $${strike} vs Spot $${spot}, Margin ${(margin * 100).toFixed(2)}%): Cost ${(cost * 100).toFixed(1)}c | Net Edge +${netEdgeCents.toFixed(1)}c/contract (T-${minutesToClose.toFixed(1)}m, Size: ${count})`)

          if (canTrade) {
            try {
              const yesLegPrice = side === 'YES' ? cost : (yesBid ?? +(1 - cost).toFixed(4))
              const limit = side === 'YES'
                ? Math.min(0.99, +(yesLegPrice + 0.01).toFixed(2))
                : Math.max(0.01, +(yesLegPrice - 0.01).toFixed(2))

              const res = await adapter.placeOrder({
                venue: 'kalshi',
                marketId: m.ticker,
                outcome: side,
                // Amount is converted back to contract count by the adapter
                // at LIMIT cost, so use that exact leg cost to request x1.
                amount: count * (side === 'YES' ? limit : 1 - limit),
                contracts: count,
                limitPrice: limit,
                timeInForce: 'immediate_or_cancel'
              })
              trade.status = res.shares > 0 ? 'filled' : 'no_fill'
              if (res.shares > 0) ordersFired++
              this.log(`[convergence] ${res.shares > 0 ? 'EXECUTED' : 'NO FILL'} ${side} on ${m.ticker} x${count} @ ${(cost * 100).toFixed(1)}c (Order ID: ${res.orderId})`)
            } catch (e) {
              trade.status = 'error'
              this.log(`[convergence] place failed on ${m.ticker}: ${e instanceof Error ? e.message : String(e)}`)
            }
          }

          this.state.trades.push(trade)
          this.state.totalTrades++
          try {
            // Was `/\\.json$/` (a literal backslash in the pattern, never
            // matching) plus a backslash-newline line continuation, so the log
            // landed at "crypto-convergence.json-trades.jsonl" with no record
            // separators — unparseable JSONL. Canonical name, real newline.
            const logFile = this.path.replace(/\.json$/, '') + '-trades.jsonl'
            appendFileSync(logFile, JSON.stringify(trade) + '\n')
          } catch (e) {
            this.log('[convergence] trade log failed: ' + (e instanceof Error ? e.message : String(e)))
          }

          await sleep(100)
        }
      }

      this.note = `scanned crypto ladders, found ${candidatesFound} setups, fired ${ordersFired} orders${inWindow ? ` | in window ${inWindow}: margin-out ${skip.margin} cost-out ${skip.cost} no-vol ${skip.vol} edge-out ${skip.edge} event-dup ${skip.event} limits ${skip.limits}` : ''}`
    } catch (e) {
      this.note = 'scan failed: ' + (e instanceof Error ? e.message : String(e))
      this.log('[convergence] error: ' + this.note)
    } finally {
      this.persist()
      this.running = false
    }
  }
}


