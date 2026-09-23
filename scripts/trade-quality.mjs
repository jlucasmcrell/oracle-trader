// Trade-quality report: per strategy and venue, is it making money after fees,
// and are fills adversely selected? Reads the app's persisted ledgers (no
// venue calls except settlement lookups for quoter fills), prints a compact
// table with flags. Run any time:  node scripts/trade-quality.mjs
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { killState } from './lib/kill-state.mjs'

const DATA = join(process.env.APPDATA || '', 'oracle-trader')
const REPO = 'G:/PROJECTS/oracle-trader'
const K = 'https://api.elections.kalshi.com/trade-api/v2'
const rj = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const f2 = (x) => (x === undefined || x === null || Number.isNaN(x) ? '-' : (x >= 0 ? '+' : '') + Number(x).toFixed(2))
const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + '%' : '-')
const mu = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN
const clusterSE = (vals, keys) => { const g = new Map(); vals.forEach((v, i) => g.set(keys[i], (g.get(keys[i]) ?? []).concat(v))); const m = mu(vals), G = [...g.values()]; return [Math.sqrt(G.reduce((s, arr) => s + Math.pow(arr.reduce((x, y) => x + y, 0) - arr.length * m, 2), 0) / (vals.length ** 2)), G.length] }
const flags = []

console.log(`TRADE QUALITY ${new Date().toISOString().slice(0, 16)}Z`)

// ---------- Kalshi main trader: per strategy ----------
const k = rj(join(DATA, 'kalshi-auto.json'))
if (k) {
  const s = k.state
  const kill = killState(s, new Date().toISOString().slice(0, 10))
  if (kill.tripped) flags.push(`kalshi: kill switch ${kill.text}`)
  console.log(`\nKALSHI main trader (armed=${k.config.liveArmed}) — open ${s.openTrades.length}, resting ${(s.pendingOrders || []).length}, today ${s.daily?.count} trades, kill ${kill.text}`)
  console.log('  strategy         trades  W/L     net $    net c/ct (event CI)     CLV c   markout5m c   flag')
  const by = s.perfByStrategy || {}
  const cal = s.calib?.byStrategy || {}
  for (const [name, p] of Object.entries(by)) {
    const c = cal[name] || {}
    let net = '-', ci = ''
    if (c.netN) {
      const m = c.netSum / c.netN
      const groups = Object.values(c.byEvent || {})
      const se = Math.sqrt(groups.reduce((a, g) => a + Math.pow(g.sum - g.n * m, 2), 0)) / c.netN
      net = f2(m); ci = `[${f2(m - 1.96 * se)}, ${f2(m + 1.96 * se)}] n=${c.netN}`
    }
    const clv = p.clvN ? f2(p.clvSum / p.clvN) : '-'
    const mk = p.markoutN ? f2(p.markoutSum / p.markoutN) : '-'
    let flag = ''
    if ((p.wins + p.losses) >= 5 && (p.realizedPnl <= -1 || p.losses / (p.wins + p.losses) >= 0.6)) flag = 'REVIEW: losing'
    if (p.markoutN >= 5 && p.markoutSum / p.markoutN <= -2) flag = (flag ? flag + '; ' : '') + 'adverse fills'
    if (flag) flags.push(`kalshi/${name}: ${flag}`)
    console.log(`  ${name.padEnd(16)} ${String(p.trades).padStart(5)}  ${String(p.wins).padStart(2)}/${String(p.losses).padEnd(3)} ${f2(p.realizedPnl).padStart(8)}  ${String(net).padStart(7)} ${ci.padEnd(22)} ${String(clv).padStart(6)}  ${String(mk).padStart(10)}   ${flag}`)
  }
  // open positions by strategy
  const openBy = {}
  for (const t of s.openTrades) openBy[t.strategy] = (openBy[t.strategy] || 0) + 1
  if (Object.keys(openBy).length) console.log('  open by strategy:', JSON.stringify(openBy))
}

// ---------- Quoter: fills, settlement, markout from the collector ladders ----------
const fillsPath = join(DATA, 'quoter-kalshi-fills.jsonl')
if (existsSync(fillsPath)) {
  const fills = readFileSync(fillsPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  // settlement cache (shared with quoter-gate)
  const cachePath = join(DATA, 'quoter-settled-cache.json'); let cache = rj(cachePath) || {}
  for (const t of new Set(fills.map((f) => f.marketId))) {
    if (cache[t] && (cache[t].result === 'yes' || cache[t].result === 'no')) continue
    if (cache[t] && Date.now() - (cache[t].checked || 0) < 3600e3) continue
    try { const r = await fetch(`${K}/markets/${encodeURIComponent(t)}`); if (r.ok) { const m = (await r.json()).market || {}; cache[t] = { status: m.status, result: m.result || null, checked: Date.now() } } } catch { /* later */ }
    await new Promise((r) => setTimeout(r, 60))
  }
  try { writeFileSync(cachePath, JSON.stringify(cache)) } catch {}
  // markout: mid 5-15 min after each fill from the collector's weather ladders
  const ladderDir = join(REPO, 'data', 'btc-collector')
  const byMarket = new Map()
  const want = new Set(fills.map((f) => f.marketId))
  if (existsSync(ladderDir)) for (const f of readdirSync(ladderDir).filter((x) => x.endsWith('.jsonl')).sort().slice(-2)) {
    for (const line of readFileSync(join(ladderDir, f), 'utf8').split('\n')) {
      if (!line.includes('"ladder"') || !line.includes('KXHIGH') && !line.includes('KXLOW')) continue
      let j; try { j = JSON.parse(line) } catch { continue }
      if (j.kind !== 'ladder' || !j.strikes) continue
      for (const st of j.strikes) { const tk = st[5]; if (tk && want.has(tk) && st[1] !== null && st[2] !== null) (byMarket.get(tk) || byMarket.set(tk, []).get(tk)).push({ t: Date.parse(j.ts), mid: (st[1] + st[2]) / 2 }) }
    }
  }
  // Post-fill mids recorded by the quoter itself (quoter-kalshi-marks.jsonl) cover every
  // series it trades; the collector's ladders only cover five cities.
  const marksPath = join(DATA, 'quoter-kalshi-marks.jsonl')
  if (existsSync(marksPath)) for (const line of readFileSync(marksPath, 'utf8').split('\n').filter(Boolean)) { let j; try { j = JSON.parse(line) } catch { continue } if (j.minutesAfter >= 4 && j.minutesAfter <= 16) (byMarket.get(j.marketId) || byMarket.set(j.marketId, []).get(j.marketId)).push({ t: Date.parse(j.ts), mid: j.mid }) }
  const settledRows = [], markouts = []
  for (const f of fills) {
    const s = cache[f.marketId]
    if (s && (s.result === 'yes' || s.result === 'no')) { const win = (f.outcome === 'YES') === (s.result === 'yes'); settledRows.push({ ...f, net: (win ? 1 - f.legCost : -f.legCost) * 100, ev: f.marketId.split('-').slice(0, 2).join('-') }) }
    const t0 = Date.parse(f.ts); const later = (byMarket.get(f.marketId) || []).filter((r) => r.t >= t0 + 4 * 60000 && r.t <= t0 + 16 * 60000).sort((a, b) => a.t - b.t)[0]
    if (later) markouts.push((f.outcome === 'YES' ? later.mid - f.yesPrice : f.yesPrice - later.mid) * 100)
  }
  console.log(`\nQUOTER (thin weather books) — fills ${fills.length} (${fills.reduce((a, f) => a + f.count, 0)} contracts), settled ${settledRows.length}`)
  if (settledRows.length) { const v = settledRows.map((r) => r.net), [se, G] = clusterSE(v, settledRows.map((r) => r.ev)); console.log(`  settled net ${f2(mu(v))} c/contract over ${G} events, CI [${f2(mu(v) - 1.96 * se)}, ${f2(mu(v) + 1.96 * se)}], adverse ${pct(settledRows.filter((r) => r.net < 0).length, settledRows.length)}`) }
  if (markouts.length) { const m = mu(markouts); console.log(`  5-15 min markout after fill: ${f2(m)} c avg over ${markouts.length} fills (negative = price moved against us right after we were filled)`); if (markouts.length >= 5 && m <= -2) flags.push(`quoter: adverse fills (markout ${f2(m)}c)`) }
  else console.log('  markout: no ladder data yet for filled markets')
}

// ---------- Minis ----------
for (const v of ['polymarket-us']) {
  const m = rj(join(DATA, `mini-auto-${v}.json`)); if (!m) continue
  const p = m.state.perf || {}, by = m.state.perfByStrategy || {}
  console.log(`\n${v.toUpperCase()} (armed=${m.config.liveArmed}) — open ${(m.state.openTrades || []).length}, resting ${(m.state.pendingOrders || []).length}, total ${p.trades} closed ${p.wins}W/${p.losses}L net $${f2(p.realizedPnl)}`)
  for (const [name, q] of Object.entries(by)) {
    let flag = ''
    if ((q.wins + q.losses) >= 5 && (q.realizedPnl <= -1 || q.losses / (q.wins + q.losses) >= 0.6)) { flag = 'REVIEW: losing'; flags.push(`${v}/${name}: losing`) }
    console.log(`  ${name.padEnd(16)} ${String(q.trades).padStart(5)}  ${q.wins}W/${q.losses}L  net $${f2(q.realizedPnl)}  ${flag}`)
  }
  if (!Object.keys(by).length) console.log('  (per-strategy split starts with the next settlement)')
  // Backlog 237: 47 of 177 live closes were booked at a provisional settlement price (section 160), so the
  // per-arm rows above are the app's own ledger, not the venue's. scripts/polyus-regrade.py re-grades them
  // from the venue's resolution records; print that next to them, with its own date so a stale file shows.
  const rg = rj(join(REPO, 'data', 'polyus-regrade', 'regraded.json'))
  if (rg) {
    console.log(`  venue-true re-grade (${rg.at}, ${rg.resolvedMarkets} resolved markets):`)
    for (const [name, q] of Object.entries(rg.byArm || {})) {
      if (!q.judged && !q.unjudgeable) continue
      console.log(`    ${name.padEnd(16)} judged ${String(q.judged).padStart(4)}  app $${f2(q.appPnl)} -> venue $${f2(q.venuePnl)}  (${q.regraded} re-graded, ${q.unjudgeable} unjudgeable)`)
    }
    const labExcluded = Object.values(rg.byArm || {}).reduce((a, q) => a + (q.labExcluded || 0), 0)
    if (labExcluded) console.log(`    ${String(labExcluded).padStart(4)} paper-lab settlements sit at a provisional price and are excluded, not re-priced`)
  } else console.log('  venue-true re-grade: not run (python scripts/polyus-regrade.py <polyus dump> --write)')
}

console.log(`\nFLAGS: ${flags.length ? flags.join(' | ') : 'none'}`)
