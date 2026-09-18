// Live verification of the favorite-longshot bias on Kalshi historical data.
// Pulls settled binary markets from GET /historical/markets, buckets them by
// their last traded YES price, and prints the empirical resolution rate per
// bucket vs the price. If a low-price bucket resolves YES materially less
// often than its price, buying NO there is net-positive (before spread/fees).
//
// Run: node scripts/verify-kalshi-fade.mjs
const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
const BUCKETS = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95, 0.98, 1.01]

async function main() {
  const buckets = BUCKETS.map(() => ({ n: 0, yes: 0 }))
  let cursor = undefined
  let total = 0
  let settled = 0
  const deadline = Date.now() + 6 * 60_000 // 6 minutes hard cap
  for (let page = 0; page < 12 && Date.now() < deadline; page++) {
    const path =
      `/historical/markets?limit=1000` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
    let res
    try {
      const r = await fetch(BASE + path)
      if (!r.ok) {
        console.error(`HTTP ${r.status} on page ${page}: ${(await r.text()).slice(0, 200)}`)
        break
      }
      res = await r.json()
    } catch (err) {
      console.error(`fetch error page ${page}: ${err.message}`)
      break
    }
    const markets = res.markets ?? []
    total += markets.length
    if (markets.length === 0) break
    for (const m of markets) {
      const type = m.market_type
      if (type !== 'binary') continue
      const result = m.result
      if (result !== 'yes' && result !== 'no') continue
      const last = parseFloat(m.last_price_dollars ?? '')
      if (!Number.isFinite(last) || last <= 0 || last >= 1) continue
      settled++
      const bi = BUCKETS.findIndex((b) => last < b)
      if (bi < 0) continue
      buckets[bi].n++
      if (result === 'yes') buckets[bi].yes++
    }
    cursor = res.cursor
    if (!cursor) break
  }

  console.log(`scanned ${total} historical markets, ${settled} settled binaries usable\n`)
  console.log('price bucket | n      | P(YES) empirical | implied | bias (emp-implied)')
  for (let i = 0; i < BUCKETS.length - 1; i++) {
    const b = buckets[i]
    if (b.n === 0) continue
    const lo = BUCKETS[i]
    const hi = BUCKETS[i + 1]
    const mid = (lo + hi) / 2
    const emp = b.yes / b.n
    console.log(
      `${lo.toFixed(2)}–${hi.toFixed(2)} | ${String(b.n).padEnd(6)} | ${(emp * 100).toFixed(1).padStart(5)}%        | ${(mid * 100).toFixed(1).padStart(5)}%   | ${((emp - mid) * 100).toFixed(1)}`
    )
  }
  // Bottom line for the longshot fade: does buying NO at p<0.10 pay?
  const long = buckets.slice(0, 2) // 0.02-0.05, 0.05-0.10
  const n = long.reduce((s, b) => s + b.n, 0)
  const yes = long.reduce((s, b) => s + b.yes, 0)
  if (n > 0) {
    const avgPrice = 0.06
    const noBuyCost = 1 - avgPrice
    const payoff = yes / n // fraction that resolved YES (NO loses)
    const noEdge = (1 - payoff) - noBuyCost
    console.log(`\nlongshot bucket p∈[0.02,0.10]: n=${n}, YES rate=${((yes / n) * 100).toFixed(1)}%`)
    console.log(`buying NO at ~${(avgPrice * 100).toFixed(0)}¢: gross edge ≈ ${(noEdge * 100).toFixed(1)}¢/contract (before spread+fee)`)
  }
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
