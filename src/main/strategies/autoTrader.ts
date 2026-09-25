import { safeStorage } from 'electron'
import { dirname, join } from 'node:path'
import { EpisodeRecorder } from '../store/episodes'
import { JsonStore } from '../store/json'
import type { TradingEngine } from '../engine/engine'
import type {
  AutoOpenTrade,
  AutoOpenTradeLeg,
  AutoPendingOrder,
  AutoScanResult,
  AutoSignal,
  AutoStatus,
  AutoTraderConfig,
  AutoStrategyId,
  StrategyPerf
} from '../../shared/ipc'
import type { NewsItem } from '../../shared/ipc'
import type { AutoBookStats, AutoVetTest } from '../../shared/ipc'
import type { MarketCandle, MarketTrade, OpenOrder, OrderBook, Position, VenueMarket } from '../../shared/types'
import { KalshiAdapter } from '../venues/kalshi'
import { KalshiWsClient, type WsStats } from '../venues/kalshiWs'
import { PolymarketAdapter } from '../venues/polymarket'
import { sendAlert } from '../util/alert'
import { KALSHI_TAKER_FEE_COEF, kalshiFeeCentsPerContract, kalshiOrderFeeDollars } from '../util/kalshiFee'
import { HttpError } from '../util/http'
import { fadeCategoryBlock, tempSeriesKind, underlyingOf, weatherSeatBlock } from './classify'
import { bankObservations, eventDayStatus, parseEventDate, stationCode, stationTimeZone } from './weatherDay'
import { bracketFairValue, fetchHourlyForecast, forecastSigma, remainingExtremes } from './weatherForecast'
import { settlementProbeDue, stuckSettlements } from './ledgerAudit'
import { fetchNews } from './news'
import { SportsAnchor, defaultSportsShadow, isSportsMarket, type SportsShadowStats } from './sportsAnchor'
import { SportsGameOddsAnchor } from './sportsGameOdds'
import { FLOW_DEFAULTS, FlowMonitor, flowVerdict } from './flowMonitor'
import { computeCandidate, midOf, momentumCandidatesActive, recordMomentumCandidates, type MomentumCandidateRow } from './momentumCandidates'
import { LEADLAG_COINS, LEADLAG_PROVEN_DEFAULT } from './leadLag'
import { ConsensusFeed, CONSENSUS_NOT_WINNER, CONSENSUS_RULE, consensusAgeHours, consensusRefusal, type ConsensusRule } from './consensus'
import { appendFileSync } from 'node:fs'
import type { VettingContext, VettingMarket } from './vetting'
import { runHunchPass } from './hunch'
import { stationLocalHour, ThinQuoter } from './quoter'
import { DutchBookEngine } from './dutchBook'
import { CryptoConvergenceEngine } from './cryptoConvergence'
import { LeadLagEngine } from './leadLag'
import { scanSlotVerdict, SCAN_WEDGE_MS } from './scanSlot'
import { OracleIntelligenceEngine } from '../intelligence/engine'
import { app } from 'electron'

const VENUE = 'kalshi' as const

/** How long after close we wait before checking for a resolution. */
const SETTLE_GRACE_MS = 30 * 60_000

const DEFAULT_CONFIG: AutoTraderConfig = {
  enabled: false,
  autoPoll: false,
  pollIntervalSeconds: 30,
  // Universe: short-expiry testing window — markets resolving in 15 min to
  // 24 h. Longer horizons are an explicit CHOICE via the panel's horizon
  // dropdown; the default never admits long-hold positions.
  minMinutesToClose: 15,
  maxMinutesToClose: 1440,
  category: '',
  maxMarketsPerScan: 40,
  minVolume: 20,
  minLiquidity: 150,
  maxSpreadPct: 0.04,
  minPrice: 0.05,
  maxPrice: 0.95,
  minScore: 55,
  // ---- momentum (backtested 2026-08-28: FAIL — mean forward move −6.6¢,
  // hit rate 36%; the 10-min move mean-reverts). Redesigned 2026-09-07 after
  // the live micro test churned 13 fills on one in-play game (-$4.41 in 20
  // trades): the move must have traded and held direction, one entry per
  // market per day, held to settlement. The ladder retries it on the cool-down.
  momentumEnabled: false,
  momentumWindowMinutes: 10,
  momentumMinMovePct: 0.03,
  // ---- mean reversion on extremes (pre-registered 2026-09-07,
  // docs/PREREGISTERED-mean-reversion.md). The 2026-08-28 momentum backtest
  // found the opposite of momentum: a 10-minute move's mean FORWARD move was
  // -6.6c with a 36% hit rate, i.e. the move reverted. This arm takes that
  // side directly - fade a big traded move on a market with hours of life
  // left, hold to settlement.
  meanReversionEnabled: false,
  meanReversionWindowMinutes: 10,
  meanReversionMinMoveCents: 8,
  meanReversionMinHoursToClose: 6,
  meanReversionMinEntryPrice: 0.35,
  meanReversionMaxHoursToClose: 24,
  // ---- time-of-day effect: the morning forecast update (pre-registered
  // 2026-09-08, docs/PREREGISTERED-weather-morning.md). Daily temperature
  // brackets are listed the evening before and trade overnight against the
  // previous afternoon's forecast; the 06z/12z runs land in the NWS hourly
  // product before local mid-morning. This arm buys the bracket side the
  // refreshed forecast says is mispriced, in the station's own morning, and
  // holds to settlement. The quoter's local high blackout starts at 12:00,
  // so the window stays clear of it.
  weatherMorningEnabled: false,
  weatherMorningFromHour: 8,
  weatherMorningToHour: 11,
  weatherMorningMinEdgeCents: 5,
  weatherMorningMinHoursToClose: 2,
  // ---- Polymarket smart-money consensus on Kalshi (pre-registered
  // 2026-09-13, docs/PREREGISTERED-polymarket-consensus.md). Day-clustered
  // over the shadow's own grades, entry at the Kalshi ask net of the taker
  // fee: +6.39c/contract, 95% [+3.14, +10.19] on 692 rows over 7 days
  // (2026-09-14 reading). The same rows clustered by CATEGORY still include
  // zero, which is why this goes on the ladder at micro size rather than
  // straight to a size the category concentration could hurt.
  consensusEnabled: false,
  consensusMaxSignalAgeHours: CONSENSUS_RULE.maxSignalAgeHours,
  consensusMinHoursToClose: CONSENSUS_RULE.minHoursToClose,
  consensusMaxHoursToClose: CONSENSUS_RULE.maxHoursToClose,
  consensusExtraLongSlots: 2,
  consensusMinPrice: CONSENSUS_RULE.minPrice,
  consensusMaxPrice: CONSENSUS_RULE.maxPrice,
  consensusMaxDriftCents: CONSENSUS_RULE.maxDriftCents,
  // ---- volume spike (never fired in any live/historical test with these
  // thresholds; unvalidated) — disabled by default.
  volumeSpikeEnabled: false,
  volumeSpikeWindowMinutes: 10,
  volumeSpikeBaselineMinutes: 120,
  volumeSpikeMinMultiple: 2.5,
  bookEnabled: false,
  bookLabBypass: false,
  // Thin-market quoter: two-sided post-only quotes one cent inside thin books.
  quoterEnabled: false,
  quoterCategory: 'Climate and Weather',
  quoterSeriesRegex: '^KX(HIGH|LOW)',
  quoterMinSpreadCents: 3,
  quoterMaxSpreadCents: 20,
  quoterMaxTouchDepth: 50,
  quoterMaxContracts: 3,
  quoterDecreaseEnabled: false,
  quoterMaxMarkets: 10,
  quoterMaxExposure: 3,
  quoterMaxPositionExposure: 25,
  quoterMaxInventory: 1,
  quoterCancelMinutes: 60,
  quoterMinHoursToClose: 3,
  quoterMaxHoursToClose: 48,
  bookMinRatio: 1.6,
  bookMinDepth: 300,
  bookMinSideDepth: 50,
  bookLogging: true,
  // ---- cross-venue (overlap discovery 2026-08-28: 0% coverage — Gamma's
  // ladders don't overlap Kalshi's at matched times) — disabled by default.
  crossVenueEnabled: false,
  crossVenueMinGapPct: 0.06,
  crossVenueMinSimilarity: 0.3,
  newsEnabled: false,
  newsTopics: ['bitcoin price', 'ethereum price', 'xrp price', 'solana price', 'gold price', 'oil price', 'fed rate decision'],
  newsMinSimilarity: 0.25,
  // ---- Dutch book. Backtested 2026-08-28: zero Σbids>1.03 excursions across
  // 104 mutually_exclusive events (12h pre-close each) and zero live — the
  // arb essentially never occurs. Disabled by default; cheap to re-enable.
  dutchEnabled: false,
  dutchMinOverSum: 0.03,
  dutchMaxLegs: 6,
  dutchLiveEnabled: false,
  convergenceEnabled: true,
  convergenceLiveEnabled: false,
  convergenceModeledWinProbability: 0.97,
  convergenceMaxDailyTrades: 6,
  // ---- thin weather quoter. Venue settlements 2026-09-02..05: -$29.07 over
  // 112 markets, -2.6c/contract, bids hit at -6.2c, fills clustered while the
  // daily extreme formed. Disabled by default; the shadow meter scores the
  // gated would-quotes at zero cost so a re-arm can rest on measured data.
  quoterShadowEnabled: true,
  quoterRatchetGate: true,
  quoterRequireIndex: true,
  quoterBlackoutEnabled: true,
  quoterGuardF: 2,
  quoterNearF: 1.5,
  // ---- favorite-longshot fade. Backtested 2026-08-28: clean-pool calibration
  // shows severe longshot overpricing (0.1-0.3% YES at p<0.10 vs 3.5-7.5%
  // implied, n≈2400); entry-level replay n≈74 shows mean +9-16¢ after fee.
  // Directionally positive but n is small — enabled as a PAPER forward
  // experiment; treat live use as experimental.
  fadeEnabled: false,
  fadeMaxPrice: 0.1,
  fadeMinPrice: 0.03,
  fadeExitEnabled: false,
  // Maker entries rest a post-only sell-YES inside the spread: strictly
  // better price when filled and zero taker fee on standard quadratic
  // series. Paper mode simulates taker regardless (resting fills cannot be
  // simulated honestly), so paper results UNDERSTATE live maker economics.
  fadeEntryMode: 'maker',
  fadeMinEdgeCents: 1.5,
  fadeMinHorizonMinutes: 60,
  fadeMaxCryptoPerCloseHour: 1,
  // Mirror side of the same calibrated bias (thinner evidence → 2× padding).
  // Evidence: 62-day point-in-time replay (2026-09-02, family-capped) put the
  // favorite leg at maker -8.42c / taker -10.28c, negative at every clustering
  // over 142 independent events. It is a losing leg in Kalshi's current mix.
  fadeFavoritesEnabled: false,
  // Category filter: only fade where the bias is measured to exist (see
  // fadeCategoryBlock). Strictly removes entries; shadow-graded via vetoes.
  fadeCategoryFilterEnabled: true,
  // Overruled by this account's own counterfactual ledger (2026-09-01):
  // crypto fades graded 38/39 wins, +156¢ gross (~+136¢ net of fees) over 39
  // settled. The study called the bias "absent" in crypto, not adverse — and
  // a maker fade pays no taker fee, so an EV-neutral trade costs nothing but
  // a slot the account had idle cash to fill. Blocking guaranteed zero.
  // finance stays blocked (7 graded, −57¢ — it earns its place); weather<48h
  // keeps the study's prior while its own ledger sits at noise (21, +30¢).
  fadeCategoryExceptions: ['crypto'],
  // Settlement convergence: on by default as a PAPER forward experiment —
  // strike parsing now uses the venue's structured fields, and the forward
  // log is the only way to validate it (the index isn't archived).
  settleEnabled: true,
  // The experiment stays paper even when the engine is live-armed, until
  // this second switch is flipped deliberately.
  settleLiveEnabled: false,
  settleMinMarginPct: 2,
  settleMaxMinutesToClose: 30,
  amountPerTrade: 5,
  maxBalancePct: 25,
  maxOpenPositions: 25,
  // At most this many slots may settle >24h out — long-dated exotics have
  // fat edges but terrible edge-per-day, and they were eating every slot.
  maxLongHorizonPositions: 3,
  // Positions allowed per risk-bearing underlying (SOL, BTC, one weather
  // station…) regardless of how many series Kalshi splits it across.
  maxPerUnderlying: 1,
  maxDailyTrades: 60,
  // Graceful de-risk: halt NEW entries while exits/settlement keep running.
  // The middle setting between "running" and the kill switch.
  stopEntry: false,
  maxDailyLossPct: 20,
  maxLlmPerScan: 4,
  takeProfitPct: 5,
  stopLossPct: 10,
  exitMinutesBeforeClose: 5,
  maxHoldMinutes: 0,
  reversalExit: true,
  reversalExitPct: 0.08,
  vetMode: 'rules',
  // Sports devig shadow: sharp-anchor gaps logged, never traded, until the
  // forward evidence clears the lab bar. Free-tier The Odds API key.
  sportsShadowEnabled: true,
  oddsApiKey: '',
  metaculusApiKey: '',
  // Live socket, SHADOW only: maintains books and grades them against REST.
  // Nothing trades off WS data until that record earns the promotion.
  wsEnabled: true,
  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
  // Verified 2026-08-28 on the real vetting prompt: DeepSeek V4 Pro with
  // thinking disabled answers in ~2s with the same verdict quality as the
  // 30-60s reasoning path (which also starves small token budgets).
  llmThinking: 'disabled',
  intelligenceEnabled: true,
  intelligenceMode: 'shadow',
  intelligencePrimaryModel: 'openai/gpt-5.6-sol',
  intelligenceSecondaryModel: 'deepseek/deepseek-v4-pro',
  intelligenceFallbackModel: 'z-ai/glm-5.3',
  intelligenceMaxPaidPerDay: 60,
  hunchChallengerEnabled: true,
  hunchChallengerModel: 'openai/gpt-5.6-sol',
  hunchChallengerMaxPerDay: 40,
  intelligenceMinEdgeCents: 2,
  liveArmed: false,
  dryRun: false,
  alertWebhookUrl: '',
  // ---- automation: the ladder promotes/demotes on pre-registered gates so
  // nothing waits on a remembered switch; the nightly review files evidence
  // and may retune bounded parameters of NON-live strategies.
  ladderEnabled: true,
  nightlyReviewEnabled: true,
  nightlyReviewHourUtc: 6,
  reviewAutoApplyParams: true,
  reviewAutoApplyLive: true,
  // Operator directive 2026-09-06: this is a real-money trader, not a research
  // rig. Strategies go to tiny-live tests as soon as the arm and collateral
  // allow (stop −$5, significance demotion); after two demotions a strategy
  // must pass its pre-registered gate before it trades again.
  ladderMode: 'trade-small',
  ladderMaxDemotionsBeforeGate: 2,
  ladderAutoAllocateUsd: 20,
  // Rest inside the spread instead of crossing for these signal strategies
  // (GWU 2026 on Kalshi's own data: makers -9.6% vs takers -31.5% after
  // fees). Momentum, settlement, dutch, lead-lag and convergence stay takers
  // by design (transient gaps, certainties, multi-leg baskets).
  makerStrategies: ['fade', 'book-imbalance', 'volume-spike', 'news', 'cross-venue', 'sports-anchor', 'flow-follow']
}

/** Calibration buckets for hold-to-settle win probabilities (cluster near 1). */
const CALIB_EDGES = [0, 0.9, 0.95, 0.98, 0.995, 1.000001]

/**
 * Half the 120-row veto watch, reserved for capacity vetoes. They outnumber the LLM gate's by orders of
 * magnitude and share one list; without a ceiling they would crowd out the counterfactual we are already
 * measuring.
 */
const CAPACITY_WATCH_MAX = 60

/**
 * Ceiling for the LLM-gate and category rows, held at its historical value so round 81 did not quietly
 * shrink a measurement already in flight. Separate from the capacity ceiling above — see `watchVeto`.
 */
const LEGACY_WATCH_MAX = 120

/**
 * Is this `entryBlocked` reason a CAPACITY decision - the market was tradeable and we declined it because a
 * budget was full - and what stable key does it belong under?
 *
 * Single source of truth for both questions on purpose. It also normalises: "underlying KXBTC full (4/4)"
 * and "long-horizon slots full (4/4)" carry live counts, so keying the ledger on the raw string would
 * explode it into one bucket per underlying and per count instead of grouping the cap's record.
 *
 * Returns undefined for anything else. Global safety states (stop-entry, paused exchange, stale ledger, kill
 * switch, unfunded shard) block everything indiscriminately, so their counterfactual says nothing about any
 * cap; dedup reasons ("market already open") mean we HAVE the position, so there is nothing to counterfact.
 */
/**
 * Cumulative marks (name, ms since scan start) -> per-phase durations, ms. Pure, so the arithmetic that
 * feeds a decision about the scan path is tested rather than eyeballed.
 */
export function phaseDurations(marks: [string, number][]): Record<string, number> {
  const out: Record<string, number> = {}
  let prev = 0
  for (const [name, at] of marks) {
    // A repeated name sums; dropping the earlier slice would misattribute it to nothing.
    out[name] = (out[name] ?? 0) + Math.max(0, at - prev)
    prev = at
  }
  return out
}

// The slot guard moved to ./scanSlot on 2026-09-25 so the lead-lag engine's own poll can share it rather
// than grow a second copy: it had the identical defect and wedged for 11 h. Re-exported unchanged, because
// callers and scripts/tests/review-fixes.test.ts import both names from here.
export { scanSlotVerdict, SCAN_WEDGE_MS }

/**
 * The long-horizon slot cap that applies to one strategy's entry. Every arm shares
 * `maxLongHorizonPositions`; the consensus arm alone may also use
 * `consensusExtraLongSlots` on top (round 96): its signals are long-dated by
 * construction (mean lead 36 h, >= 6 h floor), so a shared pool that resting
 * volume-spike orders can fill starves the one arm whose test counts settlements.
 * The extra slots are clamped 0..4 and are reserved, never shared downward.
 */
/**
 * Strategies whose positions are held to settlement: take-profit, stop-loss, pre-close, max-hold and
 * reversal exits never run on them (every trade is still quoted each pass for CLV and markout).
 * weather-morning is a forecast bet on the day's extreme: the only event that settles it is the day
 * ending, so a TP/SL rule could only pay a second spread on the way out.
 * consensus joined in round 97: its pre-registration graded hold-to-resolution, and on 2026-09-14 the
 * default 5% take-profit / 10% stop-loss sold nine of its positions minutes after entry, on in-play prices.
 */
export function holdsToSettlement(strategy: string, cfg: { fadeExitEnabled?: boolean }): boolean {
  return (
    strategy === 'dutch' ||
    strategy === 'settlement' ||
    strategy === 'momentum' ||
    strategy === 'mean-reversion' ||
    strategy === 'weather-morning' ||
    strategy === 'consensus' ||
    (strategy === 'fade' && !cfg.fadeExitEnabled)
  )
}

export function longHorizonCapFor(strategy: string, cfg: { maxLongHorizonPositions: number; consensusExtraLongSlots?: number }): number {
  const base = Math.max(0, cfg.maxLongHorizonPositions)
  if (strategy !== 'consensus') return base
  const extra = Math.max(0, Math.min(4, Math.round(cfg.consensusExtraLongSlots ?? 2)))
  return base + extra
}

export function capacityKey(reason: string): string | undefined {
  if (reason.startsWith('max open positions')) return 'max-open'
  if (reason.startsWith('unsettled backlog')) return 'unsettled-backlog'
  if (reason.startsWith('daily trade cap')) return 'daily-cap'
  if (reason.startsWith('event already')) return 'event-exposed'
  if (reason.startsWith('underlying ')) return 'underlying-full'
  if (reason.startsWith('long-horizon slots full')) return 'long-horizon'
  if (reason.startsWith('per-market entry cap')) return 'per-market-cap'
  if (reason.startsWith('re-entry lockout')) return 're-entry-lockout'
  if (reason.startsWith('momentum: one entry')) return 'momentum-one-per-day'
  if (reason.startsWith('crypto close-hour full')) return 'crypto-close-hour'
  return undefined
}

/** Block reasons that are deliberately NOT graded, so an UNRECOGNISED one can be logged instead of ignored. */
const KNOWN_UNGRADED_BLOCK =
  /^(stop-entry|exchange trading paused|venue ledger stale|awaiting venue reconcile|market already open|order already resting|stake below \$1|insufficient balance|shard \d+ unfunded|kill-switch|weather series)/i

interface VetoWatchItem {
  marketId: string
  strategy: string
  outcome: 'YES' | 'NO'
  /** Executable cost of the leg the vetoed trade would have bought. */
  legCost: number
  closeTime?: number
  ts: number
  /** What blocked it: 'llm' or 'category:<group>' — keys the byReason ledger. */
  reason?: string
}

interface CalibState {
  byStrategy: Record<string, { n: number; brierSum: number; buckets: { n: number; wins: number; probSum: number }[]; netN?: number; netSum?: number; netSq?: number; byEvent?: Record<string, { n: number; sum: number }>; byDay?: Record<string, { n: number; sum: number; w?: number; wsum?: number }>;
    /** Contract-weighted accumulators (audit B-21): wN = contracts graded, wSum = sum of net cents x contracts, wSq = sum of net^2 x contracts, wTrades = grades that carried a weight. */
    wN?: number; wSum?: number; wSq?: number; wTrades?: number }>
  vetoWatch: VetoWatchItem[]
  vetoes: { graded: number; wouldHaveWon: number; estPnlCents: number }
  /** Same counterfactual ledger split by veto reason (LLM vs category filter). */
  vetoesByReason?: Record<string, { graded: number; wouldHaveWon: number; estPnlCents: number }>
}

function defaultCalib(): CalibState {
  return { byStrategy: {}, vetoWatch: [], vetoes: { graded: 0, wouldHaveWon: 0, estPnlCents: 0 } }
}

interface PersistedState {
  openTrades: AutoOpenTrade[]
  /** Resting maker orders awaiting fill (live fade maker mode). */
  pendingOrders: AutoPendingOrder[]
  signals: AutoSignal[]
  daily: { date: string; count: number }
  /** Today's realized P&L — drives the drawdown kill-switch. */
  dailyPnl: { date: string; realized: number; tripped: boolean }
  /** Explicit operator restart baseline; raw daily ledgers remain unchanged. Expires at UTC midnight. */
  killReset?: { date: string; at: number; local: number; venue: number; reason: string }
  /** Per-market churn (entries today, last exit) - persisted because the app restarts ~15x a day (audit B-12). */
  churn?: Record<string, { day: string; entries: number; lastExitAt: number }>
  /** Live settlements this ledger has booked, by market: the venue keeps listing a determined position until its
   *  settlement timer runs out, and the orphan sweep must not adopt it again (2026-09-19: five bookings in 22 min). */
  settledMarkets?: Record<string, { at: number; shares: number }>
  stats: { scans: number; approved: number; vetoed: number; executed: number }
  bookStats: AutoBookStats
  perf: { trades: number; wins: number; losses: number; realizedPnl: number }
  /** Per-strategy slice of the same ledger (keep/kill evidence). */
  perfByStrategy: Record<string, StrategyPerf>
  /** Forward calibration of the bot's own entries + counterfactual veto grading. */
  calib: CalibState
  /** Per-event daily temperature extremes (the weather ratchet's banked floor). */
  weatherRatchet?: Record<string, { hi: number; lo: number; at: number }>
  /** Sharp-anchor shadow: Kalshi-vs-devigged-Pinnacle gap ledger (never trades). */
  sportsShadow?: SportsShadowStats
  /**
   * Consensus arm: markets and Polymarket source markets already entered, with
   * the time. PERSISTED because the pre-registration allows ONE entry per
   * market and ONE open position per Polymarket source market — an in-memory
   * set would let a restart take the same signal again, and the app boots
   * about eighteen times a day.
   */
  consensusActed?: { markets: Record<string, number>; sources: Record<string, number> }
  /** Per-sport last-poll times. PERSISTED: an in-memory throttle re-polls
   * every sport on each restart and burns the free API quota. */
  sportsPollAt?: Record<string, number>
  /** Live-socket book cache health + its REST agreement record. */
  wsStats?: WsStats
  /**
   * Today's realized P&L per the VENUE's settlement feed. The local dailyPnl
   * counts only this trader's own exits; the quoter, convergence, lead-lag and
   * Dutch engines settle at the venue without touching it, which is how a
   * 5%-per-day kill switch slept through a $29 weather-quoter loss.
   */
  venueDay?: { date: string; realized: number; legacyRealized?: number; settlements: number; fetchedAt: number }
  lastScanAt?: number
  lastScanMs?: number
  /** Per-phase durations of the last scan, ms (round 92). Read it from kalshi-auto.json before guessing. */
  lastScanPhases?: Record<string, number>
  lastError?: string
}

interface PersistedStore {
  config: AutoTraderConfig
  state: PersistedState
  /** Config schema version, for one-time evidence-driven default migrations. */
  configVersion?: number
}

interface ScanData {
  candles1m: Record<string, MarketCandle[]>
  candles1h: Record<string, MarketCandle[]>
  trades: Map<string, MarketTrade[]>
  books: Map<string, OrderBook>
  headlinesByMarket: Map<string, string[]>
  live: Map<string, { latest?: number; staleMinutes?: number; type?: string }>
  /** Full market objects for the scanned universe (rules text for the vet). */
  marketsById: Map<string, VenueMarket>
  /** False while the exchange has trading paused (weekly maintenance). */
  tradingActive?: boolean
  balance?: number
  /** Kalshi per-shard balances (live only). Collateral is held per exchange shard. */
  balanceByShard?: Record<number, number>
  /** Set when the universe was non-empty but no order books came back - surfaced as a scan error. */
  booksFailed?: string
  /** Cash + value of open positions. The percentage stake cap sizes off THIS. */
  equity?: number
}

const STOP = new Set([
  'a', 'an', 'the', 'will', 'be', 'is', 'are', 'was', 'were', 'in', 'on', 'of', 'to', 'for', 'by', 'with',
  'at', 'from', 'and', 'or', 'who', 'what', 'which', 'when', 'how', 'do', 'does', 'did', 'this', 'that', 'it',
  'he', 'she', 'they', 'we', 'you', 'i', 'me', 'my', 'vs', 'its', 'his', 'her', 'their', 'about', 'before', 'after',
  'up', 'down', 'above', 'below', 'next', 'price', 'minutes', 'minute', 'today', 'after'
])

const POS_WORDS = [
  'up', 'rise', 'rises', 'rising', 'rally', 'rallies', 'surge', 'surges', 'surged', 'jump', 'jumps', 'jumped',
  'gain', 'gains', 'record', 'higher', 'bullish', 'soar', 'soars', 'climb', 'climbs', 'rebound', 'rebounds',
  'breakout', 'approve', 'approves', 'approved', 'win', 'wins', 'winning', 'passes', 'passed', 'beats', 'beat'
]
const NEG_WORDS = [
  'down', 'fall', 'falls', 'falling', 'drop', 'drops', 'dropped', 'crash', 'crashes', 'plunge', 'plunges',
  'lower', 'bearish', 'slump', 'slumps', 'decline', 'declines', 'sink', 'sinks', 'reject', 'rejects', 'rejected',
  'lose', 'loses', 'losing', 'fail', 'fails', 'failed', 'miss', 'misses', 'missed', 'below', 'selloff', 'sell-off'
]

const ASSETS = [
  'bitcoin', 'btc', 'ethereum', 'eth', 'xrp', 'ripple', 'solana', 'sol', 'dogecoin', 'doge', 'cardano', 'ada',
  'binance', 'bnb', 'gold', 'silver', 'copper', 'oil', 'wti', 'natural gas', 'nasdaq', 's&p', 'dow jones'
]

function stem(w: string): string {
  if (/^[a-z]{4,}s$/.test(w)) return w.slice(0, -1)
  return w
}

function norm(q: string): string[] {
  return [...new Set(q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).map(stem))]
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  const union = new Set([...sa, ...sb]).size
  return union === 0 ? 0 : inter / union
}

/** Title without the appended Kalshi strike sub-title ("… · $2.1399 or above"). */
function titleTokens(m: VenueMarket): string[] {
  return norm(m.question.split(' · ')[0])
}

function assetOf(m: VenueMarket): string | undefined {
  const t = m.question.toLowerCase()
  for (const a of ASSETS) {
    const re = new RegExp(`(^|[^a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i')
    if (re.test(t)) return a
  }
  return undefined
}

/**
 * How many Polymarket Gamma searches the cross-venue arm may make in one pass.
 * Each candidate costs one HTTP round trip, so this is the arm's real budget —
 * the old `markets.slice(0, 12)` capped MARKETS EXAMINED instead, and a slice
 * full of markets with no tradeable asset spent the whole cap on zero searches.
 *
 * Four, not twelve, and the reason is the CADENCE: this runs about twice a
 * minute, not once per 10-minute scan. Twelve searches a pass is 1,440 requests
 * an hour at a free public endpoint, about seven times what the old slice
 * actually spent (~1.8 searches a pass, since most of the head had no asset).
 * Four covers the ~38 searchable markets of a 250-market universe in about five
 * minutes, which is far inside the life of any dislocation worth taking.
 */
export const CROSS_VENUE_SEARCH_BUDGET = 4

/**
 * The next batch of markets for the cross-venue arm, and where to resume.
 *
 * Found 2026-09-17 (backlog 123): the arm had produced 0 signals lifetime because
 * it only ever looked at `markets.slice(0, 12)` — the same head of the universe on
 * every scan, so ~28 of 40 markets were never compared to Polymarket at all and a
 * dislocation outside the head could not be seen. The budget is unchanged; what
 * changes is that the window ROTATES, so the whole universe is covered over
 * consecutive scans, and only markets that would actually be searched consume it.
 */
export function crossVenueBatch<T>(
  markets: T[],
  cursor: number,
  budget: number,
  searchable: (m: T) => boolean
): { batch: T[]; start: number; cursor: number; skipped: number } {
  const n = markets.length
  if (n === 0 || budget <= 0) return { batch: [], start: 0, cursor: 0, skipped: 0 }
  const start = ((Math.trunc(cursor) % n) + n) % n
  const batch: T[] = []
  let skipped = 0
  let i = 0
  for (; i < n && batch.length < budget; i++) {
    const m = markets[(start + i) % n]
    if (searchable(m)) batch.push(m)
    else skipped++
  }
  // Resume after everything examined this scan, searched or skipped, so a run of
  // unsearchable markets cannot pin the window in one place.
  return { batch, start, cursor: (start + i) % n, skipped }
}

function clamp01(v: number): number {
  return Math.min(0.99, Math.max(0.01, v))
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000
}

/** 0–167: local hour-of-week bucket (Sun 00:00 = 0). */
function hourOfWeek(ts = Date.now()): number {
  const d = new Date(ts)
  return d.getDay() * 24 + d.getHours()
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function fmtErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function nowDate(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Kalshi short-term auto-trader.
 *
 * Pipeline per tick: build universe → compute signals (momentum, volume spike,
 * order-book imbalance, cross-venue lead-lag, news, Dutch book, longshot fade,
 * settlement-source convergence) → hard risk gates → deterministic rules score
 * → optional LLM final gate (fails closed) → execute → manage exits.
 *
 * Safety model: dryRun blocks everything; otherwise orders go through the
 * engine's global paper/live mode. LIVE execution additionally requires the
 * explicit liveArmed switch (and dutchLiveEnabled for multi-leg Dutch).
 */
/**
 * Reprice a resting maker order only on a move of at least 3c.
 *
 * Kalshi's amend forfeits queue position on any price change (size decreases are the one exception), so a 1c chase
 * puts the order at the back of the book exactly when its price is right, and leaves it at the front exactly when it
 * is stale. Measured on this account's own settled maker markets (2026-09-18): markets whose order was amended ran
 * -2.17c/contract over 143 contracts, while never-amended ones ran +0.33c/contract over 1,786. The quoter's shadow
 * meter shows the same ~-2c on 1,115 markouts. Correlation is not settled - a market that moves is also a worse
 * market - but both readings argue for chasing less, and a decayed edge is already handled by pulling the order
 * rather than repricing it.
 */
export function shouldRepriceMaker(desiredYes: number, restingYes: number): boolean {
  return Math.abs(desiredYes - restingYes) >= 0.03 - 1e-9
}

/** A resting limit is stale by this much of the mid before it is pulled, in probability units. */
export const STALE_REST_CENTS = 0.02

/**
 * True when a resting order is no longer providing liquidity but offering a free option: the mid of OUR leg has
 * fallen below our own limit, so the only counterparty who wants us is one who knows the price has moved. Both
 * prices are on our leg (a NO rest is compared against the NO mid), and the tolerance keeps ordinary one-tick
 * jitter from cancelling a healthy order.
 *
 * Measured on 2026-09-21: volume-spike rested twelve orders and eleven filled - a 92% fill rate is the symptom,
 * not the goal - with the mid moving a median 1.5c and up to 43.5c against us immediately after the fill. fade,
 * the only arm that repriced and pulled, was the only arm up on the day.
 */
export function restIsStale(ourLegLimit: number, ourLegMid: number, tolerance = STALE_REST_CENTS): boolean {
  if (!(ourLegMid > 0) || !(ourLegLimit > 0)) return false
  return ourLegLimit - ourLegMid > tolerance + 1e-9
}

/** Scans between [gate] tally lines: ~11 min at the 13 s scan. */
const GATE_TALLY_SCANS = 50

export class AutoTrader {
  private config: AutoTraderConfig
  private state: PersistedState
  private store: JsonStore<PersistedStore>
  private timer: NodeJS.Timeout | null = null
  private busy = false
  /** When the tick holding `busy` started, so a never-settling one can be superseded (see scanSlotVerdict). */
  private busyAt = 0
  /** Bumped by every tick that takes the slot; a tick whose epoch is stale has been superseded. */
  private scanEpoch = 0
  private onEvent?: (type: string, payload: unknown) => void
  private newsCache: { at: number; items: NewsItem[] } | null = null
  private liveErrorStreak = 0
  private lastWatchdogAlert = 0
  private lastOrphanSweep = 0
  /** True once a live orphan sweep has fetched orders+positions cleanly this process. */
  private reconciledLive = false
  /** Last extreme-price settle probe per trade (in-memory; a stale cached closeTime must not stall settlement). */
  private settleProbeAt = new Map<string, number>()
  /** Last ratchet refusal noted per market, so a standing refusal logs on change or hourly, not every scan. */
  private ratchetNoteAt = new Map<string, { reason: string; at: number }>()
  /** Append-only JSONL archive of polled books + trade lifecycle events. */
  private episodes?: EpisodeRecorder
  private lastBookRecordAt = new Map<string, number>()
  /** Per-event throttle for weather-ratchet index reads. */
  private weatherFetchAt = new Map<string, number>()
  /** Exchange trading paused (weekly maintenance); refreshed by gatherData and exchangePausedNow. */
  private exchangePaused = false
  private exchangeCheckedAt = 0
  private incentivesLogged = false
  /** Last balance seen by gatherData — the kill switch's denominator for the sub-engines. */
  private lastEquity: number | undefined
  /** Status contributed by process-level services (promotion ladder, nightly review); set by index.ts. */
  private auxStatus: (() => Pick<AutoStatus, 'ladder' | 'lastReview'>) | undefined
  /** Live WS book cache — shadow-graded against REST before it may be trusted. */
  private ws?: KalshiWsClient
  private leadLagFastAttached = false
  /** The minute scan's last read of the exchange pause, for the fast path's gate (a pause also rejects orders). */
  private leadLagPaused = false
  private sportsAnchor = new SportsAnchor()
  private sportsGameOddsAnchor = new SportsGameOddsAnchor()
  /** Latest sharp-anchor observation per Kalshi market (from the shadow polls). */
  private lastAnchorObs = new Map<string, import('./sportsAnchor').AnchorObservation>()
  private flowMonitor = new FlowMonitor()
  /** Per-market churn record (in memory): entries today and the last exit time. */
  private churn = new Map<string, { day: string; entries: number; lastExitAt: number }>()

  /** Is this strategy switched on right now? The ladder flips these flags; unknown strategies count as on. */
  private strategyOn(strategy: string): boolean {
    const flag: Record<string, keyof AutoTraderConfig> = {
      fade: 'fadeEnabled',
      momentum: 'momentumEnabled',
      'mean-reversion': 'meanReversionEnabled',
      'book-imbalance': 'bookEnabled',
      'volume-spike': 'volumeSpikeEnabled',
      news: 'newsEnabled',
      'cross-venue': 'crossVenueEnabled',
      dutch: 'dutchLiveEnabled',
      leadlag: 'leadLagLiveEnabled',
      'sports-anchor': 'sportsAnchorLiveEnabled',
      'flow-follow': 'flowFollowEnabled',
      'weather-morning': 'weatherMorningEnabled',
      consensus: 'consensusEnabled'
    }
    const key = flag[strategy]
    return key === undefined ? true : Boolean(this.config[key] ?? true)
  }

  private noteEntry(marketId: string): void {
    const c = this.churn.get(marketId)
    if (c && c.day === nowDate()) c.entries++
    else this.churn.set(marketId, { day: nowDate(), entries: 1, lastExitAt: 0 })
    this.saveChurn()
  }

  private noteExit(marketId: string): void {
    const c = this.churn.get(marketId)
    if (c && c.day === nowDate()) c.lastExitAt = Date.now()
    else this.churn.set(marketId, { day: nowDate(), entries: 0, lastExitAt: Date.now() })
    this.saveChurn()
  }

  /** Mirror today's churn into the persisted state so a restart keeps the re-entry lockout and the per-day cap (B-12). */
  private saveChurn(): void {
    const today = nowDate()
    this.state.churn = Object.fromEntries([...this.churn].filter(([, c]) => c.day === today))
  }
  private resetRequested = false
  private readonly orphanAlerted = new Set<string>()
  /** Last time an entry was refused for an unfunded shard, and the last levelling we asked for (audit 2026-09-21). */
  private shardStarvedAt = 0
  private shardLevelledAt = 0
  /** Set by index.ts once the ladder exists: levelling collateral is the ladder's job, triggering it is the trader's. */
  private levelShards?: () => Promise<unknown>
  setShardLeveller(fn: () => Promise<unknown>): void { this.levelShards = fn }
  /** Data-only Polymarket Gamma feed for the cross-venue signal. */
  private readonly gamma = new PolymarketAdapter()
  /** Where the cross-venue arm's rotating search window resumes (backlog 123). */
  private crossVenueCursor = 0
  // book-signal lab (forward validation of the imbalance signal)
  private bookTimer: NodeJS.Timeout | null = null
  /** LLM hunch collector (docs/PREREGISTERED-llm-hunch.md): forward forecasts, trades nothing. */
  private hunchTimer: ReturnType<typeof setInterval> | undefined
  private hunchRunning = false
  /** Ledger-vs-venue reconcile (live only): consecutive scans a ledger trade was NOT held at the venue. */
  private venueMiss = new Map<string, number>()
  private reconcileTimer: ReturnType<typeof setInterval> | undefined
  private quoterTimer: ReturnType<typeof setInterval> | undefined
  private quoter = new ThinQuoter(join(app.getPath('userData'), 'quoter-kalshi.json'), (line) => console.log(line))
  private dutchTimer: ReturnType<typeof setInterval> | undefined
  private dutchEngine = new DutchBookEngine(join(app.getPath('userData'), 'dutch-book.json'), (line) => console.log(line))
  private convergenceTimer: ReturnType<typeof setInterval> | undefined
  private convergenceEngine = new CryptoConvergenceEngine(join(app.getPath('userData'), 'crypto-convergence.json'), (line) => console.log(line))
  private leadLagTimer: ReturnType<typeof setInterval> | undefined
  private leadLagCycles = 0
  private leadLagFoundLast = -1
  private leadLagEngine = new LeadLagEngine(join(app.getPath('userData'), 'leadlag.json'), (line) => console.log(line), true)
  private intelligence = new OracleIntelligenceEngine(app.getPath('userData'))
  /**
   * Polymarket smart-money consensus signals. The producer is the read-only
   * hourly shadow, so the file lives in the REPO's data dir, not userData.
   */
  private consensusFeed = new ConsensusFeed(join(app.getAppPath(), 'data', 'polymarket-consensus', 'signals.jsonl'))
  /** Consensus markets fetched from outside the ranked universe, as for the anchor. */
  private consensusMarketCache = new Map<string, { at: number; m: VenueMarket }>()
  private pendingBooks: { ts: number; ticker: string; lastPrice: number; predictedDir: 'YES' | 'NO' }[] = []
  private bookUniverse: VenueMarket[] = []
  private bookUniverseAt = 0

  /**
   * Per-strategy gate accounting, printed every GATE_TALLY_SCANS scans. `stats.vetoed` reached 1.99M against
   * 4,235 approvals with no record of WHICH strategies were being refused or WHY; mean-reversion had ~130
   * qualifying setups a day in the candle recorder and one entry in five days, and nothing could say where
   * the other 129 went. A strategy absent from the line generated nothing that scan window.
   */
  private gateTally: { scans: number; byStrategy: Record<string, { generated: number; vetoed: number; reasons: Record<string, number> }> } = { scans: 0, byStrategy: {} }

  constructor(
    private readonly engine: TradingEngine,
    statePath: string
  ) {
    this.store = new JsonStore<PersistedStore>(statePath, {
      config: { ...DEFAULT_CONFIG },
      state: defaultState(),
      // 0, not the version DEFAULT_CONFIG happens to match: JsonStore keeps these defaults when the file is absent or
      // will not parse, and a quarantined file must then run EVERY migration, not come back on code defaults with 2-20
      // skipped (the mini's 2026-09-03 lesson; audit 2026-09-19, B-13).
      configVersion: 0
    })
    this.episodes = new EpisodeRecorder(join(dirname(statePath), 'episodes'))
    const persisted = this.store.get()
    this.config = { ...DEFAULT_CONFIG, ...persisted.config }
    this.config.llmApiKey = decryptValue(this.config.llmApiKey)
    this.config.oddsApiKey = decryptValue(this.config.oddsApiKey ?? '')
    this.config.metaculusApiKey = decryptValue(this.config.metaculusApiKey ?? '')
    this.state = persisted.state ?? defaultState()
    // Rebuild today's churn guard from the persisted mirror (audit B-12): the guard was memory-only across ~15 boots a day.
    for (const [marketId, c] of Object.entries(this.state.churn ?? {})) if (c && c.day === nowDate()) this.churn.set(marketId, { ...c })
    this.state.pendingOrders = this.state.pendingOrders ?? []
    this.state.dailyPnl = this.state.dailyPnl ?? { date: nowDate(), realized: 0, tripped: false }
    this.state.perfByStrategy = this.state.perfByStrategy ?? {}
    this.state.calib = this.state.calib ?? defaultCalib()
    if ((persisted.configVersion ?? 1) < 2) {
      // One-time migration to the evidence-driven defaults from the
      // 2026-08-28 historical validation run (docs/validation-results.md):
      // momentum FAIL, volume-spike never fires, cross-venue 0% coverage,
      // dutch never occurs, fade directionally positive.
      this.config.momentumEnabled = false
      this.config.volumeSpikeEnabled = false
      this.config.crossVenueEnabled = false
      this.config.dutchEnabled = false
      this.config.fadeEnabled = true
    }
    if ((persisted.configVersion ?? 1) < 3) {
      // v3: the DeepSeek API does not accept versioned names like
      // 'deepseek-v4-pro-0813' — the alias 'deepseek-v4-pro' tracks the
      // latest Pro release.
      if (this.config.llmModel === 'deepseek-v4-pro-0813') this.config.llmModel = 'deepseek-v4-pro'
    }
    if ((persisted.configVersion ?? 1) < 4) {
      // v4: thinking=adaptive starved the token budget on the real vetting
      // prompt (28s, no answer); thinking=disabled verified same verdict
      // quality in ~2s — make that the default.
      if (this.config.llmThinking === 'adaptive') this.config.llmThinking = 'disabled'
    }
    if ((persisted.configVersion ?? 1) < 5) {
      // v5 (2026-08-28 execution-correctness pass): maker-first fade entries,
      // explicit EV hurdle, and a balance-percentage stake cap.
      this.config.fadeEntryMode = 'maker'
      this.config.fadeMinEdgeCents = 1.5
      this.config.maxBalancePct = 10
    }
    if ((persisted.configVersion ?? 1) < 6) {
      // v6: short-expiry testing window — widen the universe to 3 days (only
      // when still at the old 24h default) and surface the fade horizon floor
      // (previously hardcoded to 60 min).
      if (this.config.maxMinutesToClose === 1440) this.config.maxMinutesToClose = 4320
      this.config.fadeMinHorizonMinutes = this.config.fadeMinHorizonMinutes ?? 60
      this.config.meanReversionMinEntryPrice = this.config.meanReversionMinEntryPrice ?? 0.35
    }
    if ((persisted.configVersion ?? 1) < 7) {
      // v7: quick-win coverage — trade the favorite mirror of the fade band,
      // and run settlement convergence as a paper forward experiment.
      this.config.fadeFavoritesEnabled = true
      this.config.settleEnabled = true
    }
    if ((persisted.configVersion ?? 1) < 8) {
      // v8 (2026-08-29 audit): drawdown kill-switch + settle live gate
      // defaults, and RESET the book lab — its prior baseline mixed up to
      // 10 min of pre-signal drift into the "forward move", so the ~49%/0.2¢
      // record measured the wrong quantity and must not gate the strategy.
      this.config.maxDailyLossPct = this.config.maxDailyLossPct ?? 15
      this.config.settleLiveEnabled = this.config.settleLiveEnabled ?? false
      this.state.bookStats = { observations: 0, hitRate: 0, meanMoveCents: 0, yesSignals: 0, noSignals: 0, hits: 0, sumMove: 0 }
    }
    if ((persisted.configVersion ?? 1) < 9) {
      // v9: horizon-mix cap — long-dated exotics were consuming every slot.
      this.config.maxLongHorizonPositions = this.config.maxLongHorizonPositions ?? 3
    }
    if ((persisted.configVersion ?? 1) < 10) {
      // v10 (user directive 2026-08-30): long positions only by explicit
      // choice — default search horizon drops to 24h.
      if (this.config.maxMinutesToClose === 4320) this.config.maxMinutesToClose = 1440
    }
    if ((persisted.configVersion ?? 1) < 11) {
      // v11 (2026-08-30 research tranche): category-conditional fade — the
      // 353M-trade calibration study shows the bias is politics-concentrated,
      // absent in crypto/finance/entertainment, inverted in near weather.
      this.config.fadeCategoryFilterEnabled = true
    }
    if ((persisted.configVersion ?? 1) < 12) {
      // v12: the per-event cap missed same-asset concentration across series
      // (BTC + SOL×2 + XRP×2 in one settlement hour, 2026-08-30).
      this.config.maxPerUnderlying = this.config.maxPerUnderlying ?? 1
      this.config.stopEntry = this.config.stopEntry ?? false
    }
    if ((persisted.configVersion ?? 1) < 13) {
      // v13 (user directive 2026-08-31): deploy across MORE positions rather
      // than bigger ones. For a testing program this is strictly better —
      // 25 independent samples reach significance far sooner than 10, and
      // smaller per-trade size cuts the variance each result carries. Same
      // total deployment ceiling, spread thinner.
      if (this.config.maxOpenPositions === 10) this.config.maxOpenPositions = 25
      if (this.config.maxBalancePct === 10) this.config.maxBalancePct = 4
      if (this.config.maxDailyTrades === 20 || this.config.maxDailyTrades === 40) this.config.maxDailyTrades = 60
    }
    if ((persisted.configVersion ?? 1) < 14) {
      // v14: act on the counterfactual veto ledger — see fadeCategoryExceptions.
      this.config.fadeCategoryExceptions = this.config.fadeCategoryExceptions ?? ['crypto']
    }
    if ((persisted.configVersion ?? 1) < 15) {
      // v15: disable the favorite fade leg. The 62-day scaled replay measured
      // it at maker -8.42c / taker -10.28c (142 independent events, negative at
      // event- AND day-clustering). Flip it off once; re-enabling stays the
      // operator's choice. The longshot leg is left on for paper only.
      if (this.config.fadeFavoritesEnabled === true) this.config.fadeFavoritesEnabled = false
    }
        if ((persisted.configVersion ?? 1) < 17) {
      // v17: enforce strict overnight risk bounds: disable momentum, volume-spike,
      // book-imbalance, and unhedged favorite fading.
      this.config.momentumEnabled = false
      this.config.volumeSpikeEnabled = false
      this.config.bookEnabled = false
      this.config.fadeFavoritesEnabled = false
      this.persist(17)
    }
    if ((persisted.configVersion ?? 1) < 18) {
      // v18: micro-live research posture. Dead strategies stay off; the one
      // promising registered rule gets one-contract probes with an independent
      // arm. Multi-leg and settlement-source strategies remain observable.
      this.config.momentumEnabled = false
      this.config.volumeSpikeEnabled = false
      this.config.bookEnabled = false
      this.config.crossVenueEnabled = false
      this.config.newsEnabled = false
      this.config.fadeEnabled = false
      this.config.fadeFavoritesEnabled = false
      this.config.fadeCategoryFilterEnabled = true
      this.config.settleEnabled = true
      this.config.settleLiveEnabled = false
      this.config.dutchEnabled = true
      this.config.dutchLiveEnabled = false
      this.config.convergenceEnabled = true
      this.config.convergenceLiveEnabled = true
      this.config.convergenceModeledWinProbability = 0.97
      this.config.convergenceMaxDailyTrades = 3
      this.config.quoterEnabled = true
      this.config.quoterMaxContracts = 1
      this.config.quoterMaxMarkets = 4
      this.config.quoterMaxExposure = 3
      this.config.quoterMaxInventory = 1
      this.config.amountPerTrade = 1
      this.config.maxBalancePct = 2
      this.config.maxPerUnderlying = 1
      this.config.maxLongHorizonPositions = 2
      this.config.maxDailyLossPct = 5
      this.config.takeProfitPct = 0
      this.config.stopLossPct = 0
      this.config.reversalExit = false
      this.config.vetMode = 'rules'
      this.persist(18)
    }
    if ((persisted.configVersion ?? 1) < 19) {
      // v19: new AI is measurable and shadow-only by default. It can never
      // redirect or resize an order; promotion to veto authority is explicit.
      this.config.intelligenceEnabled = true
      this.config.intelligenceMode = 'shadow'
      this.config.intelligencePrimaryModel = 'openai/gpt-5.6-sol'
      this.config.intelligenceSecondaryModel = 'deepseek/deepseek-v4-pro'
      this.config.intelligenceFallbackModel = 'z-ai/glm-5.3'
      this.config.intelligenceMinEdgeCents = 2
      this.persist(19)
    }
    if ((persisted.configVersion ?? 1) < 20) {
      // v20: improve research throughput without increasing per-order size.
      // Resting quote collateral is separate from already-filled weather
      // positions, while a hard total cap prevents unbounded accumulation.
      this.config.quoterMaxContracts = 1
      this.config.quoterMaxMarkets = 4
      this.config.quoterMaxExposure = 3
      this.config.quoterMaxPositionExposure = 25
      this.config.quoterMaxInventory = 1
      this.config.convergenceMaxDailyTrades = 6
      this.persist(20)
    }
    if ((persisted.configVersion ?? 1) < 21) {
      // v21 (review 2026-09-06): the weather quoter is disarmed into shadow
      // mode — the venue's own settlements put it at -$29.07 over four days
      // (-2.6c/contract, adverse selection while the daily extreme forms), and
      // its fill ledger had seen 33 of 653 fills. Convergence returns to
      // shadow: it went live before its pre-registered gate passed and sits
      // at 8W/1L, -32c. Both re-arm from the panel; the gates and the shadow
      // meter accumulate evidence meanwhile.
      this.config.quoterEnabled = false
      this.config.quoterShadowEnabled = true
      this.config.quoterRatchetGate = true
      this.config.quoterRequireIndex = true
      this.config.quoterBlackoutEnabled = true
      this.config.quoterGuardF = 2
      this.config.quoterNearF = 1.5
      this.config.convergenceLiveEnabled = false
      this.persist(21)
    }
    if ((persisted.configVersion ?? 1) < 22) {
      // v22: automation on by default — the ladder evaluates every gate on a
      // timer and moves strategies itself; the nightly review runs at 06Z.
      this.config.ladderEnabled = this.config.ladderEnabled ?? true
      this.config.nightlyReviewEnabled = this.config.nightlyReviewEnabled ?? true
      this.config.nightlyReviewHourUtc = this.config.nightlyReviewHourUtc ?? 6
      this.config.reviewAutoApplyParams = this.config.reviewAutoApplyParams ?? true
      this.persist(22)
    }
    if ((persisted.configVersion ?? 1) < 23) {
      // v23: real-money micro tests by default (operator directive 2026-09-06).
      this.config.ladderMode = this.config.ladderMode ?? 'trade-small'
      this.config.ladderMaxDemotionsBeforeGate = this.config.ladderMaxDemotionsBeforeGate ?? 2
      this.config.ladderAutoAllocateUsd = this.config.ladderAutoAllocateUsd ?? 10
      this.persist(23)
    }
    if ((persisted.configVersion ?? 1) < 25) {
      // v25 (2026-09-06): the daily kill now measures against equity and
      // leaves out settlements of positions entered before the redesign. The
      // trip recorded under the old basis is cleared once; the new rules
      // re-trip on the next scan if the loss stands.
      this.config.killEpochTs = this.config.killEpochTs ?? Date.parse('2026-09-06T12:00:00Z')
      if (this.state.dailyPnl?.date === nowDate() && this.state.dailyPnl.tripped) {
        this.state.dailyPnl.tripped = false
        console.log('[auto-trader] kill switch reset once by the v25 basis change (equity, legacy carve-out); re-trips on the new rules if the loss stands')
      }
      this.persist(25)
    }
    if ((persisted.configVersion ?? 1) < 24) {
      // v24 (operator directive 2026-09-06): let ladder scale-ups take effect
      // (equity cap 25%), keep the venue-wide daily kill behind the per-strategy
      // stops (20%), and fund shard 0 to $20 for weather sizes up to x4.
      if ((this.config.maxBalancePct ?? 0) < 25) this.config.maxBalancePct = 25
      if ((this.config.maxDailyLossPct ?? 0) < 20) this.config.maxDailyLossPct = 20
      if ((this.config.ladderAutoAllocateUsd ?? 0) < 20) this.config.ladderAutoAllocateUsd = 20
      this.persist(24)
    }
    if ((persisted.configVersion ?? 1) < 26) {
      // v26 must be saved after older migrations, so later operator settings
      // survive restarts instead of being reset to the migration's floor.
      this.config.meanReversionMaxHoursToClose = this.config.meanReversionMaxHoursToClose ?? 24
      if ((this.config.maxOpenPositions ?? 0) < 18) this.config.maxOpenPositions = 18
      this.persist(26)
    }
    if ((persisted.configVersion ?? 1) < 27) {
      // v27 (2026-09-18) - the fee-model fix. netCentsOf() divided an already
      // per-contract fee by the contract count a second time, understating the
      // fee by exactly Cx on every graded settlement. netSum/netSq/byEvent/
      // byDay are running SUMS, so a contaminated total cannot be repaired by
      // filtering: it has to be cleared once. n, wins and brierSum never touch
      // the fee term, so hit rate and calibration survive the reset.
      //
      // At C=1 the old code was a no-op (the error is exactly Cx, and 1x is
      // identity), so a strategy that only ever traded single contracts loses
      // valid-but-unrecoverable history here. That is the deliberate trade: a
      // metric that silently mixes two fee bases is worse than one that
      // restarts.
      //
      // perfByStrategy is deliberately NOT touched. That ledger holds cash, and
      // entryFeeDollars() was already correct, so the money was always right -
      // only the quality signal was wrong.
      let cleared = 0
      for (const s of Object.values(this.state.calib.byStrategy)) {
        if (s.netN === undefined && s.netSum === undefined && s.netSq === undefined) continue
        cleared += 1
        delete s.netN
        delete s.netSum
        delete s.netSq
        delete s.byEvent
        delete s.byDay
      }
      if (cleared > 0) {
        console.log(`[auto-trader] v27 fee-model fix: cleared net-cents evidence for ${cleared} strategy(ies); n/wins/brierSum retained`)
      }
      this.persist(27)
    }
  }

  // ---- config/status ----

  /** True when this process started on defaults because the config file was unreadable and set aside (backlog 224). */
  configDefaulted(): boolean {
    return this.store.quarantinedAt !== undefined
  }

  getConfig(): AutoTraderConfig {
    return { ...this.config }
  }

  setConfig(cfg: Partial<AutoTraderConfig>): AutoTraderConfig {
    this.config = { ...this.config, ...cfg }
    this.persist()
    this.restartTimer()
    return this.getConfig()
  }

  setEventHandler(fn: (type: string, payload: unknown) => void): void {
    this.onEvent = fn
  }

  /** Let process-level services (ladder, nightly review) surface their status in the trader panel. */
  setAuxStatus(fn: () => Pick<AutoStatus, 'ladder' | 'lastReview'>): void {
    this.auxStatus = fn
  }

  


  getStatus(): AutoStatus {
    const trades = this.state.openTrades.map((t) => ({ ...t }))
    return {
      running: this.timer !== null,
      liveArmed: this.config.liveArmed,
      dryRun: this.config.dryRun,
      signals: this.state.signals.map((s) => ({ ...s })),
      openTrades: trades,
      pendingOrders: this.state.pendingOrders.map((p) => ({ ...p })),
      dailyTrades: this.state.daily.date === nowDate() ? this.state.daily.count : 0,
      dailyDate: this.state.daily.date,
      scans: this.state.stats.scans,
      lastScanAt: this.state.lastScanAt,
      lastScanMs: this.state.lastScanMs,
      approved: this.state.stats.approved,
      vetoed: this.state.stats.vetoed,
      executed: this.state.stats.executed,
      bookStats: this.state.bookStats ? { ...this.state.bookStats } : undefined,
      perf: this.state.perf
        ? {
            ...this.state.perf,
            winRate: this.state.perf.wins + this.state.perf.losses > 0
              ? this.state.perf.wins / (this.state.perf.wins + this.state.perf.losses)
              : 0
          }
        : undefined,
      perfByStrategy: { ...this.state.perfByStrategy },
      dailyRealizedPnl: this.state.dailyPnl.date === nowDate() ? this.state.dailyPnl.realized : 0,
      killSwitchTripped: this.state.dailyPnl.date === nowDate() && this.state.dailyPnl.tripped,
      venueDailyRealized: this.state.venueDay?.date === nowDate() ? this.state.venueDay.realized : undefined,
      venueDailyDate: this.state.venueDay?.date,
      venueDailySettlements: this.state.venueDay?.date === nowDate() ? this.state.venueDay.settlements : undefined,
      killSource: this.dayRealizedForKill().source,
      openDayMtm: round2(this.openDayMtm()),
      exchangePaused: this.exchangePaused,
      quoter: this.quoter.status(this.quoterCfg()),
      calib: {
        byStrategy: Object.fromEntries(
          Object.entries(this.state.calib.byStrategy).map(([k, v]) => [
            k,
            {
              n: v.n,
              brier: v.n > 0 ? v.brierSum / v.n : 0,
              ...(() => { const c = clusteredNet(v); return c ? { netCents: round2(c.mean), netN: v.netN, netSum: v.netSum, netSq: v.netSq, byDay: v.byDay, netEvents: c.events, netDays: c.days, netCiLo: round2(c.lo), netCiHi: round2(c.hi) } : {} })(),
              buckets: v.buckets.map((b, i) => ({ lo: CALIB_EDGES[i], hi: Math.min(CALIB_EDGES[i + 1], 1), ...b }))
            }
          ])
        ),
        vetoWatching: this.state.calib.vetoWatch.length,
        vetoes: { ...this.state.calib.vetoes },
        vetoesByReason: this.state.calib.vetoesByReason ? { ...this.state.calib.vetoesByReason } : undefined
      },
      sportsShadow: this.state.sportsShadow ? (({ pending: _omit, ...rest }) => rest)(this.state.sportsShadow) : undefined,
      wsStats: this.state.wsStats ? { ...this.state.wsStats } : undefined,
      lastError: this.state.lastError,
      ...(this.auxStatus?.() ?? {})
    }
  }

  reset(): void {
    // Paper only. In live mode this would cancel every real resting order and forget every real position (the
    // settings-page reset has refused this since round 60; the panel's own button did not - audit 2026-09-19, B-01).
    if (this.engine.getExecutionMode() === 'live') {
      throw new Error('Reset is paper-only: switch execution mode to paper first. In live mode a reset would cancel real resting orders and forget real positions.')
    }
    // NEVER swap state out from under an active scan: a reset landing
    // between a tick's awaits made every in-flight entry re-check against an
    // empty ledger — one burst of trades with ALL caps blind (observed
    // 2026-08-29: long-horizon cap overfilled at exactly reset moments).
    if (this.busy) {
      this.resetRequested = true
      return
    }
    this.doReset()
  }

  private doReset(): void {
    // A reset deferred from a busy scan re-checks the mode at the boundary: the switch may have happened since.
    if (this.engine.getExecutionMode() === 'live') {
      console.warn('[auto-trader] deferred reset refused: execution mode is live')
      return
    }
    // Live resting maker orders would keep resting at the venue (up to their
    // 3-day expirations) after the ledger forgets them — cancel first.
    const adapter = this.engine.getAdapter(VENUE)
    for (const p of this.state.pendingOrders) {
      adapter?.cancelOrder(p.orderId).catch(() => undefined)
    }
    const fresh = defaultState()
    // Long-running forward EVIDENCE survives a trade-ledger reset: the book
    // lab (gates the book strategy) and the calibration ledger (grades the
    // fade edge + vetoes). Resetting positions must not wipe experiments.
    fresh.bookStats = this.state.bookStats
    fresh.calib = this.state.calib
    this.state = fresh
    // Route through persist() rather than store.update: this.config holds the
    // DECRYPTED llm/odds keys, and only persist() re-encrypts them on the way
    // out. Writing this.config directly silently downgraded them to cleartext
    // on disk, and decryptValue accepts unprefixed values verbatim, so the key
    // kept working and nothing ever surfaced the downgrade.
    this.persist()
  }

  start(): void {
    this.restartTimer()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      if (this.hunchTimer) { clearInterval(this.hunchTimer); this.hunchTimer = undefined }
      if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = undefined }
      if (this.quoterTimer) { clearInterval(this.quoterTimer); this.quoterTimer = undefined }
      if (this.dutchTimer) { clearInterval(this.dutchTimer); this.dutchTimer = undefined }
      if (this.convergenceTimer) { clearInterval(this.convergenceTimer); this.convergenceTimer = undefined }
      if (this.leadLagTimer) { clearInterval(this.leadLagTimer); this.leadLagTimer = undefined }
      this.timer = null
    }
    if (this.bookTimer) {
      clearInterval(this.bookTimer)
      this.bookTimer = null
    }
  }

  // ---- one full cycle ----

  async tick(): Promise<AutoScanResult> {
    if (!this.config.enabled) {
      return { scanned: 0, candidates: 0, approved: 0, executed: 0, errors: [] }
    }
    const slot = scanSlotVerdict(this.busy, this.busyAt, Date.now())
    if (slot === 'busy') {
      return { scanned: 0, candidates: 0, approved: 0, executed: 0, errors: ['scan already in progress'] }
    }
    if (slot === 'wedged') {
      console.warn(`[auto-trader] scan wedged for ${Math.round((Date.now() - this.busyAt) / 60_000)} min — taking the slot; the stale pass can no longer trade or write the ledger`)
    }
    this.busy = true
    const result: AutoScanResult = { scanned: 0, candidates: 0, approved: 0, executed: 0, errors: [] }
    const started = Date.now()
    this.busyAt = started
    const epoch = ++this.scanEpoch
    // Phase marks (round 92): where a scan's time goes, so the slow phases can be moved off the path on
    // evidence. Cumulative ms since start; phaseDurations() turns them into per-phase figures.
    const marks: [string, number][] = []
    const mark = (name: string): void => {
      marks.push([name, Date.now() - started])
    }
    try {
      // A reset requested mid-scan applies HERE, at a safe boundary.
      if (this.resetRequested) {
        this.resetRequested = false
        this.doReset()
      }
      this.rollDaily()
      await this.gradeVetoes().catch(() => undefined)
      mark('vetoes')
      await this.managePendingOrders(result)
      mark('pending')
      await this.orphanSweep().catch(() => undefined)
      mark('orphans')
      await this.manageExits(result)
      mark('exits')

      const markets = await this.buildUniverse(result)
      mark('universe')
      const data = await this.gatherData(markets)
      mark('data')

      // Sports devig shadow: log sharp-anchor gaps for any sports markets in
      // the universe. Read-only; a failure here must never break the scan.
      const sportsOddsKey = process.env.THE_ODDS_API_KEY?.trim() || this.config.oddsApiKey
      if (this.config.sportsShadowEnabled && sportsOddsKey) {
        try {
          this.state.sportsShadow = this.state.sportsShadow ?? defaultSportsShadow()
          // The anchor's own feed carries every open sports market; the ranked
          // universe keeps three per series and starved it of whole ladders.
          const own = await this.sportsAnchor.kalshiSports(Date.now()).catch(() => [] as VenueMarket[])
          const sportsById = new Map<string, VenueMarket>()
          for (const m of [...markets.filter((m) => isSportsMarket(m)), ...own]) if (m.probability !== undefined) sportsById.set(m.id, m)
          const sportsMkts = [...sportsById.values()]
          this.state.sportsPollAt = this.state.sportsPollAt ?? {}
          const obs = await this.sportsAnchor.poll(
            sportsOddsKey,
            sportsMkts,
            this.state.sportsShadow,
            this.state.sportsPollAt,
            this.config.oddsApiCreditsPerMonth ?? 500
          )
          for (const o of obs) {
            this.episodes?.record('kalshi', 'anchor', o as unknown as Record<string, unknown>)
            this.lastAnchorObs.set(o.kalshiId, o)
          }
          // Final scores grade the pending observations (the anchor's own out-of-sample test).
          const writeGrade = (row: Record<string, unknown>): void => {
            try {
              appendFileSync(join(app.getPath('userData'), 'anchor-grades.jsonl'), JSON.stringify(row) + '\n')
            } catch {
              // telemetry must never break the scan
            }
          }
          await this.sportsAnchor.grade(sportsOddsKey, this.state.sportsShadow, this.state.sportsPollAt, this.config.oddsApiCreditsPerMonth ?? 500, Date.now(), writeGrade)
          // Leagues the scores feed never reports finished (NPB, KBO) grade from
          // Kalshi's own settlement instead: free, and the ledger of record.
          await this.sportsAnchor.gradeFromKalshi(this.state.sportsShadow, this.state.sportsPollAt, Date.now(), writeGrade)
        } catch {
          // shadow only
        }
      }

      // Supplemental SportsGameOdds anchor. Its free plan is object-metered,
      // so one combined, persisted six-hour poll is independent of the main
      // Odds API cadence. It is shadow evidence only and cannot place orders.
      const sportsGameOddsKey = process.env.SPORTSGAMEODDS_API_KEY?.trim()
      if (this.config.sportsShadowEnabled && sportsGameOddsKey) {
        try {
          this.state.sportsShadow = this.state.sportsShadow ?? defaultSportsShadow()
          // The anchor's own feed carries every open sports market; the ranked
          // universe keeps three per series and starved it of whole ladders.
          const own = await this.sportsAnchor.kalshiSports(Date.now()).catch(() => [] as VenueMarket[])
          const sportsById = new Map<string, VenueMarket>()
          for (const m of [...markets.filter((m) => isSportsMarket(m)), ...own]) if (m.probability !== undefined) sportsById.set(m.id, m)
          const sportsMkts = [...sportsById.values()]
          this.state.sportsPollAt = this.state.sportsPollAt ?? {}
          const obs = await this.sportsGameOddsAnchor.poll(
            sportsGameOddsKey,
            sportsMkts,
            this.state.sportsShadow,
            this.state.sportsPollAt
          )
          for (const o of obs) {
            this.episodes?.record('kalshi', 'anchor', o as unknown as Record<string, unknown>)
            this.lastAnchorObs.set(o.kalshiId, o)
          }
        } catch {
          // supplemental shadow source must never interrupt trading
        }
      }

      mark('sports')
      const candidates = await this.computeSignals(markets, data, result)
      mark('signals')
      result.candidates = candidates.length

      const approved: AutoSignal[] = []
      const tallyOf = (strategy: string) => (this.gateTally.byStrategy[strategy] ??= { generated: 0, vetoed: 0, reasons: {} })
      // Numbers vary per signal (prices, counts); collapse them so reasons group.
      const reasonKey = (r: string) => r.replace(/[\d.$]+/g, '#').slice(0, 44)
      for (const sig of candidates.sort((a, b) => b.score - a.score)) {
        const t = tallyOf(sig.strategy)
        t.generated++
        const gate = this.passesGates(sig, data)
        if (!gate.ok) {
          sig.aiVerdict = 'veto'
          sig.aiReason = gate.reason
          this.state.stats.vetoed++
          t.vetoed++
          t.reasons[reasonKey(gate.reason ?? '?')] = (t.reasons[reasonKey(gate.reason ?? '?')] ?? 0) + 1
          this.emit('veto', { strategy: sig.strategy, marketId: sig.marketId, reason: gate.reason })
          continue
        }
        if (sig.score < this.config.minScore) {
          sig.aiVerdict = 'veto'
          sig.aiReason = `score ${sig.score} < ${this.config.minScore}`
          this.state.stats.vetoed++
          t.vetoed++
          t.reasons['score below minScore'] = (t.reasons['score below minScore'] ?? 0) + 1
          this.emit('veto', { strategy: sig.strategy, marketId: sig.marketId, reason: `score ${sig.score}` })
          continue
        }
        approved.push(sig)
      }
      if (++this.gateTally.scans >= GATE_TALLY_SCANS) {
        for (const [strategy, t] of Object.entries(this.gateTally.byStrategy).sort((a, b) => b[1].generated - a[1].generated)) {
          const top = Object.entries(t.reasons).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r, n]) => `${r} x${n}`).join(', ')
          console.log(`[gate] ${strategy}: ${t.generated} generated, ${t.vetoed} vetoed over ${this.gateTally.scans} scans` + (top ? ` (${top})` : ''))
        }
        this.gateTally = { scans: 0, byStrategy: {} }
      }

      // LLM final gate (fails closed: any error ⇒ veto). Vetted in parallel —
      // a reasoning model can take seconds, and the poll interval is short.
      if (this.config.vetMode === 'llm' && approved.length > 0) {
        const budget = Math.max(1, this.config.maxLlmPerScan)
        // Spend the LLM budget on the signals worth vetting: strategy priority,
        // then score, and book-imbalance capped at a third of the budget. Before
        // this, ~30 book-imbalance signals per scan took the first `budget`
        // slots in generation order and every fade/momentum signal was 'deferred'.
        const prio = (sig: AutoSignal): number => ({ dutch: 0, settlement: 1, fade: 2, 'sports-anchor': 2, 'weather-morning': 2, 'flow-follow': 3, news: 3, 'cross-venue': 4, momentum: 5, 'mean-reversion': 5, 'volume-spike': 6, 'book-imbalance': 7 } as Record<string, number>)[sig.strategy] ?? 8
        approved.sort((a, b) => prio(a) - prio(b) || b.score - a.score)
        const bookCap = Math.max(1, Math.ceil(budget / 3))
        const toVet: AutoSignal[] = []
        let bookUsed = 0
        for (const sig of approved) {
          if (toVet.length >= budget) break
          if (sig.strategy === 'book-imbalance') { if (bookUsed >= bookCap) continue; bookUsed++ }
          toVet.push(sig)
        }
        const chosen = new Set(toVet)
        const rest = approved.filter((sig) => !chosen.has(sig))
        const verdicts = await Promise.all(toVet.map((sig) => this.llmGate(sig, data)))
        toVet.forEach((sig, i) => {
          const verdict = verdicts[i]
          if (verdict.approve && verdict.direction === sig.outcome) {
            sig.aiVerdict = 'approve'
            sig.aiConfidence = verdict.confidence
            sig.aiReason = verdict.reason
          } else if (verdict.approve) {
            // The gate vetoes, it never re-authors the trade: an "approval"
            // in the opposite direction is a different trade nobody
            // validated — treat the disagreement itself as a veto.
            sig.aiVerdict = 'veto'
            sig.aiReason = `LLM direction disagrees (${verdict.direction} vs ${sig.outcome}): ${verdict.reason}`
          } else {
            sig.aiVerdict = 'veto'
            sig.aiReason = verdict.reason
          }
        })
        // Vetoed fades enter the counterfactual watch: if vetoed trades win
        // at the base rate anyway, the LLM gate is pure cost — and only this
        // ledger can prove it either way.
        for (const sig of toVet) {
          const legCost = typeof sig.details['legCost'] === 'number' ? (sig.details['legCost'] as number) : undefined
          if (sig.aiVerdict === 'veto' && sig.strategy === 'fade' && legCost !== undefined) {
            const gap = sig.details['priorGap']
            // "Corroborated" = a cross-venue prior existed AND disagreed by
            // more than the fade's own edge threshold, in the direction that
            // would hurt us. Anything else is narrative-only.
            const adverse =
              typeof gap === 'number' &&
              (sig.outcome === 'NO' ? gap > this.config.fadeMinEdgeCents : -gap > this.config.fadeMinEdgeCents)
            this.watchVeto(
              sig.marketId,
              sig.strategy,
              sig.outcome,
              legCost,
              sig.closeTime,
              adverse ? 'llm:corroborated' : gap === undefined ? 'llm:no-prior' : 'llm:narrative'
            )
          }
        }
        // Signals beyond the per-scan LLM budget are NOT silently waved
        // through the "final gate" — they wait for a future scan.
        for (const sig of rest) {
          sig.aiVerdict = 'veto'
          sig.aiReason = 'LLM budget exhausted this scan — deferred'
        }
      } else {
        for (const sig of approved) {
          sig.aiVerdict = 'approve'
          sig.aiReason = 'rules gate'
        }
      }
      mark('gate')
      // Oracle Intelligence Engine: always collect point-in-time counterfactuals
      // in shadow mode. In veto mode it may only block an otherwise-approved
      // order; it can never reverse direction, increase size, or bypass gates.
      if (this.config.intelligenceEnabled && this.config.intelligenceMode !== 'off' && this.config.vetMode !== 'llm' && approved.length > 0) {
        const budget = Math.max(1, this.config.maxLlmPerScan)
        const reviewable = approved.filter((sig) => sig.aiVerdict === 'approve').slice(0, budget)
        const reviews = await Promise.all(reviewable.map((sig) => this.intelligence.review(this.config, {
          signal: sig,
          market: data.marketsById.get(sig.marketId),
          book: data.books.get(sig.marketId),
          balance: data.balance,
          openPositions: this.state.openTrades.length + this.state.pendingOrders.length,
          dailyTradesLeft: Math.max(0, this.config.maxDailyTrades - (this.state.daily.date === nowDate() ? this.state.daily.count : 0)),
          stake: this.stakeFor(data, sig.strategy),
          headlines: data.headlinesByMarket.get(sig.marketId)
        })))
        reviewable.forEach((sig, i) => {
          const r = reviews[i]
          sig.details['intelligenceMode'] = this.config.intelligenceMode ?? 'shadow'
          sig.details['intelligenceEdgeCents'] = Number.isFinite(r.adjudication.conservativeEdgeCents) ? r.adjudication.conservativeEdgeCents : -999
          sig.details['intelligenceModel'] = r.model ?? 'unavailable'
          sig.details['intelligenceLatencyMs'] = r.latencyMs
          sig.details['intelligenceAction'] = r.verdict?.action ?? 'ERROR'
          if (this.config.intelligenceMode === 'veto' && !r.adjudication.eligible) {
            sig.aiVerdict = 'veto'
            sig.aiReason = `Intelligence veto: ${r.adjudication.reason}`
          }
        })
      }

      mark('review')
      // A superseded pass stops HERE, before it can spend money or stamp its stale view over the ledger: a
      // newer tick owns both. Its books are at least SCAN_WEDGE_MS old, which is not a price to trade on.
      if (this.scanEpoch !== epoch) {
        result.errors.push('scan superseded by a newer pass')
        return result
      }
      const finalList = approved.filter((s) => s.aiVerdict === 'approve')
      this.state.stats.approved += finalList.length
      this.state.stats.vetoed += approved.length - finalList.length

      for (const sig of finalList) {
        await this.executeSignal(sig, data, result)
      }
      mark('execute')

      this.state.signals = candidates.slice(0, 40)
      this.state.lastScanAt = started
      this.state.lastScanMs = Date.now() - started
      this.state.stats.scans++
      const phases = phaseDurations(marks)
      this.state.lastScanPhases = phases
      // The measurement: one row per scan in the episodes ledger, where the grader for backlog 87 reads it.
      this.episodes?.record('kalshi', 'scan', { ms: this.state.lastScanMs, phases, scanned: result.scanned, candidates: result.candidates, approved: finalList.length, executed: result.executed })
      // The console line is for outliers and a 1-in-20 sample; at the 108 s baseline a 60 s bar logged every scan.
      if (this.state.lastScanMs > 150_000 || this.state.stats.scans % 20 === 0) {
        const parts = Object.entries(phases).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(' ')
        console.log(`[auto-trader] scan ${(this.state.lastScanMs / 1000).toFixed(1)}s: ${parts} | ${result.scanned} markets, ${result.candidates} candidates, ${finalList.length} approved, ${result.executed} executed`)
      }
      // Real errors win; a stuck-settlement warning fills the slot otherwise so
      // a silently-broken settlement path becomes visible instead of looking
      // like an idle venue (see ledgerAudit).
      if (data.booksFailed) result.errors.push(data.booksFailed)
      this.state.lastError = result.errors[0] ?? stuckSettlements(this.state.openTrades, Date.now()).message
      this.persist()
      this.emit('autoscan', {
        scanned: result.scanned,
        candidates: result.candidates,
        approved: finalList.length,
        executed: result.executed,
        errors: result.errors.slice(0, 5)
      })
    } catch (err) {
      const msg = fmtErr(err)
      result.errors.push(msg)
      if (this.scanEpoch === epoch) {
        this.state.lastError = msg
        this.persist()
      }
    } finally {
      // Only the tick that still owns the slot may release it; a superseded one would hand a live scan's
      // slot away and let a third pass start alongside it.
      if (this.scanEpoch === epoch) this.busy = false
    }
    return result
  }

  // ---- universe ----

  private async buildUniverse(result: AutoScanResult): Promise<VenueMarket[]> {
    const adapter = this.engine.getAdapter(VENUE)
    if (!adapter) throw new Error('Kalshi adapter unavailable')
    const now = Date.now()
    const minMs = this.config.minMinutesToClose * 60_000
    const maxMs = this.config.maxMinutesToClose * 60_000
    const all = await adapter.searchMarkets({
      status: 'open',
      sort: 'ending-soon',
      category: this.config.category || undefined,
      // Nothing past maxMinutesToClose is ever eligible; requesting it only
      // crowds the near-dated strikes out of the page budget.
      maxCloseTime: now + maxMs,
      limit: 1000
    })
    result.scanned = all.length
    const eligible = all.filter((m) => {
      if (m.outcomeType && m.outcomeType !== 'BINARY') return false
      if (m.status !== 'open') return false
      const p = m.probability
      if (p === undefined || p <= 0.01 || p >= 0.99) return false
      if (!m.closeTime || m.closeTime - now < minMs || m.closeTime - now > maxMs) return false
      if ((m.volume ?? 0) < this.config.minVolume) return false
      if ((m.liquidity ?? 0) < this.config.minLiquidity) return false
      if (m.spread === undefined || m.spread > this.config.maxSpreadPct) return false
      return true
    })
    const byVolume = [...eligible].sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
    const main = byVolume.slice(0, this.config.maxMarketsPerScan)
    // The weather and sports carve-outs below must never depend on the fade
    // switch: an early return here starved the settlement ratchet of every
    // temperature market whenever fade was off (found 2026-09-06 — the
    // ratchet had not seen a single weather market all week).
    // The volume ranking is dominated by hot mid-range markets, which crowds
    // longshots out of the scan entirely — the fade strategy then starves.
    // Give the fade band its own allocation on top of the main slice.
    const inMain = new Set(main.map((m) => m.id))
    const inBand = (p: number): boolean =>
      (p >= this.config.fadeMinPrice && p <= this.config.fadeMaxPrice) ||
      (this.config.fadeFavoritesEnabled && p >= 1 - this.config.fadeMaxPrice && p <= 1 - this.config.fadeMinPrice)
    // Rank the fade allocation by SOONEST CLOSE, not 24h volume. The strategy
    // already scores candidates by edge-per-day (capital velocity), and volume
    // ranking undid that one level up: widening the horizon to 3 days filled
    // all 40 slots with big far-dated sports props and dropped every near,
    // low-volume crypto tail — the funnel collapsed from 13 signals to 1.
    const fadeExtra = (this.config.fadeEnabled ? [...eligible] : [])
      .filter(
        (m) =>
          !inMain.has(m.id) &&
          m.probability !== undefined &&
          inBand(m.probability) &&
          (m.closeTime ?? 0) - now >= this.config.fadeMinHorizonMinutes * 60_000
      )
      .sort((a, b) => (a.closeTime ?? Infinity) - (b.closeTime ?? Infinity))
      .slice(0, this.config.maxMarketsPerScan)
    // Weather-ratchet carve-out: temperature markets bypass the volume/
    // liquidity/spread gates entirely — their books are structurally thin
    // ($0-80 top-of-book is normal), which starves the ratchet if gated.
    // Thinness is acceptable here because ratchet entries are mechanical
    // certainties, paper fills walk real depth honestly, and entry still
    // requires a priced market leaving ≥4¢ of edge.
    const seen = new Set([...main, ...fadeExtra].map((m) => m.id))
    const weatherExtra: VenueMarket[] = []
    if (this.config.settleEnabled) {
      // Select by EVENT, not by market: each ladder has 6-8 brackets, so a
      // flat market cap covered ~3 cities and starved the other trackers.
      const perEvent = new Map<string, number>()
      for (const m of all) {
        if (seen.has(m.id)) continue
        if (m.outcomeType && m.outcomeType !== 'BINARY') continue
        if (m.status !== 'open') continue
        const p = m.probability
        if (p === undefined || p <= 0.01 || p >= 0.99) continue
        if (m.closeTime === undefined || m.closeTime - now < minMs || m.closeTime - now > maxMs) continue
        // Between-brackets are most of every temperature ladder; the ratchet
        // decides them (NO once the extreme clears the top/bottom boundary),
        // so they belong in the carve-out too. The old strikeOf() gate dropped
        // them, which is why the settlement strategy never produced a trade.
        const isBetween = m.strikeType === 'between' && typeof m.floorStrike === 'number' && typeof m.capStrike === 'number'
        if (tempSeriesKind(m) === null || (strikeOf(m) === null && !isBetween)) continue
        const ev = m.eventTicker ?? m.id
        const n = perEvent.get(ev) ?? 0
        if (n >= 8) continue
        if (n === 0 && perEvent.size >= 6) continue
        perEvent.set(ev, n + 1)
        weatherExtra.push(m)
      }
    }
    // Sports carve-out for the sharp-anchor shadow: normal quality gates but
    // a WIDER close window (48h) — Kalshi stamps game markets with close
    // times well past the game itself, so the 24h universe never sees them.
    // Shadow-only exposure: >24h ENTRIES stay blocked by the horizon cap.
    const seen2 = new Set([...main, ...fadeExtra, ...weatherExtra].map((m) => m.id))
    const sportsExtra = !this.config.sportsShadowEnabled
      ? []
      : all
          .filter(
            (m) =>
              !seen2.has(m.id) &&
              isSportsMarket(m) &&
              (!m.outcomeType || m.outcomeType === 'BINARY') &&
              m.status === 'open' &&
              m.probability !== undefined &&
              m.probability > 0.01 &&
              m.probability < 0.99 &&
              m.closeTime !== undefined &&
              m.closeTime - now >= minMs &&
              // Kalshi's game close-stamps run days past the game — a whole
              // week stays visible to the SHADOW (never to entries).
              m.closeTime - now <= 7 * 1440 * 60_000 &&
              (m.volume ?? 0) >= this.config.minVolume &&
              (m.liquidity ?? 0) >= this.config.minLiquidity &&
              m.spread !== undefined &&
              m.spread <= this.config.maxSpreadPct
          )
          // Liquidity-ranked so the big leagues outrank esports fillers.
          .sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0))
          .slice(0, 30)
    // Sibling completion: the anchor matches a game by finding BOTH teams
    // inside one event, so admitting only the liquid side of a matchup makes
    // the event unmatchable. Pull in the other side of every sports event we
    // already took, even if it missed the liquidity cut.
    if (sportsExtra.length > 0) {
      const evs = new Set(sportsExtra.map((m) => m.eventTicker).filter(Boolean))
      const have = new Set([...main, ...fadeExtra, ...weatherExtra, ...sportsExtra].map((m) => m.id))
      for (const m of all) {
        if (have.has(m.id)) continue
        if (!m.eventTicker || !evs.has(m.eventTicker)) continue
        if (m.status !== 'open' || m.probability === undefined) continue
        sportsExtra.push(m)
      }
    }
    return [...main, ...fadeExtra, ...weatherExtra, ...sportsExtra]
  }

  // ---- data gathering ----

  private async gatherData(markets: VenueMarket[]): Promise<ScanData> {
    const adapter = this.engine.getAdapter(VENUE)!
    const now = Math.floor(Date.now() / 1000)
    const tickers = markets.map((m) => m.id)
    const data: ScanData = {
      candles1m: {},
      candles1h: {},
      trades: new Map(),
      books: new Map(),
      headlinesByMarket: new Map(),
      live: new Map(),
      marketsById: new Map(markets.map((m) => [m.id, m])),
      balance: undefined
    }

    if (adapter.getCandles) {
      // The candidate recorder has its own term: it must keep seeing candles while the momentum arm is
      // in cool-down, and mean-reversion - the only other reader - can be switched off at any time.
      const recCandidates = momentumCandidatesActive()
      if (this.config.momentumEnabled || this.config.meanReversionEnabled || recCandidates) {
        // One fetch feeds both candle readers and the recorder; take the longest window.
        const lookbackMin = Math.max(
          this.config.momentumEnabled || recCandidates ? this.config.momentumWindowMinutes : 0,
          this.config.meanReversionEnabled ? this.config.meanReversionWindowMinutes : 0
        )
        data.candles1m = await adapter
          .getCandles(tickers, 1, now - (lookbackMin + 5) * 60, now)
          .catch(() => ({}))
      }
      if (this.config.volumeSpikeEnabled) {
        data.candles1h = await adapter
          .getCandles(tickers, 60, now - (this.config.volumeSpikeBaselineMinutes + 60) * 60, now)
          .catch(() => ({}))
      }
    }

    // Books are one batch call and feed the book signal, fade EV math, and
    // execution limits — always fetch them for the universe.
    if (adapter.getOrderBooks && tickers.length > 0) {
      const books = await adapter.getOrderBooks(tickers).catch((err) => {
        console.warn('[auto-trader] orderbooks fetch failed:', err instanceof Error ? err.message : String(err))
        return []
      })
      // An empty book map for a non-empty universe is a FAILURE, not a quiet
      // market: every fade candidate needs a two-sided book, so this reads as
      // "no signals" and hides a broken fetch (it did, for a whole horizon).
      if (books.length === 0) data.booksFailed = `orderbooks: 0 of ${tickers.length} fetched`
      for (const b of books) {
        data.books.set(b.marketId, b)
        this.recordBook(b)
      }
      // WebSocket runs in SHADOW: it maintains its own books from the live
      // socket and every REST fetch grades them. REST stays authoritative
      // until that comparison earns the promotion — the two silent failure
      // modes (wrong field names → empty book, inverted price convention →
      // mirrored book) both surface as disagreement here and nowhere else.
      this.updateWs(tickers, books)
    }

    if (adapter.getRecentTrades && (this.config.volumeSpikeEnabled || this.config.vetMode === 'llm')) {
      const tapeMarkets = markets.slice(0, 12)
      for (let offset = 0; offset < tapeMarkets.length; offset += 4) {
        await Promise.all(tapeMarkets.slice(offset, offset + 4).map(async m => {
          const trades = await adapter.getRecentTrades!(m.id, 1000, now - this.config.volumeSpikeBaselineMinutes * 60)
          .catch(() => [])
          data.trades.set(m.id, trades)
        }))
      }
    }

    if (this.config.newsEnabled || this.config.vetMode === 'llm') {
      await this.gatherHeadlines(markets, data)
    }

    if (this.config.settleEnabled && adapter.getLiveData) {
      const settleMarkets = markets.filter((m) => m.closeTime && m.closeTime - Date.now() <= this.config.settleMaxMinutesToClose * 60_000)
      for (const m of settleMarkets.slice(0, 6)) {
        const ev = m.eventTicker
        if (!ev) continue
        const ld = await adapter.getLiveData(ev).catch(() => undefined)
        if (ld) data.live.set(m.id, { latest: ld.latest, staleMinutes: ld.staleMinutes, type: ld.type })
      }
      // Weather ratchet sampling: daily-high/low temperature events get their
      // index read ALL DAY (not just near close) — the day's running extreme
      // is monotone, so brackets it clears are mechanically decided hours
      // before settlement. One read per event per 5 min; the extreme persists
      // so a restart cannot un-bank a decided bracket.
      const now2 = Date.now()
      const tempEvents = new Map<string, VenueMarket>()
      for (const m of markets) {
        if (m.eventTicker && tempSeriesKind(m) && !tempEvents.has(m.eventTicker)) tempEvents.set(m.eventTicker, m)
      }
      this.state.weatherRatchet = this.state.weatherRatchet ?? {}
      for (const [ev] of [...tempEvents].slice(0, 8)) {
        if (now2 - (this.weatherFetchAt.get(ev) ?? 0) < 5 * 60_000) continue
        const eventDate = parseEventDate(ev)
        const tz = stationTimeZone(ev)
        if (!eventDate || !tz || eventDayStatus(eventDate, tz, now2) !== 'active') continue
        this.weatherFetchAt.set(ev, now2)
        const ld = await adapter.getLiveData(ev).catch(() => undefined)
        if (!ld || ld.latest === undefined || (ld.staleMinutes ?? 0) > 30) continue
        // Bind observations to the contract's measurement day in the station's
        // time zone. The city index serves the last few hours regardless of
        // which event asked for it: without this filter tomorrow's event
        // (listed 24–48h out) banked TODAY's extreme and read its brackets as
        // decided, and a series crossing local midnight leaked yesterday's.
        // Folding the returned history is still right — a late start can only
        // MISS extremes inside the day, never invent one.
        const obs = bankObservations(ld.series ?? [], eventDate, tz)
        if (!obs) continue
        const r = (this.state.weatherRatchet[ev] = this.state.weatherRatchet[ev] ?? { hi: obs.hi, lo: obs.lo, at: now2 })
        r.hi = Math.max(r.hi, obs.hi)
        r.lo = Math.min(r.lo, obs.lo)
        r.at = now2
      }
      // Events die with their day — drop trackers not refreshed in 48h.
      for (const [ev, r] of Object.entries(this.state.weatherRatchet)) {
        if (now2 - r.at > 48 * 3600_000) delete this.state.weatherRatchet[ev]
      }
    }

    try {
      const pf = await this.engine.getPortfolio(VENUE)
      if (pf.mode === 'live' && !pf.account) {
        // The venue balance fetch failed. Falling back to totalValue (open
        // positions only, no cash) understated balance and let the daily
        // loss kill switch trip on a tiny loss. Unknown is not zero.
        data.balance = undefined
        data.equity = undefined
        data.balanceByShard = undefined
      } else {
        data.balance = pf.account?.balance ?? pf.totalValue
        data.equity = pf.totalValue
        data.balanceByShard = pf.account?.balanceByShard
      }
    } catch {
      data.balance = undefined
      data.equity = undefined
    }
    if (adapter.getExchangeStatus) {
      data.tradingActive = (await adapter.getExchangeStatus().catch(() => ({ tradingActive: true }))).tradingActive
      this.exchangePaused = data.tradingActive === false
      this.exchangeCheckedAt = Date.now()
    }
    this.lastEquity = data.equity ?? data.balance
    // Keep the venue-day ledger fresh for the kill switch (throttled inside).
    await this.refreshVenueDay()
    return data
  }

  private async gatherHeadlines(markets: VenueMarket[], data: ScanData): Promise<void> {
    const now = Date.now()
    if (!this.newsCache || now - this.newsCache.at > 120_000) {
      const items: NewsItem[] = []
      const batches = await Promise.all(this.config.newsTopics.slice(0, 6).map(topic => fetchNews(topic, 8).catch(() => [])))
      for (const batch of batches) {
        for (const it of batch) {
          if (!items.some((x) => x.title === it.title)) items.push(it)
        }
      }
      this.newsCache = { at: now, items }
    }
    const fresh = this.newsCache.items.filter((h) => now - h.publishedAt < 30 * 60_000)
    for (const m of markets) {
      const mt = titleTokens(m)
      if (mt.length < 2) continue
      for (const h of fresh) {
        const sim = jaccard(mt, norm(h.title))
        if (sim >= this.config.newsMinSimilarity) {
          const arr = data.headlinesByMarket.get(m.id) ?? []
          arr.push(h.title)
          data.headlinesByMarket.set(m.id, arr)
        }
      }
    }
  }

  // ---- signals ----

  private async computeSignals(markets: VenueMarket[], data: ScanData, result: AutoScanResult): Promise<AutoSignal[]> {
    const out: AutoSignal[] = []
    // In-play sports markets swing every pitch: candle momentum, volume spikes
    // and book imbalance there are noise plus taker fees (the 2026-09-06 MLB
    // churn). Those three only look at markets more than six hours from close.
    const calm = markets.filter((m) => !(isSportsMarket(m) && (m.closeTime ?? Number.POSITIVE_INFINITY) - Date.now() < 6 * 3600_000))
    // Observation only, and before the enabled check: every momentum candidate window, under the flat bar
    // or over it, so the population a log-odds bar would admit is measured before it is traded (§76).
    this.recordMomentumCandidates(calm, data)
    if (this.config.momentumEnabled) out.push(...this.momentumSignals(calm, data))
    if (this.config.meanReversionEnabled) {
      // Momentum and mean reversion read the same move in opposite
      // directions. Both firing on one market would buy YES and NO of the
      // same contract and pay two sets of fees for a guaranteed loss, so
      // momentum (the older arm) keeps the market and the fade stands down.
      const taken = new Set(out.filter((x) => x.strategy === 'momentum').map((x) => x.marketId))
      out.push(...this.meanReversionSignals(calm, data).filter((x) => !taken.has(x.marketId)))
    }
    if (this.config.volumeSpikeEnabled) out.push(...this.volumeSpikeSignals(calm, data))
    if (this.config.bookEnabled) out.push(...this.bookSignals(calm, data))
    if (this.config.crossVenueEnabled) out.push(...(await this.crossVenueSignals(markets, result)))
    if (this.config.newsEnabled) out.push(...this.newsSignals(markets, data))
    if (this.config.dutchEnabled) out.push(...(await this.dutchSignals()))
    if (this.config.fadeEnabled) out.push(...this.fadeSignals(markets, data))
    if (this.config.settleEnabled) {
      out.push(...this.settleSignals(markets, data))
      out.push(...this.ratchetSignals(markets))
    }
    if (this.config.sportsAnchorLiveEnabled) out.push(...(await this.anchorSignals(data)))
    if (this.config.consensusEnabled) out.push(...(await this.consensusSignals(data)))
    if (this.config.flowFollowEnabled) out.push(...(await this.flowSignals(markets)))
    if (this.config.weatherMorningEnabled) {
      // The quoter rests two-sided on the same brackets. One market must not
      // carry both a resting quote and a taker entry from this arm: that pays
      // the taker fee to trade against our own maker side.
      const quoted = this.quoter.restingMarketIds()
      out.push(...(await this.morningForecastSignals(markets, data)).filter((x) => !quoted.has(x.marketId)))
    }
    return out
  }

  /**
   * Flow-follow: unusually large or one-sided taker flow in the last fifteen
   * minutes marks a participant who believes they know the outcome; follow
   * their side. Budgeted to the twenty most active markets per scan (one
   * public print read each, cached a minute). Maker entry by default.
   */
  private async flowSignals(markets: VenueMarket[]): Promise<AutoSignal[]> {
    const adapter = this.engine.getAdapter(VENUE)
    if (!adapter?.getRecentTrades) return []
    const out: AutoSignal[] = []
    const now = Date.now()
    const cfg = {
      ...FLOW_DEFAULTS,
      minLargestCount: this.config.flowMinLargestCount ?? FLOW_DEFAULTS.minLargestCount,
      sizeMultiple: this.config.flowSizeMultiple ?? FLOW_DEFAULTS.sizeMultiple,
      minNotionalDollars: this.config.flowMinNotional ?? FLOW_DEFAULTS.minNotionalDollars
    }
    const ranked = markets
      .filter((m) => m.probability !== undefined && m.probability > 0.05 && m.probability < 0.95)
      .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
      .slice(0, 20)
    const observations = new Map<string, Awaited<ReturnType<FlowMonitor['read']>>>()
    for (let offset = 0; offset < ranked.length; offset += 4) {
      await Promise.all(ranked.slice(offset, offset + 4).map(async m => {
        observations.set(m.id, await this.flowMonitor.read(adapter, m.id, now))
      }))
    }
    for (const m of ranked) {
      const s = observations.get(m.id)
      if (!s) continue
      const v = flowVerdict(s, cfg)
      if (!v.toxic || !v.side) continue
      out.push(
        this.makeSignal(m, 'flow-follow', v.side, Math.min(100, 40 + s.largestCount), Math.min(1, Math.max(s.yesShare, 1 - s.yesShare)), {
          largestCount: s.largestCount,
          medianCount: s.medianCount,
          notional: round2(s.notional),
          yesShare: round4(s.yesShare),
          prints: s.n,
          why: v.reason
        })
      )
    }
    return out
  }

  /**
   * Sports sharp-anchor: buy the Kalshi side that the devigged sportsbook
   * consensus says is cheap (gap = Kalshi mid − fair, in cents). Observations
   * come from the shadow poll (The Odds API, SportsGameOdds) and are used only
   * while fresh. Maker entry by default; the calibration ledger grades the
   * consensus probability like any other modeled win probability.
   */
  private anchorMarketCache = new Map<string, { at: number; m: VenueMarket }>()

  private async anchorSignals(data: ScanData): Promise<AutoSignal[]> {
    const out: AutoSignal[] = []
    const minGap = this.config.sportsAnchorMinGapCents ?? 3
    const now = Date.now()
    const adapter = this.engine.getAdapter(VENUE)
    let injected = 0
    for (const o of this.lastAnchorObs.values()) {
      // In play, a line is stale in minutes; pre-game it holds for hours.
      const inPlay = o.eventStartsAt !== undefined && o.eventStartsAt < now
      if (now - o.ts > (inPlay ? 10 * 60_000 : 2 * 3600_000)) continue
      if (Math.abs(o.gapCents) < minGap) continue
      // The observation may be on a market outside the ranked universe: fetch
      // it (and its book, for the maker entry) and add both to the scan data.
      let m = data.marketsById.get(o.kalshiId)
      if (!m) {
        if (!adapter || injected >= 10) continue
        const cached = this.anchorMarketCache.get(o.kalshiId)
        if (cached && now - cached.at < 10 * 60_000) m = cached.m
        else {
          m = await adapter.getMarket(o.kalshiId).catch(() => undefined)
          if (!m) continue
          this.anchorMarketCache.set(o.kalshiId, { at: now, m })
        }
        data.marketsById.set(m.id, m)
        if (adapter.getOrderBook && !data.books.has(m.id)) {
          const book = await adapter.getOrderBook(m.id).catch(() => undefined)
          if (book) data.books.set(m.id, book)
        }
        injected++
      }
      if (m.probability === undefined || m.probability <= 0.03 || m.probability >= 0.97) continue
      const outcome: 'YES' | 'NO' = o.gapCents > 0 ? 'NO' : 'YES'
      const winProb = outcome === 'YES' ? o.fairProb : 1 - o.fairProb
      out.push(
        this.makeSignal(m, 'sports-anchor', outcome, Math.min(100, Math.abs(o.gapCents) * 10), Math.min(1, Math.abs(o.gapCents) / 10), {
          gapCents: round2(o.gapCents),
          fairProb: round4(o.fairProb),
          kalshiMid: round4(o.kalshiMid),
          bookmaker: o.bookmaker,
          sportKey: o.sportKey,
          winProb: round4(winProb)
        })
      )
    }
    return out
  }

  /** The pre-registered consensus rule, with the config as the (unchanged) carrier. */
  private consensusRule(): ConsensusRule {
    const c = this.config
    return {
      maxSignalAgeHours: c.consensusMaxSignalAgeHours ?? CONSENSUS_RULE.maxSignalAgeHours,
      minHoursToClose: c.consensusMinHoursToClose ?? CONSENSUS_RULE.minHoursToClose,
      maxHoursToClose: c.consensusMaxHoursToClose ?? CONSENSUS_RULE.maxHoursToClose,
      minPrice: c.consensusMinPrice ?? CONSENSUS_RULE.minPrice,
      maxPrice: c.consensusMaxPrice ?? CONSENSUS_RULE.maxPrice,
      maxDriftCents: c.consensusMaxDriftCents ?? CONSENSUS_RULE.maxDriftCents
    }
  }

  private consensusLedger(): { markets: Record<string, number>; sources: Record<string, number> } {
    this.state.consensusActed = this.state.consensusActed ?? { markets: {}, sources: {} }
    this.state.consensusActed.markets = this.state.consensusActed.markets ?? {}
    this.state.consensusActed.sources = this.state.consensusActed.sources ?? {}
    return this.state.consensusActed
  }

  /**
   * Record that a consensus entry was PLACED, so the market and its Polymarket
   * source market are both closed to this arm. Called from the execution path
   * rather than from signal generation: a signal that the LLM gate or a
   * capacity cap refused was never acted on and must stay available.
   */
  private noteConsensusEntry(sig: AutoSignal): void {
    const led = this.consensusLedger()
    const now = Date.now()
    led.markets[sig.marketId] = now
    const src = sig.details['source']
    if (typeof src === 'string' && src) led.sources[src] = now
    // A Polymarket market resolves within weeks; a year of tickers in the
    // state file is dead weight that gets written on every scan.
    const cutoff = now - 30 * 24 * 3600_000
    for (const [k, at] of Object.entries(led.markets)) if (at < cutoff) delete led.markets[k]
    for (const [k, at] of Object.entries(led.sources)) if (at < cutoff) delete led.sources[k]
  }

  /**
   * Polymarket smart-money consensus, taken on Kalshi at the ask.
   * Pre-registered 2026-09-13 (docs/PREREGISTERED-polymarket-consensus.md);
   * build-queue item 13. The signal is produced by a read-only hourly shadow,
   * so this arm only reads a file and prices the match — it never asks
   * Polymarket for anything.
   */
  private async consensusSignals(data: ScanData): Promise<AutoSignal[]> {
    const out: AutoSignal[] = []
    const now = Date.now()
    const rule = this.consensusRule()
    const rows = this.consensusFeed.read(now, rule)
    const led = this.consensusLedger()
    const adapter = this.engine.getAdapter(VENUE)
    const refused: Record<string, number> = {}
    let injected = 0
    for (const row of rows) {
      const ticker = row.kalshi?.market
      if (!ticker) continue
      // Winner markets only, on the side the wallets took. Until 2026-09-19 the recorder's single-market fallback
      // matched fixtures to "both teams to score", first-inning and second-half markets and every entry was YES
      // regardless of the wallets' outcome: 11 of 12 open consensus positions were such markets (external review,
      // Gemini Flash F-03). Rows without a side predate the fix.
      const side = row.kalshi?.side
      if (!side || CONSENSUS_NOT_WINNER.test(ticker)) {
        refused['not-winner-market'] = (refused['not-winner-market'] ?? 0) + 1
        continue
      }
      // One entry per market, and one open position per Polymarket source
      // market, so a single consensus event cannot become five correlated bets.
      if (led.markets[ticker] !== undefined) {
        refused['already-entered'] = (refused['already-entered'] ?? 0) + 1
        continue
      }
      if (led.sources[row.conditionId] !== undefined) {
        refused['source-entered'] = (refused['source-entered'] ?? 0) + 1
        continue
      }
      const ageHours = consensusAgeHours(row, now)
      // Age is the one gate that needs no venue call; check it before spending
      // a market fetch on a signal that is already too old to take.
      if (ageHours > rule.maxSignalAgeHours) {
        refused['stale-signal'] = (refused['stale-signal'] ?? 0) + 1
        continue
      }
      let m = data.marketsById.get(ticker)
      if (!m) {
        if (!adapter || injected >= 10) {
          refused['fetch-budget'] = (refused['fetch-budget'] ?? 0) + 1
          continue
        }
        const cached = this.consensusMarketCache.get(ticker)
        if (cached && now - cached.at < 10 * 60_000) m = cached.m
        else {
          m = await adapter.getMarket(ticker).catch(() => undefined)
          if (!m) {
            refused['market-gone'] = (refused['market-gone'] ?? 0) + 1
            continue
          }
          this.consensusMarketCache.set(ticker, { at: now, m })
          // The budget bounds VENUE CALLS, so only a real fetch spends it. Counting cache hits too (as
          // this did until 2026-09-18) froze the window: the feed lists signals in a stable order, the
          // first ten were injected every scan, and rows 11+ were refused 'fetch-budget' on every scan -
          // 51-75 of ~95 fresh signals a scan never evaluated at all.
          injected++
        }
        // A signal under 24 h old can point at a match that has already played: 16 of 24 injected markets
        // probed on 2026-09-18 were `finalized`. Refuse those here, before spending a book read on a dead
        // market (they were reaching the ask check as 'no-ask', ~45 wasted venue reads a scan).
        if ((m.status !== undefined && m.status !== 'open') || (m.closeTime !== undefined && m.closeTime <= now)) {
          refused['market-closed'] = (refused['market-closed'] ?? 0) + 1
          continue
        }
        data.marketsById.set(m.id, m)
        if (adapter.getOrderBook && !data.books.has(m.id)) {
          const book = await adapter.getOrderBook(m.id).catch(() => undefined)
          if (book) data.books.set(m.id, book)
        }
      }
      // The pre-registration prices the entry at the ASK we would actually pay,
      // never at a mid or at the ask the shadow saw an hour ago.
      // A NO entry pays the NO ask, which is one minus the best YES bid.
      const book = data.books.get(m.id)
      const ask = side === 'NO' ? (book?.bids[0]?.price === undefined ? undefined : 1 - book.bids[0].price) : book?.asks[0]?.price
      const hoursToClose = m.closeTime === undefined ? 0 : (m.closeTime - now) / 3600_000
      const why = consensusRefusal({ market: ticker, ask, polyPrice: row.poly_price, ageHours, hoursToClose }, rule)
      if (why) {
        refused[why] = (refused[why] ?? 0) + 1
        continue
      }
      const wallets = row.n_wallets ?? 3
      const driftCents = row.poly_price === undefined || row.poly_price === null ? 0 : ((ask as number) - row.poly_price) * 100
      out.push(
        this.makeSignal(m, 'consensus', side, Math.min(100, 50 + wallets * 5), Math.min(1, wallets / 10), {
          wallets,
          polyPrice: round4(row.poly_price ?? 0),
          ask: round4(ask as number),
          driftCents: round2(driftCents),
          ageHours: round2(ageHours),
          hoursToClose: round2(hoursToClose),
          source: row.conditionId,
          side: row.outcome
        })
      )
    }
    // A silent arm must say WHY it is silent: the 2026-09-13 lesson from the
    // shadows is that "0" without a reason is how a broken feed hides for days.
    const feedError = this.consensusFeed.error()
    console.log(
      `[consensus] ${rows.length} fresh signals, ${out.length} candidates` +
        (Object.keys(refused).length ? ` | refused ${JSON.stringify(refused)}` : '') +
        (feedError ? ` | ${feedError}` : '')
    )
    return out
  }

  /**
   * Weather settlement ratchet: a daily-high market is monotone — once the
   * station's running max clears a strike (with a guard band for the CLI's
   * 6-hour-maxima corrections), brackets below it are mechanically decided
   * yet often still quoted at 90-96¢. The mirror holds for daily lows via
   * the running min. This only ever decides in the monotone direction: an
   * uncleared strike is NOT evidence of NO — the extreme may still arrive.
   * Rides the 'settlement' strategy (paper-only until settleLiveEnabled).
   */
  private ratchetSignals(markets: VenueMarket[]): AutoSignal[] {
    const out: AutoSignal[] = []
    const now = Date.now()
    for (const m of markets) {
      const kind = tempSeriesKind(m)
      if (!kind || !m.eventTicker) continue
      const r = this.state.weatherRatchet?.[m.eventTicker]
      // Reading must be fresh enough that the banked extreme is trustworthy.
      if (!r || now - r.at > 45 * 60_000) continue
      // Structured strike fields cover single-threshold AND between brackets
      // (the bulk of the temperature ladders); the title parse is the fallback.
      const parsed = strikeOf(m)
      const direction =
        ratchetBracketVerdict(kind, m.strikeType, m.floorStrike, m.capStrike, r.hi, r.lo, RATCHET_GUARD_F) ??
        (parsed ? ratchetVerdict(kind, parsed.dir, parsed.strike, r.hi, r.lo, RATCHET_GUARD_F) : null)
      if (!direction) continue
      const p = m.probability ?? 0
      // Only enter while the market still leaves edge on our (certain) side.
      if (direction === 'YES' && p > 0.96) continue
      if (direction === 'NO' && p < 0.04) continue
      const observed = round2(kind === 'high' ? r.hi : r.lo)
      // A decided bracket the market disagrees with, or one behind a wide
      // book, is refused (see ratchetEntryBlock). Both are recorded: the arm
      // used to fire and refuse in complete silence.
      const refused = ratchetEntryBlock(direction, p, m.spread)
      if (refused) {
        // A standing refusal is one fact, not one per scan: note it when the
        // reason changes or once an hour. Unthrottled this wrote ~2,000 lines
        // a day for two Boston brackets whose verdict never moved.
        const seen = this.ratchetNoteAt.get(m.id)
        if (!seen || seen.reason !== refused || now - seen.at > 3600_000) {
          this.ratchetNoteAt.set(m.id, { reason: refused, at: now })
          this.episodes?.record('kalshi', 'ratchet-refused', {
            marketId: m.id,
            direction,
            observed,
            yesProb: round2(p),
            spread: m.spread !== undefined ? round2(m.spread) : undefined,
            reason: refused
          })
          console.warn(`[ratchet] refused ${m.id} ${direction} (${kind} extreme ${observed}): ${refused}`)
        }
        continue
      }
      this.ratchetNoteAt.delete(m.id)
      console.log(`[ratchet] ${m.id} ${direction}: ${kind} extreme ${observed} clears the bracket; market ${Math.round(p * 100)}c YES, spread ${m.spread !== undefined ? Math.round(m.spread * 100) : '?'}c`)
      out.push(this.makeSignal(m, 'settlement', direction, 92, 0.95, {
        ratchet: kind,
        observed: round2(kind === 'high' ? r.hi : r.lo),
        strike: round2(parsed?.strike ?? m.floorStrike ?? m.capStrike ?? 0),
        bracket: m.strikeType ?? 'parsed',
        guardF: RATCHET_GUARD_F,
        readingAgeMin: Math.round((now - r.at) / 60_000)
      }))
    }
    return out
  }

  private momentumSignals(markets: VenueMarket[], data: ScanData): AutoSignal[] {
    const out: AutoSignal[] = []
    const windowSec = this.config.momentumWindowMinutes * 60
    const cutoff = Math.floor(Date.now() / 1000) - windowSec
    for (const m of markets) {
      const candles = (data.candles1m[m.id] ?? []).filter((c) => c.endTs >= cutoff)
      if (candles.length < Math.max(2, Math.floor(this.config.momentumWindowMinutes / 2))) continue
      const priceAt = (c: MarketCandle): number | undefined => c.close ?? midOf(c.bidClose, c.askClose)
      const newest = priceAt(candles[candles.length - 1])
      const oldest = priceAt(candles[0])
      if (newest === undefined || oldest === undefined) continue
      // Point move, not relative: a 4.5¢→5¢ tick is one cent of information,
      // not an 11% trend. Relative moves on near-zero prices are noise.
      const move = newest - oldest
      const thr = this.config.momentumMinMovePct
      if (Math.abs(move) < thr) continue
      // Confirmation (2026-09-07): the move must have TRADED (volume in at
      // least three of the window's candles) and held its direction at
      // mid-window. The quote-only version chased every tick of an in-play
      // game and was stopped after 20 trades.
      if (candles.filter((c) => (c.volume ?? 0) > 0).length < 3) continue
      const mid = priceAt(candles[Math.floor(candles.length / 2)])
      if (mid === undefined || (move > 0 ? mid <= oldest : mid >= oldest)) continue
      const direction = move > 0 ? 'YES' : 'NO'
      const score = Math.min(100, Math.round(50 + (Math.abs(move) / thr) * 30))
      const confidence = Math.min(1, Math.abs(move) / (2 * thr))
      out.push(this.makeSignal(m, 'momentum', direction, score, confidence, {
        movePoints: round2(move * 100),
        windowMin: this.config.momentumWindowMinutes,
        priceFrom: round2(oldest),
        priceTo: round2(newest)
      }))
    }
    return out
  }

  /**
   * Feeds the candidate recorder the same calm universe and candles `momentumSignals` reads, plus the
   * capacity facts the arm would gate on, read from the same state `entryBlocked` reads. Per-market
   * try/catch: a bad market costs one row, never the scan (the review found a NaN close time throwing out
   * of here and through computeSignals before any arm had run).
   */
  private recordMomentumCandidates(markets: VenueMarket[], data: ScanData): void {
    if (!momentumCandidatesActive()) return
    const cfg = { windowMin: this.config.momentumWindowMinutes, thr: this.config.momentumMinMovePct }
    const now = Date.now()
    const today = nowDate()
    const rows: MomentumCandidateRow[] = []
    let withCandles = 0
    let errors = 0
    for (const m of markets) {
      try {
        const candles = data.candles1m[m.id]
        if (candles !== undefined && candles.length > 0) withCandles++
        const row = computeCandidate(m, candles, data.books.get(m.id), cfg, now)
        if (row === undefined) continue
        const churn = this.churn.get(m.id)
        if (churn && churn.day === today) {
          row.priorEntriesToday = churn.entries
          // Floored: the live lockout is `now - lastExitAt < 60 min`, and 59.6 rounded to 60 read as free.
          if (churn.lastExitAt) row.minutesSinceExit = Math.floor((now - churn.lastExitAt) / 60_000)
        }
        if (m.eventTicker !== undefined) {
          row.eventExposed = this.state.openTrades.some((t) => t.eventTicker === m.eventTicker) || this.state.pendingOrders.some((p) => p.eventTicker === m.eventTicker)
        }
        rows.push(row)
      } catch {
        errors++
      }
    }
    recordMomentumCandidates(rows, markets.length, withCandles, now, errors)
  }

  private meanReversionSignals(markets: VenueMarket[], data: ScanData): AutoSignal[] {
    const out: AutoSignal[] = []
    const now = Date.now()
    const cutoff = Math.floor(now / 1000) - this.config.meanReversionWindowMinutes * 60
    const rule: ReversionRule = {
      minMoveCents: this.config.meanReversionMinMoveCents,
      minHoursToClose: this.config.meanReversionMinHoursToClose,
      minEntryPrice: this.config.meanReversionMinEntryPrice ?? 0.35,
      maxHoursToClose: this.config.meanReversionMaxHoursToClose ?? 24
    }
    for (const m of markets) {
      const candles = (data.candles1m[m.id] ?? []).filter((c) => c.endTs >= cutoff)
      const prices = candles.map((c) => c.close ?? midOf(c.bidClose, c.askClose)).filter((p): p is number => p !== undefined)
      const hoursToClose = m.closeTime ? (m.closeTime - now) / 3600_000 : 0
      const v = meanReversionVerdict({ prices, tradedCandles: candles.filter((c) => (c.volume ?? 0) > 0).length, hoursToClose }, rule)
      if (!v) continue
      const score = Math.min(100, Math.round(50 + (Math.abs(v.moveCents) / rule.minMoveCents) * 25))
      const confidence = Math.min(1, Math.abs(v.moveCents) / (2 * rule.minMoveCents))
      out.push(
        this.makeSignal(m, 'mean-reversion', v.direction, score, confidence, {
          moveCents: round2(v.moveCents),
          windowMin: this.config.meanReversionWindowMinutes,
          priceFrom: round2(prices[0]),
          priceTo: round2(prices[prices.length - 1]),
          hoursToClose: round2(hoursToClose)
        })
      )
    }
    return out
  }

  /**
   * Time-of-day: the morning forecast update on overnight-listed temperature
   * brackets. One forecast fetch per station per scan (the hourly product is
   * cached for FORECAST_TTL_MS), so a full weather slate costs a handful of
   * calls. Everything decidable without the network is checked first.
   */
  private async morningForecastSignals(markets: VenueMarket[], data: ScanData): Promise<AutoSignal[]> {
    const out: AutoSignal[] = []
    const now = Date.now()
    const rule: MorningEdgeRule = {
      fromHour: this.config.weatherMorningFromHour,
      toHour: this.config.weatherMorningToHour,
      minEdgeCents: this.config.weatherMorningMinEdgeCents,
      minHoursToClose: this.config.weatherMorningMinHoursToClose
    }
    // Forecast per station within this scan; null remembers a station that
    // did not resolve, so a dead city is not re-fetched market by market.
    const byStation = new Map<string, Awaited<ReturnType<typeof fetchHourlyForecast>>>()
    for (const m of markets) {
      const kind = tempSeriesKind(m)
      if (!kind) continue
      const eventTicker = m.eventTicker ?? m.id
      const station = stationCode(eventTicker)
      const eventDate = parseEventDate(eventTicker)
      const tz = stationTimeZone(eventTicker)
      if (!station || !eventDate || !tz) continue
      const localHour = stationLocalHour(eventTicker, now)
      if (localHour === null || !(localHour >= rule.fromHour && localHour < rule.toHour)) continue
      const hoursToClose = m.closeTime ? (m.closeTime - now) / 3600_000 : 0
      if (!(hoursToClose >= rule.minHoursToClose)) continue
      const book = data.books.get(m.id)
      const bid = book?.bids[0]?.price
      const ask = book?.asks[0]?.price
      if (bid === undefined && ask === undefined) continue
      if (!byStation.has(station)) byStation.set(station, await fetchHourlyForecast(station, now).catch(() => null))
      const fc = byStation.get(station)
      if (!fc) continue
      const ext = remainingExtremes(fc, eventDate, tz, now)
      if (!ext) continue
      // The morning is before the day's extreme forms, so the forecast alone
      // is the estimate — no banked running extreme is folded in here (the
      // quoter's ratchet is for the afternoon, when one exists).
      const mu = kind === 'high' ? ext.max : ext.min
      const fair = bracketFairValue(kind, m.strikeType, m.floorStrike, m.capStrike, mu, forecastSigma(ext.hours))
      if (fair === null || !Number.isFinite(fair)) continue
      const v = morningForecastVerdict({ fair, bid, ask, localHour, hoursToClose, feeRate: m.feeRate }, rule)
      if (!v) continue
      const score = Math.min(100, Math.round(50 + (v.edgeCents / rule.minEdgeCents) * 25))
      out.push(
        this.makeSignal(m, 'weather-morning', v.direction, score, Math.min(1, v.edgeCents / (2 * rule.minEdgeCents)), {
          fair: round2(fair),
          mu: round2(mu),
          edgeCents: round2(v.edgeCents),
          localHour,
          forecastHours: ext.hours,
          hoursToClose: round2(hoursToClose)
        })
      )
    }
    return out
  }

  private volumeSpikeSignals(markets: VenueMarket[], data: ScanData): AutoSignal[] {
    const out: AutoSignal[] = []
    const now = Date.now()
    const windowMs = this.config.volumeSpikeWindowMinutes * 60_000
    for (const m of markets) {
      const trades = data.trades.get(m.id) ?? []
      const inWindow = trades.filter((t) => !t.isBlockTrade && now - t.createdTs <= windowMs)
      if (inWindow.length < 3) continue
      const volWindow = inWindow.reduce((s, t) => s + t.count, 0)
      const hourCandles = data.candles1h[m.id] ?? []
      const baselineMinutes = this.config.volumeSpikeBaselineMinutes
      const baselineCandles = hourCandles.filter((c) => now / 1000 - c.endTs <= baselineMinutes * 60)
      if (baselineCandles.length < 2) continue
      const totalVol = baselineCandles.reduce((s, c) => s + c.volume, 0)
      const coveredMin = baselineCandles.length * 60
      const perMin = totalVol / coveredMin
      if (perMin <= 0) continue
      const multiple = volWindow / this.config.volumeSpikeWindowMinutes / perMin
      if (multiple < this.config.volumeSpikeMinMultiple) continue
      let aggYes = 0
      let aggNo = 0
      for (const t of inWindow) {
        if (t.takerOutcomeSide === 'yes' && t.takerBookSide === 'bid') aggYes += t.count
        else if (t.takerOutcomeSide === 'no' && t.takerBookSide === 'ask') aggNo += t.count
      }
      const total = aggYes + aggNo
      const pressure = total > 0 ? (aggYes - aggNo) / total : 0
      const direction: 'YES' | 'NO' | undefined = pressure > 0.15 ? 'YES' : pressure < -0.15 ? 'NO' : undefined
      if (!direction) continue
      const score = Math.min(100, Math.round(50 + (multiple / this.config.volumeSpikeMinMultiple) * 25 + Math.abs(pressure) * 25))
      const confidence = Math.min(1, multiple / (2 * this.config.volumeSpikeMinMultiple))
      out.push(this.makeSignal(m, 'volume-spike', direction, score, confidence, {
        multiple: round2(multiple),
        pressure: round2(pressure),
        volWindow: round2(volWindow),
        trades: inWindow.length
      }))
    }
    return out
  }

  private bookSignals(markets: VenueMarket[], data: ScanData): AutoSignal[] {
    const out: AutoSignal[] = []
    for (const m of markets) {
      const book = data.books.get(m.id)
      if (!book) continue
      const bidDepth = book.bids.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
      const askDepth = book.asks.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
      const total = bidDepth + askDepth
      // Both sides need real depth — a $5,000 bid wall against a single $0.99
      // ask produces a meaningless ratio.
      if (total < this.config.bookMinDepth) continue
      if (Math.min(bidDepth, askDepth) < this.config.bookMinSideDepth) continue
      const ratio = bidDepth / askDepth
      const minRatio = this.config.bookMinRatio
      if (ratio >= minRatio) {
        const score = Math.min(100, Math.round(50 + (ratio - 1) * 25))
        out.push(this.makeSignal(m, 'book-imbalance', 'YES', score, Math.min(1, (ratio - 1) / (2 * (minRatio - 1) || 1)), {
          bidDepth: round2(bidDepth),
          askDepth: round2(askDepth),
          ratio: round2(ratio)
        }))
      } else if (ratio <= 1 / minRatio) {
        const inv = 1 / ratio
        const score = Math.min(100, Math.round(50 + (inv - 1) * 25))
        out.push(this.makeSignal(m, 'book-imbalance', 'NO', score, Math.min(1, (inv - 1) / (2 * (minRatio - 1) || 1)), {
          bidDepth: round2(bidDepth),
          askDepth: round2(askDepth),
          ratio: round2(ratio)
        }))
      }
    }
    return out
  }

  private async crossVenueSignals(markets: VenueMarket[], result: AutoScanResult): Promise<AutoSignal[]> {
    // Data-only Gamma feed. The .com adapter is not in the venue registry
    // (region-blocked for trading, superseded by Polymarket US in the UI),
    // so the lead-lag signal owns a private instance.
    const poly = this.gamma
    const out: AutoSignal[] = []
    const minGap = this.config.crossVenueMinGapPct
    const minSim = this.config.crossVenueMinSimilarity
    // Title tokens are computed in the admission test and reused below: they used to
    // be computed AFTER the Gamma round trip, so a market that could never match
    // still paid for a search.
    const tokensById = new Map<string, string[]>()
    const searchable = (m: VenueMarket): boolean => {
      if (!assetOf(m)) return false
      const t = titleTokens(m)
      if (t.length < 2) return false
      tokensById.set(m.id, t)
      return true
    }
    const { batch, start, cursor, skipped } = crossVenueBatch(markets, this.crossVenueCursor, CROSS_VENUE_SEARCH_BUDGET, searchable)
    this.crossVenueCursor = cursor
    const refused: Record<string, number> = {}
    const refuse = (why: string): void => {
      refused[why] = (refused[why] ?? 0) + 1
    }
    if (skipped > 0) refused['no-asset-or-title'] = skipped
    for (const m of batch) {
      const asset = assetOf(m) as string
      let polyMarkets: VenueMarket[] = []
      try {
        polyMarkets = await poly.searchMarkets({ term: asset, limit: 20, status: 'open' })
      } catch (err) {
        result.errors.push(`gamma search ${asset}: ${fmtErr(err)}`)
        refuse('gamma-error')
        continue
      }
      const kTokens = tokensById.get(m.id) ?? titleTokens(m)
      let best: { sim: number; prob: number; q: string; id: string } | null = null
      let sawPriced = 0
      let sawSimilar = 0
      for (const pm of polyMarkets) {
        if (pm.probability === undefined || pm.probability <= 0) continue
        sawPriced++
        const sim = jaccard(kTokens, norm(pm.question))
        if (sim < minSim) continue
        sawSimilar++
        if (m.closeTime && pm.closeTime && Math.abs(m.closeTime - pm.closeTime) > 35 * 60_000) continue
        if (!best || sim > best.sim) best = { sim, prob: pm.probability, q: pm.question, id: pm.id }
      }
      if (!best) {
        // Three different silences, and they mean different things: nothing priced on
        // Gamma, nothing similar enough, or a twin whose close time is too far away.
        refuse(sawPriced === 0 ? 'no-poly-market' : sawSimilar === 0 ? 'below-similarity' : 'close-time-mismatch')
        continue
      }
      const kProb = m.probability ?? 0
      if (kProb <= 0) {
        refuse('no-kalshi-price')
        continue
      }
      const gap = best.prob - kProb
      if (Math.abs(gap) < minGap) {
        refuse('below-gap')
        continue
      }
      const direction: 'YES' | 'NO' = gap > 0 ? 'YES' : 'NO'
      const score = Math.min(100, Math.round(50 + (Math.abs(gap) / minGap) * 30 + best.sim * 20))
      out.push(this.makeSignal(m, 'cross-venue', direction, score, Math.min(1, Math.abs(gap) / (2 * minGap)), {
        polyProb: round2(best.prob),
        kalshiProb: round2(kProb),
        gap: round2(Math.abs(gap) * 100),
        similarity: round2(best.sim),
        polyMarket: best.q.slice(0, 80)
      }))
    }
    // A silent arm must say WHY it is silent (the same rule the consensus arm follows):
    // this one was logged as tiny-live for eleven days while producing nothing.
    console.log(
      `[cross-venue] ${markets.length} universe, searched ${batch.length} from offset ${start}, ${out.length} candidates` +
        (Object.keys(refused).length > 0 ? ` | refused ${JSON.stringify(refused)}` : '')
    )
    return out
  }

  private newsSignals(markets: VenueMarket[], data: ScanData): AutoSignal[] {
    const out: AutoSignal[] = []
    for (const m of markets) {
      const headlines = data.headlinesByMarket.get(m.id)
      if (!headlines || headlines.length === 0) continue
      let best: { title: string; sim: number } | null = null
      const mt = titleTokens(m)
      for (const h of headlines) {
        const sim = jaccard(mt, norm(h))
        if (!best || sim > best.sim) best = { title: h, sim }
      }
      if (!best) continue
      const sentiment = polarity(best.title)
      if (sentiment === 0) continue
      const direction: 'YES' | 'NO' = sentiment > 0 ? 'YES' : 'NO'
      const score = Math.min(100, Math.round(50 + best.sim * 30 + 10))
      out.push(this.makeSignal(m, 'news', direction, score, Math.min(1, 0.4 + best.sim * 0.6), {
        headline: best.title.slice(0, 100),
        similarity: round2(best.sim),
        sentiment: sentiment > 0 ? 'positive' : 'negative'
      }))
    }
    return out
  }

  private async dutchSignals(): Promise<AutoSignal[]> {
    const adapter = this.engine.getAdapter(VENUE)
    if (!adapter?.searchEvents) return []
    const out: AutoSignal[] = []
    const now = Date.now()
    let cursor: string | undefined
    for (let page = 0; page < 2; page++) {
      let pageRes: { events: import('../../shared/types').EventDetails[]; cursor?: string }
      try {
        pageRes = await adapter.searchEvents(200, cursor)
      } catch {
        break
      }
      for (const e of pageRes.events) {
        if (!e.mutuallyExclusive) continue
        const legs = e.markets.filter(
          (l) =>
            l.status === 'open' &&
            (!l.outcomeType || l.outcomeType === 'BINARY') &&
            l.probability !== undefined &&
            l.probability > 0.02 &&
            l.probability < 0.98 &&
            (l.volume ?? 0) >= this.config.minVolume
        )
        if (legs.length < 2 || legs.length > this.config.dutchMaxLegs) continue
        const closeTimes = legs.map((l) => l.closeTime ?? 0).filter((t) => t > 0)
        if (closeTimes.length === 0) continue
        const closeTime = Math.min(...closeTimes)
        if (
          closeTime - now < this.config.minMinutesToClose * 60_000 ||
          closeTime - now > this.config.maxMinutesToClose * 60_000
        )
          continue
        // Σ of YES bids: buying NO on every leg costs n − ΣB and pays n−1 (or n)
        // when exactly one leg resolves YES — profit ≥ ΣB − 1. The snapshot does
        // not carry raw bids, so approximate bid = probability − spread/2; the
        // live book is re-checked at execution time.
        let sumBids = 0
        let maxSpread = 0
        let minLiq = Infinity
        let ok = true
        for (const l of legs) {
          if (l.spread === undefined) {
            ok = false
            break
          }
          maxSpread = Math.max(maxSpread, l.spread)
          minLiq = Math.min(minLiq, l.liquidity ?? 0)
          const prob = l.probability ?? 0.5
          sumBids += Math.max(0.01, prob - l.spread / 2)
        }
        if (!ok) continue
        if (maxSpread > this.config.maxSpreadPct || minLiq < this.config.minLiquidity) continue
        const over = sumBids - 1
        if (over <= this.config.dutchMinOverSum) continue
        const sig: AutoSignal = {
          id: `dutch:${e.eventTicker}`,
          strategy: 'dutch',
          marketId: e.eventTicker,
          question: e.title ?? e.eventTicker,
          outcome: 'NO',
          price: sumBids / legs.length,
          closeTime,
          score: Math.min(100, Math.round(50 + over * 700)),
          confidence: Math.min(1, over / (2 * this.config.dutchMinOverSum)),
          details: { sumBids: round2(sumBids), legs: legs.length, profit: round2(over * 100), maxLegSpread: round2(maxSpread) },
          groupLegs: legs.map((l) => l.id),
          executed: false
        }
        out.push(sig)
      }
      if (!pageRes.cursor) break
      cursor = pageRes.cursor
    }
    return out
  }

  /**
   * Longshot fade with an explicit EV hurdle at the EXECUTABLE price.
   *
   * Calibration (docs/validation-results.md, clean pool, n≈2,400): markets
   * whose YES trades under 10¢ resolve YES 0.0–0.6% of the time vs 3.5–7.5%
   * implied. calibratedYesRate() below uses padded upper bounds (~3× the
   * worst measured bucket) so the modeled edge is conservative.
   *
   * Edge per contract (buy NO, hold to settlement):
   *   payoff = 1 − calibratedYes    cost = NO exec price    fee = taker fee
   *   edge¢ = (yesExec − calibratedYes)·100 − fee¢
   * where yesExec is the YES-leg price the entry actually transacts at
   * (taker: the standing YES bid; maker: our resting ask). Maker entries on
   * plain quadratic series pay no fee.
   */
  private fadeSignals(markets: VenueMarket[], data: ScanData): AutoSignal[] {
    const out: AutoSignal[] = []
    const now = Date.now()
    for (const m of markets) {
      const p = m.probability
      if (p === undefined) continue
      // Two mirror bands, one bias: when YES is the cheap longshot we buy NO;
      // when NO is the cheap longshot (YES at 90-97¢) we buy YES. Same
      // lottery-buyer counterparty either way.
      const longshot = p >= this.config.fadeMinPrice && p <= this.config.fadeMaxPrice
      const favorite =
        this.config.fadeFavoritesEnabled &&
        p >= 1 - this.config.fadeMaxPrice &&
        p <= 1 - this.config.fadeMinPrice
      if (!longshot && !favorite) continue
      // Horizon floor is configurable; the ceiling is the universe's
      // maxMinutesToClose (already applied by buildUniverse).
      const horizonMin = m.closeTime ? (m.closeTime - now) / 60_000 : 0
      if (horizonMin < this.config.fadeMinHorizonMinutes) continue

      const book = data.books.get(m.id)
      const yesBid = book?.bids[0]?.price
      const yesAsk = book?.asks[0]?.price
      // A fade entry needs a live two-sided book: the taker path crosses it;
      // the maker path needs a far side to undercut. No book → not executable.
      if (yesBid === undefined || yesAsk === undefined) continue

      const maker = this.config.fadeEntryMode === 'maker' && this.engine.getExecutionMode() === 'live'
      // Fee waived → zero; maker on standard quadratic series → zero.
      const waived = m.feeWaiverUntil !== undefined && m.feeWaiverUntil > now
      const baseFeeRate = waived ? 0 : (m.feeRate ?? KALSHI_TAKER_FEE_COEF)

      let outcome: 'YES' | 'NO'
      let yesExec: number
      let calibrated: number
      if (longshot) {
        // Keep the *executable* YES price inside the band, not just the last.
        if (yesBid < this.config.fadeMinPrice || yesAsk > this.config.fadeMaxPrice + 0.02) continue
        outcome = 'NO'
        yesExec = maker ? Math.max(yesBid + 0.01, yesAsk - 0.01) : yesBid
        calibrated = calibratedYesRate(yesExec)
      } else {
        if (yesAsk > 1 - this.config.fadeMinPrice || yesBid < 1 - this.config.fadeMaxPrice - 0.02) continue
        outcome = 'YES'
        // Buying YES: taker lifts the ask; maker rests a bid inside the spread.
        yesExec = maker ? Math.min(yesAsk - 0.01, yesBid + 0.01) : yesAsk
        // Mirror calibration with DOUBLE padding — the favorite-side evidence
        // ("favorites at 95-99¢ mildly underpriced in some runs") is thinner
        // than the longshot study.
        calibrated = 1 - 2 * calibratedYesRate(1 - yesExec)
      }
      // Maker is fee-free only on plain quadratic series; with-maker-fee series bill the rebate away.
      const feeRate = maker ? (waived ? 0 : (m.makerFeeRate ?? 0)) : baseFeeRate
      const legCost = outcome === 'NO' ? 1 - yesExec : yesExec
      // Kalshi computes taker fees on the ORDER total, rounded UP to the
      // next cent — at 5-contract clips the ceil is up to ~1¢/order that a
      // smooth per-contract rate understates.
      const contracts = Math.max(1, Math.floor(this.config.amountPerTrade / Math.max(legCost, 0.01)))
      const feeCents = kalshiOrderFeeCents(feeRate, yesExec, contracts)
      // Edge per contract of the leg we buy: longshot → NO pays when YES
      // loses; favorite → YES pays at its calibrated rate.
      const edgeCents = (outcome === 'NO' ? yesExec - calibrated : calibrated - yesExec) * 100 - feeCents
      if (edgeCents < this.config.fadeMinEdgeCents) continue

      // Category filter (active-stricter): the bias the fade harvests is
      // category-conditional, and blocked categories only ever REMOVE
      // entries. Each removal is shadow-logged so gradeVetoes prices the
      // filter's counterfactual instead of leaving it an argument.
      if (this.config.fadeCategoryFilterEnabled) {
        const block = fadeCategoryBlock(m, horizonMin, this.config.fadeCategoryExceptions ?? [])
        if (block) {
          this.watchVeto(m.id, 'fade', outcome, legCost, m.closeTime, `category:${block}`)
          continue
        }
      }

      // Rank by CAPITAL VELOCITY, not raw edge: hold-to-settlement capital is
      // locked until resolution, so what compounds is edge per day. A 4¢ edge
      // settling in 6h (16¢/day) beats a 7¢ edge settling in 3 days (2.3¢/day)
      // — without this, distant exotics with fat edges hog every slot.
      const edgePerDay = edgeCents * (1440 / Math.max(horizonMin, 60))
      const score = Math.min(100, Math.round(45 + Math.min(50, edgePerDay * 2.5)))
      out.push(this.makeSignal(m, 'fade', outcome, score, Math.min(0.7, 0.3 + edgeCents / 10), {
        prob: round2(p),
        yesExec: round2(yesExec),
        legCost: round2(legCost),
        // Modeled P(our side wins) — graded at settlement by the calibration ledger.
        winProb: Math.round((outcome === 'NO' ? 1 - calibrated : calibrated) * 10000) / 10000,
        edgeCents: round2(edgeCents),
        edgePerDay: round2(edgePerDay),
        entryMode: maker ? 'maker' : 'taker',
        side: longshot ? 'longshot-NO' : 'favorite-YES',
        feeWaived: waived ? 'yes' : 'no',
        horizonMin: Math.round(horizonMin)
      }))
    }
    return out
  }

  private settleSignals(markets: VenueMarket[], data: ScanData): AutoSignal[] {
    const out: AutoSignal[] = []
    for (const m of markets) {
      const ld = data.live.get(m.id)
      if (!ld || ld.latest === undefined || ld.staleMinutes === undefined) continue
      if (ld.staleMinutes > 20) continue
      // Prefer the venue's structured strike fields; title parsing is the
      // fallback (and must survive comma-formatted numbers like $85,000).
      const parsed = strikeOf(m)
      if (!parsed) continue
      const { strike, dir } = parsed
      if (strike <= 0) continue
      const distPct = (Math.abs(ld.latest - strike) / strike) * 100
      if (distPct < this.config.settleMinMarginPct) continue
      const p = m.probability ?? 0
      const above = ld.latest >= strike
      let direction: 'YES' | 'NO'
      if (dir === 'above') {
        if (above && p < 0.93) direction = 'YES'
        else if (!above && p > 0.07) direction = 'NO'
        else continue
      } else {
        if (!above && p < 0.93) direction = 'YES'
        else if (above && p > 0.07) direction = 'NO'
        else continue
      }
      const score = Math.min(100, Math.round(55 + (distPct / this.config.settleMinMarginPct) * 25))
      out.push(this.makeSignal(m, 'settlement', direction, score, Math.min(1, distPct / (2 * this.config.settleMinMarginPct)), {
        latest: round2(ld.latest),
        strike: round2(strike),
        distPct: round2(distPct),
        staleMinutes: Math.round(ld.staleMinutes)
      }))
    }
    return out
  }

  // ---- gates & vetting ----

  private passesGates(sig: AutoSignal, data: ScanData): { ok: boolean; reason?: string } {
    const now = Date.now()
    const cfg = this.config
    if (sig.strategy !== 'dutch' && sig.closeTime && now >= sig.closeTime - (cfg.exitMinutesBeforeClose + 2) * 60_000) {
      return { ok: false, reason: 'too close to close' }
    }
    // Price band does not apply to Dutch (event-level mean price) or fade
    // (which deliberately trades the extremes).
    if (sig.strategy !== 'dutch' && sig.strategy !== 'fade') {
      if (sig.outcome === 'YES' && sig.price > cfg.maxPrice) return { ok: false, reason: `price ${sig.price.toFixed(2)} above band` }
      if (sig.outcome === 'NO' && sig.price < cfg.minPrice) return { ok: false, reason: `price ${sig.price.toFixed(2)} below band` }
    }
    // Book-imbalance is forward-only (no historical books exist): it may only
    // trade once its own lab has proven the validation plan's pass bar
    // (≥500 observations, hit rate >55%, mean forward move >4¢). Until then
    // the lab logs, the strategy does not spend.
    if (sig.strategy === 'book-imbalance' && !cfg.bookLabBypass) {
      const s = this.state.bookStats
      const proven = s.observations >= 500 && s.hitRate > 0.55 && s.meanMoveCents > 4
      if (!proven) {
        return {
          ok: false,
          reason: `book lab unproven (n=${s.observations}, hit ${(s.hitRate * 100).toFixed(0)}%, move ${s.meanMoveCents.toFixed(1)}¢; needs n≥500, >55%, >4¢)`
        }
      }
    }
    const blocked = this.entryBlockedWatched(sig, data)
    if (blocked) return { ok: false, reason: blocked }
    return { ok: true }
  }

  /**
   * Stateful entry gates, evaluated BOTH at approval time and again
   * immediately before each execution — the approval loop runs over a whole
   * batch before anything executes, so without the re-check one fat scan
   * could blow far past every cap.
   */
  private entryBlocked(sig: AutoSignal, data: ScanData): string | null {
    const cfg = this.config
    const now = Date.now()
    if (cfg.stopEntry) return 'stop-entry engaged (exits still managed)'
    if (data.tradingActive === false) return 'exchange trading paused'
    // The daily-loss check reads the venue ledger in live mode; if that ledger
    // could not be refreshed for 45 minutes the check is blind — hold entries.
    if (this.venueLedgerStale()) return 'venue ledger stale — entries held until the settlement feed refreshes'
    // Live entries wait for the boot reconcile: local state must be checked
    // against the venue once per process start before new money moves.
    if (this.engine.getExecutionMode() === 'live' && !this.reconciledLive) return 'awaiting venue reconcile'
    // An unknown balance is not "no loss": with the account read failed the kill switch cannot be judged and the
    // equity cap cannot bind, so entries hold for this scan (audit 2026-09-19, B-10). The sub-engines already fail
    // closed on the same condition (subEngineKilled).
    if (this.engine.getExecutionMode() === 'live' && data.balance === undefined && data.equity === undefined) return 'venue balance unknown - entries held until the account read succeeds'
    // Percentage of EQUITY, not free cash: deploying capital into positions
    // shrank the cash base and tripped the limit at a smaller dollar loss.
    const kill = this.killSwitchCheck(data.equity ?? data.balance)
    if (kill) return kill
    // Universe rule: the generic arms may not trade the weather ladders. See
    // weatherSeatBlock — the seat is measured negative there and no arm's
    // backtest covers the series.
    const weatherSeat = weatherSeatBlock(sig.strategy, sig.marketId)
    if (weatherSeat) return weatherSeat
    // Churn guard (2026-09-06: momentum re-entered one in-play MLB market 13
    // times in an hour, paying taker fees each way). One market may be
    // entered at most twice a day and not within an hour of an exit.
    const churn = this.churn.get(sig.marketId)
    if (churn && churn.day === nowDate()) {
      if (churn.lastExitAt && now - churn.lastExitAt < 60 * 60_000) return `re-entry lockout (exited ${Math.round((now - churn.lastExitAt) / 60_000)}m ago)`
      if (churn.entries >= 2) return 'per-market entry cap (2 per day)'
      // Momentum never re-enters a market it has already traded today, in
      // either direction: a second look at the same move is the churn.
      if (sig.strategy === 'momentum' && churn.entries >= 1) return 'momentum: one entry per market per day'
    }
    // Positions whose market has already CLOSED carry no further risk — they
    // are waiting on the venue to publish a settlement, which can take hours
    // (weather resolves off the next morning's climate report). Counting them
    // against the slot cap let decided trades squat the budget and starve
    // new entries. A generous absolute ceiling still bounds the ledger.
    const active =
      this.state.openTrades.filter((t) => t.closeTime === undefined || t.closeTime > now).length +
      this.state.pendingOrders.length
    if (active >= cfg.maxOpenPositions) return 'max open positions'
    if (this.state.openTrades.length >= cfg.maxOpenPositions * 3) return 'unsettled backlog too large'
    if (this.state.daily.date === nowDate() && this.state.daily.count >= cfg.maxDailyTrades) {
      return 'daily trade cap'
    }
    if (this.state.openTrades.some((t) => t.marketId === sig.marketId)) return 'market already open'
    if (this.state.pendingOrders.some((p) => p.marketId === sig.marketId)) return 'order already resting'
    // One arm per market, in both directions: Kalshi nets YES and NO into one signed position, so a fade NO on
    // a strike convergence holds YES would close its contracts, not open ours (audit 2026-09-19, B-28).
    if (this.subEngineHolds(sig.marketId)) return 'market held by a sub-engine'
    // Correlation cap: many strikes of one ladder are ONE bet on one
    // underlying — at a small bankroll, six positions on the same event is
    // ruin-shaped, and edge-per-day ranking actively clusters same-expiry
    // strikes without this.
    if (sig.eventTicker && sig.strategy !== 'dutch') {
      if (this.state.openTrades.some((t) => t.eventTicker === sig.eventTicker)) return 'event already exposed'
      if (this.state.pendingOrders.some((p) => p.eventTicker === sig.eventTicker)) return 'event already resting'
    }
    // Underlying cap: the event cap cannot see that KXSOLE and KXSOLD are
    // the same coin. Counts positions by risk-bearing asset, not by ticker.
    if (cfg.maxPerUnderlying > 0 && sig.strategy !== 'dutch') {
      const u = underlyingOf(sig.marketId)
      if (u) {
        const held =
          this.state.openTrades.filter((t) => underlyingOf(t.marketId) === u).length +
          this.state.pendingOrders.filter((p) => underlyingOf(p.marketId) === u).length
        if (held >= cfg.maxPerUnderlying) return `underlying ${u} full (${held}/${cfg.maxPerUnderlying})`
      }
    }
    // fade's correlated tail (fade v3). underlyingOf counts crypto:BTC, crypto:ETH ... separately, so four coins'
    // dailies closing the same hour pass the cap above as four bets. They are one bet on crypto direction: on
    // 2026-09-21 BTC/ETH/SOL/DOGE fade positions closing 17:00 ET lost together, most of the sample that stopped fade.
    const cryptoPerHour = cfg.fadeMaxCryptoPerCloseHour ?? 1
    if (sig.strategy === 'fade' && cryptoPerHour > 0 && sig.closeTime !== undefined && (underlyingOf(sig.marketId) ?? '').startsWith('crypto:')) {
      const hour = Math.floor(sig.closeTime / 3_600_000)
      const sameHourCrypto = (marketId: string, closeTime: number | undefined): boolean =>
        closeTime !== undefined && Math.floor(closeTime / 3_600_000) === hour && (underlyingOf(marketId) ?? '').startsWith('crypto:')
      const held =
        this.state.openTrades.filter((t) => t.strategy === 'fade' && sameHourCrypto(t.marketId, t.closeTime)).length +
        this.state.pendingOrders.filter((p) => p.strategy === 'fade' && sameHourCrypto(p.marketId, p.closeTime)).length
      if (held >= cryptoPerHour) return `crypto close-hour full (${held}/${cryptoPerHour} fade positions on crypto closing that hour)`
    }
    // Horizon-mix cap: long-dated entries (>24h to settle) may only use a
    // few slots — the rest stay free for the intraday rotation, which is
    // where capital velocity (edge/day) actually lives.
    // 0 means ZERO long positions allowed (the user's lockdown intent), not
    // "cap off" — an uncapped mix is expressible by setting it ≥ maxOpen.
    if (sig.closeTime !== undefined && sig.closeTime - now > 24 * 3600_000) {
      const longHeld =
        this.state.openTrades.filter((t) => t.closeTime !== undefined && t.closeTime - now > 24 * 3600_000).length +
        this.state.pendingOrders.filter((p) => p.closeTime !== undefined && p.closeTime - now > 24 * 3600_000).length
      const cap = longHorizonCapFor(sig.strategy, cfg)
      if (longHeld >= cap) return `long-horizon slots full (${longHeld}/${cap})`
    }
    const stakeNow = this.stakeFor(data, sig.strategy)
    if (stakeNow < 1) return 'stake below $1 (balance cap)'
    if (data.balance !== undefined && stakeNow > data.balance) return 'insufficient balance'
    // Kalshi holds collateral PER exchange shard and rejects an order whose
    // shard is unfunded even when the aggregate covers it. Deposits land on
    // shard 0; crypto is shard 2 and MLB/tennis shard 3.
    if (this.engine.getExecutionMode() === 'live' && data.balanceByShard) {
      const shard = data.marketsById.get(sig.marketId)?.exchangeIndex
      if (shard !== undefined) {
        const avail = data.balanceByShard[shard]
        if (avail !== undefined && stakeNow > avail) {
          // The ladder levels the shards; flag it so the next reconcile asks rather than waiting an hour.
          this.shardStarvedAt = Date.now()
          return `shard ${shard} unfunded ($${avail.toFixed(2)}) - levelling collateral`
        }
      }
    }
    return null
  }

  /**
   * Stake per trade: configured amount, capped to a % of account EQUITY
   * (cash + open positions) — not cash alone.
   *
   * Sizing off cash shrinks every bet as positions open: deploy capital and
   * the remaining cash falls, so the next stake is smaller, and the account
   * asymptotes toward a large idle balance it can never spend. Equity is
   * stable, so a 10% cap means 10% of the account regardless of how much is
   * currently at work. Cash still gates affordability separately.
   */
  private stakeFor(data: ScanData, strategy?: string): number {
    const cfg = this.config
    // The ladder scales a proven strategy by a per-strategy multiplier; the
    // operator's equity cap still applies on top.
    const mult = strategy ? (cfg.strategySizeMult?.[strategy] ?? 1) : 1
    const base = data.equity ?? data.balance
    if (cfg.maxBalancePct > 0 && base !== undefined) {
      return Math.min(cfg.amountPerTrade * mult, (cfg.maxBalancePct / 100) * base)
    }
    return cfg.amountPerTrade * mult
  }

  private async llmGate(sig: AutoSignal, data: ScanData): Promise<{ approve: boolean; confidence: number; direction: 'YES' | 'NO'; reason: string }> {
    const review = await this.intelligence.review(this.config, {
      signal: sig,
      market: data.marketsById.get(sig.marketId),
      book: data.books.get(sig.marketId),
      balance: data.balance,
      openPositions: this.state.openTrades.length + this.state.pendingOrders.length,
      dailyTradesLeft: Math.max(0, this.config.maxDailyTrades - (this.state.daily.date === nowDate() ? this.state.daily.count : 0)),
      stake: this.stakeFor(data, sig.strategy),
      headlines: data.headlinesByMarket.get(sig.marketId)
    })
    const v = review.verdict
    if (!v) return { approve: false, confidence: 0, direction: sig.outcome, reason: `Intelligence unavailable: ${review.apiError ?? 'unknown error'}` }
    sig.details['llmImplied'] = round2(v.pYesMid * 100)
    sig.details['llmEdgeCents'] = review.adjudication.conservativeEdgeCents
    return {
      approve: review.adjudication.eligible,
      confidence: v.confidence,
      direction: sig.outcome,
      reason: review.adjudication.eligible ? v.reason : review.adjudication.reason
    }
  }

  /**
   * Panel "Test AI" support: run a representative sample candidate through the
   * configured LLM gate so the user can verify their key/model and see the
   * quality of the verdict before enabling live vetting. Works regardless of
   * the current vetMode (testing does not trade).
   */
  async testVet(): Promise<AutoVetTest> {
    const sampleSignal: AutoSignal = {
      id: 'test:sample',
      strategy: 'cross-venue',
      marketId: 'TEST',
      question: 'Will Bitcoin be above $85,000 at 5:00 PM ET today?',
      outcome: 'NO',
      price: 0.62,
      closeTime: Date.now() + 3 * 3600_000,
      score: 68,
      confidence: 0.55,
      details: {
        polyProb: 0.53,
        kalshiProb: 0.62,
        gap: 9,
        similarity: 0.6,
        note: 'Polymarket prices the same event at 53% while Kalshi trades at 62% — the Kalshi YES side looks 9 points rich.'
      },
      executed: false
    }
    const market: VettingMarket = {
      marketId: 'TEST',
      question: sampleSignal.question,
      yesProb: 0.62,
      spread: 2,
      volume24h: 42000,
      liquidity: 1800,
      closeInMinutes: 180,
      costCents: 4,
      recentTrades: [
        { side: 'no', count: 12, price: 0.61, agoSeconds: 40 },
        { side: 'no', count: 25, price: 0.62, agoSeconds: 95 },
        { side: 'yes', count: 6, price: 0.63, agoSeconds: 160 }
      ],
      headlines: ['Bitcoin dips below $84,000 as traders trim risk ahead of Fed decision']
    }
    const ctx: VettingContext = {
      executionMode: 'paper',
      balance: 1000,
      openPositions: 1,
      stake: this.config.amountPerTrade,
      maxOpenPositions: this.config.maxOpenPositions,
      dailyTradesLeft: this.config.maxDailyTrades
    }
    try {
      const review = await this.intelligence.review(this.config, {
        signal: sampleSignal,
        market: { venue: 'kalshi', id: 'TEST', question: sampleSignal.question, status: 'open', probability: market.yesProb, closeTime: sampleSignal.closeTime, rulesPrimary: market.rules },
        balance: ctx.balance,
        openPositions: ctx.openPositions,
        dailyTradesLeft: ctx.dailyTradesLeft,
        stake: ctx.stake,
        headlines: market.headlines
      })
      if (!review.verdict) return { ok: false, error: review.apiError ?? 'Intelligence review failed' }
      return { ok: true, verdict: {
        approve: review.adjudication.eligible,
        direction: sampleSignal.outcome,
        confidence: review.verdict.confidence,
        reason: review.adjudication.reason,
        impliedProb: review.verdict.pYesMid,
        expectedEdgeCents: review.adjudication.conservativeEdgeCents
      } }
    } catch (err) {
      return { ok: false, error: fmtErr(err) }
    }
  }

  // ---- execution ----

  private async executeSignal(sig: AutoSignal, data: ScanData, result: AutoScanResult): Promise<void> {
    const adapter = this.engine.getAdapter(VENUE)!
    if (this.config.dryRun) {
      sig.error = 'dry-run — not executed'
      return
    }
    // The hourly ladder can stop an arm DURING a 60-190 s scan. `strategyOn` was checked only when the
    // signal was generated, so the rest of that scan still executed a stopped arm's signals (audit B-39).
    if (!this.strategyOn(sig.strategy)) {
      sig.error = 'strategy switched off mid-scan'
      return
    }
    const mode = this.engine.getExecutionMode()
    if (mode === 'live' && !this.config.liveArmed) {
      sig.error = 'LIVE not armed'
      return
    }
    if (sig.strategy === 'dutch' && mode === 'live' && !this.config.dutchLiveEnabled) {
      sig.error = 'Dutch live execution disabled'
      return
    }
    // Settlement-convergence is a PAPER experiment until its own live switch
    // is flipped — without this it would spend real money the moment the
    // fade was armed.
    if (sig.strategy === 'settlement' && mode === 'live' && !this.config.settleLiveEnabled) {
      sig.error = 'settlement live execution disabled (paper experiment)'
      return
    }
    // Re-check the stateful gates NOW: earlier approvals in this same batch
    // may have consumed the position/daily/event budget.
    const blocked = this.entryBlockedWatched(sig, data)
    if (blocked) {
      sig.error = blocked
      return
    }
    try {
      if (sig.strategy === 'dutch') {
        await this.executeDutch(sig, data, adapter)
      } else if (mode === 'live' && this.makerEntryFor(sig.strategy) && (await this.executeMakerEntry(sig, data, result))) {
        // Rested (or filled) inside the spread; managePendingOrders reconciles it.
      } else {
        const stake = this.stakeFor(data, sig.strategy)
        const book = data.books.get(sig.marketId)
        let limit: number | undefined
        if (sig.outcome === 'YES' && book?.asks[0]) limit = clamp01(book.asks[0].price + 0.01)
        else if (sig.outcome === 'NO' && book?.bids[0]) limit = clamp01(book.bids[0].price - 0.01)
        const res = await this.engine.placeOrder({
          venue: VENUE,
          marketId: sig.marketId,
          outcome: sig.outcome,
          amount: stake,
          limitPrice: limit,
          timeInForce: 'immediate_or_cancel',
          feeRate: sig.feeRate,
          ref: `auto:${sig.strategy}:${sig.id}`,
          marketQuestion: sig.question
        })
        if (res.status === 'open' || res.shares <= 0) {
          await adapter.cancelOrder(res.orderId).catch(() => undefined)
          sig.error = 'no fill (IOC)'
          return
        }
        // CLV/markout reference: our side's mid from the book we just used.
        const yesMid = book?.bids[0] && book?.asks[0] ? (book.bids[0].price + book.asks[0].price) / 2 : undefined
        const entrySideMid = yesMid !== undefined ? (sig.outcome === 'NO' ? 1 - yesMid : yesMid) : res.avgPrice
        this.noteEntry(sig.marketId)
        if (sig.strategy === 'consensus') this.noteConsensusEntry(sig)
        this.state.openTrades.push({
          id: sig.id,
          marketId: sig.marketId,
          eventTicker: sig.eventTicker,
          question: sig.question,
          outcome: sig.outcome,
          shares: res.shares,
          amount: res.amount,
          entryPrice: res.avgPrice,
          strategy: sig.strategy,
          createdAt: Date.now(),
          closeTime: sig.closeTime,
          modeledWinProb: typeof sig.details['winProb'] === 'number' ? (sig.details['winProb'] as number) : undefined,
          feeRate: sig.feeRate ?? KALSHI_TAKER_FEE_COEF,
          entrySideMid: round4(entrySideMid),
          hourOfWeek: hourOfWeek()
        })
        this.episodes?.record('kalshi', 'entry', {
          marketId: sig.marketId,
          outcome: sig.outcome,
          strategy: sig.strategy,
          entryPrice: res.avgPrice,
          shares: res.shares,
          entrySideMid: round4(entrySideMid),
          hourOfWeek: hourOfWeek()
        })
        this.markExecuted(sig)
        result.executed++
        this.emit('autoopened', {
          strategy: sig.strategy,
          marketId: sig.marketId,
          outcome: sig.outcome,
          amount: round2(res.amount),
          shares: round2(res.shares),
          question: sig.question.slice(0, 80)
        })
      }
    } catch (err) {
      const msg = fmtErr(err)
      sig.error = msg
      result.errors.push(`execute ${sig.strategy} ${sig.marketId}: ${msg}`)
      if (mode === 'live') {
        this.liveErrorStreak++
        if (this.liveErrorStreak === 3) {
          this.alert('Oracle Trader — live order errors', `3 consecutive live order failures; latest: ${msg.slice(0, 200)}`)
        }
      }
      return
    }
    this.liveErrorStreak = 0
  }

  /** Signal strategies that rest inside the spread instead of crossing (fade keeps its own switch). */
  private makerEntryFor(strategy: string): boolean {
    // Consensus is taker-only by pre-registration: the +6.4c/contract was
    // measured at the Kalshi ASK, and a maker seat is a different strategy.
    // Enforced here rather than left to `makerStrategies` so that adding the
    // arm to that list by hand cannot silently change what is being tested —
    // and so the maker path, which has no place to record the Polymarket
    // source market, stays unreachable for it.
    if (strategy === 'consensus') return false
    if (strategy === 'fade') return this.config.fadeEntryMode === 'maker'
    return (this.config.makerStrategies ?? ['fade', 'book-imbalance', 'volume-spike', 'news', 'cross-venue', 'sports-anchor', 'flow-follow']).includes(strategy)
  }

  /**
   * Maker-mode entry (LIVE only): rest a post-only order inside the spread
   * instead of crossing it. NO rests a sell-YES (owning NO at 1 − restYes
   * when filled); YES rests a buy-YES bid. Either way the fill price beats
   * crossing, with zero taker fee on standard quadratic series. The order
   * carries a server-side expiration (before the pre-close exit window) and
   * is reconciled by managePendingOrders. Returns false when a maker entry is
   * not possible right now, so the caller takes the taker path instead.
   */
  private async executeMakerEntry(sig: AutoSignal, data: ScanData, result: AutoScanResult): Promise<boolean> {
    const book = data.books.get(sig.marketId)
    const yesBid = book?.bids[0]?.price
    const yesAsk = book?.asks[0]?.price
    const stake = this.stakeFor(data, sig.strategy)
    const expireMs = sig.closeTime ? sig.closeTime - (this.config.exitMinutesBeforeClose + 3) * 60_000 : 0
    // One-sided book or imminent expiry: let the taker path handle it.
    if (yesBid === undefined || yesAsk === undefined || expireMs < Date.now() + 120_000) return false
    // Improve our side of the book by 1¢ without crossing (1¢ spreads join it).
    const restYes =
      sig.outcome === 'NO'
        ? clamp01(Math.max(yesBid + 0.01, yesAsk - 0.01))
        : clamp01(Math.min(yesAsk - 0.01, yesBid + 0.01))
    const legCost = sig.outcome === 'NO' ? 1 - restYes : restYes
    const res = await this.engine
      .placeOrder({
        venue: VENUE,
        marketId: sig.marketId,
        outcome: sig.outcome,
        amount: stake,
        limitPrice: restYes,
        timeInForce: 'good_till_canceled',
        postOnly: true,
        expirationTs: Math.floor(expireMs / 1000),
        feeRate: sig.feeRate,
        ref: `auto:${sig.strategy}:maker:${sig.id}`,
        marketQuestion: sig.question
      })
      .catch((err: unknown) => {
        // A venue that answers a crossing post-only (or a self-trade block)
        // with an HTTP error must not abort the signal: without this catch
        // the taker fallback never ran and the live error streak ticked.
        const msg = err instanceof Error ? err.message : String(err)
        if (!/post.?only|would.?cross|cross|self.?trade/i.test(msg)) throw err
        this.episodes?.record('kalshi', 'reject', { marketId: sig.marketId, strategy: sig.strategy, outcome: sig.outcome, restYes: round4(restYes), yesBid, yesAsk, error: msg.slice(0, 120) })
        return null
      })
    if (!res || !res.orderId || (res.venueStatus === 'canceled' && res.shares <= 0)) {
      // A post-only that would cross is rejected by the venue — expected
      // occasionally, but a 100% rejection rate means the rest price formula
      // is wrong and the maker path is silently dead. Record every one, then
      // let the taker path take the price that just came to us. (A venue that
      // accepts and immediately cancels the order lands here too.)
      if (res) this.episodes?.record('kalshi', 'reject', { marketId: sig.marketId, strategy: sig.strategy, outcome: sig.outcome, restYes: round4(restYes), yesBid, yesAsk, venueStatus: res.venueStatus })
      return false
    }
    const winProb = typeof sig.details['winProb'] === 'number' ? (sig.details['winProb'] as number) : undefined
    if (res.shares > 0) {
      // post_only should never take, but honor any reported fill.
      this.promoteFill(sig.marketId, sig.question, sig.outcome, res.shares, res.avgPrice, sig.closeTime, sig.eventTicker, winProb, sig.makerFeeRate ?? 0, sig.strategy)
      this.markExecuted(sig)
      result.executed++
    }
    this.episodes?.record('kalshi', 'rest', {
      marketId: sig.marketId,
      strategy: sig.strategy,
      outcome: sig.outcome,
      orderId: res.orderId,
      restYes: round4(restYes),
      yesBid,
      yesAsk,
      count: round2(stake / Math.max(0.01, legCost))
    })
    this.state.pendingOrders.push({
      orderId: res.orderId,
      marketId: sig.marketId,
      eventTicker: sig.eventTicker,
      question: sig.question,
      strategy: sig.strategy,
      outcome: sig.outcome,
      yesPrice: restYes,
      makerFeeRate: sig.makerFeeRate ?? 0,
      // `count` is the order's TOTAL fillable count — the same quantity the
      // exchange holds and the same field amendOrder takes (kalshi.ts: "count
      // is the TOTAL fillable count"). It is NOT the remaining rest, and it
      // never changes; `promoted` tracks how much of it has filled so far.
      // Seeding `promoted` with any placement fill stops the reconcile below
      // from promoting those contracts a second time (markExecuted already
      // counted them, including the daily bump).
      count: Math.max(0, stake / Math.max(0.01, legCost)),
      promoted: res.shares,
      createdAt: Date.now(),
      closeTime: sig.closeTime,
      expirationTs: Math.floor(expireMs / 1000),
      modeledWinProb: winProb
    })
    sig.executed = true
    sig.executedAt = Date.now()
    this.emit('autoresting', {
      strategy: sig.strategy,
      marketId: sig.marketId,
      outcome: sig.outcome,
      yesPrice: round2(restYes),
      legCost: round2(legCost),
      question: sig.question.slice(0, 80)
    })
    return true
  }

  /** Add (or extend) an open trade from a maker fill (price = the traded leg's price). */
  private promoteFill(
    marketId: string,
    question: string | undefined,
    outcome: 'YES' | 'NO',
    shares: number,
    legPrice: number,
    closeTime?: number,
    eventTicker?: string,
    modeledWinProb?: number,
    feeRate?: number,
    strategy = 'fade',
    perfKey?: string
  ): void {
    const existing = this.state.openTrades.find((t) => t.marketId === marketId && t.outcome === outcome && t.strategy === strategy && (t.perfKey ?? '') === (perfKey ?? ''))
    if (existing) {
      const total = existing.shares + shares
      existing.entryPrice = (existing.entryPrice * existing.shares + legPrice * shares) / total
      existing.shares = total
      existing.amount += shares * legPrice
      return
    }
    this.noteEntry(marketId)
    this.state.openTrades.push({
      id: `${strategy}:maker:${marketId}:${Date.now()}`,
      feeRate: feeRate ?? 0,
      marketId,
      eventTicker,
      question,
      outcome,
      shares,
      amount: shares * legPrice,
      entryPrice: legPrice,
      strategy,
      perfKey,
      createdAt: Date.now(),
      closeTime,
      modeledWinProb,
      // No book in hand at promotion — the fill price is the reference
      // (maker fills sit at/inside the mid, so this UNDERSTATES CLV).
      entrySideMid: legPrice,
      hourOfWeek: hourOfWeek()
    })
    this.episodes?.record('kalshi', 'entry', {
      marketId,
      outcome,
      strategy,
      entryMode: 'maker',
      entryPrice: legPrice,
      shares,
      hourOfWeek: hourOfWeek()
    })
  }

  /**
   * Reconcile resting maker orders against the venue (LIVE): promote fills
   * into open trades, drop expired/canceled orders, and belt-and-braces
   * cancel anything past its expiration the server somehow kept.
   */
  private async managePendingOrders(result: AutoScanResult): Promise<void> {
    if (this.state.pendingOrders.length === 0) return
    const adapter = this.engine.getAdapter(VENUE)
    if (!adapter?.getOpenOrders) return
    // Mode flipped back to paper: reconcile ONE last time (fills since the
    // previous tick would otherwise become untracked real positions), then
    // cancel whatever still rests. The old cancel-and-wipe lost those fills.
    const finalSweep = this.engine.getExecutionMode() !== 'live'
    let open
    try {
      open = await adapter.getOpenOrders()
    } catch (err) {
      result.errors.push(`pending orders: ${fmtErr(err)}`)
      return // auth/network hiccup — keep local state, retry next tick
    }
    const byId = new Map(open.map((o) => [o.orderId, o]))
    let fills: import('../../shared/types').VenueFill[] = []
    if (adapter.getFills) {
      try {
        fills = await adapter.getFills(200)
      } catch (err) {
        // A failed fills fetch must NOT let the gone-branch below delete a
        // FILLED order as "expired" — that orphans a live position and
        // reopens the market to a double stake. Keep state; retry next tick.
        result.errors.push(`pending fills: ${fmtErr(err)}`)
        return
      }
    }

    for (const p of [...this.state.pendingOrders]) {
      const legOf = (yes: number): number => (p.outcome === 'NO' ? 1 - yes : yes)
      const o = byId.get(p.orderId)
      if (o && !this.strategyOn(p.strategy)) {
        // A strategy the ladder switched off must not keep working the book
        // through rests placed while it was on (2026-09-07: seven micro-maker
        // rests outlived their stop by hours). Cancel; the row stays so the
        // gone-branch reconciles any fill that lands first. A venue can refuse,
        // so ask at most every 30 minutes and say why.
        const rec = p as typeof p & { cancelAskedAt?: number }
        if (!rec.cancelAskedAt || Date.now() - rec.cancelAskedAt > 30 * 60_000) {
          rec.cancelAskedAt = Date.now()
          try {
            await adapter.cancelOrder(p.orderId)
            this.episodes?.record('kalshi', 'pull', { marketId: p.marketId, strategy: p.strategy, orderId: p.orderId, reason: 'strategy off', filled: p.promoted })
          } catch (err) {
            console.warn(`[auto-trader] cancel refused for ${p.orderId} on ${p.marketId} (${p.strategy} is off): ${fmtErr(err).slice(0, 160)}`)
          }
        }
        // A fill that landed on the stopped arm's rest is real inventory whatever the cancel did: promote it now, not
        // when the order finally leaves the book hours later (audit 2026-09-19, B-17).
        const filledWhileOff = o.fillCount - p.promoted
        if (filledWhileOff > 0.005) {
          this.promoteFill(p.marketId, p.question, p.outcome, filledWhileOff, legOf(p.yesPrice), p.closeTime, p.eventTicker, p.modeledWinProb, p.makerFeeRate ?? 0, p.strategy, p.perfKey)
          if (p.promoted === 0) this.bumpDaily()
          p.promoted = o.fillCount
          this.emit('autoopened', { marketId: p.marketId, outcome: p.outcome, shares: round2(filledWhileOff), price: legOf(p.yesPrice), strategy: p.strategy, reason: 'maker fill on a stopped strategy' })
        }
        continue
      }
      if (o) {
        // Still resting: promote any newly filled portion.
        const newlyFilled = o.fillCount - p.promoted
        if (newlyFilled > 0.005) {
          this.promoteFill(p.marketId, p.question, p.outcome, newlyFilled, legOf(p.yesPrice), p.closeTime, p.eventTicker, p.modeledWinProb, p.makerFeeRate ?? 0, p.strategy, p.perfKey)
          if (p.promoted === 0) this.bumpDaily()
          p.promoted = o.fillCount
          this.emit('autoopened', {
            strategy: p.strategy,
            marketId: p.marketId,
            outcome: p.outcome,
            amount: round2(newlyFilled * legOf(p.yesPrice)),
            shares: round2(newlyFilled),
            question: (p.question ?? '').slice(0, 80)
          })
        }
        if (Date.now() / 1000 > p.expirationTs + 120) {
          // Same race as the edge-decay pull: a fill can land between the
          // orders snapshot and this cancel. Leave the row; the gone-branch
          // reconciles fills from the feed and then removes it.
          await adapter.cancelOrder(p.orderId).catch(() => undefined)
          this.episodes?.record('kalshi', 'pull', { marketId: p.marketId, strategy: p.strategy, orderId: p.orderId, reason: 'expired', filled: p.promoted })
          continue
        }
        // Maker repricing: as the book moves, keep the rest competitive —
        // amend in place (no cancel/recreate gap), or pull the order when
        // the recomputed edge no longer clears the gate.
        // Repricing actively works an entry toward a fill, so an emergency
        // stop must switch it off: after the drawdown kill switch trips (or
        // stopEntry is set) the bot would otherwise keep chasing the book on
        // every tick and filling new positions, which is the opposite of
        // "halt new entries". Resting orders are left to fill, decay out, or
        // expire on their own — deliberately NOT cancelled wholesale here,
        // because a cancel that races a fill orphans the position (see the
        // gone-branch).
        //
        // The STALENESS pull below is the exception, and it runs while halted.
        // It is cancel-only and fires only on a rest the market has already
        // walked away from, i.e. the one case where leaving the order to "fill
        // on its own" means being picked off by a counterparty who knows the
        // price moved. A halted account is the last one that should be taking
        // those. Gating it behind `halted` meant the kill switch turned off the
        // defence against adverse fills at the moment it declared the day a
        // loss (found 2026-09-21, the day the switch tripped at -$13.43).
        const halted = this.state.dailyPnl.tripped || this.config.stopEntry
        if (!finalSweep && adapter.getOrderBook) {
          const ob = await adapter.getOrderBook(p.marketId).catch(() => undefined)
          const bid = ob?.bids[0]?.price
          const ask = ob?.asks[0]?.price
          // Universal staleness pull, every maker arm. Cancel-only: nothing is placed, amended or resized here,
          // so the worst case is an order we would have wanted being withdrawn. The row is deliberately NOT
          // dropped - the same reasoning as the edge pull below, a cancel can race a fill and the gone-branch
          // reconciles it against the fills feed on the next tick.
          if (bid !== undefined && ask !== undefined) {
            const mid = (bid + ask) / 2
            const ourMid = p.outcome === 'NO' ? 1 - mid : mid
            const ourLimit = p.outcome === 'NO' ? 1 - p.yesPrice : p.yesPrice
            if (restIsStale(ourLimit, ourMid)) {
              await adapter.cancelOrder(p.orderId, p.marketId).catch(() => undefined)
              this.episodes?.record('kalshi', 'pull', { marketId: p.marketId, strategy: p.strategy, orderId: p.orderId, reason: 'stale-rest', ourLimit: round2(ourLimit), mid: round2(ourMid), filled: p.promoted, restedSec: Math.round((Date.now() - p.createdAt) / 1000) })
              this.emit('autoexpired', { marketId: p.marketId, question: `market moved away from the rest (${(100 * (ourLimit - ourMid)).toFixed(1)}c) - pulled` })
              continue
            }
          }
          if (!halted && adapter.amendOrder && p.strategy === 'fade' && bid !== undefined && ask !== undefined) {
            const desired =
              p.outcome === 'NO'
                ? clamp01(Math.max(bid + 0.01, ask - 0.01))
                : clamp01(Math.min(ask - 0.01, bid + 0.01))
            const calibrated = p.outcome === 'NO' ? calibratedYesRate(desired) : 1 - 2 * calibratedYesRate(1 - desired)
            const edgeCents = (p.outcome === 'NO' ? desired - calibrated : calibrated - desired) * 100
            if (edgeCents < this.config.fadeMinEdgeCents) {
              // Cancel, but do NOT drop the row here. cancelOrder is
              // fire-and-forget and can race a fill that landed during this
              // same pass (the open-orders snapshot is seconds stale by now);
              // deleting on that race orphans real contracts that no longer
              // appear in openTrades — never exited, and invisible to the
              // duplicate-entry guard, so the market could be entered twice.
              // Leaving the row lets the next tick's gone-branch reconcile it
              // against the fills feed, which already promotes any fill and
              // then removes it. If the cancel silently failed, the order is
              // still resting and simply gets pulled again.
              await adapter.cancelOrder(p.orderId).catch(() => undefined)
              this.episodes?.record('kalshi', 'pull', { marketId: p.marketId, strategy: p.strategy, orderId: p.orderId, edgeCents: round2(edgeCents), filled: p.promoted })
              this.emit('autoexpired', { marketId: p.marketId, question: `edge decayed (${edgeCents.toFixed(1)}¢) — pulled` })
              continue
            }
            if (shouldRepriceMaker(desired, p.yesPrice)) {
              const side = p.outcome === 'NO' ? 'ask' : 'bid'
              // The amend carries the order's TOTAL size, and already-filled
              // contracts are INSIDE that total. Adding `promoted` back on top
              // re-rested the filled portion: after F of T filled, the order
              // became T+F, leaving T resting instead of T-F. Every
              // fill-then-reprice cycle restored full size, ratcheting the
              // position past amountPerTrade and maxBalancePct without bound.
              const total = p.count
              try {
                const am = await adapter.amendOrder(p.orderId, p.marketId, side, desired, total)
                p.yesPrice = desired
                const newly = am.fillCount - p.promoted
                if (newly > 0.005) {
                  this.promoteFill(p.marketId, p.question, p.outcome, newly, legOf(am.avgYes > 0 ? am.avgYes : desired), p.closeTime, p.eventTicker, p.modeledWinProb, p.makerFeeRate ?? 0, p.strategy, p.perfKey)
                  if (p.promoted === 0) this.bumpDaily()
                  p.promoted = am.fillCount
                }
                this.episodes?.record('kalshi', 'amend', { marketId: p.marketId, strategy: p.strategy, orderId: p.orderId, from: p.yesPrice, to: desired, ok: true, filled: am.fillCount })
              } catch (err) {
                // An amend CAN legitimately race a fill or expiry, and the next
                // tick's reconcile resolves that. But an empty catch made a 400
                // on EVERY amend indistinguishable from success — a maker path
                // that never reprices would look healthy. Record it, and surface
                // one message per scan so a systematic failure is visible.
                const msg = fmtErr(err)
                this.episodes?.record('kalshi', 'amend', { marketId: p.marketId, strategy: p.strategy, orderId: p.orderId, from: p.yesPrice, to: desired, ok: false, error: msg })
                if (!result.errors.some((e) => e.startsWith('amend failed'))) result.errors.push(`amend failed: ${msg}`)
              }
            }
          }
        }
        continue
      }
      // Gone from the resting list: executed or canceled/expired. The fills
      // feed tells us which (fills carry the order id; fill price is already
      // the traded leg's price).
      const mine = fills.filter((f) => f.orderId === p.orderId)
      const filledTotal = mine.reduce((s, f) => s + f.shares, 0)
      const newlyFilled = filledTotal - p.promoted
      if (newlyFilled > 0.005) {
        const vwap =
          mine.reduce((s, f) => s + f.price * f.shares, 0) / Math.max(filledTotal, 0.01)
        this.promoteFill(p.marketId, p.question, p.outcome, newlyFilled, vwap > 0 ? vwap : legOf(p.yesPrice), p.closeTime, p.eventTicker, p.modeledWinProb, p.makerFeeRate ?? 0, p.strategy, p.perfKey)
        if (p.promoted === 0) this.bumpDaily()
        this.emit('autoopened', {
          strategy: 'fade',
          marketId: p.marketId,
          outcome: p.outcome,
          amount: round2(newlyFilled * (vwap > 0 ? vwap : legOf(p.yesPrice))),
          shares: round2(newlyFilled),
          question: (p.question ?? '').slice(0, 80)
        })
      } else if (filledTotal <= 0.005) {
        this.emit('autoexpired', { marketId: p.marketId, question: (p.question ?? '').slice(0, 80) })
      } else if (filledTotal < p.promoted) {
        // The venue reports FEWER fills than we have already promoted. That means the window we reconciled
        // against (the newest 200 account fills, 356-687 a day) no longer reaches this order's earlier slice, so
        // the remainder is invisible and neither branch above fires: the row is dropped silently (audit B-53).
        // Nothing is promoted on a number we cannot trust - it stays a diagnostic until the window is widened.
        console.warn(`[auto-trader] fill window too short for ${p.marketId}: venue reports ${filledTotal} against ${p.promoted} already promoted`)
        this.episodes?.record('kalshi', 'pull', { marketId: p.marketId, strategy: p.strategy, orderId: p.orderId, reason: 'fill-window-short', filled: filledTotal, promoted: p.promoted, ageMin: Math.round((Date.now() - p.createdAt) / 60_000) })
      }
      this.removePending(p.orderId)
    }
    if (finalSweep) {
      for (const p of [...this.state.pendingOrders]) {
        await adapter.cancelOrder(p.orderId).catch(() => undefined)
        this.removePending(p.orderId)
      }
    }
    this.persist()
  }

  private removePending(orderId: string): void {
    this.state.pendingOrders = this.state.pendingOrders.filter((p) => p.orderId !== orderId)
  }

  /**
   * Safety sweep (live, every 5 min): venue-side state the ledger doesn't
   * know about. Unknown resting orders with our client-id prefix (a POST
   * whose response was lost) are canceled; venue positions no ledger tracks
   * are alerted once — never auto-traded.
   */
  private async orphanSweep(): Promise<void> {
    if (this.engine.getExecutionMode() !== 'live') return
    const now = Date.now()
    // Boot gate: until one live sweep has FETCHED cleanly since process
    // start (or since arming live), entries stay blocked — a crash-restart
    // with stale local state must be observed before new money moves. While
    // unreconciled the 5-min throttle is bypassed so the gate clears on the
    // first healthy tick.
    if (this.reconciledLive && now - this.lastOrphanSweep < 5 * 60_000) return
    this.lastOrphanSweep = now
    const adapter = this.engine.getAdapter(VENUE)
    if (!adapter) return
    let fetchedClean = true
    if (adapter.getOpenOrders) {
      let open: OpenOrder[] = []
      try {
        open = await adapter.getOpenOrders()
      } catch {
        fetchedClean = false
      }
      for (const o of open) {
        // Ours = the order journal knows it (every journaled order carries a UUID client id since 2026-09-15) or the
        // legacy 'ot-' prefix. The prefix alone made this branch dead code for four days: an untracked resting order
        // after a lost response stayed resting and could fill beside a second entry (audit 2026-09-19, B-05).
        // An order neither the journal nor the prefix recognises (placed by hand at the venue) is left alone.
        const ours = o.clientOrderId?.startsWith('ot-') || this.engine.ownsOrder(VENUE, o.orderId, o.clientOrderId)
        // The thin quoter's resting orders are not in pendingOrders; they are not orphans.
        if (ours && !this.state.pendingOrders.some((p) => p.orderId === o.orderId) && !this.quoter.ownsOrder(o.orderId)) {
          await adapter.cancelOrder(o.orderId).catch(() => undefined)
          this.emit('orphanorder', { marketId: o.marketId, orderId: o.orderId })
          this.alert('Oracle Trader — orphan order canceled', `Untracked resting order on ${o.marketId} (lost response or crash mid-place) was canceled.`)
        }
      }
    }
    let positions: Position[] = []
    try {
      positions = await adapter.getPositions()
    } catch {
      fetchedClean = false
    }
    if (fetchedClean) this.reconciledLive = true
    for (const pos of positions) {
      // The sub-engines keep their positions in their own files, and an acknowledged journal row with a
      // sub-engine ref is the same fact from the order side: neither is an orphan. Until 2026-09-19 every
      // lead-lag and convergence position alerted "untracked - review it" once per ticker (audit B-27).
      const journalRef = this.engine.recoveredOrder?.(VENUE, pos.marketId)?.ref
      const tracked =
        this.state.openTrades.some((t) => t.marketId === pos.marketId || t.legs?.some((l) => l.marketId === pos.marketId)) ||
        this.state.pendingOrders.some((p) => p.marketId === pos.marketId) ||
        this.subEngineHolds(pos.marketId) ||
        (journalRef !== undefined && !journalRef.startsWith('auto:')) ||
        // Settled here already: the venue lists a determined position for up to its settlement timer (30 min on
        // the 2026-09-19 case), and adopting it again booked the same settlement on every sweep.
        this.recentlySettled(pos.marketId)
      if (!tracked && pos.shares > 0) {
        // A position the journal can explain - an acknowledged BUY of ours whose response was lost, recovered by
        // reconcileOrders - is ADOPTED into the ledger under its strategy, so it is exited, graded and counted
        // like any entry and the market cannot be bought a second time. Until 2026-09-19 it was only alerted
        // (audit B-09). A position the journal cannot explain (a manual trade) is still only alerted.
        const row = this.engine.recoveredOrder?.(VENUE, pos.marketId)
        const strategy = row?.side === 'buy' && row.ref?.startsWith('auto:') ? row.ref.split(':')[1] : undefined
        if (row && strategy && row.outcome === pos.outcome) {
          const mk = await adapter.getMarket(pos.marketId).catch(() => undefined)
          this.state.openTrades.push({
            id: `recovered:${row.orderId ?? row.clientOrderId}`,
            marketId: pos.marketId,
            question: mk?.question,
            outcome: pos.outcome,
            shares: pos.shares,
            amount: round2(pos.shares * pos.avgPrice),
            entryPrice: pos.avgPrice,
            strategy,
            createdAt: row.acknowledgedAt ?? row.requestedAt,
            closeTime: mk?.closeTime,
            feeRate: mk?.feeRate
          })
          this.persist()
          console.log(`[auto-trader] adopted recovered ${pos.outcome} x${pos.shares} on ${pos.marketId} for ${strategy} (journal ${row.clientOrderId.slice(0, 8)})`)
          this.alert('Oracle Trader — recovered position adopted', `${pos.outcome} ×${pos.shares.toFixed(2)} on ${pos.marketId}: a ${strategy} buy whose response was lost is now tracked and managed.`)
          continue
        }
      }
      if (!tracked && !this.orphanAlerted.has(pos.marketId)) {
        this.orphanAlerted.add(pos.marketId)
        this.emit('orphanposition', { marketId: pos.marketId, outcome: pos.outcome, shares: round2(pos.shares) })
        this.alert(
          'Oracle Trader — untracked position',
          `${pos.outcome} ×${pos.shares.toFixed(2)} on ${pos.marketId} exists at the venue but no strategy tracks it (manual trade or phantom fill). Not auto-managed — review it.`
        )
      }
    }
  }

  /**
   * Detach the strategy's open trades and resting orders from its live
   * evidence: their exits record under `<strategy>:<label>` instead of the
   * strategy key, so a stage that starts now is judged only on trades it
   * opened. The ladder calls this when it captures a stage baseline. Returns
   * the number detached; trades already detached keep their first label.
   */
  detachOpenTrades(strategy: string, label: string): number {
    const key = `${strategy}:${label}`
    let n = 0
    for (const t of this.state.openTrades) {
      if (t.strategy === strategy && !t.perfKey) {
        t.perfKey = key
        n++
      }
    }
    for (const p of this.state.pendingOrders) {
      if (p.strategy === strategy && !p.perfKey) {
        p.perfKey = key
        n++
      }
    }
    if (n > 0) this.persist()
    return n
  }

  private bumpDaily(): void {
    if (this.state.daily.date === nowDate()) this.state.daily.count++
    else this.state.daily = { date: nowDate(), count: 1 }
    this.state.stats.executed++
  }

  /** A market a sub-engine holds (convergence, lead-lag) or rests a quote on. */
  private subEngineHolds(marketId: string): boolean {
    return this.convergenceEngine.heldTickers().has(marketId) || this.leadLagEngine.heldTickers().has(marketId) || this.quoter.restingMarketIds().has(marketId)
  }

  /** A market this trader holds or rests on, for the sub-engines' own cross-arm check (audit B-28). */
  private holdsMarket(marketId: string): boolean {
    return this.state.openTrades.some((t) => t.marketId === marketId || t.legs?.some((l) => l.marketId === marketId)) ||
      this.state.pendingOrders.some((p) => p.marketId === marketId)
  }

  /** Markets the thin quoter filled on since `sinceMs` (its own sidecar), for the ladder's quoter evidence (audit B-22). */
  quoterFilledMarkets(sinceMs: number): Set<string> {
    return this.quoter.filledMarkets(sinceMs)
  }

  /**
   * Markets any arm OTHER than `ref` filled on since `sinceMs`, from the engine's shared fill history (every
   * routed order records there with its ref). The ladder excludes these from an arm's settlement evidence,
   * because the venue settles one net position per market.
   */
  otherArmMarkets(ref: string, sinceMs: number): Set<string> {
    const out = new Set<string>()
    for (const r of this.engine.getHistory(5000, VENUE)) {
      if (r.timestamp < sinceMs || r.side !== 'buy') continue
      const owner = r.ref ?? r.strategyRef ?? ''
      if (owner && owner !== ref && owner !== 'settled') out.add(r.marketId)
    }
    return out
  }

  private async executeDutch(sig: AutoSignal, data: ScanData, adapter: import('../../shared/venue').VenueAdapter): Promise<void> {
    const legs = sig.groupLegs ?? []
    const entries: AutoOpenTradeLeg[] = []
    const perLeg = this.stakeFor(data, 'dutch') / legs.length
    let totalAmount = 0
    let totalShares = 0
    // A leg another trade of ours already holds or rests on would be netted by the venue into that position
    // and unwound with it (audit 2026-09-19, B-24: Dutch legs bypassed the per-market guards).
    const heldLeg = legs.find((l) => this.holdsMarket(l) || this.subEngineHolds(l))
    if (heldLeg) throw new Error(`Dutch leg ${heldLeg}: market already held`)
    try {
      // Re-check the live books: the arb must survive at execution time.
      let sumBids = 0
      const liveBids: number[] = []
      for (const leg of legs) {
        const ob = await adapter.getOrderBook!(leg)
        const yesBid = ob.bids[0]?.price
        if (yesBid === undefined) throw new Error(`Dutch leg ${leg}: no resting bid`)
        liveBids.push(yesBid)
        sumBids += yesBid
      }
      if (sumBids <= 1 + this.config.dutchMinOverSum) {
        throw new Error(`Dutch arb vanished (Σbids ${sumBids.toFixed(3)})`)
      }
      for (let i = 0; i < legs.length; i++) {
        const res = await this.engine.placeOrder({
          venue: VENUE,
          marketId: legs[i],
          outcome: 'NO',
          amount: perLeg,
          limitPrice: clamp01(liveBids[i] - 0.01),
          timeInForce: 'immediate_or_cancel',
          // Without this the paper broker models every Dutch leg fee-free
          // (paper.ts feeFor returns 0 for an undefined rate), so a paper
          // forward test reports a profit on an arb that the per-leg taker
          // fees actually turn negative — the worst possible input to a
          // decision about arming it.
          feeRate: sig.feeRate,
          ref: `auto:dutch:${sig.id}`,
          marketQuestion: sig.question
        })
        if (res.status === 'open' || res.shares <= 0) {
          await adapter.cancelOrder(res.orderId).catch(() => undefined)
          throw new Error(`Dutch leg ${legs[i]}: no fill`)
        }
        entries.push({ marketId: legs[i], outcome: 'NO', shares: res.shares, amount: res.amount, entryPrice: res.avgPrice })
        totalAmount += res.amount
        totalShares += res.shares
        // A partial leg is not a basket: the payout no longer covers every outcome (audit B-24). Record the
        // slice so the unwind below sells exactly it, then abandon the basket.
        const wanted = perLeg / Math.max(0.01, clamp01(liveBids[i] - 0.01))
        if (res.shares < wanted * 0.99 - 0.005) throw new Error(`Dutch leg ${legs[i]}: partial fill ${res.shares.toFixed(2)} of ${wanted.toFixed(2)}`)
      }
      this.state.openTrades.push({
        id: sig.id,
        marketId: sig.marketId,
        question: sig.question,
        outcome: 'NO',
        shares: totalShares,
        amount: totalAmount,
        entryPrice: totalAmount / (totalShares || 1),
        strategy: 'dutch',
        createdAt: Date.now(),
        closeTime: sig.closeTime,
        legs: entries
      })
      this.markExecuted(sig)
      this.emit('autoopened', {
        strategy: 'dutch',
        marketId: sig.marketId,
        legs: legs.length,
        amount: round2(totalAmount),
        question: sig.question.slice(0, 80)
      })
    } catch (err) {
      // Unwind legs already placed so we never carry one-sided Dutch risk. Sell THIS basket's shares, not the
      // whole venue position (which also held any fade NO on the same strike - audit B-24), and keep any leg the
      // unwind could not sell in the ledger as a tracked basket rather than dropping it unbooked.
      const stranded: AutoOpenTradeLeg[] = []
      for (const e of entries) {
        try {
          const res = await this.engine.sellPosition({ venue: VENUE, marketId: e.marketId, outcome: 'NO', shares: e.shares, ref: 'auto:dutch' })
          if (res.shares < e.shares - 0.01) stranded.push({ ...e, shares: e.shares - Math.max(0, res.shares), amount: e.amount * (1 - Math.max(0, res.shares) / e.shares) })
        } catch (unwindErr) {
          console.warn(`[auto-trader] dutch unwind failed on ${e.marketId}: ${fmtErr(unwindErr)}`)
          stranded.push(e)
        }
      }
      if (stranded.length > 0) {
        const amount = stranded.reduce((a, l) => a + l.amount, 0)
        const shares = stranded.reduce((a, l) => a + l.shares, 0)
        this.state.openTrades.push({
          id: `${sig.id}:stranded`, marketId: sig.marketId, question: sig.question, outcome: 'NO', shares, amount,
          entryPrice: amount / (shares || 1), strategy: 'dutch', createdAt: Date.now(), closeTime: sig.closeTime, legs: stranded, feeRate: sig.feeRate
        })
        this.persist()
        this.alert('Oracle Trader — Dutch unwind incomplete', `${stranded.length} leg(s) of ${sig.marketId} could not be sold back after a failed basket; they are held to settlement as a tracked (one-sided) position.`)
      }
      throw err
    }
  }

  private markExecuted(sig: AutoSignal): void {
    sig.executed = true
    sig.executedAt = Date.now()
    this.state.stats.executed++
    if (this.state.daily.date === nowDate()) this.state.daily.count++
    else {
      this.state.daily = { date: nowDate(), count: 1 }
    }
  }

  // ---- exits & settlement ----

  private async manageExits(result: AutoScanResult): Promise<void> {
    if (this.config.dryRun) return // dry-run trades nothing — exits included
    const adapter = this.engine.getAdapter(VENUE)
    if (!adapter || this.state.openTrades.length === 0) return
    const mode = this.engine.getExecutionMode()

    const exitTrades = [...this.state.openTrades]
    const batchQuotes = adapter.getPrices ? new Map((await adapter.getPrices(exitTrades).catch(() => []))
      .map(q => [`${q.marketId}:${q.outcome}`, q])) : undefined
    // Fetch four independent quotes together; keep all exit/accounting mutations in their original order.
    for (let offset = 0; offset < exitTrades.length; offset += 4) {
      const batch = exitTrades.slice(offset, offset + 4)
      const quotes = batchQuotes ? batch.map(t => batchQuotes.get(`${t.marketId}:${t.outcome}`))
        : await Promise.all(batch.map(t => adapter.getPrice(t.marketId, t.outcome).catch(() => undefined)))
      for (const [index, t] of batch.entries()) {
      // A lost exit response is resolved before anything else touches the trade (audit B-25).
      if (t.exitUnknownAt !== undefined && await this.reconcileUnknownExit(t, adapter)) continue
      if (!this.state.openTrades.includes(t)) continue
      // Fade holds to settlement by default (its edge is thinner than the
      // second spread); with fadeExitEnabled it uses the TP/SL path instead.
      // Momentum (2026-09-07) holds to settlement too: its reversal exits and
      // re-entries were the churn, and a directional read that needs an exit
      // rule to be right is not a read worth taking.
      const isHoldToSettle = holdsToSettlement(t.strategy, this.config)
      // Every trade gets a quote each pass — hold-to-settle included — so the
      // ledger carries a pre-settlement freeze (CLV) and a 5-min markout.
      const quote = quotes[index]
      if (quote && quote.price > 0) {
        this.stampDayMark(t)
        t.lastSideMid = round4(quote.price)
        t.lastSideMidAt = quote.timestamp
        t.minSideMid = Math.min(t.minSideMid ?? t.lastSideMid, t.lastSideMid)
        t.maxSideMid = Math.max(t.maxSideMid ?? t.lastSideMid, t.lastSideMid)
        if (t.markout5mCents === undefined && t.entrySideMid !== undefined && Date.now() - t.createdAt >= 5 * 60_000) {
          t.markout5mCents = round2((quote.price - t.entrySideMid) * 100)
        }
      }
      // Past close the venue will not fill anything: the only way out is
      // settlement. Trying anyway spent 467 IOC orders on one $0.30 position
      // (KXHIGHLAX-26SEP08-T89) and, because a fired exit `continue`s, starved
      // the settlement check below so the trade never booked at all.
      const pastClose = t.closeTime !== undefined && Date.now() > t.closeTime + SETTLE_GRACE_MS
      if (!isHoldToSettle && !pastClose) {
        if (quote) {
          const value = t.shares * quote.price
          const pnlPct = t.amount > 0 ? ((value - t.amount) / t.amount) * 100 : 0
          let reason: string | null = null
          if (this.config.takeProfitPct > 0 && pnlPct >= this.config.takeProfitPct) reason = `take-profit +${pnlPct.toFixed(1)}%`
          else if (this.config.stopLossPct > 0 && pnlPct <= -this.config.stopLossPct) reason = `stop-loss ${pnlPct.toFixed(1)}%`
          else if (t.closeTime && Date.now() >= t.closeTime - this.config.exitMinutesBeforeClose * 60_000) reason = 'pre-close exit'
          else if (this.config.maxHoldMinutes > 0 && Date.now() - t.createdAt >= this.config.maxHoldMinutes * 60_000) reason = 'max hold'
          else if (this.config.reversalExit && this.config.reversalExitPct > 0) {
            // quote and entryPrice are BOTH in the position's own leg terms
            // (NO quotes are already NO prices), so "against" is simply a
            // falling price — the old per-outcome sign flip dumped winners.
            const moved = quote.price - t.entryPrice
            const against = -moved
            if (against >= this.config.reversalExitPct) reason = `reversal -${against.toFixed(2)}`
          }
          // Only a trade that actually left the book skips the settlement
          // check; a no-fill must still be allowed to settle on this pass.
          if (reason && (await this.closeTrade(t, reason, pnlPct, quote.price, result))) continue
        }
      }
      // Settlement check (all trades, once past close + grace).
      //
      // The close time cached at ENTRY can be badly stale: esports and sports
      // markets finalize when play ends, and Kalshi then moves close_time
      // earlier. Three finalized WINS were found sitting unbooked because our
      // cached closeTime was over a day in the future, so the gate below could
      // not fire. A quote pinned at an extreme means the market has almost
      // certainly resolved, so probe it too (throttled to 10 min/trade).
      // trySettle books nothing without an explicit yes/no, so a false probe
      // costs one fetch.
      const probeDue = settlementProbeDue(quote?.price, this.settleProbeAt.get(t.id), Date.now())
      if (t.closeTime && Date.now() > t.closeTime + SETTLE_GRACE_MS) {
        await this.trySettle(t, result)
      } else if (probeDue) {
        this.settleProbeAt.set(t.id, Date.now())
        await this.trySettle(t, result)
      } else if (!t.closeTime && mode === 'live' && Date.now() - t.createdAt > 26 * 60_000) {
        await this.trySettle(t, result)
      }
      }
    }
  }

  /**
   * Close a trade with a marketable limit, VERIFY the fill, and escalate.
   * The old path assumed every IOC sell filled and deleted the trade from
   * the ledger — a missed stop-loss then left a live position unmanaged.
   * Escalation: attempt n crosses the spread by n cents (book refetched
   * inside the adapter each attempt via the limit we pass).
   *
   * Returns true only when the trade has left the ledger. The caller uses that
   * to decide whether to skip the settlement check: a no-fill or a partial
   * leaves a position that may well be settleable on this very pass.
   *
   * DELIBERATELY NOT KILL-SWITCH GATED (confirmed with the operator
   * 2026-09-18). The entry path consults killSwitchCheck; this exit path does
   * not. The asymmetry is intended: during testing a tripped switch must stop
   * NEW risk without also trapping an open position, so exits stay available
   * to flatten. Do not gate this on killSwitchTripped without deciding that
   * first - it would strand live positions whenever the switch trips.
   */
  private async closeTrade(t: AutoOpenTrade, reason: string, pnlPct: number, quotePrice: number, result: AutoScanResult): Promise<boolean> {
    const adapter = this.engine.getAdapter(VENUE)!
    const attempt = (t.exitAttempts ?? 0) + 1
    const cross = Math.min(attempt, 5) * 0.01
    let limit: number | undefined
    const ob = adapter.getOrderBook ? await adapter.getOrderBook(t.marketId).catch(() => undefined) : undefined
    if (t.outcome === 'YES') {
      const bid = ob?.bids[0]?.price
      limit = bid !== undefined ? clamp01(bid - cross) : undefined
    } else {
      const ask = ob?.asks[0]?.price
      limit = ask !== undefined ? clamp01(ask + cross) : undefined
    }
    try {
      const res = await this.engine.sellPosition({
        venue: VENUE,
        ref: `auto:${t.strategy}`,
        marketId: t.marketId,
        outcome: t.outcome,
        // Sell only THIS trade's size — closing the whole venue position
        // would liquidate coexisting manual holdings and misattribute P&L.
        shares: t.shares,
        limitPrice: limit,
        timeInForce: 'immediate_or_cancel'
      })
      if (res.shares <= 0) {
        t.exitAttempts = attempt
        result.errors.push(`exit ${t.marketId}: no fill (attempt ${attempt})`)
        return false
      }
      if (res.shares < t.shares - 0.01) {
        // Partial close: realize the filled slice, keep the rest working.
        const fraction = res.shares / t.shares
        // Net of BOTH fee legs: the venue's exit fee on this fill and the
        // entry fee for the slice being closed.
        const pnl = res.realizedPnl !== undefined ? res.realizedPnl : (res.avgPrice - t.entryPrice) * res.shares - (res.fee ?? 0) - entryFeeDollars(t) * fraction
        t.shares -= res.shares
        t.amount *= 1 - fraction
        t.exitAttempts = attempt
        // res.shares, NOT t.shares: t.shares is now the unsold remainder.
        this.recordExit(pnl, t.perfKey ?? t.strategy, t, res.shares)
        this.emit('autoexited', {
          marketId: t.marketId,
          outcome: t.outcome,
          reason: `${reason} (partial ${round2(res.shares)})`,
          pnlPct: round2(pnlPct),
          realized: round2(pnl)
        })
        return false
      }
      // INVARIANT: res.fee is the EXIT-side fee only; the entry fee is added back
      // separately via entryFeeDollars(). Both legs are subtracted here, so if a
      // venue ever returns realizedPnl net of the entry fee while still setting
      // res.fee, the entry fee would be double-counted. The 
      // entryFeeDollars x 100 / shares === netCentsOf fee term invariant in
      // scripts/tests/kalshi-fee.test.ts is what pins the two together.
      const pnl = res.realizedPnl !== undefined ? res.realizedPnl : (res.avgPrice > 0 ? res.avgPrice - t.entryPrice : quotePrice - t.entryPrice) * res.shares - (res.fee ?? 0) - entryFeeDollars(t)
      // Remove BEFORE booking: recordExit persists, and a restart between a persisted exit and the removal
      // reloaded the closed trade as open (three times in production; audit 2026-09-19, B-03). trySettle
      // already orders it this way.
      this.removeTrade(t.id)
      this.recordExit(pnl, t.perfKey ?? t.strategy, t)
      this.emit('autoexited', { marketId: t.marketId, outcome: t.outcome, reason, pnlPct: round2(pnlPct), realized: round2(pnl) })
      return true
    } catch (err) {
      const msg = fmtErr(err)
      if (/no (paper )?position/i.test(msg)) {
        // Closed manually from the panel (or settled venue-side) — the broker
        // no longer holds it, so drop the stale ledger entry.
        this.removeTrade(t.id)
        return true
      }
      t.exitAttempts = attempt
      result.errors.push(`exit ${t.marketId}: ${msg}`)
      // A live sell that neither returned nor was refused may have filled. Hold the trade until the journal
      // recovers the order (reconcileUnknownExit) instead of retrying blind, settling it at full size, or
      // dropping it unbooked (audit 2026-09-19, B-25). An explicit 4xx or a journal refusal is not ambiguous.
      const explicit = (err instanceof HttpError && [400, 401, 403, 404, 422, 429].includes(err.status)) || /Unresolved submission|awaiting venue reconciliation/i.test(msg)
      if (this.engine.getExecutionMode() === 'live' && !explicit && t.exitUnknownAt === undefined) {
        t.exitUnknownAt = Date.now()
        this.persist()
      }
    }
    return false
  }

  /**
   * Resolve an exit whose response was lost. Returns true while the trade must stay untouched (the submission
   * is still pending at the journal), false once it is resolved: either the recovered sell's fills were booked
   * (a full fill removes the trade), or the venue never created the order and the exit ladder may retry.
   */
  private async reconcileUnknownExit(t: AutoOpenTrade, adapter: import('../../shared/venue').VenueAdapter): Promise<boolean> {
    if (t.exitUnknownAt === undefined) return false
    const row = this.engine.recoveredOrder?.(VENUE, t.marketId)
    const sell = row && row.side === 'sell' && row.orderId && row.requestedAt >= t.exitUnknownAt - 5 * 60_000 ? row : undefined
    if (!sell) {
      if (this.engine.submissionPending(VENUE, t.marketId)) return true
      // Released by the journal: nothing exists at the venue, the exit ladder may try again.
      delete t.exitUnknownAt
      this.persist()
      return false
    }
    let fills: import('../../shared/types').VenueFill[]
    try {
      fills = adapter.getFills ? await adapter.getFills(300) : []
    } catch {
      return true
    }
    const mine = fills.filter((f) => f.orderId === sell.orderId)
    const shares = Math.min(t.shares, mine.reduce((a, f) => a + f.shares, 0))
    if (shares <= 0.005) {
      // An IOC the venue accepted but that crossed nothing: no position changed hands.
      delete t.exitUnknownAt
      this.persist()
      return false
    }
    const avg = mine.reduce((a, f) => a + f.price * f.shares, 0) / mine.reduce((a, f) => a + f.shares, 0)
    const fee = mine.reduce((a, f) => a + (f.fee ?? 0), 0)
    const fraction = shares / t.shares
    const pnl = (avg - t.entryPrice) * shares - fee - entryFeeDollars(t) * fraction
    const full = shares >= t.shares - 0.01
    if (full) {
      this.removeTrade(t.id)
      this.recordExit(pnl, t.perfKey ?? t.strategy, t)
    } else {
      t.shares -= shares
      t.amount *= 1 - fraction
      delete t.exitUnknownAt
      this.recordExit(pnl, t.perfKey ?? t.strategy, t, shares)
    }
    console.log(`[auto-trader] recovered exit on ${t.marketId}: ${shares.toFixed(2)} sold @ ${avg.toFixed(3)} (order ${sell.orderId}), realized ${pnl.toFixed(2)}`)
    this.emit('autoexited', { marketId: t.marketId, outcome: t.outcome, reason: full ? 'recovered exit (lost response)' : `recovered exit (partial ${round2(shares)})`, pnlPct: 0, realized: round2(pnl) })
    return false
  }

  private async trySettle(t: AutoOpenTrade, result: AutoScanResult): Promise<void> {
    const adapter = this.engine.getAdapter(VENUE)
    if (!adapter) return
    const mode = this.engine.getExecutionMode()

    // Only an explicit yes/no counts as resolved — anything else (undefined,
    // scalar, disputed placeholder) means KEEP WAITING, never guess a side.
    const resolvedSide = (r: string | undefined): 'yes' | 'no' | null => (r === 'yes' || r === 'no' ? r : null)

    if (t.legs && t.legs.length > 0) {
      let realized = 0
      const sides: ('yes' | 'no')[] = []
      for (const leg of t.legs) {
        const mk = await adapter.getMarket(leg.marketId).catch(() => undefined)
        const side = resolvedSide(mk?.resolution)
        if (side === null) return // not all legs resolved yet (or fetch failed) — keep waiting
        sides.push(side)
      }
      for (let i = 0; i < t.legs.length; i++) {
        const leg = t.legs[i]
        const win = sides[i] === 'yes' ? 0 : 1 // NO leg pays 1 when the leg resolves NO
        if (mode === 'paper') {
          const rec = this.engine.settlePaperPosition(VENUE, leg.marketId, 'NO', win)
          if (rec?.realizedPnl !== undefined) realized += rec.realizedPnl
        } else {
          this.noteSettled(leg.marketId, leg.shares)
          // Live settles server-side; estimate P&L. The entry fee was real money (a leg without a recorded rate is
          // charged at the standard taker coefficient - dutch legs are IOC takers); until 2026-09-19 this omitted it
          // and a basket bought at 98c with 7.5c of fees was booked +2c (external review, Gemini Flash F-06).
          realized += (win - leg.entryPrice) * leg.shares - entryFeeDollars({ outcome: 'NO', entryPrice: leg.entryPrice, shares: leg.shares, feeRate: (leg as { feeRate?: number }).feeRate ?? t.feeRate ?? 0.07 })
        }
      }
      this.removeTrade(t.id)
      // Grade the basket like every other settlement: passing no trade left `netN` at 0 forever, so only the
      // hard stop could ever act on this arm, and 'dutch' ignored a detached basket's perfKey (audit B-36).
      this.recordExit(realized, t.perfKey ?? t.strategy, t)
      this.emit('autoexited', { marketId: t.marketId, outcome: 'NO', reason: 'settled (dutch)', realized: round2(realized) })
      return
    }

    // A trade whose exit response was lost is not settled at full size while the sell is unresolved (audit B-25).
    if (t.exitUnknownAt !== undefined && await this.reconcileUnknownExit(t, adapter)) return
    if (!this.state.openTrades.includes(t)) return
    const mk = await adapter.getMarket(t.marketId).catch(() => undefined)
    // Self-heal the cached close time: the venue is the authority and it can
    // move (earlier when play ends, later on a delay). Leaving ours stale is
    // what stalled settlement in the first place.
    if (mk?.closeTime && mk.closeTime !== t.closeTime) t.closeTime = mk.closeTime
    const side = resolvedSide(mk?.resolution)
    if (side !== null) {
      const yesWon = side === 'yes'
      const win = t.outcome === 'YES' ? (yesWon ? 1 : 0) : yesWon ? 0 : 1
      if (mode === 'paper') {
        const rec = this.engine.settlePaperPosition(VENUE, t.marketId, t.outcome, win)
        if (rec) {
          Object.assign(t, { graded: true })
          this.gradeEntry(t.perfKey ?? t.strategy, t.modeledWinProb, win === 1, netCentsOf(t, win), t.eventTicker ?? t.marketId, clusterDayOf(t.closeTime), t.shares)
          this.removeTrade(t.id)
          this.recordExit(rec.realizedPnl ?? 0, t.perfKey ?? t.strategy, t)
          this.emit('autoexited', { marketId: t.marketId, outcome: t.outcome, reason: 'settled', realized: round2(rec.realizedPnl ?? 0) })
        } else {
          // No paper position left (closed manually before settlement) — drop
          // the stale ledger entry instead of re-checking forever.
          this.removeTrade(t.id)
        }
      } else {
        // Settlement charges no fee, but the entry fee was real money.
        const realized = (win - t.entryPrice) * t.shares - entryFeeDollars(t)
        this.noteSettled(t.marketId, t.shares)
        Object.assign(t, { graded: true })
        this.gradeEntry(t.perfKey ?? t.strategy, t.modeledWinProb, win === 1, netCentsOf(t, win), t.eventTicker ?? t.marketId, clusterDayOf(t.closeTime), t.shares)
        this.removeTrade(t.id)
        this.recordExit(realized, t.perfKey ?? t.strategy, t)
        this.emit('autoexited', {
          marketId: t.marketId,
          outcome: t.outcome,
          reason: 'settled',
          realized: round2(realized)
        })
      }
      return
    }
    // Live fallback: position may be gone or the market vanished — drop after a long stall.
    if (mode === 'live' && t.closeTime && Date.now() - t.closeTime > 3 * 60 * 60_000) {
      // Time alone is not evidence the position is gone: Kalshi routinely
      // leaves markets closed-but-unsettled for 6-24h (natgas monthly sat
      // 24h). Deleting on the clock orphaned a REAL position from the
      // ledger. Ask the venue; unreachable means unknown, not gone.
      const held = await adapter.getPositions().catch(() => null)
      if (held === null) return
      if (held.some((p) => p.marketId === t.marketId)) return
      this.removeTrade(t.id)
      this.emit('autoexited', { marketId: t.marketId, outcome: t.outcome, reason: 'stale (removed)', realized: 0 })
      result.errors.push(`removed stale live trade ${t.marketId}`)
    }
  }

  // ---- helpers ----

  private makeSignal(
    m: VenueMarket,
    strategy: AutoStrategyId,
    outcome: 'YES' | 'NO',
    score: number,
    confidence: number,
    details: Record<string, number | string>
  ): AutoSignal {
    return {
      id: `${strategy}:${m.id}`,
      strategy,
      marketId: m.id,
      eventTicker: m.eventTicker,
      question: m.question,
      outcome,
      price: m.probability ?? 0,
      closeTime: m.closeTime,
      score,
      confidence: Math.min(1, Math.max(0, confidence)),
      feeRate: m.feeRate,
      makerFeeRate: m.makerFeeRate ?? 0,
      details: { ...details, spread: m.spread !== undefined ? round2(m.spread * 100) : 0 },
      executed: false
    }
  }

  /** Keep the WS universe in step with the scan and grade its books against REST. */
  private updateWs(tickers: string[], restBooks: OrderBook[]): void {
    if (!this.config.wsEnabled) {
      if (this.ws) {
        this.ws.stop()
        this.ws = undefined
      }
      return
    }
    const adapter = this.engine.getAdapter(VENUE)
    if (!(adapter instanceof KalshiAdapter)) return
    if (!this.ws) {
      const url = adapter.wsUrl()
      this.ws = new KalshiWsClient(url, () => adapter.wsHeaders(url), (t, m) => this.alert(t, m))
      this.ws.seedDay(this.state.wsStats?.day, this.state.wsStats?.dayLog)
    }
    this.ws.start(tickers.slice(0, 50))
    for (const b of restBooks) this.ws.compare(b.marketId, b)
    this.state.wsStats = { ...this.ws.stats }
  }

  /** Archive a top-of-book snapshot (throttled to one per market per 20s). */
  private recordBook(b: OrderBook): void {
    const now = Date.now()
    const last = this.lastBookRecordAt.get(b.marketId) ?? 0
    if (now - last < 20_000) return
    this.lastBookRecordAt.set(b.marketId, now)
    this.episodes?.record('kalshi', 'book', {
      marketId: b.marketId,
      bids: b.bids.slice(0, 3).map((l) => [l.price, l.size]),
      asks: b.asks.slice(0, 3).map((l) => [l.price, l.size])
    })
  }

  private removeTrade(id: string): void {
    const t = this.state.openTrades.find((x) => x.id === id)
    if (t) this.noteExit(t.marketId)
    this.state.openTrades = this.state.openTrades.filter((x) => x.id !== id)
  }

  /** Remember a live settlement this ledger booked (see PersistedState.settledMarkets); entries age out after three days. */
  private noteSettled(marketId: string, shares: number): void {
    const now = Date.now()
    const m = (this.state.settledMarkets ??= {})
    for (const [id, v] of Object.entries(m)) if (now - v.at > 3 * 24 * 60 * 60_000) delete m[id]
    m[marketId] = { at: now, shares }
  }

  private recentlySettled(marketId: string): boolean {
    return (this.state.settledMarkets?.[marketId]?.at ?? 0) > Date.now() - 3 * 24 * 60 * 60_000
  }

  /**
   * Grade a settled entry against its modeled win probability — the forward
   * calibration that tells us whether the EV gate's edge is real BEFORE the
   * P&L can (Brier + reliability buckets per strategy).
   */
  /**
   * Ledger-vs-venue reconcile. The venue's positions are the truth; the ledger
   * is a cache. On demo (2026-09-02) six taker 'fills' were recorded that the
   * venue never held, and they sat in the ledger blocking the per-event caps.
   * A trade older than 10 minutes that the venue does not report as held on
   * THREE consecutive checks, whose market is NOT resolved (so the settle probe
   * is not about to book it), is dropped with an 'orphan-ledger' episode.
   * A failed positions call counts for nothing (never wipe on an API glitch).
   */
  private async reconcileLedgerWithVenue(): Promise<void> {
    if (this.engine.getExecutionMode() !== 'live') return
    const adapter = this.engine.getAdapter(VENUE)
    if (!adapter?.getPositions || this.state.openTrades.length === 0) return
    let held: Set<string>
    try {
      held = new Set((await adapter.getPositions()).map((p) => p.marketId))
    } catch {
      return
    }
    const now = Date.now()
    const pending = new Set(this.state.pendingOrders.map((p) => p.marketId))
    for (const t of [...this.state.openTrades]) {
      // A dutch basket is keyed by its EVENT ticker while the venue reports MARKET tickers: it is held when any leg
      // is (audit 2026-09-19, B-06 - every live basket was being dropped 25 minutes after entry).
      const legHeld = t.legs?.some((l) => held.has(l.marketId) || pending.has(l.marketId)) ?? false
      if (held.has(t.marketId) || pending.has(t.marketId) || legHeld || now - t.createdAt < 10 * 60_000) { this.venueMiss.delete(t.id); continue }
      // Not held because a lost-response exit sold it: the exit path books it from the recovered order (B-25).
      if (t.exitUnknownAt !== undefined) continue
      const misses = (this.venueMiss.get(t.id) ?? 0) + 1
      this.venueMiss.set(t.id, misses)
      if (misses < 3) continue
      const mk = await adapter.getMarket(t.legs?.[0]?.marketId ?? t.marketId).catch(() => null)
      // A 429/5xx on this read is not evidence of an orphan: it used to make `mk` undefined and drop a
      // position that had actually settled, losing its grade and its P&L (audit B-54). The miss count keeps
      // climbing, so the next pass whose read SUCCEEDS decides - on evidence, not on an outage.
      if (mk === null) continue
      if (mk?.resolved || mk?.resolution !== undefined) continue   // settlement path will book it
      console.warn(`[auto-trader] ledger trade not held at venue on ${misses} checks, dropping: ${t.marketId} ${t.outcome} x${t.shares}`)
      this.episodes?.record('kalshi', 'orphan-ledger', { marketId: t.marketId, outcome: t.outcome, shares: t.shares, entryPrice: t.entryPrice, ageMin: Math.round((now - t.createdAt) / 60_000) })
      this.removeTrade(t.id)
      this.venueMiss.delete(t.id)
    }
    this.persist()
  }

  /** One quoter tick (see quoter.ts): quotes only in live mode, armed, kill switch clear. */
  /** Kill flag shared by every sub-engine: the local trip OR the venue-ledger trip. */
  /**
   * The operator's two halt switches, which used to stop only the AutoTrader's own signal path. `stopEntry`
   * was read in two places and `dryRun` in two, all inside executeSignal/entryBlocked/manageExits, while the
   * quoter, dutch, convergence and lead-lag engines ran on regardless - including lead-lag, the account's
   * dominant order flow and the only arm at max notch. A halt switch that does not halt is worse than none,
   * because it is believed.
   */
  private operatorHalted(): boolean {
    return this.config.stopEntry === true || this.config.dryRun === true
  }

  private subEngineKilled(): boolean {
    // The operator's halt switches FIRST. Before this they reached only the AutoTrader's own signal path,
    // so Stop entry and Dry run left the quoter, dutch, convergence and lead-lag engines trading.
    if (this.operatorHalted()) return true
    if (this.state.dailyPnl.date === nowDate() && this.state.dailyPnl.tripped) return true
    // Fail closed: with the venue ledger stale the daily-loss check is blind,
    // so new sub-engine entries hold until it refreshes. Exits and cancels
    // are unaffected.
    if (this.venueLedgerStale()) return true
    if (this.engine.getExecutionMode() === 'live' && this.lastEquity === undefined) return true
    this.rollDaily()
    return this.killSwitchCheck(this.lastEquity) !== null
  }

  private async runQuoter(): Promise<void> {
    const base = this.engine.getAdapter(VENUE)
    if (!base) return
    // Orders route through the engine (risk limits + shared trade history);
    // reads still hit the adapter directly.
    const adapter = this.engine.routedAdapter(VENUE, 'quoter')
    const paused = await this.exchangePausedNow(base)
    await this.quoter.tick(adapter, this.quoterCfg(), this.engine.getExecutionMode(), this.config.liveArmed, this.subEngineKilled(), paused)
    const st = this.quoter.status(this.quoterCfg())
    const g = st.gates ? ` gates r${st.gates.ratchet}/b${st.gates.blackout}/i${st.gates.noIndex}` : ''
    const sh = st.shadow ? ` shadow q${st.shadow.quotes} f${st.shadow.proxyFills} mo${st.shadow.markoutMeanCents.toFixed(2)}c(n${st.shadow.markoutN})` : ''
    console.log(`[quoter] ${st.note} | resting ${st.resting} placed ${st.placed} amended ${st.amended} canceled ${st.canceled} filled ${st.filled} ledgerFills ${st.ledgerFills ?? 0}${g}${sh}${st.lastError ? ' | error ' + st.lastError : ''}`)
  }

  
  private async runDutchBook(): Promise<void> {
    const base = this.engine.getAdapter(VENUE)
    if (!base) return
    const paused = await this.exchangePausedNow(base)
    await this.dutchEngine.scanAndExecute(
      this.engine.routedAdapter(VENUE, 'dutch'),
      this.dutchCfg(),
      this.engine.getExecutionMode(),
      this.config.liveArmed,
      this.subEngineKilled(),
      paused
    )
    const st = this.dutchEngine.status(this.dutchCfg())
    console.log('[dutch] ' + st.note + ' | opps ' + st.opportunitiesFound + ' executed ' + st.executedBaskets)
  }

  private async runConvergence(): Promise<void> {
    const base = this.engine.getAdapter(VENUE)
    if (!base) return
    const paused = await this.exchangePausedNow(base)
    await this.convergenceEngine.scanAndExecute(
      this.engine.routedAdapter(VENUE, 'convergence'),
      this.convergenceCfg(),
      this.engine.getExecutionMode(),
      this.config.liveArmed,
      this.subEngineKilled(),
      paused,
      (ticker) => this.holdsMarket(ticker) || this.leadLagEngine.heldTickers().has(ticker) || this.quoter.restingMarketIds().has(ticker)
    )
    const st = this.convergenceEngine.status(this.convergenceCfg())
    console.log('[convergence] ' + st.note + ' | graded ' + st.gradedTrades + ' (W:' + st.wins + ' L:' + st.losses + ') PnL: ' + st.realizedPnlCents + 'c')
  }

  private async runLeadLag(): Promise<void> {
    const base = this.engine.getAdapter(VENUE)
    if (!base) return
    const paused = await this.exchangePausedNow(base)
    this.leadLagPaused = paused
    // Refresh the position-cap count now, while the poll fetches quotes, so a sweep never waits on account reads.
    this.engine.warmOpenPositionCount(VENUE)
    // Event-speed lead-lag shadow (section 159): a second pushed Kalshi book for the 15-minute windows, which roll too
    // often for the shared client's drift guard. Records only; it cannot trade.
    if (!this.leadLagFastAttached && this.config.wsEnabled && this.config.leadLagFastShadow !== false) {
      const kAdapter = this.engine.getAdapter(VENUE)
      if (kAdapter instanceof KalshiAdapter) {
        const url = kAdapter.wsUrl()
        // The live gates are read at the moment of each fast order, never copied from the last minute scan: a kill or a
        // disarm must stop the next order, not the one after the next scan. Trading also needs leadLagFastLive (off).
        this.leadLagEngine.attachFastShadow(new KalshiWsClient(url, () => kAdapter.wsHeaders(url), (t, m) => console.warn(`[leadlag-fast] ${t}: ${m}`)), 2, {
          allowed: () => this.engine.getExecutionMode() === 'live' && this.config.liveArmed && !this.subEngineKilled() && !this.leadLagPaused,
          adapter: () => this.engine.routedAdapter(VENUE, 'leadlag'),
          cfg: () => this.leadLagCfg()
        })
        this.leadLagFastAttached = true
      }
    }
    await this.leadLagEngine.scanAndSweep(
      this.engine.routedAdapter(VENUE, 'leadlag'),
      this.leadLagCfg(),
      this.engine.getExecutionMode(),
      this.config.liveArmed,
      this.subEngineKilled(),
      paused
    )
    // One builder, not two. The duplicate literal that used to live here is exactly how the clamp drifted
    // out of step with the ladder: a knob raised in one copy stayed pinned in the other.
    const st = this.leadLagEngine.status(this.leadLagCfg())
    // At a 10 s poll a line per cycle is 8,640 a day, and a persistent dislocation would keep "found > 0"
    // true for every one of them: log when the found count CHANGES, else every 30th cycle.
    this.leadLagCycles++
    if (st.foundLast !== this.leadLagFoundLast || this.leadLagCycles % 30 === 0) console.log('[leadlag] ' + st.note + ' | dislocations ' + st.dislocationsLogged + ' sweeps ' + st.tradesExecuted)
    this.leadLagFoundLast = st.foundLast
  }

  private quoterCfg(): import('./quoter').QuoterConfig {
    const cfg = this.config as unknown as Partial<import('./quoter').QuoterConfig>
    return {
      quoterEnabled: cfg.quoterEnabled ?? false,
      quoterCategory: cfg.quoterCategory ?? 'Climate and Weather',
      quoterSeriesRegex: cfg.quoterSeriesRegex ?? '^KX(HIGH|LOW)',
      quoterMinSpreadCents: cfg.quoterMinSpreadCents ?? 3,
      quoterMaxSpreadCents: cfg.quoterMaxSpreadCents ?? 20,
      quoterMaxTouchDepth: cfg.quoterMaxTouchDepth ?? 50,
      quoterMaxContracts: cfg.quoterMaxContracts ?? 1,
      quoterMaxMarkets: cfg.quoterMaxMarkets ?? 4,
      quoterMaxExposure: cfg.quoterMaxExposure ?? 3,
      quoterMaxPositionExposure: cfg.quoterMaxPositionExposure ?? 25,
      quoterMaxInventory: cfg.quoterMaxInventory ?? 1,
      quoterCancelMinutes: cfg.quoterCancelMinutes ?? 60,
      quoterMinHoursToClose: cfg.quoterMinHoursToClose ?? 3,
      quoterMaxHoursToClose: cfg.quoterMaxHoursToClose ?? 48,
      amountPerTrade: this.config.amountPerTrade,
      quoterShadowEnabled: cfg.quoterShadowEnabled ?? true,
      quoterRatchetGate: cfg.quoterRatchetGate ?? true,
      quoterRequireIndex: cfg.quoterRequireIndex ?? true,
      quoterBlackoutEnabled: cfg.quoterBlackoutEnabled ?? true,
      quoterGuardF: cfg.quoterGuardF ?? 2,
      quoterNearF: cfg.quoterNearF ?? 1.5,
      quoterFairValueEnabled: cfg.quoterFairValueEnabled,
      quoterFairMarginCents: cfg.quoterFairMarginCents,
      quoterFlowGate: cfg.quoterFlowGate,
      quoterDecreaseEnabled: cfg.quoterDecreaseEnabled ?? false
    }
  }

  private dutchCfg(): import('./dutchBook').DutchBookConfig {
    return {
      dutchEnabled: this.config.dutchEnabled,
      // Recorder only: the in-pipeline dutch strategy executes under the ladder
      // and the shared risk limits; two engines firing on one basket doubled it.
      dutchLiveEnabled: false,
      dutchMinEdgeCents: Math.max(3, this.config.dutchMinOverSum * 100),
      dutchMaxLegs: this.config.dutchMaxLegs,
      dutchMaxBasketSpend: 1.0,
      dutchRequireExhaustive: true
    }
  }

  private convergenceCfg(): import('./cryptoConvergence').CryptoConvergenceConfig {
    return {
      convergenceEnabled: this.config.convergenceEnabled ?? true,
      convergenceLiveEnabled: this.config.convergenceLiveEnabled ?? false,
      convergenceSeries: ['KXBTCD'],
      // The PRE-REGISTERED rule (docs/PREREGISTERED-btc-convergence.md):
      // margin 0.10–0.60% of spot at T−5. The 0.20–0.40 "v2 live band" was
      // the best-looking slice of the same data — selection after the fact,
      // which the registration forbids — and its 98c cost cap bought
      // lottery-priced contracts that one loss wipes eight wins on. The
      // registered gate (200 events, corrected CI lower bound > +1c) decides
      // whether this ever goes live; until then it records in shadow.
      // Pre-filters only; the volatility model's net edge (>= 1c after the
      // taker fee) is the actual gate. The pre-registered 0.10-0.60% / 60-88c
      // bands almost never coincide at T-5 in normal volatility (2026-09-06:
      // 188 strikes in window, 180 margin-out, 8 cost-out, 0 setups for two
      // days), so the live test widens them; btc-gate.mjs keeps the original
      // bands as the re-entry gate.
      convergenceMinMarginPct: 0.05,
      convergenceMaxMarginPct: 1.0,
      convergenceMinEdgeCents: 1.0,
      convergenceMinCostCents: 55,
      convergenceMaxCostCents: 95,
      convergenceMaxContractsPerTrade: Math.max(1, Math.min(4, this.config.convergenceMaxContractsPerTrade ?? 1)),
      convergenceMaxOpenTrades: 1,
      convergenceMaxDailyTrades: this.config.convergenceMaxDailyTrades ?? 3,
      convergenceModeledWinProbability: this.config.convergenceModeledWinProbability ?? 0.97,
      convergenceTradeHorizonMinMinutes: 4.25,
      convergenceTradeHorizonMaxMinutes: 5.75
    }
  }

  /**
   * Absolute safety bounds on a lead-lag sweep. They sit WELL ABOVE what the ladder can ask for (MAX_NOTCH 4
   * x contractsPerNotch 2 = 8 contracts), so they guard a corrupted config without overriding the ladder,
   * whose entire job is sizing. The previous contract bound was 4 — exactly the ladder's output at max notch
   * — so every increase it made was silently discarded and 33 consecutive fills came out at 4 contracts.
   * A bound equal to the ladder's maximum is not a safety bound, it is a silent veto.
   */
  private static readonly LEADLAG_HARD_MAX_CONTRACTS = 24
  private static readonly LEADLAG_HARD_MAX_SPEND = 120

  private leadLagCfg(): import('./leadLag').LeadLagConfig {
    return {
      leadLagEnabled: true,
      leadLagLiveEnabled: this.config.leadLagLiveEnabled ?? false,
      // Gap floor (§115): the 4-6c bucket was flat or negative in every era and carried most of the volume. Clamped so
      // a typo cannot open the arm to 1c noise or close it entirely.
      leadLagMinDislocationCents: Math.max(2, Math.min(20, this.config.leadLagMinDislocationCents ?? 4)),
      leadLagMaxSpreadCents: this.config.leadLagMaxSpreadCents ?? 5.0,
      leadLagMaxContractsPerOrder: Math.max(1, Math.min(AutoTrader.LEADLAG_HARD_MAX_CONTRACTS, this.config.leadLagMaxContractsPerOrder ?? 1)),
      leadLagMaxCapitalSpend: Math.max(1, Math.min(AutoTrader.LEADLAG_HARD_MAX_SPEND, this.config.leadLagMaxCapitalSpend ?? 15)),
      // Window caps (round 91b): three full sweeps per ticker per window by default, so they track the ladder's
      // per-order size, and $60 of filled spend across all tickers per window. Hard-bounded like the per-sweep caps.
      leadLagMaxContractsPerWindow: Math.max(1, Math.min(AutoTrader.LEADLAG_HARD_MAX_CONTRACTS * 3, this.config.leadLagMaxContractsPerWindow ?? 3 * Math.max(1, this.config.leadLagMaxContractsPerOrder ?? 1))),
      // $15 a window is ~10% of the 2026-09-13 equity ($142.57). $60 admitted 104 contracts on six coins in
      // one window and lost $20.94; $40 would still have let one wrong window take most of the 20% daily kill.
      leadLagMaxSpendPerWindow: Math.max(1, Math.min(AutoTrader.LEADLAG_HARD_MAX_SPEND, this.config.leadLagMaxSpendPerWindow ?? 15)),
      leadLagProvenCoins: this.config.leadLagProvenCoins ?? LEADLAG_PROVEN_DEFAULT,
      leadLagCoins: this.config.leadLagCoins ?? LEADLAG_COINS,
      leadLagNewCoinContracts: Math.max(1, Math.min(4, this.config.leadLagNewCoinContracts ?? 2)),
      leadLagMaxCoinsPerDirectionPerWindow: Math.max(1, Math.min(7, this.config.leadLagMaxCoinsPerDirectionPerWindow ?? 2)),
      pollIntervalMs: Math.max(5_000, this.config.leadLagPollIntervalMs ?? 10_000),
      leadLagFastLive: this.config.leadLagFastLive ?? false
    }
  }

  getQuantStatus(): import('../../shared/ipc').QuantStatus {
    return {
      dutch: this.dutchEngine.status(this.dutchCfg()),
      convergence: this.convergenceEngine.status(this.convergenceCfg()),
      leadLag: this.leadLagEngine.status(this.leadLagCfg()),
      quoter: this.quoter.status(this.quoterCfg())
    }
  }

  /** One hunch pass (see hunch.ts). Guarded so overlapping timers cannot double-run. */
  private async runHunches(): Promise<void> {
    if (this.hunchRunning) return
    this.hunchRunning = true
    try {
      const dir = join(app.getPath('userData'), 'hunches')
      const r = await runHunchPass(
        {
          llmBaseUrl: this.config.llmBaseUrl,
          llmApiKey: this.config.llmApiKey,
          llmModel: this.config.llmModel,
          llmThinking: this.config.llmThinking,
          // Passed explicitly rather than left to the callee's defaults: a hand-built config literal that
          // omits the operator's switches is how `reviewDefault()` ended up ignoring every intelligence
          // setting (BACKLOG 53). If it is a knob, it travels.
          hunchChallengerEnabled: this.config.hunchChallengerEnabled,
          hunchChallengerModel: this.config.hunchChallengerModel,
          hunchChallengerMaxPerDay: this.config.hunchChallengerMaxPerDay
        },
        dir,
        (line) => console.log(line)
      )
      console.log('[auto-trader] hunch pass done: ' + r.hunched + ' hunched of ' + r.eligible + ' eligible, ' + r.errors + ' errors')
    } catch (e) {
      console.warn('[auto-trader] hunch pass failed:', e instanceof Error ? e.message : String(e))
    } finally {
      this.hunchRunning = false
    }
  }

  private gradeEntry(strategy: string, prob: number | undefined, won: boolean, netCents?: number, clusterEvent?: string, clusterDay?: string, contracts?: number): void {
    const s = (this.state.calib.byStrategy[strategy] ??= {
      n: 0,
      brierSum: 0,
      buckets: CALIB_EDGES.slice(0, -1).map(() => ({ n: 0, wins: 0, probSum: 0 }))
    })
    // Net cents per contract after fees, with per-event and per-day sums so
    // the status can show a CLUSTERED interval. Hit rate alone is the trap
    // that made a 34-0 favorite streak look like skill; this is the number
    // that would have flagged it. Accumulated regardless of whether a
    // modeled probability exists.
    if (netCents !== undefined && Number.isFinite(netCents)) {
      s.netN = (s.netN ?? 0) + 1
      s.netSum = (s.netSum ?? 0) + netCents
      s.netSq = (s.netSq ?? 0) + netCents * netCents
      const ev = ((s.byEvent ??= {})[clusterEvent ?? 'unknown'] ??= { n: 0, sum: 0 })
      ev.n++; ev.sum += netCents
      const dy = ((s.byDay ??= {})[clusterDay ?? 'unknown'] ??= { n: 0, sum: 0 })
      dy.n++; dy.sum += netCents
      // Contract-weighted, the estimand the doctrine and both labs use: a 5-contract loser and a 1.25-contract
      // winner are not one observation each (audit 2026-09-19, B-21), and a partial close weighs its slice.
      if (contracts !== undefined && contracts > 0) {
        s.wN = (s.wN ?? 0) + contracts
        s.wSum = (s.wSum ?? 0) + netCents * contracts
        s.wSq = (s.wSq ?? 0) + netCents * netCents * contracts
        s.wTrades = (s.wTrades ?? 0) + 1
        dy.w = (dy.w ?? 0) + contracts
        dy.wsum = (dy.wsum ?? 0) + netCents * contracts
      }
    }
    if (prob === undefined || !Number.isFinite(prob) || prob <= 0 || prob > 1) return
    s.n++
    s.brierSum += (prob - (won ? 1 : 0)) ** 2
    let idx = CALIB_EDGES.length - 2
    for (let i = 0; i < CALIB_EDGES.length - 1; i++) {
      if (prob >= CALIB_EDGES[i] && prob < CALIB_EDGES[i + 1]) {
        idx = i
        break
      }
    }
    const b = s.buckets[idx]
    b.n++
    b.probSum += prob
    if (won) b.wins++
  }

  /**
   * Counterfactual veto grading: watch LLM-vetoed candidates to resolution
   * and record whether the vetoed trade would have won. At 1.5–6¢ edges,
   * false vetoes are the gate's dominant failure mode — this is the only
   * mechanism that prices them.
   */
  private async gradeVetoes(): Promise<void> {
    const watch = this.state.calib.vetoWatch
    if (watch.length === 0) return
    const adapter = this.engine.getAdapter(VENUE)
    if (!adapter) return
    const now = Date.now()
    const due = watch.filter((w) => w.closeTime !== undefined && now > w.closeTime + SETTLE_GRACE_MS).slice(0, 5)
    for (const w of due) {
      const mk = await adapter.getMarket(w.marketId).catch(() => undefined)
      const res = mk?.resolution
      if (res === 'yes' || res === 'no') {
        const wouldWin = w.outcome === 'NO' ? res === 'no' : res === 'yes'
        const pnlCents = (wouldWin ? 1 - w.legCost : -w.legCost) * 100
        const v = this.state.calib.vetoes
        v.graded++
        if (wouldWin) v.wouldHaveWon++
        v.estPnlCents += pnlCents
        // Per-reason slice: 'category:*' rows price the category filter's
        // counterfactual separately from the LLM gate's.
        const key = w.reason ?? 'llm'
        this.state.calib.vetoesByReason = this.state.calib.vetoesByReason ?? {}
        const r = (this.state.calib.vetoesByReason[key] = this.state.calib.vetoesByReason[key] ?? { graded: 0, wouldHaveWon: 0, estPnlCents: 0 })
        r.graded++
        if (wouldWin) r.wouldHaveWon++
        r.estPnlCents += pnlCents
        this.state.calib.vetoWatch = this.state.calib.vetoWatch.filter((x) => x !== w)
      } else if (w.closeTime !== undefined && now > w.closeTime + 6 * 3600_000) {
        // Unresolvable (voided/scalar/vanished) — drop without grading.
        this.state.calib.vetoWatch = this.state.calib.vetoWatch.filter((x) => x !== w)
      }
    }
  }

  /** Distinct unclassified block reasons already logged, so drift is reported once rather than every scan. */
  private unclassifiedBlocks = new Set<string>()
  /** Capacity vetoes that could not enrol for want of a book, by strategy - silent non-enrolment made visible. */
  private capacityNoBook = new Map<string, number>()

  /**
   * Enroll a capacity-blocked signal in the counterfactual watch, so `gradeVetoes` can price what the cap
   * cost us. Records only; the veto still vetoes.
   */
  private watchCapacityVeto(sig: AutoSignal, data: ScanData, reason: string): void {
    const key = capacityKey(reason)
    if (key === undefined) {
      // An unrecognised reason is the failure mode this round exists to fix: it would go ungraded in
      // silence. Log it once so a future edit to a block message gets triaged.
      if (!KNOWN_UNGRADED_BLOCK.test(reason) && this.unclassifiedBlocks.size < 40) {
        const norm = reason.replace(/\([^)]*\)/g, '()').replace(/\d+/g, 'N').slice(0, 80)
        if (!this.unclassifiedBlocks.has(norm)) {
          this.unclassifiedBlocks.add(norm)
          console.log(`[auto-trader] block reason not classified for veto grading: ${norm}`)
        }
      }
      return
    }
    // `passesGates` runs BEFORE the score check (see the approval loop), so a signal blocked here may have
    // been destined for a score veto anyway. Enrolling those would price the cap AND the score gate
    // together and overstate what the cap costs - the exact trap that made the long-horizon cap look
    // expensive when 34 of 35 of its "blocked" signals were below minScore.
    if (sig.score < this.config.minScore) return
    // A dutch basket is several legs under a synthetic id; there is no single book to price it from, so
    // it is excluded EXPLICITLY rather than by the lookup below failing in silence.
    if (sig.strategy === 'dutch') return
    // No two-sided book means there was no entry to counterfactual and the cost would be fiction. But a
    // missing book is also how a whole strategy's capacity vetoes could vanish from the ledger unseen, so
    // every skip is counted by strategy and reported once.
    const book = data.books.get(sig.marketId)
    const yesBid = book?.bids[0]?.price
    const yesAsk = book?.asks[0]?.price
    if (yesBid === undefined || yesAsk === undefined) {
      const n = (this.capacityNoBook.get(sig.strategy) ?? 0) + 1
      this.capacityNoBook.set(sig.strategy, n)
      if (n === 1 || n % 100 === 0) console.log(`[auto-trader] capacity veto on ${sig.strategy} not enrolled: no book for ${sig.marketId} (${n} so far for this strategy)`)
      return
    }
    const legCost = sig.outcome === 'NO' ? 1 - yesBid : yesAsk
    if (!(legCost > 0 && legCost < 1)) return
    this.watchVeto(sig.marketId, sig.strategy, sig.outcome, legCost, sig.closeTime, `capacity:${key}`)
  }

  /** `entryBlocked`, plus the counterfactual enrolment. Every caller should use this. */
  private entryBlockedWatched(sig: AutoSignal, data: ScanData): string | null {
    const reason = this.entryBlocked(sig, data)
    if (reason) this.watchCapacityVeto(sig, data, reason)
    return reason
  }

  /**
   * Enroll a blocked entry in the counterfactual watch (deduped, capped).
   *
   * The two classes get SEPARATE ceilings rather than sharing one. A single global cap made the capacity
   * reserve unreachable: the fade category filter runs every scan and had the list pinned at its full 120
   * (95 of them `weather<48h`), so a capacity row could never be enrolled at all — the round-81 wiring would
   * have recorded nothing and looked like "the caps never block anything worth trading". Budgets that
   * different producers draw from at wildly different rates have to be separate budgets.
   */
  private watchVeto(marketId: string, strategy: string, outcome: 'YES' | 'NO', legCost: number, closeTime: number | undefined, reason: string): void {
    const isCapacity = reason.startsWith('capacity:')
    const held = this.state.calib.vetoWatch.filter((w) => (w.reason?.startsWith('capacity:') ?? false) === isCapacity).length
    if (held >= (isCapacity ? CAPACITY_WATCH_MAX : LEGACY_WATCH_MAX)) return
    if (this.state.calib.vetoWatch.some((w) => w.marketId === marketId)) return
    this.state.calib.vetoWatch.push({ marketId, strategy, outcome, legCost, closeTime, ts: Date.now(), reason })
  }

  /** Push-alert helper — no-op unless a webhook is configured. */
  private alert(title: string, message: string): void {
    if (this.config.alertWebhookUrl) void sendAlert(this.config.alertWebhookUrl, title, message)
  }

  /**
   * Read-only Polymarket .com prior for the vet snapshot: the global CLOB's
   * books are the deepest in prediction markets and legal to READ from the
   * US (trading remains geo-blocked — this never trades there). A liquid
   * venue pricing our longshot materially higher is exactly the
   * stale-cheap-longshot trap the vet exists to catch.
   */

  /**
   * @param gradedShares Shares this exit actually realised, when it is a PARTIAL close. `closeTrade`
   * shrinks `trade.shares` to the unsold remainder before calling here, so grading against the trade would
   * divide the sold slice's P&L by the shares that were kept - eightfold inflation on an 88% fill, and the
   * source of two arithmetically impossible samples (-204.83c and -127.67c per contract on a binary) that
   * helped stop book-imbalance. A partial also leaves the trade UNGRADED, so its remainder still counts
   * when it settles.
   */
  private recordExit(pnl: number | undefined, strategy = 'unknown', trade?: AutoOpenTrade, gradedShares?: number): void {
    if (pnl === undefined || !Number.isFinite(pnl)) return
    const p = this.state.perf
    p.trades++
    p.realizedPnl += pnl
    if (pnl > 0) p.wins++
    else if (pnl < 0) p.losses++
    const s = (this.state.perfByStrategy[strategy] ??= { trades: 0, wins: 0, losses: 0, realizedPnl: 0 })
    s.trades++
    s.realizedPnl += pnl
    if (pnl > 0) s.wins++
    else if (pnl < 0) s.losses++
    if (trade) {
      // CLV: side mid at the last pre-exit observation vs at entry. Positive
      // = we beat the close — converges to a skill read in days, where
      // settlement P&L at this stake needs months.
      // The sums alone give a mean and never a band, which is why the CLV read
      // has only ever been a judgement call. Settlement net cents disperse at
      // 31.8c per trade on fade and 51.3c on mean reversion, so the 20-trade
      // checkpoint needs 92-257 trades to see a +4c edge; a price-move
      // statistic disperses far less and gets there in a fraction of that.
      if (trade.entrySideMid !== undefined && trade.lastSideMid !== undefined) {
        const clv = (trade.lastSideMid - trade.entrySideMid) * 100
        s.clvSum = (s.clvSum ?? 0) + clv
        s.clvN = (s.clvN ?? 0) + 1
        s.clvSq = (s.clvSq ?? 0) + clv * clv
        // Counted separately from clvN because clvSq started accumulating later: on an arm with older
        // history the two disagree, and a variance taken from the triple is silently too small.
        s.clvSqN = (s.clvSqN ?? 0) + 1
      }
      if (trade.markout5mCents !== undefined) {
        s.markoutSum = (s.markoutSum ?? 0) + trade.markout5mCents
        s.markoutN = (s.markoutN ?? 0) + 1
        s.markoutSq = (s.markoutSq ?? 0) + trade.markout5mCents * trade.markout5mCents
        s.markoutSqN = (s.markoutSqN ?? 0) + 1
        // Per-day sums: the markout veto's band is still unclustered (external review GLM 5.3, F-08; BACKLOG 183).
        const md = ((s.markoutByDay ??= {})[nowDate()] ??= { n: 0, sum: 0 })
        md.n++
        md.sum += trade.markout5mCents
      } else {
        // Counted, because the trades that miss a markout are not a random sample of the arm's trades -
        // they are the ones that closed inside five minutes, and those are measurably the losers.
        s.markoutMissingN = (s.markoutMissingN ?? 0) + 1
      }
      this.episodes?.record('kalshi', 'exit', {
        marketId: trade.marketId,
        outcome: trade.outcome,
        strategy,
        pnl: round2(pnl),
        entryPrice: trade.entryPrice,
        entrySideMid: trade.entrySideMid,
        lastSideMid: trade.lastSideMid,
        minSideMid: trade.minSideMid,
        maxSideMid: trade.maxSideMid,
        markout5mCents: trade.markout5mCents,
        hourOfWeek: trade.hourOfWeek,
        heldMin: Math.round((Date.now() - trade.createdAt) / 60_000)
      })
    }
    if (this.state.dailyPnl.date !== nowDate()) this.state.dailyPnl = { date: nowDate(), realized: 0, tripped: false }
    this.state.dailyPnl.realized += pnl
    this.persist()
    // Sale exits (take-profit, pull, pre-close) skipped net-cents grading; only
    // settlements were graded, so the panel's net cents ignored every sold trade.
    const gradeOver = gradedShares !== undefined && gradedShares > 0 ? gradedShares : trade?.shares
    if (trade && !(trade as { graded?: boolean }).graded && pnl !== undefined && Number.isFinite(pnl) && gradeOver !== undefined && gradeOver > 0) {
      // Only a FULL close marks the trade graded; a partial must leave the remainder gradeable.
      if (gradedShares === undefined) Object.assign(trade, { graded: true })
      // Clustered on the day the market closed, not the day we booked it: a settlement booked late (or a sweep of a
      // backlog) put one day's outcomes on another day's clock (backlog 209).
      this.gradeEntry(strategy, trade.modeledWinProb, pnl > 0, (pnl / gradeOver) * 100, trade.eventTicker ?? trade.marketId, clusterDayOf(trade.closeTime && trade.closeTime <= Date.now() ? trade.closeTime : Date.now()), gradeOver)
    }
  }

  private rollDaily(): void {
    if (this.state.daily.date !== nowDate()) this.state.daily = { date: nowDate(), count: 0 }
    if (this.state.dailyPnl.date !== nowDate()) {
      // Yesterday's summary goes out before the counters roll.
      if (this.state.dailyPnl.realized !== 0 || this.state.dailyPnl.tripped) {
        this.alert(
          'Oracle Trader — daily summary',
          `${this.state.dailyPnl.date}: realized ${this.state.dailyPnl.realized >= 0 ? '+' : ''}${this.state.dailyPnl.realized.toFixed(2)}` +
            (this.state.dailyPnl.tripped ? ' · kill-switch tripped' : '') +
            ` · lifetime ${this.state.perf.realizedPnl >= 0 ? '+' : ''}${this.state.perf.realizedPnl.toFixed(2)} over ${this.state.perf.trades} closed`
        )
      }
      this.state.dailyPnl = { date: nowDate(), realized: 0, tripped: false }
    }
  }

  /**
   * Drawdown kill-switch: once today's realized loss reaches the configured
   * % of balance, refuse new entries (exits keep managing) for the rest of the
   * venue day. The LIVE arm stays: entries resume with the next venue day
   * (operator directive 2026-09-06: nothing waits on a human).
   */
  private killSwitchCheck(balance: number | undefined): string | null {
    const cfg = this.config
    if (cfg.maxDailyLossPct <= 0) return null
    const d = this.state.dailyPnl
    if (d.date !== nowDate()) return null
    if (d.tripped) return 'kill-switch: daily loss limit hit — new entries halted'
    if (balance === undefined) return null
    const limit = (cfg.maxDailyLossPct / 100) * Math.max(balance, 1)
    // In live mode the venue's settlements are the ledger of record: they
    // include the quoter, convergence, lead-lag and Dutch engines, which never
    // touch dailyPnl. Whichever ledger is worse governs.
    const { realized, source } = this.dayRealizedForKill()
    // Open positions count too (operator decision 2026-09-19, backlog 159): nearly every arm holds to settlement,
    // so a break held in unsettled positions was invisible here until it settled, days later. Only a LOSS counts -
    // a paper gain is not banked and may not offset a realized loss.
    const open = Math.min(0, this.openDayMtm())
    const day = realized + open
    if (day <= -limit) {
      d.tripped = true
      const disarmed = false
      this.emit('killswitch', { realized: round2(realized), open: round2(open), limit: round2(-limit), disarmed, source })
      this.alert(
        'Oracle Trader — KILL SWITCH',
        `Daily loss ${day.toFixed(2)} (${realized.toFixed(2)} realized on the ${source} ledger, ${open.toFixed(2)} on open positions today) hit the ${cfg.maxDailyLossPct}% limit. New entries halted for the rest of the venue day; they resume automatically tomorrow.`
      )
      this.persist()
      return `kill-switch TRIPPED (${source} day ${realized.toFixed(2)} + open ${open.toFixed(2)} ≤ -${limit.toFixed(2)})`
    }
    return null
  }

  /**
   * True in live mode when the venue settlement ledger has not been refreshed
   * within 45 minutes (nine consecutive failed 5-minute refreshes) — the
   * daily-loss check is then blind, so entries fail closed until it recovers.
   */
  private venueLedgerStale(): boolean {
    if (this.engine.getExecutionMode() !== 'live') return false
    const v = this.state.venueDay
    return !v || Date.now() - v.fetchedAt > 45 * 60_000
  }

  /** Today's realized loss for the kill switch: the worse of the venue ledger (live) and the local exits ledger. */
  /** Give a trade its day-start reference once per UTC day, BEFORE the new quote overwrites the last one. */
  private stampDayMark(t: AutoOpenTrade): void {
    const today = nowDate()
    if (t.dayMark?.date === today) return
    const openedToday = new Date(t.createdAt).toISOString().slice(0, 10) === today
    // Mid to mid: a trade opened today starts at its entry MID, so the spread paid at entry is not a "loss".
    t.dayMark = { date: today, mid: openedToday ? (t.entrySideMid ?? t.entryPrice) : (t.lastSideMid ?? t.entrySideMid ?? t.entryPrice) }
  }

  /**
   * Today's change in value of the open positions, dollars: shares x (latest side mid - the day-start mark). Only
   * quotes under ten minutes old count (a stale mark is unknown, not a loss); baskets carry no single quote and
   * sub-engine positions settle within the hour, so neither is here.
   */
  private openDayMtm(now = Date.now()): number {
    const today = nowDate()
    let sum = 0
    for (const t of this.state.openTrades ?? []) {
      if (t.dayMark?.date !== today || t.lastSideMid === undefined || t.lastSideMidAt === undefined) continue
      if (now - t.lastSideMidAt > 10 * 60_000) continue
      sum += t.shares * (t.lastSideMid - t.dayMark.mid)
    }
    return sum
  }

  private dayRealizedForKill(): { realized: number; source: 'venue' | 'local' } {
    const reset = this.state.killReset?.date === nowDate() ? this.state.killReset : undefined
    const local = (this.state.dailyPnl.date === nowDate() ? this.state.dailyPnl.realized : 0) - (reset?.local ?? 0)
    const v = this.state.venueDay
    const venue = (v?.realized ?? 0) - (reset?.venue ?? 0)
    if (this.engine.getExecutionMode() === 'live' && v && v.date === nowDate() && venue < local) {
      return { realized: venue, source: 'venue' }
    }
    return { realized: local, source: 'local' }
  }

  /**
   * Refresh today's realized P&L from the venue's settlement feed (live only).
   * Runs on the 5-minute reconcile timer and at most once per scan.
   */
  private async refreshVenueDay(): Promise<void> {
    if (this.engine.getExecutionMode() !== 'live') return
    const adapter = this.engine.getAdapter(VENUE)
    if (!adapter?.getSettlements) return
    const now = Date.now()
    if (this.state.venueDay && now - this.state.venueDay.fetchedAt < 4 * 60_000) return
    try {
      const rows = await adapter.getSettlements(1000)
      const dayStart = Date.parse(nowDate() + 'T00:00:00Z')
      // Positions entered before killEpochTs (the strategy redesign) settle
      // into today's ledger but were not placed by today's strategies; the
      // daily kill exists to stop a malfunctioning live strategy, so their
      // result is tracked separately and left out of the trigger.
      const epoch = this.config.killEpochTs ?? 0
      const firstFill = new Map<string, number>()
      if (epoch > 0) {
        // `getHistory()` defaults to the newest 100 rows - under 13 h of fills - so every older position's
        // settlement missed its first fill and was booked as current instead of legacy (audit B-41).
        for (const h of this.engine.getHistory(100_000, VENUE)) {
          if (!h.timestamp) continue // any fill (maker sells included) marks when the position was first entered
          const prev = firstFill.get(h.marketId)
          if (prev === undefined || h.timestamp < prev) firstFill.set(h.marketId, h.timestamp)
        }
      }
      let realized = 0
      let legacy = 0
      let n = 0
      for (const s of rows) {
        if (s.timestamp >= dayStart) {
          const ff = firstFill.get(s.marketId)
          if (epoch > 0 && ff !== undefined && ff < epoch) legacy += s.realizedPnl
          else realized += s.realizedPnl
          n++
        }
      }
      this.state.venueDay = { date: nowDate(), realized: round2(realized), legacyRealized: round2(legacy), settlements: n, fetchedAt: now }
    } catch (err) {
      console.warn('[auto-trader] venue day P&L refresh failed:', fmtErr(err))
    }
  }

  /** Exchange trading status for the sub-engines, refreshed at most every 90s. */
  private async exchangePausedNow(adapter: import('../../shared/venue').VenueAdapter): Promise<boolean> {
    const now = Date.now()
    if (now - this.exchangeCheckedAt < 90_000) return this.exchangePaused
    this.exchangeCheckedAt = now
    if (adapter.getExchangeStatus) {
      const st = await adapter.getExchangeStatus().catch(() => ({ tradingActive: true }))
      this.exchangePaused = st.tradingActive === false
    }
    return this.exchangePaused
  }

  /** Log the venue's liquidity/maker incentive programs once per session (read-only discovery). */
  private async logIncentivePrograms(): Promise<void> {
    if (this.incentivesLogged) return
    this.incentivesLogged = true
    const adapter = this.engine.getAdapter(VENUE)
    if (!(adapter instanceof KalshiAdapter)) return
    try {
      const rows = await adapter.getIncentivePrograms()
      if (rows.length === 0) {
        console.log('[auto-trader] incentive programs: none returned (endpoint may need a higher tier or none are active)')
        return
      }
      console.log(`[auto-trader] incentive programs: ${rows.length} returned; sample ${JSON.stringify(rows[0]).slice(0, 400)}`)
      this.episodes?.record('kalshi', 'anchor', { kind2: 'incentive-programs', count: rows.length, sample: rows.slice(0, 5) })
    } catch (err) {
      console.warn('[auto-trader] incentive programs fetch failed:', fmtErr(err))
    }
  }

  private persist(configVersion?: number): void {
    // The LLM key is encrypted at rest (the venue keys already are, via
    // ConfigStore); runtime config keeps the plaintext.
    const config = {
      ...this.config,
      llmApiKey: encryptValue(this.config.llmApiKey),
      oddsApiKey: encryptValue(this.config.oddsApiKey),
      metaculusApiKey: encryptValue(this.config.metaculusApiKey ?? '')
    }
    if (configVersion !== undefined) this.store.update({ config, state: this.state, configVersion })
    else this.store.update({ config, state: this.state })
  }

  private restartTimer(): void {
    this.stop()
    if (this.config.enabled && this.config.autoPoll) {
      // Hunch collector: first pass 90s after start, then every 8 hours. Independent of the scan loop.
      if (!this.reconcileTimer) {
        this.reconcileTimer = setInterval(() => {
          void this.reconcileLedgerWithVenue()
          void this.refreshVenueDay()
          // An arm refused for an unfunded shard waits at most one reconcile, not the ladder's hour: on
          // 2026-09-21 every live arm was blocked for hours while the account held $63.55 (section 148).
          const now = Date.now()
          if (this.levelShards && now - this.shardStarvedAt < 10 * 60_000 && now - this.shardLevelledAt > 15 * 60_000) {
            this.shardLevelledAt = now
            void this.levelShards().catch((e) => console.warn('[auto-trader] shard levelling failed:', e instanceof Error ? e.message : e))
          }
        }, 5 * 60_000)
        setTimeout(() => void this.refreshVenueDay(), 25_000)
        setTimeout(() => void this.logIncentivePrograms(), 60_000)
      }
      if (!this.quoterTimer) { setTimeout(() => void this.runQuoter(), 20_000); this.quoterTimer = setInterval(() => void this.runQuoter(), 60_000) }
      if (!this.dutchTimer) { setTimeout(() => void this.runDutchBook(), 35_000); this.dutchTimer = setInterval(() => void this.runDutchBook(), 60_000) }
      if (!this.convergenceTimer) { setTimeout(() => void this.runConvergence(), 15_000); this.convergenceTimer = setInterval(() => void this.runConvergence(), 30_000) }
      // The interval comes from the config (default 10 s, floor 5 s). It was a hardcoded 60 s while the
      // configured 15 s and the type's 5 s default were read by nothing: 68% of IOCs filled nothing.
      if (!this.leadLagTimer) { setTimeout(() => void this.runLeadLag(), 30_000); this.leadLagTimer = setInterval(() => void this.runLeadLag(), this.leadLagCfg().pollIntervalMs) }
      if (!this.hunchTimer) {
        setTimeout(() => void this.runHunches(), 90_000)
        this.hunchTimer = setInterval(() => void this.runHunches(), 8 * 3600_000)
      }
      this.timer = setInterval(() => {
        this.tick().catch((err) => console.warn('[autoTrader] tick error:', err))
      }, Math.max(10, this.config.pollIntervalSeconds) * 1000)
    }
    if (this.config.bookLogging) {
      this.bookTimer = setInterval(() => {
        this.bookCycle().catch((err) => console.warn('[autoTrader] book logger:', err))
      }, 60_000)
      this.bookCycle().catch((err) => console.warn('[autoTrader] book logger (first cycle):', err))
    }
  }

  /**
   * Book-signal lab (read-only, never trades): snapshot the top-of-book
   * imbalance every minute for the current universe and resolve each entry's
   * 5-minute forward move. Feeds the forward validation of the imbalance
   * signal — Kalshi archives no historical order books.
   */
  private async bookCycle(): Promise<void> {
    const adapter = this.engine.getAdapter(VENUE)
    if (!adapter) return
    const now = Date.now()
    // Scan-loop watchdog: if auto-poll is on but no scan has completed for
    // 5 intervals, the loop is wedged or the API is dead — alert (1/hour).
    if (this.config.enabled && this.config.autoPoll && this.config.alertWebhookUrl && this.state.lastScanAt) {
      const staleMs = Math.max(5 * this.config.pollIntervalSeconds * 1000, 5 * 60_000)
      if (now - this.state.lastScanAt > staleMs && now - this.lastWatchdogAlert > 3600_000) {
        this.lastWatchdogAlert = now
        this.alert('Oracle Trader — scan loop stalled', `No completed scan for ${Math.round((now - this.state.lastScanAt) / 60_000)} min while auto-poll is enabled.`)
      }
    }
    if (now - this.bookUniverseAt > 10 * 60_000) {
      const r: AutoScanResult = { scanned: 0, candidates: 0, approved: 0, executed: 0, errors: [] }
      this.bookUniverse = await this.buildUniverse(r).catch(() => [])
      this.bookUniverseAt = now
    }
    // Held and resting markets are archived every minute too, whether or not they are still in the scan
    // universe: a stop-loss / take-profit read needs the executable bid along each trade's whole life, and on
    // 2026-09-19 only 3 of 61 settled consensus trades had one (their markets never enter this universe).
    const held = [...this.state.openTrades.flatMap((t) => (t.legs?.length ? t.legs.map((l) => l.marketId) : [t.marketId])), ...this.state.pendingOrders.map((p) => p.marketId)]
    const tickers = [...new Set([...this.bookUniverse.map((m) => m.id), ...held])]
    if (tickers.length === 0) return

    if (adapter.getOrderBooks) {
      const books = await adapter.getOrderBooks(tickers).catch(() => [])
      const byId = new Map(this.bookUniverse.map((m) => [m.id, m]))
      for (const b of books) this.recordBook(b)
      for (const b of books) {
        const bidDepth = b.bids.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
        const askDepth = b.asks.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
        const total = bidDepth + askDepth
        if (total < this.config.bookMinDepth) continue
        if (Math.min(bidDepth, askDepth) < this.config.bookMinSideDepth) continue
        const ratio = bidDepth / askDepth
        let dir: 'YES' | 'NO' | null = null
        if (ratio >= this.config.bookMinRatio) dir = 'YES'
        else if (ratio <= 1 / this.config.bookMinRatio) dir = 'NO'
        if (!dir) continue
        if (!byId.has(b.marketId)) continue
        // Baseline = the mid of the book we JUST fetched. The old baseline
        // came from a universe snapshot up to 10 minutes stale, folding
        // pre-signal drift into the measured "forward move".
        const bestBid = b.bids[0]?.price
        const bestAsk = b.asks[0]?.price
        if (bestBid === undefined || bestAsk === undefined) continue
        this.pendingBooks.push({ ts: now, ticker: b.marketId, lastPrice: (bestBid + bestAsk) / 2, predictedDir: dir })
      }
    }

    // Resolve entries whose +5min candle is available (age >= 6 min).
    const resolvable = this.pendingBooks.filter((e) => now - e.ts >= 6 * 60_000)
    if (resolvable.length > 0 && adapter.getCandles) {
      const latest = new Map<string, (typeof resolvable)[number]>()
      for (const e of resolvable) {
        const cur = latest.get(e.ticker)
        if (!cur || e.ts > cur.ts) latest.set(e.ticker, e)
      }
      const targets = [...latest.values()]
      const candleMap: Record<string, MarketCandle[]> = await adapter
        .getCandles([...new Set(targets.map((e) => e.ticker))], 1, Math.floor((now - 8 * 60_000) / 1000), Math.floor(now / 1000))
        .catch(() => ({}))
      const s = this.state.bookStats
      for (const e of targets) {
        const cs = (candleMap[e.ticker] ?? []).filter((c) => c.endTs * 1000 >= e.ts)
        const targetTs = e.ts + 5 * 60_000
        let best: { d: number; price: number } | null = null
        for (const c of cs) {
          const price = c.close ?? midOf(c.bidClose, c.askClose)
          if (price === undefined) continue
          const d = Math.abs(c.endTs * 1000 - targetTs)
          if (!best || d < best.d) best = { d, price }
        }
        if (!best) continue
        const move = best.price - e.lastPrice
        const predicted = e.predictedDir === 'YES' ? move : -move
        s.observations++
        if (predicted > 0) s.hits++
        s.sumMove += predicted * 100
        s.meanMoveCents = s.sumMove / s.observations
        s.hitRate = s.hits / s.observations
        if (e.predictedDir === 'YES') s.yesSignals++
        else s.noSignals++
        s.lastLoggedAt = now
      }
      this.pendingBooks = this.pendingBooks.filter((e) => now - e.ts < 6 * 60_000)
      this.persist()
    }
  }

  private emit(type: string, payload: unknown): void {
    this.onEvent?.(type, payload)
  }
}

function defaultState(): PersistedState {
  return {
    openTrades: [],
    pendingOrders: [],
    signals: [],
    daily: { date: nowDate(), count: 0 },
    dailyPnl: { date: nowDate(), realized: 0, tripped: false },
    stats: { scans: 0, approved: 0, vetoed: 0, executed: 0 },
    bookStats: { observations: 0, hitRate: 0, meanMoveCents: 0, yesSignals: 0, noSignals: 0, hits: 0, sumMove: 0 },
    perf: { trades: 0, wins: 0, losses: 0, realizedPnl: 0 },
    perfByStrategy: {},
    calib: defaultCalib()
  }
}

/** Encrypt a secret for at-rest storage via the OS keychain (same scheme as ConfigStore). */
function encryptValue(value: string): string {
  if (!value) return value
  if (value.startsWith('enc:')) return value // kept ciphertext from a failed decrypt: do not double-encrypt
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(value).toString('base64')
    }
  } catch {
    // fall through to plain marker
  }
  return 'plain:' + value
}

function decryptValue(value: string): string {
  if (!value) return value
  if (value.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    } catch (err) {
      // '' would be persisted by the next save and destroy the key.
      console.warn('[auto-trader] decrypt failed; keeping ciphertext:', err)
      return value
    }
  }
  if (value.startsWith('plain:')) return value.slice(6)
  return value
}

// midOf lives in momentumCandidates.ts: the recorder must price a candle exactly as this file does, and a
// second copy is how the two diverged in review (one-sided candles priced here, dropped there).

/**
 * Padded upper bound on the true YES rate for a longshot trading at yesPrice,
 * from the 2026-08-28 historical calibration (docs/validation-results.md):
 * measured 0.0–0.1% YES below 5¢ (n=608–1,832) and 0.0–0.6% at 5–10¢
 * (n=165–693). Padded ~3× the worst measured bucket so the modeled edge is
 * conservative. Outside the calibrated range the market is assumed right.
 */
export function calibratedYesRate(yesPrice: number): number {
  // Quantize before the band tests. The favorite leg calls this as
  // calibratedYesRate(1 - yesExec), and 1 - 0.9 is 0.09999999999999998 in
  // IEEE-754 — which slipped under the `< 0.1` test and returned the 1.8%
  // discount band for a price the table scores at identity (no edge). At
  // yesExec 0.90 that manufactured a +6.4¢ edge on a trade this function
  // rates as 0¢, and 0.90 is exactly the favorite band's lower bound
  // (1 − fadeMaxPrice), so it was the MOST common favorite entry price.
  // 1e-6 keeps sub-cent venue ticks intact while dropping float dust.
  const p = Math.round(yesPrice * 1e6) / 1e6
  if (p < 0.05) return 0.003
  if (p < 0.1) return 0.018
  return p
}

/**
 * Entry fee in dollars for an open trade, from the fee coefficient recorded at
 * fill (0 when unknown). Cash-accurate: this is what the balance loses.
 */
export function entryFeeDollars(t: { outcome: string; entryPrice: number; shares: number; feeRate?: number }): number {
  if (!t.feeRate || !(t.shares > 0)) return 0
  const yesPx = t.outcome === 'YES' ? t.entryPrice : 1 - t.entryPrice
  // Fractional, as the venue charges (§127); rounding to whole contracts here undid that fix for the ledger (B-34).
  const C = t.shares
  return kalshiOrderFeeDollars(t.feeRate, yesPx, C)
}
/**
 * Net cents per contract for a settled trade: payout minus cost minus the fee
 * actually charged on the fill.
 *
 * FIXED 2026-09-18 (v27): the fee term used to divide an already per-contract
 * fee by the contract count a second time, understating the fee by exactly Cx.
 * This is the metric the promotion ladder ranks strategies on, and the bias is
 * price-dependent, so it silently favoured cheap-contract strategies. See
 * src/main/util/kalshiFee.ts.
 */
export function netCentsOf(t: { outcome: string; entryPrice: number; shares: number; feeRate?: number }, win: 0 | 1): number {
  const yesPx = t.outcome === 'YES' ? t.entryPrice : 1 - t.entryPrice
  const C = t.shares > 0 ? t.shares : 1
  const feePerContract = kalshiFeeCentsPerContract(t.feeRate ?? 0, yesPx, C)
  return (win ? 1 - t.entryPrice : -t.entryPrice) * 100 - feePerContract
}
/** UTC day of a close time, the day-cluster key. */
export interface ReversionInputs {
  /** Window candle prices, oldest first, in probability units. */
  prices: number[]
  /** How many candles in the window actually traded. */
  tradedCandles: number
  /** Hours of life the market has left. */
  hoursToClose: number
}
export interface ReversionRule {
  minMoveCents: number
  minHoursToClose: number
  /**
   * Floor on the price of the side we buy (v2, 2026-09-08). The Becker
   * audit (127M seat-rows) shows the 1-15c side loses for takers in every
   * category (politics -4.6c, crypto -2.0c, sports -1.8c per contract), so
   * fading a move must not mean buying the longshot. Default 0.35.
   */
  minEntryPrice?: number
  /**
   * Ceiling on hours to close (2026-09-09). The arm holds to settlement, so
   * the horizon is how long a slot stays occupied, and the move audit prices
   * the edge per contract, not per day: >3d nets +4.58c but locks a slot for
   * three days, while 12-24h nets +4.03c and frees it inside one. Same
   * capital-velocity argument fadeSignals makes when it ranks by edge/day.
   * Default 24h; 0 disables the ceiling.
   */
  maxHoursToClose?: number
}
/**
 * Mean reversion on extremes (pre-registered 2026-09-07). The 2026-08-28
 * momentum backtest measured a 10-minute move's mean FORWARD move at -6.6c
 * on a 36% hit rate: the move reverts. This takes that side - fade a big move
 * that actually traded, on a market with hours left to revert in.
 */
export function meanReversionVerdict(i: ReversionInputs, r: ReversionRule): { direction: 'YES' | 'NO'; moveCents: number } | null {
  if (i.prices.length < 2) return null
  if (!(i.hoursToClose >= r.minHoursToClose)) return null
  if (r.maxHoursToClose !== undefined && r.maxHoursToClose > 0 && i.hoursToClose > r.maxHoursToClose) return null
  // A move nobody traded is a quote flicker on a thin book, not a crowd
  // overreacting, and there is nothing to revert.
  if (i.tradedCandles < 3) return null
  const from = i.prices[0]
  const to = i.prices[i.prices.length - 1]
  const moveCents = (to - from) * 100
  if (Math.abs(moveCents) < r.minMoveCents) return null
  // Never fade into the tails: below 5c or above 95c the move is usually the
  // market resolving, and the side we would buy has no room left to pay.
  if (to < 0.05 || to > 0.95) return null
  // Buy the side the price moved away from, but never as a longshot.
  const direction: 'YES' | 'NO' = moveCents > 0 ? 'NO' : 'YES'
  const buyPrice = direction === 'YES' ? to : 1 - to
  if (buyPrice < (r.minEntryPrice ?? 0.35)) return null
  return { direction, moveCents }
}
export interface MorningEdgeInputs {
  /** Forecast-implied probability the bracket settles YES (0..1). */
  fair: number
  /** Best YES bid and ask in probability units; undefined sides are untradable. */
  bid?: number
  ask?: number
  /** Station-local hour, fractional (13.5 = 13:30 local). */
  localHour: number
  hoursToClose: number
  /** Kalshi taker fee coefficient for the series. */
  feeRate?: number
}
export interface MorningEdgeRule {
  fromHour: number
  toHour: number
  minEdgeCents: number
  minHoursToClose: number
}
/**
 * Time-of-day effect: the morning forecast update (pre-registered 2026-09-08,
 * docs/PREREGISTERED-weather-morning.md).
 *
 * Kalshi lists a day's temperature brackets the evening before, and they trade
 * overnight against the previous afternoon's forecast. The 06z/12z model runs
 * reach the NWS hourly product before local mid-morning, so in the station's
 * own morning the book can still be quoting yesterday's information while the
 * forecast has moved. This buys the side the refreshed forecast prefers and
 * holds to settlement.
 *
 * The edge is measured AFTER the taker fee at the price actually paid, because
 * a bracket bought at 8c costs 0.44c in fee and a 3c "edge" that ignores it is
 * not an edge. Both sides are considered; the better one wins, and only if it
 * clears the threshold on its own.
 */
export function morningForecastVerdict(i: MorningEdgeInputs, r: MorningEdgeRule): { direction: 'YES' | 'NO'; price: number; edgeCents: number } | null {
  if (!Number.isFinite(i.fair) || i.fair <= 0 || i.fair >= 1) return null
  if (!(i.hoursToClose >= r.minHoursToClose)) return null
  // The window is a clock check, not a range check: fromHour < toHour always
  // (a window across local midnight would span two measurement days).
  if (!(i.localHour >= r.fromHour && i.localHour < r.toHour)) return null
  const fee = (yesPx: number): number => kalshiOrderFeeCents(i.feeRate ?? 0, yesPx, 1)
  // Buying YES pays the ask; buying NO pays 1 − bid and its fee is priced on
  // the same YES leg (Kalshi's fee is symmetric in p(1−p)).
  const yes = i.ask !== undefined && i.ask > 0.02 && i.ask < 0.98 ? (i.fair - i.ask) * 100 - fee(i.ask) : null
  const no = i.bid !== undefined && i.bid > 0.02 && i.bid < 0.98 ? (i.bid - i.fair) * 100 - fee(i.bid) : null
  const best = (yes ?? -Infinity) >= (no ?? -Infinity) ? 'YES' : 'NO'
  const edgeCents = (best === 'YES' ? yes : no) ?? -Infinity
  if (!Number.isFinite(edgeCents) || edgeCents < r.minEdgeCents) return null
  return { direction: best, price: best === 'YES' ? i.ask! : i.bid!, edgeCents }
}
export function dayKeyOf(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : 'unknown'
}
/**
 * Day bucket for the clustered statistics: the day the P&L was REALIZED.
 * A trade's cached close time is not that day. Kalshi lists a sports market
 * with an expiration-shaped close_time until play ends (the MILCIN game of
 * 2026-09-06 carried close 2026-09-09 while it traded), and a trade sold
 * before close is realized today whatever its market's close says. Bucketing
 * by the stale value put all 20 momentum trades into one future 2026-09-09
 * cluster - a nonsense date, and a single cluster whose clustered SE is
 * exactly zero. Never bucket after today.
 */
export function clusterDayOf(ms: number | undefined, now: number = Date.now()): string {
  return dayKeyOf(ms === undefined || !Number.isFinite(ms) || ms > now ? now : ms)
}
/** Mean and event-clustered 95% interval from the per-cluster sums kept by gradeEntry. */
export function clusteredNet(s: { netN?: number; netSum?: number; netSq?: number; byEvent?: Record<string, { n: number; sum: number }>; byDay?: Record<string, { n: number; sum: number }> }): { mean: number; lo: number; hi: number; events: number; days: number } | undefined {
  const N = s.netN ?? 0
  if (N === 0) return undefined
  const mean = (s.netSum ?? 0) / N
  const groups = Object.values(s.byEvent ?? {})
  // Finite-cluster correction, and a floor at the plain SE below three clusters - exactly what
  // ladder.clusteredMean and dayClusteredSe do. With every observation in ONE event cluster the inner sum
  // is identically zero, so this returned an SE of exactly 0 and a "95% interval" that collapsed onto the
  // point estimate: the failure that stopped a strategy on a band of -2.93..-2.93 on 2026-09-07, patched
  // into both siblings and missed here. Three keys in the live ledger sit at netN=1 right now.
  const G = groups.length
  const clustered = (Math.sqrt(groups.reduce((acc, g) => acc + Math.pow(g.sum - g.n * mean, 2), 0)) / N) * (G > 1 ? Math.sqrt(G / (G - 1)) : 1)
  const plain = N > 1 && s.netSq !== undefined ? Math.sqrt(Math.max(0, (s.netSq - N * mean * mean) / (N - 1)) / N) : 0
  const se = G < 3 ? Math.max(clustered, plain) : clustered
  return { mean, lo: mean - 1.96 * se, hi: mean + 1.96 * se, events: G, days: Object.keys(s.byDay ?? {}).length }
}
/**
 * Kalshi taker fee in cents PER CONTRACT. feeRate already carries the series
 * multiplier (0.07 x mult).
 *
 * DEPRECATED for sizing maths. Because the venue ceils the ORDER total, this
 * result is only a valid per-contract cost when the order really is one
 * contract (at contracts = 1 the two are identical). Multi-contract callers
 * must use kalshiFeeCentsPerContract(rate, px, contracts) or
 * kalshiTakerFeeCentsFor(px, contracts, mult) from ../util/kalshiFee.
 * Retained because scripts/tests/review-fixes.test.ts pins its 1-contract
 * values, which remain correct.
 */
export function kalshiOrderFeeCents(feeRate: number, yesPrice: number, contracts: number): number {
  if (contracts <= 0 || feeRate <= 0) return 0
  return kalshiFeeCentsPerContract(feeRate, yesPrice, contracts)
}

/**
 * Guard band (°F) between the observed running extreme and a strike before
 * the ratchet calls a bracket decided: the settlement CLI product ingests
 * 6-hour maxima/minima and occasionally prints 1°F+ past the minute index.
 */
export const RATCHET_GUARD_F = 2

/** The market must give our "certain" side at least this much, or we are the ones who are wrong. */
export const RATCHET_MIN_AGREE = 0.6
/** Widest book the ratchet may enter: its whole edge is a few cents. */
export const RATCHET_MAX_SPREAD = 0.06

/**
 * Ratchet entry guard. The banked extreme is not evidence on its own. On
 * 2026-09-07/08 the Kalshi Boston index MINIMUM banked about 9F below the
 * observed daily minimum (50.36F vs 59.00F, then 55.31F vs 64.40F against NWS
 * KBOS), and the arm read two brackets as mechanically decided NO. The first
 * settled YES for a total loss: it had bought NO at 4.2c, i.e. the market
 * priced our "certain" side at four cents and the market was right. The
 * second was bought at 96c on a 12c-wide book whose own NO mid was 90c.
 *
 * The monotone logic itself is sound, so this does not touch it. It adds the
 * two sanity rules a decided bracket must also pass: the market may not
 * strongly disagree, and the book must be tight enough for the edge to
 * survive the entry. Returns a refusal reason, or null to allow.
 */
export function ratchetEntryBlock(
  direction: 'YES' | 'NO',
  yesProb: number,
  spread: number | undefined,
  minAgree = RATCHET_MIN_AGREE,
  maxSpread = RATCHET_MAX_SPREAD
): string | null {
  if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) return 'no usable market price'
  const ourProb = direction === 'YES' ? yesProb : 1 - yesProb
  if (ourProb < minAgree) {
    return `market prices our "certain" side at ${Math.round(ourProb * 100)}c (floor ${Math.round(minAgree * 100)}c) — the banked extreme is likelier wrong than the market`
  }
  if (spread !== undefined && Number.isFinite(spread) && spread > maxSpread) {
    return `book ${Math.round(spread * 100)}c wide (max ${Math.round(maxSpread * 100)}c) — the entry gives up more than the edge`
  }
  return null
}

/**
 * Monotone ratchet verdict. A running max only rises: clearing a strike
 * decides above-brackets YES and below-brackets NO, permanently. A running
 * min mirrors it. Crucially it NEVER decides the other way — an uncleared
 * strike stays undecided (the extreme may still arrive), so this can never
 * short a bracket the day might still reach.
 */
export function ratchetVerdict(
  kind: 'high' | 'low',
  dir: 'above' | 'below',
  strike: number,
  hi: number,
  lo: number,
  guardF: number
): 'YES' | 'NO' | null {
  if (kind === 'high') {
    if (hi >= strike + guardF) return dir === 'above' ? 'YES' : 'NO'
    return null
  }
  if (lo <= strike - guardF) return dir === 'below' ? 'YES' : 'NO'
  return null
}

/**
 * Ratchet verdict from the venue's structured strike fields, including
 * BETWEEN brackets. Only the monotone direction is ever called: a running max
 * that clears a bracket's cap (or a running min that clears its floor) has
 * decided that bracket NO for good; the YES side of a between-bracket is never
 * called because the extreme can still move past the top boundary.
 */
export function ratchetBracketVerdict(
  kind: 'high' | 'low',
  strikeType: string | undefined,
  floor: number | undefined,
  cap: number | undefined,
  hi: number,
  lo: number,
  guardF: number
): 'YES' | 'NO' | null {
  const t = (strikeType ?? '').toLowerCase()
  const above = t.startsWith('greater')
  const below = t.startsWith('less')
  const between = t === 'between'
  if (kind === 'high') {
    if (above && typeof floor === 'number') return hi >= floor + guardF ? 'YES' : null
    if (below && typeof cap === 'number') return hi >= cap + guardF ? 'NO' : null
    if (between && typeof cap === 'number') return hi >= cap + guardF ? 'NO' : null
    return null
  }
  if (below && typeof cap === 'number') return lo <= cap - guardF ? 'YES' : null
  if (above && typeof floor === 'number') return lo <= floor - guardF ? 'NO' : null
  if (between && typeof floor === 'number') return lo <= floor - guardF ? 'NO' : null
  return null
}


/** Coarse headline polarity from a keyword list; 0 = neutral. */
function polarity(headline: string): number {
  const words = headline.toLowerCase().split(/\s+/)
  let score = 0
  for (const w of words) {
    if (POS_WORDS.includes(w)) score++
    else if (NEG_WORDS.includes(w)) score--
  }
  return score > 0 ? 1 : score < 0 ? -1 : 0
}

/** Strike + direction for a scalar market: structured fields first, title parse fallback. */
export function strikeOf(m: VenueMarket): { strike: number; dir: 'above' | 'below' } | null {
  // Live values observed: greater, greater_or_equal, less, less_or_equal,
  // between, custom. The or-equal boundary is negligible for a continuous
  // index vs a >2% margin gate.
  const above = m.strikeType === 'greater' || m.strikeType === 'greater_or_equal'
  const below = m.strikeType === 'less' || m.strikeType === 'less_or_equal'
  if (above && typeof m.floorStrike === 'number' && m.floorStrike > 0) {
    return { strike: m.floorStrike, dir: 'above' }
  }
  if (below && typeof m.capStrike === 'number' && m.capStrike > 0) {
    return { strike: m.capStrike, dir: 'below' }
  }
  // 'between' and other range types are not a single-threshold trade — skip
  // rather than guess a side.
  if (m.strikeType && !above && !below) return null
  return parseStrike(m.question)
}

/**
 * Extract strike + direction from a strike-market question
 * ("… · $2.1399 or above", "$85,000 or above" — commas must not split the number).
 */
export function parseStrike(question: string): { strike: number; dir: 'above' | 'below' } | null {
  const m = question.match(/([\d][\d,]*(?:\.\d+)?)\s*(or above|above|or below|below)/i)
  if (!m) return null
  const strike = parseFloat(m[1].replace(/,/g, ''))
  if (!Number.isFinite(strike) || strike <= 0) return null
  return { strike, dir: /below/i.test(m[2]) ? 'below' : 'above' }
}
