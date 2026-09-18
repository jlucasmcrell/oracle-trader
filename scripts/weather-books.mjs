// Full-event weather + economic-print book capture (backlog 148, 150). PUBLIC DATA ONLY; trades nothing; no keys.
//
// Why: every weather test we could run so far (§116) used the book rows the trading scan happened to log,
// which are only the cheap brackets the fade arm looked at (mean ask 7c). Whether any forecast beats the
// market at the MODAL bracket - the only question that matters for a taker weather arm - has never been
// testable, because nothing records whole events. This records every open KXHIGHT*/KXLOWT* market's
// top-of-book every 30 minutes, from the live orderbook endpoint (the /markets list is cached and stale,
// §111; it is used here only to enumerate tickers and strike semantics).
//
// Output: data/weather-books/YYYY-MM-DD.jsonl, one row per market per cycle. Log: data/weather-books/recorder.log.
//   node scripts/weather-books.mjs          run forever (the OracleTrader-WeatherBooks task restarts it)
//   node scripts/weather-books.mjs --once   one cycle to stdout, exit 0 on success
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const K = 'https://api.elections.kalshi.com/trade-api/v2'
const OUT = process.env.WEATHER_BOOKS_DIR || 'G:/PROJECTS/oracle-trader/data/weather-books'
const CYCLE_MS = 30 * 60_000
const ONCE = process.argv.includes('--once')
const SERIES = /^KX(HIGHT|LOWT)[A-Z]+-/
// Economic-print series that ForecastEx also lists (backlog 150): captured on the same cadence so the
// Kalshi <-> ForecastEx same-event shadow has both books. Temperature stays for its own read.
const ECON_SERIES = ['KXFED', 'KXFEDFUNDSYEAR', 'KXRATECUTCOUNT', 'KXJOBLESSCLAIMS', 'KXCPIYOY', 'KXCPICOREYOY', 'KXUSCPIYEAR', 'KXU3', 'KXUNRATE', 'KXPAYROLLS', 'KXNFP', 'KXGDP', 'KXNOMGDPGROWTH']

mkdirSync(OUT, { recursive: true })
const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); if (!ONCE) try { appendFileSync(join(OUT, 'recorder.log'), l + '\n') } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

async function get(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${K}${path}`, { headers: { 'User-Agent': 'oracle-trader-research/1.0' }, signal: AbortSignal.timeout(20_000) })
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) {
      if (i === tries - 1) throw e
      await sleep(1000 * (i + 1))
    }
  }
  // Every try was a 429: say so instead of returning undefined into the caller's `.markets`.
  throw new Error('rate limited')
}

/** Every open weather market with strike semantics: the Climate & Weather series list, then one open-markets call
 *  per KXHIGHT/KXLOWT series. (The global paged /markets list never surfaced them within 60 pages.) */
async function openWeatherMarkets() {
  const series = []
  let cursor
  for (let page = 0; page < 10; page++) {
    const d = await get(`/series?category=Climate%20and%20Weather&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    for (const x of d.series ?? []) if (SERIES.test(`${x.ticker}-`)) series.push(x.ticker)
    cursor = d.cursor
    if (!cursor || !(d.series ?? []).length) break
  }
  const out = []
  for (const st of [...series, ...ECON_SERIES]) {
    // Paginate: KXFED alone has 100+ open markets across meetings; one page silently dropped the near ones.
    let cur
    for (let page = 0; page < 10; page++) {
      const d = await get(`/markets?series_ticker=${encodeURIComponent(st)}&status=open&limit=100${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`).catch((e) => { log(`series ${st}: ${String(e).slice(0, 80)}`); return null })
      if (!d) break
      for (const m of d.markets ?? []) {
        out.push({ ticker: m.ticker, series: st, strikeType: m.strike_type ?? null, floor: m.floor_strike ?? null, cap: m.cap_strike ?? null,
          closeTime: m.close_time ?? null, listBid: num(m.yes_bid_dollars), listAsk: num(m.yes_ask_dollars), volume: num(m.volume_fp ?? m.volume) })
      }
      cur = d.cursor
      if (!cur || !(d.markets ?? []).length) break
      await sleep(150)
    }
    await sleep(150)
  }
  log(`${series.length} weather series enumerated`)
  return out
}

/** Live top-of-book for a batch of tickers. YES asks are 1 - NO bids (Kalshi books hold YES bids and NO bids). */
async function books(tickers) {
  const out = new Map()
  for (let i = 0; i < tickers.length; i += 40) {
    const chunk = tickers.slice(i, i + 40)
    const d = await get(`/markets/orderbooks?${chunk.map((t) => `tickers=${encodeURIComponent(t)}`).join('&')}&depth=3`)
    for (const o of d.orderbooks ?? []) {
      const fp = o.orderbook_fp ?? {}
      const bids = (fp.yes_dollars ?? []).map(([p, s]) => [num(p), num(s)]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => b[0] - a[0]).slice(0, 3)
      const asks = (fp.no_dollars ?? []).map(([p, s]) => [+(1 - num(p)).toFixed(4), num(s)]).filter(([p, s]) => p < 1 && s > 0).sort((a, b) => a[0] - b[0]).slice(0, 3)
      out.set(o.ticker, { bids, asks })
    }
    await sleep(150)
  }
  return out
}

async function cycle() {
  const at = new Date().toISOString()
  const markets = await openWeatherMarkets()
  const bk = await books(markets.map((m) => m.ticker))
  let rows = 0
  const day = at.slice(0, 10)
  for (const m of markets) {
    const b = bk.get(m.ticker)
    const row = { ts: at, ...m, bids: b?.bids ?? [], asks: b?.asks ?? [], bookMissing: !b }
    if (ONCE) { if (rows < 6) console.log(JSON.stringify(row)) } else appendFileSync(join(OUT, `${day}.jsonl`), JSON.stringify(row) + '\n')
    rows++
  }
  const events = new Set(markets.map((m) => m.ticker.split('-').slice(0, 2).join('-'))).size
  log(`cycle: ${markets.length} open weather markets across ${events} events, ${rows} rows, ${markets.length - [...bk.keys()].length} without a book`)
  return rows
}

if (ONCE) {
  cycle().then((n) => { if (n === 0) { console.error('no open weather markets returned - endpoint or filter problem'); process.exit(1) } process.exit(0) })
    .catch((e) => { console.error(String(e)); process.exit(1) })
} else {
  log('weather-books recorder starting')
  ;(async () => {
    for (;;) {
      try { await cycle() } catch (e) { log(`cycle failed: ${String(e).slice(0, 200)}`) }
      await sleep(CYCLE_MS)
    }
  })()
}
