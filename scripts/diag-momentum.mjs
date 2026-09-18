// Debug #2: are candles dense for liquid settled markets? Replay the exact
// momentum loop on a handful and print what happens.
// Run: node scripts/diag-momentum.mjs
import { buildPool, getCandles, priceAt } from './lib/hist.mjs'

const WINDOW_MIN = 10
const THRESHOLD = 0.03

async function main() {
  const pool = await buildPool({ livePages: 8, historicalPages: 8 })
  const cutoff = Date.parse('2026-06-28T00:00:00Z')
  const liquid = pool
    .filter((m) => m.close >= cutoff && m.volume > 500 && m.close - m.open >= 120 * 60_000)
    .slice(0, 6)
  console.log('liquid recent settled targets:')
  for (const m of liquid) console.log(`  ${m.ticker}  vol=${m.volume}  life=${Math.round((m.close - m.open) / 3600000)}h`)

  for (const m of liquid) {
    const candles = await getCandles(m.ticker, Math.floor(m.open / 1000), Math.floor(m.close / 1000), 1, m.close)
    const series = candles.map((c) => ({ t: c.end_period_ts * 1000, p: priceAt(c) })).filter((x) => x.p !== undefined)
    console.log(`\n${m.ticker}: candles=${candles.length} valid prices=${series.length}`)
    if (series.length < 2) continue
    console.log(`  first: t=${new Date(series[0].t).toISOString().slice(11, 16)} p=${series[0].p.toFixed(3)}  last: t=${new Date(series[series.length - 1].t).toISOString().slice(11, 16)} p=${series[series.length - 1].p.toFixed(3)}`)
    console.log(`  spacing sample: ${series.slice(1, 6).map((x) => Math.round((x.t - series[0].t) / 60000) + 'm').join(' ')}`)
    let evals = 0
    let fires = 0
    for (let i = 0; i < series.length; i += 5) {
      const t = series[i]
      if (t.t > m.close - 45 * 60_000) break
      const back = series.find((x) => Math.abs(x.t - (t.t - WINDOW_MIN * 60_000)) < 60_000)
      if (!back) continue
      evals++
      if (Math.abs(t.p - back.p) >= THRESHOLD) {
        fires++
        if (fires <= 3) console.log(`  FIRE at ${new Date(t.t).toISOString().slice(11, 16)}: ${back.p.toFixed(3)} -> ${t.p.toFixed(3)}`)
      }
    }
    console.log(`  evaluations: ${evals}  fires: ${fires}`)
  }
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
