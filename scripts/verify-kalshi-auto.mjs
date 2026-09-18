// Live verification of the Kalshi AutoTrader signal pipeline — mirrors
// src/main/strategies/autoTrader.ts against the real API (public endpoints,
// no auth, no orders). Prints the universe, per-signal candidates with scores,
// and what the rules gate would approve.
//
// Run: node scripts/verify-kalshi-auto.mjs
const BASE = 'https://api.elections.kalshi.com/trade-api/v2'
const GAMMA = 'https://gamma-api.polymarket.com'

// ---- defaults mirroring DEFAULT_CONFIG in autoTrader.ts ----
const CFG = {
  minMinutesToClose: 15,
  maxMinutesToClose: 1440,
  maxMarketsPerScan: 40,
  minVolume: 20,
  minLiquidity: 150,
  maxSpreadPct: 0.04,
  minPrice: 0.05,
  maxPrice: 0.95,
  minScore: 55,
  momentumEnabled: true,
  momentumWindowMinutes: 10,
  momentumMinMovePct: 0.03,
  volumeSpikeEnabled: true,
  volumeSpikeWindowMinutes: 10,
  volumeSpikeBaselineMinutes: 120,
  volumeSpikeMinMultiple: 2.5,
  bookEnabled: true,
  bookMinRatio: 1.6,
  bookMinDepth: 300,
  crossVenueEnabled: true,
  crossVenueMinGapPct: 0.06,
  crossVenueMinSimilarity: 0.3,
  dutchEnabled: true,
  dutchMinOverSum: 0.03,
  dutchMaxLegs: 6,
  fadeEnabled: false
}

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}
const clamp01 = (v) => Math.min(0.99, Math.max(0.01, v))
const round2 = (v) => Math.round(v * 100) / 100

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

async function main() {
  const now = Math.floor(Date.now() / 1000)
  console.log(`=== Kalshi AutoTrader live verification @ ${new Date().toISOString()} ===\n`)

  // ---- universe (ending-soon buckets, like searchMarkets) ----
  const seen = new Set()
  const raw = []
  for (const mins of [15, 60, 180, 360, 720, 1440, 7 * 1440, 30 * 1440, 180 * 1440]) {
    try {
      const res = await (await fetch(`${BASE}/markets?status=open&max_close_ts=${now + mins * 60}&mve_filter=exclude&limit=1000`)).json()
      for (const m of res.markets ?? []) {
        if (m.ticker && !seen.has(m.ticker)) {
          seen.add(m.ticker)
          raw.push(m)
        }
      }
    } catch (e) {
      console.log('bucket fetch error', e.message)
    }
  }
  console.log(`raw open markets fetched: ${raw.length}`)

  const uni = raw
    .filter((m) => {
      if (m.market_type !== 'binary') return false
      const p = num(m.last_price_dollars)
      if (p <= 0.01 || p >= 0.99) return false
      const close = m.close_time ? Date.parse(m.close_time) : 0
      const mins = (close - Date.now()) / 60000
      if (mins < CFG.minMinutesToClose || mins > CFG.maxMinutesToClose) return false
      if (num(m.volume_fp) < CFG.minVolume) return false
      const liq = num(m.yes_bid_size_fp) * num(m.yes_bid_dollars) + num(m.no_bid_size_fp) * num(m.no_bid_dollars)
      if (liq < CFG.minLiquidity) return false
      const spread = num(m.yes_bid_dollars) > 0 && num(m.yes_ask_dollars) > 0 ? num(m.yes_ask_dollars) - num(m.yes_bid_dollars) : num(m.no_ask_dollars) - num(m.no_bid_dollars)
      if (!(spread > 0) || spread > CFG.maxSpreadPct) return false
      m.__liq = liq
      m.__spread = spread
      return true
    })
    .sort((a, b) => num(b.volume_24h_fp) - num(a.volume_24h_fp))
    .slice(0, CFG.maxMarketsPerScan)
  console.log(`universe after filters: ${uni.length} markets`)
  if (uni.length === 0) return
  for (const m of uni.slice(0, 8)) {
    console.log(
      `  ${m.ticker} | ${((m.title ?? '') + (m.yes_sub_title ? ' · ' + m.yes_sub_title : '')).slice(0, 64)} | last ${(num(m.last_price_dollars) * 100).toFixed(0)}% | vol24h ${num(m.volume_24h_fp)} | liq $${m.__liq.toFixed(0)} | spread ${(m.__spread * 100).toFixed(1)}¢`
    )
  }

  const signals = []

  // ---- 1) momentum via 1-min candles ----
  if (CFG.momentumEnabled) {
    const start = now - (CFG.momentumWindowMinutes + 5) * 60
    const res = await (
      await fetch(`${BASE}/markets/candlesticks?market_tickers=${uni.map((m) => m.ticker).join(',')}&start_ts=${start}&end_ts=${now}&period_interval=1`)
    ).json()
    const byTicker = new Map((res.markets ?? []).map((x) => [x.market_ticker, x.candlesticks ?? []]))
    const cutoff = now - CFG.momentumWindowMinutes * 60
    for (const m of uni) {
      const candles = (byTicker.get(m.ticker) ?? []).filter((c) => c.end_period_ts >= cutoff)
      const priceAt = (c) => (c.price?.close_dollars !== undefined && c.price?.close_dollars !== '' ? num(c.price.close_dollars) : undefined) ?? ((c.yes_bid?.close_dollars !== undefined && c.yes_ask?.close_dollars !== undefined) ? (num(c.yes_bid.close_dollars) + num(c.yes_ask.close_dollars)) / 2 : undefined)
      if (candles.length < 5) continue
      const newest = priceAt(candles[candles.length - 1])
      const oldest = priceAt(candles[0])
      if (newest === undefined || oldest === undefined) continue
      const move = newest - oldest // point move — relative moves on near-zero prices are noise
      if (Math.abs(move) < CFG.momentumMinMovePct) continue
      const dir = move > 0 ? 'YES' : 'NO'
      signals.push({ strategy: 'momentum', ticker: m.ticker, q: title(m), dir, score: Math.min(100, Math.round(50 + (Math.abs(move) / CFG.momentumMinMovePct) * 30)), details: `move ${round2(move * 100)}¢ ${round2(oldest)}→${round2(newest)}` })
    }
  }

  // ---- 2) volume spike via trades ----
  if (CFG.volumeSpikeEnabled) {
    const baselines = {}
    {
      const start = now - (CFG.volumeSpikeBaselineMinutes + 60) * 60
      const res = await (await fetch(`${BASE}/markets/candlesticks?market_tickers=${uni.slice(0, 12).map((m) => m.ticker).join(',')}&start_ts=${start}&end_ts=${now}&period_interval=60`)).json()
      for (const x of res.markets ?? []) {
        const candles = (x.candlesticks ?? []).filter((c) => now - c.end_period_ts <= CFG.volumeSpikeBaselineMinutes * 60)
        if (candles.length >= 2) baselines[x.market_ticker] = candles.reduce((s, c) => s + num(c.volume_fp), 0) / (candles.length * 60)
      }
    }
    for (const m of uni.slice(0, 12)) {
      const perMin = baselines[m.ticker]
      if (!perMin || perMin <= 0) continue
      const res = await (await fetch(`${BASE}/markets/trades?ticker=${m.ticker}&limit=1000&min_ts=${now - CFG.volumeSpikeBaselineMinutes * 60}`)).json()
      const inWin = (res.trades ?? []).filter((t) => !t.is_block_trade && now - Date.parse(t.created_time) / 1000 <= CFG.volumeSpikeWindowMinutes * 60)
      if (inWin.length < 3) continue
      const vol = inWin.reduce((s, t) => s + num(t.count_fp), 0)
      const multiple = vol / CFG.volumeSpikeWindowMinutes / perMin
      if (multiple < CFG.volumeSpikeMinMultiple) continue
      let aggYes = 0, aggNo = 0
      for (const t of inWin) {
        if (t.taker_outcome_side === 'yes' && t.taker_book_side === 'bid') aggYes += num(t.count_fp)
        else if (t.taker_outcome_side === 'no' && t.taker_book_side === 'ask') aggNo += num(t.count_fp)
      }
      const total = aggYes + aggNo
      const pressure = total > 0 ? (aggYes - aggNo) / total : 0
      const dir = pressure > 0.15 ? 'YES' : pressure < -0.15 ? 'NO' : undefined
      if (!dir) continue
      signals.push({ strategy: 'volume-spike', ticker: m.ticker, q: title(m), dir, score: Math.min(100, Math.round(50 + (multiple / CFG.volumeSpikeMinMultiple) * 25 + Math.abs(pressure) * 25)), details: `×${round2(multiple)} pressure ${round2(pressure)}` })
    }
  }

  // ---- 3) book imbalance ----
  if (CFG.bookEnabled) {
    const q = uni.map((m) => `tickers=${m.ticker}`).join('&')
    const res = await (await fetch(`${BASE}/markets/orderbooks?${q}`)).json()
    for (const o of res.orderbooks ?? []) {
      const fp = o.orderbook_fp ?? {}
      const bids = (fp.yes_dollars ?? []).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) })).sort((a, b) => b.price - a.price)
      const asks = (fp.no_dollars ?? []).map(([p, s]) => ({ price: 1 - parseFloat(p), size: parseFloat(s) })).sort((a, b) => a.price - b.price)
      const bidDepth = bids.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
      const askDepth = asks.slice(0, 3).reduce((s, l) => s + l.price * l.size, 0)
      if (bidDepth + askDepth < CFG.bookMinDepth) continue
      if (Math.min(bidDepth, askDepth) < 50) continue // per-side depth — kills empty-side ratios
      const ratio = bidDepth / askDepth
      const m = uni.find((x) => x.ticker === o.ticker)
      if (!m) continue
      if (ratio >= CFG.bookMinRatio) signals.push({ strategy: 'book-imbalance', ticker: m.ticker, q: title(m), dir: 'YES', score: Math.min(100, Math.round(50 + (ratio - 1) * 25)), details: `ratio ${round2(ratio)} bid$${round2(bidDepth)} ask$${round2(askDepth)}` })
      else if (ratio <= 1 / CFG.bookMinRatio) signals.push({ strategy: 'book-imbalance', ticker: m.ticker, q: title(m), dir: 'NO', score: Math.min(100, Math.round(50 + (1 / ratio - 1) * 25)), details: `ratio ${round2(ratio)} bid$${round2(bidDepth)} ask$${round2(askDepth)}` })
    }
  }

  // ---- 4) cross-venue vs Polymarket Gamma ----
  if (CFG.crossVenueEnabled) {
    for (const m of uni.slice(0, 12)) {
      const asset = assetOf((m.title ?? '') + ' ' + (m.yes_sub_title ?? ''))
      if (!asset) continue
      let polyMarkets = []
      try {
        const r = await fetch(`${GAMMA}/public-search?q=${encodeURIComponent(asset)}&limit_pagination=true`)
        const data = await r.json()
        for (const ev of data.events ?? []) polyMarkets.push(...(ev.markets ?? []))
      } catch {
        continue
      }
      const kTokens = titleTokens(m)
      if (kTokens.length < 2) continue
      let best = null
      for (const pm of polyMarkets) {
        const pp = pm.outcomePrices ? parseFloat(pm.outcomePrices[0]) : 0
        if (!(pp > 0)) continue
        const sim = jaccard(kTokens, norm(pm.question ?? pm.title ?? ''))
        if (sim < CFG.crossVenueMinSimilarity) continue
        const mClose = m.close_time ? Date.parse(m.close_time) : 0
        const pClose = pm.endDate ? Date.parse(pm.endDate) : 0
        if (mClose && pClose && Math.abs(mClose - pClose) > 35 * 60000) continue
        if (!best || sim > best.sim) best = { sim, pp, pq: pm.question ?? pm.title }
      }
      if (!best) continue
      const kProb = num(m.last_price_dollars)
      const gap = best.pp - kProb
      if (Math.abs(gap) < CFG.crossVenueMinGapPct) continue
      const dir = gap > 0 ? 'YES' : 'NO'
      signals.push({ strategy: 'cross-venue', ticker: m.ticker, q: title(m), dir, score: Math.min(100, Math.round(50 + (Math.abs(gap) / CFG.crossVenueMinGapPct) * 30 + best.sim * 20)), details: `kalshi ${round2(kProb * 100)}% vs poly ${round2(best.pp * 100)}% sim ${round2(best.sim)} — ${(best.pq ?? '').slice(0, 60)}` })
    }
  }

  // ---- 5) Dutch book ----
  if (CFG.dutchEnabled) {
    let cursor
    for (let page = 0; page < 2; page++) {
      const path = `/events?status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const res = await (await fetch(BASE + path)).json()
      for (const e of res.events ?? []) {
        if (!e.mutually_exclusive) continue
        const legs = (e.markets ?? []).filter((l) => {
          if (l.market_type !== 'binary' || l.status !== 'active') return false
          const p = num(l.last_price_dollars)
          return p > 0.02 && p < 0.98 && num(l.volume_fp) >= CFG.minVolume
        })
        if (legs.length < 2 || legs.length > CFG.dutchMaxLegs) continue
        const closeTimes = legs.map((l) => (l.close_time ? Date.parse(l.close_time) : 0)).filter((t) => t > 0)
        if (closeTimes.length === 0) continue
        const closeTime = Math.min(...closeTimes)
        const mins = (closeTime - Date.now()) / 60000
        if (mins < CFG.minMinutesToClose || mins > CFG.maxMinutesToClose) continue
        let sumBids = 0, maxSpread = 0, ok = true
        for (const l of legs) {
          const spread = num(l.yes_bid_dollars) > 0 && num(l.yes_ask_dollars) > 0 ? num(l.yes_ask_dollars) - num(l.yes_bid_dollars) : -1
          if (!(spread > 0)) { ok = false; break }
          maxSpread = Math.max(maxSpread, spread)
          sumBids += Math.max(0.01, num(l.last_price_dollars) - spread / 2)
        }
        if (!ok || maxSpread > CFG.maxSpreadPct) continue
        const over = sumBids - 1
        if (over > CFG.dutchMinOverSum) {
          signals.push({ strategy: 'dutch', ticker: e.event_ticker, q: e.title ?? e.event_ticker, dir: 'NO', score: Math.min(100, Math.round(50 + over * 700)), details: `Σbids ${round2(sumBids)} legs ${legs.length} profit ≈${round2(over * 100)}¢` })
        }
      }
      if (!res.cursor) break
      cursor = res.cursor
    }
  }

  // ---- report ----
  console.log(`\ntotal candidates: ${signals.length}`)
  const sorted = signals.sort((a, b) => b.score - a.score)
  for (const s of sorted) {
    const gate = s.score >= CFG.minScore ? 'APPROVE' : `score<${CFG.minScore}`
    console.log(`  [${s.strategy.padEnd(14)}] ${s.dir} sig ${s.score} ${gate.padEnd(10)} | ${s.ticker} | ${s.q.slice(0, 52)} | ${s.details}`)
  }
  if (signals.length === 0) console.log('  (no signals fired in this snapshot — thresholds are conservative)')
}

function title(m) {
  return (m.title ?? '') + (m.yes_sub_title ? ' · ' + m.yes_sub_title : '')
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})
