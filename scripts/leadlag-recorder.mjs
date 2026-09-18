// Lead-lag recorder: Polymarket.com CLOB (read-only, public WebSocket) vs Kalshi
// (public REST, 2-second polling) on the SAME 15-minute BTC/ETH up-or-down
// windows. Both venues run the :00/:15/:30/:45 ET clock: Kalshi KX{COIN}15M
// closes at the window end; Polymarket's event slug is
// `{coin}-updown-15m-<window start epoch>`. Records top-of-book on every
// Polymarket update and every 2 s on Kalshi so the claim "Polymarket leads,
// Kalshi rests stale for 15-90 s" can be measured instead of assumed.
// Public data only; trades nothing. Output: data/leadlag/YYYY-MM-DD.jsonl.
//
//   node scripts/leadlag-recorder.mjs
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

const K = 'https://api.elections.kalshi.com/trade-api/v2'
const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const CLOB_REST = 'https://clob.polymarket.com'
const OUT = process.env.LEADLAG_DIR || 'G:/PROJECTS/oracle-trader/data/leadlag'
const COINS = [{ coin: 'BTC', pmSlug: 'btc', kSeries: 'KXBTC15M' }, { coin: 'ETH', pmSlug: 'eth', kSeries: 'KXETH15M' }]
const KALSHI_POLL_MS = 2000
mkdirSync(OUT, { recursive: true })
const LOG = join(OUT, 'recorder.log')
const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); try { appendFileSync(LOG, l + '\n') } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
const emit = (o) => appendFileSync(join(OUT, new Date().toISOString().slice(0, 10) + '.jsonl'), JSON.stringify(o) + '\n')
let errors = 0, pmMsgs = 0, kPolls = 0

async function get(u, tries = 3) {
  for (let a = 0; a < tries; a++) {
    let r
    try { r = await fetch(u, { signal: AbortSignal.timeout(15000) }) } catch (e) { if (a === tries - 1) throw e; await sleep(400); continue }
    if (r.ok) return r.json()
    if (r.status === 429 || r.status >= 500) { await sleep(500 * Math.pow(1.8, a)); continue }
    throw new Error(`HTTP ${r.status} ${u.slice(0, 70)}`)
  }
  throw new Error('exhausted')
}

const windowStart = (t = Date.now()) => Math.floor(t / 900e3) * 900   // epoch seconds
const state = { win: 0, pm: new Map(), k: new Map(), ws: null }        // pm: coin -> { token, bid, ask }; k: coin -> { ticker }

async function resolveWindow(win) {
  const end = new Date((win + 900) * 1000).toISOString()
  for (const c of COINS) {
    // Polymarket: event by slug -> first market -> Up token (outcomes[0])
    try {
      const ev = await get(`${GAMMA}/events?slug=${c.pmSlug}-updown-15m-${win}`)
      const m = (Array.isArray(ev) ? ev[0] : ev)?.markets?.[0]
      const ids = m?.clobTokenIds ? JSON.parse(m.clobTokenIds) : []
      const outcomes = m?.outcomes ? JSON.parse(m.outcomes) : []
      const upIdx = Math.max(0, outcomes.findIndex((o) => /up/i.test(o)))
      if (ids[upIdx]) { if (!state.pm.has(c.coin)) state.pm.set(c.coin, { token: ids[upIdx], question: m.question, bid: null, ask: null }) } else log(`${c.coin}: no PM token for window ${win}`)
    } catch (e) { errors++; log(`${c.coin} PM resolve: ${e.message}`) }
    // Kalshi: the open market of the series whose close_time is the window end
    try {
      const j = await get(`${K}/markets?series_ticker=${c.kSeries}&status=open&limit=20`)
      // Kalshi omits milliseconds in close_time; compare numerically, not as strings.
      const m = (j.markets ?? []).find((x) => Date.parse(x.close_time) === Date.parse(end))
      if (m) state.k.set(c.coin, { ticker: m.ticker, floor: num(m.floor_strike) }); else log(`${c.coin}: no Kalshi market closing ${end} (will retry)`)
    } catch (e) { errors++; log(`${c.coin} Kalshi resolve: ${e.message}`) }
  }
  log(`window ${win} (${new Date(win * 1000).toISOString().slice(11, 16)}Z): PM ${[...state.pm.keys()].join(',') || '-'} | Kalshi ${[...state.k.values()].map((x) => x.ticker).join(',') || '-'}`)
}

function bestOf(levels, pick) {
  // levels: [{price, size}] ; pick 'max' for bids, 'min' for asks
  let b = null
  for (const l of levels ?? []) { const p = num(l.price); if (p === null) continue; if (b === null || (pick === 'max' ? p > b.p : p < b.p)) b = { p, s: num(l.size) } }
  return b
}

function connectPm() {
  if (state.ws) { try { state.ws.close() } catch {} }
  const tokens = [...state.pm.values()].map((x) => x.token)
  if (!tokens.length) return
  const ws = new WebSocket(CLOB_WS)
  state.ws = ws
  ws.on('open', () => { ws.send(JSON.stringify({ assets_ids: tokens, type: 'market' })); log(`PM ws subscribed ${tokens.length} tokens`) })
  ws.on('message', (raw) => {
    pmMsgs++
    let msgs; try { msgs = JSON.parse(raw.toString()) } catch { return }
    for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
      const coin = [...state.pm.entries()].find(([, v]) => v.token === m.asset_id)?.[0]
      if (!coin) continue
      const rec = state.pm.get(coin)
      if (m.event_type === 'book') {
        const bb = bestOf(m.bids, 'max'), ba = bestOf(m.asks, 'min')
        rec.bid = bb?.p ?? null; rec.ask = ba?.p ?? null
        emit({ ts: new Date().toISOString(), v: 'pm', coin, win: state.win, bid: rec.bid, ask: rec.ask, bidSz: bb?.s ?? null, askSz: ba?.s ?? null, ev: 'book' })
      } else if (m.event_type === 'price_change') {
        for (const ch of m.changes ?? m.price_changes ?? []) {
          const p = num(ch.price), side = ch.side
          if (side === 'BUY' && p !== null && (rec.bid === null || p >= rec.bid || num(ch.size) === 0)) rec.bid = num(ch.best_bid) ?? rec.bid
          if (side === 'SELL' && p !== null) rec.ask = num(ch.best_ask) ?? rec.ask
        }
        emit({ ts: new Date().toISOString(), v: 'pm', coin, win: state.win, bid: rec.bid, ask: rec.ask, ev: 'price_change', raw: (m.changes ?? m.price_changes ?? []).slice(0, 3) })
      } else if (m.event_type === 'last_trade_price') {
        emit({ ts: new Date().toISOString(), v: 'pm', coin, win: state.win, last: num(m.price), side: m.side, ev: 'trade' })
      }
    }
  })
  ws.on('error', (e) => { errors++; log('PM ws error ' + e.message) })
  ws.on('close', () => { if (state.ws === ws) { log('PM ws closed; reconnecting in 3s'); setTimeout(() => { if (state.ws === ws) connectPm() }, 3000) } })
}

async function pollKalshi() {
  const tickers = [...state.k.values()].map((x) => x.ticker)
  if (!tickers.length) return
  try {
    const j = await get(`${K}/markets/orderbooks?${tickers.map((t) => 'tickers=' + encodeURIComponent(t)).join('&')}`)
    kPolls++
    const ts = new Date().toISOString()
    for (const o of j.orderbooks ?? []) {
      const coin = [...state.k.entries()].find(([, v]) => v.ticker === o.ticker)?.[0]
      if (!coin) continue
      const ob = o.orderbook_fp ?? o.orderbook ?? {}
      const yes = (ob.yes_dollars ?? ob.yes ?? []).map(([p, q]) => [num(p), num(q)])
      const no = (ob.no_dollars ?? ob.no ?? []).map(([p, q]) => [num(p), num(q)])
      const yb = yes.length ? yes.reduce((m, x) => (x[0] > m[0] ? x : m)) : [null, null]
      const nb = no.length ? no.reduce((m, x) => (x[0] > m[0] ? x : m)) : [null, null]
      emit({ ts, v: 'kalshi', coin, win: state.win, t: o.ticker, bid: yb[0], ask: nb[0] !== null ? +(1 - nb[0]).toFixed(4) : null, bidSz: yb[1], askSz: nb[1] })
    }
  } catch (e) { errors++; log('Kalshi poll: ' + e.message) }
}

// Also poll the PM REST book every 10 s as a cross-check of the WS stream.
async function pollPmRest() {
  for (const [coin, rec] of state.pm) {
    try {
      const b = await get(`${CLOB_REST}/book?token_id=${rec.token}`)
      const bb = bestOf(b.bids, 'max'), ba = bestOf(b.asks, 'min')
      emit({ ts: new Date().toISOString(), v: 'pm', coin, win: state.win, bid: bb?.p ?? null, ask: ba?.p ?? null, bidSz: bb?.s ?? null, askSz: ba?.s ?? null, ev: 'rest' })
    } catch (e) { errors++; log(`PM rest ${coin}: ${e.message}`) }
  }
}

process.on('unhandledRejection', (e) => { errors++; log('unhandledRejection ' + (e && e.message)) })
process.on('uncaughtException', (e) => { errors++; log('uncaughtException ' + (e && e.message)) })
log(`lead-lag recorder start -> ${OUT}`)
;(async () => {
  let lastRest = 0, lastBeat = 0, lastResolve = 0
  for (;;) {
    const win = windowStart()
    if (win !== state.win) {
      state.win = win; state.pm.clear(); state.k.clear()
      await resolveWindow(win)
      connectPm()
      lastResolve = Date.now()
    } else if ((state.k.size < COINS.length || state.pm.size < COINS.length) && Date.now() - lastResolve > 30000) {
      // Late listing: keep trying until both venues are resolved for this window.
      const before = [...state.pm.values()].map((x) => x.token).join(',')
      await resolveWindow(win)
      lastResolve = Date.now()
      const after = [...state.pm.values()].map((x) => x.token).join(',')
      if (after !== before) connectPm()
    }
    await pollKalshi()
    if (Date.now() - lastRest > 10000) { lastRest = Date.now(); await pollPmRest() }
    if (Date.now() - lastBeat > 600000) { lastBeat = Date.now(); log(`heartbeat: window ${state.win}, PM msgs ${pmMsgs}, Kalshi polls ${kPolls}, errors ${errors}`) }
    await sleep(KALSHI_POLL_MS)
  }
})()
