/**
 * Grades the market-making simulation against a rule pre-registered before the first fetch.
 *
 *   node scripts/mmsim-grade.mjs --interim   # operational health ONLY. Structurally cannot show P&L.
 *   node scripts/mmsim-grade.mjs             # the verdict. Refuses to run before the pre-registered stop.
 *
 * TWO THINGS THIS FILE EXISTS TO PREVENT
 * --------------------------------------
 * 1. PEEKING. Watching a running experiment and stopping when it looks good is how a coin flip becomes a
 *    strategy. `--interim` is not a redacted view of the verdict - it is a SEPARATE function that never
 *    reads a price, a markout or a fee field. It cannot leak the metric because it never loads it.
 * 2. RE-SLICING. One primary metric, fixed in advance. Cohorts (JOIN/IMPROVE, fee-free/fee-bearing) can
 *    only ever DOWNGRADE a PASS on sign disagreement. No secondary result can upgrade a KILL.
 *
 * WHAT A PASS MEANS, AND WHAT IT DOES NOT
 * ---------------------------------------
 * It means "not refuted". It authorises a small live confirmation run at 1 contract on fee-free series.
 * It does NOT authorise raising `quoterMaxExposure`. That is a separate decision, on live fills.
 * The prior is negative and it is this account's own: 653 maker fills at -2.6c each, on a forecast-based
 * fair value that carried BETTER information than the midpoint rule simulated here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { uniqueObservations, inDuplicateWriterWindow } from './unique-observations.mjs'

const DIR = process.env.MMSIM_DIR ?? path.join(process.env.APPDATA ?? '.', 'oracle-trader', 'mmsim')
const INTERIM = process.argv.includes('--interim')
// Operator-requested descriptive read; never emits the scheduled capital verdict.
const EXPLORATORY = process.argv.includes('--exploratory')

if (!fs.existsSync(DIR)) {
  console.log(`no simulation directory at ${DIR}`)
  process.exit(0)
}
const preFiles = fs.readdirSync(DIR).filter((f) => /^prereg-.*\.json$/.test(f))
if (preFiles.length === 0) {
  console.log('no pre-registration file; refusing to grade an unregistered run')
  process.exit(1)
}
if (preFiles.length > 1) {
  // Two registrations in one directory means two runs' rows are mixed. Refuse, rather than grade one
  // run's rows against the other's registration on directory-listing order.
  console.log(`REFUSING: ${preFiles.length} pre-registration files in ${DIR} (${preFiles.join(', ')}). One run per directory.`)
  process.exit(1)
}
const preFile = preFiles[0]
const prereg = JSON.parse(fs.readFileSync(path.join(DIR, preFile), 'utf8'))
const P = prereg.params
// Refuse before opening outcome files, not merely before displaying the computed result.
if (!INTERIM && !EXPLORATORY && Date.now() < Date.parse(prereg.stopAtIso)) {
  console.log(`REFUSING TO GRADE: the pre-registered stop is ${prereg.stopAtIso}. Use --interim for operational health.`)
  process.exit(2)
}
let rows = []
for (const f of fs.readdirSync(DIR).filter((f) => f.startsWith(prereg.runId) && f.endsWith('.jsonl'))) {
  for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* torn line */
    }
  }
}

/**
 * Wall-clock coverage: per UTC day, the minutes in which the simulator wrote ANY row, over that day's minutes inside
 * the run. The registered cycle-coverage gate counts only cycles that were written, so a dark hour cannot lower it
 * (09-19 read ~99.9% with a third of the day dark; backlog 222). Reported beside that gate, never instead of it - the
 * gate is pre-registered - and the verdict is read against both. Row timestamps only: no price, markout or fee.
 */
function wallClockLine(rows, bar) {
  const stop = Date.parse(prereg.stopAtIso)
  const end = Math.ceil((Number.isFinite(stop) ? Math.min(Date.now(), stop) : Date.now()) / 60000)
  const byDay = new Map()
  let first = Infinity
  for (const r of rows) {
    const m = Math.floor(Date.parse(r.ts) / 60000)
    if (!Number.isFinite(m)) continue
    first = Math.min(first, m)
    const d = Math.floor(m / 1440)
    if (!byDay.has(d)) byDay.set(d, new Set())
    byDay.get(d).add(m)
  }
  const start = Math.floor(Date.parse(prereg.startedAtIso) / 60000)
  let got = 0
  let possible = 0
  const low = []
  for (let m = Number.isFinite(start) ? start : first; m < end; ) {
    const d = Math.floor(m / 1440)
    const next = Math.min(end, (d + 1) * 1440)
    const n = [...(byDay.get(d) ?? [])].filter((x) => x >= m && x < next).length
    got += n
    possible += next - m
    if (n < bar * (next - m)) low.push(`${new Date(d * 86400000).toISOString().slice(0, 10)} ${n}/${next - m} min`)
    m = next
  }
  return `  wall-clock coverage  ${possible ? ((got / possible) * 100).toFixed(1) : '0.0'}% of ${possible} min   (reported, not gated; UTC days under ${(bar * 100).toFixed(0)}%: ${low.join(', ') || 'none'})`
}

/**
 * INTERIM: operational health only. The ONLY fields this function may touch are listed here, and none of
 * them is a price, a markout or a fee. If you find yourself wanting to add one, you want to peek.
 */
function interim() {
  const cycles = rows.filter((r) => r.event === 'cycle')
  const fills = rows.filter((r) => r.event === 'fill')
  const quotes = rows.filter((r) => r.event === 'quote')
  const t429 = rows.filter((r) => r.event === 'http429')
  const halts = rows.filter((r) => r.event === 'halt')
  // Same admissibility as the gate (>= 5 fills in a day), so the interim readout cannot overstate readiness.
  const dayCounts = {}
  for (const f of fills) {
    const d = String(f.fillTsIso ?? f.ts).slice(0, 10)
    dayCounts[d] = (dayCounts[d] ?? 0) + 1
  }
  const days = new Set(Object.keys(dayCounts).filter((d) => dayCounts[d] >= 5))
  const perDay = {}
  for (const f of fills) {
    const d = String(f.fillTsIso ?? f.ts).slice(0, 10)
    perDay[d] = (perDay[d] ?? 0) + 1
  }
  const okCycles = cycles.filter((c) => c.ok).length
  const remainMs = Date.parse(prereg.stopAtIso) - Date.now()
  console.log(`run ${prereg.runId}  started ${prereg.startedAtIso}`)
  console.log(`stops ${prereg.stopAtIso}  (${remainMs > 0 ? (remainMs / 86400000).toFixed(1) + ' days remaining' : 'COMPLETE'})`)
  console.log('')
  console.log(`  quotes placed        ${quotes.length}`)
  console.log(`  simulated fills      ${fills.length}    (gate needs ${P.minFills})`)
  console.log(`  days with a fill     ${days.size}    (gate needs ${P.minDayClusters} admissible clusters)`)
  console.log(`  cycle coverage       ${cycles.length ? ((okCycles / cycles.length) * 100).toFixed(1) : 0}%   (gate needs ${(P.minCoverage * 100).toFixed(0)}%)`)
  console.log(wallClockLine(rows, P.minCoverage))
  console.log(`  distinct markets     ${new Set(fills.map((f) => f.marketId)).size}`)
  console.log(`  distinct series      ${new Set(fills.map((f) => f.series)).size}`)
  console.log(`  throttles (429)      ${t429.length}`)
  console.log(`  halts                ${halts.length}${halts.length ? ' -> ' + halts.map((h) => h.reason).join(', ') : ''}`)
  console.log('')
  const busiest = Object.entries(perDay).sort((a, b) => b[1] - a[1])[0]
  if (busiest && fills.length) {
    const share = (busiest[1] / fills.length) * 100
    console.log(`  busiest day is ${share.toFixed(1)}% of all fills${share > 15 ? '   <-- over the 15% concentration guard' : ''}`)
  }
  console.log('\nNo P&L is shown and none can be: this function never reads a price, markout or fee field.')
  console.log('That is deliberate. Stopping an experiment when it looks good is how a coin flip becomes a strategy.')
}

if (INTERIM) {
  interim()
  process.exit(0)
}

// ---- the verdict path. Refuses to run early. ----
const now = Date.now()
const stopAt = Date.parse(prereg.stopAtIso)
if (!EXPLORATORY && now < stopAt) {
  const days = (stopAt - now) / 86400000
  console.log(`REFUSING TO GRADE: the pre-registered stop is ${prereg.stopAtIso}, ${days.toFixed(1)} days away.`)
  console.log('Use --interim for operational health. There is no early read, by design.')
  process.exit(2)
}

// AMENDMENT 2026-09-19 (REVIEW-CHANGES §136), fixed 28 days before the read and without reading an outcome.
// On 2026-09-15 06:20-08:22Z a second copy of the simulator ran beside the first. Both loaded the same state file
// at start and then ran their own books (state is read once, at launch), so the file holds two interleaved
// histories under the same sequence IDs and no row says which copy wrote it. Keeping either row of a pair would splice the two (one public trade filled in both
// books counts twice). So BOTH rows of every conflicting ID are dropped, with every row that shares a fill ID with
// one - the rule the exploratory read has used since 2026-09-16. It applies to the verdict only when every
// conflicting row lies inside that window; a conflict anywhere else is unexplained and still refuses a verdict below.
{
  const byKey = new Map(), conflicts = new Set()
  let unexplained = 0
  for (const r of rows) {
    const key = `${r.runId}:${r.seq}`, prior = byKey.get(key)
    if (prior && JSON.stringify(prior) !== JSON.stringify(r)) {
      conflicts.add(key)
      if (!inDuplicateWriterWindow(prior) || !inDuplicateWriterWindow(r)) unexplained++
    } else byKey.set(key, r)
  }
  if (EXPLORATORY || (conflicts.size && !unexplained)) {
    const ambiguousFills = new Set(rows.filter(r => conflicts.has(`${r.runId}:${r.seq}`)).map(r => r.fillId).filter(Boolean))
    const before = rows.length
    rows = rows.filter(r => !conflicts.has(`${r.runId}:${r.seq}`) && !ambiguousFills.has(r.fillId))
    console.log(EXPLORATORY
      ? `EXPLORATORY integrity exclusion: ${conflicts.size} conflicting sequence IDs; ${before - rows.length} rows and all associated fill IDs excluded. Raw files unchanged; this subset cannot qualify the registered run.`
      : `Integrity exclusion (amendment 2026-09-19): ${conflicts.size} conflicting sequence IDs, all inside the 2026-09-15 duplicate-writer window; ${before - rows.length} rows and all associated fill IDs excluded. Raw files unchanged.`)
  }
}
const integrity = uniqueObservations(rows, r => r.runId && Number.isSafeInteger(r.seq) ? `${r.runId}:${r.seq}` : undefined)
if (integrity.conflicts) { console.log(`INCONCLUSIVE: ${integrity.conflicts} conflicting sequence records; raw data preserved for integrity review.`); process.exit(2) }
rows = integrity.rows
console.log(`Exact duplicate records excluded: ${integrity.duplicates}`)
const fills = rows.filter((r) => r.event === 'fill')
const mk15 = new Map(rows.filter((r) => r.event === 'markout15').map((r) => [r.fillId, r.markoutC]))
const graded = []
for (const f of fills) {
  const m = mk15.get(f.fillId)
  if (m === undefined) continue
  graded.push({
    day: String(f.fillTsIso ?? f.ts).slice(0, 10),
    series: f.series,
    marketId: f.marketId,
    cohort: f.cohortQueue,
    feeType: f.feeType,
    // The primary metric, fixed in advance: 15-minute markout on our side, minus the fee actually billed
    // at the clip size the live book can hold.
    net15: m - (f.feeCents1 ?? 0)
  })
}

console.log(`fills ${fills.length}  |  with a 15-min markout ${graded.length}  (${fills.length ? ((graded.length / fills.length) * 100).toFixed(1) : 0}% coverage)`)

/** Day-clustered bootstrap. The day-mean is the unit; D is small and day-means are not Gaussian. */
function bootstrap(items, B = 10000) {
  const byDay = new Map()
  for (const g of items) {
    const a = byDay.get(g.day) ?? []
    a.push(g.net15)
    byDay.set(g.day, a)
  }
  const dayMeans = [...byDay.entries()].filter(([, a]) => a.length >= 5).map(([d, a]) => ({ d, m: a.reduce((x, y) => x + y, 0) / a.length, n: a.length }))
  const D = dayMeans.length
  if (D < 2) return { D, point: NaN, p10: NaN, p90: NaN }
  const point = dayMeans.reduce((a, x) => a + x.m, 0) / D
  // Deterministic resampling: a fixed LCG so a re-grade of the same data gives the same band.
  let seed = 20260912
  // Divide by 2^31, not 2^31-1: the masked value can equal 0x7fffffff, and /0x7fffffff would then yield
  // exactly 1.0 and index one past the end of dayMeans.
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x80000000)
  const means = []
  for (let b = 0; b < B; b++) {
    let s = 0
    for (let i = 0; i < D; i++) s += dayMeans[Math.floor(rnd() * D)].m
    means.push(s / D)
  }
  means.sort((a, b) => a - b)
  return { D, point, p10: means[Math.floor(0.1 * B)], p90: means[Math.floor(0.9 * B)], dayMeans }
}

const all = bootstrap(graded)
console.log(`\nday-clustered bootstrap: ${all.D} admissible clusters, point ${all.point.toFixed(2)}c, 10th pct ${all.p10.toFixed(2)}c, 90th pct ${all.p90.toFixed(2)}c`)

// ---- floors and degeneracy guards; any failure forces INCONCLUSIVE, never PASS ----
const cycles = rows.filter((r) => r.event === 'cycle')
const coverage = cycles.length ? cycles.filter((c) => c.ok).length / cycles.length : 0
const mkCoverage = fills.length ? graded.length / fills.length : 0
const share = (key) => {
  const c = new Map()
  for (const g of graded) c.set(g[key], (c.get(g[key]) ?? 0) + 1)
  return Math.max(0, ...c.values()) / Math.max(1, graded.length)
}
const guards = [
  [`>= ${P.minFills} fills`, graded.length >= P.minFills, graded.length],
  [`>= ${P.minDayClusters} day-clusters`, all.D >= P.minDayClusters, all.D],
  [`cycle coverage >= ${(P.minCoverage * 100).toFixed(0)}%`, coverage >= P.minCoverage, (coverage * 100).toFixed(1) + '%'],
  [`markout coverage >= ${(P.minMarkoutCoverage * 100).toFixed(0)}%`, mkCoverage >= P.minMarkoutCoverage, (mkCoverage * 100).toFixed(1) + '%'],
  ['no day > 15% of fills', share('day') <= 0.15, (share('day') * 100).toFixed(1) + '%'],
  ['no series > 40% of fills', share('series') <= 0.4, (share('series') * 100).toFixed(1) + '%'],
  ['no market > 10% of fills', share('marketId') <= 0.1, (share('marketId') * 100).toFixed(1) + '%'],
  ['>= 8 distinct series', new Set(graded.map((g) => g.series)).size >= 8, new Set(graded.map((g) => g.series)).size]
]
console.log('')
let admissible = true
for (const [label, ok, got] of guards) {
  if (!ok) admissible = false
  console.log(`  ${ok ? 'met    ' : 'NOT MET'} ${String(label).padEnd(34)} ${got}`)
}
console.log(wallClockLine(rows, P.minCoverage))

// Cohorts: may only downgrade a PASS on sign disagreement. They can never upgrade anything.
const cohorts = {}
for (const [k, sel] of [
  ['JOIN', (g) => g.cohort === 'JOIN'],
  ['IMPROVE', (g) => g.cohort === 'IMPROVE'],
  ['fee-free', (g) => g.feeType !== 'quadratic_with_maker_fees'],
  ['fee-bearing', (g) => g.feeType === 'quadratic_with_maker_fees']
]) {
  const b = bootstrap(graded.filter(sel), 2000)
  cohorts[k] = b
  console.log(`  cohort ${k.padEnd(12)} D=${b.D} point ${Number.isFinite(b.point) ? b.point.toFixed(2) + 'c' : '-'}`)
}
// Two different facts, kept apart: a cohort that could not be bootstrapped (too few day-clusters) is not a
// cohort that disagrees. Either one blocks a PASS; only one of them is a sign disagreement.
const cohortsMeasurable = Number.isFinite(cohorts.JOIN.point) && Number.isFinite(cohorts.IMPROVE.point)
const signsAgree = cohortsMeasurable && Math.sign(cohorts.JOIN.point) === Math.sign(cohorts.IMPROVE.point)

if (EXPLORATORY) {
  console.log('\nEXPLORATORY READ — operator requested; not the scheduled verdict or authority to trade live.')
  console.log(`Run began ${prereg.startedAtIso}; scheduled stop ${prereg.stopAtIso}. Primary metric is a 15-minute markout after entry fees, NOT realized trading profit.`)
  console.log('Collection and the registered rule remain unchanged. Repeated early reads cannot establish a confirmatory PASS.')
  process.exit(0)
}
console.log('\n--- VERDICT ---')
let exitCode = 4
if (!admissible) {
  console.log('INCONCLUSIVE - a floor or degeneracy guard was not met.')
  console.log('This is a DO-NOT-PURSUE for capital purposes. It does not authorise extending the run,')
  console.log('re-slicing by cohort, or grading on the 5-minute markout instead. A new question needs a')
  console.log('new pre-registration and a fresh 35-day clock.')
} else if (all.p10 >= P.passLowerC && signsAgree) {
  exitCode = 0
  console.log(`PASS - the 10th percentile of the day-clustered mean is ${all.p10.toFixed(2)}c, clearing +${P.passLowerC}c,`)
  console.log('and the JOIN/IMPROVE cohorts agree in sign.')
  console.log('\nThis means NOT REFUTED. It authorises a 14-day live confirmation run at 1 contract on')
  console.log('fee-free series with quoterMaxExposure UNCHANGED. It does not authorise raising the cap.')
} else if (all.p90 <= P.killUpperC) {
  exitCode = 3
  console.log(`KILL - the 90th percentile of the day-clustered mean is ${all.p90.toFixed(2)}c, at or below +${P.killUpperC}c.`)
  console.log('Naive spread capture does not pay on this venue at this scale. Record as refuted and do not')
  console.log('reopen without a new mechanism. This agrees with the prior: 653 real maker fills at -2.6c.')
} else if (all.p10 >= P.passLowerC && !cohortsMeasurable) {
  const thin = ['JOIN', 'IMPROVE'].filter((k) => !Number.isFinite(cohorts[k].point))
  console.log(`INCONCLUSIVE - the day-clustered 10th percentile (${all.p10.toFixed(2)}c) cleared +${P.passLowerC}c, but the`)
  console.log(`${thin.join(' and ')} cohort${thin.length > 1 ? 's have' : ' has'} too few day-clusters to bootstrap (${thin.map((k) => `${k} D=${cohorts[k].D}`).join(', ')}).`)
  console.log('A PASS requires both queue cohorts to be measurable and to agree in sign. Do-not-pursue for capital.')
} else if (all.p10 >= P.passLowerC && !signsAgree) {
  // Say what actually happened: the primary band cleared the bar and a cohort sign disagreement pulled it
  // down. That is a different fact from a straddling band and the operator should be told which it was.
  console.log(`INCONCLUSIVE - the day-clustered 10th percentile (${all.p10.toFixed(2)}c) cleared +${P.passLowerC}c, but the`)
  console.log(`JOIN and IMPROVE cohorts disagree in sign (JOIN ${cohorts.JOIN.point.toFixed(2)}c, IMPROVE ${cohorts.IMPROVE.point.toFixed(2)}c).`)
  console.log('A secondary result can downgrade a PASS; it can never upgrade anything. Do-not-pursue for capital.')
} else {
  console.log('INCONCLUSIVE - the band straddles the decision bar.')
  console.log(`Observed: 10th pct ${all.p10.toFixed(2)}c (PASS needs >= +${P.passLowerC}c), 90th pct ${all.p90.toFixed(2)}c (KILL needs <= +${P.killUpperC}c).`)
  console.log('That dead zone was disclosed before collection. Treat as do-not-pursue for capital purposes.')
}
process.exit(exitCode)
