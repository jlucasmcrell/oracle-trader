// Spot-first shadow recorder (build-queue 63 / backlog 96, taxonomy E2). PUBLIC DATA ONLY; trades nothing;
// no keys. Coinbase spot ticks (public WebSocket) -> lognormal fair value for the OPEN Kalshi KX<COIN>15M
// market (strike = the window's floor_strike; sigma = annualised realised vol of Coinbase 1-minute log
// returns over the last 240 minutes, refreshed each window) against Kalshi's live top-of-book (public
// batched REST, every 2 s), plus Polymarket's CLOB top-of-book for the same window (public WebSocket) so
// the ordering spot -> Polymarket -> Kalshi can be measured instead of assumed. Three minutes after a
// window closes the recorder harvests Kalshi's result for it, so the grader (spot-shadow-gate.mjs) is
// fully offline. Output: data/spot-shadow/YYYY-MM-DD.jsonl; log: data/spot-shadow/recorder.log.
//
//   node scripts/spot-shadow.mjs          run (detached; the OracleTrader-SpotShadow task restarts it)
//   node scripts/spot-shadow.mjs --once   self-test: resolve the window, one sigma, one Kalshi poll, one
//                                         fair value from the REST spot ticker, print the rows, exit 0
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

const K = 'https://api.elections.kalshi.com/trade-api/v2'
const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const CB_WS = 'wss://advanced-trade-ws.coinbase.com'
const CB_REST = 'https://api.exchange.coinbase.com'
const OUT = process.env.SPOT_SHADOW_DIR || 'G:/PROJECTS/oracle-trader/data/spot-shadow'
// Coins with a Coinbase USD product AND a Kalshi 15-minute series. BNB/HYPE have no Coinbase feed.
export const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']
const KALSHI_POLL_MS = 2000
const SPOT_MIN_GAP_MS = 1000         // at most one spot row per second per coin...
const SPOT_JUMP = 3e-4               // ...plus one immediately on a >= 3 bps move, so jumps carry their own timestamp
const VOL_CANDLES = 240
const MS_PER_YEAR = 365.25 * 86400e3
const SETTLE_AFTER_MS = 180e3
const ONCE = process.argv.includes('--once')

mkdirSync(OUT, { recursive: true })
const LOG = join(OUT, 'recorder.log')
const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); if (!ONCE) try { appendFileSync(LOG, l + '\n') } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
const emit = (o) => { if (ONCE) console.log(JSON.stringify(o)); else appendFileSync(join(OUT, new Date().toISOString().slice(0, 10) + '.jsonl'), JSON.stringify(o) + '\n'); stats.rows++ }
const stats = { rows: 0, kPolls: 0, spotTicks: 0, pmMsgs: 0, errors: 0, settled: 0 }

async function get(u, tries = 3) {
  for (let a = 0; a < tries; a++) {
    let r
    try { r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'oracle-trader-shadow/1.0' } }) } catch (e) { if (a === tries - 1) throw e; await sleep(400); continue }
    if (r.ok) return r.json()
    if (r.status === 429 || r.status >= 500) { await sleep(500 * Math.pow(1.8, a)); continue }
    throw new Error(`HTTP ${r.status} ${u.slice(0, 80)}`)
  }
  throw new Error('exhausted')
}

// ---- fair value: P(S_T >= K) under a driftless lognormal, T = the settlement average's midpoint ----
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y }
const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2))
/** Kalshi settles on the 60 s average before close, so the effective horizon ends 30 s before close. */
export function fairValue(spot, strike, closeMs, nowMs, sigma) {
  if (!(spot > 0) || !(strike > 0) || !(sigma > 0)) return null
  const tauMs = closeMs - 30e3 - nowMs
  if (tauMs < 1000) return null
  const tau = tauMs / MS_PER_YEAR
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma * tau) / (sigma * Math.sqrt(tau))
  return Phi(d2)
}
/** Annualised sd of 1-minute log returns from Coinbase candles ([time, low, high, open, close, vol], newest first). */
export function sigmaFromCandles(candles, n = VOL_CANDLES) {
  const closes = candles.slice().sort((a, b) => a[0] - b[0]).slice(-n).map((c) => c[4]).filter((c) => c > 0)
  if (closes.length < 60) return null
  const lr = closes.slice(1).map((c, i) => Math.log(c / closes[i]))
  const m = lr.reduce((a, b) => a + b, 0) / lr.length
  const sd = Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / (lr.length - 1))
  return sd * Math.sqrt(525600)
}
export function topOfBook(ob) {
  const yes = (ob?.yes_dollars ?? ob?.yes ?? []).map(([p, q]) => [num(p), num(q)]).filter((x) => x[0] !== null)
  const no = (ob?.no_dollars ?? ob?.no ?? []).map(([p, q]) => [num(p), num(q)]).filter((x) => x[0] !== null)
  const yb = yes.length ? yes.reduce((m, x) => (x[0] > m[0] ? x : m)) : [null, null]
  const nb = no.length ? no.reduce((m, x) => (x[0] > m[0] ? x : m)) : [null, null]
  return { bid: yb[0], bidSz: yb[1], ask: nb[0] !== null ? +(1 - nb[0]).toFixed(4) : null, askSz: nb[1] }
}

const windowStart = (t = Date.now()) => Math.floor(t / 900e3) * 900 // epoch seconds; 15 m windows align in UTC and ET
const state = { win: 0, k: new Map(), pm: new Map(), spot: new Map(), sigma: new Map(), pmWs: null, cbWs: null, toSettle: [] }
// k: coin -> { ticker, K, closeMs }; pm: coin -> { token, bid, ask }; spot: coin -> { p, bb, ba, ts, recTs, recP }

async function refreshSigma(coin) {
  try {
    const c = await get(`${CB_REST}/products/${coin}-USD/candles?granularity=60`)
    const s = sigmaFromCandles(c)
    if (s) state.sigma.set(coin, s); else log(`${coin}: too few candles for sigma`)
  } catch (e) { stats.errors++; log(`${coin} sigma: ${e.message}`) }
}

async function resolveWindow(win) {
  const endMs = (win + 900) * 1000
  for (const coin of COINS) {
    if (!state.k.has(coin) || state.k.get(coin).K === null) {
      try {
        const j = await get(`${K}/markets?series_ticker=KX${coin}15M&status=open&limit=20`)
        const m = (j.markets ?? []).find((x) => Date.parse(x.close_time) === endMs)
        if (m) state.k.set(coin, { ticker: m.ticker, K: num(m.floor_strike), closeMs: endMs })
        else log(`${coin}: no Kalshi market closing ${new Date(endMs).toISOString()} (will retry)`)
      } catch (e) { stats.errors++; log(`${coin} Kalshi resolve: ${e.message}`) }
    }
    if (!state.pm.has(coin)) {
      try {
        const ev = await get(`${GAMMA}/events?slug=${coin.toLowerCase()}-updown-15m-${win}`)
        const m = (Array.isArray(ev) ? ev[0] : ev)?.markets?.[0]
        const ids = m?.clobTokenIds ? JSON.parse(m.clobTokenIds) : []
        const outcomes = m?.outcomes ? JSON.parse(m.outcomes) : []
        const upIdx = Math.max(0, outcomes.findIndex((o) => /up/i.test(o)))
        if (ids[upIdx]) state.pm.set(coin, { token: ids[upIdx], bid: null, ask: null }); else log(`${coin}: no Polymarket token for window ${win}`)
      } catch (e) { stats.errors++; log(`${coin} Polymarket resolve: ${e.message}`) }
    }
  }
  emit({ ts: new Date().toISOString(), v: 'win', win, coins: Object.fromEntries([...state.k].map(([c, v]) => [c, { t: v.ticker, K: v.K, sigma: state.sigma.get(c) ?? null }])) })
  log(`window ${win} (${new Date(win * 1000).toISOString().slice(11, 16)}Z): Kalshi ${[...state.k.values()].map((x) => `${x.ticker}@${x.K}`).join(',') || '-'} | PM ${[...state.pm.keys()].join(',') || '-'} | sigma ${[...state.sigma].map(([c, s]) => `${c} ${(s * 100).toFixed(0)}%`).join(' ')}`)
}

function connectCoinbase() {
  const ws = new WebSocket(CB_WS)
  state.cbWs = ws
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: COINS.map((c) => `${c}-USD`), channel: 'ticker' }))
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: COINS.map((c) => `${c}-USD`), channel: 'heartbeats' }))
    log('Coinbase ws subscribed')
  })
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.channel !== 'ticker' || !msg.events) return
    for (const ev of msg.events) for (const t of ev.tickers ?? []) {
      const p = num(t.price); if (p === null || p <= 0) continue
      const coin = String(t.product_id ?? '').split('-')[0]
      if (!COINS.includes(coin)) continue
      stats.spotTicks++
      const now = Date.now()
      const s = state.spot.get(coin) ?? { recTs: 0, recP: 0 }
      s.p = p; s.bb = num(t.best_bid); s.ba = num(t.best_ask); s.ts = now
      state.spot.set(coin, s)
      if (now - s.recTs >= SPOT_MIN_GAP_MS || Math.abs(p / s.recP - 1) >= SPOT_JUMP) {
        s.recTs = now; s.recP = p
        emit({ ts: new Date(now).toISOString(), v: 'spot', coin, p, bb: s.bb, ba: s.ba })
      }
    }
  })
  ws.on('error', (e) => { stats.errors++; log('Coinbase ws error ' + e.message) })
  ws.on('close', () => { if (state.cbWs === ws) { log('Coinbase ws closed; reconnecting in 3s'); setTimeout(() => { if (state.cbWs === ws) connectCoinbase() }, 3000) } })
}

function bestOf(levels, pick) {
  let b = null
  for (const l of levels ?? []) { const p = num(l.price); if (p === null) continue; if (b === null || (pick === 'max' ? p > b.p : p < b.p)) b = { p, s: num(l.size) } }
  return b
}
function connectPm() {
  if (state.pmWs) { const old = state.pmWs; state.pmWs = null; try { old.close() } catch {} }
  const tokens = [...state.pm.values()].map((x) => x.token)
  if (!tokens.length) return
  const ws = new WebSocket(CLOB_WS)
  state.pmWs = ws
  ws.on('open', () => { ws.send(JSON.stringify({ assets_ids: tokens, type: 'market' })); log(`PM ws subscribed ${tokens.length} tokens`) })
  ws.on('message', (raw) => {
    stats.pmMsgs++
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
          if (ch.side === 'BUY') rec.bid = num(ch.best_bid) ?? rec.bid
          if (ch.side === 'SELL') rec.ask = num(ch.best_ask) ?? rec.ask
        }
        emit({ ts: new Date().toISOString(), v: 'pm', coin, win: state.win, bid: rec.bid, ask: rec.ask, ev: 'price_change' })
      } else if (m.event_type === 'last_trade_price') {
        emit({ ts: new Date().toISOString(), v: 'pm', coin, win: state.win, last: num(m.price), side: m.side, ev: 'trade' })
      }
    }
  })
  ws.on('error', (e) => { stats.errors++; log('PM ws error ' + e.message) })
  ws.on('close', () => { if (state.pmWs === ws) { log('PM ws closed; reconnecting in 3s'); setTimeout(() => { if (state.pmWs === ws) connectPm() }, 3000) } })
}

async function pollKalshi() {
  const entries = [...state.k.entries()]
  if (!entries.length) return
  try {
    const j = await get(`${K}/markets/orderbooks?${entries.map(([, v]) => 'tickers=' + encodeURIComponent(v.ticker)).join('&')}`)
    stats.kPolls++
    const now = Date.now(), ts = new Date(now).toISOString()
    for (const o of j.orderbooks ?? []) {
      const hit = entries.find(([, v]) => v.ticker === o.ticker)
      if (!hit) continue
      const [coin, kv] = hit
      const tob = topOfBook(o.orderbook_fp ?? o.orderbook)
      const sp = state.spot.get(coin)
      const sigma = state.sigma.get(coin) ?? null
      const fv = sp && kv.K !== null && sigma ? fairValue(sp.p, kv.K, kv.closeMs, now, sigma) : null
      emit({ ts, v: 'k', coin, win: state.win, t: o.ticker, ...tob, spot: sp?.p ?? null, spotAge: sp ? now - sp.ts : null,
        K: kv.K, tauS: Math.round((kv.closeMs - now) / 1000), sigma: sigma === null ? null : +sigma.toFixed(4), fv: fv === null ? null : +fv.toFixed(4) })
    }
  } catch (e) { stats.errors++; log('Kalshi poll: ' + e.message) }
}

async function settleDue() {
  const now = Date.now()
  const due = state.toSettle.filter((x) => now - x.closeMs >= SETTLE_AFTER_MS)
  for (const x of due) {
    try {
      const j = await get(`${K}/markets/${encodeURIComponent(x.ticker)}`)
      const m = j.market ?? j
      if (m.result === 'yes' || m.result === 'no') {
        emit({ ts: new Date().toISOString(), v: 'settle', coin: x.coin, win: x.win, t: x.ticker, result: m.result, K: num(m.floor_strike), exp: num(m.expiration_value) })
        stats.settled++
        state.toSettle = state.toSettle.filter((y) => y !== x)
      } else if (now - x.closeMs > 3600e3) {
        log(`${x.ticker}: no result an hour after close; dropping`)
        state.toSettle = state.toSettle.filter((y) => y !== x)
      }
    } catch (e) { stats.errors++; log(`settle ${x.ticker}: ${e.message}`) }
    await sleep(250)
  }
}

process.on('unhandledRejection', (e) => { stats.errors++; log('unhandledRejection ' + (e && e.message)) })
process.on('uncaughtException', (e) => { stats.errors++; log('uncaughtException ' + (e && e.message)) })

if (ONCE) {
  ;(async () => {
    const win = windowStart()
    state.win = win
    for (const coin of COINS) {
      await refreshSigma(coin)
      try { const t = await get(`${CB_REST}/products/${coin}-USD/ticker`); state.spot.set(coin, { p: num(t.price), bb: num(t.bid), ba: num(t.ask), ts: Date.now(), recTs: 0, recP: 0 }) } catch (e) { log(`${coin} spot: ${e.message}`) }
    }
    await resolveWindow(win)
    await pollKalshi()
    const ok = stats.kPolls === 1 && state.k.size >= 1 && [...state.k.values()].some((v) => v.K !== null) && state.sigma.size >= 1
    log(`self-test ${ok ? 'OK' : 'FAILED'}: kalshi ${state.k.size}/${COINS.length}, sigma ${state.sigma.size}, spot ${state.spot.size}, pm ${state.pm.size}, errors ${stats.errors}`)
    process.exit(ok ? 0 : 1)
  })()
} else {
  log(`spot-first shadow recorder start -> ${OUT}`)
  connectCoinbase()
  ;(async () => {
    let lastBeat = 0, lastResolve = 0
    for (;;) {
      const win = windowStart()
      if (win !== state.win) {
        // Queue the closing window's tickers for settlement, then roll.
        for (const [coin, v] of state.k) state.toSettle.push({ coin, win: state.win, ticker: v.ticker, closeMs: v.closeMs })
        state.win = win; state.k.clear(); state.pm.clear()
        for (const coin of COINS) await refreshSigma(coin)
        await resolveWindow(win)
        connectPm()
        lastResolve = Date.now()
      } else if ((state.k.size < COINS.length || state.pm.size < COINS.length || [...state.k.values()].some((v) => v.K === null)) && Date.now() - lastResolve > 20000) {
        const before = [...state.pm.values()].map((x) => x.token).join(',')
        for (const [coin, v] of [...state.k]) if (v.K === null) state.k.delete(coin) // re-fetch until the strike is published
        await resolveWindow(win)
        lastResolve = Date.now()
        if ([...state.pm.values()].map((x) => x.token).join(',') !== before) connectPm()
      }
      await pollKalshi()
      await settleDue()
      if (Date.now() - lastBeat > 600000) { lastBeat = Date.now(); log(`heartbeat: window ${state.win}, rows ${stats.rows}, Kalshi polls ${stats.kPolls}, spot ticks ${stats.spotTicks}, PM msgs ${stats.pmMsgs}, settled ${stats.settled}, errors ${stats.errors}`) }
      await sleep(KALSHI_POLL_MS)
    }
  })()
}
