// Mirrors the NEW docs-correct KalshiAdapter.searchMarkets.
const B = 'https://api.elections.kalshi.com/trade-api/v2'
const toNum = (v) => (v === undefined || v === null ? 0 : typeof v === 'number' ? v : parseFloat(v))
const fmt = (t) => {
  if (!t) return 'n/a'
  const ms = Date.parse(t) - Date.now()
  if (ms < 0) return 'closed'
  const d = ms / 86400000
  if (d < 60) return Math.round(d) + 'd'
  return new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

async function searchMarkets(sort, category) {
  const now = Math.floor(Date.now() / 1000)
  const seen = new Set()
  const collected = []
  const append = (markets) => {
    for (const m of markets) {
      if (m.ticker && !seen.has(m.ticker)) { seen.add(m.ticker); collected.push(m) }
    }
  }
  if (category) {
    const sr = await (await fetch(`${B}/series?category=${encodeURIComponent(category)}&include_volume=true`)).json()
    const topSeries = (sr.series ?? []).sort((a, b) => toNum(b.volume_fp) - toNum(a.volume_fp)).slice(0, 10)
    for (const s of topSeries) {
      if (!s.ticker) continue
      try {
        const r = await (await fetch(`${B}/markets?series_ticker=${encodeURIComponent(s.ticker)}&status=open&mve_filter=exclude&limit=10`)).json()
        append(r.markets ?? [])
      } catch {}
    }
  } else if (sort === 'ending-soon') {
    for (const mins of [15, 60, 180, 360, 720, 1440, 7 * 1440, 30 * 1440, 180 * 1440]) {
      try {
        const r = await (await fetch(`${B}/markets?status=open&max_close_ts=${now + mins * 60}&mve_filter=exclude&limit=1000`)).json()
        append(r.markets ?? [])
      } catch {}
    }
  } else {
    const r = await (await fetch(`${B}/markets?status=open&max_close_ts=${now + 180 * 86400}&mve_filter=exclude&limit=1000`)).json()
    append(r.markets ?? [])
  }
  const raw = collected
  const bySeries = new Map()
  for (const m of raw) {
    const key = (m.ticker ?? '').split(/-\d/)[0] || m.event_ticker || m.ticker || ''
    const arr = bySeries.get(key) ?? []
    arr.push(m)
    bySeries.set(key, arr)
  }
  const grouped = []
  for (const arr of bySeries.values()) {
    arr.sort((a, b) => toNum(b.volume_24h_fp) - toNum(a.volume_24h_fp))
    grouped.push(...arr.slice(0, 3))
  }
  const out = grouped
    .filter((m) => toNum(m.last_price_dollars) > 0 || toNum(m.volume_fp) > 0)
    .map((m) => ({
      q: (m.title || '') + (m.yes_sub_title && !(m.title || '').includes(m.yes_sub_title) ? ` · ${m.yes_sub_title}` : ''),
      p: toNum(m.last_price_dollars),
      close: m.close_time,
      v24: toNum(m.volume_24h_fp)
    }))
  const arr = [...out]
  if (sort === 'ending-soon') return arr.sort((a, b) => Date.parse(a.close) - Date.parse(b.close))
  if (sort === 'prob-descending') return arr.sort((a, b) => b.p - a.p)
  return arr.sort((a, b) => b.v24 - a.v24)
}

async function main() {
  const soon = await searchMarkets('ending-soon')
  console.log(`=== Ending soon (docs-correct) — ${soon.length} entries (top 25) ===`)
  for (const m of soon.slice(0, 25)) {
    console.log(`  ${(m.p * 100).toFixed(0).padStart(3)}%  ⏱ ${fmt(m.close).padEnd(10)}  vol24h ${m.v24.toFixed(0).padStart(6)} | ${(m.q || '').slice(0, 52)}`)
  }
  const vol = await searchMarkets('liquidity')
  console.log(`\n=== Default (docs-correct) — ${vol.length} entries (top 10) ===`)
  for (const m of vol.slice(0, 10)) {
    console.log(`  ${(m.p * 100).toFixed(0).padStart(3)}%  ⏱ ${fmt(m.close).padEnd(10)}  vol24h ${m.v24.toFixed(0).padStart(6)} | ${(m.q || '').slice(0, 52)}`)
  }
  const econ = await searchMarkets('liquidity', 'Economics')
  console.log(`\n=== Category "Economics" — ${econ.length} entries (top 12) ===`)
  for (const m of econ.slice(0, 12)) {
    console.log(`  ${(m.p * 100).toFixed(0).padStart(3)}%  ⏱ ${fmt(m.close).padEnd(10)}  vol24h ${m.v24.toFixed(0).padStart(6)} | ${(m.q || '').slice(0, 52)}`)
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
