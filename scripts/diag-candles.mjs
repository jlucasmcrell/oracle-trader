// Debug: inspect raw candles returned by the routed fetcher for both
// post-cutoff (live endpoint) and pre-cutoff (historical) settled markets.
// Run: node scripts/diag-candles.mjs
import { buildPool, getCandles, priceAt, bidAt } from './lib/hist.mjs'

async function main() {
  const pool = await buildPool({ livePages: 5, historicalPages: 5 })
  const cutoff = Date.parse('2026-06-28T00:00:00Z')
  const recent = pool.filter((m) => m.close >= cutoff && m.close - m.open >= 60 * 60_000).slice(0, 2)
  const old = pool.filter((m) => m.close < cutoff && m.close - m.open >= 60 * 60_000).slice(0, 2)
  console.log('recent targets:', recent.map((m) => `${m.ticker} (${new Date(m.close).toISOString()})`))
  console.log('old targets:', old.map((m) => `${m.ticker} (${new Date(m.close).toISOString()})`))

  for (const m of [...recent, ...old]) {
    const start = Math.floor((m.close - 65 * 60_000) / 1000)
    const end = Math.floor((m.close - 55 * 60_000) / 1000)
    const candles = await getCandles(m.ticker, start, end, 1, m.close)
    console.log(`\n${m.ticker}  close=${new Date(m.close).toISOString()}  candles in T-1h window: ${candles.length}`)
    if (candles.length > 0) {
      console.log('  first raw:', JSON.stringify(candles[0]).slice(0, 400))
      console.log('  priceAt(first):', priceAt(candles[0]), ' bidAt(first):', bidAt(candles[0]))
      const withP = candles.map(priceAt).filter((p) => p !== undefined)
      const withB = candles.map(bidAt).filter((b) => b !== undefined)
      console.log(`  priceAt defined: ${withP.length}/${candles.length}, bidAt defined: ${withB.length}/${candles.length}`)
    }
    // also whole life
    const full = await getCandles(m.ticker, Math.floor(m.open / 1000), Math.floor(m.close / 1000), 1, m.close)
    console.log(`  whole-life candles: ${full.length}, priceAt defined: ${full.map(priceAt).filter((p) => p !== undefined).length}`)
  }
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
