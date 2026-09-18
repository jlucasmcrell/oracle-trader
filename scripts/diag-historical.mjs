// Diagnostic for the historical backtest scripts.
// Run: node scripts/diag-historical.mjs
const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

async function main() {
  // 1) pagination check
  const p1 = await (await fetch(`${BASE}/historical/markets?limit=1000`)).json()
  const p2 = await (await fetch(`${BASE}/historical/markets?limit=1000&cursor=${encodeURIComponent(p1.cursor ?? '')}`)).json()
  const t1 = (p1.markets ?? []).map((m) => m.ticker)
  const t2 = (p2.markets ?? []).map((m) => m.ticker)
  const overlap = t1.filter((t) => t2.includes(t)).length
  const seriesP1 = new Set(t1.map((t) => t.split('-')[0].slice(0, 14))).size
  const seriesP2 = new Set(t2.map((t) => t.split('-')[0].slice(0, 14))).size
  console.log(`p1: ${t1.length}  p2: ${t2.length}  overlap: ${overlap}  series p1: ${seriesP1}  series p2: ${seriesP2}`)
  console.log(`p1 first: ${t1[0]}  |  p2 first: ${t2[0]}`)

  // 2) duration distribution in first 3000
  let cursor = p1.cursor
  let dur40 = 0
  let dur65 = 0
  let total = 0
  for (let pg = 0; pg < 3; pg++) {
    const r =
      pg === 0
        ? p1
        : await (await fetch(`${BASE}/historical/markets?limit=1000&cursor=${encodeURIComponent(cursor)}`)).json()
    for (const m of r.markets ?? []) {
      const c = m.close_time ? Date.parse(m.close_time) : 0
      const o = m.open_time ? Date.parse(m.open_time) : 0
      total++
      if (o > 0 && c - o >= 40 * 60_000) dur40++
      if (o > 0 && c - o >= 65 * 60_000) dur65++
    }
    cursor = r.cursor
    if (!cursor) break
  }
  console.log(`duration: total ${total}, >=40min ${dur40}, >=65min ${dur65}`)

  // 3) one longshot's candles at T-1h
  let target = null
  for (const m of p1.markets ?? []) {
    const c = m.close_time ? Date.parse(m.close_time) : 0
    const o = m.open_time ? Date.parse(m.open_time) : 0
    if (c - o >= 65 * 60_000 && num(m.last_price_dollars) < 0.1 && m.result === 'no') {
      target = { t: m.ticker, c, o, last: m.last_price_dollars, open: m.open_time, close: m.close_time }
      break
    }
  }
  console.log('longshot target:', JSON.stringify(target))
  if (target) {
    const s = Math.floor((target.c - 65 * 60_000) / 1000)
    const e = Math.floor((target.c - 55 * 60_000) / 1000)
    for (const period of [1, 60]) {
      const x = await (
        await fetch(`${BASE}/historical/markets/${target.t}/candlesticks?start_ts=${s}&end_ts=${e}&period_interval=${period}`)
      ).json()
      const cs = x.candlesticks ?? []
      console.log(`T-1h window period ${period}: count ${cs.length}, first: ${JSON.stringify(cs[0]).slice(0, 260)}`)
    }
    // whole life, period 60
    const y = await (
      await fetch(`${BASE}/historical/markets/${target.t}/candlesticks?start_ts=${Math.floor(target.o / 1000)}&end_ts=${Math.floor(target.c / 1000)}&period_interval=60`)
    ).json()
    console.log(`whole-life period 60: count ${(y.candlesticks ?? []).length}, first: ${JSON.stringify(y.candlesticks?.[0]).slice(0, 260)}`)
  }

  // 4) settlement_value semantics
  let svYes = 0
  let svNo = 0
  let svOther = 0
  for (const m of p1.markets ?? []) {
    const sv = m.settlement_value_dollars
    if (sv !== undefined && sv !== '') {
      if (m.result === 'yes') svYes++
      else if (m.result === 'no') svNo++
      else svOther++
    }
  }
  console.log(`settlement_value_dollars present: yes=${svYes} no=${svNo} other=${svOther}`)
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
