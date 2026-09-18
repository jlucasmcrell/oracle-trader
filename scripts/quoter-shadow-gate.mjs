// Grades the thin quoter's SHADOW meter (quoter-kalshi-shadow.jsonl under
// %APPDATA%\oracle-trader). DIAGNOSTIC ONLY — not a promotion gate on its own.
//
// While the quoter is not quoting, it logs the quotes it would rest for every
// chosen market. Cohorts:
//   allowed = passes every gate: this is the strategy that WOULD trade.
//   blocked = a gate (ratchet / blackout / no-index / index-stale) would have
//             refused it: the control group.
// A 'proxy-fill' is a timestamped trade print through the quote price (book
// crossing only when the trades feed was unavailable); 'markout15' is the mid
// ≈15 minutes after the fill (actual timing recorded); 'pulled' means the live
// lifecycle would have cancelled the quote (gate closed, or ineligible 20 min).
//
// The arming question is whether the ALLOWED cohort is profitable after
// settlement; a losing BLOCKED cohort only says the gates block the right
// quotes. Both are reported side by side. Series are fee-free (maker fee 0).
//   node scripts/quoter-shadow-gate.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const DIR = join(process.env.APPDATA || '', 'oracle-trader')
const FILE = process.env.QUOTER_SHADOW || join(DIR, 'quoter-kalshi-shadow.jsonl')
const K = 'https://api.elections.kalshi.com/trade-api/v2'
const MIN_EVENTS = 40, MIN_FILLS = 30
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (!existsSync(FILE)) { console.log('no shadow log yet at', FILE); process.exit(0) }
const rows = readFileSync(FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const quotes = new Map()
for (const r of rows) {
  if (r.event === 'quote') quotes.set(r.id, { ...r, cohort: r.cohort ?? (r.gated ? 'blocked' : 'allowed'), filled: false })
  else if (r.event === 'proxy-fill') { const q = quotes.get(r.id); if (q) { q.filled = true; q.fillTs = r.fillTs ?? r.ts; q.fillSource = r.fillSource ?? 'book' } }
  else if (r.event === 'markout15') { const q = quotes.get(r.id); if (q) { q.markout = r.markoutCents; q.markoutMinutes = r.markoutMinutes } }
  else if (r.event === 'expired') { const q = quotes.get(r.id); if (q) q.expired = true }
  else if (r.event === 'pulled') { const q = quotes.get(r.id); if (q) q.pulled = (r.reasons ?? []).join(',') || 'pulled' }
}
const all = [...quotes.values()]
const cohort = (c) => all.filter((q) => q.cohort === c)
const mu = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN
const clusterSE = (vals, keys) => { const g = new Map(); vals.forEach((v, i) => g.set(keys[i], (g.get(keys[i]) ?? []).concat(v))); const m = mu(vals), G = [...g.values()]; return [Math.sqrt(G.reduce((s, grp) => s + Math.pow(grp.reduce((a, b) => a + (b - m), 0), 2), 0)) / vals.length, G.length] }
console.log(`shadow quotes: ${all.length} (allowed ${cohort('allowed').length}, blocked ${cohort('blocked').length})`)
for (const c of ['allowed', 'blocked']) {
  const q = cohort(c)
  const filled = q.filter((x) => x.filled)
  const prints = filled.filter((x) => x.fillSource === 'print').length
  const mo = filled.filter((x) => typeof x.markout === 'number')
  const mins = mo.map((x) => x.markoutMinutes).filter((x) => typeof x === 'number')
  console.log(`${c.toUpperCase().padEnd(7)}: quotes ${q.length}, pulled ${q.filter((x) => x.pulled).length}, expired ${q.filter((x) => x.expired).length}, proxy fills ${filled.length} (${q.length ? (100 * filled.length / q.length).toFixed(1) : '0'}%; ${prints} from prints, ${filled.length - prints} from book crossing), markout mean ${mo.length ? mu(mo.map((x) => x.markout)).toFixed(2) : 'n/a'}c over ${mo.length} (timing ${mins.length ? `${Math.min(...mins).toFixed(1)}-${Math.max(...mins).toFixed(1)} min` : 'n/a'})`)
  if (c === 'blocked') {
    const reasons = new Map()
    for (const x of q) for (const r of x.gateReasons ?? []) reasons.set(r, (reasons.get(r) ?? 0) + 1)
    console.log('  gate reasons:', Object.fromEntries(reasons))
  }
}
// Settlement grading of proxy fills (public market results).
const cachePath = join(DIR, 'quoter-settled-cache.json')
let cache = {}
try { if (existsSync(cachePath)) cache = JSON.parse(readFileSync(cachePath, 'utf8')) } catch { cache = {} }
const filledAll = all.filter((q) => q.filled)
for (const t of new Set(filledAll.map((q) => q.marketId))) {
  if (cache[t] && (cache[t].result === 'yes' || cache[t].result === 'no')) continue
  if (cache[t] && Date.now() - (cache[t].checked ?? 0) < 3 * 3600e3) continue
  try { const r = await fetch(`${K}/markets/${encodeURIComponent(t)}`); if (r.ok) { const m = (await r.json()).market ?? {}; cache[t] = { status: m.status, result: m.result || m.resolution || null, checked: Date.now() } } } catch { /* next run */ }
  await sleep(80)
}
try { writeFileSync(cachePath, JSON.stringify(cache)) } catch { /* best effort */ }
const verdict = {}
for (const c of ['allowed', 'blocked']) {
  const graded = []
  for (const q of cohort(c).filter((x) => x.filled)) {
    const s = cache[q.marketId]; if (!s || !(s.result === 'yes' || s.result === 'no')) continue
    const win = (q.outcome === 'YES') === (s.result === 'yes')
    graded.push({ net: (win ? 1 - q.legCost : -q.legCost) * 100, ev: q.marketId.split('-').slice(0, 2).join('-'), day: (q.close || q.ts).slice(0, 10), win })
  }
  if (!graded.length) { console.log(`${c.toUpperCase().padEnd(7)} settled proxy fills: none yet`); verdict[c] = null; continue }
  const v = graded.map((g) => g.net), [seE, nE] = clusterSE(v, graded.map((g) => g.ev)), [seD, nD] = clusterSE(v, graded.map((g) => g.day)), m = mu(v)
  const lo = m - 1.96 * seE, hi = m + 1.96 * seE
  console.log(`${c.toUpperCase().padEnd(7)} settled proxy fills: ${v.length}, net ${m.toFixed(2)}c/contract (maker fee 0 on these series), P(adverse) ${(100 * graded.filter((g) => !g.win).length / graded.length).toFixed(1)}%, event CI95 [${lo.toFixed(2)}, ${hi.toFixed(2)}] (${nE} events), day CI95 [${(m - 1.96 * seD).toFixed(2)}, ${(m + 1.96 * seD).toFixed(2)}] (${nD} days)`)
  verdict[c] = { n: v.length, events: nE, mean: m, lo, hi }
}
console.log('')
const a = verdict.allowed
if (!a || a.n < MIN_FILLS || a.events < MIN_EVENTS) {
  console.log(`VERDICT: insufficient sample for the ALLOWED cohort (need >= ${MIN_FILLS} settled proxy fills over >= ${MIN_EVENTS} events; have ${a ? `${a.n} over ${a.events}` : '0'}).`)
} else if (a.lo > 0) {
  console.log(`VERDICT: ALLOWED cohort positive (event-clustered CI95 lower bound ${a.lo.toFixed(2)}c > 0). This is a proxy result (simulated fills, no queue model); a demo/tiny-live soak is the next step, not a full arm.`)
} else {
  console.log(`VERDICT: ALLOWED cohort not demonstrably positive (CI95 lower bound ${a.lo.toFixed(2)}c). Keep the quoter disabled.`)
}
if (verdict.blocked && verdict.blocked.mean < 0) console.log(`Filter check: BLOCKED cohort mean ${verdict.blocked.mean.toFixed(2)}c — the gates are refusing quotes that would have lost (supports the filter; says nothing about the allowed strategy's profitability).`)
// Machine-readable verdict for the in-app promotion ladder (last line, prefixed).
if (process.argv.includes('--json')) {
  const pack = (v) => (v ? { n: v.n, events: v.events, mean: +v.mean.toFixed(3), lo: +v.lo.toFixed(3), hi: +v.hi.toFixed(3) } : null)
  console.log('GATE_JSON ' + JSON.stringify({ allowed: pack(verdict.allowed), blocked: pack(verdict.blocked), minFills: MIN_FILLS, minEvents: MIN_EVENTS, quotes: all.length }))
}
