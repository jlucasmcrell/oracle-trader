// Experiment (c) v2: Dutch-book frequency + realized arb on the clean pool.
// Groups settled markets by event_ticker, keeps mutually_exclusive events
// (flag from /events/{ticker}), reconstructs Σbids(t) from 1-min candles and
// measures excursion frequency, duration, and realized arb of buying NO on
// all legs at the first qualifying minute.
//
// Pass bar: >= 1 qualifying event/day AND arb > 0 on >= 80% of executions.
// Run: node scripts/backtest-dutch.mjs
import { buildPool, getCandles, bidAt, sleep } from './lib/hist.mjs'

const MIN_OVER = 1.03
const MAX_LEGS = 6
const EVAL_HOURS = 12
const MAX_EVENTS = 200
const CONCURRENCY = 3

async function main() {
  const pool = await buildPool()
  const byEvent = new Map()
  for (const m of pool) {
    if (!m.eventTicker || !m.result) continue
    const ev = byEvent.get(m.eventTicker) ?? { legs: [] }
    ev.legs.push(m)
    byEvent.set(m.eventTicker, ev)
  }
  const candidates = [...byEvent.entries()].filter(([, e]) => e.legs.length >= 2 && e.legs.length <= MAX_LEGS)
  console.log(`events with 2-${MAX_LEGS} settled binary legs: ${candidates.length}`)
  const sample = candidates.slice(0, MAX_EVENTS)

  // mutually_exclusive flag per event
  const qualifying = []
  let done = 0
  const flagWorkers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const item = sample[done++]
      if (!item) return
      const [eventTicker, ev] = item
      try {
        const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/events/${encodeURIComponent(eventTicker)}`)
        if (!r.ok) continue
        const data = await r.json()
        if (data.event?.mutually_exclusive === true) qualifying.push({ eventTicker, legs: ev.legs })
      } catch {
        // skip
      }
      await sleep(25)
    }
  })
  await Promise.all(flagWorkers)
  console.log(`mutually_exclusive events in sample: ${qualifying.length}`)

  const results = []
  done = 0
  const candleWorkers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const ev = qualifying[done++]
      if (!ev) return
      try {
        const legSeries = []
        for (const leg of ev.legs) {
          const startSec = Math.floor(Math.max(leg.open, leg.close - EVAL_HOURS * 3600_000) / 1000)
          const endSec = Math.floor(leg.close / 1000)
          const candles = await getCandles(leg.ticker, startSec, endSec, 1, leg.close)
          const bids = candles
            .map((c) => ({ t: c.end_period_ts, b: bidAt(c) }))
            .filter((x) => x.b !== undefined)
          if (bids.length === 0) throw new Error('no bid candles')
          legSeries.push({ ticker: leg.ticker, result: leg.result, bids })
        }
        const timeSet = new Set()
        for (const ls of legSeries) for (const b of ls.bids) timeSet.add(b.t)
        const times = [...timeSet].sort((a, b) => a - b)
        let excursion = null
        const record = (last) => {
          const legCount = excursion.legs.length
          const cost = excursion.legs.reduce((acc, l) => acc + (1 - l.bid), 0)
          const yesCount = excursion.legs.filter((l) => l.result === 'yes').length
          const payoff = legCount - yesCount
          results.push({
            event: ev.eventTicker,
            durationMin: Math.floor(((last ?? excursion.start) - excursion.start) / 60),
            peakSum: +excursion.sum.toFixed(3),
            cost: +cost.toFixed(3),
            payoff,
            profit: +(payoff - cost - legCount * 0.01).toFixed(4)
          })
        }
        for (const t of times) {
          let s = 0
          let ok = true
          for (const ls of legSeries) {
            const b = ls.bids.find((x) => x.t === t)
            if (!b) {
              ok = false
              break
            }
            s += b.b
          }
          if (!ok) continue
          if (s > MIN_OVER) {
            if (!excursion) {
              excursion = {
                start: t,
                sum: s,
                legs: legSeries.map((ls) => ({ ticker: ls.ticker, result: ls.result, bid: ls.bids.find((x) => x.t === t)?.b ?? 0 }))
              }
            } else {
              excursion.sum = Math.max(excursion.sum, s)
            }
          } else if (excursion) {
            record(t)
            excursion = null
          }
        }
        if (excursion) record(undefined)
      } catch {
        // skip event
      }
      if (done % 10 === 0) process.stdout.write(`\r  ${done}/${qualifying.length}`)
      await sleep(40)
    }
  })
  await Promise.all(candleWorkers)
  console.log(`\nqualifying excursions (Σbids > ${MIN_OVER}): ${results.length} across ${qualifying.length} mutually_exclusive events`)

  if (results.length === 0) {
    console.log('=== VERDICT: FAIL (no qualifying excursions in sample) ===')
    return
  }
  const meanDur = results.reduce((s, r) => s + r.durationMin, 0) / results.length
  const meanProfit = results.reduce((s, r) => s + r.profit, 0) / results.length
  const positive = results.filter((r) => r.profit > 0).length / results.length
  const executable = results.filter((r) => r.durationMin >= 2).length / results.length
  console.log(`mean excursion ${meanDur.toFixed(1)} min · ≥2min ${(executable * 100).toFixed(0)}% · mean profit ${(meanProfit * 100).toFixed(1)}¢ · positive ${(positive * 100).toFixed(0)}%`)
  console.log('top excursions:')
  for (const r of [...results].sort((a, b) => b.profit - a.profit).slice(0, 8)) {
    console.log(`  ${r.event}  dur ${r.durationMin}min  Σ=${r.peakSum}  cost ${r.cost.toFixed(2)}  payoff ${r.payoff}  profit ${(r.profit * 100).toFixed(1)}¢`)
  }
  const eventsPerDay = qualifying.length / 90
  console.log(`\nmutually_exclusive events/day ≈ ${eventsPerDay.toFixed(2)} (${qualifying.length} in ~90-day window, sample-capped)`)
  const pass = eventsPerDay >= 1 && positive >= 0.8 && executable >= 0.8
  console.log(`PASS BAR (>=1 event/day AND >=80% positive AND >=80% executable): ${pass ? 'PASS' : 'FAIL'}`)
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
