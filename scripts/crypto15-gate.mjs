/**
 * Grades the 15-minute crypto momentum shadow against a rule PRE-REGISTERED BEFORE COLLECTION.
 *
 * The question: `minMinutesToClose: 15` makes the whole KX*15M family structurally invisible to momentum.
 * Does that floor cost us money, or protect us?
 *
 * Offline. No network of its own — settlement is already in each row, harvested by the recorder, which is
 * the component with the pacing discipline. A grader that re-fetched would be a second uncoordinated
 * consumer of the endpoint the live trader shares.
 *
 *   node scripts/crypto15-gate.mjs
 *
 * SIGN CONVENTION, because it is the whole point: `netCents` is per-contract P&L for the trade momentum
 * WOULD have placed. A POSITIVE mean means the floor is COSTING us. Negative means it is PROTECTING us.
 */
import fs from 'node:fs'
import path from 'node:path'
import { uniqueObservations } from './unique-observations.mjs'

const DIR = process.env.CRYPTO15_DIR ?? 'G:/PROJECTS/oracle-trader/data/crypto15-shadow'

// ---- PRE-REGISTERED, fixed 2026-09-12 before a single row existed ----
const MIN_DAY_CLUSTERS = 20
const MIN_SIGNALLED = 1500
const MAX_DROP_RATE = 0.02
// Two directions pre-registered over the same rows -> two-sided 5% split across two tests, z = 2.24.
const Z = 2.24
// Not `> 0`. The recorder buys ONE contract at the displayed ask on its own precise clock; live entry is
// several contracts placed by a scan that ticks every 30s on a market that moved 30 cents in 13 minutes.
// A bare >0 bar promotes a strategy whose entire margin lives inside the slippage this design cannot see.
const EDGE_BAR = 0.5
const MIN_DEPTH_REALISM = 0.8

/**
 * Verbatim port of clusteredMean from src/main/ladder/ladder.ts, INCLUDING the G/(G-1) finite-cluster
 * correction and the floor-at-plain-SE guard under three clusters. That guard exists because on 2026-09-07
 * a one-cluster band of -2.93..-2.93 (SE exactly zero) stopped a strategy on no evidence at all. Do not
 * re-derive this; the corrections are the product of real losses.
 */
function clusteredMean(rows) {
  const n = rows.length
  if (n === 0) return { n: 0, groups: 0, mean: 0, se: 0, sd: 0 }
  const mean = rows.reduce((a, r) => a + r.v, 0) / n
  const by = new Map()
  for (const r of rows) {
    const g = by.get(r.g) ?? { n: 0, sum: 0 }
    g.n++
    g.sum += r.v
    by.set(r.g, g)
  }
  const groups = [...by.values()]
  const G = groups.length
  const correction = G > 1 ? Math.sqrt(G / (G - 1)) : 1
  const clustered = (Math.sqrt(groups.reduce((a, x) => a + (x.sum - x.n * mean) ** 2, 0)) / n) * correction
  const plain = n > 1 ? Math.sqrt(rows.reduce((a, r) => a + (r.v - mean) ** 2, 0) / (n - 1) / n) : 0
  const sd = n > 1 ? Math.sqrt(rows.reduce((a, r) => a + (r.v - mean) ** 2, 0) / (n - 1)) : 0
  return { n, groups: G, mean, se: G < 3 ? Math.max(clustered, plain) : clustered, sd }
}

const band = (rows, key, field = 'netCents') => {
  const c = clusteredMean(rows.map((r) => ({ v: r[field], g: r[key] })))
  return { ...c, lo: c.mean - Z * c.se, hi: c.mean + Z * c.se }
}

/**
 * A band is only printable when it has width. With one observation (or one cluster of identical values) the
 * SE is exactly zero and this prints something like `[3.08, 3.08]` - a number that LOOKS like a confidence
 * interval and is nothing of the kind. That precise artifact stopped momentum on 2026-09-07 on a "band" of
 * -2.93..-2.93. The gate already refuses to act on a thin sample; the DISPLAY must refuse too, because the
 * failure mode is a human reading a fake interval off a table, not the rule firing.
 */
const fmtBand = (b) => (b.n < 2 || !(b.se > 0) ? `n=${b.n} - no width, not an interval` : `[${b.lo.toFixed(2)}, ${b.hi.toFixed(2)}]`)

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^observations-\d{4}-\d{2}\.jsonl$/.test(f)) : []
if (files.length === 0) {
  console.log(`no observation files in ${DIR} yet — the recorder writes one row per window at settlement`)
  process.exit(0)
}
let rows = []
for (const f of files) {
  for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* torn line */
    }
  }
}
const integrity = uniqueObservations(rows, r => r.ticker)
if (integrity.conflicts) { console.log(`INCONCLUSIVE: ${integrity.conflicts} conflicting window records; raw observations preserved for integrity review.`); process.exit(2) }
rows = integrity.rows
console.log(`Exact duplicate windows excluded: ${integrity.duplicates}`)
const sig = rows.filter((r) => r.signal && typeof r.netCents === 'number')
const days = new Set(sig.map((r) => r.day))
let hb = {}
try {
  hb = JSON.parse(fs.readFileSync(path.join(DIR, 'heartbeat.json'), 'utf8'))
} catch {
  /* optional */
}

console.log(`windows recorded      ${rows.length}`)
console.log(`momentum signalled    ${sig.length}  (${rows.length ? ((sig.length / rows.length) * 100).toFixed(1) : 0}% signal rate)`)
console.log(`distinct day-clusters ${days.size}`)
console.log(`drop rate             ${(hb.dropRate ?? 0) * 100}%  (pre-existing-at-start windows excluded, as pre-registered)`)
if (rows.length && sig.length / rows.length > 0.97) {
  console.log(`\nNOTE: the signal rate is ~100%. A filter that never filters is not a strategy — whatever this`)
  console.log(`measures, it is the family's raw drift, not momentum's selectivity. Say so in any report.`)
}
if (sig.length === 0) {
  console.log('\nnothing signalled yet; nothing to grade')
  process.exit(0)
}

const byDay = band(sig, 'day')
const byWindow = band(sig, 'windowKey')
const mirror = band(sig, 'day', 'mirrorNetCents')
console.log('')
console.log(['cluster'.padEnd(14), 'n'.padStart(6), 'G'.padStart(5), 'mean c'.padStart(9), 'lo'.padStart(9), 'hi'.padStart(9)].join(' '))
for (const [name, b] of [['day (primary)', byDay], ['window', byWindow], ['mirror (day)', mirror]]) {
  const w = b.n >= 2 && b.se > 0
  console.log([name.padEnd(14), String(b.n).padStart(6), String(b.groups).padStart(5), b.mean.toFixed(2).padStart(9), (w ? b.lo.toFixed(2) : '-').padStart(9), (w ? b.hi.toFixed(2) : '-').padStart(9)].join(' '))
}

// per-coin, for the "not carried by one coin" condition
const coins = [...new Set(sig.map((r) => r.coin))]
console.log('\nby coin:')
const perCoin = coins.map((c) => {
  const b = band(sig.filter((r) => r.coin === c), 'day')
  console.log(`  ${c.padEnd(6)} n=${String(b.n).padStart(5)} mean ${b.mean.toFixed(2).padStart(7)}c  ${fmtBand(b)}`)
  return { coin: c, mean: b.mean, n: b.n }
})

// DESCRIPTIVE ONLY - not part of the pre-registered decision, and it must never become one after the fact.
// The hunch forecaster beat the market on calibration and still lost money because its average entry was
// 97c, where a win pays 3c and a loss costs 97c. The very first six windows here showed the same shape:
// three near-identical POINT moves (28, 30, 32) whose breakeven accuracies were 96.9%, 92.4% and 66.6%.
// If this family has an edge, where it lives matters as much as whether it exists.
console.log('\nby entry price (descriptive; NOT a decision rule):')
for (const [lo, hi, label] of [[0, 0.6, '<60c'], [0.6, 0.8, '60-80c'], [0.8, 0.92, '80-92c'], [0.92, 1, '92c+']]) {
  const sub = sig.filter((r) => r.entryAsk >= lo && r.entryAsk < hi)
  if (sub.length === 0) {
    console.log(`  ${label.padEnd(8)} n=0`)
    continue
  }
  const b = band(sub, 'day')
  const wins = sub.filter((r) => r.win).length
  const breakeven = (sub.reduce((a, r) => a + r.entryAsk, 0) / sub.length) * 100
  console.log(
    `  ${label.padEnd(8)} n=${String(b.n).padStart(5)} win ${((wins / b.n) * 100).toFixed(1).padStart(5)}%  needs ~${breakeven.toFixed(1)}%  mean ${b.mean.toFixed(2).padStart(7)}c  ${fmtBand(b)}`
  )
}
// The log-odds column the flat 3c threshold ignores (backlog 67). Descriptive; gates nothing.
const withLogit = sig.filter((r) => typeof r.moveLogit === 'number')
if (withLogit.length > 0) {
  console.log('\nby log-odds move size (descriptive; the flat 3c bar does not see this):')
  for (const [lo, hi, label] of [[0, 0.5, '<0.5'], [0.5, 1, '0.5-1.0'], [1, 2, '1.0-2.0'], [2, 99, '2.0+']]) {
    const sub = withLogit.filter((r) => Math.abs(r.moveLogit) >= lo && Math.abs(r.moveLogit) < hi)
    if (sub.length === 0) {
      console.log(`  ${label.padEnd(8)} n=0`)
      continue
    }
    const b = band(sub, 'day')
    console.log(`  ${label.padEnd(8)} n=${String(b.n).padStart(5)} mean ${b.mean.toFixed(2).padStart(7)}c  ${fmtBand(b)}`)
  }
}

const depthOk = sig.filter((r) => (r.entrySizeFp ?? 0) >= (r.wantContracts ?? 1)).length / sig.length
// A coin votes only with >= 50 signalled windows behind it. The condition exists to stop one coin carrying
// the result; letting a coin with a handful of windows cast a vote defeats that with a coin flip.
const votingCoins = perCoin.filter((c) => c.n >= 50)
const positiveCoins = votingCoins.filter((c) => c.mean > 0).length
const bestCoin = perCoin.slice().sort((a, b) => b.mean - a.mean)[0]
const exBest = band(sig.filter((r) => r.coin !== bestCoin?.coin), 'day')

console.log('\n--- PRE-REGISTERED GATE ---')
const sample = [
  [`>= ${MIN_DAY_CLUSTERS} day-clusters`, days.size >= MIN_DAY_CLUSTERS, `${days.size}`],
  [`>= ${MIN_SIGNALLED} signalled windows`, sig.length >= MIN_SIGNALLED, `${sig.length}`],
  [`drop rate < ${MAX_DROP_RATE * 100}%`, (hb.dropRate ?? 0) < MAX_DROP_RATE, `${((hb.dropRate ?? 0) * 100).toFixed(2)}%`]
]
let ready = true
for (const [label, ok, got] of sample) {
  if (!ok) ready = false
  console.log(`  ${ok ? 'met    ' : 'NOT MET'} ${label.padEnd(32)} ${got}`)
}
if (!ready) {
  console.log('\nSample bar not met — no verdict may be read yet. This is deliberate: reading early is how a')
  console.log('one-cluster band killed a strategy on 2026-09-07.')
  process.exit(0)
}

const lower = [
  [`day-clustered lo > +${EDGE_BAR}c`, byDay.lo > EDGE_BAR, byDay.lo.toFixed(2)],
  ['window-clustered lo > 0', byWindow.lo > 0, byWindow.lo.toFixed(2)],
  [`depth realism >= ${MIN_DEPTH_REALISM * 100}%`, depthOk >= MIN_DEPTH_REALISM, `${(depthOk * 100).toFixed(1)}%`],
  ['>= 4 of 6 coins positive (n>=50 each)', positiveCoins >= 4 && votingCoins.length >= 4, `${positiveCoins}/${votingCoins.length} voting`],
  ['holds without the best coin', exBest.lo > 0, exBest.lo.toFixed(2)]
]
console.log('')
let all = true
for (const [label, ok, got] of lower) {
  if (!ok) all = false
  console.log(`  ${ok ? 'pass   ' : 'fail   '} ${label.padEnd(32)} ${got}`)
}
console.log('')
if (all) {
  console.log('VERDICT: CARVE-OUT JUSTIFIED for momentum on this family.')
  console.log('  NOT by lowering minMinutesToClose — that would admit every sub-15-minute market on every')
  console.log('  series into EVERY arm. Add a buildUniverse slice (alongside fadeExtra/sportsExtra) scoped')
  console.log('  to these series AND to momentum only, entered at ladder stage-1 size. See the risks doc:')
  console.log('  lead-lag already sweeps KXBTC15M/KXETH15M and could take the opposite side of the same')
  console.log('  contract; SETTLE_GRACE_MS (30min) is twice this market\'s lifetime.')
} else if (byDay.hi < EDGE_BAR) {
  console.log(`VERDICT: FLOOR STAYS. The day-clustered upper bound (${byDay.hi.toFixed(2)}c) excludes an edge`)
  console.log('  worth having. Record as a refuted hypothesis; do not reopen without a new mechanism.')
  if (mirror.lo > EDGE_BAR) {
    console.log(`  MIRROR SIGNAL: fading the drift shows ${mirror.mean.toFixed(2)}c [${mirror.lo.toFixed(2)}, ${mirror.hi.toFixed(2)}].`)
    console.log('  That is a NAMED HYPOTHESIS, not a promotion: it must clear this same gate in its own right.')
  }
} else {
  console.log('VERDICT: INCONCLUSIVE — the band straddles the bar. Pre-registered response: extend to 40')
  console.log('  day-clusters, then apply this identical rule ONCE. One extension. No further peeking.')
}
