/**
 * Paired comparison of the incumbent forecaster against the frontier challenger (round 77).
 *
 *   node scripts/hunch-paired.mjs
 *
 * WHY THIS EXISTS RATHER THAN RUNNING hunch-gate.mjs TWICE
 * -------------------------------------------------------
 * `hunch-gate.mjs` grades whichever directory it is pointed at. Running it on `hunches/` and again on
 * `hunches-challenger/` and comparing the two Brier scores compares TWO DIFFERENT MARKET POPULATIONS, not
 * two models - and it would look perfectly reasonable while doing it.
 *
 * The populations genuinely differ, by construction. The challenger has a hard daily cap
 * (`hunchChallengerMaxPerDay`, 40) and the incumbent does not, so the challenger only ever sees the first
 * ~40 markets of each day - which, because eligible markets are sorted soonest-closing-first, is a
 * systematically shorter-horizon slice. On 2026-09-12: 116 incumbent rows, 42 challenger rows, 42 paired,
 * 74 the challenger never saw.
 *
 * Round 77 was designed as "paired, not parallel" precisely so the comparison would be model-vs-model
 * rather than population-vs-population. This enforces that at grading time: only markets where BOTH models
 * produced a forecast, and a per-market DIFFERENCE as the unit of observation.
 *
 * The daily cap is a cost control and stays. Its selection effect is harmless to a paired test (both models
 * see identical inputs) and is NOT harmless to generalisation - so the horizon profile of the paired set is
 * reported, because "the challenger is better" would mean less if it were only ever asked easy questions.
 */
import fs from 'node:fs'
import path from 'node:path'

const UD = path.join(process.env.APPDATA ?? '', 'oracle-trader')
const INC = path.join(UD, 'hunches')
const CH = path.join(UD, 'hunches-challenger')

function load(dir) {
  const out = new Map()
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line)
        const t = r.t ?? r.ticker
        // First sighting per ticker: the forecast that was actually made at decision time.
        if (t && !out.has(t)) out.set(t, { ...r, day: f.slice(0, 10) })
      } catch {
        /* torn line */
      }
    }
  }
  return out
}

let settled = {}
try {
  settled = JSON.parse(fs.readFileSync(path.join(INC, 'settled-cache.json'), 'utf8'))
} catch {
  /* none yet */
}
const resultOf = (t) => {
  const v = settled[t]
  if (typeof v === 'string') return ['yes', 'no'].includes(v.toLowerCase()) ? v.toLowerCase() : null
  if (v && typeof v === 'object') {
    for (const k of ['result', 'settlement', 'outcome']) {
      const x = v[k]
      if (typeof x === 'string' && ['yes', 'no'].includes(x.toLowerCase())) return x.toLowerCase()
    }
  }
  return null
}

const inc = load(INC)
const ch = load(CH)
const pairedAll = [...ch.keys()].filter((t) => inc.has(t))
console.log(`incumbent forecasts ${inc.size}   challenger ${ch.size}   paired ${pairedAll.length}   incumbent-only ${inc.size - pairedAll.length}`)

const rows = []
for (const t of pairedAll) {
  const b = ch.get(t)
  const res = resultOf(t)
  if (res === null) continue
  const y = res === 'yes' ? 1 : 0
  // THE PAIR IS ON THE CHALLENGER ROW. incumbentP was recorded by the same call - same market, same moment,
  // same headlines. Looking the incumbent up in its own ledger by ticker could pair a day-1 incumbent
  // forecast with a day-3 challenger forecast: different moments, different news, not a pair.
  const pb = typeof b.p === 'number' ? b.p : null
  const pa = typeof b.incumbentP === 'number' ? b.incumbentP : null
  // Metadata only (mid, horizon), and only from the incumbent row made on the SAME day as the challenger's.
  const ai = inc.get(t)
  const a = ai && ai.day === b.day ? ai : b
  if (pa === null || pb === null) continue
  const mid = typeof a.mid === 'number' ? a.mid : null
  rows.push({
    t,
    day: b.day,
    y,
    pa,
    pb,
    mid,
    hours: typeof a.hoursToClose === 'number' ? a.hoursToClose : null,
    ba: (pa - y) ** 2,
    bb: (pb - y) ** 2,
    bm: mid === null ? null : (mid - y) ** 2
  })
}
console.log(`paired AND settled: ${rows.length}\n`)
if (rows.length < 20) {
  console.log('Fewer than 20 settled pairs - nothing meaningful to report yet.')
  console.log('The challenger started 2026-09-12 and most of its markets close days out.')
  process.exit(0)
}

/** Day-clustered mean of a per-market quantity, with the under-three-cluster floor the ladder uses. */
function band(vals, days) {
  const n = vals.length
  const mean = vals.reduce((a, b) => a + b, 0) / n
  const by = new Map()
  for (let i = 0; i < n; i++) {
    const g = by.get(days[i]) ?? { n: 0, sum: 0 }
    g.n++
    g.sum += vals[i]
    by.set(days[i], g)
  }
  const gs = [...by.values()]
  const G = gs.length
  const clustered = (Math.sqrt(gs.reduce((a, x) => a + (x.sum - x.n * mean) ** 2, 0)) / n) * (G > 1 ? Math.sqrt(G / (G - 1)) : 1)
  const plain = n > 1 ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) / n) : 0
  const se = G < 3 ? Math.max(clustered, plain) : clustered
  return { n, G, mean, se, lo: mean - 1.96 * se, hi: mean + 1.96 * se }
}
const fmt = (b) => (b.n < 2 || !(b.se > 0) ? `n=${b.n} - no width, not an interval` : `[${b.lo.toFixed(4)}, ${b.hi.toFixed(4)}]`)

const days = rows.map((r) => r.day)
const bi = band(rows.map((r) => r.ba), days)
const bc = band(rows.map((r) => r.bb), days)
const withMid = rows.filter((r) => r.bm !== null)
const bm = withMid.length >= 2 ? band(withMid.map((r) => r.bm), withMid.map((r) => r.day)) : null

console.log('BRIER (lower is better), on the IDENTICAL paired set:')
console.log(`  incumbent   ${bi.mean.toFixed(4)}`)
console.log(`  challenger  ${bc.mean.toFixed(4)}`)
if (bm) console.log(`  market mid  ${bm.mean.toFixed(4)}`)

// The paired difference is the unit: same market, same moment, same headlines. Differencing removes all
// market-level difficulty, which is exactly what an unpaired comparison of two ledgers cannot do.
const diff = band(rows.map((r) => r.bb - r.ba), days)
console.log(`\nPAIRED DIFFERENCE (challenger - incumbent), ${diff.G} day-cluster(s):`)
console.log(`  mean ${diff.mean.toFixed(4)}  95% ${fmt(diff)}`)
const verdict =
  diff.n < 2 || !(diff.se > 0)
    ? 'no width - not an interval'
    : diff.hi < 0
      ? 'CHALLENGER better (band wholly below zero)'
      : diff.lo > 0
        ? 'INCUMBENT better (band wholly above zero)'
        : 'no separation - the band straddles zero'
console.log(`  -> ${verdict}`)

// Agreement profile, descriptive only.
const d = rows.map((r) => Math.abs(r.pa - r.pb))
d.sort((a, b) => a - b)
console.log(`\nagreement: median |p_inc - p_ch| ${d[Math.floor(d.length / 2)].toFixed(3)}, max ${d[d.length - 1].toFixed(3)}`)

// Horizon profile of the paired set. The daily cap means the challenger only ever sees the soonest-closing
// markets, which does not harm the paired test but does bound what it generalises to. Say so.
const hs = rows.map((r) => r.hours).filter((h) => typeof h === 'number').sort((a, b) => a - b)
if (hs.length) {
  console.log(`horizon of the paired set: median ${hs[Math.floor(hs.length / 2)].toFixed(1)}h, range ${hs[0].toFixed(1)}-${hs[hs.length - 1].toFixed(1)}h`)
  console.log('(the challenger is capped at 40/day and markets are hunched soonest-closing-first, so this')
  console.log(' set is a SHORT-HORIZON slice - the paired test is valid on it, but does not generalise past it)')
}
console.log(`\nday-clusters: ${diff.G}. Under 5 this says almost nothing; the sign can flip on one day's news.`)
