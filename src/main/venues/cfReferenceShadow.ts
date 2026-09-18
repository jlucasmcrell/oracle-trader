import WebSocket from 'ws'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KalshiAdapter } from './kalshi'

const INDICES = ['BRTI', 'ETHUSD_RTI', 'SOLUSD_RTI', 'XRPUSD_RTI', 'DOGEUSD_RTI', 'BNBUSD_RTI', 'HYPEUSD_RTI']

/** Raw reference observations only: this module has no order API and produces no trading signal. */
export function cfObservation(frame: any, receivedAt: number) {
  if (frame?.type !== 'cfbenchmarks_value' || !INDICES.includes(frame.msg?.index_id)) return undefined
  const raw = typeof frame.msg.data === 'string' ? JSON.parse(frame.msg.data) : frame.msg.data
  const value = Number(raw?.value), sourceAt = Number(raw?.time)
  if (!(value > 0) || !Number.isFinite(value) || !Number.isSafeInteger(sourceAt) || sourceAt <= 0 || Math.abs(receivedAt - sourceAt) > 60_000) return undefined
  return { receivedAt, sourceAt, index: frame.msg.index_id, value,
    average60s: frame.msg.avg_60s_data ?? null, finalMinuteAverage: frame.msg.last_60s_windowed_average_15min ?? null }
}

export function startCfReferenceShadow(adapter: KalshiAdapter, directory: string): () => void {
  mkdirSync(directory, { recursive: true })
  let socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false, lastFrame = Date.now(), lastStatus = 0, rows = 0, backoff = 60_000
  const recorded = new Map<string, number>()
  const status = (state: string) => {
    lastStatus = Date.now()
    try { writeFileSync(join(directory, 'status.json'), JSON.stringify({ at: new Date().toISOString(), state, rows, lastFrame })) } catch { /* observations still attempt their own writes */ }
  }
  const connect = () => {
    if (stopped) return
    const url = adapter.wsUrl()
    let ws: WebSocket
    const reconnect = () => {
      if (socket !== ws) return
      socket = undefined
      status('disconnected')
      if (!stopped) { retry = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15 * 60_000) }
    }
    try { ws = new WebSocket(url, { headers: adapter.wsHeaders(url), handshakeTimeout: 15000, perMessageDeflate: false }) }
    catch { status('authentication unavailable'); if (!stopped) retry = setTimeout(connect, 15 * 60_000); return }
    socket = ws
    ws.on('open', () => {
      lastFrame = Date.now()
      ws.send(JSON.stringify({ id: 1, cmd: 'subscribe', params: { channels: ['cfbenchmarks_value'], index_ids: INDICES } }))
      status('subscription requested')
    })
    ws.on('ping', () => { lastFrame = Date.now() })
    ws.on('message', raw => {
      lastFrame = Date.now()
      try {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'error') { console.warn('[cf-reference] subscription refused'); status('subscription refused'); ws.terminate(); return }
        const row = cfObservation(frame, lastFrame)
        if (!row || row.sourceAt - (recorded.get(row.index) ?? 0) < 2000) return
        appendFileSync(join(directory, new Date(row.receivedAt).toISOString().slice(0, 10) + '.jsonl'), JSON.stringify(row) + '\n')
        recorded.set(row.index, row.sourceAt); rows++; backoff = 60_000
        if (rows === 1) console.log('[cf-reference] authenticated reference observations received; shadow only')
        if (Date.now() - lastStatus > 60_000 || rows === 1) status('recording')
      } catch (e) { console.warn('[cf-reference] observation rejected:', e instanceof Error ? e.message : String(e)) }
    })
    ws.on('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); reconnect() })
    ws.on('error', () => { ws.terminate(); reconnect() })
    ws.on('close', reconnect)
  }
  const watchdog = setInterval(() => { if (socket && Date.now() - lastFrame > 60_000) socket.terminate() }, 30_000)
  connect()
  return () => { stopped = true; if (retry) clearTimeout(retry); clearInterval(watchdog); socket?.terminate() }
}
