#!/usr/bin/env node
/** Grades the pre-registered 10-second versus 60-second lead-lag shadow. Never trades. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SHADOW = join(process.env.APPDATA ?? '', 'oracle-trader', 'leadlag-cadence-shadow.jsonl')
const READ_AT = Date.parse('2026-09-21T00:00:00Z')
const MIN_PAIRS = 300
const MIN_DAYS = 5
const T95 = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131 }

const pnl = (row, result) => {
  const yes = String(row.suggestedAction).endsWith('_YES')
  const cost = yes ? Number(row.kalshiPrice) : 1 - Number(row.kalshiPrice)
  return (result === (yes ? 'yes' : 'no') ? 1 : 0) - cost - Number(row.feeCents ?? 0) / 100
}

function pairedBand(rows) {
  const mean = rows.reduce((s, r) => s + r.diff, 0) / rows.length
  const byDay = new Map()
  for (const row of rows) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.diff - mean)
  const days = byDay.size
  if (days < 2) return { mean, lo: null, hi: null, days }
  const ss = [...byDay.values()].reduce((s, x) => s + x * x, 0)
  const se = Math.sqrt((ss * days) / ((days - 1) * rows.length * rows.length))
  const t = T95[days - 1] ?? 1.96
  return { mean, lo: mean - t * se, hi: mean + t * se, days }
}

function selftest() {
  const yes = { suggestedAction: 'BUY_KALSHI_YES', kalshiPrice: 0.4, feeCents: 2 }
  const no = { suggestedAction: 'BUY_KALSHI_NO', kalshiPrice: 0.7, feeCents: 1 }
  const ok = Math.abs(pnl(yes, 'yes') - 0.58) < 1e-9 && Math.abs(pnl(no, 'yes') + 0.31) < 1e-9 && pairedBand([{ day: 'a', diff: 0.1 }, { day: 'b', diff: -0.1 }]).days === 2
  console.log(`selftest: ${ok ? '3 passed, 0 failed' : 'FAILED'}`)
  return ok ? 0 : 1
}
if (process.argv.includes('--selftest')) process.exit(selftest())

const lines = existsSync(SHADOW) ? readFileSync(SHADOW, 'utf8').split(/\r?\n/).filter(Boolean) : []
const rows = lines.flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } }).filter((r) => r.pollIntervalMs === 10_000)
const markets = new Set(rows.map((r) => r.kalshiTicker))
const sampled = new Set(rows.filter((r) => r.sample60).map((r) => r.kalshiTicker))
const days = new Set(rows.map((r) => String(r.ts).slice(0, 10)))
console.log(`LEAD-LAG CADENCE SHADOW — ${rows.length} qualifying observations, ${markets.size} markets, ${sampled.size} seen by the 60 s sample, ${days.size} UTC days`)

if (!process.argv.includes('--verdict')) {
  console.log(`Health only. Verdict is locked until 2026-09-21 00:00 UTC and requires ${MIN_PAIRS} paired settled markets over ${MIN_DAYS} UTC entry days.`)
  process.exit(0)
}
if (Date.now() < READ_AT) {
  console.log('REFUSED: the pre-registered outcome read is locked until 2026-09-21 00:00 UTC.')
  process.exit(2)
}

let dumpPath = process.argv.slice(2).find((x) => !x.startsWith('--'))
if (!dumpPath) {
  const dir = join(REPO, 'tmp')
  const files = existsSync(dir) ? readdirSync(dir).filter((x) => /^k-.*\.json$/.test(x)).map((x) => join(dir, x)) : []
  if (!files.length) throw new Error('no Kalshi dump found; create a fresh read-only dump first')
  dumpPath = files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).pop()
}
const results = new Map((JSON.parse(readFileSync(dumpPath, 'utf8')).settlements ?? []).map((s) => [s.ticker, String(s.market_result).toLowerCase()]))
const byMarket = new Map()
for (const row of rows) byMarket.set(row.kalshiTicker, (byMarket.get(row.kalshiTicker) ?? []).concat(row))
const paired = []
const fastOnly = []
for (const [ticker, observations] of byMarket) {
  const result = results.get(ticker)
  if (!result) continue
  observations.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  const fast = observations[0]
  const slow = observations.find((r) => r.sample60)
  if (!slow) fastOnly.push({ pnl: pnl(fast, result), day: String(fast.ts).slice(0, 10) })
  else paired.push({ ticker, day: String(fast.ts).slice(0, 10), fast: pnl(fast, result), slow: pnl(slow, result), diff: pnl(fast, result) - pnl(slow, result) })
}
const band = paired.length ? pairedBand(paired) : { mean: 0, lo: null, hi: null, days: 0 }
const total = (key) => paired.reduce((s, r) => s + r[key], 0)
console.log(`Paired settled markets: ${paired.length}; UTC entry days: ${band.days}`)
console.log(`10 s first-entry net: $${total('fast').toFixed(2)} | 60 s first-entry net: $${total('slow').toFixed(2)} | paired difference: ${(band.mean * 100).toFixed(2)}c/market`)
console.log(`Day-clustered 95% difference: ${band.lo === null ? 'not available' : `[${(band.lo * 100).toFixed(2)}, ${(band.hi * 100).toFixed(2)}]c`}`)
console.log(`Fast-only settled markets missed by the minute sample: ${fastOnly.length}, net $${fastOnly.reduce((s, r) => s + r.pnl, 0).toFixed(2)} (secondary, not part of the paired decision)`)
const ready = paired.length >= MIN_PAIRS && band.days >= MIN_DAYS
const verdict = !ready ? 'NOT READY' : band.lo > 0 ? 'KEEP 10 SECONDS' : band.hi < 0 ? 'SWITCH TO 60 SECONDS' : 'INCONCLUSIVE — keep collecting until the 2026-10-06 deadline'
console.log(`RESULT: ${verdict}`)
