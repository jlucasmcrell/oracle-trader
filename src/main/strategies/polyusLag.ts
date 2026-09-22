/**
 * Kalshi leads Polymarket US in play (REVIEW-CHANGES section 160, docs/PREREGISTERED-polyus-lag.md).
 *
 * Polymarket US is a slow venue: its top of book is unchanged in ~92% of 60-second cycles, 63% in play. When Kalshi's
 * price for a team moves between two consecutive cycles and Polymarket US's has not, Polymarket US is still quoting
 * the old game state, and buying the side Kalshi moved toward earns the gap as it catches up (over minutes, not
 * milliseconds - so a 60-second loop is fast enough). Measured on 5 days of both books with every market resolved
 * from Kalshi's public results, taking each game's FIRST qualifying trigger as the trader does (one position per
 * market, held): Kalshi move >= 8c, +14.9c/contract [+0.1, +28.9] over 38 games. At 5c the per-trigger +10.3c came
 * from re-entering the same game; first-per-game it is +4.0c [-7.1, +14.8], so 5c is not the registered rule.
 *
 * Pure functions only: the game matcher (a port of scripts/sports-books.mjs's section-122 matcher, which the recorder
 * has run since 2026-09-18) and the trigger rule. The loop that feeds them lives with the Polymarket US trader.
 */

/** Polymarket US slug prefix (aec-<sport>-...) -> Kalshi game series. */
export const POLYUS_SPORT: Readonly<Record<string, string>> = {
  nfl: 'KXNFLGAME', cfb: 'KXNCAAFGAME', mlb: 'KXMLBGAME', mls: 'KXMLSGAME', nba: 'KXNBAGAME', nhl: 'KXNHLGAME',
  epl: 'KXEPLGAME', laliga: 'KXLALIGAGAME', seriea: 'KXSERIEAGAME', bundesliga: 'KXBUNDESLIGAGAME', ligue1: 'KXLIGUE1GAME',
  ucl: 'KXUCLGAME', wnba: 'KXWNBAGAME', ncaab: 'KXNCAAMBGAME'
}
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const STOP = new Set(['wins', 'the', 'of', 'at', 'vs', 'and', 'st', 'state', 'fc', 'united', 'city'])

const tok = (s: unknown): Set<string> =>
  new Set((String(s ?? '').toLowerCase().match(/[a-z]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t)))
const subset = (a: Set<string>, b: Set<string>): boolean => [...a].every((t) => b.has(t))
const same = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && subset(a, b)
const overlap = (a: Set<string>, b: Set<string>): number => [...a].filter((t) => b.has(t)).length
const arr = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v
  if (typeof v !== 'string') return []
  try {
    const p = JSON.parse(v)
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}

export interface PolyUsMoneyline {
  slug?: string
  gameStartTime?: string
  question?: string
  marketSides?: unknown
}
export interface KalshiGameMarket { ticker: string; title: string }
export interface KalshiGameEvent { event: string; series: string; date: number; markets: KalshiGameMarket[] }
export interface LagPair {
  slug: string
  ticker: string
  event: string
  team: string
  gameStart: string
  /** True when the Kalshi team is the Polymarket US market's LONG (priced) side. */
  kalshiTeamIsLong: boolean
}

/** Kalshi game market -> its event, keyed by series and the UTC date in the ticker (e.g. KXNFLGAME-26SEP22...). */
export function kalshiGameEvents(series: string, markets: { ticker: string; title?: string; event_ticker?: string }[]): KalshiGameEvent[] {
  const byEvent = new Map<string, KalshiGameEvent>()
  for (const m of markets) {
    const title = String(m.title ?? '')
    if (title.startsWith('Tie')) continue
    const dm = /^(\d\d)([A-Z]{3})(\d\d)/.exec(m.ticker.slice(series.length + 1))
    if (!dm || !m.event_ticker) continue
    const date = Date.UTC(2000 + Number(dm[1]), MON.indexOf(dm[2]), Number(dm[3]))
    const ev = byEvent.get(m.event_ticker) ?? { event: m.event_ticker, series, date, markets: [] }
    ev.markets.push({ ticker: m.ticker, title })
    byEvent.set(m.event_ticker, ev)
  }
  return [...byEvent.values()].filter((e) => e.markets.length === 2)
}

/** One Polymarket US moneyline <-> one two-sided Kalshi event, both team titles mapped one-to-one (section 122). */
export function matchPolyUsGames(pmRows: PolyUsMoneyline[], events: KalshiGameEvent[]): LagPair[] {
  const byKey = new Map<string, KalshiGameEvent[]>()
  for (const e of events) {
    const k = `${e.series}|${e.date}`
    byKey.set(k, [...(byKey.get(k) ?? []), e])
  }
  const pairs: LagPair[] = []
  for (const r of pmRows) {
    const sm = /^aec-([a-z0-9]+)-/.exec(String(r.slug ?? ''))
    const ser = sm ? POLYUS_SPORT[sm[1]] : undefined
    if (!ser || !r.slug) continue
    const gs = Date.parse(r.gameStartTime ?? '')
    if (!Number.isFinite(gs)) continue
    const sides = arr(r.marketSides).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    const long = sides.find((x) => x.long === true && x.price !== undefined && x.price !== null && x.price !== '')
    if (!long) continue
    const other = sides.find((x) => x !== long)
    const mph = /event (.+?) vs\.? (.+?)(?: scheduled| on |\?|$)/.exec(String(r.question ?? '').toLowerCase())
    if (!mph) continue
    const phrases = [mph[1].trim(), mph[2].trim()].map(tok)
    const sideTok = (x: Record<string, unknown> | undefined): Set<string> => new Set([...tok(x?.description), ...tok(JSON.stringify(x?.team ?? {}))])
    const d = new Date(gs)
    const gd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    let found = false
    for (const date of [gd, gd - 86_400_000, gd + 86_400_000]) {
      for (const ev of byKey.get(`${ser}|${date}`) ?? []) {
        const fit = ev.markets.map((m) => {
          const kt = tok(m.title)
          let idx = phrases.map((p, i) => (kt.size && subset(kt, p) ? i : -1)).filter((i) => i >= 0)
          if (idx.length === 2) {
            const exact = idx.filter((i) => same(kt, phrases[i]))
            if (exact.length) idx = exact
          }
          return idx
        })
        if (fit[0].length !== 1 || fit[1].length !== 1 || fit[0][0] === fit[1][0]) continue
        for (let i = 0; i < 2; i++) {
          const m = ev.markets[i]
          const kt = tok(m.title)
          const ph = phrases[fit[i][0]]
          const sL = overlap(kt, sideTok(long)) + overlap(ph, sideTok(long))
          const sO = other ? overlap(kt, sideTok(other)) + overlap(ph, sideTok(other)) : 0
          if (sL === sO) continue
          pairs.push({ slug: r.slug, ticker: m.ticker, event: ev.event, team: m.title.replace(/ wins$/i, ''), gameStart: d.toISOString(), kalshiTeamIsLong: sL > sO })
          found = true
        }
        if (found) break
      }
      if (found) break
    }
  }
  return pairs
}

/** One cycle's view of a pair: Kalshi team market top, and the Polymarket US LONG side's top with sizes. */
export interface LagObs {
  at: number
  kBid: number
  kAsk: number
  pmLongBid: number
  pmLongAsk: number
  pmLongBidSz: number
  pmLongAskSz: number
}
export interface LagConfig {
  /** Kalshi mid move between consecutive cycles that triggers, cents (pre-registered primary: 8). */
  minMoveCents: number
  /** Polymarket US's own move must be below this to count as stale, cents. */
  maxPolyMoveCents: number
  /** Kalshi's new price minus what we pay minus the Polymarket US fee must be at least this, cents. */
  minGapCents: number
  /** Consecutive cycles must be this far apart, ms - a longer gap is not "the previous cycle". */
  minCycleMs: number
  maxCycleMs: number
}
export const LAG_DEFAULTS: LagConfig = { minMoveCents: 8, maxPolyMoveCents: 1, minGapCents: 1, minCycleMs: 30_000, maxCycleMs: 100_000 }

/** Polymarket US taker fee for ONE contract at price p, dollars: 0.0695 P(1-P), rounded to the nearest cent. */
export function polyUsTakerFee(p: number): number {
  return Math.round(0.0695 * p * (1 - p) * 100) / 100
}

export interface LagDecision {
  /** Which Polymarket US side to BUY: the market's long side or its short side. */
  pmSide: 'long' | 'short'
  /** True when that side is the Kalshi team winning. */
  forKalshiTeam: boolean
  /** Price per contract we pay on Polymarket US, and the size resting there. */
  price: number
  size: number
  fee: number
  kMove: number
  gapCents: number
}

/**
 * The trigger: in play, Kalshi's mid for the team moved >= minMoveCents since the previous cycle, Polymarket US's
 * implied price for the same team moved < maxPolyMoveCents, and buying the side Kalshi moved toward on Polymarket US
 * still leaves >= minGapCents to Kalshi's new price after the Polymarket US fee. Returns the Polymarket US side to buy.
 *
 * Side mapping, because it is where a wrong sign would hide: the Kalshi market is "team X wins". If X is Polymarket
 * US's long side, X winning is the long side (bought at the long ask) and X losing is the short side (bought at
 * 1 - long bid). If X is the short side it is the other way round.
 */
export function lagTrigger(pair: LagPair, prev: LagObs, cur: LagObs, now: number, cfg: LagConfig = LAG_DEFAULTS): LagDecision | null {
  if (now < Date.parse(pair.gameStart)) return null // in play only: no trigger ever fired pre-game in the measurement
  const dt = cur.at - prev.at
  if (dt < cfg.minCycleMs || dt > cfg.maxCycleMs) return null
  const valid = (o: LagObs): boolean => o.kBid > 0 && o.kAsk < 1 && o.kAsk > o.kBid && o.pmLongBid > 0 && o.pmLongAsk < 1 && o.pmLongAsk > o.pmLongBid
  if (!valid(prev) || !valid(cur)) return null
  const kMid = (o: LagObs): number => (o.kBid + o.kAsk) / 2
  // Polymarket US's implied price for the Kalshi team, from the long side's book.
  const pmTeamMid = (o: LagObs): number => (pair.kalshiTeamIsLong ? (o.pmLongBid + o.pmLongAsk) / 2 : 1 - (o.pmLongBid + o.pmLongAsk) / 2)
  const kMove = kMid(cur) - kMid(prev)
  if (Math.abs(kMove) * 100 < cfg.minMoveCents - 1e-9) return null
  if (Math.abs(pmTeamMid(cur) - pmTeamMid(prev)) * 100 >= cfg.maxPolyMoveCents - 1e-9) return null
  const forKalshiTeam = kMove > 0
  const pmSide: 'long' | 'short' = forKalshiTeam === pair.kalshiTeamIsLong ? 'long' : 'short'
  const price = pmSide === 'long' ? cur.pmLongAsk : +(1 - cur.pmLongBid).toFixed(4)
  const size = pmSide === 'long' ? cur.pmLongAskSz : cur.pmLongBidSz
  if (!(price > 0 && price < 1) || !(size >= 1)) return null
  const target = forKalshiTeam ? kMid(cur) : 1 - kMid(cur)
  const fee = polyUsTakerFee(price)
  const gapCents = (target - price - fee) * 100
  if (gapCents < cfg.minGapCents - 1e-9) return null
  return { pmSide, forKalshiTeam, price, size, fee, kMove: +(kMove * 100).toFixed(2), gapCents: +gapCents.toFixed(2) }
}

/** Top of one Kalshi team market from the batched orderbook endpoint: YES bids, and asks as 1 - the best NO bid. */
export function kalshiTop(o: { orderbook_fp?: { yes_dollars?: [unknown, unknown][]; no_dollars?: [unknown, unknown][] } }): { bid: number; ask: number } | undefined {
  const lv = (raw: [unknown, unknown][] | undefined): number[] =>
    (raw ?? []).map(([p, s]) => [Number(p), Number(s)]).filter(([p, s]) => p > 0 && p < 1 && s > 0).map(([p]) => p)
  const yes = lv(o.orderbook_fp?.yes_dollars)
  const no = lv(o.orderbook_fp?.no_dollars)
  if (!yes.length || !no.length) return undefined
  return { bid: Math.max(...yes), ask: +(1 - Math.max(...no)).toFixed(4) }
}

export interface LagFeedIo {
  /** Polymarket US moneylines from the app's catalog index; undefined when missing or stale. */
  moneylines(): PolyUsMoneyline[] | undefined
  /** Open Kalshi markets in one game series. */
  kalshiMarkets(series: string): Promise<{ ticker: string; title?: string; event_ticker?: string }[]>
  /** Kalshi top of book for these tickers (a missing ticker means no two-sided book). */
  kalshiBooks(tickers: string[]): Promise<Map<string, { bid: number; ask: number }>>
  /** Polymarket US long side's top of book with sizes; undefined when one side is empty. */
  pmTop(slug: string): Promise<{ bid: number; bidSz: number; ask: number; askSz: number } | undefined>
  log?(line: string): void
}

export interface LagHit {
  pair: LagPair
  decision: LagDecision
  obs: LagObs
}

/**
 * The feed the recorder (scripts/sports-books.mjs) has run since 2026-09-18, inside the app: discovery every 30
 * minutes, and each call to step() observes every matched pair in play and returns the pairs whose trigger fired.
 * The previous observation is kept per Kalshi ticker; a pair whose books are missing this cycle loses it, so the next
 * trigger needs two consecutive complete observations, as in the measurement.
 */
export class PolyUsLagFeed {
  static readonly DISCOVER_MS = 30 * 60_000
  /** Observe from just before the start so the first in-play cycle has a previous observation. */
  static readonly BEFORE_MS = 5 * 60_000
  /** The recorder's window; no game in the measurement ran longer. */
  static readonly AFTER_MS = 5 * 3600_000
  private pairs: LagPair[] = []
  private discoveredAt = 0
  private discovering: Promise<void> | null = null
  private prev = new Map<string, LagObs>()

  constructor(private io: LagFeedIo, private cfg: LagConfig = LAG_DEFAULTS) {}

  get pairCount(): number {
    return this.pairs.length
  }

  /** Discovery runs in the background so a slow series walk never stretches the gap between two observations. */
  private kickDiscovery(now: number): void {
    if (this.discovering || now - this.discoveredAt < PolyUsLagFeed.DISCOVER_MS) return
    this.discovering = this.discover(now)
      .catch((e) => this.io.log?.(`discovery failed: ${String(e).slice(0, 120)}`))
      .finally(() => {
        this.discovering = null
      })
  }

  async discover(now: number): Promise<void> {
    const pm = this.io.moneylines()
    if (!pm) {
      this.io.log?.('discovery skipped: no fresh Polymarket US moneyline index')
      this.discoveredAt = now - PolyUsLagFeed.DISCOVER_MS + 5 * 60_000 // retry in five minutes
      return
    }
    const sports = new Set(pm.map((r) => /^aec-([a-z0-9]+)-/.exec(String(r.slug ?? ''))?.[1]).filter((s): s is string => !!s && s in POLYUS_SPORT))
    const events: KalshiGameEvent[] = []
    for (const s of sports) events.push(...kalshiGameEvents(POLYUS_SPORT[s], await this.io.kalshiMarkets(POLYUS_SPORT[s])))
    // Keep a pair until its own window ends even after it leaves either venue's open list (section 158).
    const byTicker = new Map(this.pairs.filter((p) => now <= Date.parse(p.gameStart) + PolyUsLagFeed.AFTER_MS).map((p) => [p.ticker, p]))
    for (const p of matchPolyUsGames(pm, events)) byTicker.set(p.ticker, p)
    this.pairs = [...byTicker.values()]
    this.discoveredAt = now
    this.io.log?.(`discovery: ${pm.length} moneylines, ${events.length} Kalshi games, ${this.pairs.length} matched sides across ${new Set(this.pairs.map((p) => p.slug)).size} games`)
  }

  async step(now: number): Promise<LagHit[]> {
    this.kickDiscovery(now)
    const active = this.pairs.filter((p) => {
      const gs = Date.parse(p.gameStart)
      return now >= gs - PolyUsLagFeed.BEFORE_MS && now <= gs + PolyUsLagFeed.AFTER_MS
    })
    for (const t of [...this.prev.keys()]) if (!active.some((p) => p.ticker === t)) this.prev.delete(t)
    if (!active.length) return []
    const kb = await this.io.kalshiBooks([...new Set(active.map((p) => p.ticker))])
    const pb = new Map<string, { bid: number; bidSz: number; ask: number; askSz: number } | undefined>()
    for (const slug of new Set(active.map((p) => p.slug))) pb.set(slug, await this.io.pmTop(slug).catch(() => undefined))
    const hits: LagHit[] = []
    for (const p of active) {
      const k = kb.get(p.ticker)
      const m = pb.get(p.slug)
      if (!k || !m) {
        this.prev.delete(p.ticker)
        continue
      }
      const obs: LagObs = { at: now, kBid: k.bid, kAsk: k.ask, pmLongBid: m.bid, pmLongAsk: m.ask, pmLongBidSz: m.bidSz, pmLongAskSz: m.askSz }
      const prev = this.prev.get(p.ticker)
      this.prev.set(p.ticker, obs)
      if (!prev) continue
      const decision = lagTrigger(p, prev, obs, now, this.cfg)
      if (decision) hits.push({ pair: p, decision, obs })
    }
    return hits
  }
}
