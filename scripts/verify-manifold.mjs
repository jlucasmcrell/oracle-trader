// Mirrors ManifoldAdapter.searchMarkets and prints what the scanner shows.
const BASE = 'https://api.manifold.markets'
const sortMap = {
  liquidity: 'liquidity',
  volume: '24-hour-vol',
  'prob-descending': 'prob-descending',
  'ending-soon': 'close-date',
  newest: 'newest'
}
const fmt = (t) => {
  if (!t) return 'n/a'
  const d = (t - Date.now()) / 86400000
  if (d < 0) return 'closed'
  if (d < 60) return Math.round(d) + 'd'
  return new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

async function searchMarkets(sort) {
  const s = sortMap[sort] ?? 'liquidity'
  const res = await (await fetch(`${BASE}/v0/search-markets?limit=200&filter=open&sort=${s}`)).json()
  return (Array.isArray(res) ? res : []).map((m) => ({
    q: m.question,
    p: m.probability,
    close: m.closeTime ?? null,
    liq: m.totalLiquidity,
    v24: m.volume24Hours,
    group: m.groupSlugs?.[0] ?? m.groupId
  }))
}

async function main() {
  for (const sort of ['liquidity', 'ending-soon']) {
    const mk = await searchMarkets(sort)
    console.log(`\n=== Manifold sort "${sort}" (top 20 of ${mk.length}) ===`)
    for (const m of mk.slice(0, 20)) {
      const p = m.p !== undefined && m.p !== null ? (m.p * 100).toFixed(0).padStart(3) + '%' : ' — '
      console.log(`  ${p}  ⏱ ${fmt(m.close).padEnd(10)}  liq ${(m.liq ?? 0).toFixed(0).padStart(7)} | ${(m.q || '').slice(0, 55)}`)
    }
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
