// Same-second Kalshi <-> Polymarket US books for matched games (backlog 151). PUBLIC DATA ONLY; trades nothing; no keys.
//
// Why: the §122 read matched 177 team-sides across 89 games and found football agreeing to the tick, MLB ~2c apart
// with a few sub-$1 baskets - but the two venues were captured minutes apart, which is exactly the gap a snapshot
// manufactures. Whether one venue leads the other around line moves, and whether any basket survives simultaneous
// quotes, needs both books in the SAME cycle. This records that: every 60 s, for every matched game from 4 h before
// its start until 5 h after, the Kalshi orderbook (batched, depth 3) and the Polymarket US book, each stamped with
// its own fetch time.
//
// Discovery (every 30 min): Polymarket moneylines come from %APPDATA%/oracle-trader/polyus-moneylines.json, the
// moneyline subset the app writes on each catalog walk (PolymarketUsAdapter.writeMoneylines); when that file is
// missing or older than 2 h the recorder walks the gateway itself. Kalshi game markets come from one open-markets
// call per game series. Matching is the §122 rule: same sport, event date within a day, and the Kalshi event's two
// "<Team> wins" titles map one-to-one onto the two team phrases of the Polymarket question.
//
// Output: data/sports-books/YYYY-MM-DD.jsonl, one row per matched Kalshi market per cycle:
//   { ts, slug, ticker, event, team, gameStart, kalshiTeamIsLong, pm: { at, bids, asks }, k: { at, bids, asks } }
// pm is the book of the Polymarket market's LONG side (the priced side); the Kalshi team's Polymarket YES is that
// book when kalshiTeamIsLong, else 1 - it. Log: data/sports-books/recorder.log.
//   node scripts/sports-books.mjs          run forever (the OracleTrader-SportsBooks task restarts it)
//   node scripts/sports-books.mjs --once   discovery + one cycle to stdout, exit 0 when any game matched
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const K = 'https://api.elections.kalshi.com/trade-api/v2'
const PM = 'https://gateway.polymarket.us'
const OUT = process.env.SPORTS_BOOKS_DIR || 'G:/PROJECTS/oracle-trader/data/sports-books'
const MONEYLINES = process.env.SPORTS_BOOKS_MONEYLINES || join(process.env.APPDATA || '', 'oracle-trader', 'polyus-moneylines.json')
const CYCLE_MS = 60_000
const DISCOVER_MS = 30 * 60_000
const MONEYLINES_STALE_MS = 2 * 3600_000
const BEFORE_MS = 4 * 3600_000
const AFTER_MS = 5 * 3600_000
const ONCE = process.argv.includes('--once')
const SPORT = { nfl: 'KXNFLGAME', cfb: 'KXNCAAFGAME', mlb: 'KXMLBGAME', mls: 'KXMLSGAME', nba: 'KXNBAGAME', nhl: 'KXNHLGAME',
  epl: 'KXEPLGAME', laliga: 'KXLALIGAGAME', seriea: 'KXSERIEAGAME', bundesliga: 'KXBUNDESLIGAGAME', ligue1: 'KXLIGUE1GAME',
  ucl: 'KXUCLGAME', wnba: 'KXWNBAGAME', ncaab: 'KXNCAAMBGAME' }
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const STOP = new Set(['wins', 'the', 'of', 'at', 'vs', 'and', 'st', 'state', 'fc', 'united', 'city'])

mkdirSync(OUT, { recursive: true })
const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); if (!ONCE) try { appendFileSync(join(OUT, 'recorder.log'), l + '\n') } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
const tok = (s) => new Set((String(s ?? '').toLowerCase().match(/[a-z]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t)))
const subset = (a, b) => [...a].every((t) => b.has(t))
const same = (a, b) => a.size === b.size && subset(a, b)
const overlap = (a, b) => [...a].filter((t) => b.has(t)).length
const J = (v) => { if (Array.isArray(v)) return v; if (typeof v !== 'string') return []; try { return JSON.parse(v) } catch { return [] } }

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'oracle-trader-research/1.0' }, signal: AbortSignal.timeout(20_000) })
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) {
      if (i === tries - 1) throw e
      await sleep(1000 * (i + 1))
    }
  }
  throw new Error('rate limited')
}

// ---- discovery ----

/** Polymarket moneylines: the app's file when fresh, else a walk of the open catalog (same params as the app). */
async function moneylines() {
  if (existsSync(MONEYLINES)) {
    try {
      const d = JSON.parse(readFileSync(MONEYLINES, 'utf8'))
      const at = typeof d.at === 'number' ? d.at : Date.parse(d.at)
      if (Number.isFinite(at) && Date.now() - at < MONEYLINES_STALE_MS && Array.isArray(d.rows)) {
        log(`moneylines: ${d.rows.length} rows from the app's index (${((Date.now() - at) / 60_000).toFixed(0)} min old)`)
        return d.rows
      }
      log(`moneylines file stale or malformed; walking the gateway`)
    } catch (e) { log(`moneylines file unreadable (${String(e).slice(0, 80)}); walking the gateway`) }
  } else log(`no moneylines file at ${MONEYLINES}; walking the gateway`)
  const rows = []
  for (let offset = 0; offset < 200_000; offset += 100) {
    const d = await get(`${PM}/v1/markets?limit=100&offset=${offset}&closed=false&orderBy=volume&orderDirection=desc`)
    const ms = d.markets ?? []
    for (const m of ms) if (!m.closed && typeof m.slug === 'string' && m.slug.startsWith('aec-') && /^who will win\b/i.test(String(m.question ?? ''))) rows.push(m)
    if (ms.length < 100) break
    await sleep(120)
  }
  log(`moneylines: ${rows.length} rows from a gateway walk`)
  return rows
}

/** Every open Kalshi game market in the mapped series, grouped by event. */
async function kalshiEvents() {
  const byEvent = new Map()
  for (const ser of new Set(Object.values(SPORT))) {
    let cur
    for (let page = 0; page < 10; page++) {
      const d = await get(`${K}/markets?series_ticker=${ser}&status=open&limit=100${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`).catch((e) => { log(`series ${ser}: ${String(e).slice(0, 80)}`); return null })
      if (!d) break
      for (const m of d.markets ?? []) {
        if (String(m.title ?? '').startsWith('Tie')) continue
        const dm = /^(\d\d)([A-Z]{3})(\d\d)/.exec(m.ticker.slice(ser.length + 1))
        if (!dm) continue
        const date = Date.UTC(2000 + +dm[1], MON.indexOf(dm[2]), +dm[3])
        const key = m.event_ticker
        if (!byEvent.has(key)) byEvent.set(key, { series: ser, date, markets: [] })
        byEvent.get(key).markets.push({ ticker: m.ticker, title: String(m.title ?? '') })
      }
      cur = d.cursor
      if (!cur || !(d.markets ?? []).length) break
      await sleep(150)
    }
    await sleep(150)
  }
  return [...byEvent.entries()].filter(([, e]) => e.markets.length === 2).map(([event, e]) => ({ event, ...e }))
}

/** The §122 matcher: one Polymarket moneyline <-> one Kalshi event, both team titles mapped one-to-one. */
function match(pmRows, events) {
  const byKey = new Map()
  for (const e of events) { const k = `${e.series}|${e.date}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(e) }
  const pairs = []
  for (const r of pmRows) {
    const sm = /^aec-([a-z0-9]+)-/.exec(String(r.slug ?? ''))
    const ser = sm && SPORT[sm[1]]
    if (!ser) continue
    const gs = Date.parse(r.gameStartTime ?? '')
    if (!Number.isFinite(gs)) continue
    const sides = J(r.marketSides).filter((x) => x && typeof x === 'object')
    const long = sides.find((x) => x.long === true && x.price !== undefined && x.price !== null && x.price !== '')
    if (!long) continue
    const other = sides.find((x) => x !== long)
    const mph = /event (.+?) vs\.? (.+?)(?: scheduled| on |\?|$)/.exec(String(r.question ?? '').toLowerCase())
    if (!mph) continue
    const phrases = [mph[1].trim(), mph[2].trim()].map(tok)
    const sideTok = (x) => new Set([...tok(x?.description), ...tok(JSON.stringify(x?.team ?? {}))])
    const gd = Date.UTC(new Date(gs).getUTCFullYear(), new Date(gs).getUTCMonth(), new Date(gs).getUTCDate())
    let found = false
    for (const date of [gd, gd - 86_400_000, gd + 86_400_000]) {
      for (const ev of byKey.get(`${ser}|${date}`) ?? []) {
        const fit = ev.markets.map((m) => {
          const kt = tok(m.title)
          let idx = phrases.map((p, i) => (kt.size && subset(kt, p) ? i : -1)).filter((i) => i >= 0)
          if (idx.length === 2) idx = idx.filter((i) => same(kt, phrases[i])).length ? idx.filter((i) => same(kt, phrases[i])) : idx
          return idx
        })
        if (fit[0].length !== 1 || fit[1].length !== 1 || fit[0][0] === fit[1][0]) continue
        for (let i = 0; i < 2; i++) {
          const m = ev.markets[i]; const kt = tok(m.title); const ph = phrases[fit[i][0]]
          const sL = overlap(kt, sideTok(long)) + overlap(ph, sideTok(long))
          const sO = other ? overlap(kt, sideTok(other)) + overlap(ph, sideTok(other)) : 0
          if (sL === sO) continue
          pairs.push({ slug: r.slug, ticker: m.ticker, event: ev.event, team: m.title.replace(/ wins$/i, ''), gameStart: new Date(gs).toISOString(), kalshiTeamIsLong: sL > sO })
          found = true
        }
        if (found) break
      }
      if (found) break
    }
  }
  return pairs
}

// ---- books ----

/** Kalshi top-of-book for a batch of tickers, YES asks = 1 - NO bids (§111 orderbook endpoint, never the list). */
async function kalshiBooks(tickers) {
  const out = new Map()
  for (let i = 0; i < tickers.length; i += 40) {
    const chunk = tickers.slice(i, i + 40)
    const at = new Date().toISOString()
    const d = await get(`${K}/markets/orderbooks?${chunk.map((t) => `tickers=${encodeURIComponent(t)}`).join('&')}&depth=3`)
    for (const o of d.orderbooks ?? []) {
      const fp = o.orderbook_fp ?? {}
      const bids = (fp.yes_dollars ?? []).map(([p, s]) => [num(p), num(s)]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => b[0] - a[0]).slice(0, 3)
      const asks = (fp.no_dollars ?? []).map(([p, s]) => [+(1 - num(p)).toFixed(4), num(s)]).filter(([p, s]) => p < 1 && s > 0).sort((a, b) => a[0] - b[0]).slice(0, 3)
      out.set(o.ticker, { at, bids, asks })
    }
    await sleep(150)
  }
  return out
}

/** Polymarket US book of the market's long side: { marketData: { bids: [{px:{value},qty}], offers: [...] } }. */
async function pmBook(slug) {
  const at = new Date().toISOString()
  const d = await get(`${PM}/v1/markets/${encodeURIComponent(slug)}/book`)
  const md = d.marketData ?? d
  const side = (raw, desc) => (Array.isArray(raw) ? raw : []).map((e) => [num(e.px?.value), num(e.qty ?? e.size ?? e.quantity)])
    .filter(([p, s]) => p > 0 && s > 0).sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0])).slice(0, 3)
  return { at, bids: side(md.bids, true), asks: side(md.offers, false) }
}

// ---- loop ----

let pairs = []
let discoveredAt = 0

async function discover() {
  const [pm, ev] = [await moneylines(), await kalshiEvents()]
  pairs = match(pm, ev)
  discoveredAt = Date.now()
  const games = new Set(pairs.map((p) => p.slug)).size
  log(`discovery: ${pm.length} Polymarket moneylines, ${ev.length} Kalshi two-sided events, ${pairs.length} matched sides across ${games} games`)
}

async function cycle() {
  const now = Date.now()
  const active = pairs.filter((p) => { const gs = Date.parse(p.gameStart); return now >= gs - BEFORE_MS && now <= gs + AFTER_MS })
  if (!active.length) return 0
  const ts = new Date(now).toISOString()
  const kb = await kalshiBooks([...new Set(active.map((p) => p.ticker))])
  const pb = new Map()
  for (const slug of new Set(active.map((p) => p.slug))) {
    pb.set(slug, await pmBook(slug).catch((e) => ({ at: new Date().toISOString(), bids: [], asks: [], error: String(e).slice(0, 80) })))
    await sleep(150)
  }
  let rows = 0
  const day = ts.slice(0, 10)
  for (const p of active) {
    const row = { ts, ...p, pm: pb.get(p.slug) ?? null, k: kb.get(p.ticker) ?? null }
    if (ONCE) { if (rows < 6) console.log(JSON.stringify(row)) } else appendFileSync(join(OUT, `${day}.jsonl`), JSON.stringify(row) + '\n')
    rows++
  }
  log(`cycle: ${active.length} active sides across ${pb.size} games, ${rows} rows, ${active.filter((p) => !kb.get(p.ticker)).length} Kalshi books missing, ${[...pb.values()].filter((b) => b.error).length} Polymarket book errors`)
  return rows
}

if (ONCE) {
  discover().then(cycle).then(() => { if (!pairs.length) { console.error('no games matched - discovery or matcher problem'); process.exit(1) } process.exit(0) })
    .catch((e) => { console.error(String(e)); process.exit(1) })
} else {
  log('sports-books recorder starting')
  ;(async () => {
    for (;;) {
      try {
        if (Date.now() - discoveredAt >= DISCOVER_MS) await discover()
        await cycle()
      } catch (e) { log(`cycle failed: ${String(e).slice(0, 200)}`) }
      await sleep(CYCLE_MS)
    }
  })()
}
