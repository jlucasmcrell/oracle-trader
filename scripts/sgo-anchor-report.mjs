import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'oracle-trader', 'episodes')
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((x) => /^kalshi-.*\.jsonl$/.test(x)).sort()
  : []

const rows = []
for (const file of files) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8')
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row.kind === 'anchor' && String(row.bookmaker || '').startsWith('sgo-')) rows.push(row)
    } catch {
      // A damaged telemetry line must not prevent analysis of the rest.
    }
  }
}

const phases = new Map()
for (const row of rows) phases.set(row.phase || 'legacy', (phases.get(row.phase || 'legacy') || 0) + 1)
const grades = rows.filter((x) => x.phase === 'grade' && typeof x.resultYes === 'boolean')
const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
const brierSgo = avg(grades.map((x) => Number(x.brier)).filter(Number.isFinite))
const brierMarket = avg(grades.map((x) => {
  const p = Number(x.kalshiMid)
  return (p - (x.resultYes ? 1 : 0)) ** 2
}).filter(Number.isFinite))
const clv = avg(grades.map((x) => Number(x.clvCents)).filter(Number.isFinite))
const stale = rows.reduce((s, x) => s + (Number(x.staleBooksExcluded) || 0), 0)
const events = new Set(rows.map((x) => x.externalEventId).filter(Boolean))

console.log(`SportsGameOdds anchor: ${rows.length} observations across ${events.size} external events`)
console.log(`phases: ${[...phases.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`)
console.log(`stale bookmaker pairs excluded: ${stale}`)
if (!grades.length) {
  console.log('graded outcomes: 0 - CLV/calibration not yet evaluable')
  process.exit(0)
}
console.log(`graded outcome legs: ${grades.length}`)
console.log(`mean CLV vs closing fair: ${clv >= 0 ? '+' : ''}${clv.toFixed(2)}c`)
console.log(`Brier: SGO initial fair ${brierSgo.toFixed(4)} vs Kalshi observed mid ${brierMarket.toFixed(4)}`)
console.log('Shadow evidence only. No order authority is implied by this report.')
