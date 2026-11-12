// Read for docs/PREREGISTERED-polyus-k15.md. READ-ONLY: the recorder's quote file and public Kalshi results.
//
//   node scripts/polyus-k15-gate.mjs [--dir <userData>] [--since 2026-11-12T00:00:00Z] [--verdict]
//
// Two legs on the same 15-minute Bitcoin window (both venues settle on BRTI):
//   kalshi : buy on Kalshi when Polymarket US's mid is past Kalshi's ask (YES) or bid (NO), fee 0.07 p(1-p)
//   polyus : buy on Polymarket US when Kalshi's mid is past its ask or bid, fee 0.095 p(1-p) to the cent
// Unit: the FIRST quote row per market, side and leg whose gap net of that leg's fee is at least N cents, one
// contract at the logged executable price, held to Kalshi's settlement. 90% band per leg (two legs), clustered on
// the New York day. --dir: pass //localhost/c$/Users/<you>/AppData/Roaming/oracle-trader from a packaged-app shell.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './lib/repo-root.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const DIR = arg('--dir', join(process.env.APPDATA ?? '', 'oracle-trader'))
const SINCE = Date.parse(arg('--since', '2026-11-12T00:00:00Z'))
const READ_ON = Date.parse('2026-11-26T00:00:00Z'), LAST = Date.parse('2026-12-10T00:00:00Z')
const PRIMARY_NET = 4, MIN_N = 100, MIN_DAYS = 10, Z90 = 1.6449
const CACHE_DIR = join(REPO, 'data', 'polyus-k15'), CACHE = join(CACHE_DIR, 'results.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nyDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const kFee = (p) => 7 * p * (1 - p)
const uFee = (p) => Math.round(9.5 * p * (1 - p))

const path = join(DIR, 'polyus-k15-quotes.jsonl')
const rows = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((r) => r && Date.parse(r.ts) >= SINCE) : []
mkdirSync(CACHE_DIR, { recursive: true })
const res = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}
for (const t of new Set(rows.map((r) => r.t))) {
  if (res[t]) continue
  const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${t}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
  const j = r?.ok ? await r.json() : null
  if (j?.market?.result === 'yes' || j?.market?.result === 'no') res[t] = j.market.result
  await sleep(120)
}
writeFileSync(CACHE, JSON.stringify(res))

function band(units) {
  const n = units.length
  if (n < 2) return { n, days: new Set(units.map((u) => u.day)).size, mean: null, lo: null, hi: null }
  const m = units.reduce((s, u) => s + u.c, 0) / n
  const by = new Map()
  for (const u of units) by.set(u.day, (by.get(u.day) ?? 0) + u.c - m)
  const g = by.size
  const se = g >= 2 ? Math.sqrt((g / (g - 1)) * [...by.values()].reduce((s, v) => s + v * v, 0)) / n : Infinity
  return { n, days: g, mean: +m.toFixed(2), lo: +(m - Z90 * se).toFixed(2), hi: +(m + Z90 * se).toFixed(2) }
}

/** Candidate entries in one row: [leg, side, price paid, net cents after that leg's fee]. */
function entries(r) {
  const uMid = (r.ub + r.ua) / 2, kMid = (r.kb + r.ka) / 2
  return [
    ['kalshi', 'YES', r.ka, 100 * (uMid - r.ka) - kFee(r.ka)],
    ['kalshi', 'NO', 1 - r.kb, 100 * (r.kb - uMid) - kFee(1 - r.kb)],
    ['polyus', 'YES', r.ua, 100 * (kMid - r.ua) - uFee(r.ua)],
    ['polyus', 'NO', 1 - r.ub, 100 * (r.ub - kMid) - uFee(1 - r.ub)]
  ]
}
function grade(minNet, minLeftMs = 60_000) {
  const seen = new Set(), out = { kalshi: [], polyus: [] }
  for (const r of rows) {
    if (!res[r.t] || r.end - Date.parse(r.ts) < minLeftMs) continue
    for (const [leg, side, px, net] of entries(r)) {
      const k = `${r.t}|${leg}|${side}`
      if (net < minNet || seen.has(k) || !(px > 0.02 && px < 0.98)) continue
      seen.add(k)
      const won = (res[r.t] === 'yes') === (side === 'YES')
      out[leg].push({ day: nyDay(r.ts), c: 100 * ((won ? 1 : 0) - px) - (leg === 'kalshi' ? kFee(px) : uFee(px)) })
    }
  }
  return out
}

console.log(`${rows.length} quote rows, ${new Set(rows.map((r) => r.t)).size} windows, ${Object.keys(res).length} settled`)
const verdicts = {}
for (const net of [2, 4, 6, 8]) {
  const g = grade(net)
  for (const leg of ['kalshi', 'polyus']) {
    const b = band(g[leg])
    let v = ''
    if (net === PRIMARY_NET) {
      v = 'WAIT'
      if (Date.now() >= READ_ON && b.n >= MIN_N && b.days >= MIN_DAYS) v = b.lo > 0 ? 'PASS' : b.hi < 0 ? 'FAIL' : Date.now() >= LAST ? 'INCONCLUSIVE' : 'CONTINUE'
      verdicts[leg] = v
    }
    console.log(`net >= ${net}c  buy on ${leg.padEnd(6)} n=${String(b.n).padStart(4)} days=${b.days}  ${b.mean}c/contract, 90% [${b.lo}, ${b.hi}] ${v}`)
  }
}
console.log(`primary: first gap of ${PRIMARY_NET}c net per market, side and leg; read from 2026-11-26 at ${MIN_N} entries on ${MIN_DAYS} days per leg`)
if (process.argv.includes('--verdict')) process.exitCode = Object.values(verdicts).includes('PASS') ? 0 : 1
