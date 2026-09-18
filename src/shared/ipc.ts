import type {
  AccountInfo,
  ExecutionMode,
  HistoryStats,
  LivePnl,
  MarketSearchQuery,
  OrderBook,
  OrderRequest,
  OrderResult,
  OpenOrder,
  Position,
  PricePoint,
  SellRequest,
  TradeRecord,
  VenueId,
  VenueMarket
} from './types'

export interface VenueStatus {
  id: VenueId
  name: string
  currency: string
  connected: boolean
  realMoney: boolean
  liveTrading: boolean
}

export interface EngineState {
  executionMode: ExecutionMode
  venues: VenueStatus[]
}

export interface PortfolioSnapshot {
  mode: ExecutionMode
  account: AccountInfo | null
  positions: Position[]
  /** Venue-authoritative position value where available; otherwise reconstructed mark. */
  positionValue: number
  /** Maximum cash committed to currently resting orders (zero in paper mode). */
  openOrderReserve: number
  /** Venue-authoritative resting orders fetched with this snapshot. */
  openOrders: OpenOrder[]
  /** Estimated total equity = available cash + position value + resting-order reserve. */
  totalValue: number
  currency: string
}




export type AutoStrategyId = 'momentum' | 'volume-spike' | 'book-imbalance' | 'cross-venue' | 'news' | 'dutch' | 'fade' | 'settlement' | 'sports-anchor' | 'flow-follow' | 'mean-reversion' | 'weather-morning' | 'consensus'

export interface AutoTraderConfig {
  enabled: boolean
  /** Run scans automatically on an interval. */
  autoPoll: boolean
  pollIntervalSeconds: number
  // ---- universe ----
  /** Universe: Kalshi markets closing within [minMinutesToClose, maxMinutesToClose]. */
  minMinutesToClose: number
  maxMinutesToClose: number
  /** Restrict the universe to one Kalshi category ('' = all). */
  category: string
  /** Cap on markets analyzed per scan (API-call budget). */
  maxMarketsPerScan: number
  /** Minimum lifetime volume (contracts) for a tradable market. */
  minVolume: number
  /** Minimum top-of-book depth (dollars) for a tradable market. */
  minLiquidity: number
  /** Maximum bid/ask spread in points (0.04 = 4¢). */
  maxSpreadPct: number
  /** Only open when YES price ∈ [minPrice, maxPrice]. */
  minPrice: number
  maxPrice: number
  /** Rules gate: composite signal score must reach this (0-100). */
  minScore: number
  // ---- momentum ----
  momentumEnabled: boolean
  /** Minutes to look back for the price change. */
  momentumWindowMinutes: number
  /** Minimum |Δprob| in points (0.03 = 3¢) to fire. */
  momentumMinMovePct: number
  // ---- mean reversion on extremes (fades what momentum follows) ----
  meanReversionEnabled: boolean
  /** Minutes to look back for the price change. */
  meanReversionWindowMinutes: number
  /** Minimum |move| in cents over the window before the fade is taken. */
  meanReversionMinMoveCents: number
  /** The market must have at least this many hours of life left to revert in. */
  meanReversionMinHoursToClose: number
  /** v2 (2026-09-08): never buy the reverting side below this price (0..1). */
  meanReversionMinEntryPrice?: number
  /** Ceiling on hours to close for mean reversion; 0 disables. The arm holds to settlement, so this is how long a slot stays occupied. */
  meanReversionMaxHoursToClose?: number
  // ---- time-of-day: the morning forecast update on overnight weather brackets ----
  weatherMorningEnabled: boolean
  /** Station-local hour the window opens (the morning model run has landed by then). */
  weatherMorningFromHour: number
  /** Station-local hour the window closes (before the high blackout at local 12:00). */
  weatherMorningToHour: number
  /** Minimum forecast-vs-price edge in cents, AFTER the taker fee, before an entry. */
  weatherMorningMinEdgeCents: number
  /** The bracket must still have this many hours of trading left. */
  weatherMorningMinHoursToClose: number
  // ---- Polymarket smart-money consensus, traded on Kalshi (pre-registered
  // 2026-09-13, docs/PREREGISTERED-polymarket-consensus.md). The signal comes
  // from the read-only hourly shadow in data/polymarket-consensus/; these
  // knobs are the pre-registered rule and are not for tuning after results.
  consensusEnabled: boolean
  /** Refuse a signal older than this; the graded edge is a lead-time effect. */
  consensusMaxSignalAgeHours?: number
  /** The Kalshi market must still have this many hours of trading left. */
  consensusMinHoursToClose?: number
  /** ...and no more than this many (default 21 days): the position must be able to settle inside the test. */
  consensusMaxHoursToClose?: number
  /** Long-horizon slots only the consensus arm may use, on top of maxLongHorizonPositions (0..4, default 2). */
  consensusExtraLongSlots?: number
  /** Refuse below this ask (0..1) — the tails eat a 6c edge whole. */
  consensusMinPrice?: number
  /** Refuse above this ask (0..1). */
  consensusMaxPrice?: number
  /** Refuse once the Kalshi ask has run this far past the Polymarket price at signal. */
  consensusMaxDriftCents?: number
  // ---- volume spike ----
  volumeSpikeEnabled: boolean
  /** Minutes of recent volume to compare against the baseline. */
  volumeSpikeWindowMinutes: number
  /** Minutes of trailing volume used as the baseline (per-minute average). */
  volumeSpikeBaselineMinutes: number
  /** Recent per-minute volume must exceed baseline by this multiple. */
  volumeSpikeMinMultiple: number
  // ---- order-book imbalance ----
  bookEnabled: boolean
  /** Operator override: let book-imbalance spend even though its lab has not met the pass bar ("enable everything", 2026-09-02). */
  bookLabBypass?: boolean
  /** Thin-market quoter (src/main/strategies/quoter.ts). */
  quoterEnabled?: boolean
  quoterCategory?: string
  quoterSeriesRegex?: string
  quoterMinSpreadCents?: number
  quoterMaxSpreadCents?: number
  quoterMaxTouchDepth?: number
  quoterMaxContracts?: number
  quoterMaxMarkets?: number
  /** Max collateral committed to currently resting quoter orders. */
  quoterMaxExposure?: number
  /** Max acquisition-cost exposure in filled weather positions plus resting quotes. */
  quoterMaxPositionExposure?: number
  quoterMaxInventory?: number
  quoterCancelMinutes?: number
  quoterMinHoursToClose?: number
  quoterMaxHoursToClose?: number
  /** While not quoting, log would-quotes and score them against later prints (zero cost). */
  quoterShadowEnabled?: boolean
  /** Skip brackets the banked running high/low has decided or is about to decide. */
  quoterRatchetGate?: boolean
  /** Quote only cities whose minute temperature index is served. */
  quoterRequireIndex?: boolean
  /** Skip the UTC hours in which the daily extreme forms. */
  quoterBlackoutEnabled?: boolean
  /** Degrees F past a boundary for "decided" (default 2). */
  quoterGuardF?: number
  /** Degrees F short of a boundary for "being decided" (default 1.5). */
  quoterNearF?: number
  /** Shrink a resting quote in place (queue-preserving /decrease) on a small adverse move (default false = shadow only). */
  quoterDecreaseEnabled?: boolean
  /** Bid depth / ask depth ratio that fires (≥1 = more bids). */
  bookMinRatio: number
  /** Minimum total top-3 depth in dollars to consider a book actionable. */
  bookMinDepth: number
  /** Minimum per-side top-3 depth in dollars (kills empty-side ratios). */
  bookMinSideDepth: number
  /**
   * Book-signal lab: log order-book snapshots + 5-min forward returns while
   * the app runs (read-only, independent of enabled). Feeds the forward
   * validation of the imbalance signal — no historical order books exist.
   */
  bookLogging: boolean
  // ---- cross-venue (Polymarket leads Kalshi) ----
  crossVenueEnabled: boolean
  /** Minimum |Kalshi − Polymarket| gap in points to fire. */
  crossVenueMinGapPct: number
  /** Minimum question similarity (0..1) for a cross-venue match. */
  crossVenueMinSimilarity: number
  // ---- news headlines ----
  newsEnabled: boolean
  /** RSS topics polled for short-term headlines. */
  newsTopics: string[]
  /** Minimum headline↔market question similarity (0..1). */
  newsMinSimilarity: number
  // ---- Dutch book (within-Kalshi, mutually-exclusive events) ----
  dutchEnabled: boolean
  /** Fire when Σ of YES bids across legs exceeds 1 + this (0.03 = 3¢). */
  dutchMinOverSum: number
  dutchMaxLegs: number
  /** Allow live multi-leg Dutch execution (one-sided risk window). */
  dutchLiveEnabled: boolean
  // ---- T-5 KXBTCD convergence micro-live probe ----
  /** Collect/evaluate the pre-registered hourly BTC convergence rule. */
  convergenceEnabled?: boolean
  /** Permit tiny live orders independently of the global LIVE arm. */
  convergenceLiveEnabled?: boolean
  /** Provisional probability used only for the executable edge gate. */
  convergenceModeledWinProbability?: number
  /** Maximum filled convergence events per UTC day. */
  convergenceMaxDailyTrades?: number
  // ---- favorite-longshot fade (NO on longshots) ----
  fadeEnabled: boolean
  fadeMaxPrice: number
  fadeMinPrice: number
  /**
   * Also trade the mirror side: buy YES at 1−fadeMaxPrice … 1−fadeMinPrice
   * (there the cheap longshot is the NO side — same calibrated bias, same
   * lottery-buyer counterparty). Favorite-side evidence is thinner, so its
   * modeled edge uses double the calibration padding.
   */
  fadeFavoritesEnabled: boolean
  /**
   * Only fade categories where the favorite-longshot bias is measured to
   * exist (353M-trade 2026 study): blocks crypto/finance/entertainment and
   * weather <48h. Strictly removes entries; removals are shadow-graded in
   * the veto counterfactual ledger.
   */
  fadeCategoryFilterEnabled: boolean
  /**
   * Block groups the counterfactual ledger has overruled — the study is the
   * prior, this account's own settled results are the evidence.
   */
  fadeCategoryExceptions: string[]
  /** Sports devig shadow: log sharp-anchor gaps vs Kalshi sports (never trades). */
  sportsShadowEnabled: boolean
  /** The Odds API key (free tier suffices for the shadow cadence). */
  oddsApiKey: string
  /** Metaculus API token (metaculus.com account settings). Feeds the Metaculus shadow anchor script; never trades. */
  metaculusApiKey?: string
  /** Monthly credit allowance of The Odds API plan (free 500); the poller paces itself to it. */
  oddsApiCreditsPerMonth?: number
  /**
   * Maintain a live WebSocket book cache alongside REST polling. Shadow
   * only: every REST fetch grades the socket's books, and nothing trades
   * off them until the agreement record justifies it.
   */
  wsEnabled: boolean
  /** Apply TP/SL exits to fade trades instead of holding to settlement.
   * Hold-to-settle pays the spread once; early exit pays it twice. */
  fadeExitEnabled: boolean
  /**
   * How fade entries execute in LIVE mode. 'taker' crosses the spread with an
   * IOC (pays spread + taker fee). 'maker' rests a post-only sell-YES inside
   * the spread until filled or expiry — better price and zero fee on standard
   * quadratic series; the cost is that some entries never fill. Paper mode
   * always simulates taker (resting fills can't be simulated honestly).
   */
  fadeEntryMode: 'taker' | 'maker'
  /**
   * Minimum modeled edge (cents/contract, after fee and at the executable
   * price) for a fade entry. Edge = (yesExec − calibratedYesRate)×100 − fee¢,
   * with the calibrated rate a padded upper bound from the historical
   * calibration (docs/validation-results.md).
   */
  fadeMinEdgeCents: number
  /**
   * Fade fires only on markets at least this many minutes from close (upper
   * bound is the universe's maxMinutesToClose). The calibration's entry
   * study measured T−1h entries; below ~60 min extreme prices are more often
   * simply correct, so lowering this trades outside the validated evidence.
   */
  fadeMinHorizonMinutes: number
  // ---- settlement-source convergence (experimental) ----
  settleEnabled: boolean
  /** Allow settlement-convergence to execute with REAL money (it is a paper experiment until proven). */
  settleLiveEnabled: boolean
  /** |index − strike| / strike must exceed this % to fire. */
  settleMinMarginPct: number
  /** Only fire within this many minutes of close. */
  settleMaxMinutesToClose: number
  // ---- sizing & risk ----
  /** USD staked per trade. */
  amountPerTrade: number
  /** Hard cap on any single stake as a % of current balance (0 = no cap). */
  maxBalancePct: number
  maxOpenPositions: number
  /**
   * Of the open-position slots, at most this many may be held by trades
   * settling MORE than 24h out (0 = no cap). Long-dated exotics carry fat
   * per-trade edges but terrible edge-per-day — without this cap they
   * crowd out the intraday rotation the short-trade setup exists for.
   */
  maxLongHorizonPositions: number
  /**
   * Positions per risk-bearing underlying (asset or weather station).
   * Kalshi splits one asset across series — KXSOLE and KXSOLD are both SOL —
   * so the per-event cap alone cannot see the concentration. 0 disables.
   */
  maxPerUnderlying: number
  /** Halt NEW entries; exits, settlement, and order management continue. */
  stopEntry: boolean
  maxDailyTrades: number
  /**
   * Drawdown kill-switch: when today's realized loss reaches this % of the
   * current balance, stop OPENING positions (exits keep managing) and drop
   * the LIVE arm so re-enabling is a manual decision. 0 = disabled.
   */
  maxDailyLossPct: number
  maxLlmPerScan: number
  /** Ask a frontier model the SAME hunch prompt, to a separate ledger, for the same pre-registered gate. */
  hunchChallengerEnabled?: boolean
  /** The challenger. Default openai/gpt-5.6-sol - the model whose no-skill verdict as a CRITIC is already measured. */
  hunchChallengerModel?: string
  /** Hard ceiling on challenger calls per UTC day. It is a paid frontier model; this is the whole cost control. */
  hunchChallengerMaxPerDay?: number
  /** Hard ceiling on PAID critic calls per UTC day. The free path failing must not become an unbounded spend. */
  intelligenceMaxPaidPerDay?: number
  // ---- exits ----
  /** Exit at this % profit on the position value (0 = disabled). */
  takeProfitPct: number
  /** Exit at this % loss on the position value (0 = disabled). */
  stopLossPct: number
  /** Close every open position this many minutes before market close. */
  exitMinutesBeforeClose: number
  /** Close any position held longer than this (0 = disabled). */
  maxHoldMinutes: number
  /** Exit when price moves against entry by this many points (0 = disabled). */
  reversalExit: boolean
  reversalExitPct: number
  // ---- vetting ----
  /** rules = deterministic gate; llm = rules + LLM final gate. */
  vetMode: 'rules' | 'llm'
  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
  /** DeepSeek reasoning control (ignored for other providers). */
  llmThinking: 'default' | 'adaptive' | 'enabled' | 'disabled'
  /** Oracle Intelligence Engine: shadow records decisions; veto may only block, never redirect/resize. */
  intelligenceEnabled?: boolean
  intelligenceMode?: 'off' | 'shadow' | 'veto'
  intelligencePrimaryModel?: string
  intelligenceSecondaryModel?: string
  intelligenceFallbackModel?: string
  intelligenceMinEdgeCents?: number
  // ---- safety ----
  /** Extra explicit switch for real-money auto-execution (global mode must also be live). */
  liveArmed: boolean
  /** Scan and report only — never place orders, even paper. */
  dryRun: boolean
  /**
   * Push-alert webhook (Discord webhook URL or an ntfy/Pushover-style POST
   * endpoint). Fired on: kill-switch trip, live order errors, stalled scan
   * loop, and the daily P&L summary. Empty = alerts off.
   */
  alertWebhookUrl: string
  // ---- automation ----
  /** Promotion ladder: evaluate each strategy's pre-registered gate on a timer and move it between stages itself. */
  ladderEnabled?: boolean
  /** Nightly LLM strategy review (files under userData/reviews). */
  nightlyReviewEnabled?: boolean
  /** UTC hour after which the day's review runs (default 6). */
  nightlyReviewHourUtc?: number
  /** Let the review apply bounded numeric parameter changes to NON-live strategies. */
  reviewAutoApplyParams?: boolean
  /** Also allow the review's bounded parameter changes on LIVE strategies (default true since 2026-09-06). */
  reviewAutoApplyLive?: boolean
  /**
   * 'trade-small' (default): every tested strategy goes to tiny-live real-money
   * tests as soon as the arm and collateral allow, with the -$5 stop and the
   * significance demotion as the safety net; after `ladderMaxDemotionsBeforeGate`
   * stops the cool-down grows to 14 days, doubling per stop (max 56), and a
   * pre-registered gate can still re-enter it sooner. Nothing is dead for good.
   * 'prove-first': shadow/paper until the gate passes.
   */
  ladderMode?: 'prove-first' | 'trade-small'
  ladderMaxDemotionsBeforeGate?: number
  /** Max dollars the ladder may move onto shard 0 per promotion so weather strategies can trade (0 = never move collateral). */
  ladderAutoAllocateUsd?: number
  /** Per-strategy stake multiplier set by the ladder's checkpoint scale-up (1 = amountPerTrade). */
  strategySizeMult?: Record<string, number>
  /** Contracts per BTC convergence trade (the ladder sets 1, 2, 4). */
  convergenceMaxContractsPerTrade?: number
  /** Lead-lag live sweeps (the ladder switches this on for its micro test). */
  leadLagLiveEnabled?: boolean
  /** Contracts per lead-lag sweep (the ladder sets 1, 2, 4). */
  leadLagMaxContractsPerOrder?: number
  /** Dollar ceiling on one lead-lag sweep. Was absent here, so the value in the config file was inert and
   * the trader hard-coded 15 instead. */
  leadLagMaxCapitalSpend?: number
  /** Lead-lag poll interval, ms (default 10000, floor 5000). Read at start; a change needs a restart. */
  leadLagPollIntervalMs?: number
  /** Widest Polymarket book, in cents, a pair may be compared on (default 5). */
  leadLagMaxSpreadCents?: number
  /** Filled contracts per Kalshi ticker per 15-minute window (default 3 x per-order). */
  leadLagMaxContractsPerWindow?: number
  /** Filled spend, dollars, across all tickers per 15-minute window (default 40). */
  leadLagMaxSpendPerWindow?: number
  /** Coins the ladder has judged: full size and pooled evidence. Default BTC/ETH. Promote by editing this. */
  leadLagProvenCoins?: string[]
  /** Coins scanned and eligible for lead-lag trading. Defaults to every supported coin. */
  leadLagCoins?: string[]
  /** Contracts per sweep for an unproven coin (default 2, max 4). */
  leadLagNewCoinContracts?: number
  /** Coins that may be swept in the same direction in one 15-minute window (default 2). */
  leadLagMaxCoinsPerDirectionPerWindow?: number
  /** Signal strategies that rest post-only inside the spread instead of crossing (fade keeps fadeEntryMode). */
  makerStrategies?: string[]
  /** Weather quoter: quote around the NWS-forecast fair value instead of the midpoint (default true). */
  quoterFairValueEnabled?: boolean
  /** Weather quoter: half-spread in cents around the fair value (default 2). */
  quoterFairMarginCents?: number
  /** Sports sharp-anchor: trade Kalshi against the devigged sportsbook consensus (needs The Odds API key). */
  sportsAnchorLiveEnabled?: boolean
  /** Minimum |Kalshi mid − consensus fair| in cents to act on (default 3). */
  sportsAnchorMinGapCents?: number
  /** Flow-follow: follow unusually large or one-sided taker flow (the ladder switches it on). */
  flowFollowEnabled?: boolean
  /** A print of at least this many contracts (default 25) ... */
  flowMinLargestCount?: number
  /** ... and this multiple of the window's median print (default 5) counts as informed flow. */
  flowSizeMultiple?: number
  /** One-sided streams need at least this many dollars behind them (default 20). */
  flowMinNotional?: number
  /** Weather quoter: pull quotes while informed flow hits the market (default true). */
  quoterFlowGate?: boolean
  /** Daily kill: settlements of positions first entered before this time (ms) do not count toward today's trigger. */
  killEpochTs?: number
}

export interface AutoSignal {
  id: string
  strategy: AutoStrategyId
  marketId: string
  /** Underlying event grouping (correlation cap: one position per event). */
  eventTicker?: string
  question: string
  outcome: 'YES' | 'NO'
  /** Current YES probability. */
  price: number
  closeTime?: number
  /** Composite 0-100 score. */
  score: number
  /** Model confidence 0..1. */
  confidence: number
  /** Per-strategy metrics for display. */
  details: Record<string, number | string>
  /** Venue taker-fee coefficient (0..1), for paper cost modeling. */
  feeRate?: number
  makerFeeRate?: number
  /** For Dutch-book groups: the leg tickers to buy NO on. */
  groupLegs?: string[]
  aiVerdict?: 'approve' | 'veto'
  aiConfidence?: number
  aiReason?: string
  executed: boolean
  executedAt?: number
  error?: string
}

export interface AutoOpenTradeLeg {
  marketId: string
  outcome: string
  shares: number
  amount: number
  entryPrice: number
}

export interface AutoOpenTrade {
  id: string
  marketId: string
  /** Underlying event grouping (correlation cap). */
  eventTicker?: string
  question?: string
  outcome: string
  shares: number
  amount: number
  entryPrice: number
  strategy: string
  createdAt: number
  closeTime?: number
  /** Multi-leg (Dutch) trades carry their legs. */
  legs?: AutoOpenTradeLeg[]
  lastPrice?: number
  pnlPct?: number
  /** Failed close attempts so far (drives the escalating exit ladder). */
  exitAttempts?: number
  /** Modeled P(this side wins) at entry — graded at settlement (calibration ledger). */
  modeledWinProb?: number
  /** Our side's mid at entry — the CLV/markout reference. */
  entrySideMid?: number
  /** Latest observed side mid (the pre-settlement freeze for CLV). */
  lastSideMid?: number
  lastSideMidAt?: number
  /** Side-mid move ¢ measured once ≥5 min after entry (adverse-selection meter). */
  markout5mCents?: number
  /** 0–167, local time at entry — liquidity/edge patterns by hour-of-week. */
  hourOfWeek?: number
  /** Fee coefficient charged on this fill (taker rate, or the series maker rate for maker fills). Used to grade net cents. */
  feeRate?: number
  /** Exit-ledger key when it differs from `strategy`: a stage change detaches the trades it inherited under `<strategy>:pre-<stamp>`, so a new stage is judged only on trades it opened. */
  perfKey?: string
  /** Last time the venue was asked about this market and answered "not resolved yet" — lets the ledger audit tell a creator who has not resolved from a settlement path of ours that has broken. */
  venueUnresolvedAt?: number
}

/** A resting maker order awaiting fill (fade maker-mode entries, live only). */
export interface AutoPendingOrder {
  orderId: string
  marketId: string
  /** Underlying event grouping (correlation cap). */
  eventTicker?: string
  question?: string
  strategy: string
  outcome: 'YES' | 'NO'
  /** YES-leg price the order rests at. */
  yesPrice: number
  count: number
  /** Contracts already promoted to an open trade from partial fills. */
  promoted: number
  /** Maker fee coefficient for the eventual fill (0 on plain quadratic series). */
  makerFeeRate?: number
  createdAt: number
  closeTime?: number
  /** Unix-seconds expiration sent with the order. */
  expirationTs: number
  /** Modeled P(win) carried through to the promoted trade (calibration ledger). */
  modeledWinProb?: number
  /** Carried to the promoted trade: exits record under this key instead of `strategy` (see AutoOpenTrade.perfKey). */
  perfKey?: string
}

/** One calibration bucket: predicted-probability range vs realized outcomes. */
export interface CalibBucket {
  lo: number
  hi: number
  n: number
  wins: number
  probSum: number
}

/** Forward calibration of the bot's own entries + counterfactual veto grading. */
export interface CalibStats {
  /** netCents = mean net cents per contract after fees over graded settlements (the base-rate-proof number); netCiLo/Hi = event-clustered 95% interval. */
  byStrategy: Record<string, { n: number; brier: number; buckets: CalibBucket[]; netCents?: number; netN?: number; netSum?: number; netSq?: number; byDay?: Record<string, { n: number; sum: number }>; netEvents?: number; netDays?: number; netCiLo?: number; netCiHi?: number }>
  /** Vetoed signals currently being watched to resolution. */
  vetoWatching: number
  /** Graded vetoes: how often the vetoed trade would have won, and its est. P&L. */
  vetoes: { graded: number; wouldHaveWon: number; estPnlCents: number }
  /** Same ledger split by veto reason ('llm', 'category:<group>'). */
  vetoesByReason?: Record<string, { graded: number; wouldHaveWon: number; estPnlCents: number }>
}

export interface AutoBookStats {
  observations: number
  /** Fraction of 5-min forward moves in the predicted direction. */
  hitRate: number
  /** Mean forward move in the predicted direction, cents. */
  meanMoveCents: number
  yesSignals: number
  noSignals: number
  /** Internal accumulators. */
  hits: number
  sumMove: number
  lastLoggedAt?: number
}

export interface AutoPerf {
  trades: number
  wins: number
  losses: number
  winRate: number
  realizedPnl: number
}

/** Per-strategy slice of the performance ledger (the keep/kill evidence). */
export interface StrategyPerf {
  trades: number
  wins: number
  losses: number
  realizedPnl: number
  /** Closing-line-value sum (¢, side terms) — converges to skill in days, not months. */
  clvSum?: number
  clvN?: number
  /** Sum of squares of the same, so the fast meter can carry a confidence band and not only a mean. */
  clvSq?: number
  /**
   * How many observations `clvSq` actually covers. It began accumulating later than `clvSum`/`clvN`, so on
   * any arm with older history the sum of squares is short and every variance derived from the triple comes
   * out too small (measured: SE understated 1.4x-2.1x; flow-follow's went arithmetically impossible).
   * A band may only be computed when this equals `clvN`.
   */
  clvSqN?: number
  /** 5-minute post-entry markout sum (¢) — the adverse-selection meter. */
  markoutSum?: number
  markoutN?: number
  markoutSq?: number
  /** How many observations `markoutSq` covers; see `clvSqN`. A band needs this to equal `markoutN`. */
  markoutSqN?: number
  /**
   * Exits that produced NO markout, because they closed before the five-minute mark. They are not missing
   * at random: measured across 179 exits, the ones without a markout averaged -$0.354 against +$0.041 for
   * the ones with, so an arm that exits fast is judged only on the trades that survived. Coverage =
   * markoutN / (markoutN + markoutMissingN).
   */
  markoutMissingN?: number
}

export interface AutoStatus {
  running: boolean
  liveArmed: boolean
  dryRun: boolean
  signals: AutoSignal[]
  openTrades: AutoOpenTrade[]
  /** Resting maker orders awaiting fill (live fade maker mode). */
  pendingOrders?: AutoPendingOrder[]
  dailyTrades: number
  dailyDate: string
  scans: number
  lastScanAt?: number
  lastScanMs?: number
  approved: number
  vetoed: number
  executed: number
  bookStats?: AutoBookStats
  /** Closed-trade performance record (wins/losses/win-rate/net P&L). */
  perf?: AutoPerf
  /** Same ledger split by strategy — the keep/kill decision data. */
  perfByStrategy?: Record<string, StrategyPerf>
  /** Today's realized P&L (drives the drawdown kill-switch). */
  dailyRealizedPnl?: number
  /** True when the drawdown kill-switch has halted new entries today. */
  killSwitchTripped?: boolean
  /** Today's realized P&L per the VENUE's settlements (covers every engine, not just this trader's exits). */
  venueDailyRealized?: number
  venueDailyDate?: string
  venueDailySettlements?: number
  /** Which ledger the kill switch is reading: 'venue' in live mode, 'local' in paper. */
  killSource?: 'venue' | 'local'
  /** Exchange trading paused (weekly maintenance) — every engine holds. */
  exchangePaused?: boolean
  /** Promotion ladder: each tested strategy's stage, gate progress and last transition. */
  ladder?: {
    enabled: boolean
    mode?: string
    lastRunAt?: number
    lastPromotionAt?: number
    note?: string
    strategies: {
      id: string
      stage: string
      since: number
      lastEval?: number
      lastVerdict?: string
      cooldownUntil?: number
      demotions?: number
      operatorHold?: boolean
      notch?: number
      lastCheckpoint?: number
      history: { at: number; from: string; to: string; reason: string }[]
    }[]
  }
  /** Most recent nightly LLM review. */
  lastReview?: { at?: number; date?: string; summary?: string; applied?: number; skipped?: number; error?: string; model?: string }
  /** Thin-market quoter status. */
  quoter?: QuoterStatus
  /** Forward calibration of entries + counterfactual veto grading. */
  calib?: CalibStats
  /** Live-socket book cache health and its agreement record vs REST. */
  wsStats?: {
    connected: boolean
    attempts: number
    reconnects: number
    frames: number
    snapshots: number
    deltas: number
    gaps: number
    liveBooks: number
    compared: number
    agreed: number
    maxDiffCents: number
    lastError?: string
    guardTripped?: string
    convention?: string
  }
  /** Sports sharp-anchor shadow ledger (gap evidence, never trades). */
  sportsShadow?: {
    n: number
    matched: number
    polls: number
    sumGapCents: number
    sumAbsGapCents: number
    lastPollAt?: number
    lastError?: string
    sgoPolls?: number
    sgoObjects?: number
    sgoMatched?: number
    sgoLastPollAt?: number
    sgoLastNotice?: string
    sgoLastError?: string
    sgoBudgetMonth?: string
    sgoMonthlyObjects?: number
    sgoTracked?: Record<string, {
      eventID: string
      leagueID: string
      startsAt: number
      gradedAt?: number
    }>
    sgoTargetPolls?: number
    sgoFreshBooks?: number
    sgoStaleBooksExcluded?: number
    sgoGraded?: number
    sgoBrierSum?: number
    sgoClvN?: number
    sgoClvSumCents?: number
    sgoFinalized?: number  }
  lastError?: string
}

export interface AutoScanResult {
  scanned: number
  candidates: number
  approved: number
  executed: number
  errors: string[]
}

/** Result of the panel's "Test AI" button: a sample candidate through the gate. */
export interface AutoVetTest {
  ok: boolean
  verdict?: {
    approve: boolean
    direction: 'YES' | 'NO'
    confidence: number
    reason: string
    impliedProb?: number
    expectedEdgeCents?: number
  }
  error?: string
}

// ---- mini multi-venue auto-trader (Manifold · Polymarket US) ----

export interface MiniAutoConfig {
  /** Only fade categories where the bias is measured to exist (see classify.ts). */
  fadeCategoryFilterEnabled: boolean
  /** Block groups the counterfactual ledger has overruled (see classify.ts). */
  fadeCategoryExceptions: string[]
  /** Positions per risk-bearing underlying (asset or weather location). 0 disables. */
  maxPerUnderlying: number
  /** Stake ceiling as a % of account equity (cash + open positions). 0 disables. */
  maxBalancePct: number
  /** Apply TP/SL + pre-close exit to fades instead of holding to settlement. */
  fadeExitEnabled: boolean
  enabled: boolean
  autoPoll: boolean
  pollIntervalSeconds: number
  /** Venue-currency amount per trade (M$ on Manifold, USD on Polymarket US). */
  amountPerTrade: number
  maxOpenPositions: number
  maxDailyTrades: number
  /**
   * Venue-wide daily realized-loss brake in venue currency; 0 disables (and
   * Manifold, being play money, leaves it at 0). New entries halt for the rest
   * of the UTC day once the day's realized loss reaches it; exits and
   * settlement keep running, and it clears itself at 00:00Z.
   */
  maxDailyLossDollars: number
  fadeEnabled: boolean
  fadeMaxPrice: number
  fadeMinPrice: number
  /** Also back favorites at 1−fadeMaxPrice … 1−fadeMinPrice (mirror of the longshot fade). */
  fadeFavoritesEnabled: boolean
  /**
   * LIVE entry style on venues with an order book (Polymarket US): 'maker'
   * rests a post-only limit inside the spread — the maker fee there is a
   * REBATE, flipping fee sign entirely; 'taker' crosses immediately. Paper
   * always simulates taker. Ignored on AMM venues (Manifold).
   */
  fadeEntryMode: 'taker' | 'maker'
  /** Minimum venue-reported market liquidity (M$ on Manifold); skipped when the venue doesn't report it. */
  fadeMinLiquidity: number
  /** Minimum unique bettors (Manifold) — filters creator-resolved insider markets nobody trades. */
  fadeMinBettors: number
  /** Max bid/ask spread in cents for fade entries on venues with an order book. */
  fadeMaxSpreadCents: number
  /** Min top-3 dollar depth PER SIDE for fade entries on venues with an order book. */
  fadeMinSideDollars: number
  minMinutesToClose: number
  maxHoursToClose: number
  /** Polymarket US one-contract passive maker research arm. */
  microMakerEnabled: boolean
  microMakerMaxMarkets: number
  microMakerMinSpreadCents: number
  microMakerMaxSpreadCents: number
  microMakerMinSideDollars: number
  microMakerMinMidPrice: number
  microMakerMaxMidPrice: number
  microMakerMinHoursToClose: number
  microMakerCancelMinutes: number
  bookEnabled: boolean
  /** Per-strategy stake multiplier set by the ladder's checkpoint scale-up (1 = amountPerTrade). */
  strategySizeMult?: Record<string, number>
  /** Micro-maker rests a bid AND an offer per market (default true); false = one hashed side. */
  microMakerTwoSided?: boolean
  /** Polymarket US temperature markets priced from the NWS forecast (maker only). */
  weatherFairEnabled?: boolean
  /** Minimum |market − forecast fair| in cents to rest an order (default 3). */
  weatherFairMarginCents?: number
  /** Operator override: let book-imbalance spend even though its lab has not met the pass bar ("enable everything", 2026-09-02). */
  bookLabBypass?: boolean
  bookMinRatio: number
  bookMinDepth: number
  bookMinSideDepth: number
  takeProfitPct: number
  stopLossPct: number
  exitMinutesBeforeClose: number
  maxHoldMinutes: number
  dryRun: boolean
  liveArmed: boolean
}

export interface MiniPerf {
  trades: number
  wins: number
  losses: number
  winRate: number
  realizedPnl: number
}

export interface MiniStatus {
  venue: VenueId
  running: boolean
  dryRun: boolean
  liveArmed: boolean
  openTrades: AutoOpenTrade[]
  /** Resting maker orders awaiting fill (live maker mode). */
  pendingOrders?: AutoPendingOrder[]
  dailyTrades: number
  scans: number
  executed: number
  lastScanMs?: number
  perf?: MiniPerf
  /** Per-strategy split of the same counters, plus the entry-quality meters (round 69). */
  perfByStrategy?: Record<string, StrategyPerf>
  lastError?: string
}

export interface MiniScanResult {
  venue: VenueId
  scanned: number
  candidates: number
  executed: number
  errors: string[]
}

export interface BacktestParams {
  venue: VenueId
  marketId: string
  buyBelow: number
  sellAbove: number
  amountPerTrade: number
  startBalance: number
}

export interface BacktestResult {
  venue: VenueId
  marketId: string
  points: number
  trades: number
  startBalance: number
  endBalance: number
  returnPct: number
  winRate: number
  realizedPnl: number
  maxDrawdownPct: number
  priceSeries: PricePoint[]
}

export interface NewsItem {
  title: string
  source: string
  url: string
  publishedAt: number
}

export interface ArbOpportunity {
  venueA: VenueId
  marketAId: string
  questionA: string
  probA: number
  venueB: VenueId
  marketBId: string
  questionB: string
  probB: number
  spread: number
  similarity: number
}

export interface ResearchResult {
  topic: string
  news: NewsItem[]
  byVenue: { venue: VenueId; markets: VenueMarket[] }[]
  opportunities: ArbOpportunity[]
}

export interface RiskLimits {
  /** Max venue-currency per single order (0 = unlimited). */
  maxStakePerBet: number
  /**
   * Per-venue override of maxStakePerBet, in that venue's currency. Exists because the global number is
   * "venue-currency": 10 means $10 on Kalshi and 10 mana on Manifold, and raising it for the play-money
   * venue must not raise the real-money cap. Absent venues use the global.
   */
  maxStakePerBetByVenue?: Partial<Record<VenueId, number>>
  /** Max number of open positions (0 = unlimited). */
  maxOpenPositions: number
}

export interface ManifoldConnection {
  connected: boolean
  username?: string
  balance?: number
  error?: string
}

export interface KalshiConnection {
  connected: boolean
  balance?: number
  error?: string
}

export interface SettingsView {
  executionMode: ExecutionMode
  hasManifoldKey: boolean
  manifoldUsername?: string
  manifoldBalance?: number
  hasKalshiKey: boolean
  kalshiBalance?: number
  /** Kalshi adapter is pointed at the DEMO exchange (separate creds, mock funds). */
  kalshiDemo: boolean
  /** Demo-exchange credentials are saved (separate from production). */
  hasKalshiDemoKey: boolean
  hasPolymarketUsKey: boolean
  polymarketUsBalance?: number
  riskLimits: RiskLimits
}

export interface IbkrGatewayStatus {
  connected: boolean
  port?: number
  mode?: 'live' | 'paper'
  message: string
}

/** The surface exposed to the renderer via contextBridge (window.api). */

export interface DutchOpportunityLeg {
  ticker: string
  title: string
  outcome: 'YES' | 'NO'
  price: number
  availableSize: number
}

export interface DutchOpportunity {
  ts: string
  eventTicker: string
  seriesTicker: string
  category: string
  title: string
  numLegs: number
  hasOther: boolean
  kind: 'buy-all-yes' | 'buy-all-no'
  sumPrice: number
  feeCents: number
  netEdgeCents: number
  maxContracts: number
  legs: DutchOpportunityLeg[]
}

export interface DutchBookStatus {
  enabled: boolean
  liveEnabled: boolean
  active: boolean
  scannedEvents: number
  exclusiveChecked: number
  opportunitiesFound: number
  executedBaskets: number
  lastScanAt?: number
  lastOpportunity?: DutchOpportunity | null
  note: string
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

export interface LeadLagDislocation {
  ts: string
  underlying: string
  polyMarketId: string
  kalshiTicker: string
  polyPrice: number
  kalshiPrice: number
  dislocationCents: number
  suggestedAction: 'BUY_KALSHI_YES' | 'BUY_KALSHI_NO'
  clearsFees: boolean
  executed: boolean
}

export interface LeadLagStatus {
  enabled: boolean
  liveEnabled: boolean
  active: boolean
  dislocationsLogged: number
  tradesExecuted: number
  lastDislocation?: LeadLagDislocation | null
  lastScanAt?: number
  note: string
}

export interface QuoterStatus {
  enabled: boolean
  active: boolean
  note: string
  candidates: number
  quoting: number
  resting: number
  /** Total filled-position plus resting-order acquisition-cost exposure. */
  exposure: number
  positionExposure: number
  /** Includes closed weather positions awaiting venue settlement. */
  accountingPositionExposure: number
  restingExposure: number
  restingBudget: number
  totalExposureCap: number
  inventory: number
  placed: number
  amended: number
  canceled: number
  filled: number
  lastTick?: number
  lastError?: string | null
  blockedReason?: string | null
  /** Complementary orders rejected because paired acquisition cost exceeds 98c. */
  lossLockBlocks: string[]
  /** Fills attributed from the venue's fills feed by order id. */
  ledgerFills?: number
  /** Candidates removed by each gate on the last tick. */
  gates?: { ratchet: number; blackout: number; noIndex: number }
  /** Shadow meter: would-quotes logged, proxy fills, mean 15-minute markout (cents), expiries, active. */
  shadow?: { quotes: number; proxyFills: number; markoutN: number; markoutMeanCents: number; expired: number; active: number }
  /** Weather events with a banked running extreme. */
  indexEvents?: number
}

export interface QuantStatus {
  dutch: DutchBookStatus
  convergence: CryptoConvergenceStatus
  leadLag: LeadLagStatus
  quoter: QuoterStatus
}

export interface Api {
  quant: {
    getStatus(): Promise<QuantStatus>
  }
  engine: {
    getState(): Promise<EngineState>
    setExecutionMode(mode: ExecutionMode): Promise<EngineState>
    placeOrder(req: OrderRequest): Promise<OrderResult>
    sellPosition(req: SellRequest): Promise<OrderResult>
  }
  markets: {
    search(venue: VenueId, query: MarketSearchQuery): Promise<VenueMarket[]>
    orderBook(venue: VenueId, marketId: string): Promise<OrderBook>
  }
  portfolio: {
    get(venue: VenueId): Promise<PortfolioSnapshot>
    livePnl(venue: VenueId): Promise<LivePnl | null>
    /** Venue-authoritative resting orders; includes every strategy and manual/API order. */
    openOrders(venue: VenueId): Promise<OpenOrder[]>
  }
  autoTrader: {
    getConfig(): Promise<AutoTraderConfig>
    setConfig(cfg: AutoTraderConfig): Promise<AutoTraderConfig>
    scan(): Promise<AutoScanResult>
    getStatus(): Promise<AutoStatus>
    reset(): Promise<void>
    testVet(): Promise<AutoVetTest>
  }
  autoMini: {
    getConfig(venue: VenueId): Promise<MiniAutoConfig>
    setConfig(venue: VenueId, cfg: MiniAutoConfig): Promise<MiniAutoConfig>
    scan(venue: VenueId): Promise<MiniScanResult>
    getStatus(venue: VenueId): Promise<MiniStatus>
    reset(venue: VenueId): Promise<void>
    /** Validate a Polymarket US order payload with real credentials WITHOUT placing it (POST /v1/order/preview). Returns the raw venue response. */
    preview(venue: VenueId, req: OrderRequest): Promise<unknown>
  }
  history: {
    list(limit?: number, venue?: VenueId): Promise<TradeRecord[]>
    /** Pass a venue for per-broker numbers (each tab shows its own). */
    stats(venue?: VenueId): Promise<HistoryStats>
  }
  categories: {
    get(): Promise<string[]>
  }
  backtest: {
    run(params: BacktestParams): Promise<BacktestResult>
  }
  research: {
    run(topic: string): Promise<ResearchResult>
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
  settings: {
    get(): Promise<SettingsView>
    testIbkrGateway(): Promise<IbkrGatewayStatus>
    ibkrSnapshot(): Promise<import('./ibkr').IbkrSnapshot>
    ibkrMarkets(symbol: string, month: string): Promise<import('./ibkr').IbkrInstrument[]>
    ibkrQuote(conId: number): Promise<import('./ibkr').IbkrQuote>
    ibkrPreview(req: OrderRequest): Promise<import('./ibkr').IbkrPreview>
    ibkrCancel(orderId: string): Promise<void>
    ibkrWatches(): Promise<import('./ibkr').IbkrWatch[]>
    ibkrLabStatus(): Promise<import('./ibkrLab').IbkrLabStatus>
    polyPaperStatus(): Promise<import('./polyPaper').PolyPaperStatus>
    polyPaperEnabled(enabled:boolean): Promise<import('./polyPaper').PolyPaperStatus>
    ibkrLabConfigure(patch: Partial<import('./ibkrLab').IbkrLabConfig>): Promise<import('./ibkrLab').IbkrLabStatus>
    ibkrLabScan(): Promise<import('./ibkrLab').IbkrLabStatus>
    ibkrReconciliation(): Promise<{ lastRunAt?: number; lastError?: string; ingested: number }>
    ibkrWatchAdd(request: OrderRequest, expiresAt: number): Promise<import('./ibkr').IbkrWatch[]>
    ibkrWatchStop(id: string): Promise<import('./ibkr').IbkrWatch[]>
    saveManifoldKey(key: string): Promise<ManifoldConnection>
    saveKalshiCredentials(apiKeyId: string, privateKey: string): Promise<KalshiConnection>
    setKalshiDemo(demo: boolean): Promise<KalshiConnection>
    savePolymarketUsCredentials(apiKeyId: string, secretKey: string): Promise<KalshiConnection>
    setRiskLimits(r: RiskLimits): Promise<RiskLimits>
    resetPaper(): Promise<void>
  }
  scanner: {
    scan(venue: VenueId, query: MarketSearchQuery): Promise<VenueMarket[]>
  }
  onEvent(channel: string, listener: (payload: unknown) => void): () => void
}

export const IPC = {
  engineGetState: 'engine:getState',
  engineSetMode: 'engine:setMode',
  enginePlaceOrder: 'engine:placeOrder',
  engineSell: 'engine:sell',
  marketsSearch: 'markets:search',
  marketsOrderBook: 'markets:orderBook',
  portfolioGet: 'portfolio:get',
  portfolioLivePnl: 'portfolio:livePnl',
  portfolioOpenOrders: 'portfolio:openOrders',
  autoTraderGet: 'autoTrader:getConfig',
  autoTraderSet: 'autoTrader:setConfig',
  autoTraderScan: 'autoTrader:scan',
  autoTraderStatus: 'autoTrader:getStatus',
  autoTraderReset: 'autoTrader:reset',
  autoTraderTestVet: 'autoTrader:testVet',
  autoMiniGet: 'autoMini:getConfig',
  autoMiniSet: 'autoMini:setConfig',
  autoMiniScan: 'autoMini:scan',
  autoMiniStatus: 'autoMini:getStatus',
  autoMiniReset: 'autoMini:reset',
  autoMiniPreview: 'autoMini:preview',
  historyList: 'history:list',
  historyStats: 'history:stats',
  categoriesGet: 'categories:get',
  backtestRun: 'backtest:run',
  researchRun: 'research:run',
  shellOpen: 'shell:openExternal',
  settingsGet: 'settings:get',
  settingsTestIbkrGateway: 'settings:testIbkrGateway',
  ibkrSnapshot: 'ibkr:snapshot',
  ibkrMarkets: 'ibkr:markets',
  ibkrQuote: 'ibkr:quote',
  ibkrPreview: 'ibkr:preview',
  ibkrCancel: 'ibkr:cancel',
  ibkrWatches: 'ibkr:watches',
  ibkrLabStatus: 'ibkr:lab-status',
  polyPaperStatus: 'poly-paper:status',
  polyPaperEnabled: 'poly-paper:enabled',
  ibkrLabConfigure: 'ibkr:lab-configure',
  ibkrLabScan: 'ibkr:lab-scan',
  ibkrReconciliation: 'ibkr:reconciliation',
  ibkrWatchAdd: 'ibkr:watch-add',
  ibkrWatchStop: 'ibkr:watch-stop',
  settingsSaveKey: 'settings:saveManifoldKey',
  settingsSaveKalshi: 'settings:saveKalshiCredentials',
  settingsSetKalshiDemo: 'settings:setKalshiDemo',
  settingsSavePolymarketUs: 'settings:savePolymarketUsCredentials',
  settingsRiskLimits: 'settings:setRiskLimits',
  settingsResetPaper: 'settings:resetPaper',
  scannerScan: 'scanner:scan',
  quantStatus: 'quant:getStatus',
  event: 'engine:event'
} as const
