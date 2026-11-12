/**
 * Kalshi vs Polymarket US on the 15-minute Bitcoin market: a QUOTE RECORDER. TRADES NOTHING.
 * (docs/PREREGISTERED-polyus-k15.md)
 *
 * Both venues list a 15-minute "BTC up or down" market for the same window, and since 2026-09-21 both settle it on
 * the same index, CF Benchmarks' BRTI (Kalshi KXBTC15M; Polymarket US cpc-btc-updown-15m-<date>-<HHMM>z). The live
 * lead-lag arm compares Kalshi with Polymarket's INTERNATIONAL market, which settles on a different index; this pair
 * has no such basis, and the operator can trade either side of it.
 *
 * It records both tops of book side by side whenever either changes (at most every 2 s) to
 * `polyus-k15-quotes.jsonl`. Gaps, fees and the decision rule are computed offline by
 * scripts/polyus-k15-gate.mjs, so the threshold is not baked into the recorder.
 */
import { appendFileSync } from 'node:fs'
import WebSocket from 'ws'

const WINDOW = 900_000
/** A top older than this is not a quote. */
export const K15_MAX_AGE_MS = 5_000

/** Polymarket US slug of the 15-minute market that STARTS at windowStartMs (UTC). */
export function k15Slug(windowStartMs: number): string {
  const d = new Date(windowStartMs)
  return `cpc-btc-updown-15m-${d.toISOString().slice(0, 10)}-${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}z`
}

export interface K15KalshiTop { ticker: string; bid: number; ask: number; end: number }
export interface K15Row { ts: string; slug: string; t: string; end: number; ub: number; ua: number; uAgeMs: number; kb: number; ka: number }

/** The row to write for this instant, or null when either side has no fresh two-sided quote for the current window. */
export function k15Row(now: number, us: { bid: number; ask: number; at: number } | undefined, k: K15KalshiTop | null): K15Row | null {
  const start = now - (now % WINDOW)
  if (!us || !k || k.end !== start + WINDOW) return null
  if (now - us.at > K15_MAX_AGE_MS) return null
  if (!(us.bid > 0 && us.ask > us.bid && us.ask < 1) || !(k.bid > 0 && k.ask > k.bid && k.ask < 1)) return null
  return { ts: new Date(now).toISOString(), slug: k15Slug(start), t: k.ticker, end: k.end, ub: us.bid, ua: us.ask, uAgeMs: now - us.at, kb: k.bid, ka: k.ask }
}

export class PolyUsK15Shadow {
  private sock: WebSocket | null = null
  private tops = new Map<string, { bid: number; ask: number; at: number }>()
  private subscribed = new Set<string>()
  private timer?: NodeJS.Timeout
  private retry?: NodeJS.Timeout
  private stopped = false
  private last = ''
  private lastLog = 0
  readonly stats = { frames: 0, rows: 0, connects: 0, lastError: '' }

  constructor(private readonly opts: {
    path: string
    /** Signed X-PM-* headers for a GET of `path`; throws while no credentials are configured. */
    headers: (path: string) => Record<string, string>
    /** Kalshi's top of book for the current KXBTC15M window, from the lead-lag engine's in-memory book. */
    kalshiTop: () => K15KalshiTop | null
    enabled: () => boolean
    log: (s: string) => void
  }) {}

  start(): void {
    this.connect()
    this.timer = setInterval(() => this.tick(Date.now()), 2_000)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.retry) clearTimeout(this.retry)
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

  /** Subscribe this window's market and the next, once each per connection. */
  private subscribe(now: number): void {
    const ws = this.sock
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const start = now - (now % WINDOW)
    for (const s of [k15Slug(start), k15Slug(start + WINDOW)]) {
      if (this.subscribed.has(s)) continue
      this.subscribed.add(s)
      ws.send(JSON.stringify({ subscribe: { requestId: s, subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA_LITE', marketSlugs: [s] } }))
    }
  }

  private tick(now: number): void {
    if (!this.opts.enabled()) return
    this.subscribe(now)
    const start = now - (now % WINDOW)
    for (const k of [...this.tops.keys()]) if (k !== k15Slug(start) && k !== k15Slug(start + WINDOW)) this.tops.delete(k)
    let kalshi: K15KalshiTop | null = null
    try { kalshi = this.opts.kalshiTop() } catch { kalshi = null }
    const row = k15Row(now, this.tops.get(k15Slug(start)), kalshi)
    if (row) {
      // Only when a price moved: an unchanged pair of books repeats nothing.
      const key = `${row.slug}|${row.ub}|${row.ua}|${row.kb}|${row.ka}`
      if (key !== this.last) {
        this.last = key
        try { appendFileSync(this.opts.path, JSON.stringify(row) + '\n'); this.stats.rows++ } catch (e) { this.stats.lastError = 'write: ' + String(e) }
      }
    }
    if (now - this.lastLog > 30 * 60_000) {
      this.lastLog = now
      this.opts.log(`[k15] Kalshi vs Polymarket US 15m BTC recorder: ${this.sock ? 'connected' : 'down'}, ${this.stats.frames} frames, ${this.stats.rows} rows${kalshi ? '' : ', no Kalshi book yet'}${this.stats.lastError ? `, last error ${this.stats.lastError.slice(0, 80)}` : ''}`)
    }
  }
}
