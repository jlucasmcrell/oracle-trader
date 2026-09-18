// Multi-series crypto ladder collector for the pre-registered convergence
// tests (docs/PREREGISTERED-btc-convergence.md and successors). Public data
// only, no credentials, places nothing.
//
// Records, every minute, for every configured Kalshi series:
//   ladder  - every open market closing within the series horizon (strike,
//             yes bid/ask + sizes), plus that coin's spot (Coinbase; Kraken
//             cross-check for BTC).
//   book    - live order books at the series' capture windows (minutes to
//             close) for strikes within BOOK_BAND of spot; one capture per
//             (event, window).
//   settled - result + expiration_value (CF Benchmarks index at close) every
//             30 minutes, for grading and the spot-vs-index basis check.
// Kalshi keeps ~2 weeks of 1-minute candles, so this is the durable record.
//
//   node scripts/btc-collector.mjs            run forever
//   node scripts/btc-collector.mjs --once     one tick, then exit
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const B = 'https://api.elections.kalshi.com/trade-api/v2'
const OUT_DIR = process.env.BTC_COLLECTOR_DIR || 'G:/PROJECTS/oracle-trader/data/btc-collector'
const ONCE = process.argv.includes('--once')
const BOOK_BAND = 0.012
const BOOK_CAP = 24

// kind 'hourly' = strike ladders closing 14:00Z/21:00Z (188 strikes); kind '15m' = one
// up/down market per 15-minute window, floor_strike = index average at window open.
const SERIES = [
  { s: 'KXBTCD', kind: 'hourly', coin: 'BTC', windows: [5, 15, 30], horizonMin: 65 },
  { s: 'KXETHD', kind: 'hourly', coin: 'ETH', windows: [5, 15, 30], horizonMin: 65 },
  { s: 'KXSOLD', kind: 'hourly', coin: 'SOL', windows: [5, 15, 30], horizonMin: 65 },
  { s: 'KXXRPD', kind: 'hourly', coin: 'XRP', windows: [5, 15, 30], horizonMin: 65 },
  { s: 'KXBTC15M', kind: '15m', coin: 'BTC', windows: [2, 3, 5], horizonMin: 20 },
  { s: 'KXETH15M', kind: '15m', coin: 'ETH', windows: [2, 3, 5], horizonMin: 20 },
  { s: 'KXSOL15M', kind: '15m', coin: 'SOL', windows: [2, 3, 5], horizonMin: 20 },
  { s: 'KXXRP15M', kind: '15m', coin: 'XRP', windows: [2, 3, 5], horizonMin: 20 },
  { s: 'KXDOGE15M', kind: '15m', coin: 'DOGE', windows: [2, 3, 5], horizonMin: 20 },
  // Daily high-temperature ladders. No spot feed: books for every strike, plus a
  // point-in-time GFS ensemble snapshot (Open-Meteo, key-free) at each window, so
  // the forward weather test has the forecast that was actually available at T.
  { s: 'KXHIGHNY', kind: 'daily', coin: 'WX-NY', windows: [360, 720, 1440], horizonMin: 1500, wx: { lat: 40.78, lon: -73.97, tz: 'America/New_York' } },
  // Chicago settles on The Weather Company's MIDWAY reading (CLIMDW), not O'Hare (verified in rules_primary 2026-09-02).
  { s: 'KXHIGHCHI', kind: 'daily', coin: 'WX-CHI', windows: [360, 720, 1440], horizonMin: 1500, wx: { lat: 41.79, lon: -87.75, tz: 'America/Chicago' } },
  { s: 'KXHIGHMIA', kind: 'daily', coin: 'WX-MIA', windows: [360, 720, 1440], horizonMin: 1500, wx: { lat: 25.79, lon: -80.29, tz: 'America/New_York' } },
  { s: 'KXHIGHLAX', kind: 'daily', coin: 'WX-LAX', windows: [360, 720, 1440], horizonMin: 1500, wx: { lat: 33.94, lon: -118.41, tz: 'America/Los_Angeles' } },
  { s: 'KXHIGHDEN', kind: 'daily', coin: 'WX-DEN', windows: [360, 720, 1440], horizonMin: 1500, wx: { lat: 39.86, lon: -104.67, tz: 'America/Denver' } },
]
const COINS = [...new Set(SERIES.map((x) => x.coin))].filter((c) => !c.startsWith('WX-'))
const WINDOW_TOL = 0.75

mkdirSync(OUT_DIR, { recursive: true })
const LOG = join(OUT_DIR, 'collector.log')
const log = (s) => { const line = `[${new Date().toISOString()}] ${s}`; console.log(line); try { appendFileSync(LOG, line + '\n') } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
const dayFile = () => join(OUT_DIR, new Date().toISOString().slice(0, 10) + '.jsonl')
let written = 0, errors = 0, ticks = 0
const emit = (obj) => { try { appendFileSync(dayFile(), JSON.stringify(obj) + '\n'); written++ } catch (e) { errors++; log('WRITE FAIL ' + e.message) } }

async function get(u, tries = 4) {
  for (let a = 0; a < tries; a++) {
    let r
    try { r = await fetch(u, { signal: AbortSignal.timeout(15000) }) } catch (e) { if (a === tries - 1) throw e; await sleep(500); continue }
    if (r.ok) return r.json()
    if (r.status === 429 || r.status >= 500) { await sleep(500 * Math.pow(1.8, a)); continue }
    throw new Error(`HTTP ${r.status} ${u.slice(0, 80)}`)
  }
  throw new Error('exhausted ' + u.slice(0, 80))
}

async function spots() {
  const out = {}
  await Promise.all(COINS.map(async (c) => {
    const o = { cb: null, cb_bid: null, cb_ask: null, cb_time: null, kr: null }
    try { const j = await get(`https://api.exchange.coinbase.com/products/${c}-USD/ticker`); o.cb = num(j.price); o.cb_bid = num(j.bid); o.cb_ask = num(j.ask); o.cb_time = j.time ?? null } catch (e) { errors++; log(`spot coinbase ${c}: ${e.message}`) }
    if (c === 'BTC') { try { const j = await get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD'); const k = j.result && Object.values(j.result)[0]; o.kr = k && k.c ? num(k.c[0]) : null } catch (e) { errors++; log('spot kraken: ' + e.message) } }
    out[c] = o
  }))
  return out
}

async function openMarkets(series) {
  const all = []; let cursor
  for (let p = 0; p < 5; p++) {
    const j = await get(`${B}/markets?series_ticker=${series}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    all.push(...(j.markets ?? [])); cursor = j.cursor; if (!cursor) break
  }
  return all
}

const bookDone = new Set()
let lastSettled = 0
const settledSeen = new Set()

async function tick() {
  ticks++
  const now = Date.now(), ts = new Date(now).toISOString()
  const sp = await spots()
  let inWindow = 0
  for (const cfg of SERIES) {
    let markets
    try { markets = await openMarkets(cfg.s) } catch (e) { errors++; log(`ladder ${cfg.s}: ${e.message}`); continue }
    const events = new Map()
    for (const m of markets) {
      const close = m.close_time ? Date.parse(m.close_time) : NaN
      if (!Number.isFinite(close)) continue
      const mtc = (close - now) / 60e3
      if (mtc < -1 || mtc > cfg.horizonMin) continue
      const ev = m.event_ticker ?? m.ticker
      if (!events.has(ev)) events.set(ev, { ev, close: m.close_time, mtc: +mtc.toFixed(2), strikes: [] })
      events.get(ev).strikes.push([num(m.floor_strike), num(m.yes_bid_dollars), num(m.yes_ask_dollars), num(m.yes_bid_size_fp), num(m.yes_ask_size_fp), m.ticker, num(m.cap_strike)])
    }
    const spot = sp[cfg.coin]
    for (const e of events.values()) {
      inWindow++
      e.strikes.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
      // Weather rows keep ticker + cap (direction and bounds live there); crypto ladders are 188 strikes, so keep them compact.
      emit({ ts, kind: 'ladder', series: cfg.s, coin: cfg.coin, ev: e.ev, close: e.close, mtc: e.mtc, spot: spot ?? null, n: e.strikes.length, strikes: cfg.wx ? e.strikes.map((s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6]]) : e.strikes.map((s) => s.slice(0, 5)) })
      if (!cfg.wx && (!spot || spot.cb === null)) continue
      for (const w of cfg.windows) {
        const key = `${e.ev}|${w}`
        if (bookDone.has(key) || Math.abs(e.mtc - w) > WINDOW_TOL) continue
        bookDone.add(key)
        const near = cfg.wx
          ? e.strikes.slice(0, BOOK_CAP)
          : e.strikes.filter((s) => s[0] !== null && Math.abs(spot.cb - s[0]) / spot.cb <= BOOK_BAND)
              .sort((a, b) => Math.abs(spot.cb - a[0]) - Math.abs(spot.cb - b[0])).slice(0, BOOK_CAP)
        if (cfg.wx) {
          // Point-in-time GFS ensemble (31 members) for the city: the forecast that was available at T.
          try {
            const u = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${cfg.wx.lat}&longitude=${cfg.wx.lon}&models=gfs_seamless&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&forecast_days=3&timezone=${encodeURIComponent(cfg.wx.tz)}`
            const f = await get(u)
            emit({ ts: new Date().toISOString(), kind: 'forecast', series: cfg.s, coin: cfg.coin, ev: e.ev, close: e.close, w, mtc: +((Date.parse(e.close) - Date.now()) / 60e3).toFixed(2), source: 'open-meteo gfs_seamless', daily: f.daily ?? null })
          } catch (err) { errors++; log(`forecast ${cfg.s}: ${err.message}`) }
        }
        let got = 0
        for (const s of near) {
          try {
            const j = await get(`${B}/markets/${encodeURIComponent(s[5])}/orderbook`)
            const ob = j.orderbook_fp ?? j.orderbook ?? {}
            const lv = (a) => (a ?? []).map(([p, q]) => [num(p), num(q)])
            emit({ ts: new Date().toISOString(), kind: 'book', series: cfg.s, coin: cfg.coin, ev: e.ev, close: e.close, w, mtc: +((Date.parse(e.close) - Date.now()) / 60e3).toFixed(2), spot: spot ?? null, t: s[5], strike: s[0], cap: s[6] ?? null, yb: s[1], ya: s[2], yes: lv(ob.yes_dollars ?? ob.yes), no: lv(ob.no_dollars ?? ob.no) })
            got++
          } catch (err) { errors++; log(`book ${s[5]}: ${err.message}`) }
          await sleep(100)
        }
        log(`books T-${w} ${e.ev}: ${got}/${near.length}${spot ? ` near spot ${spot.cb}` : ' (all strikes)'}`)
      }
    }
  }
  if (now - lastSettled > 30 * 60e3) {
    lastSettled = now
    let total = 0
    for (const cfg of SERIES) {
      try {
        const j = await get(`${B}/markets?series_ticker=${cfg.s}&status=settled&limit=200`)
        for (const m of j.markets ?? []) {
          if (!m.ticker || !m.result || settledSeen.has(m.ticker)) continue
          settledSeen.add(m.ticker); total++
          emit({ ts, kind: 'settled', series: cfg.s, coin: cfg.coin, ev: m.event_ticker, t: m.ticker, strike: num(m.floor_strike), result: m.result, expiration_value: num(m.expiration_value), close: m.close_time })
        }
      } catch (e) { errors++; log(`settled ${cfg.s}: ${e.message}`) }
      await sleep(80)
    }
    log(`settled: +${total} new (${settledSeen.size} seen)`)
  }
  if (ticks % 10 === 1) log(`tick ${ticks}: events in window ${inWindow}, spot BTC=${sp.BTC?.cb} ETH=${sp.ETH?.cb} SOL=${sp.SOL?.cb}, lines ${written}, errors ${errors}`)
}

process.on('unhandledRejection', (e) => { errors++; log('unhandledRejection ' + (e && e.message)) })
process.on('uncaughtException', (e) => { errors++; log('uncaughtException ' + (e && e.message)) })

log(`collector v2 start (${ONCE ? 'once' : 'loop'}) series=${SERIES.map((x) => x.s).join(',')} -> ${OUT_DIR}`)
;(async () => {
  for (;;) {
    try { await tick() } catch (e) { errors++; log('tick: ' + e.message) }
    if (ONCE) { log(`once done: lines ${written}, errors ${errors}`); process.exit(errors && !written ? 1 : 0) }
    await sleep(60000 - (Date.now() % 60000) + 2000)
  }
})()
