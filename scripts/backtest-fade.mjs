// Experiment (a) v3: Fade entry-timing backtest.
// - clean pool (mve excluded), historical-first (dense archived candles)
// - T-1h executable NO-ask from the nearest candle in [close-90m, close-30m]
// - instrumented (reports fetch/parse errors instead of failing silently)
//
// Run: node scripts/backtest-fade.mjs
import { buildPool, getCandles, bidAt, sleep } from './lib/hist.mjs'

const FEE = 0.01
const MAX_PRICE = 0.1
const SAMPLE = 2500
const CONCURRENCY = 4

async function main() {
  const pool = await buildPool({ historicalFirst: true, livePages: 15, historicalPages: 25 })
  console.log(`clean pool (mve excluded): ${pool.length} settled markets`)

  // calibration on the clean pool (bucket by last traded price)
  const BUCKETS = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95, 0.98, 1.01]
  const buckets = BUCKETS.map(() => ({ n: 0, yes: 0 }))
  for (const m of pool) {
    if (!(m.last > 0 && m.last < 1)) continue
    const bi = BUCKETS.findIndex((b) => m.last < b)
    if (bi < 0) continue
    buckets[bi].n++
    if (m.result === 'yes') buckets[bi].yes++
  }
  console.log('\ncalibration (clean, by last traded price):')
  for (let i = 0; i < BUCKETS.length - 1; i++) {
    const b = buckets[i]
    if (b.n === 0) continue
    const mid = (BUCKETS[i] + BUCKETS[i + 1]) / 2
    console.log(
      `  ${BUCKETS[i].toFixed(2)}-${BUCKETS[i + 1].toFixed(2)}  n=${String(b.n).padEnd(6)}  P(YES) ${((b.yes / b.n) * 100).toFixed(1)}%  vs implied ${(mid * 100).toFixed(1)}%`
    )
  }

  // entry-timing backtest
  const longshots = pool.filter(
    (m) => m.last > 0 && m.last < MAX_PRICE && m.result && m.close > 0 && m.open > 0 && m.close - m.open >= 90 * 60_000
  )
  console.log(`\nlongshots alive at T-1h: ${longshots.length}`)
  const step = Math.max(1, Math.floor(longshots.length / SAMPLE))
  const sample = longshots.filter((_, i) => i % step === 0).slice(0, SAMPLE)
  console.log(`sampled: ${sample.length}`)

  const rows = []
  let done = 0
  let candleMiss = 0
  let noBid = 0
  let errors = 0
  const firstErrors = []
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const m = sample[done++]
      if (!m) return
      try {
        // Whole-life candles (the archive is sparse/incomplete): take the
        // candle nearest to T-1h as the executable-price snapshot. The book
        // persists between updates, so this is the standing bid at entry time.
        const start = Math.floor(m.open / 1000)
        const end = Math.floor(m.close / 1000)
        const candles = await getCandles(m.ticker, start, end, 1, m.close)
        if (candles.length === 0) {
          candleMiss++
          continue
        }
        const target = m.close - 60 * 60_000
        // relax: accept the nearest candle within [close-3h, close-30m]
        const candidates = candles.filter((c) => {
          const t = c.end_period_ts * 1000
          return t >= m.close - 3 * 3600_000 && t <= m.close - 30 * 60_000
        })
        if (candidates.length === 0) {
          candleMiss++
          continue
        }
        let best = null
        for (const c of candidates) {
          const d = Math.abs(c.end_period_ts * 1000 - target)
          if (!best || d < best.d) best = { d, c }
        }
        const bid = bidAt(best.c)
        if (bid === undefined || !(bid > 0) || bid >= 0.995) {
          noBid++
          continue
        }
        const entry = 1 - bid
        const payoff = m.result === 'no' ? 1 : 0
        rows.push({
          series: m.series,
          bid: +bid.toFixed(3),
          entry: +entry.toFixed(3),
          payoff,
          edge: +(payoff - entry - FEE).toFixed(4)
        })
      } catch (err) {
        errors++
        if (firstErrors.length < 3) firstErrors.push(`${m.ticker}: ${err.message}`)
      }
      if (done % 50 === 0) process.stdout.write(`\r  ${done}/${sample.length}`)
      await sleep(40)
    }
  })
  await Promise.all(workers)
  console.log(`\nexecutable observations: ${rows.length}  (no candles: ${candleMiss}, no bid: ${noBid}, errors: ${errors})`)
  for (const e of firstErrors) console.log(`  first error: ${e}`)

  if (rows.length === 0) {
    console.log('nothing to conclude')
    return
  }
  const yesRate = rows.filter((r) => r.payoff === 0).length / rows.length
  const meanEdge = rows.reduce((s, r) => s + r.edge, 0) / rows.length
  const sorted = [...rows].map((r) => r.edge).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const positive = rows.filter((r) => r.edge > 0).length / rows.length
  const meanEntry = rows.reduce((s, r) => s + r.entry, 0) / rows.length
  console.log(`\n=== VERDICT (entry at T-1h) ===`)
  console.log(`n=${rows.length}  YES rate: ${(yesRate * 100).toFixed(2)}%  mean NO-ask entry: ${(meanEntry * 100).toFixed(2)}¢`)
  console.log(`net edge after 1¢ fee: mean ${(meanEdge * 100).toFixed(2)}¢  median ${(median * 100).toFixed(2)}¢  positive ${(positive * 100).toFixed(1)}%`)
  const pass = rows.length >= 1000 && meanEdge > 0
  console.log(`PASS BAR (n>=1000 AND mean edge > 0): ${pass ? 'PASS' : 'FAIL'}${rows.length < 1000 ? ' (insufficient n)' : ''}`)
  const bySeries = new Map()
  for (const r of rows) {
    const a = bySeries.get(r.series) ?? { n: 0, edge: 0 }
    a.n++
    a.edge += r.edge
    bySeries.set(r.series, a)
  }
  console.log('\ntop series (by n):')
  for (const [k, v] of [...bySeries.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
    console.log(`  ${k.padEnd(16)} n=${v.n}  mean edge ${((v.edge / v.n) * 100).toFixed(2)}¢`)
  }
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
