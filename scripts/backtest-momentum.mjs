// Experiment (b) v3: Momentum hit-rate backtest.
// - clean pool, historical-first (dense archived candles)
// - relaxed 10-min lookback alignment (±3 min) for sparse series
// - instrumented error reporting
//
// Run: node scripts/backtest-momentum.mjs
import { buildPool, getCandles, priceAt, sleep } from './lib/hist.mjs'

const THRESHOLD = 0.03
const WINDOW_MIN = 10
const FORWARD_MIN = 30
const TARGET_MARKETS = 1500
const PER_SERIES_CAP = 40
const EVAL_HOURS = 8
const CONCURRENCY = 4

async function main() {
  const pool = await buildPool({ historicalFirst: true, livePages: 15, historicalPages: 25 })
  const bySeries = new Map()
  const candidates = []
  for (const m of pool) {
    if (!m.result || m.close <= 0 || m.open <= 0) continue
    if (m.close - m.open < 60 * 60_000) continue
    if ((bySeries.get(m.series) ?? 0) >= PER_SERIES_CAP) continue
    bySeries.set(m.series, (bySeries.get(m.series) ?? 0) + 1)
    candidates.push(m)
  }
  const sample = candidates.slice(0, TARGET_MARKETS)
  console.log(`sampled ${sample.length} settled markets across ${bySeries.size} series`)

  const signals = []
  let done = 0
  let tooFewCandles = 0
  let errors = 0
  const firstErrors = []
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const m = sample[done++]
      if (!m) return
      try {
        const startSec = Math.floor(Math.max(m.open, m.close - EVAL_HOURS * 3600_000) / 1000)
        const endSec = Math.floor(m.close / 1000)
        const candles = await getCandles(m.ticker, startSec, endSec, 1, m.close)
        const series = candles.map((c) => ({ t: c.end_period_ts * 1000, p: priceAt(c) })).filter((x) => x.p !== undefined)
        if (series.length < 12) {
          tooFewCandles++
          continue
        }
        for (let i = 0; i < series.length; i += 5) {
          const t = series[i]
          if (t.t > m.close - 45 * 60_000) break
          const back = series.find((x) => Math.abs(x.t - (t.t - WINDOW_MIN * 60_000)) < 4 * 60_000)
          if (!back) continue
          const move = t.p - back.p
          if (Math.abs(move) < THRESHOLD) continue
          const dir = move > 0 ? 1 : -1
          const fwdT = Math.min(t.t + FORWARD_MIN * 60_000, m.close - 60_000)
          let fwd = series[series.length - 1]
          for (const x of series) if (x.t >= fwdT) { fwd = x; break }
          signals.push({ series: m.series, dir, move, fwdMove: (fwd.p - t.p) * dir })
        }
      } catch (err) {
        errors++
        if (firstErrors.length < 3) firstErrors.push(`${m.ticker}: ${err.message}`)
      }
      if (done % 25 === 0) process.stdout.write(`\r  ${done}/${sample.length}`)
      await sleep(40)
    }
  })
  await Promise.all(workers)
  console.log(`\nsignals fired: ${signals.length}  (too few candles: ${tooFewCandles}, errors: ${errors})`)
  for (const e of firstErrors) console.log(`  first error: ${e}`)

  if (signals.length === 0) {
    console.log('no signals — threshold never crossed in sample')
    return
  }
  const moves = signals.map((s) => s.fwdMove)
  const mean = moves.reduce((s, x) => s + x, 0) / moves.length
  const hits = moves.filter((x) => x > 0).length / moves.length
  const sorted = [...moves].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  console.log(`=== VERDICT ===`)
  console.log(`n=${signals.length}  hit rate ${(hits * 100).toFixed(1)}%  mean forward move ${(mean * 100).toFixed(2)}¢  median ${(median * 100).toFixed(2)}¢`)
  console.log(`distribution: p10 ${(sorted[Math.floor(sorted.length * 0.1)] * 100).toFixed(1)}¢  p25 ${(sorted[Math.floor(sorted.length * 0.25)] * 100).toFixed(1)}¢  p75 ${(sorted[Math.floor(sorted.length * 0.75)] * 100).toFixed(1)}¢  p90 ${(sorted[Math.floor(sorted.length * 0.9)] * 100).toFixed(1)}¢`)
  console.log(`PASS BAR (mean > 4¢ AND hit rate > 50%): ${mean > 0.04 && hits > 0.5 ? 'PASS' : 'FAIL'}`)
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
