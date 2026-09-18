// Probe: do "missed" old markets have candles anywhere in their life?
// Run: node scripts/diag-candles3.mjs
import { buildPool, getCandles } from './lib/hist.mjs'

async function main() {
  const pool = await buildPool({ historicalFirst: true, livePages: 4, historicalPages: 6 })
  const longshots = pool.filter(
    (m) => m.last > 0 && m.last < 0.1 && m.result && m.close > 0 && m.open > 0 && m.close - m.open >= 90 * 60_000
  )
  console.log('longshots:', longshots.length)
  let haveAny = 0
  let none = 0
  let total = 0
  const examples = { none: [], some: [] }
  for (const m of longshots.slice(0, 120)) {
    const candles = await getCandles(m.ticker, Math.floor(m.open / 1000), Math.floor(m.close / 1000), 1, m.close)
    total++
    if (candles.length > 0) {
      haveAny++
      if (examples.some.length < 3) examples.some.push({ t: m.ticker, n: candles.length, first: candles[0].end_period_ts, last: candles[candles.length - 1].end_period_ts })
    } else {
      none++
      if (examples.none.length < 3) examples.none.push(m.ticker)
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  console.log(`whole-life candle availability: ${haveAny}/${total} have candles, ${none} empty`)
  console.log('some examples:', JSON.stringify(examples.some))
  console.log('none examples:', examples.none)
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
