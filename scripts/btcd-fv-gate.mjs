// Gate checker for docs/PREREGISTERED-btcd-fairvalue-maker.md.
// Same data, fill proxy, clustering and gate mechanics as btcd-maker-gate.mjs,
// but the side/price decision comes from a lognormal fair value:
//   p_fair = Phi(d2), d2 = (ln(S/K) - 0.5 sigma^2 tau) / (sigma sqrt(tau)), r = 0
//   S = Coinbase spot in the T-5 snapshot, K = floor_strike, tau = 5 min,
//   sigma = annualised realised vol of Coinbase 1-min log returns over the
//           240 minutes ending at T (fetched here, at grading time; all <= T).
// Rest at the best bid on the side whose fair value exceeds that bid by >= 3c,
// bid within [0.05, 0.95]. Public data only.
//
//   node scripts/btcd-fv-gate.mjs               (KXBTCD)
//   GATE_SERIES=KXETHD node scripts/btcd-fv-gate.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.BTC_COLLECTOR_DIR || 'G:/PROJECTS/oracle-trader/data/btc-collector'
const SERIES = process.env.GATE_SERIES || 'KXBTCD'
const COIN = { KXBTCD: 'BTC', KXETHD: 'ETH', KXSOLD: 'SOL', KXXRPD: 'XRP' }[SERIES] || 'BTC'
const REGISTERED_AT = Date.parse('2026-09-02T15:20:00Z')
const WINDOW = 5, EDGE = 0.03, LO = 0.05, HI = 0.95, Z = 1.96
const TAU = 5 / 525600, VOL_MIN = 240
const MIN_FILLED = 60, MIN_CLOSES = 40, MIN_POINT = 0.34, MIN_FILL_RATE = 0.30
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- load collector data ----
const books = new Map(), ladders = new Map(), settled = new Map(), settledByEvStrike = new Map()
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
    if (!line) continue
    let j; try { j = JSON.parse(line) } catch { continue }
    if ((j.series ?? 'KXBTCD') !== SERIES) continue
    if (j.kind === 'book' && j.w === WINDOW) {
      const e = books.get(j.ev) ?? { ev: j.ev, close: Date.parse(j.close), spot: j.spot, strikes: new Map() }
      e.strikes.set(j.strike, j); books.set(j.ev, e)
    } else if (j.kind === 'ladder') {
      (ladders.get(j.ev) ?? ladders.set(j.ev, []).get(j.ev)).push({ ts: Date.parse(j.ts), mtc: j.mtc, strikes: j.strikes })
    } else if (j.kind === 'settled') { settled.set(j.t, j.result); settledByEvStrike.set(`${j.ev}|${j.strike}`, j.result) }
  }
}

// ---- realised vol at T, cached per event (Coinbase public candles, all <= T) ----
const volCache = join(DIR, `fv-vol-cache-${COIN}.json`)
let vols = {}
try { if (existsSync(volCache)) vols = JSON.parse(readFileSync(volCache, 'utf8')) } catch { vols = {} }
async function sigmaAt(tMs) {
  const key = String(Math.floor(tMs / 60000))
  if (vols[key]) return vols[key]
  const end = new Date(Math.floor(tMs / 60000) * 60000).toISOString(), start = new Date(Math.floor(tMs / 60000) * 60000 - VOL_MIN * 60000).toISOString()
  const r = await fetch(`https://api.exchange.coinbase.com/products/${COIN}-USD/candles?granularity=60&start=${start}&end=${end}`)
  if (!r.ok) throw new Error(`coinbase ${r.status}`)
  const rows = (await r.json()).filter((c) => c[0] * 1000 <= tMs).sort((a, b) => a[0] - b[0])
  const closes = rows.map((c) => c[4]).filter((x) => x > 0)
  if (closes.length < 60) throw new Error('too few candles for vol')
  const lr = closes.slice(1).map((c, i) => Math.log(c / closes[i]))
  const m = lr.reduce((a, b) => a + b, 0) / lr.length
  const sd = Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / (lr.length - 1))
  const sigma = sd * Math.sqrt(525600)
  vols[key] = sigma
  await sleep(120)
  return sigma
}
const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2))
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y }
const best = (levels) => levels && levels.length ? levels.reduce((m, [p, q]) => (p > m[0] ? [p, q] : m), [0, 0]) : [0, 0]
const mu = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN
const clusterSE = (vals, keys) => { const g = new Map(); vals.forEach((v, i) => g.set(keys[i], (g.get(keys[i]) ?? []).concat(v))); const m = mu(vals), G = [...g.values()]; return [Math.sqrt(G.reduce((s, arr) => s + Math.pow(arr.reduce((x, y) => x + y, 0) - arr.length * m, 2), 0) / (vals.length ** 2)), G.length] }

let resting = 0, unsettled = 0, noSpot = 0, volFail = 0
const filled = [], oppFilled = []
for (const e of books.values()) {
  if (e.close < REGISTERED_AT) continue
  const S = e.spot && e.spot.cb
  if (!S) { noSpot++; continue }
  let sigma
  try { sigma = await sigmaAt(e.close - WINDOW * 60000) } catch (err) { volFail++; continue }
  const later = (ladders.get(e.ev) ?? []).filter((l) => l.mtc < WINDOW && l.mtc > -0.5).sort((a, b) => a.ts - b.ts)
  for (const b of e.strikes.values()) {
    if (!(b.strike > 0)) continue
    const d2 = (Math.log(S / b.strike) - 0.5 * sigma * sigma * TAU) / (sigma * Math.sqrt(TAU))
    const pFair = Phi(d2)
    const res = settled.get(b.t) ?? settledByEvStrike.get(`${e.ev}|${b.strike}`)
    const [yesBid] = best(b.yes), [noBid] = best(b.no)
    const tryOrder = (side, px, target) => {
      let hit = false
      for (const l of later) { const row = l.strikes.find((s) => s[0] === b.strike); if (!row) continue; const yb = row[1], ya = row[2]; if (side === 'YES' && ya !== null && ya <= px) { hit = true; break } if (side === 'NO' && yb !== null && 1 - yb <= px) { hit = true; break } }
      if (!res) { unsettled++; return }
      if (!hit) return
      const win = (side === 'YES' && res === 'yes') || (side === 'NO' && res === 'no')
      target.push({ ev: e.ev, close: e.close, day: new Date(e.close).toISOString().slice(0, 10), t: b.t, side, px, pFair, win, net: (win ? 1 - px : -px) * 100 })
    }
    let side = null, px = 0
    if (yesBid >= LO && yesBid <= HI && pFair - yesBid >= EDGE) { side = 'YES'; px = yesBid }
    else if (noBid >= LO && noBid <= HI && (1 - pFair) - noBid >= EDGE) { side = 'NO'; px = noBid }
    if (!side) continue
    resting++
    tryOrder(side, px, filled)
    const oside = side === 'YES' ? 'NO' : 'YES', opx = side === 'YES' ? noBid : yesBid
    if (opx > 0) tryOrder(oside, opx, oppFilled)
  }
}
try { writeFileSync(volCache, JSON.stringify(vols)) } catch { /* best effort */ }
console.log(`${SERIES} fair-value maker: T-${WINDOW} books for ${books.size} events; resting ${resting}; filled ${filled.length}; unsettled ${unsettled}; noSpot ${noSpot}; volFail ${volFail}`)
if (!filled.length) { console.log('GATE: NOT EVALUABLE (no filled, settled orders yet)'); process.exit(0) }
const v = filled.map((r) => r.net)
const [seC, nC] = clusterSE(v, filled.map((r) => String(r.close))), [seD] = clusterSE(v, filled.map((r) => r.day))
const m = mu(v), fillRate = filled.length / Math.max(resting, 1)
console.log(`\nFILLED ${filled.length} over ${nC} closes | fill rate ${(100 * fillRate).toFixed(0)}% | P(adverse) ${(100 * filled.filter((r) => !r.win).length / filled.length).toFixed(1)}% | mean price ${(100 * mu(filled.map((r) => r.px))).toFixed(1)}c | mean fair ${(100 * mu(filled.map((r) => r.side === 'YES' ? r.pFair : 1 - r.pFair))).toFixed(1)}c`)
console.log(`NET ${m.toFixed(2)}c/contract  close-clustered CI95 [${(m - Z * seC).toFixed(2)}, ${(m + Z * seC).toFixed(2)}]  day-clustered [${(m - Z * seD).toFixed(2)}, ${(m + Z * seD).toFixed(2)}]`)
const om = oppFilled.length ? mu(oppFilled.map((r) => r.net)) : NaN
console.log(`BASELINE opposite side at its bid: ${oppFilled.length} filled, net ${Number.isFinite(om) ? om.toFixed(2) : 'n/a'}c`)
const g1 = filled.length >= MIN_FILLED && nC >= MIN_CLOSES, g2 = (m - Z * seC) > 0 && m >= MIN_POINT, g3 = (m - Z * seD) > 0, g4 = !(Number.isFinite(om) && om > 0), g5 = fillRate >= MIN_FILL_RATE
console.log(`\nGATE (pre-registered):\n  [${g1 ? 'x' : ' '}] >= ${MIN_FILLED} filled over >= ${MIN_CLOSES} closes (${filled.length}/${nC})\n  [${g2 ? 'x' : ' '}] close-clustered LB > 0 and point >= +${MIN_POINT}c (LB ${(m - Z * seC).toFixed(2)}, point ${m.toFixed(2)})\n  [${g3 ? 'x' : ' '}] day-clustered LB > 0 (${(m - Z * seD).toFixed(2)})\n  [${g4 ? 'x' : ' '}] opposite side not also positive (${Number.isFinite(om) ? om.toFixed(2) : 'n/a'})\n  [${g5 ? 'x' : ' '}] fill rate >= ${(100 * MIN_FILL_RATE).toFixed(0)}% (${(100 * fillRate).toFixed(0)}%)\nRESULT: ${g1 && g2 && g3 && g4 && g5 ? 'PASS' : 'FAIL / NOT YET'}`)
