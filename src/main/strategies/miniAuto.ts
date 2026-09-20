import { appendFileSync } from 'node:fs'
import { parseUsTempSlug, usWeatherFairValue } from './weatherForecast'
import { app } from 'electron'
import { OracleIntelligenceEngine } from '../intelligence/engine'
import type { AutoSignal } from '../../shared/ipc'
import { JsonStore } from '../store/json'
import type { TradingEngine } from '../engine/engine'
import type { MiniAutoConfig, MiniScanResult, MiniStatus } from '../../shared/ipc'
import type { AutoOpenTrade, AutoPendingOrder } from '../../shared/ipc'
import type { OrderResult, VenueId, VenueMarket } from '../../shared/types'
import { fadeCategoryBlock, underlyingOf } from './classify'
import { refreshedCloseTime, settlementProbeDue, stuckSettlements } from './ledgerAudit'

const SETTLE_GRACE_MS = 30 * 60_000
/** A mini arm owns its entry cost; pooled venue basis can include another arm. */
export function miniExitPnl(trade: Pick<AutoOpenTrade, 'entryPrice'>, res: OrderResult): number {
  return (res.paper || res.venue !== 'polymarket-us') && res.realizedPnl !== undefined
    ? res.realizedPnl : (res.avgPrice - trade.entryPrice) * res.shares - (res.fee ?? 0)
}
/**
 * Order-book lookups the micro-maker may spend in one scan. It needs `microMakerMaxMarkets` (6) markets;
 * before this it fetched one book for EVERY in-horizon market - 750 of them, ~225s of a 288s scan.
 * Generous on purpose, so the examined set barely changes.
 */
const MICRO_MAKER_BOOK_BUDGET = 120
/** Past close by this much AND unfetchable = the venue dropped it; stop holding. */
const STALE_DROP_MS = 12 * 3600_000

/** Bump when adding a config migration below — persist() must write the CURRENT version. */
const CONFIG_VERSION = 20

export const MINI_DEFAULTS: MiniAutoConfig = {
  enabled: false,
  autoPoll: false,
  pollIntervalSeconds: 60,
  amountPerTrade: 2,
  /**
   * Ceiling on each stake as a % of account EQUITY (cash + open positions).
   * The minis previously had no cap at all and used a flat amount, which on
   * a 900-mana account meant a 2-mana bet — 2% of the account deployable
   * across every slot combined.
   */
  maxBalancePct: 4,
  maxOpenPositions: 25,
  maxDailyTrades: 60,
  maxDailyLossDollars: 0,
  fadeEnabled: true,
  fadeMaxPrice: 0.1,
  fadeMinPrice: 0.03,
  // Mirror side: back favorites at 1−fadeMaxPrice … 1−fadeMinPrice — same
  // longshot-overpricing bias, opposite leg.
  // See AutoTrader v15: the favorite leg is a measured loser; off by default.
  fadeFavoritesEnabled: false,
  // The research-driven gates the Kalshi trader already runs. They were
  // missing here, so this venue kept taking the inside-48h weather fades
  // the calibration study measured as inverted.
  fadeCategoryFilterEnabled: true,
  // Mirrors the Kalshi trader's v14 exception. Letting the venues diverge is
  // what v11 fixed — a filter set that differs per venue makes their records
  // incomparable, and this venue grades no counterfactual of its own, so
  // leaving crypto blocked here would never produce contrary evidence.
  fadeCategoryExceptions: ['crypto'],
  maxPerUnderlying: 1,
  /**
   * Apply TP/SL and the pre-close exit to FADE positions instead of holding
   * to settlement. Default false — holding is the evidenced policy.
   *
   * Exiting early only beats holding if the pre-close price OVERSTATES the
   * favorite, which is the exact negation of the entry signal; you cannot
   * coherently believe both. Settlement is free on Kalshi/PolyUS while a
   * round trip costs half a spread plus a rounded-up fee (~1.25c at the
   * median 2c exit-band spread = 83% of the 1.5c minimum edge). Measured
   * here: holding returned +5.32%/trade vs -2.30% for the early-exit venue,
   * and early exit did NOT dodge the tail — it converted a rare -100% into
   * frequent -15..-24% losses at the same mean, minus the friction.
   *
   * MANIFOLD IS THE EXCEPTION (set true in the v11 migration): its markets
   * are CREATOR-resolved, so resolution risk — not price — is a legitimate
   * reason to be flat before settlement. That reason does not exist on the
   * two CFTC-regulated venues.
   */
  fadeExitEnabled: false,
  // LIVE entries on book venues rest post-only (Polymarket US maker fee is a
  // REBATE); paper and AMM venues stay taker.
  fadeEntryMode: 'maker',
  // Entry-quality gates. Manifold markets are creator-created AND
  // creator-RESOLVED — tiny niche markets are often insider-known (the
  // Kalshi longshot calibration does not transfer there). Bettor count is
  // the sharper insider discriminator (measured 2026-08-29: creator-clique
  // markets run 4–10 bettors; real ones 16–159), so the crowd gate does the
  // work and the liquidity floor only screens sub-default dust. On book
  // venues (Polymarket US) require a tight two-sided book with real depth.
  fadeMinLiquidity: 100,
  fadeMinBettors: 15,
  fadeMaxSpreadCents: 5,
  // Polymarket US weather books carry $10-30/side (measured 2026-08-29);
  // $25 is still >10× the default stake while screening painted books.
  fadeMinSideDollars: 25,
  // Short-expiry testing window: 15 min to 24 h. Longer horizons are an
  // explicit CHOICE via the panel's horizon dropdown.
  minMinutesToClose: 15,
  maxHoursToClose: 24,
  // One-contract, one-sided passive maker experiment. Disabled globally; the
  // v15 migration enables it only for Polymarket US. Side is assigned by a
  // stable market-id hash, preventing discretionary outcome selection.
  microMakerEnabled: false,
  microMakerMaxMarkets: 4,
  microMakerMinSpreadCents: 1,
  microMakerMaxSpreadCents: 6,
  microMakerMinSideDollars: 10,
  microMakerMinMidPrice: 0.2,
  microMakerMaxMidPrice: 0.8,
  microMakerMinHoursToClose: 1,
  microMakerCancelMinutes: 30,
  bookEnabled: false,
  bookMinRatio: 1.6,
  bookMinDepth: 200,
  bookMinSideDepth: 40,
  takeProfitPct: 6,
  stopLossPct: 12,
  exitMinutesBeforeClose: 30,
  maxHoldMinutes: 0,
  dryRun: false,
  liveArmed: false
}

interface MiniState {
  openTrades: AutoOpenTrade[]
  /** Resting maker orders awaiting fill (live maker mode, book venues). */
  pendingOrders: AutoPendingOrder[]
  daily: { date: string; count: number }
  /** Realized P&L for the current UTC day, and whether the loss brake has tripped. */
  dailyPnl?: { date: string; realized: number; tripped: boolean }
  perf: { trades: number; wins: number; losses: number; realizedPnl: number }
  /** Same counters split by the strategy that opened the trade (fade, book-imbalance, ...). */
  perfByStrategy?: Record<
    string,
    {
      trades: number
      wins: number
      losses: number
      realizedPnl: number
      clvSum?: number
      clvN?: number
      clvSq?: number
      clvSqN?: number
      markoutSum?: number
      markoutN?: number
      markoutSq?: number
      markoutSqN?: number
      markoutMissingN?: number
    }
  >
  stats: { scans: number; executed: number }
  lastScanMs?: number
  lastError?: string
  /** Last scan's venue-catalog verdict; undefined = catalog looked healthy. */
  venueHealth?: string
}

interface MiniStore {
  config: MiniAutoConfig
  state: MiniState
  configVersion: number
}

function nowDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function fmtErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Bare-minimum multi-venue auto-trader for venues without Kalshi's data
 * depth (Manifold AMM, Polymarket US). Strategies: longshot fade (buy NO on
 * p<0.10) everywhere, order-book imbalance where a book exists. Same safety
 * model as the Kalshi AutoTrader: dryRun > paper > live (armed + live mode).
 */
export class MiniAuto {
  /** Last settlement probe per trade id, so a stale close time costs one market fetch per 10 min, not one per scan. */
  private settleProbeAt = new Map<string, number>()
  private config: MiniAutoConfig
  private state: MiniState
  /** Last scan's entry-block reason, so a bound cap logs on change instead of every 60 s. */
  private lastEntryBlock: string | null = null
  private store: JsonStore<MiniStore>
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private resetRequested = false
  private readonly researchLogPath: string
  /** True once live venue state has been fetched cleanly this process. */
  private reconciledLive = false
  private onEvent?: (type: string, payload: unknown) => void
  private readonly intelligence = new OracleIntelligenceEngine(app.getPath('userData'))

  /**
   * Boot gate check: one clean positions (+ open orders where supported)
   * fetch per process before live entries may spend — a crash-restart with
   * stale local state must be observed first. Retries every scan until it
   * succeeds; paper mode needs no reconcile (the broker is local).
   */
  private async bootReconcile(): Promise<void> {
    if (this.reconciledLive || this.engine.getExecutionMode() !== 'live') return
    const adapter = this.engine.getAdapter(this.venue)
    if (!adapter) return
    try {
      await adapter.getPositions()
      if (adapter.getOpenOrders) await adapter.getOpenOrders()
      this.reconciledLive = true
    } catch {
      // fetch failed — stay gated, try again next scan
    }
  }

  /** Stake per trade: configured amount, capped to a % of account equity. */
  private stakeFor(base: number | undefined): number {
    const cfg = this.config
    if (cfg.maxBalancePct > 0 && base !== undefined && base > 0) {
      return Math.min(cfg.amountPerTrade, (cfg.maxBalancePct / 100) * base)
    }
    return cfg.amountPerTrade
  }

  constructor(
    private readonly engine: TradingEngine,
    private readonly venue: VenueId,
    statePath: string
  ) {
    this.researchLogPath = `${statePath}-research.jsonl`
    this.store = new JsonStore<MiniStore>(statePath, {
      config: { ...MINI_DEFAULTS },
      state: {
        openTrades: [],
        pendingOrders: [],
        daily: { date: nowDate(), count: 0 },
        perf: { trades: 0, wins: 0, losses: 0, realizedPnl: 0 },
        stats: { scans: 0, executed: 0 }
      },
      // NOT CONFIG_VERSION: JsonStore keeps these defaults when the file is absent or will not parse, so
      // stamping the current version here tells every `if ((persisted.configVersion ?? 1) < N)` migration
      // below that it has already run. On 2026-09-03 this very file was quarantined for a stray BOM
      // (mini-auto-polymarket-us.json.corrupt-1788435253682), and coming back on bare MINI_DEFAULTS means
      // maxDailyLossDollars: 0 — no daily loss brake at all on a real-money venue. 0 makes every migration
      // run, which is what a fresh install should do anyway.
      configVersion: 0
    })
    const persisted = this.store.get()
    this.config = { ...MINI_DEFAULTS, ...persisted.config }
    this.state = persisted.state ?? {
      openTrades: [],
      pendingOrders: [],
      daily: { date: nowDate(), count: 0 },
      perf: { trades: 0, wins: 0, losses: 0, realizedPnl: 0 },
      stats: { scans: 0, executed: 0 }
    }
    this.state.pendingOrders = this.state.pendingOrders ?? []
    if ((persisted.configVersion ?? 1) < 2) {
      // v2: widen the close window from 7 days — Polymarket US only lists
      // long-dated markets, so the fade found nothing there.
      if (this.config.maxHoursToClose === 168) this.config.maxHoursToClose = 4320
      this.store.update({ config: this.config, state: this.state, configVersion: 2 })
    }
    if ((persisted.configVersion ?? 1) < 3) {
      // v3: revert the v2 widen — Polymarket US DOES have short-dated weather
      // ladders (the adapter was just truncating to the first page). 7 days
      // keeps the fade comparable to the Kalshi validation.
      if (this.config.maxHoursToClose === 4320) this.config.maxHoursToClose = 168
    }
    if ((persisted.configVersion ?? 1) < 4) {
      // v4: short-expiry testing window (15 min – 3 days), applied only when
      // still at the old defaults so user overrides survive.
      if (this.config.minMinutesToClose === 60) this.config.minMinutesToClose = 15
      if (this.config.maxHoursToClose === 168) this.config.maxHoursToClose = 72
    }
    if ((persisted.configVersion ?? 1) < 5) {
      // v5: liquidity 500 excluded the whole default-subsidy tier (100 M$)
      // where most near-term real-crowd markets live; the bettors gate is the
      // sharper insider filter, so the floor drops to 100. Side-depth 50
      // drops to 25 — Polymarket US weather books carry $10-30/side.
      if (this.config.fadeMinLiquidity === 500) this.config.fadeMinLiquidity = 100
      if (this.config.fadeMinSideDollars === 50) this.config.fadeMinSideDollars = 25
    }
    if ((persisted.configVersion ?? 1) < 6) {
      // v6: trade the favorite mirror of the fade band.
      this.config.fadeFavoritesEnabled = true
    }
    if ((persisted.configVersion ?? 1) < 7) {
      // v7 (user directive 2026-08-30): long positions only by explicit
      // choice — default search horizon drops to 24h.
      if (this.config.maxHoursToClose === 72) this.config.maxHoursToClose = 24
    }
    if ((persisted.configVersion ?? 1) < 8) {
      // v8: the evidence-driven category filter and per-underlying cap that
      // the Kalshi trader has had since its v11/v12 — this venue was still
      // taking negative-edge weather fades and stacking sibling strikes.
      this.config.fadeCategoryFilterEnabled = this.config.fadeCategoryFilterEnabled ?? true
      this.config.maxPerUnderlying = this.config.maxPerUnderlying ?? 1
    }
    if ((persisted.configVersion ?? 1) < 9) {
      // v9 idle-cash fix: a flat 2-unit stake left these accounts 2-44%
      // deployed (2 mana against a 900-mana Manifold balance). Raise the
      // flat ceiling so the new equity percentage is what actually binds.
      this.config.maxBalancePct = this.config.maxBalancePct ?? 10
      if (this.config.amountPerTrade === 2) this.config.amountPerTrade = 1000
    }
    if ((persisted.configVersion ?? 1) < 10) {
      // v10: more positions, smaller each — same deployment ceiling but far
      // more independent samples per day, which is what a testing program
      // actually needs. See the AutoTrader v13 note.
      if (this.config.maxOpenPositions === 10 || this.config.maxOpenPositions === 4) this.config.maxOpenPositions = 25
      if (this.config.maxBalancePct === 10) this.config.maxBalancePct = 4
      if (this.config.maxDailyTrades === 15) this.config.maxDailyTrades = 60
    }
    if ((persisted.configVersion ?? 1) < 11) {
      // v11: fades hold to settlement, matching the Kalshi trader. The two
      // venues were silently running different strategies, which made their
      // records incomparable. Manifold keeps exiting early because its
      // markets are creator-resolved (resolution risk, not price).
      // Manifold was removed 2026-09-18; only Manifold set this true, so every surviving venue holds to settlement.
      this.config.fadeExitEnabled = false
    }
    if ((persisted.configVersion ?? 1) < 20) {
      // v20 (2026-09-09 audit): the mini had no loss-based brake at all. Sized
      // so it does not bind on a normal day — the worst measured PolyUS day is
      // -$5.38 (2026-09-08) — while still stopping a runaway on a ~$63 balance.
      // Not `??`: config is `{ ...MINI_DEFAULTS, ...persisted }` and the
      // default is 0, so the key always exists and a nullish check would
      // silently no-op, leaving the brake off on the venue that needs it.
      if (this.venue === 'polymarket-us' && !(this.config.maxDailyLossDollars > 0)) this.config.maxDailyLossDollars = 10
    }
    if ((persisted.configVersion ?? 1) < 12) {
      // v12: mirror AutoTrader v14 — crypto fades unblocked on the Kalshi
      // counterfactual ledger (38/39 winners over 39 graded).
      this.config.fadeCategoryExceptions = this.config.fadeCategoryExceptions ?? ['crypto']
    }
    if ((persisted.configVersion ?? 1) < 13) {
      // v13: mirror AutoTrader v15 — favorite fade leg measured -8c+, disable.
      if (this.config.fadeFavoritesEnabled === true) this.config.fadeFavoritesEnabled = false
    }
    if ((persisted.configVersion ?? 1) < 14) {
      // v14 (2026-09-02 live alpha upgrade): disable bookEnabled (1W/9L on sports,
      // negative expectancy) and enforce favorite fade off.
      this.config.bookEnabled = false
      if (this.config.fadeFavoritesEnabled === true) this.config.fadeFavoritesEnabled = false
    }
    if ((persisted.configVersion ?? 1) < 15) {
      // v15: restore useful Polymarket US activity with a separately measured,
      // strictly one-contract passive-maker experiment. Never enable on Manifold.
      this.config.microMakerEnabled = this.venue === 'polymarket-us'
      this.config.microMakerMaxMarkets = 2
      this.config.microMakerMinSpreadCents = 1
      this.config.microMakerMaxSpreadCents = 6
      this.config.microMakerMinSideDollars = 10
      this.config.microMakerMinMidPrice = 0.2
      this.config.microMakerMaxMidPrice = 0.8
      this.config.microMakerMinHoursToClose = 1
      this.config.microMakerCancelMinutes = 30
    }
    if ((persisted.configVersion ?? 1) < 16) {
      // v16: increase independent one-contract maker slots; the two-slot
      // probe filled too slowly to reach a useful sample.
      if (this.venue === 'polymarket-us' && this.config.microMakerMaxMarkets === 2) this.config.microMakerMaxMarkets = 4
    }
    if ((persisted.configVersion ?? 1) < 17) {
      // v17: increase independent one-contract Polymarket maker observations.
      // maxOpenPositions=2 silently overrode microMakerMaxMarkets=4.
      if (this.venue === 'polymarket-us') {
        if (this.config.maxOpenPositions < 6) this.config.maxOpenPositions = 6
        if (this.config.microMakerMaxMarkets < 6) this.config.microMakerMaxMarkets = 6
      }
    }
    if ((persisted.configVersion ?? 1) < 18) {
      // v18 (operator directive 2026-09-06): let the ladder's stake scale-ups take effect on Polymarket US.
      if (this.venue === 'polymarket-us' && this.config.maxBalancePct < 10) this.config.maxBalancePct = 10
    }
    if ((persisted.configVersion ?? 1) < 19) {
      // v19: two-sided micro-maker quotes are two resting orders per market;
      // the open-position cap must not halve the market breadth again.
      if (this.venue === 'polymarket-us' && this.config.maxOpenPositions < 2 * this.config.microMakerMaxMarkets) this.config.maxOpenPositions = 2 * this.config.microMakerMaxMarkets
    }
    if ((persisted.configVersion ?? 1) < CONFIG_VERSION) {
      this.persist()
    }
  }

  getConfig(): MiniAutoConfig {
    return { ...this.config }
  }

  setConfig(cfg: Partial<MiniAutoConfig>): MiniAutoConfig {
    this.config = { ...this.config, ...cfg }
    this.persist()
    this.restartTimer()
    return this.getConfig()
  }

  setEventHandler(fn: (type: string, payload: unknown) => void): void {
    this.onEvent = fn
  }

  getStatus(): MiniStatus {
    const wl = this.state.perf.wins + this.state.perf.losses
    return {
      venue: this.venue,
      running: this.timer !== null,
      dryRun: this.config.dryRun,
      liveArmed: this.config.liveArmed,
      openTrades: this.state.openTrades.map((t) => ({ ...t })),
      pendingOrders: this.state.pendingOrders.map((p) => ({ ...p })),
      dailyTrades: this.state.daily.date === nowDate() ? this.state.daily.count : 0,
      scans: this.state.stats.scans,
      executed: this.state.stats.executed,
      lastScanMs: this.state.lastScanMs,
      perf: { ...this.state.perf, winRate: wl > 0 ? this.state.perf.wins / wl : 0 },
      perfByStrategy: { ...(this.state.perfByStrategy ?? {}) },
      lastError: this.state.lastError
    }
  }

  reset(): void {
    // Paper only (audit 2026-09-19, B-01): a live reset cancels real resting orders and forgets real positions.
    if (this.engine.getExecutionMode() === 'live') {
      throw new Error('Reset is paper-only: switch execution mode to paper first. In live mode a reset would cancel real resting orders and forget real positions.')
    }
    // Same mid-scan race as the main AutoTrader: never swap state during a
    // tick — defer to the next safe boundary.
    if (this.busy) {
      this.resetRequested = true
      return
    }
    this.doReset()
  }

  private doReset(): void {
    if (this.engine.getExecutionMode() === 'live') {
      console.warn(`[mini ${this.venue}] deferred reset refused: execution mode is live`)
      return
    }
    // Live resting maker orders must not outlive the ledger that tracks them.
    const adapter = this.engine.getAdapter(this.venue)
    for (const p of this.state.pendingOrders) {
      adapter?.cancelOrder(p.orderId, p.marketId).catch(() => undefined)
    }
    this.state = {
      openTrades: [],
      pendingOrders: [],
      daily: { date: nowDate(), count: 0 },
      perf: { trades: 0, wins: 0, losses: 0, realizedPnl: 0 },
      stats: { scans: 0, executed: 0 }
    }
    this.persist()
  }

  start(): void {
    this.restartTimer()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<MiniScanResult> {
    if (!this.config.enabled) return { venue: this.venue, scanned: 0, candidates: 0, executed: 0, errors: [] }
    if (this.busy) return { venue: this.venue, scanned: 0, candidates: 0, executed: 0, errors: ['scan in progress'] }
    this.busy = true
    const result: MiniScanResult = { venue: this.venue, scanned: 0, candidates: 0, executed: 0, errors: [] }
    const started = Date.now()
    /** Venue-catalog health, surfaced even when the scan itself is error-free. */
    let venueHealth: string | undefined
    try {
      if (this.resetRequested) {
        this.resetRequested = false
        this.doReset()
      }
      if (this.state.daily.date !== nowDate()) this.state.daily = { date: nowDate(), count: 0 }
      await this.bootReconcile()
      await this.managePendingOrders(result)
      await this.manageExits(result)

      const adapter = this.engine.getAdapter(this.venue)
      if (!adapter) throw new Error(`no adapter for ${this.venue}`)
      // Bound the fetch to the horizon so venues that paginate by volume (and
      // would otherwise bury short-dated markets) return the right window.
      const now = Date.now()
      const markets = await adapter.searchMarkets({
        status: 'open',
        limit: 1000,
        sort: 'ending-soon',
        minCloseTime: now + this.config.minMinutesToClose * 60_000,
        maxCloseTime: now + this.config.maxHoursToClose * 3600_000
      })
      result.scanned = markets.length

      // Venue-health check. A venue serving a STALE catalog looks exactly
      // like a quiet market from inside the scan loop — zero candidates, no
      // error, normal timings — which is the most dangerous shape a failure
      // can take. Polymarket US began serving a 10-month-old catalog on
      // 2026-09-01 and the bot reported nothing wrong for ~16 hours.
      // Surface it explicitly instead.
      const future = markets.filter((m) => m.closeTime !== undefined && m.closeTime > now).length
      // Held in a local, not written straight to state: the end of the scan
      // overwrites lastError with result.errors[0], which silently erased
      // this the first time it shipped.
      if (markets.length === 0) {
        venueHealth = `no open markets inside the ${this.config.maxHoursToClose}h horizon — catalog empty, API changed, or simply nothing listed this window`
      } else if (future === 0) {
        venueHealth = `venue catalog looks STALE — ${markets.length} markets returned, none closing in the future`
      }
      // Persisted so the NEXT scan's exit pass can tell an outage (hold
      // everything) from a genuine delisting (drop the zombie).
      this.state.venueHealth = venueHealth

      const candidates: { m: VenueMarket; strategy: string; direction: 'YES' | 'NO'; reason: string; makerSpreadCents?: number; limitYes?: number }[] = []
      // One order-book fetch per in-horizon market, sequentially, was 750 fetches and ~225s of a 288s scan -
      // to find at most microMakerMaxMarkets (6) worth quoting. Budget them, and say so when it bites.
      let bookBudget = MICRO_MAKER_BOOK_BUDGET
      let bookSkipped = 0

      for (const m of markets) {
        if (m.status !== 'open' || !m.closeTime || m.probability === undefined) continue
        // Binary only: a three-way (soccer draw) or multi-outcome market
        // priced as binary is a guaranteed mispricing on OUR side.
        if (m.outcomeType && m.outcomeType !== 'BINARY') continue
        const toClose = m.closeTime - now
        // Entry must leave MORE time than the pre-close exit needs, plus a
        // margin. Otherwise a market inside the exit window is bought and
        // instantly sold again every poll: on 2026-08-31 a 15-min floor
        // against a 30-min pre-close exit churned one market 16 times,
        // round-tripping the spread each cycle (free in paper, not live).
        const entryFloorMin = Math.max(this.config.minMinutesToClose, this.config.exitMinutesBeforeClose + 5)
        if (toClose < entryFloorMin * 60_000) continue
        if (toClose > this.config.maxHoursToClose * 3600_000) continue
        if (m.probability <= 0.02 || m.probability >= 0.98) continue

        if (this.venue === 'polymarket-us' && this.config.microMakerEnabled && adapter.getOrderBook) {
          const hours = toClose / 3600_000
          // The venue advertises a best bid and ask on the list row, which mapMarket already turns into
          // m.spread, and m.probability is the long side's price. When both are known and put the market
          // clearly outside the band, no order book can bring it back inside - so do not pay for one.
          // Slack is generous (2c of spread, 0.05 of mid) so a market that has just tightened still gets
          // examined; the book check below is unchanged and stays authoritative for everything we fetch.
          const advSpreadC = m.spread !== undefined ? m.spread * 100 : undefined
          const advMid = m.probability
          const advertisedMiss =
            (advSpreadC !== undefined && (advSpreadC > this.config.microMakerMaxSpreadCents + 2 || advSpreadC < this.config.microMakerMinSpreadCents - 2)) ||
            (advMid !== undefined && (advMid > this.config.microMakerMaxMidPrice + 0.05 || advMid < this.config.microMakerMinMidPrice - 0.05))
          if (hours >= this.config.microMakerMinHoursToClose && !advertisedMiss && bookBudget <= 0) bookSkipped++
          if (hours >= this.config.microMakerMinHoursToClose && !advertisedMiss && bookBudget > 0) {
            bookBudget--
            const book = await adapter.getOrderBook(m.id).catch(() => undefined)
            const bid = book?.bids[0]?.price
            const ask = book?.asks[0]?.price
            if (book && bid !== undefined && ask !== undefined && ask > bid) {
              const spreadCents = (ask - bid) * 100
              const mid = (ask + bid) / 2
              const bidDepth = book.bids.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
              const askDepth = book.asks.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
              const oneContractAllowed = (m.minTradeQty ?? 1) <= 1
              if (
                oneContractAllowed &&
                spreadCents >= this.config.microMakerMinSpreadCents &&
                spreadCents <= this.config.microMakerMaxSpreadCents &&
                mid >= this.config.microMakerMinMidPrice &&
                mid <= this.config.microMakerMaxMidPrice &&
                Math.min(bidDepth, askDepth) >= this.config.microMakerMinSideDollars
              ) {
                // Two-sided by default: rest a bid AND an offer one tick inside
                // the spread. A double fill nets to cash at the spread (the venue
                // nets YES against NO), a single fill carries one contract of
                // inventory, and the maker rebate is earned either way.
                const hash = [...m.id].reduce((n, ch) => ((n * 31 + ch.charCodeAt(0)) >>> 0), 2166136261)
                const sides: ('YES' | 'NO')[] = (this.config.microMakerTwoSided ?? true) ? ['YES', 'NO'] : [hash % 2 === 0 ? 'YES' : 'NO']
                for (const direction of sides) {
                  candidates.push({
                    m, strategy: 'micro-maker', direction,
                    reason: `passive 1-contract ${direction}, spread ${spreadCents.toFixed(1)}c, depth $${Math.min(bidDepth, askDepth).toFixed(0)}`,
                    makerSpreadCents: spreadCents
                  })
                }
              }
            }
          }
        }

        // Weather fair value (Polymarket US temperature markets settle on the
        // same NWS stations as Kalshi's): rest a post-only order on the side
        // the forecast says is cheap, at fair ∓ margin. Maker only — the venue
        // pays makers and charges takers 6%.
        if (this.venue === 'polymarket-us' && (this.config.weatherFairEnabled ?? false) && m.probability !== undefined) {
          const parsed = parseUsTempSlug(m.id)
          if (parsed) {
            const fv = await usWeatherFairValue(parsed, Date.now()).catch(() => null)
            if (fv) {
              const margin = (this.config.weatherFairMarginCents ?? 3) / 100
              const p = m.probability
              if (fv.fair - p >= margin) {
                candidates.push({ m, strategy: 'weather-fair', direction: 'YES', reason: `forecast fair ${fv.fair.toFixed(2)} (mu ${fv.mu.toFixed(1)} sigma ${fv.sigma.toFixed(1)}) vs ${p.toFixed(2)}`, limitYes: fv.fair - margin })
              } else if (p - fv.fair >= margin) {
                candidates.push({ m, strategy: 'weather-fair', direction: 'NO', reason: `forecast fair ${fv.fair.toFixed(2)} (mu ${fv.mu.toFixed(1)} sigma ${fv.sigma.toFixed(1)}) vs ${p.toFixed(2)}`, limitYes: fv.fair + margin })
              }
            }
          }
        }

        if (this.config.fadeEnabled) {
          const p = m.probability
          const longshot = p < this.config.fadeMaxPrice && p > this.config.fadeMinPrice
          const favorite =
            this.config.fadeFavoritesEnabled && p > 1 - this.config.fadeMaxPrice && p < 1 - this.config.fadeMinPrice
          if (longshot || favorite) {
            // Market-quality gates where the venue reports them (Manifold):
            // creator-resolved markets with no liquidity/crowd are exactly
            // where an extreme price means "insiders know", not "mispriced".
            if (m.liquidity !== undefined && m.liquidity < this.config.fadeMinLiquidity) continue
            if (m.uniqueBettorCount !== undefined && m.uniqueBettorCount < this.config.fadeMinBettors) continue
            // Same evidence-driven category filter the Kalshi trader runs:
            // the favorite-longshot bias is absent in crypto/finance/
            // entertainment and INVERTED in weather inside 48h. This venue
            // reports no category, so the classifier reads the question.
            if (this.config.fadeCategoryFilterEnabled) {
              const block = fadeCategoryBlock(m, toClose / 60_000, this.config.fadeCategoryExceptions ?? [])
              if (block) {
                this.emit('miniveto', { venue: this.venue, marketId: m.id, reason: `category:${block}` })
                continue
              }
            }
            candidates.push({
              m,
              strategy: 'fade',
              direction: longshot ? 'NO' : 'YES',
              reason: longshot ? `longshot ${(p * 100).toFixed(1)}%` : `favorite ${(p * 100).toFixed(1)}%`
            })
          }
        }
        if (this.config.bookEnabled && adapter.getOrderBook) {
          const book = await adapter.getOrderBook(m.id).catch(() => undefined)
          if (book) {
            const bidDepth = book.bids.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
            const askDepth = book.asks.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
            if (bidDepth + askDepth >= this.config.bookMinDepth && Math.min(bidDepth, askDepth) >= this.config.bookMinSideDepth) {
              const ratio = bidDepth / askDepth
              if (ratio >= this.config.bookMinRatio) {
                candidates.push({ m, strategy: 'book-imbalance', direction: 'YES', reason: `bid wall ${ratio.toFixed(1)}x` })
              } else if (ratio <= 1 / this.config.bookMinRatio) {
                candidates.push({ m, strategy: 'book-imbalance', direction: 'NO', reason: `ask wall ${(1 / ratio).toFixed(1)}x` })
              }
            }
          }
        }
      }
      result.candidates = candidates.length

      let balance: number | undefined
      let equity: number | undefined
      try {
        const pf = await this.engine.getPortfolio(this.venue)
        balance = pf.account?.balance ?? pf.totalValue
        equity = pf.totalValue
      } catch {
        balance = undefined
        equity = undefined
      }
      // Stake sized off EQUITY (cash + positions), not cash — sizing off a
      // shrinking cash balance makes every successive bet smaller and leaves
      // the account permanently under-deployed. Cash still gates whether the
      // trade is affordable at all.
      const stake = this.stakeFor(equity ?? balance)
      // The ladder scales a proven strategy by a per-strategy multiplier.
      const stakeOf = (strategy: string): number => stake * (this.config.strategySizeMult?.[strategy] ?? 1)

      // Nearest expiries claim the limited slots first — the point of the
      // short-trade setup is capital velocity, not maximum per-trade edge.
      candidates.sort((a, b) => {
        if (a.strategy === 'micro-maker' && b.strategy === 'micro-maker') {
          const spread = (a.makerSpreadCents ?? Infinity) - (b.makerSpreadCents ?? Infinity)
          if (Math.abs(spread) > 0.05) return spread
        }
        return (a.m.closeTime ?? Infinity) - (b.m.closeTime ?? Infinity)
      })

      let entryBlock: string | null = null
      for (const c of candidates) {
        const halted = this.killSwitchBlock()
        if (halted) {
          entryBlock = halted
          break
        }
        if (c.strategy === 'micro-maker') {
          // Breadth is counted in MARKETS: a two-sided quote is one market.
          const makerMarkets = new Set([
            ...this.state.openTrades.filter((x) => x.strategy === 'micro-maker' && (x.closeTime === undefined || x.closeTime > Date.now())).map((x) => x.marketId),
            ...this.state.pendingOrders.filter((x) => x.strategy === 'micro-maker').map((x) => x.marketId)
          ])
          if (!makerMarkets.has(c.m.id) && makerMarkets.size >= this.config.microMakerMaxMarkets) continue
        }
        // Positions whose market already CLOSED carry no further risk — they
        // are only awaiting the venue's settlement, which can take hours.
        // Counting them would let held trades starve new entries.
        const activeNow =
          this.state.openTrades.filter((x) => x.closeTime === undefined || x.closeTime > Date.now()).length +
          this.state.pendingOrders.length
        // Every one of these used to be a bare `break` (see the note below).
        if (activeNow >= this.config.maxOpenPositions) {
          entryBlock = `entries blocked: open positions ${activeNow}/${this.config.maxOpenPositions}`
          break
        }
        if (this.state.openTrades.length >= this.config.maxOpenPositions * 3) {
          entryBlock = `entries blocked: ledger rows ${this.state.openTrades.length}/${this.config.maxOpenPositions * 3}`
          break
        }
        if (this.state.daily.date === nowDate() && this.state.daily.count >= this.config.maxDailyTrades) {
          entryBlock = `entries blocked: daily cap ${this.state.daily.count}/${this.config.maxDailyTrades}`
          break
        }
        // One position per market — except the micro-maker's opposite side.
        const sameSide = (x: { marketId: string; outcome?: string; strategy?: string }): boolean =>
          x.marketId === c.m.id && (c.strategy !== 'micro-maker' || x.strategy !== 'micro-maker' || x.outcome === c.direction)
        if (this.state.openTrades.some(sameSide)) continue
        if (this.state.pendingOrders.some(sameSide)) continue
        if (balance !== undefined && stakeOf(c.strategy) > balance) continue
        // Nearly-resolved guard for the book strategy only — fade's own bands
        // already cap both sides (favorites legitimately buy YES up to 97%).
        if (c.strategy !== 'fade' && c.direction === 'YES' && (c.m.probability ?? 0) > 0.95) continue
        if (c.strategy !== 'fade' && c.direction === 'NO' && (c.m.probability ?? 1) < 0.05) continue

        if (this.config.dryRun) {
          this.emit('miniveto', { venue: this.venue, marketId: c.m.id, reason: 'dry run' })
          continue
        }
        const mode = this.engine.getExecutionMode()
        if (mode === 'live' && !this.config.liveArmed) {
          this.emit('miniveto', { venue: this.venue, marketId: c.m.id, reason: 'LIVE not armed' })
          continue
        }
        // Boot gate: live entries wait until local state has been checked
        // against the venue once this process (crash-restart protection).
        if (mode === 'live' && !this.reconciledLive) {
          this.emit('miniveto', { venue: this.venue, marketId: c.m.id, reason: 'awaiting venue reconcile' })
          continue
        }
        // Correlation cap: sibling strikes on one subject ("Highest temp in
        // NYC" at 90° and 92°) are ONE bet on one underlying. Without this
        // the venue held two NYC and two Miami positions simultaneously.
        if (this.config.maxPerUnderlying > 0) {
          const u = underlyingOf(c.m.id, c.m.question)
          if (u) {
            // Resting maker orders count too. On the maker path (the default
            // here) a filled entry never touches openTrades in the same scan
            // — it goes to pendingOrders — so counting only openTrades left
            // `held` at 0 for every sibling in one pass and rested the whole
            // strike ladder on a single underlying. The Kalshi trader counts
            // both lists for this same cap.
            const held =
              this.state.openTrades.filter((t) => underlyingOf(t.marketId, t.question) === u).length +
              (this.state.pendingOrders ?? []).filter((o) => underlyingOf(o.marketId, o.question) === u).length
            if (held >= this.config.maxPerUnderlying) {
              this.emit('miniveto', { venue: this.venue, marketId: c.m.id, reason: `underlying ${u} full` })
              continue
            }
          }
        }
        try {
          // On venues with a book, bound the entry: 1¢ through the spread on
          // the YES leg (paper walks depth under this limit; live Polymarket
          // US derives its slippage tolerance from it).
          let limit: number | undefined
          if (adapter.getOrderBook) {
            const ob = await adapter.getOrderBook(c.m.id).catch(() => undefined)
            const bid = ob?.bids[0]?.price
            const ask = ob?.asks[0]?.price
            if (c.strategy === 'fade') {
              // Book-quality gate: fade needs a genuine two-sided market —
              // a one-sided or gutter-wide book is unpriceable, and thin
              // walls are cheap to paint.
              if (bid === undefined || ask === undefined) {
                this.emit('miniveto', { venue: this.venue, marketId: c.m.id, reason: 'no two-sided book' })
                continue
              }
              if (ask - bid > this.config.fadeMaxSpreadCents / 100) {
                this.emit('miniveto', { venue: this.venue, marketId: c.m.id, reason: `spread ${((ask - bid) * 100).toFixed(0)}¢ too wide` })
                continue
              }
              const bidDepth = ob!.bids.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
              const askDepth = ob!.asks.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
              if (Math.min(bidDepth, askDepth) < this.config.fadeMinSideDollars) {
                this.emit('miniveto', { venue: this.venue, marketId: c.m.id, reason: `book depth $${Math.min(bidDepth, askDepth).toFixed(0)} too thin` })
                continue
              }
            }
            // MAKER path (live, book venues): rest a post-only limit INSIDE
            // the spread instead of crossing it — on Polymarket US the maker
            // fee is a rebate, so this flips the fee sign entirely.
            if (
              (c.strategy === 'fade' || c.strategy === 'micro-maker' || c.strategy === 'weather-fair') &&
              (c.strategy !== 'fade' || this.config.fadeEntryMode === 'maker') &&
              this.engine.getExecutionMode() === 'live' &&
              adapter.getOpenOrders &&
              bid !== undefined &&
              ask !== undefined &&
              c.m.closeTime !== undefined
            ) {
              const cancelMinutes = c.strategy === 'micro-maker' ? this.config.microMakerCancelMinutes : this.config.exitMinutesBeforeClose + 3
              const expireMs = c.m.closeTime - cancelMinutes * 60_000
              if (expireMs > Date.now() + 120_000) {
                const tick = c.m.tickSize && c.m.tickSize > 0 ? c.m.tickSize : 0.01
                // Improve our side by one tick without crossing (book is YES-side).
                let restYes =
                  c.direction === 'YES'
                    ? Math.min(ask - tick, bid + tick)
                    : Math.max(bid + tick, ask - tick)
                // A fair-value candidate never pays more (or sells for less)
                // than its limit; it still rests inside the spread when that
                // is better than the limit.
                if (c.limitYes !== undefined) restYes = c.direction === 'YES' ? Math.min(c.limitYes, ask - tick) : Math.max(c.limitYes, bid + tick)
                // Two-sided maker: on a 2-tick spread both improvements land on
                // the same price and our offer would cross our own bid (the
                // venue rejects the post-only). Keep the offer strictly above
                // the bid by joining the touch instead.
                const ownOther = this.state.pendingOrders.find((p) => p.marketId === c.m.id && p.strategy === 'micro-maker' && p.outcome !== c.direction)
                if (c.strategy === 'micro-maker' && ownOther) {
                  if (c.direction === 'NO' && restYes <= ownOther.yesPrice + 1e-9) restYes = ownOther.yesPrice + tick
                  if (c.direction === 'YES' && restYes >= ownOther.yesPrice - 1e-9) restYes = ownOther.yesPrice - tick
                }
                const snapped = Math.round(restYes / tick) * tick
                const legCost = c.direction === 'YES' ? snapped : 1 - snapped
                if (snapped > 0 && snapped < 1 && legCost > 0.01) {
                  const res = await this.engine.placeOrder({
                    venue: this.venue,
                    marketId: c.m.id,
                    outcome: c.direction,
                    amount: c.strategy === 'micro-maker' ? legCost : stakeOf(c.strategy),
                    contracts: c.strategy === 'micro-maker' ? 1 : undefined,
                    limitPrice: snapped,
                    timeInForce: 'good_till_canceled',
                    postOnly: true,
                    expirationTs: Math.floor(expireMs / 1000),
                    feeRate: c.m.feeRate,
                    ref: `mini:${c.strategy}:maker:${c.m.id}`,
                    marketQuestion: c.m.question
                  })
                  if (res.orderId) {
                    this.state.pendingOrders.push({
                      orderId: res.orderId,
                      marketId: c.m.id,
                      question: c.m.question,
                      strategy: c.strategy,
                      outcome: c.direction,
                      yesPrice: snapped,
                      count: Math.max(0, (c.strategy === 'micro-maker' ? 1 : stakeOf(c.strategy) / Math.max(0.01, legCost)) - res.shares),
                      promoted: 0,
                      createdAt: Date.now(),
                      closeTime: c.m.closeTime,
                      expirationTs: Math.floor(expireMs / 1000)
                    })
                    this.logResearch('resting', { marketId: c.m.id, strategy: c.strategy, outcome: c.direction, yesPrice: snapped, legPrice: legCost, closeTime: c.m.closeTime, reason: c.reason })
                    if (c.strategy === 'micro-maker') {
                      const shadowSignal = {
                        id: `poly-maker:${c.m.id}:${Date.now()}`, strategy: 'book-imbalance',
                        marketId: c.m.id, question: c.m.question, outcome: c.direction,
                        price: (bid + ask) / 2, closeTime: c.m.closeTime, score: 50, confidence: 0.5,
                        details: { entryMode:'maker', experiment:'polymarket-us-micro-maker', spreadCents:(ask-bid)*100, legCost },
                        feeRate: c.m.feeRate, executed: true
                      } as AutoSignal
                      void this.intelligence.reviewDefault({
                        signal: shadowSignal, market: c.m, book: ob, balance,
                        openPositions: activeNow, dailyTradesLeft: Math.max(0,this.config.maxDailyTrades-this.state.daily.count),
                        stake: legCost, venue:this.venue
                      }).catch(() => undefined)
                    }
                    this.emit('miniresting', {
                      venue: this.venue,
                      marketId: c.m.id,
                      outcome: c.direction,
                      legCost: Math.round(legCost * 100) / 100,
                      question: c.m.question.slice(0, 60)
                    })
                    continue
                  }
                }
              }
              // Maker unavailable (expiry too near / degenerate book) — fall
              // through to the taker path below.
            }
            if (c.strategy === 'micro-maker' || c.strategy === 'weather-fair') continue
            if (c.direction === 'YES' && ask !== undefined) limit = Math.min(0.99, ask + 0.01)
            else if (c.direction === 'NO' && bid !== undefined) limit = Math.max(0.01, bid - 0.01)
            // Snap to the venue tick grid (Polymarket US has 0.001-tick
            // markets; off-grid limits bounce).
            if (limit !== undefined && c.m.tickSize && c.m.tickSize > 0) {
              limit = Math.round(limit / c.m.tickSize) * c.m.tickSize
            }
          }
          const res = await this.engine.placeOrder({
            venue: this.venue,
            marketId: c.m.id,
            outcome: c.direction,
            amount: stakeOf(c.strategy),
            limitPrice: limit,
            feeRate: c.m.feeRate,
            ref: `mini:${c.strategy}:${c.m.id}`,
            marketQuestion: c.m.question
          })
          if (res.status === 'open' || res.shares <= 0) {
            await adapter.cancelOrder(res.orderId, c.m.id).catch(() => undefined)
            continue
          }
          // CLV/markout reference: the market's mid expressed in OUR leg's terms, falling back to the
          // fill when the venue gives us no probability. Without this the mini's fast meter is dead code.
          const entrySideMid =
            c.m.probability !== undefined && Number.isFinite(c.m.probability)
              ? c.direction === 'NO'
                ? 1 - c.m.probability
                : c.m.probability
              : res.avgPrice
          this.state.openTrades.push({
            id: `mini:${c.strategy}:${c.m.id}`,
            marketId: c.m.id,
            question: c.m.question,
            outcome: c.direction,
            shares: res.shares,
            amount: res.amount + (this.venue === 'polymarket-us' && this.engine.getExecutionMode() === 'live' ? res.fee ?? 0 : 0),
            entryPrice: res.avgPrice + (this.venue === 'polymarket-us' && this.engine.getExecutionMode() === 'live' ? (res.fee ?? 0) / res.shares : 0),
            strategy: c.strategy,
            createdAt: Date.now(),
            closeTime: c.m.closeTime,
            entrySideMid: Math.round(entrySideMid * 10000) / 10000
          })
          this.state.daily.count++
          this.state.stats.executed++
          result.executed++
          this.emit('miniopened', {
            venue: this.venue,
            strategy: c.strategy,
            marketId: c.m.id,
            outcome: c.direction,
            amount: res.amount,
            question: c.m.question.slice(0, 60)
          })
        } catch (err) {
          result.errors.push(`execute ${c.m.id}: ${fmtErr(err)}`)
        }
      }

      // A blocked entry loop used to leave no trace at all: on 2026-09-08 an
      // arm the ladder had already disabled spent 19 of the 20 daily slots by
      // 02:31Z and every live arm was refused for the next 13 hours in total
      // silence. Edge-triggered on purpose — the scan runs every 60 s, and an
      // unconditional line is the mistake the cancel path already had to undo.
      if (entryBlock) result.errors.push(entryBlock)
      if (entryBlock !== this.lastEntryBlock) console.log(`[mini ${this.venue}] ${entryBlock ?? 'entries unblocked'}`)
      this.lastEntryBlock = entryBlock
      // Never cap coverage silently: if the book budget bit, say how many markets went unexamined.
      if (bookSkipped > 0) {
        console.log(`[mini ${this.venue}] micro-maker book budget spent (${MICRO_MAKER_BOOK_BUDGET}); ${bookSkipped} in-band market(s) not examined this scan`)
      }
      this.state.stats.scans++
      this.state.lastScanMs = Date.now() - started
      this.state.lastError =
        result.errors[0] ?? venueHealth ?? stuckSettlements(this.state.openTrades, Date.now()).message
      this.persist()
      this.emit('miniscan', { venue: this.venue, scanned: result.scanned, candidates: result.candidates, executed: result.executed })
    } catch (err) {
      const msg = fmtErr(err)
      result.errors.push(msg)
      this.state.lastError = msg
      this.persist()
    } finally {
      this.busy = false
    }
    return result
  }

  /** Is this strategy switched on right now? The ladder flips these flags; unknown strategies count as on. */
  private strategyOn(strategy: string): boolean {
    const flag: Record<string, keyof MiniAutoConfig> = { 'micro-maker': 'microMakerEnabled', fade: 'fadeEnabled', 'book-imbalance': 'bookEnabled', 'weather-fair': 'weatherFairEnabled' }
    const key = flag[strategy]
    return key === undefined ? true : Boolean(this.config[key] ?? true)
  }

  /** Reconcile resting maker orders (live): promote fills, drop expired. */
  private async managePendingOrders(result: MiniScanResult): Promise<void> {
    if (this.state.pendingOrders.length === 0) return
    const adapter = this.engine.getAdapter(this.venue)
    if (!adapter?.getOpenOrders) return
    const finalSweep = this.engine.getExecutionMode() !== 'live'
    let open
    try {
      open = await adapter.getOpenOrders()
    } catch (err) {
      result.errors.push(`pending orders: ${fmtErr(err)}`)
      return
    }
    const byId = new Map(open.map((o) => [o.orderId, o]))
    let fills: import('../../shared/types').VenueFill[] = []
    if (adapter.getFills) {
      try {
        fills = await adapter.getFills(100)
      } catch (err) {
        // Without the fills feed the gone-branch would delete filled orders
        // as expired — keep state and retry next tick.
        result.errors.push(`pending fills: ${fmtErr(err)}`)
        return
      }
    }
    for (const p of [...this.state.pendingOrders]) {
      const legOf = (yes: number): number => (p.outcome === 'NO' ? 1 - yes : yes)
      const o = byId.get(p.orderId)
      if (o && !this.strategyOn(p.strategy)) {
        // A stopped strategy must not keep working the book (2026-09-07: seven
        // micro-maker rests outlived the ladder's stop by hours). Cancel; the
        // row stays so the gone-branch reconciles any fill that lands first.
        // The venue can refuse (two SMU rests stayed ORDER_STATE_NEW through
        // 2,584 silent retries), so ask at most every 30 minutes and log why.
        const rec = p as typeof p & { cancelAskedAt?: number; cancelError?: string }
        if (!rec.cancelAskedAt || Date.now() - rec.cancelAskedAt > 30 * 60_000) {
          rec.cancelAskedAt = Date.now()
          try {
            await adapter.cancelOrder(p.orderId, p.marketId)
            rec.cancelError = undefined
            this.logResearch('cancelled-strategy-off', { marketId: p.marketId, strategy: p.strategy, outcome: p.outcome, yesPrice: p.yesPrice, createdAt: p.createdAt })
          } catch (err) {
            rec.cancelError = fmtErr(err).slice(0, 160)
            console.log(`[mini ${this.venue}] cancel refused for ${p.orderId} on ${p.marketId} (${p.strategy} is off): ${rec.cancelError}`)
            this.logResearch('cancel-refused', { marketId: p.marketId, strategy: p.strategy, orderId: p.orderId, error: rec.cancelError })
          }
        }
        // Promote a fill that landed before/around the cancel (audit B-17): a stopped arm's fill is still real inventory.
        const filledWhileOff = o.fillCount - p.promoted
        if (filledWhileOff > 0.005) {
          this.promotePendingFill(p, filledWhileOff, legOf(p.yesPrice))
          p.promoted = o.fillCount
        }
        continue
      }
      if (o) {
        const newly = o.fillCount - p.promoted
        if (newly > 0.005) {
          this.promotePendingFill(p, newly, legOf(p.yesPrice))
          p.promoted = o.fillCount
        }
        if (Date.now() / 1000 > p.expirationTs + 120) {
          // Cancel, but leave the row: a fill can land between the open-orders snapshot and this cancel, and the
          // gone-branch promotes it from the venue's own order/fills before removing the row (audit B-16; the Kalshi
          // trader has ordered it this way since round 63).
          await adapter.cancelOrder(p.orderId, p.marketId).catch(() => undefined)
        }
        continue
      }
      // Gone from the open list. Ask the venue for THIS order first: the
      // activities feed carries no order id, and matching by slug+time promoted
      // every cleared trade on the market (including manual ones) as this
      // order's fill. GET /v1/order/{id} carries cumQuantity and the YES-leg
      // average; a NO leg cost 1 - that.
      let total: number
      let legPrice: number | undefined
      const venueOrder = adapter.getOrder ? await adapter.getOrder(p.orderId).catch(() => undefined) : undefined
      // Polymarket US accepts a maker order ID before its query/read model indexes
      // that order. A transient miss used to be labeled expired and the same six
      // orders were resubmitted every minute. Preserve the local record for five
      // minutes; fills are still detected from the activities feed.
      if (!venueOrder && Date.now() - p.createdAt < 5 * 60_000) continue
      if (venueOrder) {
        total = venueOrder.fillCount
        legPrice = venueOrder.avgYes !== undefined ? legOf(venueOrder.avgYes) : undefined
      } else {
        // This order's fills only: by order id where the feed carries one, else the same leg and direction.
        // Market-and-time alone promoted the other side of a two-sided rest, or a manual trade, as this
        // order's fill (audit 2026-09-19, B-26). A fill's price is already the traded leg's price.
        const mine = fills.filter((f) => f.marketId === p.marketId && f.timestamp >= p.createdAt - 10_000 && f.outcome === p.outcome && f.side === 'buy' && (!f.orderId || f.orderId === p.orderId))
        total = mine.reduce((s, f) => s + f.shares, 0)
        const vwap = mine.reduce((s, f) => s + f.price * f.shares, 0) / Math.max(total, 0.01)
        legPrice = vwap > 0 && vwap < 1 ? vwap : undefined
      }
      const newly = total - p.promoted
      if (newly > 0.005) {
        this.promotePendingFill(p, newly, legPrice !== undefined && legPrice > 0 && legPrice < 1 ? legPrice : legOf(p.yesPrice))
      } else if (total <= 0.005) {
        this.logResearch('expired-unfilled', { marketId: p.marketId, strategy: p.strategy, outcome: p.outcome, yesPrice: p.yesPrice, createdAt: p.createdAt })
        this.emit('miniexpired', { venue: this.venue, marketId: p.marketId, question: (p.question ?? '').slice(0, 60) })
      }
      this.state.pendingOrders = this.state.pendingOrders.filter((x) => x.orderId !== p.orderId)
    }
    if (finalSweep) {
      for (const p of [...this.state.pendingOrders]) {
        await adapter.cancelOrder(p.orderId, p.marketId).catch(() => undefined)
      }
      this.state.pendingOrders = []
    }
    this.persist()
  }

  /** Add (or extend) an open trade from a maker fill (price = traded leg's price). */
  private promotePendingFill(p: AutoPendingOrder, shares: number, legPrice: number): void {
    this.logResearch('fill', { marketId: p.marketId, strategy: p.strategy, outcome: p.outcome, shares, legPrice, yesPrice: p.yesPrice, secondsRested: Math.round((Date.now() - p.createdAt) / 1000) })
    if (p.promoted === 0) {
      if (this.state.daily.date === nowDate()) this.state.daily.count++
      else this.state.daily = { date: nowDate(), count: 1 }
      this.state.stats.executed++
    }
    const existing = this.state.openTrades.find((t) => t.marketId === p.marketId && t.outcome === p.outcome)
    if (existing) {
      const total = existing.shares + shares
      existing.entryPrice = (existing.entryPrice * existing.shares + legPrice * shares) / total
      existing.shares = total
      existing.amount += shares * legPrice
      return
    }
    this.state.openTrades.push({
      id: `mini:${p.strategy}:maker:${p.marketId}:${Date.now()}`,
      marketId: p.marketId,
      question: p.question,
      outcome: p.outcome,
      shares,
      amount: shares * legPrice,
      entryPrice: legPrice,
      strategy: p.strategy,
      createdAt: Date.now(),
      closeTime: p.closeTime,
      // No book in hand at promotion - the fill price is the reference. A maker fill sits at or inside the
      // mid, so this UNDERSTATES the arm's CLV rather than flattering it.
      entrySideMid: legPrice
    })
    this.emit('miniopened', {
      venue: this.venue,
      strategy: p.strategy,
      marketId: p.marketId,
      outcome: p.outcome,
      amount: Math.round(shares * legPrice * 100) / 100,
      question: (p.question ?? '').slice(0, 60)
    })
  }

  private async manageExits(result: MiniScanResult): Promise<void> {
    if (this.config.dryRun) return
    const adapter = this.engine.getAdapter(this.venue)
    if (!adapter || this.state.openTrades.length === 0) return

    for (const t of [...this.state.openTrades]) {
      // Fades hold to settlement unless fadeExitEnabled — see the config note.
      const isHoldToSettle = (t.strategy === 'fade' && !this.config.fadeExitEnabled) || t.strategy === 'micro-maker' || t.strategy === 'weather-fair'
      const quote = await adapter.getPrice(t.marketId, t.outcome).catch(() => undefined)
      // Every trade gets its side mid refreshed each pass - hold-to-settle included - so the ledger carries
      // a pre-settlement freeze for CLV and a 5-minute markout. Same meter the Kalshi trader has had since
      // 2026-09-06; the mini had the recordExit block for it but never any data to put in it.
      if (quote && quote.price > 0) {
        t.lastSideMid = Math.round(quote.price * 10000) / 10000
        t.lastSideMidAt = Date.now()
        if (t.markout5mCents === undefined && t.entrySideMid !== undefined && Date.now() - t.createdAt >= 5 * 60_000) {
          t.markout5mCents = Math.round((quote.price - t.entrySideMid) * 100 * 100) / 100
        }
      }
      let closed = false
      if (quote && !isHoldToSettle) {
        const value = t.shares * quote.price
        const pnlPct = t.amount > 0 ? ((value - t.amount) / t.amount) * 100 : 0
        let reason: string | null = null
        if (this.config.takeProfitPct > 0 && pnlPct >= this.config.takeProfitPct) reason = `take-profit +${pnlPct.toFixed(1)}%`
        else if (this.config.stopLossPct > 0 && pnlPct <= -this.config.stopLossPct) reason = `stop-loss ${pnlPct.toFixed(1)}%`
        else if (t.closeTime && Date.now() >= t.closeTime - this.config.exitMinutesBeforeClose * 60_000) reason = 'pre-close exit'
        else if (this.config.maxHoldMinutes > 0 && Date.now() - t.createdAt >= this.config.maxHoldMinutes * 60_000) reason = 'max hold'
        else if (t.closeTime && t.closeTime - Date.now() > this.config.maxHoursToClose * 3600_000 * 2) {
          // Position expires FAR beyond the configured window (2× buffer so a
          // modest window change doesn't dump legitimate holds) — a short-trade
          // bot must not sit in months-out markets, and stale holds block the
          // maxOpenPositions slots for everything else.
          reason = 'out of window'
        }
        if (reason) {
          try {
            // Sell only this trade's size — never a coexisting manual holding.
            const res = await this.engine.sellPosition({ venue: this.venue, marketId: t.marketId, outcome: t.outcome, shares: t.shares, ref: `mini:${t.strategy}` })
            if (res.shares <= 0) {
              // Nothing filled — the position is still open on the venue.
              // Keep it in the ledger and retry next tick.
              result.errors.push(`exit ${t.marketId}: no fill`)
            } else if (res.shares < t.shares - 1e-6) {
              const pnl = miniExitPnl(t, res)
              this.recordExit(pnl, t.strategy, { ...t, shares: res.shares, amount: t.amount * res.shares / t.shares })
              t.amount *= 1 - res.shares / t.shares
              t.shares -= res.shares
              this.emit('miniexited', { venue: this.venue, marketId: t.marketId, outcome: t.outcome, reason: `${reason} (partial)`, realized: Math.round(pnl * 100) / 100 })
            } else {
              const pnl = miniExitPnl(t, res)
              // Remove before booking (audit 2026-09-19, B-03): recordExit persists.
              this.removeTrade(t.id)
              this.recordExit(pnl, t.strategy, t)
              closed = true
              this.emit('miniexited', { venue: this.venue, marketId: t.marketId, outcome: t.outcome, reason, realized: Math.round(pnl * 100) / 100 })
            }
          } catch (err) {
            const msg = fmtErr(err)
            if (/no (paper )?position/i.test(msg)) {
              // Closed manually from the panel (or settled venue-side) — the
              // broker no longer holds it, so drop the stale ledger entry.
              this.removeTrade(t.id)
              closed = true
            } else {
              result.errors.push(`exit ${t.marketId}: ${msg}`)
            }
          }
        }
      }
      if (closed) continue
      // settlement check (paper resolves from the market record)
      //
      // The cached close alone is not enough to gate this. A position the venue has stopped quoting - or
      // quotes pinned at 0/1 - has almost certainly resolved whatever our copy says, and the market fetch
      // that would reveal a corrected close lives inside this block, so a close time wrong in the LATE
      // direction is otherwise unrecoverable. On 2026-09-10 fourteen NFL prop fades carried a close of
      // 2026-09-24 against a venue endDate of 2026-09-09T23:49Z on markets the venue had already resolved
      // in our favour; they held fourteen of the venue's 48 slots while entries were blocked at 48/48.
      // Same net autoTrader has had since round 46, throttled per trade.
      const pastClose = t.closeTime !== undefined && Date.now() > t.closeTime + SETTLE_GRACE_MS
      const probeDue = settlementProbeDue(quote?.price, this.settleProbeAt.get(t.id), Date.now())
      if (t.closeTime && (pastClose || probeDue)) {
        if (!pastClose) this.settleProbeAt.set(t.id, Date.now())
        const mk = await adapter.getMarket(t.marketId).catch(() => undefined)
        // Zombie guard: a market the venue no longer serves can NEVER settle,
        // so the position would be held forever. THREE cases must be told
        // apart, and only the third may be dropped:
        //   1. market fetches, no resolution yet — normal, keep waiting
        //      (Kalshi weather resolves off the next morning's report, 7-10h)
        //   2. market unfetchable AND the whole venue is down/stale — this is
        //      an OUTAGE. Everything 404s during maintenance, so dropping here
        //      would discard positions minutes before the venue returns and
        //      settles them. Polymarket US went into maintenance on
        //      2026-09-01 and this exact case would have binned three live
        //      positions. Hold them.
        //   3. market unfetchable while the venue is otherwise SERVING a fresh
        //      catalog — the market really is delisted. Drop it.
        // manageExits runs BEFORE this scan fetches markets, so use the
        // PREVIOUS scan's verdict — during an outage that is already set.
        const venueServingFreshCatalog = this.state.venueHealth === undefined
        if (!mk && venueServingFreshCatalog && Date.now() > t.closeTime + STALE_DROP_MS) {
          this.removeTrade(t.id)
          result.errors.push(`dropped ${t.marketId}: market no longer served by the venue ${Math.round((Date.now() - t.closeTime) / 3600_000)}h past close`)
          this.emit('miniexited', { venue: this.venue, marketId: t.marketId, outcome: t.outcome, reason: 'market delisted (unsettleable)', realized: 0 })
          continue
        }
        // The stored close can be wrong (see refreshedCloseTime): adopt the
        // venue's later one and wait, instead of treating the row as overdue
        // forever. Heals rows opened before a close-derivation fix landed.
        const fresher = mk ? refreshedCloseTime(t.closeTime, mk.closeTime) : undefined
        if (fresher !== undefined) {
          t.closeTime = fresher
          this.persist()
          continue
        }
        // ...and earlier, too. The venue is the authority in both directions: sports props close when the
        // game starts, and our copy can be a placeholder weeks out. Unlike the later case there is nothing
        // to wait for, so this falls through to the resolution check in the same pass.
        if (mk?.closeTime !== undefined && Number.isFinite(mk.closeTime) && mk.closeTime < t.closeTime) {
          t.closeTime = mk.closeTime
          this.persist()
        }
        const resolution = mk?.resolution
        // The venue answered, and the answer was "not yet". Stamp it so the ledger audit can tell a market
        // whose creator has not resolved it from a settlement path of ours that has broken.
        if (mk && resolution === undefined) {
          t.venueUnresolvedAt = Date.now()
          this.persist()
        }
        // Manifold binaries resolve MKT (at a probability) or CANCEL (refund)
        // 8.4% of the time (264 of 3,141 captured). YES/NO-only settlement
        // left those open forever, and the zombie guard never fires because
        // the market still fetches. PaperBroker.settle takes a PRICE, so
        // CANCEL settles at cost (P&L = -fee, as the venue refunds the stake)
        // and MKT at the resolution value on our leg. A MKT with no
        // resolutionProbability keeps waiting: never guess a settlement.
        const resUpper = typeof resolution === 'string' ? resolution.toUpperCase() : undefined
        if (this.venue === 'polymarket-us' && (resUpper === 'CANCEL' || resUpper === 'MKT')) {
          const p = mk?.resolutionProbability
          const winPrice = resUpper === 'CANCEL' ? t.entryPrice : t.outcome === 'YES' ? p : p === undefined ? undefined : 1 - p
          if (winPrice !== undefined && Number.isFinite(winPrice)) {
            const reason = resUpper === 'CANCEL' ? 'settled (cancelled - refund)' : `settled (MKT @ ${winPrice.toFixed(3)})`
            if (this.engine.getExecutionMode() === 'paper') {
              const rec = this.engine.settlePaperPosition(this.venue, t.marketId, t.outcome, winPrice)
              if (rec) {
                this.removeTrade(t.id)
                this.recordExit(rec.realizedPnl ?? 0, t.strategy, t)
                this.emit('miniexited', { venue: this.venue, marketId: t.marketId, outcome: t.outcome, reason, realized: Math.round((rec.realizedPnl ?? 0) * 100) / 100 })
              } else {
                this.removeTrade(t.id)
              }
            } else {
              const realized = (winPrice - t.entryPrice) * t.shares
              this.removeTrade(t.id)
              this.recordExit(realized, t.strategy, t)
              this.emit('miniexited', { venue: this.venue, marketId: t.marketId, outcome: t.outcome, reason, realized: Math.round(realized * 100) / 100 })
            }
          }
          continue
        }
        if (resolution !== undefined && (resolution === 'YES' || resolution === 'NO' || resolution === 'yes' || resolution === 'no')) {
          const yesWon = resolution === 'YES' || resolution === 'yes'
          const win = t.outcome === 'YES' ? (yesWon ? 1 : 0) : yesWon ? 0 : 1
          if (this.engine.getExecutionMode() === 'paper') {
            const rec = this.engine.settlePaperPosition(this.venue, t.marketId, t.outcome, win)
            if (rec) {
              this.removeTrade(t.id)
              this.recordExit(rec.realizedPnl ?? 0, t.strategy, t)
              this.emit('miniexited', { venue: this.venue, marketId: t.marketId, outcome: t.outcome, reason: 'settled', realized: Math.round((rec.realizedPnl ?? 0) * 100) / 100 })
            } else {
              // No paper position left (closed manually before settlement).
              this.removeTrade(t.id)
            }
          } else {
            // Live settles venue-side; record the estimated P&L instead of
            // silently deleting the trade (which biased the stats toward
            // survivors that exited early).
            const realized = (win - t.entryPrice) * t.shares
            this.removeTrade(t.id)
            this.recordExit(realized, t.strategy, t)
            this.emit('miniexited', { venue: this.venue, marketId: t.marketId, outcome: t.outcome, reason: 'settled', realized: Math.round(realized * 100) / 100 })
          }
        }
      }
    }
  }

  /**
   * Venue-wide daily loss brake. The Kalshi trader has had a kill switch since
   * the start; the mini had no loss-based brake of any kind, and the ladder is
   * a poor substitute — it runs hourly, judges only CLOSED trades while three
   * of four arms hold to settlement, and never closes a position. Halts new
   * entries only; exits and settlement keep running and it clears at 00:00Z.
   * 0 disables, which is where Manifold (play money) stays.
   */
  private killSwitchBlock(): string | null {
    const reason = dailyBrakeBlock(this.config.maxDailyLossDollars ?? 0, this.state.dailyPnl, nowDate())
    if (!reason) return null
    if (this.state.dailyPnl && !this.state.dailyPnl.tripped) {
      this.state.dailyPnl.tripped = true
      this.persist()
    }
    return reason
  }

  private recordExit(pnl: number | undefined, strategy = 'unknown', trade?: AutoOpenTrade): void {
    if (pnl === undefined || !Number.isFinite(pnl)) return
    this.logResearch('closed', {
      strategy, pnl,
      marketId: trade?.marketId,
      outcome: trade?.outcome,
      shares: trade?.shares,
      entryPrice: trade?.entryPrice,
      amount: trade?.amount,
      createdAt: trade?.createdAt,
      closeTime: trade?.closeTime
    })
    const p = this.state.perf
    p.trades++
    p.realizedPnl += pnl
    if (pnl > 0) p.wins++
    else if (pnl < 0) p.losses++
    // Per-strategy split so "which strategies work" is answerable per venue.
    const by = (this.state.perfByStrategy ??= {})
    const q = (by[strategy] ??= { trades: 0, wins: 0, losses: 0, realizedPnl: 0 })
    q.trades++
    q.realizedPnl += pnl
    if (pnl > 0) q.wins++
    else if (pnl < 0) q.losses++
    // Same fast meter as the Kalshi trader; the mini records no side mid at
    // entry yet (see the 2026-09-09 audit), so this only fires once it does.
    if (trade?.entrySideMid !== undefined && trade?.lastSideMid !== undefined) {
      const clv = (trade.lastSideMid - trade.entrySideMid) * 100
      q.clvSum = (q.clvSum ?? 0) + clv
      q.clvN = (q.clvN ?? 0) + 1
      q.clvSq = (q.clvSq ?? 0) + clv * clv
      q.clvSqN = (q.clvSqN ?? 0) + 1
    }
    if (trade?.markout5mCents !== undefined) {
      q.markoutSum = (q.markoutSum ?? 0) + trade.markout5mCents
      q.markoutN = (q.markoutN ?? 0) + 1
      q.markoutSq = (q.markoutSq ?? 0) + trade.markout5mCents * trade.markout5mCents
      q.markoutSqN = (q.markoutSqN ?? 0) + 1
    } else if (trade) {
      q.markoutMissingN = (q.markoutMissingN ?? 0) + 1
    }
    const day = nowDate()
    if (!this.state.dailyPnl || this.state.dailyPnl.date !== day) this.state.dailyPnl = { date: day, realized: 0, tripped: false }
    this.state.dailyPnl.realized += pnl
    this.persist()
  }

  private removeTrade(id: string): void {
    this.settleProbeAt.delete(id)
    this.state.openTrades = this.state.openTrades.filter((t) => t.id !== id)
  }

  private persist(): void {
    // Writing a stale version here used to reset configVersion to 1 on every
    // save, making the migrations re-run on each launch.
    this.store.update({ config: this.config, state: this.state, configVersion: CONFIG_VERSION })
  }

  private restartTimer(): void {
    this.stop()
    if (this.config.enabled && this.config.autoPoll) {
      this.timer = setInterval(() => {
        this.tick().catch((err) => console.warn(`[miniAuto ${this.venue}] tick error:`, err))
      }, Math.max(15, this.config.pollIntervalSeconds) * 1000)
    }
  }

  private logResearch(type: string, payload: Record<string, unknown>): void {
    if (this.venue !== 'polymarket-us') return
    try {
      // Every row states the execution mode it was produced under. Without it a PAPER session's closes enter a
      // LIVE arm's ladder evidence and cannot be told apart afterwards - the mode switch is global, and the
      // ladder's miniRows filtered on type, strategy and timestamp only (audit B-48). Written here, at the one
      // chokepoint all six call sites pass through, so no future row can forget it. Rows already on file carry
      // no mode and are treated as unknown by the ladder rather than silently counted.
      appendFileSync(this.researchLogPath, JSON.stringify({ ts: new Date().toISOString(), type, mode: this.engine.getExecutionMode(), ...payload }) + '\n', 'utf8')
    } catch {
      // Research telemetry must never interrupt order management.
    }
  }

  private emit(type: string, payload: unknown): void {
    this.onEvent?.(type, payload)
  }
}

/**
 * The mini's venue-wide daily loss brake, as a pure decision. Returns the
 * refusal reason when the day's realized loss has reached the limit, else
 * null. `limit` is a positive dollar amount; 0 (or less) disables it, which is
 * where Manifold stays because its currency is play money.
 *
 * Added after the 2026-09-09 audit found the mini had no loss-based brake at
 * all: the daily trade cap and the position cap bound COUNTS, never dollars,
 * and the ladder underneath runs hourly, judges only closed trades while three
 * of four arms hold to settlement, and never closes a position.
 */
export function dailyBrakeBlock(
  limit: number,
  dailyPnl: { date: string; realized: number; tripped: boolean } | undefined,
  today: string
): string | null {
  if (!(limit > 0)) return null
  if (!dailyPnl || dailyPnl.date !== today) return null
  if (!Number.isFinite(dailyPnl.realized)) return null
  if (dailyPnl.realized > -limit) return null
  return `entries halted: daily realized ${dailyPnl.realized.toFixed(2)} hit the -${limit} brake (clears at 00:00Z)`
}
