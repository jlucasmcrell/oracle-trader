// Diagnostic #2: candle routing + page diversity.
// Run: node scripts/diag-historical2.mjs
const BASE = 'https://api.elections.kalshi.com/trade-api/v2'

async function main() {
  const cutoff = await (await fetch(`${BASE}/historical/cutoff`)).json()
  console.log('cutoff:', JSON.stringify(cutoff))

  const p1 = await (await fetch(`${BASE}/historical/markets?limit=1000`)).json()
  const settled = (p1.markets ?? []).slice(0, 5).map((m) => ({ t: m.ticker, c: m.close_time, o: m.open_time }))
  console.log('sample settled:', JSON.stringify(settled, null, 1))

  // live batch candles for these settled tickers (are they still served?)
  const now = Math.floor(Date.now() / 1000)
  const start = now - 40 * 86400
  const q = settled.map((m) => `market_tickers=${encodeURIComponent(m.t)}`).join('&')
  const live = await (
    await fetch(`${BASE}/markets/candlesticks?${q}&start_ts=${start}&end_ts=${now}&period_interval=60`)
  ).json()
  for (const x of live.markets ?? []) {
    console.log(`live batch candles ${x.market_ticker}: ${(x.candlesticks ?? []).length}`)
  }

  // historical candles for the same (should be empty if they're inside the live window)
  for (const m of settled.slice(0, 2)) {
    const o = m.o ? Math.floor(Date.parse(m.o) / 1000) : start
    const c = m.c ? Math.floor(Date.parse(m.c) / 1000) : now
    const h = await (
      await fetch(`${BASE}/historical/markets/${m.t}/candlesticks?start_ts=${o}&end_ts=${c}&period_interval=60`)
    ).json()
    console.log(`historical candles ${m.t}: ${(h.candlesticks ?? []).length}`)
  }

  // series diversity per page
  let cursor
  for (const page of [1, 5, 15, 40, 80]) {
    const r = await (
      await fetch(`${BASE}/historical/markets?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    ).json()
    const ms = r.markets ?? []
    const series = new Map()
    for (const m of ms) {
      const s = m.ticker.split('-')[0]
      series.set(s, (series.get(s) ?? 0) + 1)
    }
    const top = [...series.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    console.log(`page ${page}: ${ms.length} markets, ${series.size} series, top: ${top.map(([s, n]) => `${s}=${n}`).join('  ')}`)
    cursor = r.cursor
    if (!cursor) break
  }
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
