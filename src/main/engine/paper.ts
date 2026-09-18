import type {
  AccountInfo,
  OrderRequest,
  OrderResult,
  Position,
  PriceQuote,
  SellRequest,
  VenueId
} from '../../shared/types'
import type { PaperFillPlan } from './engine'
import { JsonStore } from '../store/json'
import { kalshiOrderFeeDollars } from '../util/kalshiFee'

interface PaperPosition {
  venue: VenueId
  marketId: string
  marketQuestion?: string
  outcome: string
  /** Multiple-choice answer this position is on (keys separately per answer). */
  answerId?: string
  shares: number
  avgPrice: number
  feeRate: number
  entryFee: number
}

interface PaperState {
  balance: number
  positions: PaperPosition[]
}

/**
 * Simulates order fills against live prices without risking any funds.
 * Used whenever execution mode is "paper".
 *
 * Realism notes: fills use a caller-supplied plan (VWAP walked across the
 * live book's depth with the limit applied) when the venue has a book, so
 * size is capped by real resting liquidity; AMM venues fill at the quote.
 * Limits are honest: nothing executable within the limit means no fill.
 * Taker fees are modeled symmetrically (fee = rate × C × p × (1−p)) on
 * entry and exit; settlement pays out fee-free, matching Kalshi.
 *
 * State (balance + positions) is persisted so paper accounts survive restarts.
 */
export class PaperBroker {
  private balance: number
  private positions = new Map<string, PaperPosition>()
  private seq = 0
  private store: JsonStore<PaperState> | null = null

  constructor(
    readonly venue: VenueId,
    readonly currency: string,
    private readonly startingBalance = 10_000,
    statePath?: string
  ) {
    this.balance = startingBalance
    if (statePath) {
      this.store = new JsonStore<PaperState>(statePath, { balance: startingBalance, positions: [] })
      const saved = this.store.get()
      this.balance = saved.balance ?? startingBalance
      this.positions = new Map(saved.positions.map((p) => [this.key(p.marketId, p.outcome, p.answerId), p]))
    }
  }

  getAccount(): AccountInfo {
    return {
      venue: this.venue,
      userId: 'paper',
      username: 'Paper Account',
      balance: this.balance,
      currency: this.currency,
      profit: undefined,
      realMoney: false
    }
  }

  getPositions(): Position[] {
    return [...this.positions.values()].map((p) => ({
      venue: p.venue,
      marketId: p.marketId,
      marketQuestion: p.marketQuestion,
      outcome: p.outcome,
      answerId: p.answerId,
      shares: p.shares,
      avgPrice: p.avgPrice,
      currentPrice: undefined,
      unrealizedPnl: undefined
    }))
  }

  buy(order: OrderRequest, quote: PriceQuote, plan?: PaperFillPlan): OrderResult {
    let price: number
    let maxShares = Infinity
    if (plan) {
      // Depth-aware fill: VWAP across the book levels the engine walked, with
      // the limit already applied. Size is capped by the available depth.
      price = plan.avgPrice
      maxShares = plan.maxShares
    } else {
      // No order book on this venue (AMM): fill at the quote, but honor the
      // limit honestly — a quote beyond the limit is a no-fill, not a
      // fill-at-limit (the old behavior invented price improvement).
      price = quote.price
      if (order.limitPrice !== undefined) {
        const outcomeLimit = order.outcome === 'YES' ? order.limitPrice : 1 - order.limitPrice
        if (price > outcomeLimit + 1e-9) {
          throw new Error(`Paper: quote ${price.toFixed(3)} is beyond the limit ${outcomeLimit.toFixed(3)}`)
        }
      }
    }
    if (price <= 0) throw new Error(`Cannot buy at price ${price}`)

    const shares = Math.min(order.amount / price, maxShares)
    if (shares <= 0) throw new Error('Paper: no executable size')
    const spend = shares * price
    const fee = feeFor(this.venue, order.feeRate, shares, price)
    if (spend + fee > this.balance) throw new Error('Insufficient paper balance')
    this.balance -= spend + fee

    const key = this.key(order.marketId, order.outcome, order.answerId)
    const existing = this.positions.get(key)
    if (existing) {
      const totalShares = existing.shares + shares
      existing.avgPrice = (existing.avgPrice * existing.shares + price * shares) / totalShares
      existing.shares = totalShares
      existing.entryFee += fee
    } else {
      this.positions.set(key, {
        venue: this.venue,
        marketId: order.marketId,
        marketQuestion: order.marketQuestion,
        outcome: order.outcome,
        answerId: order.answerId,
        shares,
        avgPrice: price,
        feeRate: order.feeRate ?? 0,
        entryFee: fee
      })
    }
    this.persist()

    return {
      venue: this.venue,
      orderId: `paper-${++this.seq}`,
      marketId: order.marketId,
      outcome: order.outcome,
      amount: spend,
      shares,
      avgPrice: price,
      status: 'filled',
      paper: true,
      fee,
      timestamp: Date.now()
    }
  }

  sell(req: SellRequest, quote: PriceQuote, plan?: PaperFillPlan): OrderResult {
    const p = this.positions.get(this.key(req.marketId, req.outcome, req.answerId))
    if (!p) throw new Error('No paper position to sell')
    const price = plan?.avgPrice ?? quote.price
    if (price <= 0) throw new Error('Paper: no sell price available')
    const wanted = req.shares !== undefined ? Math.min(req.shares, p.shares) : p.shares
    const shares = Math.min(wanted, plan?.maxShares ?? Infinity)
    if (shares <= 0) throw new Error('Paper: no executable size')
    const fraction = shares / p.shares
    // Coerce fee fields: positions persisted by older builds can carry
    // null/NaN here, which would turn realizedPnl into NaN downstream.
    const sellFee = feeFor(this.venue, Number.isFinite(p.feeRate) ? p.feeRate : 0, shares, price)
    const proceeds = shares * price
    const entryFeeAlloc = (Number.isFinite(p.entryFee) ? p.entryFee : 0) * fraction
    const realizedPnl = (price - p.avgPrice) * shares - entryFeeAlloc - sellFee
    p.shares -= shares
    p.entryFee -= entryFeeAlloc
    if (p.shares <= 1e-9) this.positions.delete(this.key(req.marketId, req.outcome, req.answerId))
    this.balance += proceeds - sellFee
    this.persist()
    return {
      venue: this.venue,
      orderId: `paper-${++this.seq}`,
      marketId: req.marketId,
      outcome: req.outcome,
      amount: proceeds,
      shares,
      avgPrice: price,
      status: 'filled',
      paper: true,
      fee: sellFee,
      realizedPnl,
      timestamp: Date.now()
    }
  }

  /** Shares currently held for a market/outcome (0 when none). */
  getPositionShares(marketId: string, outcome: string, answerId?: string): number {
    return this.positions.get(this.key(marketId, outcome, answerId))?.shares ?? 0
  }

  /**
   * Settle an open paper position at a resolution value (0 or 1).
   *
   * `answerId` MUST be supplied for a multi-outcome position: the position key
   * includes it (as getPositionShares and sell already do), so omitting it looks
   * up the binary key, misses, and returns null - the stake and its payout would
   * then never be accounted at all.
   */
  settle(
    marketId: string,
    outcome: string,
    winPrice: number,
    answerId?: string
  ): { shares: number; realizedPnl: number } | null {
    const key = this.key(marketId, outcome, answerId)
    const p = this.positions.get(key)
    if (!p) return null
    const payout = p.shares * winPrice
    const realizedPnl = (winPrice - p.avgPrice) * p.shares - (Number.isFinite(p.entryFee) ? p.entryFee : 0)
    this.positions.delete(key)
    this.balance += payout
    this.persist()
    return { shares: p.shares, realizedPnl }
  }

  getBalance(): number {
    return this.balance
  }

  /** Reset to the starting balance with no positions (used by the settings reset). */
  reset(): void {
    this.balance = this.startingBalance
    this.positions.clear()
    this.persist()
  }

  private persist(): void {
    if (!this.store) return
    this.store.update({ balance: this.balance, positions: [...this.positions.values()] })
  }

  private key(marketId: string, outcome: string, answerId?: string): string {
    return `${marketId}:${outcome}${answerId ? `:${answerId}` : ''}`
  }
}

/**
 * Fee model, per venue.
 *
 * KALSHI: the quadratic fee is assessed on the ORDER total and rounded up to
 * the venue's balance precision (4 decimals - verified empirically against
 * /portfolio/fills; see util/kalshiFee.ts), so the ceil is applied to
 * contracts x price x (1 - price) as a whole, never once per contract. Passing
 * the OUTCOME price is safe: p x (1 - p) is unchanged by p -> 1 - p, so a NO
 * leg costs the same fee as the equivalent YES leg. See util/kalshiFee.ts for
 * the full derivation, and for why an un-rounded figure is wrong - the ceil
 * matters most exactly where this app trades, at small order sizes.
 *
 * ALL OTHER VENUES: symmetric continuous model, fee = rate x shares x p x (1-p),
 * unchanged.
 */
function feeFor(venue: VenueId, feeRate: number | undefined, shares: number, price: number): number {
  if (!feeRate || feeRate <= 0 || !Number.isFinite(feeRate)) return 0
  if (venue === 'kalshi') return kalshiOrderFeeDollars(feeRate, price, shares)
  return feeRate * shares * price * (1 - price)
}
