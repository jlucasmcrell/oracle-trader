// Diagnostic #3: settled-market listing + candle routing across the cutoff.
// Run: node scripts/diag-historical3.mjs
const BASE = 'https://api.elections.kalshi.com/trade-api/v2'

async function main() {
  // 1) live settled listing
  const s = await (await fetch(`${BASE}/markets?status=settled&limit=5`)).json()
  const recent = (s.markets ?? []).map((m) => ({ t: m.ticker, c: m.close_time, o: m.open_time }))
  console.log('live settled sample:', JSON.stringify(recent, null, 1))

  // 2) live batch candles (comma-joined) for those settled tickers
  const now = Math.floor(Date.now() / 1000)
  const tickers = recent.map((m) => m.t).join(',')
  const lc = await (
    await fetch(`${BASE}/markets/candlesticks?market_tickers=${encodeURIComponent(tickers)}&start_ts=${now - 5 * 86400}&end_ts=${now}&period_interval=1`)
  ).json()
  for (const x of lc.markets ?? []) {
    console.log(`live batch candles ${x.market_ticker}: ${(x.candlesticks ?? []).length}`)
  }

  // 3) historical candles, period 1, exact life of the June-27 esports market
  const h = await (
    await fetch(
      `${BASE}/historical/markets/KXMVESPORTSMULTIGAMEEXTENDED-S2026B1A6BF525DE-7B5DAC3C3E8/candlesticks?start_ts=1787874353&end_ts=1787875034&period_interval=1`
    )
  ).json()
  const cs = h.candlesticks ?? []
  console.log(`historical period-1 esports market: ${cs.length}, first: ${JSON.stringify(cs[0]).slice(0, 250)}`)

  // 4) does /historical/markets accept series_ticker filter?
  const f = await (
    await fetch(`${BASE}/historical/markets?limit=5&series_ticker=KXBTCD`)
  ).json()
  console.log('historical series_ticker=KXBTCD →', (f.markets ?? []).length, 'markets, first:', (f.markets ?? [])[0]?.ticker)

  // 5) how many settled markets does the LIVE endpoint see?
  let cursor
  let count = 0
  for (let p = 0; p < 3; p++) {
    const r = await (
      await fetch(`${BASE}/markets?status=settled&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    ).json()
    const ms = r.markets ?? []
    count += ms.length
    const series = new Map()
    for (const m of ms) {
      const k = m.ticker.split('-')[0]
      series.set(k, (series.get(k) ?? 0) + 1)
    }
    console.log(`live settled page ${p}: ${ms.length}, series: ${series.size}, top: ${[...series.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}=${n}`).join('  ')}`)
    cursor = r.cursor
    if (!cursor) break
  }
  console.log('live settled counted:', count, 'cursor?', !!cursor)
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
