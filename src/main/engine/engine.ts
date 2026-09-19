import type { VenueAdapter } from '../../shared/venue'
import type { VenueRegistry } from '../venues/registry'
import { PaperBroker } from './paper'
import { HistoryStore } from '../store/history'
import { OrderJournal, type JournalOrder } from '../store/orderJournal'
import { HttpError } from '../util/http'
import { join } from 'node:path'
import type {
  ExecutionMode,
  HistoryStats,
  LivePnl,
  MarketSearchQuery,
  OrderRequest,
  OrderResult,
  Position,
  SellRequest,
  TradeRecord,
  VenueCredentials,
  VenueId,
  VenueMarket
} from '../../shared/types'
import type { EngineState, PortfolioSnapshot, RiskLimits } from '../../shared/ipc'

/** VWAP + available size for a simulated fill against the live book. */
export interface PaperFillPlan {
  avgPrice: number
  maxShares: number
}

export interface EngineOptions {
  paperStartingBalance?: number
  /** Per-venue paper starting balance (falls back to paperStartingBalance). */
  paperStartingBalances?: Partial<Record<VenueId, number>>
  /** Directory for persisting paper-account state (survives restarts). */
  paperStateDir?: string
}

/**
 * Orchestrates venue adapters, the paper broker, and execution mode.
 * Strategies and the UI talk to the engine, never directly to an adapter.
 */
/** The position-cap count is served from memory for up to 30 s and refreshed in the background after 5 s. */
export const POSITION_COUNT_MAX_AGE_MS = 30_000
export const POSITION_COUNT_REFRESH_MS = 5_000
/** How long after an order settles before a venue read is trusted to include it. */
export const RESERVATION_VISIBILITY_MS = 2_000

export class TradingEngine {
  private mode: ExecutionMode = 'paper'
  private paperBrokers = new Map<VenueId, PaperBroker>()
  private questionCache = new Map<string, string>()
  private riskLimits: RiskLimits = { maxStakePerBet: 0, maxOpenPositions: 0 }
  private livePnlCache = new Map<VenueId, { at: number; value: LivePnl | null }>()
  private livePnlInflight = new Map<VenueId, Promise<LivePnl | null>>()
  private portfolioCache = new Map<string, { at: number; value: PortfolioSnapshot }>()
  private portfolioInflight = new Map<string, Promise<PortfolioSnapshot>>()
  /** One routed view per venue+strategy: adapters keep per-instance dedupe state (e.g. the positions log signature) as own properties, so a fresh wrapper per tick would reset it every call. */
  private routedCache = new Map<string, VenueAdapter>()
  private entryQueues = new Map<VenueId, Promise<void>>()
  /** Venue snapshot for the position cap: positions + resting orders + journaled in-flight intents. Reservations are NOT in it. */
  private openPositionCountCache = new Map<VenueId, { at: number; base: number }>()
  private openPositionCountInflight = new Map<VenueId, Promise<number>>()
  private warmUntil = new Map<VenueId, number>()
  private warmTimer: ReturnType<typeof setInterval> | undefined
  /**
   * Live slot reservations per venue, one token per entry. A token counts on top of the snapshot until a venue read
   * that STARTED after its order settled has completed (with a margin for venue visibility); a zero fill removes it at
   * once. Round 116 kept a net counter instead and a zero fill landing during a read drove the count negative, which
   * let two orders fill against a cap of one (GPT's reproduction, 2026-09-17).
   */
  private reservations = new Map<VenueId, Map<number, { settledAt?: number }>>()
  private reservationSeq = 0
  private journal?: OrderJournal
  private recoveryChecks = new Map<string, number>()

  constructor(
    private readonly registry: VenueRegistry,
    private readonly history: HistoryStore,
    private readonly opts: EngineOptions = {}
  ) {
    if (opts.paperStateDir) this.journal = new OrderJournal(join(opts.paperStateDir, 'order-journal.jsonl'))
  }

  orderAttribution(venue: VenueId, orderId: string): JournalOrder | undefined { return this.journal?.attribution(venue, orderId) }
  orderIntent(venue: VenueId, ref: string): JournalOrder | undefined { return this.journal?.byRef(venue, ref) }
  orderStrategy(venue: VenueId, orderId: string): string | undefined { return this.orderAttribution(venue, orderId)?.ref ?? this.history.orderStrategy(venue, orderId) }

  async reconcileOrders(venue: VenueId): Promise<void> {
    const adapter = this.getAdapter(venue)
    if (!this.journal || !adapter?.findOrderByClientId) return
    const pending = this.journal.pending(venue).filter(row => Date.now() - row.requestedAt >= 60_000)
      .sort((a, b) => (this.recoveryChecks.get(a.clientOrderId) ?? 0) - (this.recoveryChecks.get(b.clientOrderId) ?? 0))
    for (const row of pending.slice(0, 4)) {
      this.recoveryChecks.set(row.clientOrderId, Date.now())
      const found = await adapter.findOrderByClientId(row.clientOrderId, row.marketId, row.requestedAt)
      if (found) {
        this.journal.update(row, { state: 'acknowledged', orderId: found.orderId, acknowledgedAt: Date.now() })
        console.log(`[orders] recovered ${venue} submission on ${row.marketId}`)
      }
    }
  }

  async init(credentials?: Partial<Record<VenueId, VenueCredentials>>): Promise<void> {
    for (const adapter of this.registry.list()) {
      const creds = credentials?.[adapter.id]
      await adapter.init(creds).catch((err) => {
        console.warn(`[engine] failed to init ${adapter.id}:`, err instanceof Error ? err.message : err)
      })
      this.paperBrokers.set(adapter.id, this.makePaperBroker(adapter.id, adapter.currency))
    }
  }

  getAdapter(venue: VenueId): VenueAdapter | undefined {
    return this.registry.get(venue)
  }

  setExecutionMode(mode: ExecutionMode): void {
    this.mode = mode
    this.openPositionCountCache.clear()
  }

  getExecutionMode(): ExecutionMode {
    return this.mode
  }

  setRiskLimits(limits: RiskLimits): void {
    this.riskLimits = { ...limits }
    this.openPositionCountCache.clear()
  }

  async setCredentials(venue: VenueId, creds: VenueCredentials): Promise<void> {
    await this.requireAdapter(venue).init(creds)
  }

  getState(): EngineState {
    return {
      executionMode: this.mode,
      venues: this.registry.list().map((a) => ({
        id: a.id,
        name: a.name,
        currency: a.currency,
        connected: true,
        realMoney: a.capabilities.realMoney,
        liveTrading: a.capabilities.liveTrading
      }))
    }
  }

  async searchMarkets(venue: VenueId, query: MarketSearchQuery): Promise<VenueMarket[]> {
    return this.requireAdapter(venue).searchMarkets(query)
  }

  /**
   * The stake cap for one venue: its override if set, else the global. One function for both the place and
   * amend checks, so the two cannot drift apart - they were two hand-copied expressions before.
   */
  private stakeCapFor(venue: VenueId): number {
    const v = this.riskLimits.maxStakePerBetByVenue?.[venue]
    return typeof v === 'number' && v >= 0 ? v : this.riskLimits.maxStakePerBet
  }

  /**
   * Refresh the position-cap count in the background so the next order does not wait on venue reads. Lead-lag
   * calls this at the start of every poll; its orders follow a second or two later.
   */
  warmOpenPositionCount(venue: VenueId): void {
    if (this.mode !== 'live' || this.riskLimits.maxOpenPositions <= 0 || !this.registry.get(venue)) return
    // Keep it warm between polls too: a poll longer apart than the 30 s cache (and the account read racing the
    // scan's quote fetches) made every sweep await a fresh read - 0.9-1.9 s from decision to send on 2026-09-17.
    this.warmUntil.set(venue, Date.now() + 120_000)
    if (!this.warmTimer) {
      this.warmTimer = setInterval(() => {
        for (const [v, until] of this.warmUntil) {
          if (Date.now() > until || this.mode !== 'live') { this.warmUntil.delete(v); continue }
          void this.readOpenPositionCount(v).catch(() => undefined)
        }
        if (this.warmUntil.size === 0 && this.warmTimer) { clearInterval(this.warmTimer); this.warmTimer = undefined }
      }, POSITION_COUNT_REFRESH_MS * 2)
      this.warmTimer.unref?.()
    }
    const cached = this.openPositionCountCache.get(venue)
    if (cached && Date.now() - cached.at < POSITION_COUNT_REFRESH_MS) return
    void this.readOpenPositionCount(venue).catch(() => undefined)
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    // Keep the venue snapshot and submission together. Concurrent strategies
    // otherwise all see the same final free slot before any order is counted.
    if (this.riskLimits.maxOpenPositions <= 0) return this.placeOrderChecked(order)
    if (this.mode === 'live') return this.placeLiveOrderReserved(order)
    const previous = this.entryQueues.get(order.venue) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.entryQueues.set(order.venue, current)
    await previous
    try {
      return await this.placeOrderChecked(order)
    } finally {
      release()
      if (this.entryQueues.get(order.venue) === current) this.entryQueues.delete(order.venue)
    }
  }

  /**
   * Live entries: check the cap and reserve the slot inside the per-venue queue, then submit OUTSIDE it. Holding the
   * queue across the POST made every order wait for the previous order's full round trip; the reservation already
   * gives the next order an exact count, so concurrent submission cannot share the last slot.
   */
  private async placeLiveOrderReserved(order: OrderRequest): Promise<OrderResult> {
    let token: number | undefined
    const previous = this.entryQueues.get(order.venue) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.entryQueues.set(order.venue, current)
    await previous
    try {
      const cap = this.stakeCapFor(order.venue)
      if (cap > 0 && order.amount > cap) throw new Error(`Order of ${order.amount} exceeds max stake per bet (${cap} on ${order.venue})`)
      // An exit expressed as a buy of the opposite side (closeFrom, IBKR and Polymarket US) frees a slot; it must
      // never be refused at the cap or reserve one (2026-09-19, external review: a full book could not exit).
      if (!order.closeFrom) {
        const count = await this.countOpenPositions(order.venue)
        if (count >= this.riskLimits.maxOpenPositions) throw new Error(`At max open positions (${this.riskLimits.maxOpenPositions})`)
        token = this.reserveSlot(order.venue)
      }
    } finally {
      release()
      if (this.entryQueues.get(order.venue) === current) this.entryQueues.delete(order.venue)
    }
    let res: OrderResult
    try {
      res = await this.submitLive(order, 'buy')
    } catch (e) {
      // An explicit venue rejection holds nothing: release the slot. Any other error may conceal a fill: keep the token
      // counted until a later read has seen the aftermath, and drop the snapshot so the next entry re-reads.
      if (token !== undefined) {
        if (e instanceof HttpError && [400, 401, 403, 404, 422, 429].includes(e.status)) this.reservations.get(order.venue)?.delete(token)
        else this.settleSlot(order.venue, token)
      }
      this.openPositionCountCache.delete(order.venue)
      throw e
    }
    // Nothing held and nothing resting: give the reserved slot back. Otherwise it stays counted until a later read sees it.
    if (token !== undefined) {
      if (!(res.shares > 0 || res.venueStatus === 'resting')) this.reservations.get(order.venue)?.delete(token)
      else this.settleSlot(order.venue, token)
    } else this.openPositionCountCache.delete(order.venue)
    if (order.marketQuestion) this.questionCache.set(order.marketId, order.marketQuestion)
    this.recordFill(order.venue, order.closeFrom ?? order.marketId, order.outcome, order.closeFrom ? 'sell' : 'buy', res, order.ref, order.marketQuestion, order.answerId)
    return res
  }

  private async placeOrderChecked(order: OrderRequest): Promise<OrderResult> {
    const cap = this.stakeCapFor(order.venue)
    if (cap > 0 && order.amount > cap) {
      throw new Error(`Order of ${order.amount} exceeds max stake per bet (${cap} on ${order.venue})`)
    }
    if (this.riskLimits.maxOpenPositions > 0 && !order.closeFrom) {
      const count = await this.countOpenPositions(order.venue)
      if (count >= this.riskLimits.maxOpenPositions) {
        throw new Error(`At max open positions (${this.riskLimits.maxOpenPositions})`)
      }
    }

    if (this.mode === 'paper') {
      const adapter = this.requireAdapter(order.venue)
      // Multiple-choice markets price per answer — quoting the parent market
      // returns 0 and made every MC paper trade throw.
      const quote = await adapter.getPrice(order.marketId, order.answerId ?? order.outcome, order.outcome as 'YES' | 'NO')
      const broker = this.paperBrokers.get(order.venue)
      if (!broker) throw new Error(`No paper broker for '${order.venue}'`)
      const plan = await this.paperBuyPlan(adapter, order.marketId, order.outcome, order.amount, order.limitPrice)
      if (plan === null) throw new Error('Paper: no executable liquidity within the limit')
      const res = broker.buy(order, quote, plan)
      if (order.marketQuestion) this.questionCache.set(order.marketId, order.marketQuestion)
      this.recordFill(order.venue, order.marketId, order.outcome, 'buy', res, order.ref, order.marketQuestion, order.answerId)
      return res
    }
    let res: OrderResult
    try {
      res = await this.submitLive(order, 'buy')
    } catch (e) {
      this.openPositionCountCache.delete(order.venue)
      throw e
    }
    // The per-venue entry queue serialises this update with the cap check. A
    // filled buy or resting order consumes one conservative slot immediately,
    // so the next strategy need not wait on two venue reads to see it.
    if (this.riskLimits.maxOpenPositions > 0 && (res.shares > 0 || res.venueStatus === 'resting')) this.settleSlot(order.venue, this.reserveSlot(order.venue))
    // Record live fills so real orders appear in the trade history (recordFill
    // drops zero-share results, so unfilled IOCs stay out of the ledger).
    if (order.marketQuestion) this.questionCache.set(order.marketId, order.marketQuestion)
    this.recordFill(order.venue, order.marketId, order.outcome, 'buy', res, order.ref, order.marketQuestion, order.answerId)
    return res
  }

  private async submitLive(order: OrderRequest | SellRequest, side: 'buy' | 'sell'): Promise<OrderResult> {
    const adapter = this.requireAdapter(order.venue)
    const journaled = order.venue === 'kalshi' || order.venue === 'polymarket-us' || order.venue === 'ibkr'
    const intent = journaled ? this.journal?.begin({ venue: order.venue, marketId: order.marketId, outcome: order.outcome, side, ref: order.ref }) : undefined
    let submitted = false
    const request = { ...order, clientOrderId: intent?.clientOrderId ?? order.clientOrderId, onSubmit: () => {
      if (intent) this.journal!.update(intent, { submittedAt: Date.now() })
      submitted = true
    } }
    let res: OrderResult
    try {
      res = side === 'buy' ? await adapter.placeOrder(request as OrderRequest) : await adapter.sellPosition(request as SellRequest)
      if (intent && !res.orderId) throw new Error('Submission response has no order ID; reconciliation required')
    } catch (e) {
      if (intent && (!submitted || (e instanceof HttpError && [400, 401, 403, 404, 422, 429].includes(e.status)))) this.journal!.update(intent, { state: 'rejected' })
      throw e
    }
    if (intent) this.journal!.update(intent, { state: 'acknowledged', orderId: res.orderId, acknowledgedAt: Date.now() })
    return res
  }

  async sellPosition(req: SellRequest): Promise<OrderResult> {
    const closeAsBuy = this.requireAdapter(req.venue).closeAsBuy
    if (this.mode === 'live' && closeAsBuy) return this.placeOrder(await closeAsBuy.call(this.requireAdapter(req.venue), req))
    if (this.mode === 'paper') {
      const adapter = this.requireAdapter(req.venue)
      const quote = await adapter.getPrice(req.marketId, req.answerId ?? req.outcome, req.outcome as 'YES' | 'NO')
      const broker = this.paperBrokers.get(req.venue)
      if (!broker) throw new Error(`No paper broker for '${req.venue}'`)
      const held = broker.getPositionShares(req.marketId, req.outcome, req.answerId)
      if (held <= 0) throw new Error('No paper position to sell')
      const want = req.shares !== undefined ? Math.min(req.shares, held) : held
      const plan = await this.paperSellPlan(adapter, req.marketId, req.outcome, want, req.limitPrice)
      if (plan === null) throw new Error('Paper: no executable liquidity within the limit')
      const res = broker.sell(req, quote, plan)
      this.recordFill(req.venue, req.marketId, req.outcome, 'sell', res, undefined, this.questionCache.get(req.marketId), req.answerId)
      return res
    }
    const res = await this.submitLive(req, 'sell')
    this.recordFill(req.venue, req.marketId, req.outcome, 'sell', res, req.ref, this.questionCache.get(req.marketId), req.answerId)
    return res
  }

  /**
   * Settle an open PAPER position at a resolution value (0 or 1) and record it
   * in history. Returns null when there is no such position. Live venues settle
   * on their own — this is for paper accounts only.
   */
  settlePaperPosition(
    venue: VenueId,
    marketId: string,
    outcome: string,
    winPrice: number,
    answerId?: string
  ): TradeRecord | null {
    const broker = this.paperBrokers.get(venue)
    if (!broker) return null
    // A2: answerId is part of the paper position key - drop it and a
    // multi-outcome position never settles.
    const res = broker.settle(marketId, outcome, winPrice, answerId)
    if (!res) return null
    const record: TradeRecord = {
      id: `settle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      venue,
      marketId,
      marketQuestion: this.questionCache.get(marketId),
      side: 'sell',
      outcome,
      ...(answerId ? { answerId } : {}),
      amount: res.shares * winPrice,
      shares: res.shares,
      price: winPrice,
      realizedPnl: res.realizedPnl,
      ref: 'settled',
      timestamp: Date.now()
    }
    this.history.record(record)
    return record
  }

  /**
   * Executable paper BUY plan from the live order book: walk the outcome-leg
   * ask levels (YES buys lift YES asks; NO buys hit YES bids, whose NO-leg
   * price is 1 − bid), respecting the YES-leg limit, and return the VWAP and
   * available size.
   *
   * Returns undefined when the venue has no book (AMM venues fill at quote),
   * null when a book exists but nothing is executable within the limit.
   */
  private async paperBuyPlan(
    adapter: VenueAdapter,
    marketId: string,
    outcome: string,
    amount: number,
    limitYes?: number
  ): Promise<PaperFillPlan | null | undefined> {
    if (!adapter.getOrderBook) return undefined
    const ob = await adapter.getOrderBook(marketId).catch(() => undefined)
    if (!ob) return undefined
    const levels =
      outcome === 'NO'
        ? ob.bids.map((l) => ({ price: 1 - l.price, size: l.size })) // bids desc → NO asks asc
        : ob.asks
    const outcomeLimit = limitYes === undefined ? undefined : outcome === 'NO' ? 1 - limitYes : limitYes
    let spend = 0
    let shares = 0
    for (const l of levels) {
      if (l.price <= 0 || l.price >= 1) continue
      if (outcomeLimit !== undefined && l.price > outcomeLimit + 1e-9) break
      const remaining = amount - spend
      if (remaining <= 1e-9) break
      const take = Math.min(l.size, remaining / l.price)
      shares += take
      spend += take * l.price
    }
    if (shares <= 0) return null
    return { avgPrice: spend / shares, maxShares: shares }
  }

  /** Executable paper SELL plan: walk the outcome-leg bid levels for `shares`. */
  private async paperSellPlan(
    adapter: VenueAdapter,
    marketId: string,
    outcome: string,
    shares: number,
    limitYes?: number
  ): Promise<PaperFillPlan | null | undefined> {
    if (!adapter.getOrderBook) return undefined
    const ob = await adapter.getOrderBook(marketId).catch(() => undefined)
    if (!ob) return undefined
    const levels =
      outcome === 'NO'
        ? ob.asks.map((l) => ({ price: 1 - l.price, size: l.size })) // asks asc → NO bids desc
        : ob.bids
    // Min acceptable outcome-leg price from the YES-leg limit (selling NO
    // buys back the YES leg, so the YES-leg cap becomes a NO-leg floor).
    const minPrice = limitYes === undefined ? undefined : outcome === 'NO' ? 1 - limitYes : limitYes
    let proceeds = 0
    let filled = 0
    for (const l of levels) {
      if (l.price <= 0 || l.price >= 1) continue
      if (minPrice !== undefined && l.price < minPrice - 1e-9) break
      const remaining = shares - filled
      if (remaining <= 1e-9) break
      const take = Math.min(l.size, remaining)
      filled += take
      proceeds += take * l.price
    }
    if (filled <= 0) return null
    return { avgPrice: proceeds / filled, maxShares: filled }
  }

  /**
   * Portfolio snapshot with a 10-second per-mode/venue cache. Initial and
   * refresh requests share one calculation. The renderer polls on a timer and on
   * every tab switch; without the cache each switch waited for three venue
   * calls before the panel could change.
   */
  /** Snapshot for the venue in the current execution mode, or in `mode` when the UI asks for the other ledger (a view, not a switch). */
  private readonly lastLoggedBalance = new Map<VenueId, number>()

  async getPortfolio(venue: VenueId, mode: ExecutionMode = this.mode): Promise<PortfolioSnapshot> {
    const key = `${mode}:${venue}`
    const cached = this.portfolioCache.get(key)
    if (cached && Date.now() - cached.at < 10_000) return cached.value
    let pending = this.portfolioInflight.get(key)
    if (!pending) {
      pending = this.computePortfolio(venue, mode).then(value => {
        this.portfolioCache.set(key, { at: Date.now(), value })
        return value
      }).finally(() => this.portfolioInflight.delete(key))
      this.portfolioInflight.set(key, pending)
    }
    return pending
  }

  private async computePortfolio(venue: VenueId, mode: ExecutionMode): Promise<PortfolioSnapshot> {
    const adapter = this.requireAdapter(venue)

    if (mode === 'paper') {
      const broker = this.paperBrokers.get(venue)
      if (!broker) throw new Error(`No paper broker for '${venue}'`)
      const positions = await this.enrichPositions(venue, broker.getPositions())
      const positionsValue = positions.reduce((sum, p) => sum + p.shares * (p.currentPrice ?? 0), 0)
      return {
        mode: 'paper',
        account: broker.getAccount(),
        positions,
        positionValue: positionsValue,
        openOrderReserve: 0,
        openOrders: [],
        totalValue: broker.getBalance() + positionsValue,
        currency: broker.currency
      }
    }

    let live: {
      account: Awaited<ReturnType<typeof adapter.getAccount>>
      rawPositions: Awaited<ReturnType<typeof adapter.getPositions>>
      openOrders: Awaited<ReturnType<NonNullable<typeof adapter.getOpenOrders>>>
    }
    try {
      const [acct, pos] = await Promise.all([adapter.getAccount(), adapter.getPositions()])
      // Balance changes are rare events (deposits, settlements) worth a line in the log; the read itself is not.
      const prevBalance = this.lastLoggedBalance.get(venue)
      if (prevBalance === undefined || Math.abs(prevBalance - acct.balance) >= 0.005) {
        console.log(`[engine] ${venue} live account balance $${acct.balance.toFixed(2)}${prevBalance === undefined ? '' : ` (was $${prevBalance.toFixed(2)})`}`)
        this.lastLoggedBalance.set(venue, acct.balance)
      }
      live = {
        account: acct,
        rawPositions: pos,
        openOrders: adapter.getOpenOrders ? await adapter.getOpenOrders() : []
      }
    } catch (err) {
      // FIXED 2026-09-18: all three of these reads were unguarded - not just
      // getOpenOrders - so a single 429, timeout or auth blip on ANY one of
      // them rejected the whole snapshot: the portfolio panel went blank and
      // the auto-trader aborted the scan mid-cycle. Serve the last good
      // snapshot when we have one rather than fabricating a zero-equity view;
      // if there is no prior snapshot, surface the error honestly.
      const last = this.portfolioCache.get(`${this.mode}:${venue}`)
      if (last) {
        console.warn(
          `[engine] portfolio read failed for '${venue}' (${(err as Error).message}); serving last good snapshot from ${Math.round((Date.now() - last.at) / 1000)}s ago`
        )
        return last.value
      }
      throw err
    }
    const account = live.account
    const rawPositions = live.rawPositions
    const openOrders = live.openOrders
    // Kalshi already reports an authoritative aggregate portfolio value. Do
    // not issue two market requests for every position on every 15-second UI
    // refresh: 54 positions meant 108 sequential calls, minutes of "Loading",
    // and avoidable 429s. Other venues still use best-effort enrichment.
    const positions = account?.portfolioValue !== undefined ? rawPositions : await this.enrichPositions(venue, rawPositions)
    const reconstructedPositionValue = positions.reduce((sum, p) => sum + p.shares * (p.currentPrice ?? 0), 0)
    const positionValue = account?.portfolioValue ?? reconstructedPositionValue
    // Kalshi's balance is GROSS of the collateral held for resting orders
    // (checked 2026-09-06: $30.71 of resting sells while shard 0 held $8.68 and
    // the balance was up on the day). Adding the reserve to total equity double
    // counted it by that amount; it is computed for display only.
    let openOrderReserve = 0
    openOrderReserve = openOrders.reduce(
      (sum, o) => sum + o.remainingCount * (o.outcome === 'NO' ? 1 - o.yesPrice : o.yesPrice),
      0
    )
    return {
      mode: 'live',
      account,
      positions,
      positionValue,
      openOrderReserve,
      openOrders,
      totalValue: account.balance + positionValue,
      currency: adapter.currency
    }
  }

  getHistory(limit?: number, venue?: VenueId): TradeRecord[] {
    return this.history.list(limit, venue)
  }

  getHistoryStats(venue?: VenueId): HistoryStats {
    return this.history.stats(venue)
  }

  /** Aggregate realized P&L + fees from the venue's fills/settlements (live accuracy). */
  async getLivePnl(venue: VenueId): Promise<LivePnl | null> {
    // The UI refreshes this on every portfolio poll and the full paginated
    // history is many authenticated pages. Serve the cached value at once and
    // refresh it in the background once it is older than five minutes; only
    // the very first call for a venue waits.
    const cached = this.livePnlCache.get(venue)
    const now = Date.now()
    if (cached && now - cached.at < 5 * 60_000) return cached.value
    let pending = this.livePnlInflight.get(venue)
    if (!pending) {
      pending = this.computeLivePnl(venue).then(value => {
        this.livePnlCache.set(venue, { at: Date.now(), value })
        return value
      }).finally(() => this.livePnlInflight.delete(venue))
      this.livePnlInflight.set(venue, pending)
    }
    if (cached) { void pending.catch(() => undefined); return cached.value }
    return pending
  }

  private async computeLivePnl(venue: VenueId): Promise<LivePnl | null> {
    const adapter = this.registry.get(venue)
    if (!adapter) return null
    if (adapter.getAccountPnl) return adapter.getAccountPnl()
    // Venues with a settlements feed (Kalshi): realized P&L from settled markets.
    if (adapter.getSettlements) {
      // Full history: the adapter paginates. A single 200-row page silently
      // truncated the record once the account passed 200 settlements.
      const settlements = await adapter.getSettlements(Infinity)
      let realizedPnl = 0
      let fees = 0
      let wins = 0
      let losses = 0
      let flat = 0
      for (const s of settlements) {
        realizedPnl += s.realizedPnl
        fees += s.fee
        if (s.realizedPnl > 0.000001) wins++
        else if (s.realizedPnl < -0.000001) losses++
        else flat++
      }
      // A Kalshi settlement row's fee_cost is already netted in realizedPnl,
      // so only fills on markets absent from the settlement feed add fees.
      // Polymarket US settlements carry no fee (commissions are charged on
      // the trade and the venue's realized figure is gross of them), so there
      // every fill's commission counts. 2026-09-07: skipping settled markets
      // for every venue dropped all commissions on settled PolyUS contracts.
      const settlementsCarryFees = venue !== 'polymarket-us'
      const settledMarkets = new Set(settlements.map((s) => s.marketId))
      let fillCount = 0
      if (adapter.getFills) {
        const fills = await adapter.getFills(5000)
        fillCount = fills.length
        for (const f of fills) {
          if (settlementsCarryFees && settledMarkets.has(f.marketId)) continue
          fees += f.fee
          realizedPnl -= f.fee
        }
      }
      const times = settlements.map((s) => s.timestamp).filter((t) => t > 0)
      return {
        available: true,
        source: 'settlements',
        realizedPnl,
        fees,
        settlements: settlements.length,
        fills: fillCount,
        wins,
        losses,
        flat,
        fromTs: times.length ? Math.min(...times) : undefined,
        toTs: times.length ? Math.max(...times) : undefined,
        // Totals above cover the whole history; the row list crosses IPC to
        // the renderer on every poll, so cap it at the newest 1,000 rows.
        details: [...settlements].sort((a, b) => b.timestamp - a.timestamp).slice(0, 1000)
      }
    }
    // A fills feed is not automatically a realized-P&L feed. Polymarket US
    // currently omits realizedPnl on ordinary trade activities, so showing
    // $0.00 would falsely imply an authoritative break-even result.
    if (adapter.getFills) {
      const fills = await adapter.getFills(5000).catch(() => [])
      const realized = fills.filter((f) => typeof f.realizedPnl === 'number' && Number.isFinite(f.realizedPnl))
      if (realized.length === 0) {
        return {
          available: false,
          source: 'unavailable',
          unavailableReason: 'Venue fills do not include authoritative settlement P&L.',
          realizedPnl: 0,
          fees: fills.reduce((sum, f) => sum + (f.fee ?? 0), 0),
          settlements: 0,
          fills: fills.length
        }
      }
      const realizedPnl = realized.reduce((sum, f) => sum + (f.realizedPnl ?? 0), 0)
      const fees = fills.reduce((sum, f) => sum + (f.fee ?? 0), 0)
      return { available: true, source: 'fills', realizedPnl, fees, settlements: 0, fills: fills.length }
    }
    return null
  }

  /**
   * Adapter view for strategy engines that manage their own orders (quoter,
   * convergence, lead-lag, Dutch). Reads pass straight through; placeOrder
   * and sellPosition go through the engine so the operator's risk limits
   * apply and every fill lands in the shared trade history. Before this the
   * four engines called the adapter directly and were invisible to both.
   * Object.create keeps the adapter's prototype chain intact (instanceof and
   * optional-method checks still hold) while overriding the two writers.
   */
  routedAdapter(venue: VenueId, ref: string): VenueAdapter {
    const cacheKey = `${venue}|${ref}`
    const cached = this.routedCache.get(cacheKey)
    if (cached) return cached
    const adapter = this.requireAdapter(venue)
    const routed = Object.create(adapter) as VenueAdapter
    this.routedCache.set(cacheKey, routed)
    routed.placeOrder = (order: OrderRequest) => this.placeOrder({ ...order, venue, ref: order.ref ?? ref })
    routed.sellPosition = (req: SellRequest) => this.sellPosition({ ...req, venue, ref: req.ref ?? ref })
    // An amend can grow an order's worst-case cost past the stake limit just
    // like a placement can; hold it to the same bar. Size-reducing amends pass.
    if (adapter.amendOrder) {
      routed.amendOrder = (orderId: string, marketId: string, side: 'bid' | 'ask', yesPrice: number, count: number) => {
        const legCost = side === 'bid' ? yesPrice : 1 - yesPrice
        const cap = this.stakeCapFor(venue)
        if (cap > 0 && count * legCost > cap) {
          return Promise.reject(new Error(`Amend of ${(count * legCost).toFixed(2)} exceeds max stake per bet (${cap} on ${venue})`))
        }
        return adapter.amendOrder!(orderId, marketId, side, yesPrice, count)
      }
    }
    return routed
  }

  clearHistory(): void {
    this.history.clear()
  }

  /** Reset every paper broker to a fresh starting balance (for strategy testing). */
  resetPaperAccounts(): void {
    for (const adapter of this.registry.list()) {
      const broker = this.makePaperBroker(adapter.id, adapter.currency)
      broker.reset()
      this.paperBrokers.set(adapter.id, broker)
    }
    this.questionCache.clear()
  }

  private makePaperBroker(venue: VenueId, currency: string): PaperBroker {
    const starting = this.opts.paperStartingBalances?.[venue] ?? this.opts.paperStartingBalance ?? 10_000
    const statePath = this.opts.paperStateDir ? join(this.opts.paperStateDir, `paper-${venue}.json`) : undefined
    return new PaperBroker(venue, currency, starting, statePath)
  }

  private recordFill(
    venue: VenueId,
    marketId: string,
    outcome: string,
    side: 'buy' | 'sell',
    res: OrderResult,
    ref: string | undefined,
    question: string | undefined,
    answerId?: string
  ): void {
    // Nothing traded (unfilled IOC / resting order) — keep it out of history.
    if ((res.shares ?? 0) <= 0) return
    this.history.record({
      id: res.orderId,
      venue,
      marketId,
      marketQuestion: question,
      side,
      outcome,
      ...(answerId ? { answerId } : {}),
      amount: res.amount ?? 0,
      shares: res.shares ?? 0,
      price: res.avgPrice ?? 0,
      realizedPnl: res.realizedPnl ?? undefined,
      fee: res.fee ?? undefined,
      ref,
      orderId: res.orderId,
      clientOrderId: this.orderAttribution(venue, res.orderId)?.clientOrderId,
      strategyRef: this.orderAttribution(venue, res.orderId)?.ref,
      implementationVersion: this.orderAttribution(venue, res.orderId)?.version,
      timestamp: res.timestamp
    })
  }

  /**
   * Open exposure for the position cap: settled positions PLUS resting orders
   * (a resting order is a commitment the cap must see). Fails CLOSED: a failed
   * venue read used to become "no positions" and let the entry through.
   */
  private async countOpenPositions(venue: VenueId): Promise<number> {
    if (this.mode === 'paper') return this.paperBrokers.get(venue)?.getPositions().length ?? 0
    const cached = this.openPositionCountCache.get(venue)
    if (cached && Date.now() - cached.at < POSITION_COUNT_MAX_AGE_MS) {
      // Serve the count and refresh behind it; only our own orders move it between reads, and they are counted locally.
      if (Date.now() - cached.at >= POSITION_COUNT_REFRESH_MS) void this.readOpenPositionCount(venue).catch(() => undefined)
      return cached.base + (this.reservations.get(venue)?.size ?? 0)
    }
    return this.readOpenPositionCount(venue)
  }

  private reserveSlot(venue: VenueId): number {
    const token = ++this.reservationSeq
    let held = this.reservations.get(venue)
    if (!held) this.reservations.set(venue, (held = new Map()))
    held.set(token, {})
    return token
  }

  private settleSlot(venue: VenueId, token: number): void {
    const r = this.reservations.get(venue)?.get(token)
    if (r) r.settledAt = Date.now()
  }

  /** Venue read of positions plus resting orders plus journaled in-flight intents. Fails closed. One read at a time. */
  private readOpenPositionCount(venue: VenueId): Promise<number> {
    const inflight = this.openPositionCountInflight.get(venue)
    if (inflight) return inflight
    const run = this.readOpenPositionCountNow(venue).finally(() => this.openPositionCountInflight.delete(venue))
    this.openPositionCountInflight.set(venue, run)
    return run
  }

  private async readOpenPositionCountNow(venue: VenueId): Promise<number> {
    const startedAt = Date.now()
    const adapter = this.requireAdapter(venue)
    let positions: number
    try {
      positions = (await adapter.getPositions()).length
    } catch (err) {
      throw new Error(`Position cap check failed (venue positions unavailable): ${err instanceof Error ? err.message : String(err)}`)
    }
    let resting = 0
    if (adapter.getOpenOrders) {
      try {
        resting = (await adapter.getOpenOrders()).length
      } catch (err) {
        throw new Error(`Position cap check failed (open orders unavailable): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const base = positions + resting + (this.journal?.pending(venue).length ?? 0)
    this.openPositionCountCache.set(venue, { at: Date.now(), base })
    // A reservation leaves only once this read began comfortably after its order settled, so the venue shows it.
    // Anything newer, unsettled or in flight stays counted on top: an order the venue already shows may count twice,
    // which errs toward the cap, never past it.
    const held = this.reservations.get(venue)
    for (const [token, r] of held ?? []) if (r.settledAt !== undefined && r.settledAt < startedAt - RESERVATION_VISIBILITY_MS) held!.delete(token)
    return base + (held?.size ?? 0)
  }

  /** Mark positions to market: fetch current prices and compute unrealized P&L. */
  private async enrichPositions(venue: VenueId, positions: Position[]): Promise<Position[]> {
    if (positions.length === 0) return positions
    const adapter = this.requireAdapter(venue)
    const out: Position[] = []
    for (const p of positions) {
      try {
        const quote = await adapter.getPrice(p.marketId, p.answerId ?? p.outcome, p.outcome as 'YES' | 'NO')
        const enriched: Position = {
          ...p,
          currentPrice: quote.price,
          unrealizedPnl: p.avgPrice > 0 ? (quote.price - p.avgPrice) * p.shares : undefined
        }
        // Best-effort expiry/resolution metadata for the position cards.
        try {
          const mkt = await adapter.getMarket(p.marketId)
          if (mkt.closeTime !== undefined) enriched.closeTime = mkt.closeTime
          if (mkt.resolution !== undefined) enriched.resolution = mkt.resolution
        } catch {
          // some venues/paper markets have no market record — keep whatever we have
        }
        out.push(enriched)
      } catch {
        out.push(p)
      }
    }
    return out
  }

  private requireAdapter(venue: VenueId): VenueAdapter {
    const adapter = this.registry.get(venue)
    if (!adapter) throw new Error(`No adapter registered for venue '${venue}'`)
    return adapter
  }
}


