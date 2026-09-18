// Gate checker for docs/PREREGISTERED-llm-hunch.md.
// Reads <userData>/hunches/*.jsonl (written by the app's hunch collector),
// keeps the FIRST hunch per market, fetches settlement from the public Kalshi
// API, and reports: Brier(model) vs Brier(mid) with an event-clustered CI on
// the per-market difference, the 3-threshold taker trading table (event- and
// day-clustered, Bonferroni z=2.39), a per-category split, and PASS/FAIL.
//
//   node scripts/hunch-gate.mjs
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.HUNCH_DIR || join(process.env.APPDATA || '', 'oracle-trader', 'hunches')
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2'
const THRESHOLDS = [0.10, 0.15, 0.25]
const Z_BONF = 2.39, Z = 1.96, MIN_EVENTS = 200, MIN_LB = 1.0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(DIR)) { console.log('no hunches dir at', DIR); process.exit(0) }
const first = new Map()   // ticker -> first hunch line
let lines = 0
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
    if (!line) continue
    let j; try { j = JSON.parse(line) } catch { continue }
    lines++
    if (!first.has(j.t) || Date.parse(j.ts) < Date.parse(first.get(j.t).ts)) first.set(j.t, j)
  }
}
console.log(`hunch lines ${lines}; distinct markets ${first.size}`)

// settlement lookup (public), cached to disk so repeated runs are cheap
const cachePath = join(DIR, 'settled-cache.json')
let cache = {}
try { if (existsSync(cachePath)) cache = JSON.parse(readFileSync(cachePath, 'utf8')) } catch { cache = {} }
let fetched = 0
for (const t of first.keys()) {
  if (cache[t] && (cache[t].result === 'yes' || cache[t].result === 'no')) continue
  if (cache[t] && Date.now() - (cache[t].checked ?? 0) < 6 * 3600e3) continue
  try {
    const r = await fetch(`${KALSHI}/markets/${encodeURIComponent(t)}`)
    if (r.ok) { const m = (await r.json()).market ?? {}; cache[t] = { status: m.status, result: m.result || null, checked: Date.now() } }
    fetched++
  } catch { /* try next run */ }
  await sleep(80)
}
try { (await import('node:fs')).writeFileSync(cachePath, JSON.stringify(cache)) } catch { /* best effort */ }

const fee = (px, C) => Math.ceil(0.07 * C * px * (1 - px) * 100 - 1e-9) / C   // cents per contract (multiplier 1 assumed)
const rows = []
for (const [t, h] of first) {
  const s = cache[t]; if (!s || !(s.result === 'yes' || s.result === 'no')) continue
  const y = s.result === 'yes' ? 1 : 0
  rows.push({ ...h, y, day: (h.close ?? h.ts).slice(0, 10) })
}
const mu = (a) => a.reduce((x, y) => x + y, 0) / a.length
const clusterSE = (vals, keys) => { const g = new Map(); vals.forEach((v, i) => g.set(keys[i], (g.get(keys[i]) ?? []).concat(v))); const m = mu(vals), G = [...g.values()]; return [Math.sqrt(G.reduce((s, arr) => s + Math.pow(arr.reduce((x, y) => x + y, 0) - arr.length * m, 2), 0) / (vals.length ** 2)), G.length] }
console.log(`settled with a first hunch: ${rows.length} (fetched ${fetched} statuses this run)`)
if (rows.length < 5) { console.log('GATE: NOT EVALUABLE'); process.exit(0) }

// 1) Brier: model vs market mid
const bd = rows.map((r) => (r.p - r.y) ** 2 - (r.mid - r.y) ** 2)   // negative = model better
const [seB, nEv] = clusterSE(bd, rows.map((r) => r.ev))
console.log(`\nBRIER model ${mu(rows.map((r) => (r.p - r.y) ** 2)).toFixed(4)} vs mid ${mu(rows.map((r) => (r.mid - r.y) ** 2)).toFixed(4)} | diff ${mu(bd).toFixed(4)} CI95 [${(mu(bd) - Z * seB).toFixed(4)}, ${(mu(bd) + Z * seB).toFixed(4)}] over ${nEv} events (negative = model knows more)`)

// 2) trading table
let bestLB = -Infinity, bestCell = null
console.log('\nTRADING (taker at the ask, one trade per market, fee included):')
for (const th of THRESHOLDS) {
  const tr = rows.filter((r) => Math.abs(r.p - r.mid) >= th).map((r) => {
    const side = r.p > r.mid ? 'YES' : 'NO'
    const cost = side === 'YES' ? r.ya : 1 - r.yb
    const win = side === 'YES' ? r.y === 1 : r.y === 0
    const C = Math.max(1, Math.floor(10 / Math.max(cost, 0.01)))
    return { ...r, side, cost, win, net: (win ? 1 - cost : -cost) * 100 - fee(cost, C) }
  })
  if (tr.length < 3) { console.log(`  |p-mid|>=${th}: n=${tr.length} (too few)`); continue }
  const v = tr.map((r) => r.net), [seE, ev] = clusterSE(v, tr.map((r) => r.ev)), [seD, dy] = clusterSE(v, tr.map((r) => r.day)), m = mu(v)
  const lb = m - Z_BONF * seE
  if (lb > bestLB) { bestLB = lb; bestCell = { th, m, ev, dy, seD } }
  console.log(`  |p-mid|>=${th}: n=${tr.length} events=${ev} days=${dy} adverse ${(100 * tr.filter((r) => !r.win).length / tr.length).toFixed(1)}% cost ${(100 * mu(tr.map((r) => r.cost))).toFixed(1)}c | NET ${m >= 0 ? '+' : ''}${m.toFixed(2)}c  event-CI95 [${(m - Z * seE).toFixed(2)}, ${(m + Z * seE).toFixed(2)}]  Bonferroni [${lb.toFixed(2)}, ${(m + Z_BONF * seE).toFixed(2)}]  day-CI95 [${(m - Z * seD).toFixed(2)}, ${(m + Z * seD).toFixed(2)}]`)
}

// 3) by category
const cats = new Map()
for (const r of rows) { const c = cats.get(r.category) ?? { n: 0, bd: [] }; c.n++; c.bd.push((r.p - r.y) ** 2 - (r.mid - r.y) ** 2); cats.set(r.category, c) }
console.log('\nby category (Brier diff, negative = model better):')
for (const [k, c] of [...cats.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(24)} n=${String(c.n).padStart(4)}  diff ${mu(c.bd).toFixed(4)}`)

// 4) gate
const g1 = nEv >= MIN_EVENTS, g2 = (mu(bd) + Z * seB) < 0, g3 = bestCell !== null && bestLB > MIN_LB && (bestCell.m - Z * bestCell.seD) > 0
console.log(`\nGATE (pre-registered):`)
console.log(`  [${g1 ? 'x' : ' '}] >= ${MIN_EVENTS} settled events                 (${nEv})`)
console.log(`  [${g2 ? 'x' : ' '}] Brier(model) < Brier(mid), CI excludes 0  (upper ${(mu(bd) + Z * seB).toFixed(4)})`)
console.log(`  [${g3 ? 'x' : ' '}] best cell Bonferroni LB > +${MIN_LB}c and day-CI > 0 (${bestCell ? `th ${bestCell.th}: LB ${bestLB.toFixed(2)}c` : 'n/a'})`)
console.log(`RESULT: ${g1 && g2 && g3 ? 'PASS' : 'FAIL / NOT YET'}`)
