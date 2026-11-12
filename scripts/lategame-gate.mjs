// Read for docs/PREREGISTERED-lategame.md. READ-ONLY: the recorder's rows and public Kalshi results.
//
//   node scripts/lategame-gate.mjs [--dir data/lategame] [--verdict]
//
// Unit: one game. In the final period of regulation or overtime, the team ahead on the scoreboard, when its Kalshi
// YES ask is 70-95c with at least one contract offered:
//   blind : the first such row of the game
//   gated : the first such row where Polymarket's mid for that team is at least 4c above Kalshi's ask
// One contract at Kalshi's ask, held to settlement, after the taker fee rounded up to a whole cent (what one
// contract really pays). 90% band per leg (two legs), clustered on the New York day.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './lib/repo-root.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const DIR = arg('--dir', join(REPO, 'data', 'lategame'))
const READ_ON = Date.parse('2026-11-27T00:00:00Z'), LAST = Date.parse('2026-12-18T00:00:00Z')
const MIN_N = 100, MIN_DAYS = 10, Z90 = 1.6449, GATE = 0.04, LO = 0.70, HI = 0.95
const FINAL = { nba: 4, nfl: 4, nhl: 3 }
const CACHE = join(DIR, 'results.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nyDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
export const fee1 = (p) => Math.ceil(7 * p * (1 - p) - 1e-9)

/** The leader's entry in one row, or null. `gated` is true when Polymarket's mid is at least GATE past Kalshi's ask. */
export function entryOf(r) {
  if (r.st !== 'in' || !(r.per >= FINAL[r.lg]) || r.sa == null || r.sh == null || r.sa === r.sh) return null
  const away = r.sa > r.sh, k = away ? r.ka : r.kh
  if (!k || !(k.a >= LO && k.a <= HI) || !(k.as >= 1)) return null
  const pMid = r.pa ? (away ? (r.pa.b + r.pa.a) / 2 : 1 - (r.pa.b + r.pa.a) / 2) : null
  const pOk = !!r.pa && r.pa.a - r.pa.b <= 0.05 + 1e-9
  return { t: k.t, px: k.a, gated: pOk && pMid - k.a >= GATE - 1e-9, side: away ? 'ka' : 'kh' }
}

export function band(units) {
  const n = units.length
  if (n < 2) return { n, days: new Set(units.map((u) => u.day)).size, mean: null, lo: null, hi: null }
  const m = units.reduce((s, u) => s + u.c, 0) / n
  const by = new Map()
  for (const u of units) by.set(u.day, (by.get(u.day) ?? 0) + u.c - m)
  const g = by.size
  const se = g >= 2 ? Math.sqrt((g / (g - 1)) * [...by.values()].reduce((s, v) => s + v * v, 0)) / n : Infinity
  return { n, days: g, mean: +m.toFixed(2), lo: +(m - Z90 * se).toFixed(2), hi: +(m + Z90 * se).toFixed(2) }
}

if (process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('scripts/lategame-gate.mjs')) {
  mkdirSync(DIR, { recursive: true })
  const rows = readdirSync(DIR).filter((f) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort().flatMap((f) => readFileSync(join(DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean))
  const byGame = new Map()
  for (const r of rows) { const k = `${r.lg}:${r.g}`; if (!byGame.has(k)) byGame.set(k, []); byGame.get(k).push(r) }
  const picks = { blind: [], gated: [] }
  for (const rs of byGame.values()) {
    const done = {}
    for (let i = 0; i < rs.length; i++) {
      const e = entryOf(rs[i])
      if (!e) continue
      for (const leg of ['blind', 'gated']) {
        if (done[leg] || (leg === 'gated' && !e.gated)) continue
        done[leg] = true
        // The same contract's bid at the first row at least 60 s later: printed beside the result, decides nothing.
        const later = rs.slice(i + 1).find((x) => Date.parse(x.ts) - Date.parse(rs[i].ts) >= 60_000)
        picks[leg].push({ ...e, ts: rs[i].ts, lg: rs[i].lg, bid60: later?.[e.side]?.b ?? null })
      }
    }
  }
  const res = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}
  for (const t of new Set([...picks.blind, ...picks.gated].map((p) => p.t))) {
    if (res[t]) continue
    const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${t}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
    const j = r?.ok ? await r.json() : null
    if (j?.market?.result === 'yes' || j?.market?.result === 'no') res[t] = j.market.result
    await sleep(120)
  }
  writeFileSync(CACHE, JSON.stringify(res))
  console.log(`${rows.length} rows, ${byGame.size} games`)
  const verdicts = {}
  for (const leg of ['blind', 'gated']) {
    const units = picks[leg].filter((p) => res[p.t]).map((p) => ({ day: nyDay(p.ts), c: 100 * ((res[p.t] === 'yes' ? 1 : 0) - p.px) - fee1(p.px), lg: p.lg }))
    const b = band(units)
    let v = 'WAIT'
    if (Date.now() >= READ_ON && b.n >= MIN_N && b.days >= MIN_DAYS) v = b.lo > 0 ? 'PASS' : b.hi < 0 ? 'FAIL' : Date.now() >= LAST ? 'INCONCLUSIVE' : 'CONTINUE'
    else if (Date.now() >= LAST) v = 'INCONCLUSIVE'
    verdicts[leg] = v
    const m60 = picks[leg].filter((p) => p.bid60 != null)
    const mark = m60.length ? (100 * m60.reduce((s, p) => s + p.bid60 - p.px, 0) / m60.length).toFixed(1) : 'n/a'
    console.log(`${leg.padEnd(5)} n=${String(b.n).padStart(4)} days=${b.days}  ${b.mean}c/contract, 90% [${b.lo}, ${b.hi}] ${v}   (${picks[leg].length - units.length} unsettled; bid 60 s later vs price paid: ${mark}c)`)
    for (const lg of ['nba', 'nfl', 'nhl']) { const x = band(units.filter((u) => u.lg === lg)); if (x.n) console.log(`        ${lg} n=${x.n} ${x.mean}c [${x.lo}, ${x.hi}]  (scored only)`) }
  }
  console.log(`read from 2026-11-27 at ${MIN_N} games on ${MIN_DAYS} days per leg; INCONCLUSIVE after 2026-12-18`)
  if (process.argv.includes('--verdict')) process.exitCode = Object.values(verdicts).includes('PASS') ? 0 : 1
}
