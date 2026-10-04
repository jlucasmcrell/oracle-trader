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
import { appendFileSync } from 'node:fs'
import { PolyClobWs } from '../services/polyClobWs'
import { liveSpotFeed } from '../services/liveSpot'
import { cryptoFair } from './ibkrSignals'
import { cryptoSpot } from './ibkrLab'
import { polyUsTakerFee } from './polyusLag'

export const BTC_HOUR_LOG_MIN_NET = 2
const HOUR = 3600_000
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', hour: 'numeric', hour12: true })

/** Polymarket US slug of the hourly market that STARTS at hourStartMs (UTC). */
export function btcHourSlug(hourStartMs: number): string {
  const d = new Date(hourStartMs)
  return `cpc-btc-updown-1h-${d.toISOString().slice(0, 10)}-${String(d.getUTCHours()).padStart(2, '0')}00z`
}

/** Polymarket international event slug for the same hour, named by its New York start: bitcoin-up-or-down-october-4-3am-et. */
export function globalHourSlug(hourStartMs: number): string {
  const p: Record<string, string> = {}
  for (const x of ET.formatToParts(new Date(hourStartMs))) p[x.type] = x.value
  return `bitcoin-up-or-down-${p.month.toLowerCase()}-${p.day}-${p.hour}${p.dayPeriod.toLowerCase()}-et`
}

/** Net cents a one-contract taker clears buying YES at the ask, or NO at 1 - bid, against a leader's P(up). */
export function hourGaps(bid: number, ask: number, leader: number): { YES: number; NO: number } {
  return {
    YES: +(100 * (leader - ask - polyUsTakerFee(ask))).toFixed(2),
    NO: +(100 * (bid - leader - polyUsTakerFee(1 - bid))).toFixed(2)
  }
}

interface Top { bid: number; ask: number; at: number }
interface Hour { start: number; slug: string; s0?: number; upToken?: string }

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
  readonly stats = { frames: 0, opens: 0, connects: 0, lastError: '' }

  constructor(private readonly opts: {
    path: string
    /** Signed X-PM-* headers for a GET of `path`; throws while no credentials are configured. */
    headers: (path: string) => Record<string, string>
    enabled: () => boolean
    log: (s: string) => void
  }) {}

  start(): void {
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
    ws.on('open', () => this.subscribe(Date.now()))
    ws.on('message', (data) => {
      this.stats.frames++
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
    try {
      const iso = new Date(start).toISOString()
      const r = await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${iso}&end=${new Date(start + 60_000).toISOString()}`, { signal: AbortSignal.timeout(10_000) })
      const rows = (await r.json()) as number[][]
      const first = Array.isArray(rows) ? rows.find((c) => c[0] * 1000 === start) : undefined
      if (first && first[3] > 0) h.s0 = first[3]
    } catch (e) { this.stats.lastError = 'hour open: ' + String(e) }
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
            this.write({ ts: new Date(now).toISOString(), ev: 'open', slug: h.slug, leader, side, px: side === 'YES' ? top.ask : +(1 - top.bid).toFixed(4), net, leaderP: +p.toFixed(4), bid: top.bid, ask: top.ask, leftMs: left })
          } else if (net > was.peak) was.peak = net
        } else if (was) {
          this.open.delete(key)
          this.write({ ts: new Date(now).toISOString(), ev: 'close', slug: h.slug, leader, side, durMs: now - was.at, peak: was.peak })
        }
      }
    }
  }

  private write(row: Record<string, unknown>): void {
    try { appendFileSync(this.opts.path, JSON.stringify(row) + '\n') } catch (e) { this.stats.lastError = 'write: ' + String(e) }
  }
}
