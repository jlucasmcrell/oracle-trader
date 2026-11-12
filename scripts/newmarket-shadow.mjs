// Brand-new Kalshi markets, first hour: a BOOK AND TAPE RECORDER. PUBLIC DATA ONLY; trades nothing; reads no key.
// (docs/PREREGISTERED-newmarket-bid.md)
//
// Why: in the first hour of a new Sports / Mentions / Entertainment market, takers who buy an 85-95c favourite
// overpay, and whoever sold to them earned about +3.9c a contract (a ceiling measured on other people's fills). The
// open question is whether a NEW resting order at the back of the queue gets filled at all, and on which fills.
// That needs the size ahead of us at the moment we would have joined, and every print after it. This records both.
//
// Every 60 s: markets created in the last 15 min (every 10 min: the last 26 h, for markets that open long after
// they are created). A market in a watched category is tracked from first sight until 60 min after it opened: its
// top of book with sizes every 20 s (written when it changes), then its trade tape for that hour.
//
// Output: data/newmarkets/YYYY-MM-DD.jsonl (books), trades-YYYY-MM-DD.jsonl, markets.jsonl (one row per market),
// series.json (category and fee cache). Graded by scripts/newmarket-gate.mjs.
//   node scripts/newmarket-shadow.mjs          run forever (the OracleTrader-NewMarkets task restarts it)
//   node scripts/newmarket-shadow.mjs --once   one discovery + one book pass to stdout
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './lib/repo-root.mjs'

const K = 'https://api.elections.kalshi.com/trade-api/v2'
const OUT = process.env.NEWMARKET_DIR || `${REPO}/data/newmarkets`
const ONCE = process.argv.includes('--once')
const CATEGORIES = new Set(['Sports', 'Mentions', 'Entertainment'])
const TRACK_MS = 60 * 60_000, BOOK_MS = 20_000, DISCOVER_MS = 60_000, WIDE_MS = 10 * 60_000, MAX_TRACKED = 1000
const H = { 'User-Agent': 'oracle-trader-research/1.0' }

mkdirSync(OUT, { recursive: true })
const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); if (!ONCE) try { appendFileSync(join(OUT, 'recorder.log'), l + '\n') } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(15_000) })
      if (r.status === 429) { await sleep(4000 * (i + 1)); continue }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) { if (i === tries - 1) throw e; await sleep(1000 * (i + 1)) }
  }
  throw new Error('rate limited')
}

const SERIES_PATH = join(OUT, 'series.json')
const series = existsSync(SERIES_PATH) ? JSON.parse(readFileSync(SERIES_PATH, 'utf8')) : {}
async function seriesInfo(s) {
  if (series[s]) return series[s]
  const d = await get(`${K}/series/${encodeURIComponent(s)}`).catch(() => null)
  if (!d?.series) return null
  series[s] = { cat: d.series.category ?? '', fee: d.series.fee_type ?? '', mult: d.series.fee_multiplier ?? 1 }
  try { writeFileSync(SERIES_PATH, JSON.stringify(series)) } catch {}
  await sleep(120)
  return series[s]
}

const tracked = new Map()   // ticker -> { open, until, last }
const seen = new Set()
let skippedFull = 0

/** Markets created since `sinceSec`; a market joins only inside the first 12 minutes after it opened. */
async function discover(sinceSec) {
  let cur, added = 0, pages = 0
  for (; pages < 40; pages++) {
    const d = await get(`${K}/markets?status=open&min_created_ts=${sinceSec}&limit=1000&mve_filter=exclude${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`)
    for (const m of d.markets ?? []) {
      if (seen.has(m.ticker)) continue
      const open = Math.max(Date.parse(m.open_time ?? m.created_time), Date.parse(m.created_time ?? m.open_time))
      if (!(Date.now() - open < 12 * 60_000)) { if (Date.now() - open >= 12 * 60_000) seen.add(m.ticker); continue }
      const sTicker = String(m.event_ticker ?? m.ticker).split('-')[0]
      const info = await seriesInfo(sTicker)
      if (!info) continue
      seen.add(m.ticker)
      if (!CATEGORIES.has(info.cat) || m.market_type !== 'binary') continue
      if (tracked.size >= MAX_TRACKED) { skippedFull++; continue }
      tracked.set(m.ticker, { open, until: open + TRACK_MS, last: '' })
      const meta = { t: m.ticker, ev: m.event_ticker, series: sTicker, cat: info.cat, fee: info.fee, mult: info.mult, created: m.created_time, open: new Date(open).toISOString(), close: m.close_time, title: String(m.title ?? '').slice(0, 120), sub: String(m.yes_sub_title ?? '').slice(0, 60) }
      if (ONCE) { if (added < 3) console.log(JSON.stringify(meta)) } else appendFileSync(join(OUT, 'markets.jsonl'), JSON.stringify(meta) + '\n')
      added++
    }
    cur = d.cursor
    if (!cur || !(d.markets ?? []).length) break
    await sleep(200)
  }
  if (seen.size > 200_000) seen.clear()
  return { added, pages: pages + 1 }
}

async function books() {
  const tickers = [...tracked.keys()]
  let rows = 0
  for (let i = 0; i < tickers.length; i += 40) {
    const chunk = tickers.slice(i, i + 40)
    const ts = new Date().toISOString()
    const d = await get(`${K}/markets/orderbooks?${chunk.map((t) => `tickers=${encodeURIComponent(t)}`).join('&')}&depth=1`).catch(() => null)
    const top = (levels) => (levels ?? []).map(([p, s]) => [num(p), num(s)]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => b[0] - a[0])[0]
    for (const o of d?.orderbooks ?? []) {
      const st = tracked.get(o.ticker)
      if (!st) continue
      const yes = top(o.orderbook_fp?.yes_dollars), no = top(o.orderbook_fp?.no_dollars)
      // yb/ybs: best YES bid and its size. nb/nbs: best NO bid and its size (the YES ask is 1 - nb).
      const row = { ts, t: o.ticker, yb: yes?.[0] ?? null, ybs: yes?.[1] ?? 0, nb: no?.[0] ?? null, nbs: no?.[1] ?? 0 }
      const key = `${row.yb}|${row.ybs}|${row.nb}|${row.nbs}`
      if (key === st.last) continue
      st.last = key
      if (ONCE) { if (rows < 3) console.log(JSON.stringify(row)) } else appendFileSync(join(OUT, `${ts.slice(0, 10)}.jsonl`), JSON.stringify(row) + '\n')
      rows++
    }
    await sleep(150)
  }
  return rows
}

/** The first hour's prints for a market whose hour is over, oldest first. */
async function tape(ticker, st) {
  const out = []
  let cur
  for (let page = 0; page < 5; page++) {
    const d = await get(`${K}/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=1000&max_ts=${Math.ceil(st.until / 1000)}${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`).catch(() => null)
    for (const x of d?.trades ?? []) out.push({ t: ticker, ts: x.created_time, yes: num(x.yes_price_dollars), n: num(x.count_fp), side: x.taker_side })
    cur = d?.cursor
    if (!cur || !(d?.trades ?? []).length) break
    await sleep(150)
  }
  if (out.length) appendFileSync(join(OUT, `trades-${new Date(st.open).toISOString().slice(0, 10)}.jsonl`), out.reverse().map((r) => JSON.stringify(r)).join('\n') + '\n')
  return out.length
}

if (ONCE) {
  discover(Math.floor(Date.now() / 1000) - 900).then(async (r) => { console.log(`discovery: ${r.added} tracked, ${r.pages} pages`); console.log(`books: ${await books()} rows`); process.exit(0) }).catch((e) => { console.error(String(e)); process.exit(1) })
} else {
  log('new-market recorder starting')
  let lastDiscover = 0, lastWide = Date.now(), lastLog = 0, added = 0, rows = 0, prints = 0, done = 0
  ;(async () => {
    for (;;) {
      const t0 = Date.now()
      try {
        if (t0 - lastDiscover >= DISCOVER_MS) {
          const wide = t0 - lastWide >= WIDE_MS
          if (wide) lastWide = t0
          lastDiscover = t0
          added += (await discover(Math.floor(t0 / 1000) - (wide ? 26 * 3600 : 900))).added
        }
        rows += await books()
        for (const [t, st] of tracked) {
          if (Date.now() < st.until + 30_000) continue
          tracked.delete(t)
          prints += await tape(t, st); done++
          await sleep(120)
        }
        if (Date.now() - lastLog > 30 * 60_000) {
          lastLog = Date.now()
          log(`tracking ${tracked.size}; since last note: ${added} new markets, ${rows} book rows, ${done} hours finished with ${prints} prints${skippedFull ? `, ${skippedFull} skipped (full)` : ''}`)
          added = rows = prints = done = skippedFull = 0
        }
      } catch (e) { log(`cycle failed: ${String(e).slice(0, 200)}`) }
      await sleep(Math.max(1000, BOOK_MS - (Date.now() - t0)))
    }
  })()
}
