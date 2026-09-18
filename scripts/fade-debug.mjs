// Minimal reproduction of the fade worker with per-iteration logging.
// Run: node scripts/fade-debug.mjs
import { buildPool, getCandles, bidAt, sleep } from './lib/hist.mjs'

async function main() {
  const pool = await buildPool({ historicalFirst: true, livePages: 5, historicalPages: 8 })
  const longshots = pool.filter(
    (m) => m.last > 0 && m.last < 0.1 && m.result && m.close > 0 && m.open > 0 && m.close - m.open >= 90 * 60_000
  )
  console.log('longshots:', longshots.length)
  const sample = longshots.slice(0, 40)
  console.log('sample:', sample.length)

  let done = 0
  const workers = Array.from({ length: 2 }, async () => {
    while (true) {
      const m = sample[done++]
      if (!m) return
      try {
        const start = Math.floor((m.close - 90 * 60_000) / 1000)
        const end = Math.floor((m.close - 30 * 60_000) / 1000)
        const candles = await getCandles(m.ticker, start, end, 1, m.close)
        const target = m.close - 60 * 60_000
        let best = null
        for (const c of candles) {
          const d = Math.abs(c.end_period_ts * 1000 - target)
          if (!best || d < best.d) best = { d, c }
        }
        const bid = best ? bidAt(best.c) : undefined
        console.log(
          `${done - 1}/${sample.length}  ${m.ticker}  candles=${candles.length}  best=${best ? new Date(best.c.end_period_ts * 1000).toISOString().slice(11, 16) : 'none'}  bid=${bid}`
        )
      } catch (err) {
        console.log(`${done - 1}/${sample.length}  ${m.ticker}  ERROR ${err.message}`)
      }
      await sleep(30)
    }
  })
  await Promise.all(workers)
  console.log('done:', done)
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
