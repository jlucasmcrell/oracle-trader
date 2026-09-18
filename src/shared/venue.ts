import type {
  AccountInfo,
  EventDetails,
  Holder,
  Leader,
  LiveDataSnapshot,
  LivePnl,
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
} from './types'

/**
 * Describes what a venue adapter can actually do. Drives UI affordances and
 * whether the "live" execution mode is even available for that venue.
 */
export interface VenueCapabilities {
  /** Whether the adapter can place real orders (requires credentials). */
  liveTrading: boolean
  /** Whether the venue itself is real money (vs play money like Mana). */
  realMoney: boolean
  /** Whether other users' positions/portfolio are exposed (enables copy-trading). */
  socialExposure: boolean
}

/**
 * The single contract every venue plugs into. Add a new prediction market by
 * implementing this interface and registering it in the VenueRegistry —
 * the engine, strategies, and UI all work against it unchanged.
 */
export interface VenueAdapter {
  readonly id: VenueId
  readonly name: string
  readonly currency: string
  readonly capabilities: VenueCapabilities

  /** Initialize credentials (e.g. verify an API key). */
  init(credentials?: VenueCredentials): Promise<void>

  // ---- market data (public) ----
  searchMarkets(query: MarketSearchQuery): Promise<VenueMarket[]>
  getMarket(id: string): Promise<VenueMarket>
  /**
   * `outcome` selects WHICH contract (an answerId on multi-outcome markets,
   * else YES/NO); `side` says which DIRECTION is being priced. They are
   * separate: buying NO on answer X costs 1 − p(X), and collapsing them lets
   * both legs of one answer be charged the same price.
   */
  getPrice(marketId: string, outcome?: string, side?: 'YES' | 'NO'): Promise<PriceQuote>
  getPrices?(requests: { marketId: string; outcome: string }[]): Promise<PriceQuote[]>

  // ---- account ----
  getAccount(): Promise<AccountInfo>
  /** Account-level reconciliation where settlement deltas alone omit trading proceeds. */
  getAccountPnl?(): Promise<LivePnl>
  /** No match is not proof of rejection; callers retain an unresolved reservation. */
  findOrderByClientId?(clientOrderId: string, marketId: string, since: number): Promise<{ orderId: string } | undefined>
  getPositions(): Promise<Position[]>

  // ---- trading ----
  placeOrder(order: OrderRequest): Promise<OrderResult>
  sellPosition(req: SellRequest): Promise<OrderResult>
  /** Venues such as ForecastEx close through an opposing BUY, with entry risk checks. */
  closeAsBuy?(req: SellRequest): Promise<OrderRequest>
  /** `marketSlug` is required by Polymarket US and ignored by the other venues. */
  cancelOrder(orderId: string, marketSlug?: string): Promise<void>

  // ---- social / copy-trading (may be unsupported on some venues) ----
  getTopHolders(marketId: string, limit?: number): Promise<Holder[]>
  getUserPortfolio(userId: string): Promise<UserPortfolio>
  getUserBets(userId: string, limit?: number): Promise<UserBet[]>
  /** Aggregate top earners across liquid markets (for copy-trading discovery). */
  getLeaderboard(limit?: number): Promise<Leader[]>
  /** A user's current holdings (to detect when a master exits a position). */
  getUserHoldings(userId: string): Promise<Position[]>
  /** Historical price points for backtesting (optional; unsupported venues omit). */
  getPriceHistory?(marketId: string, limit?: number): Promise<PricePoint[]>
  /** Venue category list for UI filters (optional; unsupported venues omit). */
  getCategories?(): Promise<string[]>
  /** Current order book for a market (optional; unsupported venues omit). */
  getOrderBook?(marketId: string): Promise<OrderBook>
  /** Order books for many markets in one call (optional). */
  getOrderBooks?(marketIds: string[]): Promise<OrderBook[]>
  /** Recent public trades for a market (optional). */
  getRecentTrades?(marketId: string, limit?: number, minTs?: number): Promise<MarketTrade[]>
  /** OHLC candles for many markets (optional). */
  getCandles?(marketTickers: string[], periodMinutes: 1 | 60, startTs: number, endTs: number): Promise<Record<string, MarketCandle[]>>
  /** Event-level metadata incl. mutually_exclusive flag and leg markets (optional). */
  getEventDetails?(eventTicker: string): Promise<EventDetails>
  /** Paginated list of open events with nested markets (optional; for Dutch scanning). */
  searchEvents?(limit?: number, cursor?: string): Promise<{ events: EventDetails[]; cursor?: string }>
  /** Live settlement-source data for an event (optional). */
  getLiveData?(eventTicker: string): Promise<LiveDataSnapshot>
  /** Executed fills for accurate live P&L (optional). */
  getFills?(limit?: number): Promise<VenueFill[]>
  /** Settled markets for accurate live P&L (optional). */
  getSettlements?(limit?: number): Promise<VenueSettlement[]>
  /** Resting orders (optional; for maker-order lifecycle management). */
  getOpenOrders?(marketId?: string): Promise<OpenOrder[]>
  /** One order by venue id: filled quantity + average YES-leg price. Fill attribution for venues whose fills feed carries no order id. */
  getOrder?(orderId: string): Promise<{ fillCount: number; avgYes?: number; state?: string } | undefined>
  /** Amend a resting order in place (optional; YES-leg price, total count). */
  amendOrder?(orderId: string, marketId: string, side: 'bid' | 'ask', yesPrice: number, count: number): Promise<{ fillCount: number; avgYes: number }>
  /** Reduce a resting order's REMAINING count in place (optional). Unlike amend, a size
   *  decrease preserves queue position, so this is the safe way to shrink a stale quote
   *  without forfeiting the slot it paid for in time. `reduceTo` is the new desired
   *  REMAINING count (not total fillable). Idempotent (always reduce_to, never reduce_by). */
  decreaseOrder?(orderId: string, marketId: string, reduceTo: number): Promise<{ fillCount: number; remainingCount: number | undefined }>
  /** A resting order's queue position (contracts ahead of it at the same price/side).
   *  0 = front of queue; undefined = venue omitted the field (unknown, not front).
   *  Diagnostic only - makes the cost of repricing measurable. */
  getOrderQueuePosition?(orderId: string): Promise<number | undefined>
  /** Exchange-wide trading status (optional; gate entries during maintenance). */
  getExchangeStatus?(): Promise<{ tradingActive: boolean }>
}
