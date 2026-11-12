// Late-game leader on Kalshi sports, with Polymarket's price beside it: a QUOTE RECORDER. PUBLIC DATA ONLY;
// trades nothing; reads no key. (docs/PREREGISTERED-lategame.md)
//
// Why: the one pattern in the top Polymarket wallets that held on wallets not picked for a good month was buying the
// LEADER late in a game at 70-97c (about +5c a market, strongest in the NBA). This records what that would have paid
// on Kalshi at Kalshi's ask, blind and gated by Polymarket's price being ahead of Kalshi's (lead-lag in a new place).
//
// Per live NBA / NFL / NHL game: the scoreboard (period, clock, score; ESPN's public feed), Kalshi's top of book for
// both game-winner contracts, and Polymarket's top of book for the same game. Every 5 s while any game is in its
// final period or overtime, every 30 s otherwise. Discovery every 5 min.
//
// Output: data/lategame/YYYY-MM-DD.jsonl. Log: data/lategame/recorder.log. Graded by scripts/lategame-gate.mjs.
//   node scripts/lategame-shadow.mjs          run forever (the OracleTrader-LateGame task restarts it)
//   node scripts/lategame-shadow.mjs --once   discovery + one cycle to stdout (INPLAY_ALL=1 tracks every game)
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './lib/repo-root.mjs'

const K = 'https://api.elections.kalshi.com/trade-api/v2'
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'
const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB = 'https://clob.polymarket.com'
const OUT = process.env.LATEGAME_DIR || `${REPO}/data/lategame`
const ONCE = process.argv.includes('--once')
const FAST_MS = 5_000, SLOW_MS = 30_000, DISCOVER_MS = 5 * 60_000
export const LEAGUES = [
  { key: 'nba', espn: 'basketball/nba', series: 'KXNBAGAME', tag: 'nba', finalPeriod: 4 },
  { key: 'nfl', espn: 'football/nfl', series: 'KXNFLGAME', tag: 'nfl', finalPeriod: 4 },
  { key: 'nhl', espn: 'hockey/nhl', series: 'KXNHLGAME', tag: 'nhl', finalPeriod: 3 }
]
// One spelling per team across ESPN and Kalshi (extend when the log reports an unmatched game).
const ALIAS = { SA: 'SAS', NY: 'NYK', GS: 'GSW', NO: 'NOP', UTAH: 'UTA', WSH: 'WAS', PHO: 'PHX', TB: 'TBL', NJ: 'NJD', SJ: 'SJS', LA: 'LAK', LAR: 'LA', JAC: 'JAX', MON: 'MTL', NAS: 'NSH', WAS: 'WAS' }
const code = (c, lg) => { const u = String(c ?? '').toUpperCase(); return lg === 'nfl' && (u === 'LAR' || u === 'LA') ? 'LAR' : lg !== 'nhl' && (u === 'TB' || u === 'LA') ? u : (ALIAS[u] ?? u) }
const H = { 'User-Agent': 'oracle-trader-research/1.0' }

const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; console.log(l); if (!ONCE) try { appendFileSync(join(OUT, 'recorder.log'), l + '\n') } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

async function get(url, init, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(12_000), ...init })
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) { if (i === tries - 1) throw e; await sleep(800 * (i + 1)) }
  }
  throw new Error('rate limited')
}

/** ESPN's scoreboard for one league, reduced to what a row needs. */
async function scoreboard(lg) {
  const d = await get(`${ESPN}/${lg.espn}/scoreboard`)
  return (d.events ?? []).map((e) => {
    const c = e.competitions?.[0] ?? {}, st = c.status ?? e.status ?? {}
    const side = (ha) => { const t = (c.competitors ?? []).find((x) => x.homeAway === ha) ?? {}; return { abbr: code(t.team?.abbreviation, lg.key), name: t.team?.name ?? '', loc: t.team?.location ?? '', score: num(t.score) } }
    return { id: String(e.id), start: Date.parse(e.date), state: st.type?.state ?? '', period: st.period ?? 0, clock: st.displayClock ?? '', clockSec: num(st.clock), away: side('away'), home: side('home') }
  })
}

async function kalshiEvents(lg) {
  const by = new Map()
  let cur
  for (let page = 0; page < 6; page++) {
    const d = await get(`${K}/markets?series_ticker=${lg.series}&status=open&limit=200${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`)
    for (const m of d.markets ?? []) {
      if (!by.has(m.event_ticker)) by.set(m.event_ticker, [])
      by.get(m.event_ticker).push({ ticker: m.ticker, code: code(m.ticker.split('-').pop(), lg.key), sub: m.yes_sub_title ?? '', exp: Date.parse(m.expected_expiration_time ?? m.close_time) })
    }
    cur = d.cursor
    if (!cur || !(d.markets ?? []).length) break
    await sleep(150)
  }
  return [...by.values()].filter((ms) => ms.length === 2)
}

async function polyGames(lg) {
  const out = []
  for (let off = 0; off < 600; off += 100) {
    const d = await get(`${GAMMA}/events?tag_slug=${lg.tag}&closed=false&limit=100&offset=${off}`).catch(() => null)
    if (!Array.isArray(d) || !d.length) break
    for (const e of d) for (const m of e.markets ?? []) {
      if (m.sportsMarketType !== 'moneyline') continue
      let names, tokens
      try { names = JSON.parse(m.outcomes); tokens = JSON.parse(m.clobTokenIds) } catch { continue }
      if (names?.length !== 2 || tokens?.length !== 2) continue
      out.push({ slug: m.slug, names: names.map(norm), tokens, start: Date.parse(String(m.gameStartTime ?? '').replace(' ', 'T').replace('+00', 'Z')) })
    }
    if (d.length < 100) break
    await sleep(150)
  }
  return out
}

/** The Kalshi market pair for an ESPN game: by team code, else by city name; the game's start must fit the market. */
export function matchKalshi(g, events) {
  const fits = (ms) => g.start > ms[0].exp - 10 * 3600_000 && g.start < ms[0].exp + 3600_000
  const pick = (ms, t) => ms.find((m) => m.code === t.abbr) ?? ms.find((m) => norm(m.sub) && (norm(m.sub).startsWith(norm(t.loc)) || norm(t.loc).startsWith(norm(m.sub))))
  for (const ms of events) {
    if (!fits(ms)) continue
    const a = ms.find((m) => m.code === g.away.abbr), h = ms.find((m) => m.code === g.home.abbr)
    if (a && h && a !== h) return { away: a.ticker, home: h.ticker }
  }
  const cands = events.filter(fits).map((ms) => ({ a: pick(ms, g.away), h: pick(ms, g.home) })).filter((x) => x.a && x.h && x.a !== x.h)
  return cands.length === 1 ? { away: cands[0].a.ticker, home: cands[0].h.ticker } : null
}

/** Polymarket's moneyline for an ESPN game: both nicknames, start within 3 h. Returns the AWAY team's token. */
export function matchPoly(g, polys) {
  const idx = (names, t) => names.findIndex((n) => n === norm(t.name) || n === norm(t.loc) || n === norm(t.loc + t.name))
  for (const p of polys) {
    if (!(Math.abs(p.start - g.start) <= 3 * 3600_000)) continue
    const ia = idx(p.names, g.away), ih = idx(p.names, g.home)
    if (ia >= 0 && ih >= 0 && ia !== ih) return { slug: p.slug, awayToken: p.tokens[ia] }
  }
  return null
}

let games = [], discoveredAt = 0
async function discover() {
  const next = []
  let seen = 0, noK = 0, noP = 0
  for (const lg of LEAGUES) {
    try {
      const sb = await scoreboard(lg)
      const now = Date.now()
      const active = process.env.INPLAY_ALL ? sb : sb.filter((g) => g.state === 'in' || (g.state === 'pre' && g.start - now <= 30 * 60_000))
      seen += sb.length
      if (!active.length) continue
      const [events, polys] = [await kalshiEvents(lg), await polyGames(lg)]
      for (const g of active) {
        const k = matchKalshi(g, events)
        if (!k) { noK++; log(`unmatched on Kalshi: ${lg.key} ${g.away.abbr}@${g.home.abbr}`); continue }
        const p = matchPoly(g, polys)
        if (!p) noP++
        next.push({ lg, id: g.id, away: g.away.abbr, home: g.home.abbr, k, p })
      }
    } catch (e) { log(`${lg.key} discovery failed: ${String(e).slice(0, 120)}`) }
  }
  games = next
  discoveredAt = Date.now()
  log(`discovery: ${seen} games on the boards, ${games.length} tracked, ${noK} without a Kalshi market, ${noP} without a Polymarket market`)
}

async function kalshiTops(tickers) {
  const out = new Map()
  for (let i = 0; i < tickers.length; i += 40) {
    const chunk = tickers.slice(i, i + 40)
    const d = await get(`${K}/markets/orderbooks?${chunk.map((t) => `tickers=${encodeURIComponent(t)}`).join('&')}&depth=1`).catch(() => null)
    const top = (levels) => (levels ?? []).map(([p, s]) => [num(p), num(s)]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => b[0] - a[0])[0]
    for (const o of d?.orderbooks ?? []) {
      const yes = top(o.orderbook_fp?.yes_dollars), no = top(o.orderbook_fp?.no_dollars)
      out.set(o.ticker, { b: yes?.[0] ?? null, bs: yes?.[1] ?? 0, a: no ? +(1 - no[0]).toFixed(4) : null, as: no?.[1] ?? 0 })
    }
  }
  return out
}

async function polyTops(tokens) {
  const out = new Map()
  if (!tokens.length) return out
  const d = await get(`${CLOB}/books`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(tokens.map((t) => ({ token_id: t }))) }).catch(() => null)
  for (const b of Array.isArray(d) ? d : []) {
    const bid = Math.max(0, ...(b.bids ?? []).map((x) => num(x.price) ?? 0)), ask = Math.min(1, ...(b.asks ?? []).map((x) => num(x.price) ?? 1))
    if (bid > 0 && ask < 1) out.set(b.asset_id, { b: bid, a: ask })
  }
  return out
}

/** One pass. Returns true when any tracked game is in its final period or overtime (the fast cadence). */
async function cycle() {
  if (!games.length) return false
  const ts = new Date().toISOString()
  const boards = new Map()
  for (const lg of new Set(games.map((g) => g.lg))) for (const g of await scoreboard(lg).catch(() => [])) boards.set(`${lg.key}:${g.id}`, g)
  const kAt = Date.now()
  const k = await kalshiTops(games.flatMap((g) => [g.k.away, g.k.home]))
  const pAt = Date.now()
  const p = await polyTops(games.filter((g) => g.p).map((g) => g.p.awayToken))
  let late = false, rows = 0
  for (const g of games) {
    const b = boards.get(`${g.lg.key}:${g.id}`)
    if (!b || (b.state !== 'in' && !process.env.INPLAY_ALL)) continue
    if (b.period >= g.lg.finalPeriod) late = true
    const row = {
      ts, lg: g.lg.key, g: g.id, away: g.away, home: g.home, st: b.state, per: b.period, clk: b.clock, sec: b.clockSec, sa: b.away.score, sh: b.home.score,
      ka: { t: g.k.away, ...(k.get(g.k.away) ?? {}) }, kh: { t: g.k.home, ...(k.get(g.k.home) ?? {}) }, kMs: kAt - Date.parse(ts),
      pa: g.p ? (p.get(g.p.awayToken) ?? null) : null, pMs: pAt - Date.parse(ts), ps: g.p?.slug ?? null
    }
    if (ONCE) { if (rows < 4) console.log(JSON.stringify(row)) } else appendFileSync(join(OUT, `${ts.slice(0, 10)}.jsonl`), JSON.stringify(row) + '\n')
    rows++
  }
  if (rows && (ONCE || Date.now() - lastLog > 10 * 60_000)) { lastLog = Date.now(); log(`cycle: ${rows} live games, ${late ? 'final period' : 'earlier periods'}`) }
  return late
}
let lastLog = 0

if (process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('scripts/lategame-shadow.mjs')) {
  mkdirSync(OUT, { recursive: true })
  if (ONCE) {
    discover().then(cycle).then(() => process.exit(0)).catch((e) => { console.error(String(e)); process.exit(1) })
  } else {
    log('late-game recorder starting')
    ;(async () => {
      for (;;) {
        const t0 = Date.now()
        let late = false
        try {
          if (Date.now() - discoveredAt >= DISCOVER_MS) await discover()
          late = await cycle()
        } catch (e) { log(`cycle failed: ${String(e).slice(0, 200)}`) }
        await sleep(Math.max(1000, (late ? FAST_MS : SLOW_MS) - (Date.now() - t0)))
      }
    })()
  }
}
