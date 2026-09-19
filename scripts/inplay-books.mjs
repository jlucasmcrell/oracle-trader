// In-play MLB: the official league feed against Kalshi's in-game books, same cycle (backlog 165). PUBLIC DATA ONLY;
// trades nothing; no keys.
//
// Why: Kalshi trades game markets in play and lists first-inning and total-runs markets. The MLB Stats API is free
// and public and carries every play with the feed's own timestamp. The question is lead-lag with a data feed as
// the leader: after a scoring play, how long until the Kalshi moneyline / RFI / totals books move, and by how much
// - i.e. whether a taker at the stale book would clear the fee. Latency is the one family that has ever earned.
//
// Every 15 s for every live game: the feed's linescore and current play (inning, half, outs, runs, last event and
// its end time, the feed's metaData timestamp) and the Kalshi top-of-book (batched orderbooks, depth 1, its own
// fetch time) for the game's markets. Discovery every 5 min: today's schedule (games live or starting within
// 30 min) and the open KXMLBGAME / KXMLBRFI / KXMLBTOTAL markets, matched by the team codes in the ticker stem.
//
// Output: data/inplay-books/YYYY-MM-DD.jsonl, one row per game per cycle. Log: data/inplay-books/recorder.log.
//   node scripts/inplay-books.mjs          run forever (the OracleTrader-InplayBooks task restarts it)
//   node scripts/inplay-books.mjs --once   discovery + one cycle to stdout; exit 0 when the schedule was read
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const K = 'https://api.elections.kalshi.com/trade-api/v2'
const MLB = 'https://statsapi.mlb.com/api'
const OUT = process.env.INPLAY_BOOKS_DIR || 'G:/PROJECTS/oracle-trader/data/inplay-books'
const CYCLE_MS = 15_000
const DISCOVER_MS = 5 * 60_000
const ONCE = process.argv.includes('--once')
const SERIES = ['KXMLBGAME', 'KXMLBRFI', 'KXMLBTOTAL']
// Kalshi codes that differ from MLB's abbreviations (extend when the log reports an unmatched game).
const ALIAS = { CHW: 'CWS', WAS: 'WSH', ARI: 'AZ', OAK: 'ATH', TBR: 'TB', KCR: 'KC', SDP: 'SD', SFG: 'SF' }
const H = { 'User-Agent': 'oracle-trader-research/1.0' }

mkdirSync(OUT, { recursive: true })
const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); if (!ONCE) try { appendFileSync(join(OUT, 'recorder.log'), l + '\n') } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(15_000) })
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) { if (i === tries - 1) throw e; await sleep(1000 * (i + 1)) }
  }
  throw new Error('rate limited')
}

// ---- discovery ----
let abbrev = new Map()   // MLB team id -> abbreviation
let games = []           // [{ gamePk, away, home, start, state, tickers: [...] }]
let discoveredAt = 0

async function teams() {
  if (abbrev.size) return abbrev
  const d = await get(`${MLB}/v1/teams?sportId=1`)
  abbrev = new Map((d.teams ?? []).map((t) => [t.id, String(t.abbreviation).toUpperCase()]))
  return abbrev
}

/** Split a Kalshi stem's team block (e.g. "MINSF") into [away, home] using the known abbreviation set. */
function splitCodes(block, known) {
  for (let i = 2; i <= 3; i++) {
    const a = block.slice(0, i), b = block.slice(i)
    if (known.has(ALIAS[a] ?? a) && known.has(ALIAS[b] ?? b) && b.length >= 2 && b.length <= 3) return [ALIAS[a] ?? a, ALIAS[b] ?? b]
  }
  return null
}

async function kalshiMarkets() {
  const out = []
  for (const st of SERIES) {
    let cur
    for (let page = 0; page < 10; page++) {
      const d = await get(`${K}/markets?series_ticker=${st}&status=open&limit=100${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`).catch((e) => { log(`${st}: ${String(e).slice(0, 80)}`); return null })
      if (!d) break
      for (const m of d.markets ?? []) out.push({ ticker: m.ticker, series: st, title: m.title, strikeType: m.strike_type ?? null, floor: m.floor_strike ?? null })
      cur = d.cursor
      if (!cur || !(d.markets ?? []).length) break
      await sleep(150)
    }
    await sleep(150)
  }
  return out
}

async function discover() {
  const ab = await teams()
  const known = new Set(ab.values())
  const today = new Date().toISOString().slice(0, 10)
  const sched = await get(`${MLB}/v1/schedule?sportId=1&date=${today}`)
  const all = (sched.dates ?? []).flatMap((d) => d.games ?? [])
  const now = Date.now()
  // INPLAY_ALL=1 tracks every game on the schedule (a dry run of the matcher outside game hours).
  const active = process.env.INPLAY_ALL ? all : all.filter((g) => g.status?.abstractGameState === 'Live' || (g.status?.abstractGameState === 'Preview' && Date.parse(g.gameDate) - now <= 30 * 60_000))
  const markets = await kalshiMarkets()
  // Group Kalshi markets by their stem's team block: KXMLBGAME-26SEP212145MINSF-SF -> "MINSF"
  const byCodes = new Map()
  for (const m of markets) {
    const stem = m.ticker.split('-')[1] ?? ''
    const block = stem.replace(/^\d{2}[A-Z]{3}\d{2}\d{4}/, '')
    const codes = splitCodes(block, known)
    if (!codes) continue
    const key = codes.join('@')
    if (!byCodes.has(key)) byCodes.set(key, [])
    byCodes.get(key).push(m)
  }
  games = []
  let unmatched = 0
  for (const g of active) {
    const away = ab.get(g.teams?.away?.team?.id), home = ab.get(g.teams?.home?.team?.id)
    const ms = byCodes.get(`${away}@${home}`) ?? []
    if (!ms.length) { unmatched++; continue }
    games.push({ gamePk: g.gamePk, away, home, start: g.gameDate, state: g.status?.abstractGameState, tickers: ms.map((m) => m.ticker), markets: ms })
  }
  discoveredAt = Date.now()
  log(`discovery: ${all.length} games today, ${active.length} live or imminent, ${games.length} matched to ${games.reduce((a, g) => a + g.tickers.length, 0)} Kalshi markets, ${unmatched} unmatched`)
}

// ---- cycle ----
async function kalshiBooks(tickers) {
  const out = new Map()
  for (let i = 0; i < tickers.length; i += 40) {
    const chunk = tickers.slice(i, i + 40)
    const at = new Date().toISOString()
    const d = await get(`${K}/markets/orderbooks?${chunk.map((t) => `tickers=${encodeURIComponent(t)}`).join('&')}&depth=1`).catch(() => null)
    for (const o of d?.orderbooks ?? []) {
      const fp = o.orderbook_fp ?? {}
      const bid = (fp.yes_dollars ?? []).map(([p, s]) => [num(p), num(s)]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => b[0] - a[0])[0]
      const noBid = (fp.no_dollars ?? []).map(([p, s]) => [num(p), num(s)]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => b[0] - a[0])[0]
      out.set(o.ticker, { at, bid: bid?.[0] ?? null, bidSize: bid?.[1] ?? 0, ask: noBid ? +(1 - noBid[0]).toFixed(4) : null, askSize: noBid?.[1] ?? 0 })
    }
    await sleep(120)
  }
  return out
}

async function feed(gamePk) {
  const at = new Date().toISOString()
  const d = await get(`${MLB}/v1.1/game/${gamePk}/feed/live`)
  const ls = d.liveData?.linescore ?? {}
  const cp = d.liveData?.plays?.currentPlay ?? {}
  const last = (d.liveData?.plays?.allPlays ?? []).filter((p) => p.about?.isComplete).slice(-1)[0]
  return {
    at, feedTs: d.metaData?.timeStamp ?? null, state: d.gameData?.status?.abstractGameState ?? null, detailed: d.gameData?.status?.detailedState ?? null,
    inning: ls.currentInning ?? null, half: ls.inningHalf ?? null, outs: ls.outs ?? null, balls: ls.balls ?? null, strikes: ls.strikes ?? null,
    awayRuns: ls.teams?.away?.runs ?? null, homeRuns: ls.teams?.home?.runs ?? null,
    current: { atBat: cp.about?.atBatIndex ?? null, desc: cp.result?.description ?? null, event: cp.result?.event ?? null, startTime: cp.about?.startTime ?? null, endTime: cp.about?.endTime ?? null, complete: cp.about?.isComplete ?? null },
    lastComplete: last ? { atBat: last.about?.atBatIndex, event: last.result?.event, rbi: last.result?.rbi ?? 0, awayScore: last.result?.awayScore, homeScore: last.result?.homeScore, endTime: last.about?.endTime } : null
  }
}

async function cycle() {
  const live = games.filter((g) => g.state !== 'Final')
  if (!live.length) return 0
  const ts = new Date().toISOString()
  const books = await kalshiBooks([...new Set(live.flatMap((g) => g.tickers))])
  let rows = 0
  const day = ts.slice(0, 10)
  for (const g of live) {
    const f = await feed(g.gamePk).catch((e) => ({ at: new Date().toISOString(), error: String(e).slice(0, 80) }))
    if (f.state) g.state = f.state
    const row = { ts, gamePk: g.gamePk, away: g.away, home: g.home, start: g.start, feed: f, books: Object.fromEntries(g.tickers.map((t) => [t, books.get(t) ?? null])) }
    if (ONCE) { if (rows < 3) console.log(JSON.stringify(row).slice(0, 600)) } else appendFileSync(join(OUT, `${day}.jsonl`), JSON.stringify(row) + '\n')
    rows++
    await sleep(100)
  }
  const inPlay = live.filter((g) => g.state === 'Live').length
  log(`cycle: ${live.length} games tracked, ${inPlay} in play, ${rows} rows, ${[...books.values()].length} books`)
  return rows
}

if (ONCE) {
  discover().then(cycle).then(() => process.exit(0)).catch((e) => { console.error(String(e)); process.exit(1) })
} else {
  log('inplay-books recorder starting')
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
