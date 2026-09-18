// Experiment (e) proxy v2: settlement-convergence screening.
// For settled strike markets: distance between the winning side's price at
// T-30min and certainty (1.0). If a meaningful fraction were still > 5¢ away
// 30 min out, there is room for the index-leads-price edge.
// Run: node scripts/backtest-settlement-proxy.mjs
import { buildPool, getCandles, priceAt, sleep } from './lib/hist.mjs'

const SAMPLE = 400
const CONCURRENCY = 4

async function main() {
  const pool = await buildPool()
  const strikes = pool.filter(
    (m) =>
      m.result &&
      m.close > 0 &&
      m.open > 0 &&
      m.close - m.open >= 35 * 60_000 &&
      (m.strikeType || /above|below/i.test(m.yesSub))
  )
  console.log(`settled strike markets: ${strikes.length}`)
  const sample = strikes.slice(0, SAMPLE)

  const gaps = []
  let done = 0
  let usable = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const m = sample[done++]
      if (!m) return
      try {
        const candles = await getCandles(m.ticker, Math.floor(m.open / 1000), Math.floor(m.close / 1000), 1, m.close)
        const target = m.close - 30 * 60_000
        let best = null
        for (const c of candles) {
          const p = priceAt(c)
          if (p === undefined) continue
          const d = Math.abs(c.end_period_ts * 1000 - target)
          if (!best || d < best.d) best = { d, p }
        }
        if (!best || best.d > 30 * 60_000) {
          continue
        }
        usable++
        const winSide = m.result === 'yes' ? best.p : 1 - best.p
        gaps.push({ gap: winSide - 1, series: m.series })
      } catch {
        // skip
      }
      if (done % 20 === 0) process.stdout.write(`\r  ${done}/${sample.length}`)
      await sleep(40)
    }
  })
  await Promise.all(workers)
  console.log(`\nusable observations: ${usable}`)
  if (gaps.length === 0) return

  const abs = gaps.map((g) => Math.abs(g.gap))
  const over5 = abs.filter((x) => x > 0.05).length / abs.length
  const over10 = abs.filter((x) => x > 0.1).length / abs.length
  const over3 = abs.filter((x) => x > 0.03).length / abs.length
  const mean = abs.reduce((s, x) => s + x, 0) / abs.length
  const sorted = [...abs].sort((a, b) => a - b)
  console.log(`=== VERDICT ===`)
  console.log(`n=${gaps.length}  mean |P(win side @T-30) - 1| = ${(mean * 100).toFixed(1)}¢  median ${(sorted[Math.floor(sorted.length / 2)] * 100).toFixed(1)}¢`)
  console.log(`still > 3¢ from certainty at T-30: ${(over3 * 100).toFixed(1)}%   > 5¢: ${(over5 * 100).toFixed(1)}%   > 10¢: ${(over10 * 100).toFixed(1)}%`)
  console.log(
    over5 > 0.1
      ? 'SCREENING: room for the index-leads-price edge exists — forward logging is worth starting.'
      : 'SCREENING: mostly converged at T-30 — settlement edge unlikely at this horizon.'
  )
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
