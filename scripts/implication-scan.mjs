// Cross-series implication scan: spread markets against their moneyline (backlog 162, from external review §129).
// PUBLIC DATA ONLY; trades nothing; no keys.
//
// Why: within one ladder Kalshi's prices are monotone to within fees (backlog 76, 1.1M rows). Across SERIES the
// same logical relation exists and was never scanned: "T wins by over X" (a SPREAD market) implies "T wins" (the
// GAME market), and "U wins" implies NOT "T wins by over X". Whenever the implied side is priced below the
// implying side by more than two taker fees, buying B and selling A pays at least $1 in every outcome for less
// than $1 - a Dutch book with a free option on the "B but not A" case.
//
//   check 1  bid(S_T) - ask(G_T) > fees      sell the spread (NO on S at 1 - bid), buy the moneyline
//   check 2  bid(G_U) + bid(S_T) > 1 + fees  sell both (NO on each)
//
// Pass 1 uses the cached /markets list quotes for every full-game spread series; every flagged pair is re-read
// from the live orderbook before it is reported (the list is 18+ s stale, §111).
//   node scripts/implication-scan.mjs            print the flagged pairs (live-book confirmed) and the summary
//   node scripts/implication-scan.mjs --record   also append rows to data/implication-scan/YYYY-MM-DD.jsonl
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const K = 'https://api.elections.kalshi.com/trade-api/v2'
const OUT = 'G:/PROJECTS/oracle-trader/data/implication-scan'
const RECORD = process.argv.includes('--record')
const PERIOD = /1H|2H|1Q|2Q|3Q|4Q|\dP\b|OT|SET|MAP|INN|HALF|QTR/
const H = { 'User-Agent': 'oracle-trader-research/1.0' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
const fee = (p) => Math.ceil(0.07 * p * (1 - p) * 10000 - 1e-9) / 10000

async function get(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${K}${path}`, { headers: H, signal: AbortSignal.timeout(20_000) })
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (e) { if (i === tries - 1) throw e; await sleep(1000 * (i + 1)) }
  }
  throw new Error('rate limited')
}

async function openMarkets(series) {
  const out = []
  let cur
  for (let page = 0; page < 10; page++) {
    const d = await get(`/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=100${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`).catch(() => null)
    if (!d) break
    out.push(...(d.markets ?? []))
    cur = d.cursor
    if (!cur || !(d.markets ?? []).length) break
    await sleep(120)
  }
  return out
}

async function books(tickers) {
  const out = new Map()
  for (let i = 0; i < tickers.length; i += 40) {
    const chunk = tickers.slice(i, i + 40)
    const d = await get(`/markets/orderbooks?${chunk.map((t) => `tickers=${encodeURIComponent(t)}`).join('&')}&depth=1`).catch(() => null)
    for (const o of d?.orderbooks ?? []) {
      const fp = o.orderbook_fp ?? {}
      const bid = (fp.yes_dollars ?? []).map(([p, s]) => [num(p), num(s)]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => b[0] - a[0])[0]
      const noBid = (fp.no_dollars ?? []).map(([p, s]) => [num(p), num(s)]).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => b[0] - a[0])[0]
      out.set(o.ticker, { bid: bid?.[0] ?? null, bidSize: bid?.[1] ?? 0, ask: noBid ? +(1 - noBid[0]).toFixed(4) : null, askSize: noBid?.[1] ?? 0 })
    }
    await sleep(150)
  }
  return out
}

/** Every pair the two quote sets imply, with the surplus in cents after two taker fees (positive = a book). */
function pairs(spreads, games, q) {
  const out = []
  for (const s of spreads) {
    const x = num(s.floor_strike)
    if (x === null || x <= 0 || !/^greater/.test(String(s.strike_type ?? 'greater'))) continue
    const parts = s.ticker.split('-')
    if (parts.length < 3) continue
    const stem = parts[1]
    const team = parts[2].replace(/\d+$/, '')
    const gameSeries = parts[0].replace('SPREAD', 'GAME')
    const gT = games.get(`${gameSeries}-${stem}-${team}`)
    if (!gT) continue
    const others = [...games.values()].filter((g) => g.ticker.startsWith(`${gameSeries}-${stem}-`) && g.ticker !== gT.ticker && !/-TIE$/.test(g.ticker))
    const qs = q(s.ticker), qt = q(gT.ticker)
    if (qs?.bid != null && qt?.ask != null) {
      const surplus = qs.bid - qt.ask - fee(qs.bid) - fee(qt.ask)
      out.push({ check: 1, spread: s.ticker, game: gT.ticker, x, team, bidS: qs.bid, askG: qt.ask, surplusCents: +(surplus * 100).toFixed(2), size: Math.min(qs.bidSize ?? 0, qt.askSize ?? 0) })
    }
    for (const gU of others) {
      const qu = q(gU.ticker)
      if (qs?.bid != null && qu?.bid != null) {
        const surplus = qu.bid + qs.bid - 1 - fee(qs.bid) - fee(qu.bid)
        out.push({ check: 2, spread: s.ticker, game: gU.ticker, x, team, bidS: qs.bid, bidGU: qu.bid, surplusCents: +(surplus * 100).toFixed(2), size: Math.min(qs.bidSize ?? 0, qu.bidSize ?? 0) })
      }
    }
  }
  return out
}

async function main() {
  const series = []
  let cur
  for (let page = 0; page < 30; page++) {
    const d = await get(`/series?category=Sports&limit=200${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`)
    series.push(...(d.series ?? []).map((s) => s.ticker))
    cur = d.cursor
    if (!cur || !(d.series ?? []).length) break
    await sleep(120)
  }
  const spreadSeries = series.filter((t) => /SPREAD/.test(t) && !PERIOD.test(t.replace(/^KX/, '').replace('SPREAD', '')))
  console.log(`${series.length} sports series, ${spreadSeries.length} full-game spread series`)
  let allPairs = []
  let spreadMarkets = 0
  for (const st of spreadSeries) {
    const spreads = await openMarkets(st)
    if (!spreads.length) continue
    const gameMarkets = await openMarkets(st.replace('SPREAD', 'GAME'))
    if (!gameMarkets.length) continue
    spreadMarkets += spreads.length
    const games = new Map(gameMarkets.map((m) => [m.ticker, m]))
    const list = new Map([...spreads, ...gameMarkets].map((m) => [m.ticker, { bid: num(m.yes_bid_dollars), ask: num(m.yes_ask_dollars), bidSize: 1, askSize: 1 }]))
    allPairs.push(...pairs(spreads, games, (t) => list.get(t)).map((p) => ({ ...p, series: st })))
    await sleep(150)
  }
  const flagged = allPairs.filter((p) => p.surplusCents > 0)
  console.log(`${spreadMarkets} spread markets, ${allPairs.length} implication pairs on list quotes, ${flagged.length} with a positive surplus on list quotes`)
  // Confirm on live books
  const tickers = [...new Set(flagged.flatMap((p) => [p.spread, p.game]))]
  const live = await books(tickers)
  const confirmed = []
  for (const p of flagged) {
    const qs = live.get(p.spread), qg = live.get(p.game)
    if (!qs || !qg) continue
    const surplus = p.check === 1
      ? (qs.bid != null && qg.ask != null ? qs.bid - qg.ask - fee(qs.bid) - fee(qg.ask) : null)
      : (qs.bid != null && qg.bid != null ? qg.bid + qs.bid - 1 - fee(qs.bid) - fee(qg.bid) : null)
    if (surplus === null) continue
    confirmed.push({ ...p, liveSurplusCents: +(surplus * 100).toFixed(2), liveSize: p.check === 1 ? Math.min(qs.bidSize, qg.askSize) : Math.min(qs.bidSize, qg.bidSize) })
  }
  const real = confirmed.filter((p) => p.liveSurplusCents > 0)
  console.log(`${confirmed.length} re-read on live books, ${real.length} still positive after two taker fees`)
  for (const p of real.sort((a, b) => b.liveSurplusCents - a.liveSurplusCents).slice(0, 20)) {
    console.log(`  check ${p.check}  ${p.spread.padEnd(40)} vs ${p.game.padEnd(34)} surplus ${p.liveSurplusCents.toFixed(2)}c  depth ${p.liveSize}`)
  }
  const dist = allPairs.map((p) => p.surplusCents).sort((a, b) => a - b)
  const pct = (f) => dist.length ? dist[Math.min(dist.length - 1, Math.floor(f * dist.length))].toFixed(2) : 'n/a'
  console.log(`surplus distribution on list quotes (cents, after fees): p10 ${pct(0.1)}  p50 ${pct(0.5)}  p90 ${pct(0.9)}  max ${dist.length ? dist[dist.length - 1].toFixed(2) : 'n/a'}`)
  if (RECORD) {
    mkdirSync(OUT, { recursive: true })
    const ts = new Date().toISOString()
    for (const p of confirmed) appendFileSync(join(OUT, `${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, ...p }) + '\n')
    appendFileSync(join(OUT, 'scan.log'), `[${ts}] ${spreadMarkets} spreads, ${allPairs.length} pairs, ${flagged.length} flagged, ${real.length} confirmed\n`)
  }
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
