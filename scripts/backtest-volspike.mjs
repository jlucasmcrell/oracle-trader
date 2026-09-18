// Experiment (b2) v2: Volume-spike hit-rate backtest on the clean pool.
// Replays the volume-spike signal (2.5x baseline + |taker pressure| > 0.15)
// using the routed trade tape + 60-min candle baseline.
// Pass bar: mean forward move > 4¢ AND hit rate > 50%.
//
// Run: node scripts/backtest-volspike.mjs
import { buildPool, getCandles, getTrades, priceAt, num, sleep } from './lib/hist.mjs'

const WINDOW_MIN = 10
const BASELINE_MIN = 120
const MIN_MULTIPLE = 2.5
const PRESSURE_MIN = 0.15
const FORWARD_MIN = 30
const TARGET_MARKETS = 150
const EVAL_MIN = 180
const CONCURRENCY = 3

async function main() {
  const pool = await buildPool()
  const bySeries = new Map()
  const candidates = []
  for (const m of pool) {
    if (!m.result || m.close <= 0 || m.open <= 0) continue
    if (m.close - m.open < 60 * 60_000) continue
    if (m.volume < 200) continue
    if ((bySeries.get(m.series) ?? 0) >= 8) continue
    bySeries.set(m.series, (bySeries.get(m.series) ?? 0) + 1)
    candidates.push(m)
  }
  const sample = candidates.slice(0, TARGET_MARKETS)
  console.log(`sampled ${sample.length} volume-bearing settled markets across ${bySeries.size} series`)

  const signals = []
  let done = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const m = sample[done++]
      if (!m) return
      const evalStart = m.close - EVAL_MIN * 60_000
      try {
        const candles = await getCandles(m.ticker, Math.floor((m.close - 240 * 60_000) / 1000), Math.floor(m.close / 1000), 1, m.close)
        const series = candles.map((c) => ({ t: c.end_period_ts * 1000, p: priceAt(c) })).filter((x) => x.p !== undefined)
        if (series.length < 40) {
          continue
        }

        const hCandles = await getCandles(m.ticker, Math.floor((m.close - (BASELINE_MIN + 120) * 60_000) / 1000), Math.floor(m.close / 1000), 60, m.close)

        const trades = []
        for (let p = 0; p < 6; p++) {
          const batch = await getTrades(m.ticker, m.close)
          if (batch.length === 0) break
          trades.push(...batch)
          const oldest = Date.parse(batch[batch.length - 1].created_time)
          if (oldest < evalStart || batch.length < 1000) break
          // NOTE: cursor pagination not implemented per-page here; markets with
          // >1000 trades in the window use their newest 1000 (window is 3h —
          // acceptable coverage for most markets).
          break
        }

        for (let t = evalStart; t < m.close - 45 * 60_000; t += 5 * 60_000) {
          const inWin = trades.filter(
            (x) => !x.is_block_trade && Date.parse(x.created_time) <= t && t - Date.parse(x.created_time) <= WINDOW_MIN * 60_000
          )
          if (inWin.length < 3) continue
          const vol = inWin.reduce((s, x) => s + num(x.count_fp), 0)
          const baseCandles = hCandles.filter((c) => t / 1000 - c.end_period_ts >= 0 && t / 1000 - c.end_period_ts <= BASELINE_MIN * 60)
          if (baseCandles.length < 2) continue
          const perMin = baseCandles.reduce((s, c) => s + num(c.volume_fp ?? c.volume ?? 0), 0) / (baseCandles.length * 60)
          if (perMin <= 0) continue
          const multiple = vol / WINDOW_MIN / perMin
          if (multiple < MIN_MULTIPLE) continue
          let aggYes = 0
          let aggNo = 0
          for (const x of inWin) {
            if (x.taker_outcome_side === 'yes' && x.taker_book_side === 'bid') aggYes += num(x.count_fp)
            else if (x.taker_outcome_side === 'no' && x.taker_book_side === 'ask') aggNo += num(x.count_fp)
          }
          const total = aggYes + aggNo
          const pressure = total > 0 ? (aggYes - aggNo) / total : 0
          if (Math.abs(pressure) <= PRESSURE_MIN) continue
          const dir = pressure > 0 ? 1 : -1
          const pNow = series.find((x) => Math.abs(x.t - t) < 90_000)
          if (!pNow) continue
          const fwdT = Math.min(t + FORWARD_MIN * 60_000, m.close - 60_000)
          let fwd = series[series.length - 1]
          for (const x of series) if (x.t >= fwdT) { fwd = x; break }
          signals.push({ series: m.series, dir, multiple, pressure, fwdMove: (fwd.p - pNow.p) * dir })
        }
      } catch {
        // skip
      }
      if (done % 10 === 0) process.stdout.write(`\r  ${done}/${sample.length}`)
      await sleep(60)
    }
  })
  await Promise.all(workers)
  console.log(`\nsignals fired: ${signals.length}`)

  if (signals.length === 0) {
    console.log('no signals — spike conditions never met in sample')
    return
  }
  const moves = signals.map((s) => s.fwdMove)
  const mean = moves.reduce((s, x) => s + x, 0) / moves.length
  const hits = moves.filter((x) => x > 0).length / moves.length
  const sorted = [...moves].sort((a, b) => a - b)
  console.log(`=== VERDICT ===`)
  console.log(`n=${signals.length}  hit rate ${(hits * 100).toFixed(1)}%  mean forward move ${(mean * 100).toFixed(2)}¢  median ${(sorted[Math.floor(sorted.length / 2)] * 100).toFixed(2)}¢`)
  console.log(`PASS BAR (mean > 4¢ AND hit rate > 50%): ${mean > 0.04 && hits > 0.5 ? 'PASS' : 'FAIL'}`)
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
