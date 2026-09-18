// Mirrors the NEW PolymarketAdapter.searchMarkets and prints what the scanner shows.
const GAMMA = 'https://gamma-api.polymarket.com'
const parse = (v) => { try { return JSON.parse(v || '[]') } catch { return [] } }
const fmt = (t) => {
  if (!t) return 'n/a'
  const d = (Date.parse(t) - Date.now()) / 86400000
  if (d < 0) return 'closed'
  if (d < 60) return Math.round(d) + 'd'
  return new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

async function searchMarkets(sort) {
  const order = sort === 'ending-soon' ? 'endDate' : sort === 'newest' ? 'createdAt' : 'volume24hr'
  const ascending = sort === 'ending-soon'
  const extra = sort === 'ending-soon' ? '&end_date_min=' + encodeURIComponent(new Date().toISOString()) : ''
  const res = await (await fetch(`${GAMMA}/markets?active=true&closed=false&limit=200&order=${order}&ascending=${ascending}${extra}`)).json()
  let markets = res.filter((m) => !m.endDate || Date.parse(m.endDate) >= Date.now())
  const byEvent = new Map()
  for (const m of markets) {
    const key = m.events?.[0]?.slug ?? m.slug ?? m.id
    const arr = byEvent.get(key) ?? []
    arr.push(m)
    byEvent.set(key, arr)
  }
  const grouped = []
  for (const arr of byEvent.values()) {
    arr.sort((a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0))
    grouped.push(...arr.slice(0, 3))
  }
  const out = grouped.map((m) => ({
    q: m.question,
    p: parseFloat(parse(m.outcomePrices)[0]),
    close: m.endDate,
    liq: m.liquidityNum,
    v24: m.volume24hr,
    created: m.createdAt
  }))
  const arr = [...out]
  switch (sort) {
    case 'volume': return arr.sort((a, b) => (b.v24 ?? 0) - (a.v24 ?? 0))
    case 'prob-descending': return arr.sort((a, b) => (b.p ?? 0) - (a.p ?? 0))
    case 'ending-soon': return arr.sort((a, b) => Date.parse(a.close) - Date.parse(b.close))
    case 'newest': return arr.sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
    default: return arr.sort((a, b) => (b.liq ?? 0) - (a.liq ?? 0))
  }
}

async function main() {
  for (const sort of ['liquidity', 'ending-soon']) {
    const mk = await searchMarkets(sort)
    console.log(`\n=== Polymarket sort "${sort}" (top 20 of ${mk.length}) ===`)
    for (const m of mk.slice(0, 20)) {
      const p = Number.isFinite(m.p) ? (m.p * 100).toFixed(0).padStart(3) + '%' : ' — '
      console.log(`  ${p}  ⏱ ${fmt(m.close).padEnd(10)}  liq ${(m.liq / 1000).toFixed(0).padStart(6)}k | ${m.q.slice(0, 55)}`)
    }
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
