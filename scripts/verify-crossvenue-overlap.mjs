// Experiment (f): Cross-venue overlap discovery.
// Runs the production matcher (assetOf + Jaccard >= 0.3 + close-time within
// 35 min) over the current short-term Kalshi universe and reports coverage:
// what fraction of Kalshi markets have a Polymarket Gamma counterpart, and
// why the misses fail. Pass bar: >= 5% coverage before lead-lag is testable.
//
// Run: node scripts/verify-crossvenue-overlap.mjs
const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
const GAMMA = 'https://gamma-api.polymarket.com'
const MIN_SIM = 0.3
const CLOSE_WINDOW_MS = 35 * 60_000

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}
const STOP = new Set(['a','an','the','will','be','is','are','was','were','in','on','of','to','for','by','with','at','from','and','or','who','what','which','when','how','do','does','did','this','that','it','he','she','they','we','you','i','me','my','vs','its','his','her','their','about','before','after','up','down','above','below','next','price','minutes','minute','today','after'])
const stem = (w) => (/^[a-z]{4,}s$/.test(w) ? w.slice(0, -1) : w)
const norm = (q) => [...new Set(q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).map(stem))]
const jaccard = (a, b) => {
  const sa = new Set(a), sb = new Set(b)
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  const union = new Set([...sa, ...sb]).size
  return union === 0 ? 0 : inter / union
}
const ASSETS = ['bitcoin','btc','ethereum','eth','xrp','ripple','solana','sol','dogecoin','doge','cardano','ada','binance','bnb','gold','silver','copper','oil','wti','natural gas','nasdaq','s&p','dow jones']
const assetOf = (q) => {
  const t = q.toLowerCase()
  for (const a of ASSETS) {
    const re = new RegExp(`(^|[^a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i')
    if (re.test(t)) return a
  }
  return undefined
}
const titleTokens = (m) => norm((m.title ?? '').split(' · ')[0])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const now = Math.floor(Date.now() / 1000)
  // Kalshi universe (mirror verify-kalshi-auto.mjs)
  const seen = new Set()
  const raw = []
  for (const mins of [15, 60, 180, 360, 720, 1440, 7 * 1440, 30 * 1440]) {
    const res = await (await fetch(`${BASE}/markets?status=open&max_close_ts=${now + mins * 60}&mve_filter=exclude&limit=1000`)).json()
    for (const m of res.markets ?? []) if (m.ticker && !seen.has(m.ticker)) { seen.add(m.ticker); raw.push(m) }
  }
  const uni = raw
    .filter((m) => {
      if (m.market_type !== 'binary') return false
      const p = num(m.last_price_dollars)
      if (p <= 0.01 || p >= 0.99) return false
      const close = m.close_time ? Date.parse(m.close_time) : 0
      const mins = (close - Date.now()) / 60000
      if (mins < 15 || mins > 1440) return false
      return true
    })
    .sort((a, b) => num(b.volume_24h_fp) - num(a.volume_24h_fp))
    .slice(0, 40)
  console.log(`Kalshi short-term universe: ${uni.length} markets\n`)

  const misses = { noAsset: 0, noGammaResults: 0, simFail: 0, timeFail: 0 }
  const matches = []
  for (const m of uni) {
    const asset = assetOf((m.title ?? '') + ' ' + (m.yes_sub_title ?? ''))
    if (!asset) {
      misses.noAsset++
      console.log(`✗ ${m.ticker}  (no asset keyword) ${(m.title ?? '').slice(0, 50)}`)
      continue
    }
    let polyMarkets = []
    try {
      const r = await fetch(`${GAMMA}/public-search?q=${encodeURIComponent(asset)}&limit_pagination=true`)
      const data = await r.json()
      for (const ev of data.events ?? []) polyMarkets.push(...(ev.markets ?? []))
    } catch {
      polyMarkets = []
    }
    if (polyMarkets.length === 0) {
      misses.noGammaResults++
      console.log(`✗ ${m.ticker}  (no Gamma results for "${asset}")`)
      await sleep(150)
      continue
    }
    const kTokens = titleTokens(m)
    const kClose = m.close_time ? Date.parse(m.close_time) : 0
    let best = null
    let bestTimeGap = Infinity
    for (const pm of polyMarkets) {
      const pClose = pm.endDate ? Date.parse(pm.endDate) : 0
      const sim = jaccard(kTokens, norm(pm.question ?? pm.title ?? ''))
      if (sim >= MIN_SIM && kClose && pClose && Math.abs(kClose - pClose) <= CLOSE_WINDOW_MS) {
        if (!best || sim > best.sim) best = { sim, q: pm.question ?? pm.title, end: pm.endDate }
      } else if (sim >= MIN_SIM) {
        bestTimeGap = Math.min(bestTimeGap, Math.abs(kClose - pClose))
      }
    }
    if (best) {
      matches.push({ ticker: m.ticker, q: best.q, sim: best.sim, end: best.end })
      console.log(`✓ ${m.ticker}  sim ${best.sim.toFixed(2)} → ${best.q.slice(0, 60)} (${best.end})`)
    } else {
      const why = bestTimeGap !== Infinity ? `timeFail (nearest ${(bestTimeGap / 3600000).toFixed(1)}h)` : 'simFail'
      misses[why === 'timeFail (nearest ' + (bestTimeGap / 3600000).toFixed(1) + 'h)' ? 'timeFail' : 'simFail']++
      console.log(`✗ ${m.ticker}  (${why}) ${(m.title ?? '').slice(0, 50)}`)
    }
    await sleep(150)
  }

  const coverage = matches.length / uni.length
  console.log(`\n=== VERDICT ===`)
  console.log(`coverage: ${matches.length}/${uni.length} = ${(coverage * 100).toFixed(1)}%`)
  console.log(`miss reasons — noAsset ${misses.noAsset}, noGammaResults ${misses.noGammaResults}, simFail ${misses.simFail}, timeFail ${misses.timeFail}`)
  console.log(`PASS BAR (>= 5% coverage): ${coverage >= 0.05 ? 'PASS (lead-lag test worth running)' : 'FAIL (cross-venue not viable — disable)'}`)
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
