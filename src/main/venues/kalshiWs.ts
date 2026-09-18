import WebSocket from 'ws'
import type { OrderBook } from '../../shared/types'

/**
 * Kalshi WebSocket v2 book cache.
 *
 * Emits the same OrderBook shape the REST path produces, so strategies are
 * unchanged. Runs in SHADOW by default: books are maintained and compared
 * against REST, but nothing consumes them for trading until the comparison
 * proves the parse correct (see KalshiWsClient.divergence).
 *
 * The failure modes here are silent-by-nature — wrong field names or an
 * inverted price convention both yield plausible numbers and no error — so
 * the guards are structural, not incidental:
 *  - WS field names differ from REST (msg.yes_dollars_fp vs
 *    orderbook_fp.yes_dollars). Separate interfaces, and legacy keys hard-fail.
 *  - Sequence gaps invalidate every book on the sid; clearing is NOT recovery,
 *    so a gap always ends in a re-snapshot or an escalation.
 *  - Control frames may carry seq; they may advance the watermark but must
 *    never trigger the reset branch (correct whether or not they consume it).
 */

/** WS snapshot payload. NOT interchangeable with the REST orderbook shape. */
interface WsSnapshotMsg {
  market_ticker?: string
  yes_dollars_fp?: [string, string][]
  no_dollars_fp?: [string, string][]
  // Legacy/REST-shaped keys — presence means we are parsing the wrong shape.
  yes?: unknown
  no?: unknown
  yes_dollars?: unknown
  no_dollars?: unknown
}

interface WsDeltaMsg {
  market_ticker?: string
  price_dollars?: string
  delta_fp?: string
  side?: 'yes' | 'no'
  ts_ms?: number
  price?: unknown
  delta?: unknown
}

type BookStatus = 'UNAVAILABLE' | 'STALE' | 'LIVE'

interface BookState {
  /** price (integer 1e4 units) → size (integer 1e2 units), bids only, per leg. */
  yes: Map<number, number>
  no: Map<number, number>
  status: BookStatus
  lastFrameMs: number
}

const PX = 10000
const SZ = 100

export interface WsStats {
  connected: boolean
  attempts: number
  reconnects: number
  frames: number
  snapshots: number
  deltas: number
  gaps: number
  liveBooks: number
  /** Shadow comparison against REST: how often top-of-book agreed. */
  compared: number
  agreed: number
  maxDiffCents: number
  lastError?: string
  /** Set when a structural guard fired — WS must not be trusted. */
  guardTripped?: string
  /** Which no-ladder price convention the socket was measured to use. */
  convention?: string
}

export function defaultWsStats(): WsStats {
  return { connected: false, attempts: 0, reconnects: 0, frames: 0, snapshots: 0, deltas: 0, gaps: 0, liveBooks: 0, compared: 0, agreed: 0, maxDiffCents: 0 }
}

export class KalshiWsClient {
  private sock: WebSocket | null = null
  private books = new Map<string, BookState>()
  private tickers: string[] = []
  private sid: number | null = null
  private lastSeq: number | null = null
  private cmdId = 1
  private attempt = 0
  private hadConnection = false
  private connectedSince = 0
  private stash: { sid: number; frame: Record<string, unknown> }[] = []
  private pingTimer?: NodeJS.Timeout
  private ackTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private stopped = true
  /** null until detected against REST; true = no-leg prices needing the 1−p flip. */
  private noLegPricing: boolean | null = null
  private votesFlip = 0
  private votesDirect = 0
  /** Tickers the live subscription actually covers (vs the desired set). */
  private subscribed = new Set<string>()
  private lastCycleAt = 0
  readonly stats: WsStats = defaultWsStats()

  constructor(
    private readonly url: string,
    private readonly headers: () => Record<string, string>,
    private readonly onAlert?: (title: string, message: string) => void
  ) {}

  /** Books this client believes are LIVE (never returns STALE data). */
  getBook(ticker: string): OrderBook | null {
    const b = this.books.get(ticker)
    if (!b || b.status !== 'LIVE') return null
    // Until the price convention is settled the book is not interpretable.
    if (this.noLegPricing === null) return null
    return materialize(ticker, b, this.noLegPricing)
  }

  getStatus(ticker: string): BookStatus {
    return this.books.get(ticker)?.status ?? 'UNAVAILABLE'
  }

  start(tickers: string[]): void {
    this.stopped = false
    this.setTickers(tickers)
    if (!this.sock) this.connect()
  }

  /**
   * Update the desired universe. Resubscribing means cycling the socket
   * (one subscription per channel per session), which discards every book —
   * so a small drift in the scanned set must NOT trigger it. The scan
   * universe churns a little every pass; cycling on each one kept the cache
   * permanently empty, defeating the point of holding live books.
   */
  setTickers(tickers: string[]): void {
    const next = [...new Set(tickers)].sort()
    this.tickers = next
    if (!this.sock || this.sock.readyState !== WebSocket.OPEN) return
    const missing = next.filter((t) => !this.subscribed.has(t)).length
    const stale = [...this.subscribed].filter((t) => !next.includes(t)).length
    const drift = (missing + stale) / Math.max(next.length, 1)
    const sinceCycle = Date.now() - this.lastCycleAt
    if (drift >= 0.3 && sinceCycle > 5 * 60_000) this.cycle(`universe drift ${Math.round(drift * 100)}%`)
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.sock?.terminate()
    this.sock = null
    this.markAllStale()
    this.stats.connected = false
  }

  /**
   * Shadow check: does the WS book agree with a REST book for this ticker?
   * This is the guard for BOTH silent-corruption modes — wrong field names
   * yield an empty book, and an inverted price convention yields a mirrored
   * one. Either shows up here as disagreement.
   */
  compare(ticker: string, rest: OrderBook): void {
    const b = this.books.get(ticker)
    if (!b || b.status !== 'LIVE') return
    const rBid = rest.bids[0]?.price
    const rAsk = rest.asks[0]?.price
    if (rBid === undefined || rAsk === undefined) return

    // Convention detection: score BOTH readings of the no ladder against
    // REST. Only asymmetric books discriminate — when bestBid + bestAsk ≈ 1
    // the two readings coincide and the sample proves nothing.
    if (this.noLegPricing === null) {
      const flipped = materialize(ticker, b, true)
      const direct = materialize(ticker, b, false)
      const fAsk = flipped.asks[0]?.price
      const dAsk = direct.asks[0]?.price
      if (fAsk === undefined || dAsk === undefined) return
      if (Math.abs(fAsk - dAsk) * 100 < 5) return // indiscriminate sample
      const fErr = Math.abs(fAsk - rAsk)
      const dErr = Math.abs(dAsk - rAsk)
      if (Math.min(fErr, dErr) * 100 > 3) return // neither matches; bad sample
      if (fErr < dErr) this.votesFlip++
      else this.votesDirect++
      const total = this.votesFlip + this.votesDirect
      if (total >= 10) {
        // Require a decisive majority; a split vote means something else is
        // wrong and the socket must not be trusted at all.
        if (this.votesFlip >= 9) this.noLegPricing = true
        else if (this.votesDirect >= 9) this.noLegPricing = false
        else {
          this.trip(`price convention indeterminate (${this.votesFlip} flip vs ${this.votesDirect} direct)`)
          return
        }
        this.stats.convention = this.noLegPricing ? 'no-leg (1−p)' : 'yes-leg (direct)'
        this.onAlert?.(
          'Oracle Trader — WS price convention detected',
          `WebSocket no-ladder reads as ${this.stats.convention} (${this.votesFlip}/${total} flip votes). Shadow comparison continues.`
        )
      }
      return
    }

    const ws = materialize(ticker, b, this.noLegPricing)
    const wsBid = ws.bids[0]?.price
    const wsAsk = ws.asks[0]?.price
    if (wsBid === undefined || wsAsk === undefined) return
    this.stats.compared++
    const diff = Math.max(Math.abs(wsBid - rBid), Math.abs(wsAsk - rAsk)) * 100
    // 2¢ tolerance: the books are sampled at different instants.
    if (diff <= 2) this.stats.agreed++
    this.stats.maxDiffCents = Math.max(this.stats.maxDiffCents, Math.round(diff * 10) / 10)
    // Crossed books are impossible and mean the interpretation is wrong.
    if (wsAsk < wsBid) this.trip(`crossed book (bid ${wsBid.toFixed(2)} > ask ${wsAsk.toFixed(2)})`)
  }

  private trip(reason: string): void {
    if (this.stats.guardTripped) return
    this.stats.guardTripped = reason
    this.onAlert?.('Oracle Trader — WS guard tripped', `WebSocket books are not trustworthy: ${reason}. Staying on REST.`)
  }

  private connect(): void {
    if (this.stopped || this.tickers.length === 0) return
    this.stats.attempts++
    let sock: WebSocket
    try {
      // Headers are minted HERE, per attempt: a signature built before a
      // backoff sleep is stale and 401s on upgrade.
      sock = new WebSocket(this.url, { headers: this.headers(), perMessageDeflate: false, handshakeTimeout: 30_000 })
    } catch (err) {
      this.scheduleReconnect(fmt(err))
      return
    }
    this.sock = sock

    sock.on('open', () => {
      this.connectedSince = Date.now()
      this.stats.connected = true
      if (this.hadConnection) this.stats.reconnects++
      this.hadConnection = true
      this.heartbeat()
      this.subscribe()
    })
    sock.on('ping', () => this.heartbeat())
    sock.on('message', (raw) => {
      this.heartbeat()
      this.onMessage(raw)
    })
    // Every failure path must DROP the socket reference before scheduling:
    // the reconnect timer no-ops while this.sock is set, so a dead socket
    // left in place meant a refused connect / 401 / server close never
    // reconnected at all (observed: attempts stuck at 1, no alert).
    sock.on('unexpected-response', (_req, res) => {
      // 401 = bad key/clock/signature. Never tight-loop on it.
      this.dropSocket(sock)
      this.scheduleReconnect(`handshake ${res.statusCode}`)
      sock.terminate()
    })
    sock.on('error', (err) => {
      this.dropSocket(sock)
      this.scheduleReconnect(fmt(err))
    })
    sock.on('close', () => {
      this.stats.connected = false
      this.markAllStale()
      this.dropSocket(sock)
      this.scheduleReconnect('closed')
    })
  }

  private subscribe(): void {
    this.sid = null
    this.lastSeq = null
    this.stash = []
    // Chunked at 50 to stay under the (unpublished) per-subscription cap.
    const batch = this.tickers.slice(0, 50)
    this.subscribed = new Set(batch)
    this.lastCycleAt = Date.now()
    this.send({
      id: this.cmdId++,
      cmd: 'subscribe',
      params: { channels: ['orderbook_delta'], market_tickers: batch, use_yes_price: true, skip_ticker_ack: true }
    })
    // A socket that opens, authenticates, then ignores commands is invisible
    // to the ping watchdog — this is the only thing that catches it.
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = setTimeout(() => {
      if (this.sid === null) this.cycle('no subscribe ack in 10s')
    }, 10_000)
  }

  private onMessage(raw: WebSocket.RawData): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch {
      return
    }
    this.stats.frames++
    const type = frame['type'] as string | undefined
    const sid = typeof frame['sid'] === 'number' ? (frame['sid'] as number) : undefined
    const seq = typeof frame['seq'] === 'number' ? (frame['seq'] as number) : undefined

    if (type === 'subscribed') {
      const msg = (frame['msg'] ?? {}) as { sid?: number }
      this.sid = typeof msg.sid === 'number' ? msg.sid : (sid ?? null)
      if (this.ackTimer) clearTimeout(this.ackTimer)
      // Frames can arrive on a fresh sid BEFORE the ack — drain them through
      // the normal path so seq tracking stays consistent.
      const pending = this.stash.filter((s) => s.sid === this.sid)
      this.stash = []
      for (const p of pending) this.route(p.frame, p.sid, typeof p.frame['seq'] === 'number' ? (p.frame['seq'] as number) : undefined)
      return
    }
    if (type === 'error') {
      const msg = (frame['msg'] ?? {}) as { code?: number; msg?: string }
      this.stats.lastError = `${msg.code}: ${msg.msg}`
      // 10 channel error, 17 internal, 25 buffer overflow are terminal.
      if (msg.code === 10 || msg.code === 17 || msg.code === 25) this.cycle(`error ${msg.code}`)
      return
    }
    if (sid === undefined) return
    if (this.sid === null) {
      if (this.stash.length < 1000) this.stash.push({ sid, frame })
      return
    }
    this.route(frame, sid, seq)
  }

  private route(frame: Record<string, unknown>, sid: number, seq: number | undefined): void {
    if (sid !== this.sid) return
    const type = frame['type'] as string | undefined
    const isData = type === 'orderbook_snapshot' || type === 'orderbook_delta'
    if (seq !== undefined) {
      if (this.lastSeq === null) {
        this.lastSeq = seq
      } else if (seq === this.lastSeq) {
        return // duplicate — applying twice corrupts the book
      } else if (seq < this.lastSeq) {
        // Only DATA frames may signal a server-side reset. Control frames
        // are advance-only, which is correct whether or not they consume seq.
        if (!isData) return
        this.lastSeq = seq
        this.recover('sequence reset')
        return
      } else if (seq > this.lastSeq + 1) {
        this.lastSeq = seq
        this.stats.gaps++
        this.recover(`gap to ${seq}`)
        return
      } else {
        this.lastSeq = seq
      }
    }
    if (type === 'orderbook_snapshot') this.applySnapshot(frame['msg'] as WsSnapshotMsg)
    else if (type === 'orderbook_delta') this.applyDelta(frame['msg'] as WsDeltaMsg)
  }

  private applySnapshot(msg: WsSnapshotMsg | undefined): void {
    if (!msg?.market_ticker) return
    // Legacy/REST key shapes mean we are parsing the wrong message shape —
    // defaulting to [] here is exactly how a book goes permanently empty.
    if (msg.yes !== undefined || msg.no !== undefined || msg.yes_dollars !== undefined || msg.no_dollars !== undefined) {
      this.trip('snapshot carries REST/legacy key names — WS shape changed')
      return
    }
    const b = this.ensure(msg.market_ticker)
    b.yes = toLevels(msg.yes_dollars_fp)
    b.no = toLevels(msg.no_dollars_fp)
    b.status = 'LIVE'
    b.lastFrameMs = Date.now()
    this.stats.snapshots++
    this.recount()
  }

  private applyDelta(msg: WsDeltaMsg | undefined): void {
    if (!msg?.market_ticker || msg.side === undefined) return
    if (msg.price !== undefined || msg.delta !== undefined) {
      this.trip('delta carries legacy key names — WS shape changed')
      return
    }
    const b = this.books.get(msg.market_ticker)
    // A delta with no snapshot is not appliable — the book stays untrusted.
    if (!b || b.status !== 'LIVE') return
    const price = Math.round(parseFloat(msg.price_dollars ?? 'NaN') * PX)
    const delta = Math.round(parseFloat(msg.delta_fp ?? 'NaN') * SZ)
    if (!Number.isFinite(price) || !Number.isFinite(delta)) return
    const side = msg.side === 'yes' ? b.yes : b.no
    const next = (side.get(price) ?? 0) + delta
    if (next > 0) side.set(price, next)
    else side.delete(price)
    b.lastFrameMs = Date.now()
    this.stats.deltas++
  }

  /**
   * Gap recovery. Clearing state is NOT recovery — a cleared book with no
   * re-snapshot stays empty forever while deltas keep flowing. Every path
   * here ends in a fresh subscribe (which snapshots) via the cycle.
   */
  private recover(reason: string): void {
    this.markAllStale()
    this.cycle(reason)
  }

  private cycle(reason: string): void {
    this.stats.lastError = reason
    this.clearTimers()
    const s = this.sock
    this.sock = null
    this.sid = null
    this.lastSeq = null
    s?.terminate()
    this.markAllStale()
    this.scheduleReconnect(reason)
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return
    this.stats.lastError = reason
    // Reset backoff only after a connection SURVIVED — otherwise an
    // auth-reject loop keeps resetting it and hammers the endpoint.
    if (this.connectedSince && Date.now() - this.connectedSince > 30_000) this.attempt = 0
    this.connectedSince = 0
    // AWS full jitter: a flat jitter window is thundering-herd risk.
    const delay = Math.random() * Math.min(30_000, 500 * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 10)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.sock) return
      this.connect()
    }, Math.max(500, delay))
  }

  private heartbeat(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer)
    // Kalshi pings every 10s; ws auto-pongs. This detects ABSENCE.
    // terminate(), never close() — a half-open socket would hang the closing
    // handshake for 30s while books rot.
    this.pingTimer = setTimeout(() => this.cycle('no heartbeat in 25s'), 25_000)
  }

  /** Release a dead socket so the reconnect timer is allowed to act. clearTimers leaves reconnectTimer alone. */
  private dropSocket(sock: WebSocket): void {
    if (this.sock === sock) {
      this.sock = null
      this.clearTimers()
    }
  }

  private clearTimers(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer)
    if (this.ackTimer) clearTimeout(this.ackTimer)
  }

  private markAllStale(): void {
    for (const b of this.books.values()) if (b.status === 'LIVE') b.status = 'STALE'
    this.recount()
  }

  private recount(): void {
    let n = 0
    for (const b of this.books.values()) if (b.status === 'LIVE') n++
    this.stats.liveBooks = n
  }

  private ensure(ticker: string): BookState {
    let b = this.books.get(ticker)
    if (!b) {
      b = { yes: new Map(), no: new Map(), status: 'UNAVAILABLE', lastFrameMs: 0 }
      this.books.set(ticker, b)
    }
    return b
  }

  private send(obj: unknown): void {
    try {
      this.sock?.send(JSON.stringify(obj))
    } catch {
      // socket died mid-send; the close/error handler drives recovery
    }
  }
}

/** Levels arrive as [priceDollars, sizeFp] STRING tuples; absent key = empty side. */
function toLevels(rows: [string, string][] | undefined): Map<number, number> {
  const m = new Map<number, number>()
  for (const [p, s] of rows ?? []) {
    const price = Math.round(parseFloat(p) * PX)
    const size = Math.round(parseFloat(s) * SZ)
    if (Number.isFinite(price) && Number.isFinite(size) && size > 0) m.set(price, size)
  }
  return m
}

/**
 * Both WS ladders are BIDS (yes-leg bids and no-leg bids). With
 * use_yes_price=true the no ladder is already quoted in yes terms, so the
 * ask side is the no ladder mirrored: a no bid at p is an offer to sell YES
 * at 1−p. Ordering is not documented, so sort explicitly — trusting the
 * array order would silently yield the WORST price as top-of-book.
 */
export function materialize(ticker: string, b: BookState, noLegPricing: boolean): OrderBook {
  const bids = [...b.yes.entries()]
    .map(([p, s]) => ({ price: p / PX, size: s / SZ }))
    .sort((x, y) => y.price - x.price)
  // The no ladder is a ladder of BIDS on the NO leg. Whether its prices
  // arrive in no-leg terms (ask_yes = 1−p) or already converted to yes terms
  // (ask_yes = p) depends on use_yes_price AND on the server default, which
  // Kalshi has announced will flip. Both readings produce valid-looking
  // prices in 0..1, so the convention is DETECTED against REST, never assumed.
  const asks = [...b.no.entries()]
    .map(([p, s]) => ({ price: noLegPricing ? 1 - p / PX : p / PX, size: s / SZ }))
    .filter((l) => l.price > 0 && l.price < 1)
    .sort((x, y) => x.price - y.price)
  return { venue: 'kalshi', marketId: ticker, bids, asks }
}

function fmt(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)
}
