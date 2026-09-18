// Gate checker for docs/PREREGISTERED-btcd-maker.md.
// Reads the collector JSONL: for each hourly-ladder event after registration,
// take the T-5 book snapshot per strike, rest at the best bid of the side priced
// 80-95c, and apply the registered fill proxy against the later per-minute
// ladder records (opposite ask trades through our price before close). Grades
// filled orders at settlement, clusters by close timestamp and by day, reports
// the opposite-side baseline and the fill rate, prints PASS/FAIL.
//
//   node scripts/btcd-maker-gate.mjs                 (primary: KXBTCD)
//   GATE_SERIES=KXETHD node scripts/btcd-maker-gate.mjs   (secondary coins)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.BTC_COLLECTOR_DIR || 'G:/PROJECTS/oracle-trader/data/btc-collector'
const SERIES = process.env.GATE_SERIES || 'KXBTCD'
const REGISTERED_AT = Date.parse('2026-09-02T14:35:00Z')
const WINDOW = 5, LO = 0.80, HI = 0.95, Z = 1.96
const MIN_FILLED = 60, MIN_CLOSES = 40, MIN_POINT = 0.34, MIN_FILL_RATE = 0.30

const books = new Map()     // ev -> { close, strikes: Map(strikeValue -> book) }
const ladders = new Map()   // ev -> [{ ts, mtc, strikes: [[floor, yb, ya, ...]] }]
const settled = new Map()   // ticker -> result ; also strike-keyed per event
const settledByEvStrike = new Map()
let lines = 0
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
    if (!line) continue
    let j; try { j = JSON.parse(line) } catch { continue }
    if ((j.series ?? 'KXBTCD') !== SERIES) continue
    lines++
    if (j.kind === 'book' && j.w === WINDOW) {
      const e = books.get(j.ev) ?? { ev: j.ev, close: Date.parse(j.close), strikes: new Map() }
      e.strikes.set(j.strike, j); books.set(j.ev, e)
    } else if (j.kind === 'ladder') {
      (ladders.get(j.ev) ?? ladders.set(j.ev, []).get(j.ev)).push({ ts: Date.parse(j.ts), mtc: j.mtc, strikes: j.strikes })
    } else if (j.kind === 'settled') {
      settled.set(j.t, j.result)
      settledByEvStrike.set(`${j.ev}|${j.strike}`, j.result)
    }
  }
}
const best = (levels) => levels && levels.length ? levels.reduce((m, [p, q]) => (p > m[0] ? [p, q] : m), [0, 0]) : [0, 0]
const mu = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN
const clusterSE = (vals, keys) => { const g = new Map(); vals.forEach((v, i) => g.set(keys[i], (g.get(keys[i]) ?? []).concat(v))); const m = mu(vals), G = [...g.values()]; return [Math.sqrt(G.reduce((s, arr) => s + Math.pow(arr.reduce((x, y) => x + y, 0) - arr.length * m, 2), 0) / (vals.length ** 2)), G.length] }

let resting = 0, unsettled = 0, beforeReg = 0
const filled = [], oppFilled = []
for (const e of books.values()) {
  if (e.close < REGISTERED_AT) { beforeReg++; continue }
  const later = (ladders.get(e.ev) ?? []).filter((l) => l.mtc < WINDOW && l.mtc > -0.5).sort((a, b) => a.ts - b.ts)
  for (const b of e.strikes.values()) {
    const res = settled.get(b.t) ?? settledByEvStrike.get(`${e.ev}|${b.strike}`)
    const [yesBid] = best(b.yes)            // best resting YES bid
    const [noBid] = best(b.no)              // best resting NO bid
    const tryOrder = (side, px, target) => {
      // fill proxy: a later ladder minute whose opposite ask trades at/below our price
      let hit = false
      for (const l of later) {
        const row = l.strikes.find((s) => s[0] === b.strike); if (!row) continue
        const yb = row[1], ya = row[2]
        if (side === 'YES' && ya !== null && ya <= px) { hit = true; break }
        if (side === 'NO' && yb !== null && 1 - yb <= px) { hit = true; break }
      }
      if (!res) { unsettled++; return }
      if (!hit) return
      const win = (side === 'YES' && res === 'yes') || (side === 'NO' && res === 'no')
      target.push({ ev: e.ev, close: e.close, day: new Date(e.close).toISOString().slice(0, 10), t: b.t, side, px, win, net: (win ? 1 - px : -px) * 100 })
    }
    let side = null, px = 0
    if (yesBid >= LO && yesBid <= HI) { side = 'YES'; px = yesBid }
    else if (noBid >= LO && noBid <= HI) { side = 'NO'; px = noBid }
    if (!side) continue
    resting++
    tryOrder(side, px, filled)
    // baseline: the opposite side at ITS best bid, same proxy
    const oside = side === 'YES' ? 'NO' : 'YES', opx = side === 'YES' ? noBid : yesBid
    if (opx > 0) tryOrder(oside, opx, oppFilled)
  }
}
console.log(`${SERIES}: lines ${lines}; T-${WINDOW} books for ${books.size} events (${beforeReg} before registration); resting orders ${resting}; filled ${filled.length}; unsettled ${unsettled}`)
if (!filled.length) { console.log('GATE: NOT EVALUABLE (no filled, settled orders yet)'); process.exit(0) }
const v = filled.map((r) => r.net)
const [seC, nC] = clusterSE(v, filled.map((r) => String(r.close)))
const [seD] = clusterSE(v, filled.map((r) => r.day))
const m = mu(v), fillRate = filled.length / Math.max(resting, 1)
console.log(`\nMAKER 80-95c: filled ${filled.length} over ${nC} closes | fill rate ${(100 * fillRate).toFixed(0)}% | P(adverse) ${(100 * filled.filter((r) => !r.win).length / filled.length).toFixed(1)}% | mean price ${(100 * mu(filled.map((r) => r.px))).toFixed(1)}c`)
console.log(`NET ${m.toFixed(2)}c/contract  close-clustered CI95 [${(m - Z * seC).toFixed(2)}, ${(m + Z * seC).toFixed(2)}]  day-clustered [${(m - Z * seD).toFixed(2)}, ${(m + Z * seD).toFixed(2)}]`)
const om = oppFilled.length ? mu(oppFilled.map((r) => r.net)) : NaN
console.log(`BASELINE opposite side at its bid: ${oppFilled.length} filled, net ${Number.isFinite(om) ? om.toFixed(2) : 'n/a'}c`)
const g1 = filled.length >= MIN_FILLED && nC >= MIN_CLOSES, g2 = (m - Z * seC) > 0 && m >= MIN_POINT, g3 = (m - Z * seD) > 0, g4 = !(Number.isFinite(om) && om > 0), g5 = fillRate >= MIN_FILL_RATE
console.log(`\nGATE (pre-registered):`)
console.log(`  [${g1 ? 'x' : ' '}] >= ${MIN_FILLED} filled over >= ${MIN_CLOSES} closes   (${filled.length} / ${nC})`)
console.log(`  [${g2 ? 'x' : ' '}] close-clustered LB > 0 and point >= +${MIN_POINT}c  (LB ${(m - Z * seC).toFixed(2)}, point ${m.toFixed(2)})`)
console.log(`  [${g3 ? 'x' : ' '}] day-clustered LB > 0                     (${(m - Z * seD).toFixed(2)})`)
console.log(`  [${g4 ? 'x' : ' '}] opposite side NOT also positive          (${Number.isFinite(om) ? om.toFixed(2) : 'n/a'})`)
console.log(`  [${g5 ? 'x' : ' '}] fill rate >= ${(100 * MIN_FILL_RATE).toFixed(0)}%                        (${(100 * fillRate).toFixed(0)}%)`)
console.log(`RESULT: ${g1 && g2 && g3 && g4 && g5 ? 'PASS' : 'FAIL / NOT YET'}`)
