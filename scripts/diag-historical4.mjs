// Diagnostic #4: mve exclusion + candle routing for non-mve markets.
// Run: node scripts/diag-historical4.mjs
const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

async function main() {
  // 1) historical with mve_filter=exclude
  const h = await (await fetch(`${BASE}/historical/markets?limit=1000&mve_filter=exclude`)).json()
  const ms = h.markets ?? []
  const series = new Map()
  for (const m of ms) {
    const k = m.ticker.split('-')[0]
    series.set(k, (series.get(k) ?? 0) + 1)
  }
  console.log(`historical mve_filter=exclude: ${ms.length} markets, ${series.size} series`)
  console.log(`  top: ${[...series.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}=${n}`).join('  ')}`)

  // 2) series_ticker filter on historical
  for (const st of ['KXETHD', 'KXHIGHNY']) {
    const f = await (await fetch(`${BASE}/historical/markets?limit=3&series_ticker=${st}`)).json()
    console.log(`historical series_ticker=${st} → ${(f.markets ?? []).length} markets, first: ${(f.markets ?? [])[0]?.ticker}`)
  }

  // 3) live settled, mve excluded
  const s = await (await fetch(`${BASE}/markets?status=settled&mve_filter=exclude&limit=1000`)).json()
  const sm = s.markets ?? []
  const sSeries = new Map()
  for (const m of sm) {
    const k = m.ticker.split('-')[0]
    sSeries.set(k, (sSeries.get(k) ?? 0) + 1)
  }
  console.log(`live settled mve excluded: ${sm.length} markets, ${sSeries.size} series`)
  console.log(`  top: ${[...sSeries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}=${n}`).join('  ')}`)

  // pick a settled non-mve crypto market for candle routing
  const target = sm.find((m) => /^KXETH|^KXBTC|^KXXRP|^KXSOL|^KXHIGH/.test(m.ticker))
  console.log('target:', target?.ticker, 'close:', target?.close_time, 'open:', target?.open_time)
  if (target) {
    const o = Math.floor(Date.parse(target.open_time) / 1000)
    const c = Math.floor(Date.parse(target.close_time) / 1000)
    const lc = await (
      await fetch(`${BASE}/markets/candlesticks?market_tickers=${encodeURIComponent(target.ticker)}&start_ts=${o}&end_ts=${c}&period_interval=1`)
    ).json()
    console.log(`live batch candles (period 1, exact life): ${(lc.markets ?? [])[0]?.candlesticks?.length ?? 0}`)
    const hc = await (
      await fetch(`${BASE}/historical/markets/${target.ticker}/candlesticks?start_ts=${o}&end_ts=${c}&period_interval=1`)
    ).json()
    console.log(`historical candles (period 1, exact life): ${(hc.candlesticks ?? []).length}`)
  }

  // 4) an OLD non-mve market's historical candles (from the excluded listing, older than cutoff)
  const old = ms.find((m) => m.close_time && Date.parse(m.close_time) < Date.parse('2026-06-28T00:00:00Z'))
  console.log('old target:', old?.ticker, 'close:', old?.close_time)
  if (old) {
    const o = Math.floor(Date.parse(old.open_time) / 1000)
    const c = Math.floor(Date.parse(old.close_time) / 1000)
    const hc = await (
      await fetch(`${BASE}/historical/markets/${old.ticker}/candlesticks?start_ts=${o}&end_ts=${c}&period_interval=1`)
    ).json()
    console.log(`old-market historical candles (period 1): ${(hc.candlesticks ?? []).length}, first: ${JSON.stringify(hc.candlesticks?.[0]).slice(0, 220)}`)
  }
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
