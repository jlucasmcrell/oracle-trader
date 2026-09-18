// Grades the thin quoter's fills at settlement (quoter-kalshi-fills.jsonl next to the
// quoter state under %APPDATA%\oracle-trader). Maker fills on fee-free series: net cents
// per contract = payout - legCost. Clustered by event (series+date) and by day.
//
// Since the 2026-09-06 review the ledger is fed from the venue's fills feed by
// order id (source 'venue-fills'); older rows came from the resting-order
// reconcile and cover only a fraction of real fills. The report splits the two.
//   node scripts/quoter-gate.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const DIR = join(process.env.APPDATA || '', 'oracle-trader')
const FILLS = process.env.QUOTER_FILLS || join(DIR, 'quoter-kalshi-fills.jsonl')
const K = 'https://api.elections.kalshi.com/trade-api/v2'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (!existsSync(FILLS)) { console.log('no fills yet at', FILLS); process.exit(0) }
const repaired = readFileSync(FILLS, 'utf8').replace(/\\n(?=\{)/g, '\n')
const fills = repaired.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
console.log(`fills logged: ${fills.length} (${fills.reduce((s, f) => s + (f.count || 0), 0).toFixed(2)} contracts)`)
const bySource = new Map()
for (const f of fills) bySource.set(f.source || '?', (bySource.get(f.source || '?') ?? 0) + 1)
console.log('by source:', Object.fromEntries(bySource))
const cachePath = join(DIR, 'quoter-settled-cache.json')
let cache = {}
try { if (existsSync(cachePath)) cache = JSON.parse(readFileSync(cachePath, 'utf8')) } catch { cache = {} }
for (const t of new Set(fills.map((f) => f.marketId))) {
  if (cache[t] && (cache[t].result === 'yes' || cache[t].result === 'no')) continue
  if (cache[t] && Date.now() - (cache[t].checked ?? 0) < 3 * 3600e3) continue
  try { const r = await fetch(`${K}/markets/${encodeURIComponent(t)}`); if (r.ok) { const m = (await r.json()).market ?? {}; cache[t] = { status: m.status, result: m.result || m.resolution || null, checked: Date.now() } } } catch { /* retry next run */ }
  await sleep(80)
}
try { writeFileSync(cachePath, JSON.stringify(cache)) } catch { /* best effort */ }
const rows = []
for (const f of fills) {
  const s = cache[f.marketId]; if (!s || !(s.result === 'yes' || s.result === 'no')) continue
  const win = (f.outcome === 'YES') === (s.result === 'yes')
  const net = (win ? 1 - f.legCost : -f.legCost) * 100
  const ev = f.marketId.split('-').slice(0, 2).join('-')
  rows.push({ ...f, win, net, ev, day: (f.close || f.ts).slice(0, 10) })
}
const mu = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN
const clusterSE = (vals, keys) => { const g = new Map(); vals.forEach((v, i) => g.set(keys[i], (g.get(keys[i]) ?? []).concat(v))); const m = mu(vals), G = [...g.values()]; return [Math.sqrt(G.reduce((s, grp) => s + Math.pow(grp.reduce((a, b) => a + (b - m), 0), 2), 0)) / vals.length, G.length] }
console.log(`settled fills: ${rows.length} of ${fills.length}`)
if (!rows.length) { console.log('nothing settled yet'); process.exit(0) }
function report(label, subset) {
  const v = [], kEv = [], kDay = []
  for (const r of subset) for (let i = 0; i < Math.max(1, Math.round(r.count)); i++) { v.push(r.net); kEv.push(r.ev); kDay.push(r.day) }
  if (!v.length) { console.log(`${label}: no settled contracts`); return }
  const [seE, nE] = clusterSE(v, kEv), [seD, nD] = clusterSE(v, kDay), m = mu(v)
  console.log(`${label}: net ${m.toFixed(2)}c/contract over ${v.length} contracts, ${nE} events, ${nD} days | P(adverse) ${(100 * subset.filter((r) => !r.win).length / subset.length).toFixed(1)}% | mean cost ${(100 * mu(subset.map((r) => r.legCost))).toFixed(1)}c`)
  console.log(`  event-clustered CI95 [${(m - 1.96 * seE).toFixed(2)}, ${(m + 1.96 * seE).toFixed(2)}]  day-clustered [${(m - 1.96 * seD).toFixed(2)}, ${(m + 1.96 * seD).toFixed(2)}]`)
}
report('ALL', rows)
report('venue-fills (order-id attributed)', rows.filter((r) => r.source === 'venue-fills'))
report('legacy reconcile (resting-only sample)', rows.filter((r) => r.source !== 'venue-fills'))
const byDay = new Map(); for (const r of rows) { const d = byDay.get(r.day) ?? { n: 0, pnl: 0 }; d.n += r.count; d.pnl += r.net * r.count / 100; byDay.set(r.day, d) }
console.log('by day:'); for (const [d, x] of [...byDay.entries()].sort()) console.log(`  ${d}  contracts ${x.n.toFixed(2)}  P&L $${x.pnl.toFixed(2)}`)
console.log('\nNOTE: the venue settlement feed (GET /portfolio/settlements) is the ledger of record; the app panel shows it under "Venue-authoritative settlements".')
