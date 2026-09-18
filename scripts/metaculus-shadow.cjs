// Metaculus community forecast vs Kalshi price: a SHADOW anchor (no trading, no writes to any venue).
//
//   <electron> scripts/metaculus-shadow.cjs            record matching pairs and grade settled ones
//   <electron> scripts/metaculus-shadow.cjs report     Brier of the community forecast vs the Kalshi mid
//   <electron> scripts/metaculus-shadow.cjs whoami     which Metaculus account the token belongs to
//
// Runs under the project's electron with the APP's profile so it can decrypt the
// Metaculus token the panel stores in kalshi-auto.json (config.metaculusApiKey; env
// METACULUS_API_KEY overrides). Every hour: list open binary Metaculus questions
// (token), match each to an open Kalshi EVENT outside sports by rare title tokens,
// pick the event's market that names the question's subject (or the date strike
// nearest its resolution), read the community forecast from the public question
// page through scripts/metaculus-page.cjs (the API hides it from tokens on 299 of
// 300 questions, the page does not), store the pair (community p, Kalshi mid), and
// grade pairs whose Kalshi market has settled. The ladder never sees this until a
// report shows the community forecast beating the price on 100+ resolved pairs.
const { app, safeStorage } = require('electron')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

app.setPath('userData', path.join(app.getPath('appData'), 'oracle-trader'))
const REPO = process.cwd()
const OUT_DIR = path.join(REPO, 'data', 'metaculus-shadow')
const PAIRS = path.join(OUT_DIR, 'pairs.jsonl')
const GRADES = path.join(OUT_DIR, 'grades.jsonl')
const PAGE_SCRIPT = path.join(REPO, 'scripts', 'metaculus-page.cjs')
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2'
const METACULUS = 'https://www.metaculus.com/api'
const UA = 'oracle-trader metaculus-shadow (research; contact via repository)'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`)

function dec(v) {
  if (!v) return ''
  if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'))
  return v.replace(/^plain:/, '')
}
function readRows(p) {
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}
async function getJson(url, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(25_000) })
    if (res.status === 429 && attempt < 5) {
      // Kalshi's public limit is shared with every other read on this machine; wait it out.
      await sleep(3000 * (attempt + 1))
      continue
    }
    if (!res.ok) throw new Error(`GET ${url.slice(0, 90)} -> ${res.status}: ${(await res.text()).slice(0, 120)}`)
    return res.json()
  }
}

const STOP = new Set(
  'will the be a an of in on by to before after at for and or is than more less this that does do who what which with from as it its s not any have has been are was were over under above below during end year next new first last per each any all both either between into out about again there here when where how also than then them they their his her him she he you your our we us can could would should may might must shall'.split(' ')
)
function tokens(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w) && !/^20[0-9][0-9]$/.test(w))
  )
}
const CATEGORIES = new Set(['Elections', 'Politics', 'Economics', 'Entertainment', 'Financials', 'Companies', 'Science and Technology', 'Health', 'World', 'Social', 'Business', 'Transportation', 'Climate and Weather'])

/** Community probability when the API does expose it (rare). */
function communityP(post) {
  const q = post.question || post
  const ag = q.aggregations || {}
  for (const k of ['recency_weighted', 'unweighted']) {
    const latest = ag[k] && ag[k].latest
    const c = latest && (latest.centers || latest.forecast_values)
    if (Array.isArray(c) && typeof c[0] === 'number') return c[0]
  }
  return undefined
}

async function fetchMetaculus(token) {
  const out = []
  const seen = new Set()
  // Two listings: the most active questions (the big long-running ones) and the
  // soonest-resolving ones (2026-09-07: activity alone gave 301 of 500 beyond two years).
  for (const order of ['-activity', 'scheduled_resolve_time']) {
    for (let offset = 0; offset < 500; offset += 100) {
      const d = await getJson(`${METACULUS}/posts/?statuses=open&forecast_type=binary&with_cp=true&limit=100&offset=${offset}&order_by=${order}`, { Authorization: `Token ${token}` })
      const results = d.results || []
      for (const p of results) {
        const q = p.question || {}
        if (q.type && q.type !== 'binary') continue
        if (seen.has(p.id)) continue
        seen.add(p.id)
        const prob = communityP(p)
        const resolveAt = Date.parse(q.scheduled_resolve_time || p.scheduled_resolve_time || '')
        out.push({ id: p.id, title: p.title || q.title, p: typeof prob === 'number' ? prob : undefined, resolveAt: Number.isFinite(resolveAt) ? resolveAt : undefined })
      }
      if (results.length < 100) break
      await sleep(400)
    }
  }
  return out
}

/** Every open Kalshi event outside sports: title + subtitle, its category and series. */
async function fetchKalshiEvents() {
  const out = []
  let cursor = ''
  for (let page = 0; page < 40; page++) {
    const d = await getJson(`${KALSHI}/events?status=open&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    for (const e of d.events || []) {
      if (!e.event_ticker || !CATEGORIES.has(e.category)) continue
      out.push({ eventTicker: e.event_ticker, series: e.series_ticker, category: e.category, title: `${e.title || ''} ${e.sub_title || ''}`.trim() })
    }
    cursor = d.cursor || ''
    if (!cursor) break
    await sleep(450)
  }
  return out
}

/** The event's markets, priced. */
async function fetchEventMarkets(eventTicker) {
  const d = await getJson(`${KALSHI}/markets?event_ticker=${encodeURIComponent(eventTicker)}&status=open&limit=100`)
  const out = []
  for (const m of d.markets || []) {
    const bid = parseFloat(m.yes_bid_dollars || '')
    const ask = parseFloat(m.yes_ask_dollars || '')
    const mid = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : parseFloat(m.last_price_dollars || '')
    if (!(mid > 0 && mid < 1)) continue
    out.push({ ticker: m.ticker, title: m.title || '', subtitle: `${m.subtitle || ''} ${m.yes_sub_title || ''}`.trim(), mid, closeAt: Date.parse(m.close_time || '') })
  }
  return out
}

/** Community forecasts from the public pages, in one child process with its own profile. */
function readPages(ids) {
  return new Promise((resolve) => {
    if (ids.length === 0) return resolve(new Map())
    // An empty ELECTRON_RUN_AS_NODE still counts as set and turns the child into plain node; remove it.
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    execFile(process.execPath, [PAGE_SCRIPT, ...ids.map(String)], { cwd: REPO, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
      const out = new Map()
      for (const line of String(stdout || '').split(/\r?\n/)) {
        if (!line.startsWith('PAGE ')) continue
        try {
          const r = JSON.parse(line.slice(5))
          if (typeof r.pct === 'number') out.set(String(r.id), Math.min(0.995, Math.max(0.005, r.pct / 100)))
        } catch {
          // skip
        }
      }
      if (err) log(`page reader: ${String(err.message || err).slice(0, 120)} | stderr: ${String(stderr || '').slice(-300).replace(/\s+/g, ' ')}`)
      resolve(out)
    })
  })
}

async function collect(token) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const mc = await fetchMetaculus(token)
  const events = await fetchKalshiEvents()
  log(`metaculus open binary questions ${mc.length}; kalshi open non-sports events ${events.length}`)
  fs.writeFileSync(path.join(OUT_DIR, 'last-mc.json'), JSON.stringify(mc))
  fs.writeFileSync(path.join(OUT_DIR, 'last-kalshi.json'), JSON.stringify(events))
  // Rare tokens carry the match: weight shared tokens by their inverse frequency across Kalshi events.
  const et = events.map((e) => ({ ...e, tok: tokens(e.title) }))
  const df = new Map()
  for (const e of et) for (const w of e.tok) df.set(w, (df.get(w) || 0) + 1)
  const idf = (w) => Math.log((et.length + 1) / ((df.get(w) || 0) + 1))
  const today = new Date().toISOString().slice(0, 10)
  const seen = new Set(readRows(PAIRS).filter((r) => r.at.slice(0, 10) === today).map((r) => `${r.mcId}|${r.ticker}`))
  const matches = []
  const debug = []
  let noMarket = 0
  for (const q of mc) {
    const qt = tokens(q.title)
    if (qt.size < 3) continue
    const qWeight = [...qt].reduce((s, w) => s + idf(w), 0) || 1
    let best = null
    for (const e of et) {
      const shared = [...qt].filter((w) => e.tok.has(w) && idf(w) > 1)
      if (shared.length < 2) continue
      const score = shared.reduce((s, w) => s + idf(w), 0) / qWeight
      // Loose matches paired "Iranian government lose power" with "ABA lose accreditation power"
      // (2026-09-07): demand most of the question's rare weight, or three rare tokens with over half.
      if (!(score >= 0.85 || (score >= 0.6 && shared.length >= 3))) continue
      if (!best || score > best.score) best = { e, score, shared }
    }
    if (!best) continue
    let markets
    try {
      markets = await fetchEventMarkets(best.e.eventTicker)
      await sleep(300)
    } catch (err) {
      log(`${best.e.eventTicker}: markets failed: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    debug.push({ q: q.title, event: best.e.title, eventTicker: best.e.eventTicker, score: Math.round(best.score * 100) / 100, shared: best.shared, markets: markets.slice(0, 12).map((m) => `${m.subtitle || m.title} @${m.mid.toFixed(2)}`) })
    // Which market of the event? A single-market event is the event; otherwise the
    // market whose subtitle names a token of the question, else the date strike
    // closest to the question's resolution date.
    let market = markets.length === 1 ? markets[0] : undefined
    if (!market && markets.length > 1) {
      const scored = markets
        .map((m) => ({ m, hits: [...tokens(`${m.subtitle} ${m.title}`)].filter((w) => qt.has(w) && idf(w) > 1).length }))
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits)
      if (scored.length && (scored.length === 1 || scored[0].hits > scored[1].hits)) market = scored[0].m
      if (!market && q.resolveAt) {
        const dated = markets.filter((m) => Number.isFinite(m.closeAt)).sort((a, b) => Math.abs(a.closeAt - q.resolveAt) - Math.abs(b.closeAt - q.resolveAt))
        if (dated.length && Math.abs(dated[0].closeAt - q.resolveAt) <= 60 * 24 * 3600_000) market = dated[0]
      }
    }
    if (!market) {
      noMarket++
      continue
    }
    if (q.resolveAt && Number.isFinite(market.closeAt) && Math.abs(q.resolveAt - market.closeAt) > 60 * 24 * 3600_000) continue
    if (seen.has(`${q.id}|${market.ticker}`)) continue
    matches.push({ q, best, market })
  }
  fs.writeFileSync(path.join(OUT_DIR, 'last-matches.json'), JSON.stringify(debug, null, 1))
  const needPages = matches.filter((m) => typeof m.q.p !== 'number').map((m) => m.q.id).slice(0, 40)
  const fromPages = await readPages(needPages)
  let stored = 0
  let noValue = 0
  for (const { q, best, market } of matches) {
    const p = typeof q.p === 'number' ? q.p : fromPages.get(String(q.id))
    if (typeof p !== 'number') {
      noValue++
      continue
    }
    seen.add(`${q.id}|${market.ticker}`)
    fs.appendFileSync(
      PAIRS,
      JSON.stringify({
        at: new Date().toISOString(),
        mcId: q.id,
        mcTitle: q.title,
        mcP: p,
        mcResolveAt: q.resolveAt,
        ticker: market.ticker,
        eventTicker: best.e.eventTicker,
        kalshiTitle: `${best.e.title} | ${market.subtitle || market.title}`.trim(),
        mid: market.mid,
        score: Math.round(best.score * 100) / 100,
        shared: best.shared
      }) + '\n'
    )
    stored++
  }
  log(`matches ${matches.length}; pages read ${needPages.length}; pairs stored ${stored}; without a community value ${noValue}; event without a clear market ${noMarket}`)
}

async function grade() {
  const pairs = readRows(PAIRS)
  const graded = new Set(readRows(GRADES).map((g) => `${g.mcId}|${g.ticker}`))
  const byKey = new Map()
  for (const r of pairs) {
    const k = `${r.mcId}|${r.ticker}`
    if (graded.has(k)) continue
    const e = byKey.get(k) || { first: r, last: r }
    if (r.at < e.first.at) e.first = r
    if (r.at > e.last.at) e.last = r
    byKey.set(k, e)
  }
  let n = 0
  for (const [k, e] of byKey) {
    try {
      const m = (await getJson(`${KALSHI}/markets/${encodeURIComponent(e.last.ticker)}`)).market || {}
      if (!(m.status === 'settled' || m.status === 'finalized') || (m.result !== 'yes' && m.result !== 'no')) continue
      const y = m.result === 'yes' ? 1 : 0
      fs.appendFileSync(
        GRADES,
        JSON.stringify({ gradedAt: new Date().toISOString(), mcId: e.last.mcId, ticker: e.last.ticker, result: m.result, mcP: e.last.mcP, mid: e.last.mid, firstMcP: e.first.mcP, firstMid: e.first.mid, brierMc: (e.last.mcP - y) ** 2, brierMid: (e.last.mid - y) ** 2, score: e.last.score, mcTitle: e.last.mcTitle, kalshiTitle: e.last.kalshiTitle }) + '\n'
      )
      n++
    } catch (err) {
      log(`${k}: grade failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    await sleep(250)
  }
  log(`graded ${n} pairs (${byKey.size} open)`)
}

function report() {
  const g = readRows(GRADES)
  if (g.length === 0) {
    console.log('no graded pairs yet; pairs on file: ' + readRows(PAIRS).length)
    return
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length
  const closer = g.filter((r) => r.brierMc < r.brierMid).length
  console.log(`Metaculus community vs Kalshi mid on ${g.length} resolved pairs: Brier ${mean(g.map((r) => r.brierMc)).toFixed(4)} vs ${mean(g.map((r) => r.brierMid)).toFixed(4)} (lower is better); community closer on ${closer}`)
  const strong = g.filter((r) => (r.score || 0) >= 0.8)
  if (strong.length) console.log(`  high-confidence pairs only (match score >= 0.8): n=${strong.length} Brier ${mean(strong.map((r) => r.brierMc)).toFixed(4)} vs ${mean(strong.map((r) => r.brierMid)).toFixed(4)}`)
  for (const thr of [0.1, 0.15, 0.25]) {
    const pnl = []
    for (const r of g) {
      const y = r.result === 'yes' ? 1 : 0
      if (r.mcP - r.mid >= thr) {
        const px = Math.min(0.99, r.mid + 0.01)
        pnl.push(y - px - 0.07 * px * (1 - px))
      } else if (r.mid - r.mcP >= thr) {
        const px = Math.min(0.99, 1 - r.mid + 0.01)
        pnl.push(1 - y - px - 0.07 * px * (1 - px))
      }
    }
    console.log(`  trade when the community disagrees by ${thr}: n=${pnl.length} net ${pnl.reduce((s, x) => s + x, 0).toFixed(2)} mean ${(pnl.length ? mean(pnl) : 0).toFixed(3)}/contract wins ${pnl.filter((x) => x > 0).length}`)
  }
  if (g.length < 100) console.log('  (fewer than 100 resolved pairs: keep collecting before drawing a conclusion)')
}

app.whenReady().then(async () => {
  try {
    const mode = process.argv[process.argv.length - 1]
    if (mode === 'report') {
      report()
      return
    }
    let token = (process.env.METACULUS_API_KEY || '').trim()
    if (!token) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'kalshi-auto.json'), 'utf8')).config || {}
        token = dec(cfg.metaculusApiKey || '').trim()
      } catch {
        token = ''
      }
    }
    if (!token) {
      log('no Metaculus token yet (paste it in the Kalshi AutoTrader panel, "metaculus key"); nothing to do')
      return
    }
    if (mode === 'whoami') {
      const me = await getJson(`${METACULUS}/users/me/`, { Authorization: `Token ${token}` })
      console.log('WHOAMI ' + JSON.stringify({ id: me.id, username: me.username, is_bot: me.is_bot, date_joined: me.date_joined }))
      return
    }
    await collect(token)
    await grade()
  } catch (e) {
    log('failed: ' + (e instanceof Error ? e.message : String(e)))
  } finally {
    app.quit()
  }
})
