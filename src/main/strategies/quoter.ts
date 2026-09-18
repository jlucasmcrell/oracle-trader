/**
 * Thin-market quoter for Kalshi daily temperature brackets (fee-free series).
 *
 * What it does: rests one post-only contract one cent inside each side of a
 * thin book and holds fills to settlement. What it is NOT: an
 * Avellaneda-Stoikov market maker (an earlier header claimed one). Fair value
 * here is the book midpoint and the only "skew" is a one-cent lean per held
 * contract; the file says so because the label was hiding the mechanism.
 *
 * Why it lost money (2026-09-02..05, venue settlements, not the app ledger):
 * 653 maker fills at −2.6c per contract, bids hit at −6.2c, fills clustered
 * 19–21 UTC while the day's high was being realised. A weather bracket is
 * decided by an observable running extreme, so late-day flow is informed and a
 * passive quote is its counterparty of choice. Defenses:
 *  - venue-fed fill attribution by order id, run BEFORE quotes are cancelled
 *    on disarm as well as on every live tick (the old reconcile saw only
 *    still-resting orders: 33 of 653 fills);
 *  - a failed cancel keeps the quote tracked (the orphan sweep is the backstop);
 *  - shard-aware collateral (weather settles on exchange index 0);
 *  - ratchet gate on observations bound to the contract's measurement day in
 *    the station's time zone (see weatherDay.ts): no quote on a bracket the
 *    banked running high/low has decided or is within nearF of deciding;
 *  - time-of-day blackout around the hours the extreme forms;
 *  - exchange-pause hold;
 *  - a shadow meter that logs the quotes the live path WOULD rest, tagged
 *    'allowed' (passes every gate) or 'blocked', re-applies the gates each
 *    tick exactly as the live path would (a quote whose gate closes is
 *    pulled, not left to collect a fill), infers fills from timestamped trade
 *    prints through the quote price (book crossing only as a fallback), and
 *    records the mid at ≈15 minutes after the fill with its actual timing.
 *    It is a diagnostic; scripts/quoter-shadow-gate.mjs grades it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VenueAdapter } from '../../shared/venue'
import type { MarketTrade, OrderBook, VenueFill } from '../../shared/types'
import { bankObservations, eventDayStatus, parseEventDate, stationCode, stationTimeZone } from './weatherDay'
import { bracketFairValue, fetchHourlyForecast, forecastSigma, quoteAroundFair, remainingExtremes } from './weatherForecast'
import { FLOW_DEFAULTS, FlowMonitor, flowVerdict } from './flowMonitor'

export interface QuoterConfig {
  quoterEnabled: boolean
  quoterCategory: string
  quoterSeriesRegex: string
  quoterMinSpreadCents: number
  quoterMaxSpreadCents: number
  quoterMaxTouchDepth: number
  quoterMaxContracts: number
  quoterMaxMarkets: number
  /** New/resting quote collateral budget. */
  quoterMaxExposure: number
  /** Filled weather positions + resting quotes may not exceed this acquisition-cost cap. */
  quoterMaxPositionExposure: number
  quoterMaxInventory: number
  quoterCancelMinutes: number
  quoterMinHoursToClose: number
  quoterMaxHoursToClose: number
  amountPerTrade: number
  /** Log would-quotes and score them against later prints while not quoting (default true). */
  quoterShadowEnabled?: boolean
  /** Skip brackets the banked running extreme has decided or nearly decided (default true). */
  quoterRatchetGate?: boolean
  /** Only quote cities whose minute temperature index is served (default true). */
  quoterRequireIndex?: boolean
  /** Skip the UTC hours in which the daily extreme forms (default true). */
  quoterBlackoutEnabled?: boolean
  /** Degrees F the extreme must clear a boundary by to count as decided (default 2). */
  quoterGuardF?: number
  /** Degrees F short of a boundary at which a bracket counts as "being decided" (default 1.5). */
  quoterNearF?: number
  /** Quote around the NWS-forecast fair value instead of the midpoint (default true). */
  quoterFairValueEnabled?: boolean
  /** Half-spread in cents around the fair value (default 2). */
  quoterFairMarginCents?: number
  /** Pull quotes while unusually large or one-sided taker flow hits the market (default true). */
  quoterFlowGate?: boolean
  /** Shrink a resting quote in place (queue-preserving /decrease) on a small adverse
   *  fair-value move instead of waiting for the 3c reprice. Default false = log the
   *  would-be decrease and place NO order; the only call made is a rate-limited
   *  queue-position GET (at most one per QUEUE_PROBE_MIN_INTERVAL_MS). */
  quoterDecreaseEnabled?: boolean
}

export interface QuoterStatus {
  enabled: boolean
  active: boolean
  note: string
  candidates: number
  quoting: number
  resting: number
  exposure: number
  positionExposure: number
  /** All venue-reported weather acquisition cost, including closed markets awaiting settlement. */
  accountingPositionExposure: number
  restingExposure: number
  restingBudget: number
  totalExposureCap: number
  inventory: number
  placed: number
  amended: number
  canceled: number
  decreased: number
  filled: number
  lastTick?: number
  lastError?: string | null
  blockedReason?: string | null
  /** Complementary orders blocked because they would lock a loss or less than 2c gross margin. */
  lossLockBlocks: string[]
  /** Fills attributed from the venue's fills feed (the number the ledger used to miss). */
  ledgerFills?: number
  /** Candidates removed by each gate on the last tick. */
  gates?: { ratchet: number; blackout: number; noIndex: number }
  /** Shadow meter totals: would-quotes logged, proxy fills, mean ≈15-min markout (cents). */
  shadow?: { quotes: number; proxyFills: number; markoutN: number; markoutMeanCents: number; expired: number; active: number }
  /** Weather events with a banked running extreme this session. */
  indexEvents?: number
}

interface Quote {
  orderId: string
  marketId: string
  outcome: 'YES' | 'NO'
  yesPrice: number
  count: number
  placedAt: number
  close: number
  filledSoFar?: number
  /** Timestamp of the last Tier-1 in-place shrink; throttles shrink/restore churn. */
  shrunkAt?: number
  /** Last time this market passed eligibility gates; prevents one-tick churn. */
  lastEligibleAt?: number
}

interface MarkWatch {
  marketId: string
  outcome: 'YES' | 'NO'
  price: number
  filledAt: number
}

export type ShadowCohort = 'allowed' | 'blocked'

interface ShadowQuote {
  id: string
  marketId: string
  kind: 'high' | 'low' | null
  outcome: 'YES' | 'NO'
  yesPrice: number
  /** Cost of the leg we would hold. */
  legCost: number
  at: number
  close: number
  /** 'allowed' = the live path would rest it; 'blocked' = a gate would stop it (control cohort). */
  cohort: ShadowCohort
  gateReasons: string[]
  lastEligibleAt: number
  filledAt?: number
  fillSource?: 'print' | 'book'
  markoutCents?: number
  markoutMinutes?: number
  pulled?: string
  done?: boolean
}

interface QuoterState {
  quotes: Quote[]
  placed: number
  amended: number
  canceled: number
  decreased?: number
  filled: number
  lastTick?: number
  lastError?: string | null
  markWatch?: MarkWatch[]
  /** Do not hammer the venue after it rejects an order for insufficient collateral. */
  collateralBackoffUntil?: number
  /** Banked daily extremes per weather event (running max/min of the minute index, bound to the event's day). */
  ratchet?: Record<string, { hi: number; lo: number; at: number }>
  shadow?: ShadowQuote[]
  shadowStats?: { quotes: number; proxyFills: number; markoutN: number; markoutSum: number; expired: number; pulled?: number }
  ledgerFills?: number
}

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : undefined
}
const r2 = (x: number): number => Math.round(x * 100) / 100

/**
 * A4: minimum wall-clock spacing between queue-position diagnostic probes. The
 * probe is one venue GET per call and its purpose is evidence for the /decrease
 * policy, not per-tick telemetry.
 */
const QUEUE_PROBE_MIN_INTERVAL_MS = 15_000

/** Blackout windows (UTC hours) in which the daily extreme forms across US metros. */
export const HIGH_BLACKOUT_UTC: [number, number] = [16, 24]
export const LOW_BLACKOUT_UTC: [number, number] = [8, 15]

export function inBlackout(kind: 'high' | 'low' | null, utcHour: number): boolean {
  if (kind === 'high') return utcHour >= HIGH_BLACKOUT_UTC[0] && utcHour < HIGH_BLACKOUT_UTC[1]
  if (kind === 'low') return utcHour >= LOW_BLACKOUT_UTC[0] && utcHour < LOW_BLACKOUT_UTC[1]
  return false
}

/**
 * Blackout windows in the STATION's own local hours (the venue ledger shows
 * 43% of weather fills — and the losses — between 13h and 16h local, when
 * the daily high forms; lows form around dawn). One UTC band cannot cover
 * both coasts, so the local form is used whenever the station is known.
 */
export const HIGH_BLACKOUT_LOCAL: [number, number] = [12, 20]
export const LOW_BLACKOUT_LOCAL: [number, number] = [3, 10]
export function inBlackoutLocal(kind: 'high' | 'low' | null, localHour: number): boolean {
  if (kind === 'high') return localHour >= HIGH_BLACKOUT_LOCAL[0] && localHour < HIGH_BLACKOUT_LOCAL[1]
  if (kind === 'low') return localHour >= LOW_BLACKOUT_LOCAL[0] && localHour < LOW_BLACKOUT_LOCAL[1]
  return false
}
/** Hour of day at the market's station, or null when the station is unknown. */
export function stationLocalHour(ticker: string, nowMs: number): number | null {
  const tz = stationTimeZone(ticker)
  if (!tz) return null
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date(nowMs))
    const n = parseInt(h, 10)
    return Number.isFinite(n) ? n % 24 : null
  } catch {
    return null
  }
}

export function tempKindOfSeries(series: string): 'high' | 'low' | null {
  const s = series.toUpperCase()
  if (s.startsWith('KXHIGH')) return 'high'
  if (s.startsWith('KXLOW')) return 'low'
  return null
}

/**
 * Where a temperature bracket stands against the day's banked extreme.
 *  'decided' — the extreme already cleared a boundary by the guard: the
 *              bracket's outcome is mechanically fixed (informed flow now).
 *  'near'    — the extreme is within `nearF` of a boundary: it is being
 *              decided right now; the next prints are the pick-off.
 *  'open'    — genuinely uncertain; quoting is a fair-odds proposition.
 * A running max only rises and a running min only falls, so 'decided' is
 * permanent and this can never call a bracket the day might still reach.
 */
export function bracketState(
  kind: 'high' | 'low',
  strikeType: string | undefined,
  floor: number | undefined,
  cap: number | undefined,
  hi: number,
  lo: number,
  guardF: number,
  nearF: number
): 'decided' | 'near' | 'open' {
  const t = (strikeType ?? '').toLowerCase()
  const above = t.startsWith('greater')
  const below = t.startsWith('less')
  const between = t === 'between'
  if (kind === 'high') {
    if (above && floor !== undefined) {
      if (hi >= floor + guardF) return 'decided'
      if (hi >= floor - nearF) return 'near'
      return 'open'
    }
    if ((below || between) && cap !== undefined) {
      if (hi >= cap + guardF) return 'decided'
      const lower = between && floor !== undefined ? floor : cap
      if (hi >= lower - nearF) return 'near'
      return 'open'
    }
    return 'open'
  }
  if (below && cap !== undefined) {
    if (lo <= cap - guardF) return 'decided'
    if (lo <= cap + nearF) return 'near'
    return 'open'
  }
  if ((above || between) && floor !== undefined) {
    if (lo <= floor - guardF) return 'decided'
    const upper = between && cap !== undefined ? cap : floor
    if (lo <= upper + nearF) return 'near'
    return 'open'
  }
  return 'open'
}

/**
 * Proxy fill from trade prints: a resting YES bid at p is filled by a print at
 * or below p (someone sold down through it); a resting YES ask (our NO) at p
 * by a print at or above p. Only prints after the quote was placed count.
 */
export function printFills(outcome: 'YES' | 'NO', yesPrice: number, placedAt: number, trades: MarketTrade[]): MarketTrade | null {
  let best: MarketTrade | null = null
  for (const t of trades) {
    if (t.createdTs <= placedAt || t.isBlockTrade) continue
    const hit = outcome === 'YES' ? t.yesPrice <= yesPrice + 1e-9 : t.yesPrice >= yesPrice - 1e-9
    if (hit && (!best || t.createdTs < best.createdTs)) best = t
  }
  return best
}

async function getJson<T>(url: string): Promise<T> {
  for (let a = 0; a < 3; a++) {
    let res: Response
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    } catch (e) {
      if (a === 2) throw e
      await sleep(400)
      continue
    }
    if (res.ok) return (await res.json()) as T
    if (res.status === 429 || res.status >= 500) {
      await sleep(500 * Math.pow(1.8, a))
      continue
    }
    throw new Error(`HTTP ${res.status} ${url.slice(0, 70)}`)
  }
  throw new Error('exhausted')
}

interface RawMarket {
  ticker: string
  event_ticker?: string
  close_time?: string
  yes_bid_dollars?: string
  yes_ask_dollars?: string
  yes_bid_size_fp?: string
  yes_ask_size_fp?: string
  floor_strike?: number
  cap_strike?: number
  strike_type?: string
  exchange_index?: number
  status?: string
}

interface Candidate {
  id: string
  series: string
  eventTicker: string
  kind: 'high' | 'low' | null
  strikeType?: string
  floor?: number
  cap?: number
  shard: number
  close: number
  hoursToClose: number
  bid: number
  ask: number
  bidSz: number
  askSz: number
  spread: number
}

interface IndexRead {
  /** The venue serves a minute index for this city. */
  served: boolean
  /** Banked extreme for the event's own measurement day, when observed. */
  bank: { hi: number; lo: number; at: number } | null
  /** Whether the event's measurement day is running now (only then can a bracket be decided). */
  dayActive: boolean
}

export class ThinQuoter {
  private state: QuoterState = { quotes: [], placed: 0, amended: 0, canceled: 0, filled: 0 }
  private seriesCache: { at: number; tickers: string[] } | undefined
  private makerFee = new Map<string, boolean>()
  private marketCache = new Map<string, { at: number; ms: RawMarket[] }>()
  /** Weather-index fetch throttle per event; served=false = no index for this city. */
  private indexFetchAt = new Map<string, { at: number; served: boolean }>()
  private candidates = 0
  private quotingNow = 0
  private note = 'idle'
  private blockedReason: string | null = null
  private positionExposure = 0
  private accountingPositionExposure = 0
  private restingBudget = 0
  private totalExposureCap = 0
  private lossLockBlocks: string[] = []
  private gates = { ratchet: 0, blackout: 0, noIndex: 0 }
  private running = false
  /** Wall-clock of the last queue-position probe (A4 throttle). */
  private lastQueueProbeAt = 0

  constructor(
    private readonly path: string,
    private readonly log: (s: string) => void = console.log
  ) {
    try {
      if (existsSync(path)) {
        this.state = { ...this.state, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<QuoterState>) }
      }
    } catch {
      // fresh state
    }
    // Shadow rows written before cohorts existed: derive the cohort from the flag.
    for (const s of this.state.shadow ?? []) {
      const legacy = s as ShadowQuote & { gated?: boolean }
      if (!legacy.cohort) legacy.cohort = legacy.gated ? 'blocked' : 'allowed'
      if (legacy.lastEligibleAt === undefined) legacy.lastEligibleAt = legacy.at
    }
  }

  ownsOrder(orderId: string): boolean {
    return this.state.quotes.some((x) => x.orderId === orderId)
  }

  /** Markets this quoter currently rests on (a taker arm must not cross its own quote). */
  restingMarketIds(): Set<string> {
    return new Set(this.state.quotes.map((q) => q.marketId))
  }

  status(cfg: QuoterConfig): QuoterStatus {
    const restingExposure = this.state.quotes.reduce((s, q) => s + q.count * (q.outcome === 'YES' ? q.yesPrice : 1 - q.yesPrice), 0)
    const ss = this.state.shadowStats
    return {
      enabled: cfg.quoterEnabled,
      active: this.note.startsWith('quoting'),
      note: this.note,
      candidates: this.candidates,
      quoting: this.quotingNow,
      resting: this.state.quotes.length,
      exposure: r2(this.positionExposure + restingExposure),
      positionExposure: r2(this.positionExposure),
      accountingPositionExposure: r2(this.accountingPositionExposure),
      restingExposure: r2(restingExposure),
      restingBudget: r2(this.restingBudget),
      totalExposureCap: r2(this.totalExposureCap || cfg.quoterMaxPositionExposure),
      inventory: 0,
      placed: this.state.placed,
      amended: this.state.amended,
      canceled: this.state.canceled,
      decreased: this.state.decreased ?? 0,
      filled: this.state.filled,
      lastTick: this.state.lastTick,
      lastError: this.state.lastError ?? null,
      blockedReason: this.blockedReason,
      lossLockBlocks: [...this.lossLockBlocks],
      ledgerFills: this.state.ledgerFills ?? 0,
      gates: { ...this.gates },
      shadow: ss
        ? {
            quotes: ss.quotes,
            proxyFills: ss.proxyFills,
            markoutN: ss.markoutN,
            markoutMeanCents: ss.markoutN > 0 ? r2(ss.markoutSum / ss.markoutN) : 0,
            expired: ss.expired,
            active: (this.state.shadow ?? []).filter((s) => !s.done).length
          }
        : undefined,
      indexEvents: Object.keys(this.state.ratchet ?? {}).length
    }
  }

  private sidecar(suffix: string): string {
    return this.path.replace(/\.json$/, '') + suffix
  }

  private appendJsonl(suffix: string, row: Record<string, unknown>): void {
    try {
      appendFileSync(this.sidecar(suffix), JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n')
    } catch (e) {
      this.log('[quoter] log failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  private recordFill(
    qt: { marketId: string; outcome: 'YES' | 'NO'; yesPrice: number; close: number; orderId?: string },
    count: number,
    source: string,
    legPrice?: number
  ): void {
    if (!(count > 0)) return
    this.state.filled += count
    if (source === 'venue-fills') this.state.ledgerFills = (this.state.ledgerFills ?? 0) + 1
    const legCost = legPrice ?? (qt.outcome === 'YES' ? qt.yesPrice : 1 - qt.yesPrice)
    this.appendJsonl('-fills.jsonl', {
      marketId: qt.marketId,
      outcome: qt.outcome,
      yesPrice: qt.yesPrice,
      legCost: r2(legCost * 100) / 100,
      count,
      close: new Date(qt.close).toISOString(),
      source,
      orderId: qt.orderId
    })
    this.log(`[quoter] FILL ${qt.outcome} ${qt.marketId} x${count} @leg ${legCost.toFixed(2)} (${source})`)
    ;(this.state.markWatch ??= []).push({ marketId: qt.marketId, outcome: qt.outcome, price: qt.yesPrice, filledAt: Date.now() })
  }

  private recordMarks(books: Map<string, OrderBook>): void {
    const now = Date.now()
    const watch = (this.state.markWatch ?? []).filter((w) => now - w.filledAt < 20 * 60_000)
    for (const w of watch) {
      const b = books.get(w.marketId)
      const bid = b?.bids?.[0]?.price
      const ask = b?.asks?.[0]?.price
      if (bid === undefined || ask === undefined) continue
      this.appendJsonl('-marks.jsonl', {
        marketId: w.marketId,
        outcome: w.outcome,
        fillYes: w.price,
        minutesAfter: +((now - w.filledAt) / 60_000).toFixed(1),
        mid: +((bid + ask) / 2).toFixed(4)
      })
    }
    this.state.markWatch = watch
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = this.path + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.path)
    } catch (e) {
      this.log('[quoter] persist failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  private async series(cfg: QuoterConfig): Promise<string[]> {
    if (this.seriesCache && Date.now() - this.seriesCache.at < 3600_000) return this.seriesCache.tickers
    const re = new RegExp(cfg.quoterSeriesRegex)
    const j = await getJson<{ series?: { ticker?: string; fee_type?: string; category?: string }[] }>(
      `${KALSHI}/series?category=${encodeURIComponent(cfg.quoterCategory)}&limit=500`
    )
    const tickers: string[] = []
    for (const s of j.series ?? []) {
      if (!s.ticker || !re.test(s.ticker)) continue
      const bills = s.fee_type === 'quadratic_with_maker_fees'
      this.makerFee.set(s.ticker, bills)
      if (!bills) tickers.push(s.ticker)
    }
    this.seriesCache = { at: Date.now(), tickers }
    this.log(`[quoter] ${tickers.length} fee-free series in "${cfg.quoterCategory}" matching ${cfg.quoterSeriesRegex}`)
    return tickers
  }

  /**
   * Refresh the banked running extreme for one weather event from the venue's
   * minute temperature index, keeping only observations inside the event's
   * own measurement day (station time zone). The city index serves the last
   * few hours regardless of which event asked; unfiltered, tomorrow's event
   * banked today's high and a series across local midnight leaked yesterday's.
   * A late start can only MISS an extreme inside the day, never invent one.
   * Cities the index does not serve are remembered as such for 30 minutes.
   */
  /** Latest forecast fair value per quoted market (for the status line and the fill log). */
  private fairById = new Map<string, { fair: number; mu: number; sigma: number; hours: number }>()
  private flow = new FlowMonitor()

  /**
   * Forecast-derived fair value for a temperature bracket: the day's extreme is
   * Normal(mu, sigma) with mu = max(observed running high, forecast high of the
   * remaining hours) for highs (min for lows). Null when the station, date or
   * forecast is unavailable — the caller falls back to the midpoint.
   */
  private async fairValue(c: Candidate, bank: { hi: number; lo: number; at: number } | null, now: number): Promise<{ fair: number; mu: number; sigma: number; hours: number } | null> {
    if (!c.kind) return null
    const station = stationCode(c.eventTicker)
    const eventDate = parseEventDate(c.eventTicker)
    const tz = stationTimeZone(c.eventTicker)
    if (!station || !eventDate || !tz) return null
    const fc = await fetchHourlyForecast(station, now).catch(() => null)
    if (!fc) return null
    const ext = remainingExtremes(fc, eventDate, tz, now)
    if (!ext) return null
    const fresh = bank && now - bank.at < 45 * 60_000 ? bank : null
    const mu = c.kind === 'high' ? Math.max(fresh?.hi ?? -Infinity, ext.max) : Math.min(fresh?.lo ?? Infinity, ext.min)
    const sigma = forecastSigma(ext.hours)
    const fair = bracketFairValue(c.kind, c.strikeType, c.floor, c.cap, mu, sigma)
    if (fair === null || !Number.isFinite(fair)) return null
    return { fair: Math.min(0.98, Math.max(0.02, fair)), mu, sigma, hours: ext.hours }
  }

  private async refreshIndex(adapter: VenueAdapter, eventTicker: string): Promise<IndexRead> {
    const now = Date.now()
    const banked = this.state.ratchet?.[eventTicker] ?? null
    const eventDate = parseEventDate(eventTicker)
    const tz = stationTimeZone(eventTicker)
    const dayActive = !!eventDate && !!tz && eventDayStatus(eventDate, tz, now) === 'active'
    const last = this.indexFetchAt.get(eventTicker)
    if (last && now - last.at < (last.served ? 5 * 60_000 : 30 * 60_000)) {
      return { served: last.served, bank: last.served ? banked : null, dayActive }
    }
    if (!adapter.getLiveData || !eventDate || !tz) {
      this.indexFetchAt.set(eventTicker, { at: now, served: false })
      return { served: false, bank: null, dayActive }
    }
    const ld = await adapter.getLiveData(eventTicker).catch(() => undefined)
    if (!ld || ld.latest === undefined) {
      // No index for this city (404) or a transient failure — keep the last verdict on the city.
      this.indexFetchAt.set(eventTicker, { at: now, served: last?.served ?? false })
      return { served: last?.served ?? false, bank: last?.served ? banked : null, dayActive }
    }
    this.indexFetchAt.set(eventTicker, { at: now, served: true })
    if (!dayActive || (ld.staleMinutes ?? 0) > 30) return { served: true, bank: banked, dayActive }
    const obs = bankObservations(ld.series ?? [], eventDate, tz)
    if (!obs) return { served: true, bank: banked, dayActive }
    this.state.ratchet ??= {}
    const r = (this.state.ratchet[eventTicker] ??= { hi: obs.hi, lo: obs.lo, at: now })
    r.hi = Math.max(r.hi, obs.hi)
    r.lo = Math.min(r.lo, obs.lo)
    r.at = now
    return { served: true, bank: r, dayActive }
  }

  /**
   * Attribute fills to tracked quotes from the venue's fills feed by order id
   * (so an order that filled and left the resting list is still counted), and
   * drop quotes the venue no longer lists. Returns false when the feeds were
   * unavailable, in which case nothing is dropped.
   */
  private async attributeFills(adapter: VenueAdapter, open: Map<string, { fillCount: number; status: string }>): Promise<boolean> {
    let fillsByOrder: Map<string, { shares: number; notional: number }> | null = null
    if (adapter.getFills && this.state.quotes.length) {
      try {
        const fills: VenueFill[] = await adapter.getFills(1000)
        fillsByOrder = new Map()
        for (const f of fills) {
          if (!f.orderId) continue
          const acc = fillsByOrder.get(f.orderId) ?? { shares: 0, notional: 0 }
          acc.shares += f.shares
          acc.notional += f.shares * f.price
          fillsByOrder.set(f.orderId, acc)
        }
      } catch (e) {
        this.note = 'fills feed unavailable; holding (' + (e instanceof Error ? e.message : String(e)).slice(0, 60) + ')'
        return false
      }
    }
    for (const q of this.state.quotes) {
      const o = open.get(q.orderId)
      const venueFill = fillsByOrder?.get(q.orderId)
      const totalFilled = venueFill ? venueFill.shares : o ? o.fillCount : undefined
      if (totalFilled === undefined) continue
      const newFills = totalFilled - (q.filledSoFar ?? 0)
      if (newFills > 0.005) {
        const legPrice = venueFill && venueFill.shares > 0 ? venueFill.notional / venueFill.shares : undefined
        this.recordFill(q, newFills, venueFill ? 'venue-fills' : 'reconcile', legPrice)
        q.filledSoFar = totalFilled
      }
    }
    return true
  }

  async tick(
    adapter: VenueAdapter,
    cfg: QuoterConfig,
    mode: 'paper' | 'live',
    armed: boolean,
    killed: boolean,
    /** Exchange trading paused (weekly maintenance): hold everything, place nothing. */
    paused = false
  ): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      this.state.lastTick = Date.now()
      this.lossLockBlocks = []
      this.gates = { ratchet: 0, blackout: 0, noIndex: 0 }
      if (paused) {
        this.note = 'exchange trading paused; holding quotes'
        return
      }
      if (!adapter.getOrderBooks || !adapter.getOpenOrders || !adapter.amendOrder) {
        this.note = 'adapter lacks books/orders/amend'
        return
      }
      const canTrade = mode === 'live' && armed && !killed && cfg.quoterEnabled
      if (!canTrade && this.state.quotes.length) {
        // Book any fill that landed since the last tick BEFORE cancelling —
        // a cancel-then-forget here is exactly how fills went missing.
        const reason = !cfg.quoterEnabled ? 'disabled' : mode !== 'live' ? 'paper mode' : killed ? 'kill switch' : 'disarmed'
        let open: Map<string, { fillCount: number; status: string }> | null = null
        try {
          open = new Map((await adapter.getOpenOrders()).map((o) => [o.orderId, { fillCount: o.fillCount, status: o.status }]))
        } catch {
          open = null
        }
        if (open && (await this.attributeFills(adapter, open))) {
          await this.cancelAll(adapter, reason, open)
        } else {
          this.note = `${reason}: venue feeds unavailable; holding ${this.state.quotes.length} tracked quotes until they can be reconciled`
          return
        }
      }
      const shadow = !canTrade && (cfg.quoterShadowEnabled ?? true)
      if (!canTrade && !shadow) {
        this.note = cfg.quoterEnabled ? 'disarmed' : 'disabled'
        this.quotingNow = 0
        return
      }

      const now = Date.now()
      const series = await this.series(cfg)
      const cands: Candidate[] = []

      for (const s of series) {
        let ms: RawMarket[] = []
        const cached = this.marketCache.get(s)
        if (cached && now - cached.at < 10 * 60_000) ms = cached.ms
        else {
          try {
            ms = (await getJson<{ markets?: RawMarket[] }>(`${KALSHI}/markets?series_ticker=${s}&status=open&limit=200`)).markets ?? []
          } catch (e) {
            this.log(`[quoter] ${s}: ${e instanceof Error ? e.message : String(e)}`)
            continue
          }
          this.marketCache.set(s, { at: now, ms })
          // Public market endpoints share Kalshi's IP-level read budget with
          // authenticated calls. Avoid a 100-series burst that starves the UI.
          await sleep(250)
        }

        for (const m of ms) {
          const close = m.close_time ? Date.parse(m.close_time) : NaN
          if (!Number.isFinite(close)) continue
          const h = (close - now) / 3600e3
          if (h < cfg.quoterMinHoursToClose || h > cfg.quoterMaxHoursToClose) continue

          const bid = num(m.yes_bid_dollars)
          const ask = num(m.yes_ask_dollars)
          if (bid === undefined || ask === undefined || !(bid > 0) || !(ask < 1) || ask <= bid) continue
          if (bid < 0.05 || ask > 0.95) continue

          const spread = ask - bid
          if (spread * 100 < cfg.quoterMinSpreadCents || spread * 100 > cfg.quoterMaxSpreadCents) continue

          const bidSz = num(m.yes_bid_size_fp) ?? 0
          const askSz = num(m.yes_ask_size_fp) ?? 0
          if (Math.min(bidSz, askSz) > cfg.quoterMaxTouchDepth) continue

          cands.push({
            id: m.ticker,
            series: s,
            eventTicker: m.event_ticker ?? m.ticker.split('-').slice(0, 2).join('-'),
            kind: tempKindOfSeries(s),
            strikeType: m.strike_type,
            floor: num(m.floor_strike),
            cap: num(m.cap_strike),
            shard: typeof m.exchange_index === 'number' ? m.exchange_index : 0,
            close,
            hoursToClose: h,
            bid,
            ask,
            bidSz,
            askSz,
            spread
          })
        }
      }

      cands.sort((a, b) => b.spread - a.spread)
      const activeShadow = (this.state.shadow ?? []).filter((x) => !x.done)
      const held = new Set(canTrade ? this.state.quotes.map((x) => x.marketId) : activeShadow.map((x) => x.marketId))
      const keepers = cands.filter((c) => held.has(c.id))
      const fresh = cands.filter((c) => !held.has(c.id))
      // One bracket per city/day event. Sibling buckets are correlated.
      // Keep existing markets first so resting orders retain queue priority.
      const chosen: Candidate[] = []
      const eventKeys = new Set<string>()
      for (const c of [...keepers, ...fresh]) {
        const key = c.eventTicker
        if (eventKeys.has(key)) continue
        chosen.push(c)
        eventKeys.add(key)
        if (chosen.length >= cfg.quoterMaxMarkets) break
      }
      this.candidates = cands.length

      // ---- gates: ratchet (banked extreme of the event's own day), blackout (time of day), index availability ----
      const guardF = cfg.quoterGuardF ?? 2
      const nearF = cfg.quoterNearF ?? 1.5
      const utcHour = new Date(now).getUTCHours()
      const gateOf = new Map<string, string[]>()
      const bankOf = new Map<string, { hi: number; lo: number; at: number } | null>()
      let indexBudget = 8
      for (const c of chosen) {
        const reasons: string[] = []
        const localHour = stationLocalHour(c.id, now)
        const blackout = localHour === null ? inBlackout(c.kind, utcHour) : inBlackoutLocal(c.kind, localHour)
        if ((cfg.quoterBlackoutEnabled ?? true) && blackout) reasons.push('blackout')
        // Informed flow: a whale print or a one-sided stream in the last 15
        // minutes is the counterparty a passive quote should not meet.
        if ((cfg.quoterFlowGate ?? true) && adapter.getRecentTrades) {
          const fs = await this.flow.read(adapter, c.id, now)
          if (fs && flowVerdict(fs, FLOW_DEFAULTS).toxic) reasons.push('flow')
        }
        if (c.kind) {
          let idx: IndexRead
          if (indexBudget > 0) {
            indexBudget--
            idx = await this.refreshIndex(adapter, c.eventTicker)
          } else {
            const last = this.indexFetchAt.get(c.eventTicker)
            const d = parseEventDate(c.eventTicker)
            const tz = stationTimeZone(c.eventTicker)
            idx = { served: last?.served ?? false, bank: last?.served ? this.state.ratchet?.[c.eventTicker] ?? null : null, dayActive: !!d && !!tz && eventDayStatus(d, tz, now) === 'active' }
          }
          bankOf.set(c.id, idx.served ? idx.bank : null)
          if (!idx.served) {
            if (cfg.quoterRequireIndex ?? true) reasons.push('no-index')
          } else if ((cfg.quoterRatchetGate ?? true) && idx.dayActive) {
            if (!idx.bank || now - idx.bank.at > 45 * 60_000) {
              // The day is running but no fresh reading: the extreme is unknown, treat as being decided.
              reasons.push('index-stale')
            } else {
              const st = bracketState(c.kind, c.strikeType, c.floor, c.cap, idx.bank.hi, idx.bank.lo, guardF, nearF)
              if (st !== 'open') reasons.push(`ratchet:${st}`)
            }
          }
        }
        gateOf.set(c.id, reasons)
        if (reasons.includes('blackout')) this.gates.blackout++
        if (reasons.includes('no-index') || reasons.includes('index-stale')) this.gates.noIndex++
        if (reasons.some((x) => x.startsWith('ratchet:'))) this.gates.ratchet++
      }
      const quotable = chosen.filter((c) => (gateOf.get(c.id) ?? []).length === 0)

      const books = new Map<string, OrderBook>()
      const watched = (this.state.markWatch ?? []).map((w) => w.marketId)
      const bookIds = [...new Set([...chosen.map((c) => c.id), ...watched, ...activeShadow.map((s) => s.marketId)])]
      if (bookIds.length) {
        try {
          for (const b of await adapter.getOrderBooks(bookIds)) books.set(b.marketId, b)
        } catch (e) {
          this.log('[quoter] books: ' + (e instanceof Error ? e.message : String(e)))
        }
      }
      this.recordMarks(books)

      if (!canTrade) {
        await this.runShadow(adapter, chosen, gateOf, books, now)
        this.quotingNow = 0
        const gated = chosen.length - quotable.length
        this.note =
          (mode !== 'live' ? 'paper' : !cfg.quoterEnabled ? 'disabled' : killed ? 'kill switch' : 'disarmed') +
          `: ${cands.length} candidates, would quote ${quotable.length} (${gated} gated) — shadow meter on`
        return
      }

      // ---- live path ----
      const inventory = new Map<string, number>()
      const openWeatherMarketIds = new Set<string>()
      const refreshedSeries = new Set<string>()
      for (const ticker of series) {
        const cached = this.marketCache.get(ticker)
        if (!cached) continue
        refreshedSeries.add(ticker)
        for (const market of cached.ms) if (market.ticker) openWeatherMarketIds.add(market.ticker)
      }
      const positionDetails = new Map<string, { outcome: 'YES' | 'NO'; shares: number; avgPrice: number }>()
      let positionRisk = 0
      let accountingPositionRisk = 0
      try {
        for (const p of await adapter.getPositions()) {
          inventory.set(p.marketId, (p.outcome === 'YES' ? 1 : -1) * p.shares)
          positionDetails.set(p.marketId, { outcome: p.outcome === 'YES' ? 'YES' : 'NO', shares: p.shares, avgPrice: p.avgPrice })
          const matchedSeries = series.find((ticker) => p.marketId.startsWith(ticker + '-'))
          if (matchedSeries) {
            const cost = Math.max(0, p.avgPrice) * Math.max(0, p.shares)
            accountingPositionRisk += cost
            if (!refreshedSeries.has(matchedSeries) || openWeatherMarketIds.has(p.marketId)) positionRisk += cost
          }
        }
      } catch {
        this.note = 'positions unavailable; holding existing quotes'
        return
      }
      this.positionExposure = positionRisk
      this.accountingPositionExposure = accountingPositionRisk

      // Collateral is per exchange shard. Weather settles on shard 0; the
      // aggregate balance read "funded" for three days while shard 0 held
      // five cents and every placement was rejected.
      let aggregateBalance = 0
      let balanceByShard: Record<number, number> | undefined
      try {
        const acct = await adapter.getAccount()
        aggregateBalance = Math.max(0, acct.balance ?? 0)
        balanceByShard = acct.balanceByShard
      } catch {
        this.note = 'balance unavailable; holding existing quotes'
        return
      }
      const shardBalance = (shard: number): number => balanceByShard?.[shard] ?? aggregateBalance

      let openById: Map<string, { fillCount: number; status: string }>
      try {
        openById = new Map((await adapter.getOpenOrders()).map((o) => [o.orderId, { fillCount: o.fillCount, status: o.status }]))
      } catch (e) {
        this.note = 'open orders unavailable; holding (' + (e instanceof Error ? e.message : String(e)).slice(0, 60) + ')'
        return
      }
      if (!(await this.attributeFills(adapter, openById))) return

      const keep: Quote[] = []
      for (const q of this.state.quotes) {
        const o = openById.get(q.orderId)
        if (!o) continue // gone: filled, expired or cancelled — the fill (if any) was booked by attributeFills
        if (o.status !== 'resting') continue
        const c = chosen.find((x) => x.id === q.marketId)
        if (c) q.lastEligibleAt = now
        const tooClose = q.close - now < cfg.quoterCancelMinutes * 60_000
        const gatedNow = c ? (gateOf.get(c.id) ?? []).length > 0 : false
        // Preserve queue priority through brief spread/depth changes, but pull
        // immediately when a gate closes: a bracket being decided is exactly
        // when a resting quote gets picked off.
        const outsideLongEnough = !c && now - (q.lastEligibleAt ?? q.placedAt) >= 20 * 60_000
        if (outsideLongEnough || tooClose || gatedNow) {
          const ok = await this.cancel(adapter, q, gatedNow ? `gate ${(gateOf.get(c!.id) ?? []).join(',')}` : outsideLongEnough ? 'ineligible 20m' : 'near close')
          if (!ok) keep.push(q) // still resting at the venue as far as we know; retry next tick
          continue
        }
        keep.push(q)
      }
      this.state.quotes = keep

      const restingExposureNow = this.state.quotes.reduce((s, q) => s + q.count * (q.outcome === 'YES' ? q.yesPrice : 1 - q.yesPrice), 0)
      let exposure = positionRisk + restingExposureNow
      const restingBudget = Math.min(cfg.quoterMaxExposure, Math.max(0, aggregateBalance * 0.25))
      const totalExposureCap = Math.max(cfg.quoterMaxExposure, cfg.quoterMaxPositionExposure)
      this.restingBudget = restingBudget
      this.totalExposureCap = totalExposureCap
      this.blockedReason = null
      const collateralCooling = (this.state.collateralBackoffUntil ?? 0) > now
      if (collateralCooling) {
        const minutes = Math.max(1, Math.ceil(((this.state.collateralBackoffUntil ?? now) - now) / 60_000))
        this.blockedReason = `venue collateral backoff (${minutes}m remaining)`
      }
      let newRestingExposure = restingExposureNow
      let quoting = 0
      this.fairById.clear()

      for (const c of quotable) {
        const book = books.get(c.id)
        const bestBid = book?.bids?.[0]?.price ?? c.bid
        const bestAsk = book?.asks?.[0]?.price ?? c.ask
        if (!(bestAsk - bestBid >= 0.02)) continue

        const inv = inventory.get(c.id) ?? 0
        // Fair value: the forecast-derived bracket probability when the station's
        // NWS forecast is available (the 2026-09-06 audit: quoting around the mid
        // lost 3.9c/contract to slow, forecast-horizon adverse selection). Without
        // a forecast, the old midpoint quote with a one-cent inventory lean.
        const model = (cfg.quoterFairValueEnabled ?? true) ? await this.fairValue(c, bankOf.get(c.id) ?? null, now) : null
        const fairValue = model?.fair ?? (bestBid + bestAsk) / 2
        let wantYesBid: number | null
        let wantYesAsk: number | null
        if (model) {
          const q = quoteAroundFair(model.fair, bestBid, bestAsk, cfg.quoterFairMarginCents ?? 2, inv, cfg.quoterMaxInventory)
          wantYesBid = q.bid
          wantYesAsk = q.ask
          this.fairById.set(c.id, model)
        } else {
          const reservationPrice = Math.min(bestAsk - 0.01, Math.max(bestBid + 0.01, fairValue - inv * 0.01))
          wantYesBid = inv < cfg.quoterMaxInventory ? r2(Math.min(bestAsk - 0.01, Math.max(bestBid + 0.01, reservationPrice - 0.01))) : null
          wantYesAsk = inv > -cfg.quoterMaxInventory ? r2(Math.max(bestBid + 0.01, Math.min(bestAsk - 0.01, reservationPrice + 0.01))) : null
          this.fairById.delete(c.id)
        }

        for (const [outcome, yesPrice] of [['YES', wantYesBid], ['NO', wantYesAsk]] as const) {
          if (yesPrice === null || yesPrice <= 0.01 || yesPrice >= 0.99) continue
          if (outcome === 'YES' && yesPrice >= bestAsk) continue
          if (outcome === 'NO' && yesPrice <= bestBid) continue

          const legCost = outcome === 'YES' ? yesPrice : 1 - yesPrice
          const count = Math.max(1, Math.min(cfg.quoterMaxContracts || 1, 4)) // the ladder sets 1, 2, 4 per side
          const existing = this.state.quotes.find((q) => q.marketId === c.id && q.outcome === outcome)

          // A YES+NO pair always pays exactly $1. Never add a complementary leg
          // when its cost plus the held opposite leg would lock a loss.
          const heldPosition = positionDetails.get(c.id)
          if (heldPosition && heldPosition.shares > 0 && heldPosition.avgPrice > 0 && heldPosition.outcome !== outcome) {
            const pairCost = heldPosition.avgPrice + legCost
            if (pairCost > 0.980001) {
              this.lossLockBlocks.push(`${c.id}: held ${heldPosition.outcome} ${(heldPosition.avgPrice * 100).toFixed(0)}c + ${outcome} ${(legCost * 100).toFixed(0)}c = ${(pairCost * 100).toFixed(0)}c`)
              this.blockedReason = `loss-locking complement blocked (${this.lossLockBlocks.length})`
              if (existing && (await this.cancel(adapter, existing, 'loss-locking complement'))) {
                this.state.quotes = this.state.quotes.filter((q) => q !== existing)
              }
              continue
            }
          }
          const oppositeQuote = this.state.quotes.find((q) => q.marketId === c.id && q.outcome !== outcome)
          if (oppositeQuote) {
            const oppositeCost = oppositeQuote.outcome === 'YES' ? oppositeQuote.yesPrice : 1 - oppositeQuote.yesPrice
            if (oppositeCost + legCost > 0.980001) {
              this.lossLockBlocks.push(`${c.id}: resting ${oppositeQuote.outcome} ${(oppositeCost * 100).toFixed(0)}c + ${outcome} ${(legCost * 100).toFixed(0)}c = ${((oppositeCost + legCost) * 100).toFixed(0)}c`)
              this.blockedReason = `loss-locking complement blocked (${this.lossLockBlocks.length})`
              if (existing && (await this.cancel(adapter, existing, 'loss-locking complement'))) {
                this.state.quotes = this.state.quotes.filter((q) => q !== existing)
              }
              continue
            }
          }

          if (existing) {
            const crossed = outcome === 'YES' ? existing.yesPrice >= bestAsk : existing.yesPrice <= bestBid
            const microDeltaCents = Math.abs(existing.yesPrice - yesPrice) * 100
            const adverseMove = outcome === 'YES' ? yesPrice < existing.yesPrice : yesPrice > existing.yesPrice
            const remaining = existing.count - (existing.filledSoFar ?? 0)
            const shrinkCooldownMs = 60_000
            if (!crossed && adverseMove && microDeltaCents >= 1 && microDeltaCents < 3 && remaining > 1 && adapter.decreaseOrder && (existing.shrunkAt === undefined || now - existing.shrunkAt > shrinkCooldownMs)) {
              // Tier-1: a small (1c..<3c) adverse fair-value move. The quote is now
              // slightly cheap for takers AND sits at the front of the queue (it was
              // resting first), so it will be picked off. Shrink it in place instead: a
              // size decrease is the one amendment that PRESERVES queue position, so we
              // cut the notional at risk without forfeiting the slot.
              const reduceTo = remaining - 1
              // A4: arm the cooldown in BOTH modes. In shadow there is no order to
              // amend, so without this the branch re-fired on every tick for the same
              // quote - an unbounded log (and probe) cost for no order.
              existing.shrunkAt = now
              // A4: the queue probe is a venue GET per call. Throttle it.
              let queue: string | null = null
              if (adapter.getOrderQueuePosition && now - this.lastQueueProbeAt > QUEUE_PROBE_MIN_INTERVAL_MS) {
                this.lastQueueProbeAt = now
                try {
                  const qp = await adapter.getOrderQueuePosition(existing.orderId)
                  queue = qp === undefined ? null : String(qp)
                } catch { /* diagnostic only */ }
              }
              this.log(`[quoter] tier1 shrink ${outcome} ${c.id}: ${existing.count}->${reduceTo} remaining, queue=${queue ?? '?'}${cfg.quoterDecreaseEnabled ? '' : ' (shadow)'}`)
              if (cfg.quoterDecreaseEnabled) {
                try {
                  const r = await adapter.decreaseOrder(existing.orderId, c.id, reduceTo)
                  if (r.remainingCount === undefined) {
                    // A7: the reply omitted remaining_count. Do NOT invent 0 - that
                    // would set count = filledSoFar, i.e. read as "fully filled".
                    // Keep the pre-call count; the next open-orders read reconciles.
                    this.log(`[quoter] tier1 decrease ${c.id} ${outcome}: reply had no remaining_count; count left unchanged`)
                  } else {
                    existing.count = (existing.filledSoFar ?? 0) + r.remainingCount
                  }
                  this.state.decreased = (this.state.decreased ?? 0) + 1
                } catch (e) {
                  this.log(`[quoter] tier1 decrease failed ${c.id} ${outcome}: ${e instanceof Error ? e.message : String(e)}`)
                }
              }
              quoting++
              continue
            }
            // A3: reprice ONLY when the resting price is genuinely wrong - the book
            // crossed us, or fair value moved >= 3c. A 1c..<3c adverse move is handled
            // by the tier-1 shrink above, which HOLDS the reduced size and keeps the
            // queue slot. The old condition amended (forfeiting the slot) as soon as
            // the 60s cooldown lapsed, on a move that had not reverted.
            const priceDelta = Math.abs(existing.yesPrice - yesPrice)
            // Restore full size only once fair value has come BACK to the resting
            // price; because the price is then unchanged this is a size-only amend.
            const restoreSize = existing.count !== count && priceDelta < 0.01
            if (crossed || priceDelta >= 0.03 || restoreSize) {
              try {
                // Keep the resting price on a pure size restore: it is a PRICE change
                // that forfeits queue position, not a size increase per se.
                const amendPrice = restoreSize && !crossed ? existing.yesPrice : yesPrice
                const r = await adapter.amendOrder(existing.orderId, c.id, outcome === 'YES' ? 'bid' : 'ask', amendPrice, count)
                existing.yesPrice = amendPrice
                existing.count = count
                existing.shrunkAt = undefined
                this.state.amended++
                if (r.fillCount > (existing.filledSoFar ?? 0) + 0.005) {
                  this.recordFill(existing, r.fillCount - (existing.filledSoFar ?? 0), 'amend')
                  existing.filledSoFar = r.fillCount
                }
              } catch (e) {
                // Leave the row: the order may still rest; the next tick's
                // open-orders read decides whether it is gone.
                this.log(`[quoter] amend ${c.id} ${outcome}: ${e instanceof Error ? e.message : String(e)}`)
              }
            }
            quoting++
            continue
          }

          if (collateralCooling) continue
          if (shardBalance(c.shard) < legCost + 0.25) {
            this.blockedReason = `shard ${c.shard} cash $${shardBalance(c.shard).toFixed(2)} below order cost plus reserve`
            continue
          }
          if (newRestingExposure + count * legCost > restingBudget) {
            this.blockedReason = `resting budget $${restingBudget.toFixed(2)} reached`
            continue
          }
          if (exposure + count * legCost > totalExposureCap) {
            this.blockedReason = `total weather exposure cap $${totalExposureCap.toFixed(2)} reached`
            continue
          }

          try {
            const res = await adapter.placeOrder({
              venue: 'kalshi',
              marketId: c.id,
              outcome,
              amount: count * legCost,
              contracts: count,
              limitPrice: yesPrice,
              timeInForce: 'good_till_canceled',
              postOnly: true,
              expirationTs: Math.floor((c.close - cfg.quoterCancelMinutes * 60_000) / 1000),
              ref: 'quoter'
            })
            this.state.quotes.push({
              orderId: res.orderId,
              marketId: c.id,
              outcome,
              yesPrice,
              count,
              placedAt: Date.now(),
              close: c.close,
              filledSoFar: res.shares > 0 ? res.shares : 0,
              lastEligibleAt: now
            })
            this.state.placed++
            this.state.collateralBackoffUntil = undefined
            exposure += count * legCost
            newRestingExposure += count * legCost
            quoting++
            if (res.shares > 0) this.recordFill({ marketId: c.id, outcome, yesPrice, close: c.close, orderId: res.orderId }, res.shares, 'placement')
            this.log(`[quoter] rest ${outcome} ${c.id} @yes ${yesPrice.toFixed(2)} x${count} (${model ? `fair ${fairValue.toFixed(2)} mu ${model.mu.toFixed(1)} sigma ${model.sigma.toFixed(1)}` : `mid ${fairValue.toFixed(2)}`}, inv ${inv}, spread ${(100 * c.spread).toFixed(0)}c, shard ${c.shard})`)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            this.log(`[quoter] place ${c.id} ${outcome}: ${msg}`)
            if (/insufficient[_ ]balance|insufficient collateral/i.test(msg)) {
              this.state.collateralBackoffUntil = Date.now() + 15 * 60_000
              this.blockedReason = 'venue collateral backoff (15m)'
              this.note = `collateral guard: venue rejected shard ${c.shard} order for insufficient balance; backing off new orders for 15m`
              this.state.lastError = msg
              return
            }
          }
          await sleep(120)
        }
      }

      this.quotingNow = quoting
      const gated = chosen.length - quotable.length
      this.note = `quoting ${quoting} sides on ${quotable.length} markets (${cands.length} candidates, ${gated} gated), total $${r2(exposure).toFixed(2)} (positions $${r2(positionRisk).toFixed(2)} + resting $${r2(newRestingExposure).toFixed(2)}); fair-value on ${this.fairById.size} of ${quotable.length}${this.blockedReason ? '; ' + this.blockedReason : ''}`
      this.state.lastError = null
    } catch (e) {
      this.state.lastError = e instanceof Error ? e.message : String(e)
      this.log('[quoter] tick failed: ' + this.state.lastError)
    } finally {
      this.persist()
      this.running = false
    }
  }

  /**
   * Shadow meter. Mirrors the live lifecycle for the quotes the live path
   * WOULD rest: the same gates each tick (a quote whose gate closes is pulled,
   * as the live path would pull it), the same 20-minute ineligibility grace,
   * fills from timestamped trade prints through the quote price (book crossing
   * only when the trades feed is unavailable), and the mid ≈15 minutes after
   * the fill with its actual timing recorded. Cohorts: 'allowed' is the
   * strategy under test; 'blocked' is the control the gates would have
   * refused. Settlement grading lives in scripts/quoter-shadow-gate.mjs.
   */
  private async runShadow(adapter: VenueAdapter, chosen: Candidate[], gateOf: Map<string, string[]>, books: Map<string, OrderBook>, now: number): Promise<void> {
    const shadow = (this.state.shadow ??= [])
    const stats = (this.state.shadowStats ??= { quotes: 0, proxyFills: 0, markoutN: 0, markoutSum: 0, expired: 0, pulled: 0 })
    stats.pulled ??= 0
    const chosenIds = new Set(chosen.map((c) => c.id))
    const tradesCache = new Map<string, MarketTrade[]>()
    const tradesFor = async (marketId: string, sinceMs: number): Promise<MarketTrade[] | null> => {
      if (!adapter.getRecentTrades) return null
      const cached = tradesCache.get(marketId)
      if (cached) return cached
      try {
        const t = await adapter.getRecentTrades(marketId, 200, Math.floor(sinceMs / 1000))
        tradesCache.set(marketId, t)
        return t
      } catch {
        return null
      }
    }
    // Score active shadow quotes.
    for (const s of shadow) {
      if (s.done) continue
      const b = books.get(s.marketId)
      const bid = b?.bids?.[0]?.price
      const ask = b?.asks?.[0]?.price
      if (s.filledAt === undefined) {
        // Lifecycle: expiry, gate closing, prolonged ineligibility — as live.
        if (now - s.at > 60 * 60_000 || now > s.close) {
          s.done = true
          stats.expired++
          this.appendJsonl('-shadow.jsonl', { event: 'expired', id: s.id, marketId: s.marketId, outcome: s.outcome, cohort: s.cohort, gated: s.cohort === 'blocked' })
          continue
        }
        if (chosenIds.has(s.marketId)) {
          s.lastEligibleAt = now
          const reasons = gateOf.get(s.marketId) ?? []
          if (s.cohort === 'allowed' && reasons.length > 0) {
            s.done = true
            s.pulled = reasons.join(',')
            stats.pulled++
            this.appendJsonl('-shadow.jsonl', { event: 'pulled', id: s.id, marketId: s.marketId, outcome: s.outcome, cohort: s.cohort, gated: false, reasons })
            continue
          }
        } else if (now - s.lastEligibleAt >= 20 * 60_000) {
          s.done = true
          s.pulled = 'ineligible 20m'
          stats.pulled++
          this.appendJsonl('-shadow.jsonl', { event: 'pulled', id: s.id, marketId: s.marketId, outcome: s.outcome, cohort: s.cohort, gated: s.cohort === 'blocked', reasons: ['ineligible 20m'] })
          continue
        }
        const trades = await tradesFor(s.marketId, s.at)
        let fillTs: number | undefined
        let source: 'print' | 'book' | undefined
        if (trades) {
          const hit = printFills(s.outcome, s.yesPrice, s.at, trades)
          if (hit) {
            fillTs = hit.createdTs
            source = 'print'
          }
        } else if (bid !== undefined && ask !== undefined) {
          const crossed = s.outcome === 'YES' ? ask <= s.yesPrice + 1e-9 : bid >= s.yesPrice - 1e-9
          if (crossed) {
            fillTs = now
            source = 'book'
          }
        }
        if (fillTs !== undefined && source) {
          s.filledAt = fillTs
          s.fillSource = source
          stats.proxyFills++
          this.appendJsonl('-shadow.jsonl', { event: 'proxy-fill', id: s.id, marketId: s.marketId, outcome: s.outcome, yesPrice: s.yesPrice, legCost: s.legCost, cohort: s.cohort, gated: s.cohort === 'blocked', gateReasons: s.gateReasons, kind: s.kind, close: new Date(s.close).toISOString(), fillTs: new Date(fillTs).toISOString(), fillSource: source, bid, ask })
        }
        continue
      }
      if (s.markoutCents === undefined && now - s.filledAt >= 15 * 60_000) {
        if (bid === undefined || ask === undefined) continue
        const mid = (bid + ask) / 2
        s.markoutCents = r2((s.outcome === 'YES' ? mid - s.yesPrice : s.yesPrice - mid) * 100)
        s.markoutMinutes = +((now - s.filledAt) / 60_000).toFixed(1)
        s.done = true
        stats.markoutN++
        stats.markoutSum += s.markoutCents
        this.appendJsonl('-shadow.jsonl', { event: 'markout15', id: s.id, marketId: s.marketId, outcome: s.outcome, yesPrice: s.yesPrice, markoutCents: s.markoutCents, markoutMinutes: s.markoutMinutes, cohort: s.cohort, gated: s.cohort === 'blocked', gateReasons: s.gateReasons, kind: s.kind })
      }
    }
    // Open new shadow quotes for chosen markets without an active one on that side.
    for (const c of chosen) {
      const book = books.get(c.id)
      const bestBid = book?.bids?.[0]?.price ?? c.bid
      const bestAsk = book?.asks?.[0]?.price ?? c.ask
      if (!(bestAsk - bestBid >= 0.02)) continue
      const mid = (bestBid + bestAsk) / 2
      const reasons = gateOf.get(c.id) ?? []
      for (const [outcome, yesPrice] of [['YES', r2(Math.max(bestBid + 0.01, mid - 0.01))], ['NO', r2(Math.min(bestAsk - 0.01, mid + 0.01))]] as const) {
        if (yesPrice <= 0.01 || yesPrice >= 0.99) continue
        if (shadow.some((s) => !s.done && s.marketId === c.id && s.outcome === outcome)) continue
        const q: ShadowQuote = {
          id: `sq-${now}-${c.id}-${outcome}`,
          marketId: c.id,
          kind: c.kind,
          outcome,
          yesPrice,
          legCost: r2(outcome === 'YES' ? yesPrice : 1 - yesPrice),
          at: now,
          close: c.close,
          cohort: reasons.length > 0 ? 'blocked' : 'allowed',
          gateReasons: reasons,
          lastEligibleAt: now
        }
        shadow.push(q)
        stats.quotes++
        this.appendJsonl('-shadow.jsonl', { event: 'quote', id: q.id, marketId: c.id, outcome, yesPrice, legCost: q.legCost, cohort: q.cohort, gated: q.cohort === 'blocked', gateReasons: reasons, kind: c.kind, close: new Date(c.close).toISOString(), bid: bestBid, ask: bestAsk, spread: r2(c.spread * 100) })
      }
    }
    // Bound the in-memory ledger; the JSONL holds the full record.
    this.state.shadow = shadow.filter((s) => !s.done || now - s.at < 2 * 3600_000).slice(-400)
  }

  /** Cancel one quote. Returns false when the venue refused, in which case the caller keeps tracking it. */
  private async cancel(adapter: VenueAdapter, q: Quote, why: string): Promise<boolean> {
    try {
      await adapter.cancelOrder(q.orderId)
      this.state.canceled++
      this.log(`[quoter] cancel ${q.outcome} ${q.marketId} (${why})`)
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // An order the venue no longer knows is gone, not "still resting".
      if (/not[ _]found|already[ _](canceled|cancelled|executed)|404/i.test(msg)) {
        this.log(`[quoter] cancel ${q.marketId}: venue reports it gone (${msg.slice(0, 80)})`)
        return true
      }
      this.log(`[quoter] cancel ${q.marketId} FAILED, keeping it tracked: ${msg.slice(0, 120)}`)
      return false
    }
  }

  /**
   * Cancel every tracked quote; quotes whose cancel failed stay tracked for the
   * next attempt. When the venue's resting list is supplied, quotes it no
   * longer lists are dropped without a cancel call: their fills were already
   * attributed, and cancelling a gone order only burns write budget (and, if
   * the venue's error text were ever unrecognised, would keep the quote
   * tracked forever).
   */
  private async cancelAll(adapter: VenueAdapter, why: string, open?: Map<string, unknown>): Promise<void> {
    const kept: Quote[] = []
    for (const q of this.state.quotes) {
      if (open && !open.has(q.orderId)) continue
      if (!(await this.cancel(adapter, q, why))) kept.push(q)
    }
    this.state.quotes = kept
    this.persist()
  }
}
