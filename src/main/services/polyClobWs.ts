/**
 * Polymarket CLOB market WebSocket - top-of-book per token, SHADOW ONLY (2026-09-19, §131).
 *
 * Lead-lag reads the Polymarket book by REST once a minute. This keeps a pushed top-of-book for the tokens it
 * is watching so every dislocation row can carry what the socket showed at decision time (bid, ask, age, and how
 * many top-of-book changes arrived since the token was subscribed). Nothing trades off it until the
 * pre-registered read (docs/PREREGISTERED-leadlag-polyws-shadow.md) says the feed agrees with REST and moves
 * often enough between polls to be worth acting on.
 *
 * Protocol (measured 2026-09-19): connect to wss://ws-subscriptions-clob.polymarket.com/ws/market, send
 * {"assets_ids":[...],"type":"market"}; the first frame per token is a `book` event (full bids/asks), then
 * `price_change` frames whose entries carry `best_bid`/`best_ask` for the asset. Text "PING" keeps it alive.
 * The subscription set changes whenever a 15-minute window rolls, so a change reconnects with the new list.
 */
import WebSocket from 'ws'

export interface PolyTop {
  bid: number
  ask: number
  /** Wall-clock ms of the frame that set this top. */
  at: number
  /** Top-of-book changes seen for the token since it was subscribed. */
  changes: number
}

export interface PolyClobWsStats {
  connected: boolean
  attempts: number
  reconnects: number
  frames: number
  books: number
  priceChanges: number
  subscribed: number
  lastError?: string
}

const URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const num = (v: unknown): number | null => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : null }

/** Pure: fold one frame (object or array of objects) into the tops map. Exported for the tests. */
export function applyClobFrame(tops: Map<string, PolyTop>, frame: unknown, now: number): { books: number; priceChanges: number } {
  const out = { books: 0, priceChanges: 0 }
  const msgs = Array.isArray(frame) ? frame : [frame]
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const r = m as Record<string, unknown>
    if (Array.isArray(r.bids) && Array.isArray(r.asks) && typeof r.asset_id === 'string') {
      const bids = (r.bids as { price?: unknown }[]).map((l) => num(l.price)).filter((p): p is number => p !== null)
      const asks = (r.asks as { price?: unknown }[]).map((l) => num(l.price)).filter((p): p is number => p !== null)
      if (!bids.length || !asks.length) continue
      const bid = Math.max(...bids), ask = Math.min(...asks)
      const prev = tops.get(r.asset_id)
      tops.set(r.asset_id, { bid, ask, at: now, changes: (prev?.changes ?? 0) + (prev && (prev.bid !== bid || prev.ask !== ask) ? 1 : 0) })
      out.books++
      continue
    }
    if (Array.isArray(r.price_changes)) {
      for (const c of r.price_changes as Record<string, unknown>[]) {
        const id = typeof c.asset_id === 'string' ? c.asset_id : null
        const bid = num(c.best_bid), ask = num(c.best_ask)
        if (!id || bid === null || ask === null) continue
        const prev = tops.get(id)
        const moved = !prev || prev.bid !== bid || prev.ask !== ask
        tops.set(id, { bid, ask, at: now, changes: (prev?.changes ?? 0) + (moved ? 1 : 0) })
        out.priceChanges++
      }
    }
  }
  return out
}

export class PolyClobWs {
  readonly stats: PolyClobWsStats = { connected: false, attempts: 0, reconnects: 0, frames: 0, books: 0, priceChanges: 0, subscribed: 0 }
  private tops = new Map<string, PolyTop>()
  private wanted = new Set<string>()
  private sock: WebSocket | null = null
  private pingTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private stopped = false

  constructor(private readonly log: (s: string) => void = () => undefined) {}

  private note(s: string): void {
    this.log(`[poly-ws] ${s}`)
  }

  /** Watch these tokens (idempotent). A changed set reconnects with the new subscription list. */
  ensure(tokens: string[]): void {
    const next = new Set(tokens.filter(Boolean))
    let changed = next.size !== this.wanted.size
    for (const t of next) if (!this.wanted.has(t)) changed = true
    if (!changed) { if (!this.sock && !this.reconnectTimer) this.connect(); return }
    this.wanted = next
    for (const t of [...this.tops.keys()]) if (!next.has(t)) this.tops.delete(t)
    this.stats.subscribed = next.size
    this.close()
    if (next.size) this.connect()
  }

  top(token: string): PolyTop | undefined {
    return this.tops.get(token)
  }

  stop(): void {
    this.stopped = true
    this.close()
  }

  private close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.pingTimer = undefined
    this.reconnectTimer = undefined
    const s = this.sock
    this.sock = null
    this.stats.connected = false
    try { s?.close() } catch { /* already closed */ }
  }

  private connect(): void {
    if (this.stopped || !this.wanted.size) return
    this.stats.attempts++
    let sock: WebSocket
    try {
      sock = new WebSocket(URL)
    } catch (e) {
      this.stats.lastError = e instanceof Error ? e.message : String(e)
      this.scheduleReconnect()
      return
    }
    this.sock = sock
    sock.on('open', () => {
      if (this.sock !== sock) return
      this.stats.connected = true
      sock.send(JSON.stringify({ assets_ids: [...this.wanted], type: 'market' }))
      this.pingTimer = setInterval(() => { try { sock.send('PING') } catch { /* dropped */ } }, 10_000)
      this.pingTimer.unref?.()
    })
    sock.on('message', (data) => {
      if (this.sock !== sock) return
      this.stats.frames++
      const text = String(data)
      if (text === 'PONG') return
      let frame: unknown
      try { frame = JSON.parse(text) } catch { return }
      const r = applyClobFrame(this.tops, frame, Date.now())
      this.stats.books += r.books
      this.stats.priceChanges += r.priceChanges
    })
    sock.on('error', (e) => {
      this.stats.lastError = e instanceof Error ? e.message : String(e)
      if (this.stats.reconnects <= 1) this.note(`socket error: ${this.stats.lastError.slice(0, 80)}`)
    })
    sock.on('close', () => {
      if (this.sock !== sock) return
      this.stats.connected = false
      this.sock = null
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = undefined
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.stats.reconnects++
    const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(5, this.stats.reconnects)))
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect() }, delay)
    this.reconnectTimer.unref?.()
  }
}
