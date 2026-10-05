/**
 * Polymarket US "BTC Up or Down Hourly" lead-lag SHADOW (docs/PREREGISTERED-polyus-btc-hour.md). TRADES NOTHING.
 *
 * Polymarket US lists one crypto market of this kind: cpc-btc-updown-1h-<date>-<HH>00z, settling on CF Benchmarks' BRTI
 * at the hour's end against its start. Its public REST prices are a 30 s cache (the September lag arm's failure), so
 * this reads the AUTHENTICATED market-data socket, measured live on 2026-10-04 (787 top-of-book updates in two minutes,
 * a change every 0.4 s, against one every 30 s on the public /bbo). Two leaders are compared with that book every
 * 250 ms: Polymarket's international market for the same hour (Binance-settled) and a lognormal fair value from the
 * Coinbase spot tick against the hour's opening price. A gap is the cents a taker would clear after Polymarket US's
 * fee; each one is logged when it opens and when it closes, and the registered read grades the first per market,
 * side and leader at settlement.
 */
import WebSocket from 'ws'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { PolyClobWs } from '../services/polyClobWs'
import { liveSpotFeed } from '../services/liveSpot'
import { cryptoFair } from './ibkrSignals'
import { cryptoSpot } from './ibkrLab'
import { polyUsTakerFee } from './polyusLag'

export const BTC_HOUR_LOG_MIN_NET = 2
const HOUR = 3600_000
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', hour12: true })

/** Polymarket US slug of the hourly market that STARTS at hourStartMs (UTC). */
export function btcHourSlug(hourStartMs: number): string {
  const d = new Date(hourStartMs)
  return `cpc-btc-updown-1h-${d.toISOString().slice(0, 10)}-${String(d.getUTCHours()).padStart(2, '0')}00z`
}

/**
 * Polymarket international event slug for the same hour, named by its New York start:
 * bitcoin-up-or-down-october-4-2026-3am-et. The year is part of the slug; without it the October 2025 market answers.
 */
export function globalHourSlug(hourStartMs: number): string {
  const p: Record<string, string> = {}
  for (const x of ET.formatToParts(new Date(hourStartMs))) p[x.type] = x.value
  return `bitcoin-up-or-down-${p.month.toLowerCase()}-${p.day}-${p.year}-${p.hour}${p.dayPeriod.toLowerCase()}-et`
}

/** End of the hour a slug names (its start plus an hour). */
export function hourEnd(slug: string): number {
  const m = /(\d{4}-\d\d-\d\d)-(\d\d)00z$/.exec(slug)
  return m ? Date.parse(`${m[1]}T${m[2]}:00:00Z`) + HOUR : Infinity
}

/** Net cents a one-contract taker clears buying YES at the ask, or NO at 1 - bid, against a leader's P(up). */
export function hourGaps(bid: number, ask: number, leader: number): { YES: number; NO: number } {
  return {
    YES: +(100 * (leader - ask - polyUsTakerFee(ask))).toFixed(2),
    NO: +(100 * (bid - leader - polyUsTakerFee(1 - bid))).toFixed(2)
  }
}

interface Top { bid: number; ask: number; at: number }
interface PaperEntry { slug: string; leader: string; side: 'YES' | 'NO'; px: number; ts: string }

/** The paper ledger shown in the Polymarket paper panel: the registered rule (first gap of 6c or more per market, side
 *  and leader, one contract at the logged price, held to settlement), scored as the hours settle. */
export interface BtcHourStatus {
  connected: boolean
  lastFrameAgeS: number | null
  frames: number
  gapsLogged: number
  since: string | null
  hoursSeen: number
  leaders: { leader: string; entries: number; settled: number; wins: number; net: number; centsPerContract: number | null; open: number }[]
  recent: { at: string; slug: string; leader: string; side: string; px: number; won: boolean; net: number }[]
  lastError: string
}
export const BTC_HOUR_PAPER_NET = 6
interface Hour { start: number; slug: string; s0?: number; upToken?: string; openTry?: number; globalTry?: number }

export class PolyUsBtcHourShadow {
  private sock: WebSocket | null = null
  private tops = new Map<string, Top>()
  private global = new PolyClobWs()
  private hour: Hour | null = null
  private vol: { v: number; at: number } | null = null
  private open = new Map<string, { at: number; peak: number }>()
  private timer?: NodeJS.Timeout
  private retry?: NodeJS.Timeout
  private stopped = false
  private subscribed = new Set<string>()
  private lastLog = 0
  private lastFrameAt = 0
  private connectedAt = 0
  private paper = new Map<string, PaperEntry>()
  private results: Record<string, 'yes' | 'no'> = {}
  private resultsAt = 0
  private resultsBusy = false
  private since: string | null = null
  readonly stats = { frames: 0, opens: 0, connects: 0, lastError: '' }

  constructor(private readonly opts: {
    path: string
    /** Settled results, shared with the registered read. */
    resultsPath: string
    /** Signed X-PM-* headers for a GET of `path`; throws while no credentials are configured. */
    headers: (path: string) => Record<string, string>
    enabled: () => boolean
    log: (s: string) => void
  }) {}

  start(): void {
    this.loadLedger()
    liveSpotFeed.start()
    this.connect()
    this.timer = setInterval(() => { try { this.tick(Date.now()) } catch (e) { this.stats.lastError = String(e) } }, 250)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.retry) clearTimeout(this.retry)
    this.global.stop()
    try { this.sock?.close() } catch { /* closing */ }
  }

  private connect(): void {
    if (this.stopped) return
    let headers: Record<string, string>
    try { headers = this.opts.headers('/v1/ws/markets') } catch (e) {
      this.stats.lastError = String(e)
      this.retry = setTimeout(() => this.connect(), 60_000)
      return
    }
    this.stats.connects++
    this.subscribed.clear()
    const ws = new WebSocket('wss://api.polymarket.us/v1/ws/markets', { headers })
    this.sock = ws
    const ping = setInterval(() => { try { ws.ping() } catch { /* closing */ } }, 15_000)
    ws.on('open', () => { this.connectedAt = this.lastFrameAt = Date.now(); this.subscribe(Date.now()) })
    ws.on('message', (data) => {
      this.stats.frames++
      this.lastFrameAt = Date.now()
      try {
        const m = JSON.parse(String(data)) as { marketDataLite?: { marketSlug?: string; bestBid?: { value?: string }; bestAsk?: { value?: string } }; error?: string }
        if (m.error) this.stats.lastError = String(m.error).slice(0, 200)
        const l = m.marketDataLite
        const bid = Number(l?.bestBid?.value), ask = Number(l?.bestAsk?.value)
        if (l?.marketSlug && bid > 0 && ask > 0 && ask > bid) this.tops.set(l.marketSlug, { bid, ask, at: Date.now() })
      } catch { /* a frame we do not read */ }
    })
    ws.on('error', (e) => { this.stats.lastError = String(e.message || e) })
    ws.on('close', () => {
      clearInterval(ping)
      if (this.sock === ws) this.sock = null
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 10_000)
    })
  }

  /** Subscribe this hour's market and the next, once each per connection. */
  private subscribe(now: number): void {
    const ws = this.sock
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const start = now - (now % HOUR)
    for (const s of [btcHourSlug(start), btcHourSlug(start + HOUR)]) {
      if (this.subscribed.has(s)) continue
      this.subscribed.add(s)
      ws.send(JSON.stringify({ subscribe: { requestId: s, subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA_LITE', marketSlugs: [s] } }))
    }
  }

  /** A new hour: its opening price (Coinbase one-minute open) and the international market's Up token. */
  private async roll(start: number): Promise<void> {
    for (const [key, was] of this.open) {
      if (key.startsWith(btcHourSlug(start - HOUR) + '|')) {
        const [slug, leader, side] = key.split('|')
        this.write({ ts: new Date(start).toISOString(), ev: 'close', slug, leader, side, durMs: start - was.at, peak: was.peak, why: 'hour end' })
        this.open.delete(key)
      }
    }
    const h: Hour = { start, slug: btcHourSlug(start) }
    this.hour = h
    this.subscribe(start)
    for (const k of [...this.tops.keys()]) if (k !== h.slug && k !== btcHourSlug(start + HOUR)) this.tops.delete(k)
    await Promise.all([this.loadOpen(h), this.loadGlobal(h)])
  }

  /** The hour's opening price. Coinbase publishes the first minute's candle only once that minute has begun. */
  private async loadOpen(h: Hour): Promise<void> {
    const start = h.start
    h.openTry = Date.now()
    try {
      const iso = new Date(start).toISOString()
      const r = await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${iso}&end=${new Date(start + 60_000).toISOString()}`, { signal: AbortSignal.timeout(10_000) })
      const rows = (await r.json()) as number[][]
      const first = Array.isArray(rows) ? rows.find((c) => c[0] * 1000 === start) : undefined
      if (first && first[3] > 0) h.s0 = first[3]
    } catch (e) { this.stats.lastError = 'hour open: ' + String(e) }
  }

  private async loadGlobal(h: Hour): Promise<void> {
    const start = h.start
    h.globalTry = Date.now()
    try {
      const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${globalHourSlug(start)}`, { signal: AbortSignal.timeout(10_000) })
      const ev = (await r.json()) as { markets?: { clobTokenIds?: string; outcomes?: string }[] }[]
      const m = ev?.[0]?.markets?.[0]
      const ids = m?.clobTokenIds ? (JSON.parse(m.clobTokenIds) as string[]) : []
      const names = m?.outcomes ? (JSON.parse(m.outcomes) as string[]) : []
      const up = ids[names.findIndex((n) => /^up$/i.test(n))]
      if (up) { h.upToken = up; this.global.ensure([up]) }
    } catch (e) { this.stats.lastError = 'international market: ' + String(e) }
  }

  private tick(now: number): void {
    if (!this.opts.enabled()) return
    // A socket can stay open and go silent (2026-10-04 18:00Z to 10-05 12:00Z, and again from 16:40Z): the book updates
    // several times a second, so a minute without a frame is a dead feed. Drop it; the close handler reconnects.
    // Polymarket US skips some hours entirely (none listed 13:00-17:00Z on 2026-10-05), and then silence is correct, so
    // reconnects are spaced five minutes apart rather than every minute.
    if (this.sock && this.connectedAt && now - this.lastFrameAt > 60_000 && now - this.connectedAt > 5 * 60_000) {
      this.stats.lastError = `no data for ${Math.round((now - this.lastFrameAt) / 1000)} s (no market this hour, or a stalled feed); reconnecting`
      this.connectedAt = 0
      try { this.sock.terminate() } catch { /* already gone */ }
    }
    if (now - this.resultsAt > 10 * 60_000) void this.refreshResults(now)
    if (now - this.lastLog > 10 * 60_000) {
      this.lastLog = now
      this.opts.log(`[btc-hour] shadow: ${this.sock ? 'connected' : 'down'}, ${this.stats.frames} frames, ${this.stats.opens} gaps logged${this.stats.lastError ? `, last error ${this.stats.lastError.slice(0, 120)}` : ''}`)
    }
    const start = now - (now % HOUR)
    if (!this.hour || this.hour.start !== start) { void this.roll(start); return }
    if (!this.vol || now - this.vol.at > 5 * 60_000) {
      this.vol = { v: this.vol?.v ?? NaN, at: now }
      void cryptoSpot('CFBTC', now).then((s) => { if (s) this.vol = { v: s.annualVol, at: now } }).catch(() => undefined)
    }
    const h = this.hour
    if (h.s0 === undefined && now - (h.openTry ?? 0) > 15_000) void this.loadOpen(h)
    if (h.upToken === undefined && now - (h.globalTry ?? 0) > 60_000) void this.loadGlobal(h)
    const end = start + HOUR, left = end - now
    const top = this.tops.get(h.slug)
    if (!top || now - top.at > 5_000 || left < 60_000) return
    const leaders: [string, number][] = []
    const g = h.upToken ? this.global.top(h.upToken) : undefined
    if (g && now - g.at <= 5_000 && g.ask - g.bid <= 0.05) leaders.push(['international', (g.bid + g.ask) / 2])
    const spot = liveSpotFeed.getTick('BTC')
    if (spot && h.s0 && this.vol && Number.isFinite(this.vol.v) && now - spot.timestamp <= 3_000) {
      const fair = cryptoFair(spot.price, h.s0, this.vol.v, left / (365.25 * 86_400_000))
      if (Number.isFinite(fair)) leaders.push(['spot', fair])
    }
    for (const [leader, p] of leaders) {
      const gaps = hourGaps(top.bid, top.ask, p)
      for (const side of ['YES', 'NO'] as const) {
        const key = `${h.slug}|${leader}|${side}`, net = gaps[side], was = this.open.get(key)
        if (net >= BTC_HOUR_LOG_MIN_NET) {
          if (!was) {
            this.open.set(key, { at: now, peak: net })
            this.stats.opens++
            const px = side === 'YES' ? top.ask : +(1 - top.bid).toFixed(4), ts = new Date(now).toISOString()
            this.write({ ts, ev: 'open', slug: h.slug, leader, side, px, net, leaderP: +p.toFixed(4), bid: top.bid, ask: top.ask, leftMs: left })
            if (net >= BTC_HOUR_PAPER_NET && !this.paper.has(key)) this.paper.set(key, { slug: h.slug, leader, side, px, ts })
          } else if (net > was.peak) was.peak = net
        } else if (was) {
          this.open.delete(key)
          this.write({ ts: new Date(now).toISOString(), ev: 'close', slug: h.slug, leader, side, durMs: now - was.at, peak: was.peak })
        }
      }
    }
  }

  /** Rebuild the paper ledger and the settled results from disk after a restart. */
  private loadLedger(): void {
    try { if (existsSync(this.opts.resultsPath)) this.results = JSON.parse(readFileSync(this.opts.resultsPath, 'utf8')) as Record<string, 'yes' | 'no'> } catch { this.results = {} }
    try {
      if (!existsSync(this.opts.path)) return
      for (const line of readFileSync(this.opts.path, 'utf8').split('\n')) {
        if (!line.includes('"open"')) continue
        try {
          const r = JSON.parse(line) as PaperEntry & { ev?: string; net?: number }
          this.since ??= r.ts
          const key = `${r.slug}|${r.leader}|${r.side}`
          if (r.ev === 'open' && (r.net ?? 0) >= BTC_HOUR_PAPER_NET && !this.paper.has(key)) this.paper.set(key, { slug: r.slug, leader: r.leader, side: r.side, px: r.px, ts: r.ts })
        } catch { /* torn line */ }
      }
    } catch (e) { this.stats.lastError = 'ledger: ' + String(e) }
  }

  /** Settled results for every ended hour the ledger holds, from the public catalog (outcomePrices once RESOLVED). */
  async results_(slugs: string[]): Promise<Record<string, 'yes' | 'no'>> {
    for (const s of slugs) {
      if (this.results[s]) continue
      try {
        const r = await fetch(`https://gateway.polymarket.us/v1/markets?slug=${encodeURIComponent(s)}`, { signal: AbortSignal.timeout(10_000) })
        const m = ((await r.json()) as { markets?: { status?: string; outcomePrices?: string }[] }).markets?.[0]
        if (m?.status === 'MARKET_STATUS_RESOLVED' && m.outcomePrices) this.results[s] = (JSON.parse(m.outcomePrices) as string[])[0] === '1' ? 'yes' : 'no'
      } catch { /* next pass */ }
      await new Promise((resolve) => setTimeout(resolve, 1100))
    }
    try { writeFileSync(this.opts.resultsPath, JSON.stringify(this.results)) } catch { /* cache only */ }
    return this.results
  }

  private async refreshResults(now: number): Promise<void> {
    if (this.resultsBusy) return
    this.resultsBusy = true
    this.resultsAt = now
    try {
      const ended = [...new Set([...this.paper.values()].map((e) => e.slug))].filter((s) => !this.results[s] && hourEnd(s) + 5 * 60_000 < now)
      await this.results_(ended)
    } finally { this.resultsBusy = false }
  }

  status(): BtcHourStatus {
    const now = Date.now()
    const by = new Map<string, BtcHourStatus['leaders'][number]>()
    const recent: BtcHourStatus['recent'] = []
    for (const e of this.paper.values()) {
      const row = by.get(e.leader) ?? { leader: e.leader, entries: 0, settled: 0, wins: 0, net: 0, centsPerContract: null, open: 0 }
      row.entries++
      const res = this.results[e.slug]
      if (!res) row.open++
      else {
        const won = (res === 'yes') === (e.side === 'YES')
        const net = (won ? 1 : 0) - e.px - polyUsTakerFee(e.px)
        row.settled++; if (won) row.wins++; row.net += net
        recent.push({ at: e.ts, slug: e.slug, leader: e.leader, side: e.side, px: e.px, won, net: +net.toFixed(4) })
      }
      by.set(e.leader, row)
    }
    for (const r of by.values()) { r.centsPerContract = r.settled ? +(100 * r.net / r.settled).toFixed(2) : null; r.net = +r.net.toFixed(2) }
    return {
      connected: !!this.sock && !!this.connectedAt,
      lastFrameAgeS: this.lastFrameAt ? Math.round((now - this.lastFrameAt) / 1000) : null,
      frames: this.stats.frames,
      gapsLogged: this.stats.opens,
      since: this.since,
      hoursSeen: new Set([...this.paper.values()].map((e) => e.slug)).size,
      leaders: [...by.values()].sort((a, b) => a.leader.localeCompare(b.leader)),
      recent: recent.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12),
      lastError: this.stats.lastError
    }
  }

  private write(row: Record<string, unknown>): void {
    try { appendFileSync(this.opts.path, JSON.stringify(row) + '\n') } catch (e) { this.stats.lastError = 'write: ' + String(e) }
  }
}
