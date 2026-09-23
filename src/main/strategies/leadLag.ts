/**
 * Cross-venue lead-lag SHADOW: Polymarket.com CLOB top of book vs Kalshi top
 * of book on the identical 15-minute crypto up/down window.
 *
 * Why the data source matters. The first version compared Kalshi's live book
 * to Gamma's `outcomePrices`, which refresh on a lag of minutes. Every flagged
 * "dislocation" (16,373 of them, median 13.5c) was Gamma standing still while
 * Kalshi moved, so the signal pointed the wrong way — and on 2026-09-03 a
 * live-enabled build tried to sweep it 1,716 times (every attempt was refused
 * by the exchange's weekly maintenance pause). This version reads the CLOB
 * order book, which is the live price, records both venues' moves since the
 * previous tick (so the log can show who actually leads), and computes the
 * Kalshi taker fee so "clears fees" is a measured fact, not a constant.
 *
 * It is a recorder. leadLagLiveEnabled stays false; a pre-registered forward
 * test grades the log before any order path is considered.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VenueAdapter } from '../../shared/venue'
import type { OrderBook, OrderResult } from '../../shared/types'
import { HttpError } from '../util/http'
import { PreSubmitRefusal } from '../engine/engine'
import { kalshiTakerFeeCentsFor } from '../util/kalshiFee'
import { PolyClobWs } from '../services/polyClobWs'

const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2'
const POLY_GAMMA_API = 'https://gamma-api.polymarket.com'
const POLY_CLOB_API = 'https://clob.polymarket.com'
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}
/**
 * DEPRECATED for order sizing. This is the taker fee in cents per contract
 * for a ONE-CONTRACT order, now delegated to the canonical fee model so it
 * returns the empirically-verified venue charge (settled to $0.0001) rather
 * than the old whole-cent ceil. 2026-09-18: the live-fill audit proved the
 * venue charges 1.75c (not 2c) at p=0.5, so the old `ceil(7*p*(1-p))`
 * overcharged even a single contract.
 *
 * Multi-contract callers must use kalshiTakerFeeCentsFor(p, contracts,
 * multiplier) from ../util/kalshiFee.
 */
export function kalshiTakerFeeCents(p: number): number {
  return kalshiTakerFeeCentsFor(p, 1)
}

export interface LeadLagConfig {
  leadLagEnabled: boolean
  leadLagLiveEnabled: boolean
  leadLagMinDislocationCents: number // default 4.0c
  leadLagMaxSpreadCents: number // default 5.0c
  leadLagMaxContractsPerOrder: number // default 3
  leadLagMaxCapitalSpend: number // default 20.00
  /** Filled contracts per Kalshi ticker per 15-minute window. The per-sweep cap bounds one order, not a poll loop. */
  leadLagMaxContractsPerWindow: number
  /** Filled spend, dollars, across ALL tickers per 15-minute window. */
  leadLagMaxSpendPerWindow: number
  /** Coins that sweep at the ladder's size and feed its pooled evidence. Default BTC/ETH. */
  leadLagProvenCoins: readonly string[]
  /** Coins scanned and eligible for trading. */
  leadLagCoins?: readonly string[]
  /** Contracts per sweep for a coin not yet proven (default 2, the ladder's entry size for this arm). */
  leadLagNewCoinContracts: number
  /**
   * Coins that may be swept in the SAME direction in one window. Seven coins on one 15-minute crypto window
   * are one directional bet; the 2026-09-13 11:00Z window held six of them, 104 contracts, and lost $20.94.
   */
  leadLagMaxCoinsPerDirectionPerWindow: number
  pollIntervalMs: number // default 5000ms
  /**
   * Trade the event-speed gaps (section 161). Off until the operator approves it after the pre-registered read
   * (docs/PREREGISTERED-leadlag-fast-shadow.md, on or after 2026-09-26): the first gap per market and side that opens
   * at FAST_LIVE_MIN_NET_CENTS or more, through the same sweep, sizes and window caps as the minute scan.
   */
  leadLagFastLive?: boolean
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
  /** Where the Polymarket price came from ('clob-book' is the live one). */
  polySource?: string
  /** 'orderbook' from 2026-09-17; rows without it priced Kalshi from the cached markets list (stale by up to ~30 s). */
  kalshiSource?: 'orderbook' | 'ws'
  /** 'fast': placed by the event-speed path from both pushed books (section 161); absent: the minute scan. */
  path?: 'fast'
  polyBid?: number
  polyAsk?: number
  /** Kalshi taker fee at the executable price, cents per contract. */
  feeCents?: number
  /** Gap minus the taker fee, cents per contract. */
  netCents?: number
  /** Price moves since the previous observation of the same window (lead/lag evidence). */
  dPolyCents?: number
  dKalshiCents?: number
  /** The CLOB WebSocket's top at decision time - shadow only (PREREGISTERED-leadlag-polyws-shadow, §131). */
  polyWs?: { bid: number; ask: number; ageMs: number; changes: number }
  /** Contracts the IOC actually filled, and the price they filled at. */
  filledContracts?: number
  fillPrice?: number
  /** Detection (quotes in hand) to venue acknowledgement, and the order round trip alone, in ms. */
  latencyMs?: number
  submitMs?: number
  /** When the Polymarket quote was read, and how old it was when the IOC was sent (audit B-33: `ts` is stamped
   *  after two further Kalshi round trips, so latencyMs alone never bounded the quote's age). */
  polyAt?: number
  polyAgeMs?: number
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
  /** Dislocations found on the last cycle (before the once-a-minute recording throttle). */
  foundLast: number
}

interface LeadLagState {
  dislocationsLogged: number
  tradesExecuted: number
  /** IOC sweeps the venue accepted that crossed nothing (0 contracts filled). */
  sweepsNoFill?: number
  lastScanAt?: number
  history: LeadLagDislocation[]
  /** UTC minute last admitted to the 60-second cadence shadow. */
  cadenceMinute?: number
  /** Per UTC day: scan cycles, and cycles in which any pair's Kalshi leg failed (backlog 170; read by 164). */
  legFailByDay?: Record<string, { cycles: number; failed: number }>
  window?: {
    epoch: number
    fills: [string, { contracts: number; spend: number }][]
    spend: number
    directions: { YES: string[]; NO: string[] }
    blocked: boolean
  }
}

interface PolyQuote {
  source: 'clob-book' | 'clob-mid'
  mid: number
  /** Wall clock when the REST body arrived: the age of this quote at the IOC is measured from here (audit B-33). */
  at: number
  /** Pushed top-of-book for the same token, when the socket has one (shadow). */
  ws?: { bid: number; ask: number; ageMs: number; changes: number }
  bid?: number
  ask?: number
  marketId: string
  /** The Polymarket Up token this quote is for (the event-speed shadow reads its pushed top by it). */
  upToken: string
}

/** What the event-speed shadow needs from a pushed Kalshi book (KalshiWsClient satisfies it). */
export interface FastBookSource {
  getBook(ticker: string): OrderBook | null
  start(tickers: string[]): void
  stop(): void
  compare(ticker: string, rest: OrderBook): void
}
export interface FastPair { ticker: string; upToken: string; end: number; marketId?: string }

/** The registered primary threshold of the fast read: net of Kalshi's one-contract fee, at the moment the gap opens. */
export const FAST_LIVE_MIN_NET_CENTS = 6

/** What the fast path needs from the trader, read at the moment of each order - never a snapshot from the last scan. */
export interface FastLive {
  /** Every gate the minute scan applies: live mode, armed, no kill, exchange open. */
  allowed(): boolean
  adapter(): VenueAdapter
  cfg(): LeadLagConfig
}

/**
 * The sweep a fast 'open' row asks for, priced exactly as the grader prices it (the Kalshi ask for YES, 1 - the bid
 * for NO, at the instant the gap opened), or null when the row is below the registered threshold or malformed.
 */
export function fastDislocation(
  r: Record<string, unknown>,
  marketId: string,
  cfg: Pick<LeadLagConfig, 'leadLagMaxContractsPerOrder' | 'leadLagProvenCoins' | 'leadLagNewCoinContracts'>,
  now: number
): { d: LeadLagDislocation; side: 'YES' | 'NO'; yesRef: number } | null {
  const side = r.side === 'YES' || r.side === 'NO' ? r.side : null
  const pm = Number(r.pm)
  const kb = Number(r.kb)
  const ka = Number(r.ka)
  const coin = String(r.c ?? '')
  if (r.ev !== 'open' || !side || !coin || typeof r.t !== 'string' || ![pm, kb, ka].every((x) => x > 0 && x < 1)) return null
  if (!(Number(r.net) >= FAST_LIVE_MIN_NET_CENTS)) return null
  const yesRef = side === 'YES' ? ka : kb
  const px = side === 'YES' ? ka : +(1 - kb).toFixed(4)
  const feeCents = kalshiTakerFeeCentsFor(px, sweepSizeFor(coin, cfg))
  const gapCents = +(100 * (side === 'YES' ? pm - ka : kb - pm)).toFixed(1)
  const d: LeadLagDislocation = {
    ts: new Date(now).toISOString(),
    underlying: coin,
    polyMarketId: marketId,
    kalshiTicker: r.t,
    polyPrice: pm,
    kalshiPrice: yesRef,
    dislocationCents: gapCents,
    suggestedAction: side === 'YES' ? 'BUY_KALSHI_YES' : 'BUY_KALSHI_NO',
    clearsFees: gapCents - feeCents > 0,
    executed: false,
    polySource: 'clob-ws',
    kalshiSource: 'ws',
    polyBid: Number(r.pb),
    polyAsk: Number(r.pa),
    feeCents,
    netCents: +(gapCents - feeCents).toFixed(1),
    polyAt: now - (Number(r.pAgeMs) || 0),
    path: 'fast'
  }
  return { d, side, yesRef }
}
export interface FastOpen { at: number; net: number; peak: number }

/**
 * Event-speed lead-lag shadow (section 159). Both books are held in memory - Polymarket's pushed top and Kalshi's
 * pushed book - so a gap is seen within 250 ms of either venue moving, where the live arm looks once a minute.
 * Returns the rows to record: 'open' when a side's gap first clears `minNetCents` after Kalshi's one-contract taker
 * fee, 'close' with its duration and peak when it falls back or the window leaves the map. Mutates `open`. Pure
 * otherwise; the engine runs it on a timer and never trades on it.
 *
 * Refuses (never opens, and closes any open gap on): the last minute of a window (the settlement average, not a
 * lag), a Polymarket top older than 5 s, a Polymarket spread over 5c, a price outside 5-95c, a missing Kalshi side.
 */
export function fastGaps(
  pairs: ReadonlyMap<string, FastPair>,
  topOf: (token: string) => { bid: number; ask: number; at: number } | undefined,
  bookOf: (ticker: string) => OrderBook | null,
  open: Map<string, FastOpen>,
  now: number,
  minNetCents: number
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  const iso = new Date(now).toISOString()
  const live = new Set<string>()
  for (const [coin, p] of pairs) {
    const pt = topOf(p.upToken)
    const kb = bookOf(p.ticker)
    const pm = pt ? (pt.bid + pt.ask) / 2 : 0
    const usable = p.end - now >= 60_000 && pt !== undefined && kb !== null && kb.bids.length > 0 && kb.asks.length > 0 &&
      now - pt.at <= 5_000 && pt.ask > pt.bid && pt.ask - pt.bid <= 0.05 + 1e-9 && pm > 0.05 && pm < 0.95
    for (const side of ['YES', 'NO'] as const) {
      const key = `${p.ticker}|${side}`
      live.add(key)
      const was = open.get(key)
      let net = -Infinity
      let px = 0
      if (usable) {
        const kBid = kb!.bids[0].price
        const kAsk = kb!.asks[0].price
        px = side === 'YES' ? kAsk : 1 - kBid
        net = 100 * (side === 'YES' ? pm - kAsk : kBid - pm) - kalshiTakerFeeCentsFor(px, 1)
      }
      if (net >= minNetCents) {
        if (!was) {
          open.set(key, { at: now, net, peak: net })
          rows.push({
            ts: iso, ev: 'open', c: coin, t: p.ticker, side, pm: +pm.toFixed(4), pb: pt!.bid, pa: pt!.ask, pAgeMs: now - pt!.at,
            kb: kb!.bids[0].price, ka: kb!.asks[0].price, kbSz: kb!.bids[0].size, kaSz: kb!.asks[0].size,
            px: +px.toFixed(4), net: +net.toFixed(2), endMs: p.end
          })
        } else if (net > was.peak) {
          was.peak = net
        }
      } else if (was) {
        open.delete(key)
        rows.push({ ts: iso, ev: 'close', c: coin, t: p.ticker, side, durMs: now - was.at, peak: +was.peak.toFixed(2), why: usable ? 'gap closed' : 'book unusable' })
      }
    }
  }
  for (const [key, was] of open) {
    if (live.has(key)) continue
    open.delete(key)
    const [t, side] = key.split('|')
    rows.push({ ts: iso, ev: 'close', t, side, durMs: now - was.at, peak: +was.peak.toFixed(2), why: 'window gone' })
  }
  return rows
}

/**
 * Every coin with a 15-minute up/down window on BOTH venues (checked 2026-09-13: Polymarket
 * `<coin>-updown-15m-<epoch>` and Kalshi `KX<COIN>15M` both open for all seven; NEAR is Kalshi-only).
 * ZEC added 2026-09-17: Kalshi KXZEC15M (CF Benchmarks ZECUSDRTI) and Polymarket zec-updown-15m (Chainlink TWAP),
 * the same settlement structure as the others; ADA, BCH, NEAR and TON have no Polymarket 15-minute twin.
 * The list was BTC and ETH for no recorded reason. Thin books exclude themselves per window through the
 * spread gate below, so nothing here is pre-judged on liquidity.
 */
export const LEADLAG_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'ZEC'] as const

/**
 * Coins whose size the ladder has earned. Everything else sweeps at the micro size until the cohort's
 * pre-registered gate (docs/PREREGISTERED-leadlag-coins.md) clears zero, and only these coins' rows feed
 * the ladder's pooled evidence - a pool cannot stop a subset, so an unproven subset stays out of it.
 */
export const LEADLAG_PROVEN_DEFAULT: readonly string[] = ['BTC', 'ETH']

/** Contracts per sweep for a coin: the ladder's size for a proven coin, the micro size for the rest. */
export function sweepSizeFor(coin: string, cfg: Pick<LeadLagConfig, 'leadLagMaxContractsPerOrder' | 'leadLagProvenCoins' | 'leadLagNewCoinContracts'>): number {
  const full = Math.max(1, cfg.leadLagMaxContractsPerOrder)
  if (cfg.leadLagProvenCoins.includes(coin)) return full
  return Math.max(1, Math.min(full, cfg.leadLagNewCoinContracts))
}

export interface LeadLagPair {
  coin: string
  pmSlug: string
  kSeries: string
}

export function leadLagPairs(windowStartEpoch: number, coins: readonly string[] = LEADLAG_COINS): LeadLagPair[] {
  return LEADLAG_COINS.filter((coin) => coins.includes(coin)).map((coin) => ({ coin, pmSlug: `${coin.toLowerCase()}-updown-15m-${windowStartEpoch}`, kSeries: `KX${coin}15M` }))
}

/**
 * May this Polymarket quote be compared against Kalshi at all? Only a two-sided CLOB book no wider than the
 * cap: the dislocation is a difference of MIDS, and a wide book's mid is noise that would read as edge. The
 * midpoint fallback (no book) fails for the same reason - it used to trade.
 */
export function polyBookTradeable(poly: { source: 'clob-book' | 'clob-mid'; bid?: number; ask?: number }, maxSpreadCents: number): { ok: boolean; why?: string } {
  if (poly.source !== 'clob-book' || poly.bid === undefined || poly.ask === undefined) return { ok: false, why: 'no book' }
  const spreadCents = (poly.ask - poly.bid) * 100
  if (spreadCents > maxSpreadCents + 1e-9) return { ok: false, why: `book ${spreadCents.toFixed(1)}c wide (max ${maxSpreadCents}c)` }
  return { ok: true }
}

/** Kalshi shard of a market row from the public list, when present. */
/**
 * Top of a public Kalshi orderbook body: YES bid is the best YES bid, YES ask is 1 - the best NO bid.
 * Undefined unless both sides have a positive-size level.
 */
export function kalshiBookTop(body: unknown): { bid: number; ask: number } | undefined {
  const fp = (body as { orderbook_fp?: { yes_dollars?: unknown; no_dollars?: unknown } } | null)?.orderbook_fp
  const best = (levels: unknown): number | undefined => {
    let top: number | undefined
    for (const l of Array.isArray(levels) ? levels : []) {
      const p = Array.isArray(l) ? parseFloat(String(l[0])) : NaN
      const q = Array.isArray(l) ? parseFloat(String(l[1])) : NaN
      if (Number.isFinite(p) && p > 0 && p < 1 && q > 0 && (top === undefined || p > top)) top = p
    }
    return top
  }
  const bid = best(fp?.yes_dollars)
  const noBid = best(fp?.no_dollars)
  if (bid === undefined || noBid === undefined) return undefined
  return { bid, ask: +(1 - noBid).toFixed(4) }
}

export function shardOf(m: unknown): number | undefined {
  const v = (m as { exchange_index?: unknown } | undefined)?.exchange_index
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
}

/** The window epoch a Polymarket 15m slug ends in, or undefined. */
export function slugEpoch(slug: string): number | undefined {
  const m = /-(\d{9,11})$/.exec(slug)
  return m ? Number(m[1]) : undefined
}

/**
 * Slug -> (up token, market id). A window's token never changes, so one Gamma lookup per pair per window
 * instead of one per poll (at 10 s and seven pairs that is 42 lookups a minute saved). Entries older than
 * the previous window are pruned each scan.
 */
export class SlugTokenCache {
  private readonly m = new Map<string, { upToken: string; marketId: string }>()
  get(slug: string): { upToken: string; marketId: string } | undefined {
    return this.m.get(slug)
  }
  set(slug: string, v: { upToken: string; marketId: string }): void {
    this.m.set(slug, v)
  }
  prune(currentEpoch: number): void {
    for (const k of this.m.keys()) {
      const e = slugEpoch(k)
      if (e === undefined || e < currentEpoch - 900) this.m.delete(k)
    }
  }
  get size(): number {
    return this.m.size
  }
}

/**
 * May one more sweep of `count` contracts at `legCost` go into this window? Per-sweep caps bound ONE order;
 * a 10 s poll over seven coins re-sweeps a persistent dislocation up to 630 times a window, and a frozen
 * reference price would look exactly like a persistent dislocation. Filled contracts per ticker and filled
 * spend across tickers are what bound that - attempts that fill nothing cost nothing.
 */
export function windowRoom(
  fills: Map<string, { contracts: number; spend: number }>,
  spendSoFar: number,
  ticker: string,
  count: number,
  legCost: number,
  cfg: Pick<LeadLagConfig, 'leadLagMaxContractsPerWindow' | 'leadLagMaxSpendPerWindow'>
): { ok: boolean; why?: string } {
  const have = fills.get(ticker) ?? { contracts: 0, spend: 0 }
  if (have.contracts + count > cfg.leadLagMaxContractsPerWindow) return { ok: false, why: `${have.contracts} of ${cfg.leadLagMaxContractsPerWindow} contracts already filled on ${ticker} this window` }
  if (spendSoFar + count * legCost > cfg.leadLagMaxSpendPerWindow) return { ok: false, why: `$${spendSoFar.toFixed(2)} of $${cfg.leadLagMaxSpendPerWindow.toFixed(2)} already spent this window` }
  return { ok: true }
}

export class LeadLagEngine {
  private state: LeadLagState = {
    dislocationsLogged: 0,
    tradesExecuted: 0,
    history: []
  }
  private running = false
  private note = 'idle'
  private lastDislocation: LeadLagDislocation | null = null
  /** Previous observation per Kalshi ticker: who moved since last time. */
  private prev = new Map<string, { poly: number; kalshi: number; at: number }>()
  private readonly slugCache = new SlugTokenCache()
  /** Last time a dislocation was recorded per (ticker, action): at most one a minute, clearing or not. */
  private lastNoted = new Map<string, number>()
  /** Window exposure: filled contracts per ticker and filled spend across tickers, reset when the window turns. */
  private windowEpoch = Math.floor(Date.now() / 900_000) * 900
  private windowFills = new Map<string, { contracts: number; spend: number }>()
  private windowSpend = 0
  private windowCapLogged = new Set<string>()
  /** Coins swept per direction this window; reserved before the venue call, released on throw or zero fill. */
  private windowDir: { YES: Set<string>; NO: Set<string> } = { YES: new Set(), NO: new Set() }
  private windowBlocked = false
  private lastKalshiFailLogAt = 0
  private lastErrorLogAt = 0
  private foundLast = 0

  constructor(
    private readonly path: string,
    private readonly log: (s: string) => void = console.log,
    shadowFeed = false
  ) {
    this.polyWs = shadowFeed ? new PolyClobWs((s) => this.log(s)) : null
    try {
      if (existsSync(path)) {
        this.state = { ...this.state, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<LeadLagState>) }
        const w = this.state.window
        // Legacy files contain no recoverable reservations. Observe until the
        // next window on upgrade rather than grant an already-spent budget.
        if (!w) {
          this.windowBlocked = true
          this.log(`[leadlag] legacy window ledger; entries held until ${new Date((this.windowEpoch + 900) * 1000).toISOString()}`)
        }
        else if (!Number.isSafeInteger(w.epoch) || w.epoch > this.windowEpoch) throw new Error('Invalid window epoch')
        else if (w.epoch === this.windowEpoch) {
          if (!Number.isFinite(w.spend) || w.spend < 0 || !Array.isArray(w.fills) ||
              w.fills.some(([, f]) => !Number.isFinite(f.contracts) || f.contracts < 0 || !Number.isFinite(f.spend) || f.spend < 0) ||
              !Array.isArray(w.directions?.YES) || !Array.isArray(w.directions?.NO)) throw new Error('Invalid window ledger')
          this.windowFills = new Map(w.fills)
          this.windowSpend = w.spend
          this.windowDir = { YES: new Set(w.directions.YES), NO: new Set(w.directions.NO) }
          this.windowBlocked = w.blocked === true
        }
      }
    } catch {
      this.windowBlocked = true
      this.log('[leadlag] unreadable window ledger; entries held until the next window')
    }
  }

  status(cfg: LeadLagConfig): LeadLagStatus {
    return {
      enabled: cfg.leadLagEnabled,
      liveEnabled: cfg.leadLagLiveEnabled,
      active: this.running,
      dislocationsLogged: this.state.dislocationsLogged,
      tradesExecuted: this.state.tradesExecuted,
      lastDislocation: this.lastDislocation,
      lastScanAt: this.state.lastScanAt,
      note: this.note,
      foundLast: this.foundLast
    }
  }

  private persist(): boolean {
    try {
      this.state.window = {
        epoch: this.windowEpoch, fills: [...this.windowFills], spend: this.windowSpend,
        directions: { YES: [...this.windowDir.YES], NO: [...this.windowDir.NO] }, blocked: this.windowBlocked
      }
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = this.path + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', flush: true })
      renameSync(tmp, this.path)
      return true
    } catch (e) {
      this.log('[leadlag] persist failed: ' + (e instanceof Error ? e.message : String(e)))
      return false
    }
  }

  /** Window ledger delta, in contracts and dollars; negative releases. Never below zero. */
  private adjustWindow(ticker: string, contracts: number, dollars: number): void {
    const had = this.windowFills.get(ticker) ?? { contracts: 0, spend: 0 }
    this.windowFills.set(ticker, { contracts: Math.max(0, had.contracts + contracts), spend: Math.max(0, had.spend + dollars) })
    this.windowSpend = Math.max(0, this.windowSpend + dollars)
  }

  /**
   * Record and log a dislocation at most once a minute per (ticker, action), clearing or not: at a 10 s
   * poll the same gap would otherwise be written six times a minute per pair, and a clearing one that keeps
   * failing to fill is the documented flood case. The SWEEP decision does not pass through here, and the
   * executed rows the ladder counts are appended by sweep() itself, so this trims only repetition.
   */
  private worthNoting(d: LeadLagDislocation, now: number): boolean {
    const k = `${d.kalshiTicker}|${d.suggestedAction}`
    const last = this.lastNoted.get(k) ?? 0
    if (now - last < 60_000) return false
    this.lastNoted.set(k, now)
    if (this.lastNoted.size > 256) {
      for (const [kk, t] of this.lastNoted) if (now - t > 3600_000) this.lastNoted.delete(kk)
    }
    return true
  }

  private recordDislocation(d: LeadLagDislocation): void {
    this.lastDislocation = d
    this.state.dislocationsLogged++
    this.state.history = [d, ...this.state.history.slice(0, 49)]
    this.appendRow(d)
  }

  /**
   * One JSON line per dislocation and one more when its sweep executes. The
   * ladder counts a strategy's trades from the `executed` rows of this file;
   * until 2026-09-07 the flag was only ever set in memory, so 393 sweeps in a
   * night counted as zero and lead-lag could never reach a checkpoint.
   */
  private appendRow(d: LeadLagDislocation): void {
    try {
      const logFile = this.path.replace(/\.json$/, '') + '-dislocations.jsonl'
      appendFileSync(logFile, JSON.stringify(d) + '\n')
    } catch (e) {
      this.log('[leadlag] log failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /**
   * Shadow quote row, every observed pair on every scan: Polymarket, the live Kalshi book and the Kalshi LIST quote.
   * Nothing reads it at runtime. It exists so the pre-round-116 mechanism - an IOC at the list's 20-40 s old price,
   * which fills only when a Kalshi order has not caught up with a move - can be graded offline against what the arm
   * does now (REVIEW-CHANGES section 156). Compact keys: the file gains ~11k rows a day.
   */
  private appendQuoteRow(row: Record<string, unknown>): void {
    try {
      appendFileSync(this.path.replace(/\.json$/, '') + '-quotes-shadow.jsonl', JSON.stringify(row) + '\n')
    } catch (e) {
      this.log('[leadlag] quote shadow log failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /** Paired signal-only evidence: every clearing observation is the 10 s arm; one scan per UTC minute is also the 60 s arm. */
  private appendCadenceRow(d: LeadLagDislocation, sample60: boolean, pollIntervalMs: number): void {
    try {
      const logFile = this.path.replace(/\.json$/, '') + '-cadence-shadow.jsonl'
      appendFileSync(logFile, JSON.stringify({
        ts: d.ts, underlying: d.underlying, kalshiTicker: d.kalshiTicker,
        suggestedAction: d.suggestedAction, kalshiPrice: d.kalshiPrice,
        feeCents: d.feeCents, netCents: d.netCents, sample60, pollIntervalMs
      }) + '\n')
    } catch (e) {
      this.log('[leadlag] cadence shadow log failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /** Live Polymarket price for the window: CLOB book first, CLOB midpoint second, never Gamma's stale outcomePrices. */
  /** Slug -> (up token, market id), from the cache when the window has been seen, else one Gamma lookup. */
  /** Slugs refused for their outcomes array, so a standing refusal logs once and not every 10 s poll. */
  private slugRefused = new Set<string>()

  private async resolveSlug(slug: string): Promise<{ upToken: string; marketId: string } | null> {
    const cached = this.slugCache.get(slug)
    if (cached) return cached
    let pmRes: Response
    try {
      pmRes = await fetch(`${POLY_GAMMA_API}/events?slug=${slug}`, { signal: AbortSignal.timeout(6000) })
    } catch {
      return null
    }
    if (!pmRes.ok) return null
    let pmData: unknown
    try {
      pmData = (await pmRes.json()) as unknown
    } catch {
      return null
    }
    const pmEvent = Array.isArray(pmData) ? pmData[0] : pmData
    const pmMarket = (pmEvent as { markets?: Record<string, unknown>[] } | undefined)?.markets?.[0]
    if (!pmMarket) return null
    let tokenIds: string[] = []
    try {
      const raw = pmMarket.clobTokenIds
      tokenIds = typeof raw === 'string' ? (JSON.parse(raw) as string[]) : Array.isArray(raw) ? (raw as string[]) : []
    } catch {
      tokenIds = []
    }
    // Which token is "Up" comes from the market's own outcomes array, never from position: a market listed
    // ["Down","Up"] would invert every gap computed on it - the arm would buy the wrong Kalshi side at real money
    // and it would read as one more slightly negative market (external review GLM 5.3, F-06). Gamma lists
    // ["Up","Down"] today (checked 2026-09-19); a market that names no Up outcome is skipped, not guessed.
    let outcomes: string[] = []
    try {
      const rawO = pmMarket.outcomes
      outcomes = typeof rawO === 'string' ? (JSON.parse(rawO) as string[]) : Array.isArray(rawO) ? (rawO as string[]) : []
    } catch {
      outcomes = []
    }
    const upIdx = outcomes.findIndex((o) => /^up$/i.test(String(o).trim()))
    if (upIdx < 0 || outcomes.length !== tokenIds.length) {
      if (!this.slugRefused.has(slug)) {
        this.slugRefused.add(slug)
        this.log(`[leadlag] ${slug}: outcomes ${JSON.stringify(outcomes)} do not identify the Up token among ${tokenIds.length}; pair skipped`)
      }
      return null
    }
    const upToken = tokenIds[upIdx]
    if (!upToken) return null
    const resolved = { upToken, marketId: String(pmMarket.id ?? slug) }
    this.slugCache.set(slug, resolved)
    return resolved
  }

  /** Tokens seen this scan; the socket is (re)subscribed to them at the start of the next one. */
  private wsTokens = new Set<string>()
  /**
   * Shadow feed, opt-in from production only (`shadowFeed` in the constructor): a test that drives a scan with
   * mocked fetches must never open a real socket - an open socket and its ping timer keep the process alive,
   * and the review suite hung on exactly that on 2026-09-19.
   */
  private readonly polyWs: PolyClobWs | null

  /** Event-speed shadow: each coin's current window, the second Kalshi book client, and the gaps now open (section 159). */
  private fastPairs = new Map<string, FastPair>()
  private fast: { books: FastBookSource; timer: ReturnType<typeof setInterval>; open: Map<string, FastOpen>; minNet: number } | null = null
  /** Set only when the trader hands the fast path its live gates; trading still needs `leadLagFastLive`. */
  private fastLive: FastLive | null = null
  private fastShard = new Map<string, number | undefined>()
  /** `ticker|side` already attempted: the registered decision unit is the first gap per market and side. */
  private fastTried = new Set<string>()

  /**
   * Start the event-speed shadow. Needs the Polymarket socket (this engine's own) and a pushed Kalshi book client.
   * Records to `<state>-fast-shadow.jsonl`; never trades. `minNetCents` is deliberately below the live 6c floor so the
   * read can choose a threshold from the data.
   */
  attachFastShadow(books: FastBookSource, minNetCents = 2, live?: FastLive): void {
    if (this.fast || !this.polyWs) return
    const open = new Map<string, FastOpen>()
    this.fastLive = live ?? null
    const timer = setInterval(() => this.fastTick(Date.now()), 250)
    timer.unref?.()
    this.fast = { books, timer, open, minNet: minNetCents }
    this.log(`[leadlag] event-speed shadow on: both books in memory, checked every 250 ms, gaps from ${minNetCents}c net`)
  }

  /** One pass of the event-speed path: record every gap row, and trade a qualifying 'open' when the switch is on. */
  fastTick(now: number): void {
    const f = this.fast
    if (!f || !this.polyWs) return
    const rows = fastGaps(this.fastPairs, (tk) => this.polyWs?.top(tk), (t) => f.books.getBook(t), f.open, now, f.minNet)
    for (const r of rows) {
      this.appendFastRow(r)
      if (this.fastLive && r.ev === 'open' && Number(r.net) >= FAST_LIVE_MIN_NET_CENTS) void this.fastTrade(r, now)
    }
  }

  private async fastTrade(r: Record<string, unknown>, now: number): Promise<void> {
    const live = this.fastLive
    if (!live) return
    try {
      const cfg = live.cfg()
      if (!cfg.leadLagFastLive || !cfg.leadLagLiveEnabled || !cfg.leadLagEnabled || this.windowBlocked) return
      const key = `${r.t}|${r.side}`
      if (this.fastTried.has(key) || !live.allowed()) return
      const pair = [...this.fastPairs.values()].find((p) => p.ticker === r.t)
      if (!pair || pair.end - now < 60_000) return
      const plan = fastDislocation(r, pair.marketId ?? '', cfg, now)
      if (!plan || !plan.d.clearsFees) return
      this.fastTried.add(key)
      await this.sweep(live.adapter(), plan.d, plan.side, plan.yesRef, cfg, this.fastShard.get(pair.ticker))
    } catch (e) {
      this.log(`[leadlag] fast trade error on ${String(r.t)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private appendFastRow(row: Record<string, unknown>): void {
    try {
      appendFileSync(this.path.replace(/\.json$/, '') + '-fast-shadow.jsonl', JSON.stringify(row) + '\n')
    } catch (e) {
      this.log('[leadlag] fast shadow log failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  private wsTop(upToken: string): PolyQuote['ws'] {
    const t = this.polyWs?.top(upToken)
    return t ? { bid: t.bid, ask: t.ask, ageMs: Math.max(0, Date.now() - t.at), changes: t.changes } : undefined
  }

  private async polyQuote(slug: string): Promise<PolyQuote | null> {
    const resolved = await this.resolveSlug(slug)
    if (!resolved) return null
    const { upToken, marketId } = resolved
    this.wsTokens.add(upToken)
    // The socket top is snapshotted AFTER the REST round trip, not before it: the pre-registered agreement read
    // compares the two at the same instant, and a snapshot taken before a 150-400 ms fetch was one top earlier
    // on a token that moves every few seconds (audit 2026-09-19, B-32).
    let ws: PolyQuote['ws']
    try {
      const bookRes = await fetch(`${POLY_CLOB_API}/book?token_id=${encodeURIComponent(upToken)}`, { signal: AbortSignal.timeout(6000) })
      ws = this.wsTop(upToken)
      const at = Date.now()
      if (bookRes.ok) {
        const book = (await bookRes.json()) as { bids?: { price?: string; size?: string }[]; asks?: { price?: string; size?: string }[] }
        const bids = (book.bids ?? []).map((l) => num(l.price)).filter((p): p is number => p !== null)
        const asks = (book.asks ?? []).map((l) => num(l.price)).filter((p): p is number => p !== null)
        if (bids.length && asks.length) {
          const bid = Math.max(...bids)
          const ask = Math.min(...asks)
          if (ask > bid) return { source: 'clob-book', mid: (bid + ask) / 2, bid, ask, marketId, upToken, ws, at }
        }
      }
    } catch {
      // fall through to the midpoint endpoint
    }
    try {
      const midRes = await fetch(`${POLY_CLOB_API}/midpoint?token_id=${encodeURIComponent(upToken)}`, { signal: AbortSignal.timeout(6000) })
      ws = this.wsTop(upToken)
      const at = Date.now()
      if (!midRes.ok) return null
      const mid = num(((await midRes.json()) as { mid?: string }).mid)
      if (mid === null) return null
      return { source: 'clob-mid', mid, marketId, upToken, ws, at }
    } catch {
      return null
    }
  }

  /**
   * Compare the Polymarket CLOB to Kalshi's resting quotes on the identical
   * 15-minute contract and record every gap that exceeds the threshold.
   */
  /**
   * Kalshi tickers this arm holds or held within the last two hours: the sweep's fills settle 15 minutes after
   * entry and the venue lists them until then. The trader's orphan sweep and its per-market guard read this
   * (audit 2026-09-19, B-27/B-28).
   */
  heldTickers(now = Date.now()): Set<string> {
    const out = new Set<string>()
    for (const [ticker, f] of this.windowFills) if (f.contracts > 0) out.add(ticker)
    for (const r of this.state.history) {
      if (r.executed && (r.filledContracts ?? 0) > 0 && now - Date.parse(r.ts) < 2 * 60 * 60_000) out.add(r.kalshiTicker)
    }
    return out
  }

  async scanAndSweep(
    adapter: VenueAdapter,
    cfg: LeadLagConfig,
    mode: 'paper' | 'live',
    armed: boolean,
    killed: boolean,
    /** Exchange trading paused (weekly maintenance): observe nothing, place nothing. */
    paused = false,
    /** A market another arm holds or rests on: never cross it (Kalshi nets the two into one signed position). */
    heldElsewhere: (ticker: string) => boolean = () => false
  ): Promise<void> {
    if (this.running || !cfg.leadLagEnabled) return
    if (paused) {
      this.note = 'exchange trading paused; not scanning'
      return
    }
    this.running = true
    const now = Date.now()

    try {
      this.state.lastScanAt = now
      const cadenceMinute = Math.floor(now / 60_000)
      const sample60 = this.state.cadenceMinute !== cadenceMinute
      this.state.cadenceMinute = cadenceMinute
      let foundDislocations = 0
      let pairsObserved = 0
      let wide = 0
      let noPoly = 0
      let extreme = 0
      let kalshiFail = 0
      let noMarket = 0
      let noQuote = 0
      let errors = 0

      const windowStartEpoch = Math.floor(now / 900_000) * 900
      const windowEndMs = (windowStartEpoch + 900) * 1000

      const pairs = leadLagPairs(windowStartEpoch, cfg.leadLagCoins)
      this.slugCache.prune(windowStartEpoch)
      // Shadow feed: subscribe the socket to the tokens the previous scan resolved (one-scan lag on a window roll).
      if (this.polyWs && this.wsTokens.size) this.polyWs.ensure([...this.wsTokens])
      this.wsTokens = new Set()
      if (this.polyWs && this.polyWs.stats.attempts > 0) {
        const s = this.polyWs.stats
        this.log(`[leadlag] poly ws: ${s.connected ? 'connected' : 'down'}, ${s.subscribed} tokens, ${s.books} books, ${s.priceChanges} changes, ${s.reconnects} reconnects${s.lastError ? `, last error ${s.lastError.slice(0, 60)}` : ''}`)
      }
      if (this.windowEpoch !== windowStartEpoch) {
        this.windowEpoch = windowStartEpoch
        this.windowFills = new Map()
        this.windowSpend = 0
        this.windowCapLogged = new Set()
        this.windowDir = { YES: new Set(), NO: new Set() }
        this.windowBlocked = false
      }

      // All pairs at once: seven sequential pairs at three round trips each would not fit the poll interval.
      // Each pair is contained in its own try/catch and the batch is allSettled: one coin's bad body must
      // cost that coin's turn, never the batch. The review reproduced the other shape - a rejected batch
      // released the running guard while another pair's sweep was in flight, and the next cycle swept the
      // same edge again.
      await Promise.allSettled(pairs.map(async (pair) => {
        try {
        const poly = await this.polyQuote(pair.pmSlug)
        if (!poly) {
          noPoly++
          return
        }
        if (poly.mid <= 0.05 || poly.mid >= 0.95) {
          extreme++
          return
        }
        const book = polyBookTradeable(poly, cfg.leadLagMaxSpreadCents)
        if (!book.ok) {
          wide++
          return
        }

        let kData: { markets?: Record<string, unknown>[] }
        try {
          const kRes = await fetch(`${KALSHI_API}/markets?series_ticker=${pair.kSeries}&status=open&limit=20`, {
            signal: AbortSignal.timeout(6000)
          })
          if (!kRes.ok) {
            kalshiFail++
            return
          }
          kData = (await kRes.json()) as { markets?: Record<string, unknown>[] }
        } catch {
          kalshiFail++
          return
        }
        const kalshiMarket = (kData.markets ?? []).find((m) => Date.parse(String(m.close_time)) === windowEndMs)
        if (!kalshiMarket) {
          noMarket++
          return
        }

        // The quote comes from the live orderbook, never the list: /markets?series_ticker= is served from a cache
        // (2026-09-17, side by side: the list held 74/73c for 18 s while the book and the tape moved 76c -> 82c), and
        // the stale list price made most recorded gaps phantom - IOCs at the "ask" found the market 10c away.
        const ticker = String(kalshiMarket.ticker)
        let top: { bid: number; ask: number } | undefined
        try {
          const bRes = await fetch(`${KALSHI_API}/markets/${encodeURIComponent(ticker)}/orderbook?depth=1`, {
            signal: AbortSignal.timeout(6000)
          })
          if (!bRes.ok) {
            kalshiFail++
            return
          }
          top = kalshiBookTop(await bRes.json())
        } catch {
          kalshiFail++
          return
        }
        if (!top) {
          noQuote++
          return
        }
        const kYesBid = top.bid
        const kYesAsk = top.ask
        pairsObserved++
        // Event-speed shadow: remember this coin's window, and let the second book client check itself against the
        // REST top it would otherwise never see (it cannot read its books until the price convention is settled).
        this.fastPairs.set(pair.coin, { ticker, upToken: poly.upToken, end: windowEndMs, marketId: poly.marketId })
        this.fastShard.set(ticker, shardOf(kalshiMarket))
        this.fast?.books.compare(ticker, { venue: 'kalshi', marketId: ticker, bids: [{ price: kYesBid, size: 0 }], asks: [{ price: kYesAsk, size: 0 }] })

        // Lead/lag evidence: which venue moved since the previous look at this window.
        const kMid = (kYesBid + kYesAsk) / 2
        const before = this.prev.get(ticker)
        const dPolyCents = before ? +((poly.mid - before.poly) * 100).toFixed(1) : undefined
        const dKalshiCents = before ? +((kMid - before.kalshi) * 100).toFixed(1) : undefined
        this.prev.set(ticker, { poly: poly.mid, kalshi: kMid, at: now })
        if (this.prev.size > 64) {
          for (const [k, v] of this.prev) if (now - v.at > 3600_000) this.prev.delete(k)
        }
        // Shadow only: the list quote is still in hand from the ticker lookup above, so record it next to the book.
        const listBid = Number(kalshiMarket.yes_bid_dollars)
        const listAsk = Number(kalshiMarket.yes_ask_dollars)
        this.appendQuoteRow({
          ts: new Date(now).toISOString(), c: pair.coin, t: ticker, end: windowEndMs,
          pm: +poly.mid.toFixed(4), pb: poly.bid, pa: poly.ask, bb: kYesBid, ba: kYesAsk,
          lb: Number.isFinite(listBid) ? listBid : null, la: Number.isFinite(listAsk) ? listAsk : null
        })

        const threshold = cfg.leadLagMinDislocationCents / 100
        const canTrade = mode === 'live' && armed && !killed && cfg.leadLagLiveEnabled

        if (poly.mid - kYesAsk >= threshold) {
          // Polymarket above Kalshi's ask: the Kalshi YES ask looks cheap.
          foundDislocations++
          const feeCents = kalshiTakerFeeCentsFor(kYesAsk, sweepSizeFor(pair.coin, cfg))
          const gapCents = +((poly.mid - kYesAsk) * 100).toFixed(1)
          const netCents = +(gapCents - feeCents).toFixed(1)
          const d: LeadLagDislocation = {
            ts: new Date().toISOString(),
            underlying: pair.coin,
            polyMarketId: poly.marketId,
            kalshiTicker: ticker,
            polyPrice: poly.mid,
            kalshiPrice: kYesAsk,
            dislocationCents: gapCents,
            suggestedAction: 'BUY_KALSHI_YES',
            clearsFees: netCents > 0,
            executed: false,
            polySource: poly.source,
            kalshiSource: 'orderbook',
            polyBid: poly.bid,
            polyAsk: poly.ask,
            feeCents,
            netCents,
            dPolyCents,
            dKalshiCents,
            polyWs: poly.ws,
            polyAt: poly.at
          }
          if (d.clearsFees) this.appendCadenceRow(d, sample60, cfg.pollIntervalMs)
          if (this.worthNoting(d, now)) {
            this.recordDislocation(d)
            this.log(`[leadlag] DISLOCATION ${pair.coin} 15m: CLOB ${(poly.mid * 100).toFixed(1)}c vs Kalshi ask ${(kYesAsk * 100).toFixed(1)}c (+${gapCents}c, net ${netCents}c after fee)`)
          }
          if (canTrade && d.clearsFees && !heldElsewhere(ticker)) await this.sweep(adapter, d, 'YES', kYesAsk, cfg, shardOf(kalshiMarket))
        } else if (kYesBid - poly.mid >= threshold) {
          // Polymarket below Kalshi's bid: the Kalshi YES bid looks rich; buying NO at 1 − bid.
          foundDislocations++
          const noCost = +(1 - kYesBid).toFixed(4)
          const feeCents = kalshiTakerFeeCentsFor(noCost, sweepSizeFor(pair.coin, cfg))
          const gapCents = +((kYesBid - poly.mid) * 100).toFixed(1)
          const netCents = +(gapCents - feeCents).toFixed(1)
          const d: LeadLagDislocation = {
            ts: new Date().toISOString(),
            underlying: pair.coin,
            polyMarketId: poly.marketId,
            kalshiTicker: ticker,
            polyPrice: poly.mid,
            kalshiPrice: kYesBid,
            dislocationCents: gapCents,
            suggestedAction: 'BUY_KALSHI_NO',
            clearsFees: netCents > 0,
            executed: false,
            polySource: poly.source,
            kalshiSource: 'orderbook',
            polyBid: poly.bid,
            polyAsk: poly.ask,
            feeCents,
            netCents,
            dPolyCents,
            dKalshiCents,
            polyWs: poly.ws,
            polyAt: poly.at
          }
          if (d.clearsFees) this.appendCadenceRow(d, sample60, cfg.pollIntervalMs)
          if (this.worthNoting(d, now)) {
            this.recordDislocation(d)
            this.log(`[leadlag] DISLOCATION ${pair.coin} 15m: CLOB ${(poly.mid * 100).toFixed(1)}c vs Kalshi bid ${(kYesBid * 100).toFixed(1)}c (+${gapCents}c, net ${netCents}c after fee)`)
          }
          if (canTrade && d.clearsFees && !heldElsewhere(ticker)) await this.sweep(adapter, d, 'NO', kYesBid, cfg, shardOf(kalshiMarket))
        }
        } catch (e) {
          errors++
          if (now - this.lastErrorLogAt > 60_000) {
            this.lastErrorLogAt = now
            this.log(`[leadlag] ${pair.coin} pair error (contained): ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }))

      const day = new Date(now).toISOString().slice(0, 10)
      const tally = ((this.state.legFailByDay ??= {})[day] ??= { cycles: 0, failed: 0 })
      tally.cycles++
      if (kalshiFail > 0) tally.failed++
      for (const d of Object.keys(this.state.legFailByDay)) if (d < new Date(now - 30 * 86_400_000).toISOString().slice(0, 10)) delete this.state.legFailByDay[d]
      if (kalshiFail > 0 && now - this.lastKalshiFailLogAt > 60_000) {
        this.lastKalshiFailLogAt = now
        this.log(`[leadlag] Kalshi leg failed for ${kalshiFail} of ${pairs.length} pairs this cycle`)
      }
      // Event-speed shadow: drop past windows and point the second Kalshi book client at this window's tickers.
      for (const [c, p] of this.fastPairs) if (p.end <= now) this.fastPairs.delete(c)
      const liveTickers = new Set([...this.fastPairs.values()].map((p) => p.ticker))
      for (const t of this.fastShard.keys()) if (!liveTickers.has(t)) this.fastShard.delete(t)
      for (const k of this.fastTried) if (!liveTickers.has(k.split('|')[0])) this.fastTried.delete(k)
      if (this.fast) {
        const tickers = [...this.fastPairs.values()].map((p) => p.ticker)
        if (tickers.length) this.fast.books.start(tickers)
      }
      this.foundLast = foundDislocations
      // Every pair lands in exactly one bucket, so this adds up to the pair count.
      this.note = `scanned ${pairs.length} 15m crypto pairs (${pairsObserved} live CLOB books), found ${foundDislocations} dislocations; skipped: ${wide} wide/no Polymarket book, ${noPoly} no Polymarket quote, ${extreme} Polymarket price outside 5-95c, ${kalshiFail} Kalshi fetch failed, ${noMarket} no Kalshi market, ${noQuote} no Kalshi quote, ${errors} errors`
    } catch (e) {
      this.note = 'scan failed: ' + (e instanceof Error ? e.message : String(e))
      this.log('[leadlag] error: ' + this.note)
    } finally {
      this.persist()
      this.running = false
    }
  }

  /**
   * Live sweep. Reachable whenever `leadLagLiveEnabled` is set, which it IS — this arm is the only one at
   * ladder stage `live` and is spending real money. (The previous comment here said the flag was "hard-coded
   * off", which stopped being true when the arm was promoted; a stale safety comment in a money path is
   * worse than none, because it invites exactly the assumption it used to justify.)
   */
  private async sweep(adapter: VenueAdapter, d: LeadLagDislocation, side: 'YES' | 'NO', yesRef: number, cfg: LeadLagConfig, exchangeIndex?: number): Promise<void> {
    try {
      if (this.windowBlocked) return
      // Micro size for a coin the ladder has not judged (round 93): round 91 gave five untested coins the
      // size BTC/ETH earned, which is the opposite of the ladder's own rule.
      const count = sweepSizeFor(d.underlying, cfg)
      // Kalshi quotes everything on the YES leg: buying NO crosses the YES bid.
      const limit = side === 'YES' ? Math.min(0.99, +(yesRef + 0.01).toFixed(2)) : Math.max(0.01, +(yesRef - 0.01).toFixed(2))
      const legCost = side === 'YES' ? limit : 1 - limit
      if (count * legCost > cfg.leadLagMaxCapitalSpend) {
        this.log(`[leadlag] sweep skipped on ${d.kalshiTicker}: $${(count * legCost).toFixed(2)} exceeds cap $${cfg.leadLagMaxCapitalSpend.toFixed(2)}`)
        return
      }
      // Per-ticker window room is three sweeps AT THIS COIN'S SIZE, never more than the configured cap.
      const room = windowRoom(this.windowFills, this.windowSpend, d.kalshiTicker, count, legCost, { ...cfg, leadLagMaxContractsPerWindow: Math.min(cfg.leadLagMaxContractsPerWindow, 3 * count) })
      if (!room.ok) {
        if (!this.windowCapLogged.has(d.kalshiTicker)) {
          this.windowCapLogged.add(d.kalshiTicker)
          this.log(`[leadlag] sweep held on ${d.kalshiTicker}: window cap - ${room.why}`)
        }
        return
      }
      // Direction concentration: a coin not yet swept this way this window needs a free seat. Same
      // check-then-reserve discipline as the spend cap - the seat is taken before the await.
      const dir = this.windowDir[side]
      const newSeat = !dir.has(d.underlying)
      if (newSeat && dir.size >= cfg.leadLagMaxCoinsPerDirectionPerWindow) {
        const k = `${side}|dir`
        if (!this.windowCapLogged.has(k)) {
          this.windowCapLogged.add(k)
          this.log(`[leadlag] sweep held on ${d.kalshiTicker}: ${dir.size} coins already ${side} this window (max ${cfg.leadLagMaxCoinsPerDirectionPerWindow}: ${[...dir].join(' ')})`)
        }
        return
      }
      if (newSeat) dir.add(d.underlying)
      // RESERVE the full requested size now, with no await between the check and this write: seven pairs
      // sweep concurrently, and a check that is only debited after the order returns let every pair pass
      // against the same untouched total (the re-review placed seven orders past a $6 cap that way). The
      // reservation is persisted BEFORE submission and reconciled to the fill.
      this.adjustWindow(d.kalshiTicker, count, count * legCost)
      if (!this.persist()) {
        this.adjustWindow(d.kalshiTicker, -count, -(count * legCost))
        if (newSeat) dir.delete(d.underlying)
        return
      }
      let res: OrderResult
      const submitAt = Date.now()
      if (d.polyAt !== undefined) d.polyAgeMs = submitAt - d.polyAt
      try {
        res = await adapter.placeOrder({
        venue: 'kalshi',
        exchangeIndex,
        marketId: d.kalshiTicker,
        outcome: side,
        amount: count * legCost,
        contracts: count,
        limitPrice: limit,
        timeInForce: 'immediate_or_cancel',
        ref: 'leadlag'
      })
      } catch (e) {
        // A timeout/5xx may conceal a fill. Keep its budget and direction seat
        // for the rest of this window, including across a restart. Only an
        // explicit rejection proves that the reservation can be released.
        // A PreSubmitRefusal (stake cap, position cap, cap-read failure, journal) is thrown before any POST:
        // nothing can have filled, so the window's budget and direction seat go straight back (audit B-58).
        if (e instanceof PreSubmitRefusal || (e instanceof HttpError && [400, 401, 403, 404, 422, 429].includes(e.status))) {
          this.adjustWindow(d.kalshiTicker, -count, -(count * legCost))
          if (newSeat) dir.delete(d.underlying)
        } else {
          this.log(`[leadlag] uncertain order on ${d.kalshiTicker}; window reservation retained`)
        }
        this.persist()
        throw e
      }
      // Reconcile the reservation to the fill: a zero fill costs nothing, a partial fill holds only what it
      // used, and the spend is the REALIZED average price, not the limit the IOC was sent at.
      const ackAt = Date.now()
      d.latencyMs = ackAt - (Date.parse(d.ts) || submitAt)
      d.submitMs = ackAt - submitAt
      const filled = res.shares > 0 ? res.shares : 0
      const paid = filled * (res.avgPrice > 0 ? res.avgPrice : legCost)
      this.adjustWindow(d.kalshiTicker, filled - count, paid - count * legCost)
      // An IOC the venue accepts but that crosses nothing fills ZERO
      // contracts. Calling that "executed" wrote 331 phantom trades into the
      // research ledger in eight hours (2026-09-08: 358 SWEEP EXECUTED lines,
      // 2 venue fills), and the ladder builds this arm's evidence from the
      // executed tickers - so it was crediting settlements of markets the
      // sweep never held. The adapter already reports the truth in `shares`.
      if (!(res.shares > 0)) {
        this.state.sweepsNoFill = (this.state.sweepsNoFill ?? 0) + 1
        // A seat is for a position held, not for an attempt that crossed nothing.
        if (newSeat) dir.delete(d.underlying)
        return
      }
      d.executed = true
      d.filledContracts = res.shares
      d.fillPrice = res.avgPrice
      this.state.tradesExecuted++
      this.appendRow(d)
      this.log(`[leadlag] SWEEP EXECUTED: bought ${side} on ${d.kalshiTicker} x${res.shares} @ ${(res.avgPrice * 100).toFixed(1)}c in ${d.latencyMs}ms (order ${d.submitMs}ms)`)
    } catch (e) {
      this.log(`[leadlag] sweep error on ${d.kalshiTicker}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.persist()
    }
  }
}
