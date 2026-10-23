// Read for docs/PREREGISTERED-leadlag-entry-filters.md. READ-ONLY: public Kalshi market results, no key, no orders.
//
//   node scripts/leadlag-filters-gate.mjs [--dir <userData>] [--since 2026-10-23T14:30:00Z] [--verdict]
//
// Grades (1) the LIVE cohort: every filled lead-lag sweep in leadlag-dislocations.jsonl since the cohort start, at its
// fill price, won or lost at Kalshi's settlement, less the logged taker fee; contract-weighted, 80% band clustered on
// the New York calendar day; and (2) the SHADOW: the first gap per market and side under 12c in
// leadlag-cadence-shadow.jsonl, one hypothetical contract at the logged Kalshi price. Only (1) decides; (2) is reported
// beside it, with what the filtered 12c+ gaps would have made.
//
// --dir: the app's userData. From a packaged app's process %APPDATA% is virtualized, so pass
// //localhost/c$/Users/<you>/AppData/Roaming/oracle-trader there.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './lib/repo-root.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const DIR = arg('--dir', join(process.env.APPDATA ?? '', 'oracle-trader'))
const SINCE = Date.parse(arg('--since', '2026-10-23T14:30:00Z'))
const READ_ON = Date.parse('2026-10-30T00:00:00Z'), LAST = Date.parse('2026-11-13T00:00:00Z')
const MIN_FILLS = 150, MIN_DAYS = 7, CAP = 12, Z80 = 1.2816
const CACHE_DIR = join(REPO, 'data', 'leadlag-filters')
const CACHE = join(CACHE_DIR, 'results.json')

const rows = (f) => existsSync(join(DIR, f)) ? readFileSync(join(DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []
const nyDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function results(tickers) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const res = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}
  for (const t of tickers) {
    if (res[t]) continue
    for (let a = 0; a < 4; a++) {
      const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${t}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
      if (r?.status === 429) { await sleep(1500 * (a + 1)); continue }
      const j = r?.ok ? await r.json() : null
      if (j?.market?.result === 'yes' || j?.market?.result === 'no') res[t] = j.market.result
      break
    }
    await sleep(120)
  }
  writeFileSync(CACHE, JSON.stringify(res))
  return res
}

/** Contract-weighted mean cents and its day-clustered 80% band. */
function band(units) {
  const n = units.reduce((s, u) => s + u.w, 0)
  if (!n) return { n: 0, days: 0, mean: null, lo: null, hi: null, dollars: 0 }
  const m = units.reduce((s, u) => s + u.c * u.w, 0) / n
  const by = new Map()
  for (const u of units) by.set(u.day, (by.get(u.day) ?? 0) + u.w * (u.c - m))
  const g = by.size
  const se = g >= 2 ? Math.sqrt((g / (g - 1)) * [...by.values()].reduce((s, v) => s + v * v, 0)) / n : Infinity
  return { n: +n.toFixed(2), days: g, mean: +m.toFixed(2), lo: +(m - Z80 * se).toFixed(2), hi: +(m + Z80 * se).toFixed(2), dollars: +(m * n / 100).toFixed(2) }
}

const live = rows('leadlag-dislocations.jsonl').filter((r) => r.executed && (r.filledContracts ?? 0) > 0 && r.fillPrice != null && Date.parse(r.ts) >= SINCE)
const shadow = rows('leadlag-cadence-shadow.jsonl').filter((r) => Date.parse(r.ts) >= SINCE && r.kalshiTicker)
const res = await results([...new Set([...live, ...shadow].map((r) => r.kalshiTicker))])

const liveUnits = []
for (const r of live) {
  const t = res[r.kalshiTicker]; if (!t) continue
  const yes = r.suggestedAction === 'BUY_KALSHI_YES'
  liveUnits.push({ day: nyDay(r.ts), w: r.filledContracts, c: 100 * ((t === 'yes') === yes ? 1 : 0) - 100 * r.fillPrice - (r.feeCents ?? 0) })
}
const kept = [], filtered = [], seen = new Set()
for (const r of shadow) {
  const t = res[r.kalshiTicker]; if (!t) continue
  const k = `${r.kalshiTicker}|${r.suggestedAction}`
  if (seen.has(k)) continue
  seen.add(k)
  const yes = r.suggestedAction === 'BUY_KALSHI_YES'
  const px = yes ? r.kalshiPrice : 1 - r.kalshiPrice
  const u = { day: nyDay(r.ts), w: 1, c: 100 * ((t === 'yes') === yes ? 1 : 0) - 100 * px - (r.feeCents ?? 0) }
  ;((r.netCents ?? 0) + (r.feeCents ?? 0) >= CAP ? filtered : kept).push(u)
}

const L = band(liveUnits), S = band(kept), F = band(filtered)
const fills = liveUnits.length
let verdict = 'WAIT'
if (Date.now() >= READ_ON && fills >= MIN_FILLS && L.days >= MIN_DAYS) {
  if (L.lo > 0) verdict = 'PASS'
  else if (L.hi < 0) verdict = 'FAIL'
  else verdict = Date.now() >= LAST ? 'INCONCLUSIVE' : 'CONTINUE'
}
console.log(`live:     ${fills} fills, ${L.n} contracts over ${L.days} NY days: ${L.mean}c/contract, 80% [${L.lo}, ${L.hi}], $${L.dollars}`)
console.log(`shadow:   first gap per market and side under ${CAP}c: ${S.n} over ${S.days} days: ${S.mean}c, 80% [${S.lo}, ${S.hi}]`)
console.log(`filtered: ${CAP}c+ gaps the live rule skipped: ${F.n}: ${F.mean}c, 80% [${F.lo}, ${F.hi}]`)
console.log(`verdict:  ${verdict} (read from 2026-10-30 at ${MIN_FILLS} fills on ${MIN_DAYS} days; INCONCLUSIVE after 2026-11-13)`)
if (process.argv.includes('--verdict')) process.exitCode = verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 2 : 1
