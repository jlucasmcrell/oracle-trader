// Core domain types shared across main, preload, and renderer processes.
// These are framework-agnostic and would survive a UI or shell swap.

export type VenueId = 'polymarket' | 'polymarket-us' | 'kalshi' | 'ibkr'

export type ExecutionMode = 'paper' | 'live'

export type MarketStatus = 'open' | 'closed' | 'resolved'

export type MarketOutcomeType = 'BINARY' | 'MULTIPLE_CHOICE' | 'NUMERIC' | 'OTHER'

export interface VenueMarket {
  venue: VenueId
  id: string
  question: string
  slug?: string
  description?: string
  status: MarketStatus
  /** Probability of YES, 0..1 */
  probability?: number
  volume?: number
  volume24h?: number
  liquidity?: number
  /** Kalshi exchange shard this market trades on; collateral is held PER shard. */
  exchangeIndex?: number
  /** Manifold MKT resolution value (0..1); settles at this price rather than 0/1. */
  resolutionProbability?: number
  uniqueBettorCount?: number
  outcomeType?: MarketOutcomeType
  /** Multiple-choice answers (id + text + probability each); undefined for binary. */
  outcomes?: { id: string; text: string; probability?: number }[]
  category?: string
  tags?: string[]
  createdAt?: number
  closeTime?: number
  resolutionTime?: number
  /** Bid/ask spread in probability points (0..1); undefined when no book. */
  spread?: number
  /** Venue taker-fee coefficient (0..1, e.g. 0.06 = 6%); undefined when fee-free. */
  feeRate?: number
  /** Maker-side fee coefficient. 0 on plain `quadratic` series; equals feeRate on `quadratic_with_maker_fees` (Kalshi charges makers on e.g. KXMLB/NBA/NFL since 2026-08-19). */
  makerFeeRate?: number
  /** Trading is fee-free until this ms-epoch (Kalshi fee waivers); undefined = no waiver. */
  feeWaiverUntil?: number
  /** Primary resolution rules text (truncated), when the venue exposes it. */
  rulesPrimary?: string
  /** Market can close/settle the instant its condition is met (Kalshi). */
  canCloseEarly?: boolean
  /** Order price tick size (e.g. 0.001 on Polymarket US), when exposed. */
  tickSize?: number
  /** Minimum order quantity in contracts, when exposed. */
  minTradeQty?: number
  /** Venue-specific event identifier grouping mutually-exclusive markets. */
  eventTicker?: string
  /** Recurring-series identifier (Kalshi: ticker prefix, e.g. KXXRPD). */
  seriesTicker?: string
  /** Scalar-market strike boundaries (Kalshi), when exposed by the venue. */
  floorStrike?: number
  capStrike?: number
  /** Strike comparison type (Kalshi: greater/less/between/…). */
  strikeType?: string
  resolved?: boolean
  resolution?: string
  url?: string
}

export interface PriceQuote {
  venue: VenueId
  marketId: string
  outcome: string
  /** Best executable price, 0..1 */
  price: number
  /** Probability estimate, 0..1 */
  probability: number
  timestamp: number
}

export interface AccountInfo {
  venue: VenueId
  userId: string
  username?: string
  balance: number
  /** Venue-reported marked portfolio value, excluding available cash. */
  portfolioValue?: number
  /** Kalshi: balance per exchange shard (exchange_index -> dollars). An order on a $0 shard is rejected regardless of the aggregate. */
  balanceByShard?: Record<number, number>
  currency: string
  profit?: number
  realMoney: boolean
}

export interface Position {
  venue: VenueId
  marketId: string
  marketQuestion?: string
  outcome: string
  shares: number
  avgPrice: number
  currentPrice?: number
  unrealizedPnl?: number
  /** Market close/expiry time (enriched when available). */
  closeTime?: number
  /** Final resolution (YES/NO) once the market settles. */
  resolution?: string
  /** Multi-outcome markets: WHICH answer this position is on. */
  answerId?: string
}

export interface OrderRequest {
  /** ForecastEx closing buy: recheck this held contract immediately before submission. */
  closeFrom?: string
  clientOrderId?: string
  /** Internal callback, set by the engine after IPC; called before the adapter submits. */
  onSubmit?: () => void
  venue: VenueId
  marketId: string
  outcome: string
  /** Amount of venue currency to spend */
  amount: number
  /** Max acceptable price, 0..1 (optional limit; YES-leg price on Kalshi) */
  limitPrice?: number
  /** Exact contract quantity when strategy risk must be count-bounded. Overrides amount-based sizing on supporting book venues. */
  contracts?: number
  /** Kalshi matching-engine shard already known to the caller; spares the adapter a market lookup. */
  exchangeIndex?: number
  /** Order lifetime (Kalshi V2); defaults to good_till_canceled. */
  timeInForce?: 'good_till_canceled' | 'immediate_or_cancel' | 'fill_or_kill'
  /** Rest passively as a maker order — reject instead of crossing (Kalshi post_only). */
  postOnly?: boolean
  /** Unix-seconds expiration for resting orders (Kalshi GTC + expiration_time). */
  expirationTs?: number
  /** Venue taker-fee coefficient (0..1), used to model fees in paper fills. */
  feeRate?: number
  /** Multiple-choice answer id (used instead of YES/NO on MC markets). */
  answerId?: string
  /** Arbitrary reference (e.g. a copied bet id) */
  ref?: string
  /** Optional market question for trade-history display. */
  marketQuestion?: string
}

export interface OrderResult {
  venue: VenueId
  orderId: string
  marketId: string
  outcome: string
  amount: number
  shares: number
  avgPrice: number
  status: 'filled' | 'partial' | 'open'
  /** The venue's own status word when it reports one ('resting', 'canceled', 'executed'). */
  venueStatus?: string
  paper?: boolean
  /** For sells: realized profit/loss on the closed shares. */
  realizedPnl?: number
  /** Fee paid on this fill (venue currency). */
  fee?: number
  timestamp: number
}

export interface PricePoint {
  timestamp: number
  price: number
}

export interface OrderBookLevel {
  price: number
  size: number
}

export interface OrderBook {
  venue: VenueId
  marketId: string
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
}

export interface TradeRecord {
  orderId?: string
  clientOrderId?: string
  strategyRef?: string
  implementationVersion?: string
  id: string
  venue: VenueId
  marketId: string
  marketQuestion?: string
  side: 'buy' | 'sell'
  outcome: string
  /** Multi-outcome markets only: which answer the leg is on. `outcome` carries the
   *  answer TEXT, which is readable but not a stable identity. */
  answerId?: string
  amount: number
  shares: number
  price: number
  realizedPnl?: number
  /** Fee paid (venue currency); already netted out of realizedPnl. */
  fee?: number
  ref?: string
  timestamp: number
}

export interface HistoryStats {
  /** Every fill row, entries AND exits — NOT the number of trades taken. */
  totalTrades: number
  buys: number
  sells: number
  /**
   * Completed round trips: one per closed/settled position. This is the
   * denominator winRate and realizedPnl already use, so it is the only count
   * that belongs beside them.
   */
  completedTrades: number
  totalVolume: number
  realizedPnl: number
  winRate: number
}

export interface SellRequest {
  clientOrderId?: string
  onSubmit?: () => void
  ref?: string
  venue: VenueId
  marketId: string
  outcome: string
  /** Multiple-choice answer id (used instead of YES/NO on MC markets). */
  answerId?: string
  /** Number of shares to sell; omit to close the whole position */
  shares?: number
  /**
   * YES-leg limit for the closing order (venues with books). Selling YES:
   * minimum acceptable YES price. Selling NO: maximum acceptable YES price
   * (closing NO buys the YES leg back).
   */
  limitPrice?: number
  /** Order lifetime for the closing order; venue default when omitted. */
  timeInForce?: 'good_till_canceled' | 'immediate_or_cancel' | 'fill_or_kill'
}

export interface Holder {
  userId: string
  username?: string
  name?: string
  outcome: string
  shares: number
  profit?: number
  rank: number
}

export interface Leader {
  userId: string
  username?: string
  name?: string
  /** Aggregated all-time profit across scanned markets. */
  profit: number
  /** Aggregated recent (month) profit across scanned markets. */
  monthProfit: number
  /** Number of scanned markets this user held. */
  markets: number
  rank: number
}

export interface UserPortfolio {
  userId: string
  username?: string
  investmentValue?: number
  balance?: number
  profit?: number
  dailyProfit?: number
}

export interface UserBet {
  userId: string
  id: string
  marketId: string
  outcome: string
  /** Multiple-choice answer id the bet was placed on (Manifold). */
  answerId?: string
  amount: number
  shares?: number
  probBefore?: number
  probAfter?: number
  createdAt: number
  isSold?: boolean
}

export interface MarketSearchQuery {
  term?: string
  limit?: number
  sort?: string
  status?: 'open' | 'closed' | 'resolved'
  minLiquidity?: number
  category?: string
  /** Horizon bound (ms epoch) — used by venues whose API supports date filters. */
  minCloseTime?: number
  maxCloseTime?: number
}

export interface VenueCredentials {
  apiKey?: string // Manifold
  apiKeyId?: string // Kalshi
  privateKey?: string // Kalshi RSA private key (PEM)
  [key: string]: unknown
}

/** One public trade from a venue tape (normalized). */
export interface MarketTrade {
  id: string
  yesPrice: number
  noPrice: number
  count: number
  createdTs: number
  /** Exposure the taker took: yes = bought YES (or sold NO). */
  takerOutcomeSide: 'yes' | 'no'
  /** Whether the taker crossed the book (bid = aggressive buy). */
  takerBookSide: 'bid' | 'ask'
  isBlockTrade: boolean
}

/** One OHLC candle (normalized). */
export interface MarketCandle {
  endTs: number
  open?: number
  high?: number
  low?: number
  close?: number
  bidClose?: number
  askClose?: number
  volume: number
}

/** Event-level metadata for Dutch-book / settlement logic. */
export interface EventDetails {
  eventTicker: string
  seriesTicker?: string
  title?: string
  /** Exactly one market in this event can resolve YES. */
  mutuallyExclusive: boolean
  markets: VenueMarket[]
}

/** Live underlying (settlement-source) data for an event. */
export interface LiveDataSnapshot {
  eventTicker: string
  type?: string
  /** Most recent observable value of the settlement source. */
  latest?: number
  /** Minutes since the latest observation. */
  staleMinutes?: number
  series: PricePoint[]
}

/** One executed fill reported by a venue (for accurate live P&L). */
export interface VenueFill {
  id: string
  marketId: string
  outcome: 'YES' | 'NO'
  side: 'buy' | 'sell'
  shares: number
  price: number
  fee: number
  isTaker: boolean
  /** The order this fill belongs to (where the venue reports it). */
  orderId?: string
  /** Venue-reported realized P&L for this fill (where available). */
  realizedPnl?: number
  timestamp: number
}

/** One order as reported by a venue's order list (resting-order management). */
export interface OpenOrder {
  orderId: string
  /** Caller-supplied id, when the venue echoes it (orphan detection). */
  clientOrderId?: string
  /** IBKR's permanent order id: the only id a TWS completed-order row carries besides orderRef. */
  permId?: number
  marketId: string
  /** Directional exposure the order adds when filled. */
  outcome: 'YES' | 'NO'
  /** YES-leg price of the order, 0..1. */
  yesPrice: number
  initialCount: number
  fillCount: number
  remainingCount: number
  status: 'resting' | 'canceled' | 'executed'
  createdTs?: number
  expirationTs?: number
}

/** One settled market reported by a venue (accurate realized P&L). */
export interface VenueSettlement {
  marketId: string
  result: 'YES' | 'NO'
  shares: number
  /** Gross acquisition cost across YES and NO fills. */
  cost: number
  /** Total proceeds: settlement payout plus any automatic YES/NO pairing proceeds. */
  revenue: number
  /** Final settlement payout reported by the venue, before pairing proceeds. */
  settlementRevenue?: number
  /** Proceeds returned when opposite YES/NO contracts were paired before settlement. */
  pairedRevenue?: number
  yesShares?: number
  noShares?: number
  fee: number
  realizedPnl: number
  timestamp: number
}

/** Aggregated live-account P&L pulled from a venue's fills/settlements. */
export interface LivePnl {
  /** True only when the venue exposes enough data for a defensible realized-P&L calculation. */
  available: boolean
  source: 'settlements' | 'fills' | 'account-cash' | 'cash-ledger' | 'unavailable'
  openCostBasis?: number
  pairedCash?: number
  cashDifference?: number
  unavailableReason?: string
  realizedPnl: number
  fees: number
  settlements: number
  fills: number
  wins?: number
  losses?: number
  flat?: number
  fromTs?: number
  toTs?: number
  details?: VenueSettlement[]
}
